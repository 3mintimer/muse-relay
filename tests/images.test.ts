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

test('home avatar uses a right-side square and clock updates preserve its pixels and both columns',async()=>{
  const app=fixture(),items=['Chat','Spaces','Record voice'];
  await app.glasses.home(state,items,['1. Test','2. —','3. —','Usage'],0,'Tap: open',[],'2026/11/17 22:00',image);
  const page=app.page();assert.equal(page.containerTotalNum,5);
  assert.deepEqual(page.imageObject.map((c:any)=>[c.xPosition,c.yPosition,c.width,c.height]),[[432,72,144,144]]);
  const [left,right]=page.textObject.filter((c:any)=>c.containerName.startsWith('home-'));
  assert.equal(left.xPosition+left.width,right.xPosition);
  assert.equal(right.xPosition+right.width,432);
  assert.equal(left.isEventCapture,1);
  assert.equal(page.textObject.filter((c:any)=>c.isEventCapture).length,1);
  assert.equal(app.wire.length,1);assert.equal(app.wire[0]!.containerName,'avatar');
  await app.glasses.home(state,items,['1. Test','2. —','3. —','Usage'],0,'Tap: open',[],'2026/11/17 22:01',{...image});
  assert.equal(app.wire.length,1);assert.equal(app.rebuilds.length,1);
  await app.glasses.show(state,'Chat');
  await app.glasses.home(state,items,['1. Test','2. —','3. —','Usage'],0,'Tap: open',[],'2026/11/17 22:02',image);assert.equal(app.wire.length,2);
  await app.glasses.home(state,items,['1. Test','2. —','3. —','Usage'],0,'Tap: open',[],'2026/11/17 22:03');
  assert.equal(app.page().imageObject.length,0);const wide=app.page().textObject.find((c:any)=>c.containerName==='home-right');assert.equal(wide.xPosition+wide.width,576);
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

test('a delayed animation transfer skips elapsed frames and never queues a stale one behind the answer',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
  t.mock.method(performance,'now',()=>Date.now());
  const app=fixture(), sent:number[]=[];
  const ack=Promise.withResolvers<void>();
  const render=app.glasses.bridge!;
  t.mock.method(render,'updateImageRawData',async payload=>{
    sent.push(ImageRawDataUpdate.toJson(payload).imageData[0]);
    if(sent.length===1) await ack.promise;
    return ImageRawDataUpdateResult.success;
  });
  const frames=Array.from({length:16},(_,i)=>Uint8Array.of(i));
  const settle=()=>new Promise<void>(r=>setImmediate(r));
  await app.glasses.waiting(state,'Waiting','Double-tap: home',[],'q',{frames,failed:assert.fail});
  const layout = app.page();
  assert.deepEqual(layout.imageObject.map((c:any)=>[c.xPosition,c.yPosition,c.width,c.height]),[[432,72,144,144]]);
  const status = layout.textObject.find((c:any)=>c.containerName==='body');
  assert.equal(status.content,'Waiting'); assert.equal(status.width,432); assert.equal(status.isEventCapture,1);
  await settle();
  t.mock.timers.tick(1100);await settle();
  assert.deepEqual(sent,[0]);
  ack.resolve();await settle();t.mock.timers.tick(0);await settle();
  assert.deepEqual(sent,[0,4]);
  t.mock.timers.tick(150);await settle();assert.deepEqual(sent,[0,4,5]);
  await app.glasses.show(state,'Answer');
  t.mock.timers.tick(4000);await settle();
  assert.equal(app.wire.length,0);assert.deepEqual(sent,[0,4,5]);assert.equal(app.body(),'Answer');
  assert.equal(app.page().imageObject.length,0);
});

test('updating the Home clock between two motion frames preserves the four-second timeline and list selection',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:5000});
  t.mock.method(performance,'now',()=>Date.now());
  const app=fixture(),motion={frames:Array.from({length:16},(_,i)=>Uint8Array.of(i)),failed:assert.fail};
  const settle=()=>new Promise<void>(r=>setImmediate(r));
  const home=(time:string)=>app.glasses.home(state,['Chat','Spaces','Settings'],['1. —','2. —','3. —','Usage'],0,'Open',[],time,undefined,motion);
  await home('11:59');await settle();
  for(let i=1;i<=7;i++){t.mock.timers.tick(250);await settle();}
  t.mock.timers.tick(100);await home('12:00');await settle();
  t.mock.timers.tick(150);await settle();
  for(let i=9;i<=16;i++){t.mock.timers.tick(250);await settle();}
  assert.deepEqual(app.wire.map(frame=>frame.imageData[0]),[...Array.from({length:16},(_,i)=>i),0]);
  assert.equal(app.rebuilds.length,1);
  app.glasses.disconnect();
});
