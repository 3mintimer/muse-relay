import { waitForEvenAppBridge, CreateStartUpPageContainer, RebuildPageContainer, TextContainerUpgrade, ImageRawDataUpdate, ImageRawDataUpdateResult, AudioInputSource, type EvenAppBridge, type EvenHubEvent, ListContainerProperty } from '@evenrealities/even_hub_sdk';
import type { AppState, Attachment } from './types';
import { glassImageTiles, imageBytes, resizeImage, type GlassImageTile } from './media';
import { excerpt, G2_LINE_HEIGHT, lineBudget, wrapLines } from './glass-text';

export interface GlassMenuItem { itemID:number; itemName:string; }
export interface GlassTextStyle { bodyColor?:1|4; input?:string; }

const WIDTH = 576;
const HEIGHT = 288;
const AVATAR_SIZE = 144;
const settleImage = () => new Promise<void>(resolve => setTimeout(resolve, 500));

function textBand(content: string | undefined, maxRows: number) {
  if (!content?.trim()) return { content: '', height: 0 };
  const fitted = excerpt(content, maxRows, WIDTH);
  return { content: fitted, height: wrapLines(fitted, WIDTH).length * G2_LINE_HEIGHT };
}

function bands(footer: string, top?: string) {
  const first = textBand(top, 2);
  const last = textBand(footer, 3);
  return { first, last, bodyHeight: HEIGHT - first.height - last.height };
}

export function glassBodyRows(footer: string, input?: string): number {
  return lineBudget(bands(footer, input).bodyHeight);
}

function label(id: number, name: string, y: number, height: number, content: string, capture = false, color: 1|4 = 4) {
  return { containerID: id, containerName: name, xPosition: 0, yPosition: y, width: WIDTH, height,
    paddingLength: 0, borderWidth: 0, isEventCapture: capture ? 1 : 0, textColor: color, content: content || ' ' };
}

function sameImage(source: Attachment, next: Attachment): boolean {
  return source.mime === next.mime && source.data_base64 === next.data_base64;
}

type GlassBitmap = GlassImageTile & { containerID: number; containerName: string };

export class Glasses {
  bridge?: EvenAppBridge;
  ready=false;
  private chain: Promise<unknown>=Promise.resolve();
  private storageChain: Promise<unknown>=Promise.resolve();
  private connecting?: Promise<void>;
  private layout='';
  private serial=0;
  private off?:()=>void;
  private onEvent:(e:EvenHubEvent)=>void;
  private bridgeFactory: typeof waitForEvenAppBridge;
  private photo?: {source: Attachment; height: number; tiles: Promise<GlassImageTile[]>};
  private avatar?: {source: Attachment; bytes: Promise<Uint8Array>};
  private displayedImages = new Map<number, Uint8Array>();

  private avatarConverter: (asset: Attachment, size: {width: number; height: number}) => Promise<Attachment>;
  private photoConverter: typeof glassImageTiles;

  constructor(onEvent: (e: EvenHubEvent) => void, bridgeFactory = waitForEvenAppBridge,
    avatarConverter = (asset: Attachment, size: {width: number; height: number}) => resizeImage(asset, true, size),
    photoConverter = glassImageTiles) {
    this.avatarConverter = avatarConverter;
    this.photoConverter = photoConverter;
    this.onEvent = onEvent;
    this.bridgeFactory = bridgeFactory;
  }
  async run<T>(fn:(bridge:EvenAppBridge)=>Promise<T>, timeoutMs = 10000):Promise<T>{
    if(!this.bridge)throw new Error('Even app required');
    const bridge=this.bridge;
    const job=this.chain.then(()=>fn(bridge));this.chain=job.catch(()=>{});
    // Keep the underlying chain serialized even when the caller's deadline passes.
    let timer:ReturnType<typeof setTimeout>;
    try{return await Promise.race([job,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('G2 timeout')),timeoutMs);})]);}
    finally{clearTimeout(timer!);}
  }
  async connect():Promise<void>{
    if(this.bridge)return;
    if(!this.connecting)this.connecting=(async()=>{
      let timer:ReturnType<typeof setTimeout>;
      try{this.bridge=await Promise.race([this.bridgeFactory(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Even app required')),8000);})]);
        this.off=this.bridge.onEvenHubEvent(this.onEvent);
      }finally{clearTimeout(timer!);this.connecting=undefined;}
    })();
    return this.connecting;
  }
  async start():Promise<void>{
    if(this.ready)return;
    await this.connect();
    const result=await this.run(b=>b.createStartUpPageContainer(CreateStartUpPageContainer.fromJson({containerTotalNum:1,textObject:[{
      xPosition:0,yPosition:0,width:WIDTH,height:HEIGHT,containerID:1,containerName:'body',
      isEventCapture:1,paddingLength:0,content:' ',textColor:4,
    }]})));
    if(result!==0)throw new Error('G2 startup');this.ready=true;
  }
  private async storageCall<T>(fn:(bridge:EvenAppBridge)=>Promise<T>):Promise<T>{
    await this.connect();
    const bridge=this.bridge!;
    // App-local storage must remain usable while a G2/BLE call is stalled.
    const job=this.storageChain.then(()=>fn(bridge));this.storageChain=job.catch(()=>{});
    let timer:ReturnType<typeof setTimeout>;
    try{return await Promise.race([job,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Settings storage timeout')),8000);})]);}
    finally{clearTimeout(timer!);}
  }
  async load():Promise<string>{const value=await this.storageCall(b=>b.getLocalStorage('muse-relay-v1'));if(typeof value!=='string')throw new Error('Settings read failed');return value;}
  async save(value:string):Promise<void>{if(await this.storageCall(b=>b.setLocalStorage('muse-relay-v1',value))!==true)throw new Error('Settings save failed');}
  async microphone(open:boolean,phone:boolean):Promise<void>{
    if(open&&!this.ready)throw new Error('Even app required');
    if(!await this.run(b=>b.audioControl(open,phone?AudioInputSource.Phone:AudioInputSource.Glasses)))throw new Error('Microphone unavailable');
  }
  async exit():Promise<void>{await this.run(b=>b.shutDownPageContainer(1));}
  invalidateRender():void{++this.serial;}
  invalidateImage(): void { this.displayedImages.clear(); }
  disconnect(): void {
    this.invalidateRender();
    this.off?.(); this.off = undefined;
    this.ready = false; this.layout = '';
    this.photo = undefined; this.avatar = undefined;
    this.invalidateImage();
  }

  private async photoTiles(image: Attachment, height: number): Promise<GlassImageTile[]> {
    if (!this.photo || this.photo.height !== height || !sameImage(this.photo.source, image)) {
      this.photo = { source: image, height, tiles: this.photoConverter(image, { width: WIDTH, height }) };
    }
    const entry = this.photo;
    try { return await entry.tiles; }
    catch (e) { if (this.photo === entry) this.photo = undefined; throw e; }
  }

  private async avatarBytes(image: Attachment): Promise<Uint8Array> {
    if (!this.avatar || !sameImage(this.avatar.source, image)) {
      this.avatar = { source: image, bytes: this.avatarConverter(image, { width: AVATAR_SIZE, height: AVATAR_SIZE }).then(imageBytes) };
    }
    const entry = this.avatar;
    try { return await entry.bytes; }
    catch (e) { if (this.avatar === entry) this.avatar = undefined; throw e; }
  }

  async show(state: AppState, body: string, footer = '', image?: Attachment, menuItems: GlassMenuItem[] = [], style: GlassTextStyle = {}): Promise<void> {
    if (!this.ready) return;
    const renderId = ++this.serial;
    // Photos have their own page. The following text page carries the exchange and caption.
    const { first, last, bodyHeight } = bands(footer, image ? undefined : style.input);
    const text: ReturnType<typeof label>[] = [];
    let bitmaps: GlassBitmap[] = [];
    if (image) {
      const tiles = await this.photoTiles(image, bodyHeight);
      bitmaps = tiles.map((tile, i) => ({ ...tile, containerID: 2 + i, containerName: 'photo' + i }));
      if (!last.height) text.push(label(1, 'body', 0, HEIGHT, ' ', true));
    } else {
      if (first.height) text.push(label(12, 'input', 0, first.height, first.content, false, 1));
      text.push(label(1, 'body', first.height, bodyHeight, excerpt(body, lineBudget(bodyHeight)), true, style.bodyColor));
    }
    if (last.height) text.push(label(11, 'footer', HEIGHT - last.height, last.height, last.content, Boolean(image)));
    await this.paint(renderId, state, menuItems, text, [], bitmaps);
  }

  async list(state: AppState, items: string[], footer = '', menuItems: GlassMenuItem[] = [], header?: string, avatar?: Attachment): Promise<void> {
    if (!this.ready) return;
    const renderId = ++this.serial;
    const { first, last, bodyHeight } = bands(footer, header);
    const text: ReturnType<typeof label>[] = [];
    if (first.height) text.push(label(13, 'header', 0, first.height, first.content));
    if (last.height) text.push(label(11, 'footer', HEIGHT - last.height, last.height, last.content));
    const width = WIDTH - (avatar ? AVATAR_SIZE : 0);
    const list = ListContainerProperty.fromJson({ xPosition: 0, yPosition: first.height, width, height: bodyHeight, containerID: 3, containerName: 'list', isEventCapture: 1,
      itemContainer: { itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1,
        itemName: items.map(item => excerpt(Array.from(item).slice(0, 64).join(''), 1, width - 24)) } });
    const bitmaps: GlassBitmap[] = avatar ? [{ x: width, y: first.height + Math.floor((bodyHeight - AVATAR_SIZE) / 2),
      width: AVATAR_SIZE, height: AVATAR_SIZE, containerID: 2, containerName: 'avatar', bytes: await this.avatarBytes(avatar) }] : [];
    await this.paint(renderId, state, menuItems, text, [list], bitmaps);
  }

  private async paint(renderId: number, state: AppState, menuItems: GlassMenuItem[], textObject: ReturnType<typeof label>[],
    listObject: ListContainerProperty[], bitmaps: GlassBitmap[]): Promise<void> {
    if (renderId !== this.serial) return;
    const imageObject = bitmaps.map(({ x, y, width, height, containerID, containerName }) =>
      ({ xPosition: x, yPosition: y, width, height, containerID, containerName }));
    const layout = JSON.stringify([state.settings.language, listObject, imageObject, menuItems,
      textObject.map(t => [t.containerID, t.yPosition, t.height, t.isEventCapture])]);
    await this.run(async bridge => {
      if (renderId !== this.serial) return;
      if (layout !== this.layout) {
        const page = RebuildPageContainer.fromJson({ containerTotalNum: textObject.length + listObject.length + imageObject.length,
          textObject, listObject, imageObject, menuObject: { menuItems } });
        if (!await bridge.rebuildPageContainer(page)) throw new Error('G2 display');
        this.layout = layout;
        this.invalidateImage();
      } else {
        for (const t of textObject) {
          if (renderId !== this.serial) return;
          const upgrade = TextContainerUpgrade.fromJson({ containerID: t.containerID, containerName: t.containerName,
            content: t.content, contentOffset: 0, contentLength: 0, textColor: t.textColor });
          if (!await bridge.textContainerUpgrade(upgrade)) throw new Error('G2 display');
        }
      }
      const pending = bitmaps.filter(tile => this.displayedImages.get(tile.containerID) !== tile.bytes);
      if (!pending.length || renderId !== this.serial) return;
      // The page acknowledgement can precede BLE readiness. Send each tile in order.
      await settleImage();
      for (const { containerID, containerName, bytes } of pending) {
        if (renderId !== this.serial) return;
        const payload = ImageRawDataUpdate.fromJson({ containerID, containerName, imageData: bytes });
        let result = await bridge.updateImageRawData(payload);
        if (ImageRawDataUpdateResult.isSendFailed(result)) {
          await settleImage();
          if (renderId !== this.serial) return;
          result = await bridge.updateImageRawData(payload);
        }
        if (!ImageRawDataUpdateResult.isSuccess(result)) throw new Error(`G2 image ${result}`);
        if (renderId === this.serial) this.displayedImages.set(containerID, bytes);
      }
    }, 10000 * Math.max(1, bitmaps.length));
  }
}
