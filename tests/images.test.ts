import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { ImageRawDataUpdate, ImageRawDataUpdateResult, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/core/glasses.ts';
import { defaults } from '../src/core/config.ts';
import type { AppState, Attachment } from '../src/core/types.ts';

// A complete 288 × 144 greyscale PNG, generated locally without a browser or network.
function syntheticPng(width=288,height=144): Uint8Array {
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name), out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length, 0); type.copy(out, 4); bytes.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([type, bytes])), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8;
  const raster = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raster[y * (width + 1) + x + 1] = Math.round(x / (width - 1) * 15) * 17;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0))]));
}
const png = syntheticPng();
const image: Attachment = { mime: 'image/png', name: 'synthetic.png', data_base64: Buffer.from(png).toString('base64') };
const state = { settings: { ...defaults, language: 'ja', images: true } } as AppState;

function fixture(results: ImageRawDataUpdateResult[] = []) {
  let page: Record<string, any> = {};
  const remaining = [...results];
  const wire: Record<string, any>[] = [], rebuilds: string[] = [], textUpdates: Record<string, any>[] = [];
  const bridge = {
    async rebuildPageContainer(next: Record<string, any>) {
      rebuilds.push(next.imageObject?.length ? 'image' : next.listObject?.length ? 'list' : 'text');
      page = structuredClone(next); return true;
    },
    async textContainerUpgrade(next: Record<string, any>) {
      const target = page.textObject?.find((item: any) => item.containerID === next.containerID && item.containerName === next.containerName);
      assert.ok(target, 'text updates must refer to a current container');
      target.content = next.content; textUpdates.push(structuredClone(next)); return true;
    },
    async updateImageRawData(next: ImageRawDataUpdate) {
      const serialized = ImageRawDataUpdate.toJson(next);
      assert.ok(page.imageObject?.some((item: any) => item.containerID === serialized.containerID && item.containerName === serialized.containerName), 'create the image container before sending pixels');
      wire.push(serialized);
      return remaining.shift() ?? ImageRawDataUpdateResult.success;
    },
  };
  const native = bridge as unknown as EvenAppBridge;
  const glasses = new Glasses(() => {}, async () => native, async (_asset,dimensions) => dimensions
    ?{...image,data_base64:Buffer.from(syntheticPng(dimensions.width,dimensions.height)).toString('base64')}:{...image});
  glasses.bridge = native; glasses.ready = true;
  return { glasses, wire, rebuilds, textUpdates, page:()=>page,body: () => page.textObject?.find((item: any) => item.containerName === 'body')?.content };
}

test('home avatar uses a right-side square and clock updates preserve its pixels and the native list',async()=>{
  const app=fixture(),items=['Chat','Spaces','Record voice'];
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:00',image);
  const page=app.page();assert.equal(page.containerTotalNum,4);
  assert.deepEqual(page.imageObject.map((c:any)=>[c.xPosition,c.yPosition,c.width,c.height]),[[424,68,144,144]]);
  assert.equal(page.listObject[0].width,400);assert.equal(page.listObject[0].isEventCapture,1);
  assert.ok(page.textObject.every((c:any)=>c.isEventCapture===0));
  assert.equal(app.wire.length,1);assert.equal(app.wire[0]!.containerName,'avatar');
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:01',{...image});
  assert.equal(app.wire.length,1);assert.equal(app.rebuilds.length,1);
  await app.glasses.show(state,'Chat');
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:02',image);assert.equal(app.wire.length,2);
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:03');
  assert.equal(app.page().imageObject.length,0);assert.equal(app.page().listObject[0].width,560);
});

test('image transfers contain PNG bytes, skip unchanged accepted images, and resend after a layout rebuild', async () => {
  const app = fixture();
  await app.glasses.show(state, '最初の本文', '1/2', { ...image });
  assert.equal(app.wire.length, 1);
  assert.ok(Array.isArray(app.wire[0]!.imageData), 'the SDK wire payload must contain a numeric array rather than base64');
  assert.deepEqual(app.wire[0]!.imageData, Array.from(png), 'encoding must preserve every PNG byte');
  assert.ok(app.wire[0]!.imageData.every((byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255));

  await app.glasses.show(state, '更新された本文', '2/2', { ...image });
  assert.equal(app.wire.length, 1, 'polling with a fresh attachment object must not retransmit unchanged accepted image data');
  assert.equal(app.body(), '更新された本文');
  assert.ok(app.textUpdates.length > 0, 'the text should still update');

  await app.glasses.list(state, ['チャット']);
  await app.glasses.show(state, '画像へ戻る', '', { ...image });
  assert.deepEqual(app.rebuilds, ['image', 'list', 'image']);
  assert.equal(app.wire.length, 2, 'a newly created image container needs its pixels sent again');
  await app.glasses.show(state,'タップして本文を表示','1/2',{...image},[],{input:'あなた: 画像を見せて'});
  assert.equal(app.wire.length,3,'paired image layout also transfers its image after rebuilding');
  const {textObject,imageObject,containerTotalNum}=app.page();
  assert.equal(containerTotalNum,4);
  assert.equal(textObject.find((c:any)=>c.containerName==='input').textColor,1);
  assert.equal(textObject.find((c:any)=>c.containerName==='body').textColor,4);
  assert.equal(imageObject[0].yPosition,60);assert.equal(imageObject[0].height,144);
  assert.equal(textObject.filter((c:any)=>c.isEventCapture===1).length,1);
});

test('sendFailed retries once, preserves terminal failure, and leaves a later attempt usable', async () => {
  const recovered = fixture([ImageRawDataUpdateResult.sendFailed, ImageRawDataUpdateResult.success]);
  await recovered.glasses.show(state, '一時的な転送失敗', '', { ...image });
  assert.equal(recovered.wire.length, 2, 'a transient transfer failure should have one bounded retry');
  await recovered.glasses.show(state, '同じ画像', '', { ...image });
  assert.equal(recovered.wire.length, 2, 'the successful retry should mark this image accepted');

  const failed = fixture([ImageRawDataUpdateResult.sendFailed, ImageRawDataUpdateResult.sendFailed, ImageRawDataUpdateResult.success]);
  await assert.rejects(failed.glasses.show(state, '転送失敗', '', { ...image }),
    (error: unknown) => error instanceof Error && error.message === 'G2 image sendFailed');
  assert.equal(failed.wire.length, 2, 'a failed retry must stop rather than loop');
  await failed.glasses.show(state, 'もう一度表示', '', { ...image });
  assert.equal(failed.wire.length, 3, 'a failed image must not be cached as accepted or block the queue');
});

test('invalid-size and conversion failures keep their exact result and do not retry', async () => {
  for (const result of [ImageRawDataUpdateResult.imageSizeInvalid, ImageRawDataUpdateResult.imageToGray4Failed]) {
    const app = fixture([result]);
    await assert.rejects(app.glasses.show(state, '画像の変換エラー', '', { ...image }),
      (error: unknown) => error instanceof Error && error.message === `G2 image ${result}`);
    assert.equal(app.wire.length, 1, `${result} is not a transient transfer failure`);
  }
});
