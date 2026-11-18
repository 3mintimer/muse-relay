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
  const glasses = new Glasses(() => {}, async () => native,
    async (_asset, {width, height}) => ({...image, data_base64: Buffer.from(syntheticPng(width, height)).toString('base64')}),
    async (_asset, {width, height}) => {
      const middle = Math.floor(height / 2);
      return [0, middle].flatMap(y => [0, width / 2].map(x => {
        const h = y ? height - middle : middle;
        return {x, y, width: width / 2, height: h, bytes: syntheticPng(width / 2, h)};
      }));
    });
  glasses.bridge = native; glasses.ready = true;
  return { glasses, wire, rebuilds, textUpdates, page:()=>page,body: () => page.textObject?.find((item: any) => item.containerName === 'body')?.content };
}

test('home avatar uses a right-side square and clock updates preserve its pixels and the native list',async()=>{
  const app=fixture(),items=['Chat','Spaces','Record voice'];
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:00',image);
  const page=app.page();assert.equal(page.containerTotalNum,4);
  assert.deepEqual(page.imageObject.map((c:any)=>[c.xPosition,c.yPosition,c.width,c.height]),[[432,72,144,144]]);
  assert.equal(page.listObject[0].width,432);assert.equal(page.listObject[0].isEventCapture,1);
  assert.ok(page.textObject.every((c:any)=>c.isEventCapture===0));
  assert.equal(app.wire.length,1);assert.equal(app.wire[0]!.containerName,'avatar');
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:01',{...image});
  assert.equal(app.wire.length,1);assert.equal(app.rebuilds.length,1);
  await app.glasses.show(state,'Chat');
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:02',image);assert.equal(app.wire.length,2);
  await app.glasses.list(state,items,'Tap: open',[],'2026/11/17 22:03');
  assert.equal(app.page().imageObject.length,0);assert.equal(app.page().listObject[0].width,576);
});

test('photo tiles fill the space above the gesture footer and are sent once per native layout', async () => {
  const app = fixture();
  await app.glasses.show(state, 'Photo caption', '1/2', image, [], {input: 'You: A photo?'});
  const page = app.page();
  const footer = page.textObject[0];
  assert.deepEqual([footer.containerName, footer.yPosition, footer.height, footer.isEventCapture], ['footer', 261, 27, 1]);
  assert.equal(page.textObject.length, 1);
  assert.equal(page.containerTotalNum, 5);
  assert.deepEqual(page.imageObject.map((t: any) => [t.xPosition, t.yPosition, t.width, t.height]), [
    [0, 0, 288, 130], [288, 0, 288, 130], [0, 130, 288, 131], [288, 130, 288, 131],
  ]);
  assert.equal(app.wire.length, 4);
  for (const [i, payload] of app.wire.entries()) {
    const tile = page.imageObject[i];
    assert.equal(payload.containerID, tile.containerID);
    assert.deepEqual(payload.imageData, Array.from(syntheticPng(tile.width, tile.height)));
  }
  await app.glasses.show(state, '', 'Updated footer', {...image});
  assert.equal(app.wire.length, 4);
  assert.equal(app.page().textObject[0].content, 'Updated footer');

  await app.glasses.list(state, ['Chat']);
  assert.deepEqual([app.page().listObject[0].xPosition, app.page().listObject[0].height], [0, 288]);
  await app.glasses.show(state, '', '', image);
  assert.equal(app.wire.length, 8);
  assert.equal(app.page().imageObject[3].yPosition + app.page().imageObject[3].height, 288);
  assert.equal(app.page().textObject.filter((c: any) => c.isEventCapture === 1).length, 1);
});

test('a transient tile failure gets one retry; another attempt resumes from the failed tile', async () => {
  const ok = ImageRawDataUpdateResult.success, fail = ImageRawDataUpdateResult.sendFailed;
  const app = fixture([ok, fail, fail, fail, ok]);
  await assert.rejects(app.glasses.show(state, '', '', image), /G2 image sendFailed/);
  assert.deepEqual(app.wire.map(p => p.containerID), [2, 3, 3]);
  await app.glasses.show(state, '', '', image);
  assert.deepEqual(app.wire.map(p => p.containerID), [2, 3, 3, 3, 3, 4, 5]);
  await app.glasses.show(state, '', '', image);
  assert.equal(app.wire.length, 7);
});

test('invalid-size and conversion failures keep their exact result and do not retry', async () => {
  for (const result of [ImageRawDataUpdateResult.imageSizeInvalid, ImageRawDataUpdateResult.imageToGray4Failed]) {
    const app = fixture([result]);
    await assert.rejects(app.glasses.show(state, '画像の変換エラー', '', { ...image }),
      (error: unknown) => error instanceof Error && error.message === `G2 image ${result}`);
    assert.equal(app.wire.length, 1, `${result} is not a transient transfer failure`);
  }
});
