import { waitForEvenAppBridge, CreateStartUpPageContainer, RebuildPageContainer, TextContainerUpgrade, ImageRawDataUpdate, ImageRawDataUpdateResult, AudioInputSource, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import type { AppState, Attachment } from './types';
import { imageBytes, resizeImage } from './media';

export interface GlassMenuItem { itemID:number; itemName:string; }
export interface GlassTextStyle { bodyColor?:1|4; input?:string; }

export function paginate(text: string, lines=7): string[] {
  const pages:string[]=[];let page='',line='',width=0,count=0;
  const flush=()=>{page+=(page?'\n':'')+line;line='';width=0;count++;if(count===lines){pages.push(page);page='';count=0;}};
  for(const char of text){const w=/[^\u0000-\u00ff]/.test(char)?2:1;
    if(char==='\n'){flush();continue;}
    if(width+w>46)flush();line+=char;width+=w;}
  if(line)flush();if(page)pages.push(page);return pages.length?pages:[' '];
}

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
  private imageConverter:(asset:Attachment,dimensions?:{width:number;height:number})=>Promise<Attachment>;
  private preparedImage?:{source:Attachment;png:Attachment;bytes:Uint8Array};
  private preparedAvatar?:{source:Attachment;png:Attachment;bytes:Uint8Array};
  private displayedImage?:Uint8Array;
  constructor(onEvent:(e:EvenHubEvent)=>void, bridgeFactory = waitForEvenAppBridge,imageConverter=(asset:Attachment,dimensions?:{width:number;height:number})=>resizeImage(asset,true,dimensions)){
    this.onEvent=onEvent;this.bridgeFactory=bridgeFactory;this.imageConverter=imageConverter;
  }
  async run<T>(fn:(bridge:EvenAppBridge)=>Promise<T>):Promise<T>{
    if(!this.bridge)throw new Error('Even app required');
    const bridge=this.bridge;
    const job=this.chain.then(()=>fn(bridge));this.chain=job.catch(()=>{});
    // Keep the underlying chain serialized even when the caller's deadline passes.
    let timer:ReturnType<typeof setTimeout>;
    try{return await Promise.race([job,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('G2 timeout')),10000);})]);}
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
      xPosition:0,yPosition:0,width:576,height:288,containerID:1,containerName:'body',
      isEventCapture:1,paddingLength:8,content:' ',textColor:4,
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
  invalidateImage():void{this.displayedImage=undefined;}
  disconnect():void{this.invalidateRender();this.off?.();this.off=undefined;this.ready=false;this.preparedImage=undefined;this.preparedAvatar=undefined;this.invalidateImage();}
  async show(state:AppState,body:string,footer='',image?:Attachment,menuItems:GlassMenuItem[]=[],style:GlassTextStyle={}):Promise<void>{
    if(!this.ready)return;
    const renderId=++this.serial;
    const paired=style.input!==undefined;
    const kind=`${image?'image':'text'}:${paired?'paired':'single'}:${state.settings.language}:${JSON.stringify(menuItems)}`;
    let prepared:typeof this.preparedImage;
    if(image){
      prepared=this.preparedImage;
      if(!prepared||prepared.source.mime!==image.mime||prepared.source.data_base64!==image.data_base64){
        const png=await this.imageConverter(image);
        prepared={source:image,png,bytes:imageBytes(png)};
      }
    }
    if(renderId!==this.serial)return;
    if(prepared)this.preparedImage=prepared;
    const png=prepared?.png;
    const page={containerTotalNum:(png?3:2)+(paired?1:0),textObject:[
      ...(paired?[{xPosition:8,yPosition:0,width:560,height:58,containerID:12,containerName:'input',content:style.input||' ',isEventCapture:0,paddingLength:0,textColor:1}]:[]),
      {xPosition:8,yPosition:paired?(png?208:64):(png?156:0),width:560,height:paired?(png?42:186):(png?94:250),containerID:1,containerName:'body',content:(png?paginate(body,paired?1:3)[0]:body.slice(0,950))||' ',isEventCapture:1,paddingLength:0,textColor:style.bodyColor??4},
      {xPosition:8,yPosition:254,width:560,height:34,containerID:11,containerName:'footer',content:footer||' ',isEventCapture:0,paddingLength:0,textColor:4},
    ],...(png?{imageObject:[{xPosition:144,yPosition:paired?60:4,width:288,height:144,containerID:2,containerName:'image'}]}:{}),menuObject:{menuItems}};
    await this.run(async b=>{
      if(renderId!==this.serial)return;
      if(this.layout!==kind){if(!await b.rebuildPageContainer(RebuildPageContainer.fromJson(page)))throw new Error('G2 display');this.layout=kind;this.invalidateImage();}
      else{for(const t of page.textObject){
        if(renderId!==this.serial)return;
        if(!await b.textContainerUpgrade(TextContainerUpgrade.fromJson({containerID:t.containerID,containerName:t.containerName,content:t.content,contentOffset:0,contentLength:0,textColor:t.textColor})))throw new Error('G2 display');
      }}
      if(prepared)await this.sendImage(b,prepared.bytes,renderId,'image');
    });
  }
  private async sendImage(b:EvenAppBridge,bytes:Uint8Array,renderId:number,name:string):Promise<void>{
    if(renderId!==this.serial||this.displayedImage===bytes)return;
    // Native page acknowledgement can precede completion on the BLE link.
    await new Promise(resolve=>setTimeout(resolve,500));
    if(renderId!==this.serial)return;
    const payload=ImageRawDataUpdate.fromJson({containerID:2,containerName:name,imageData:bytes});
    let result=await b.updateImageRawData(payload);
    if(ImageRawDataUpdateResult.isSendFailed(result)){
      await new Promise(resolve=>setTimeout(resolve,500));
      if(renderId!==this.serial)return;
      result=await b.updateImageRawData(payload);
    }
    if(!ImageRawDataUpdateResult.isSuccess(result))throw new Error(`G2 image ${result}`);
    this.displayedImage=bytes;
  }
  async list(state:AppState,items:string[],footer='',menuItems:GlassMenuItem[]=[],header?:string,avatar?:Attachment):Promise<void>{
    if(!this.ready)return;
    const renderId=++this.serial;
    const hasHeader=header!==undefined;
    let prepared:typeof this.preparedAvatar;
    if(avatar){
      prepared=this.preparedAvatar;
      if(!prepared||prepared.source.mime!==avatar.mime||prepared.source.data_base64!==avatar.data_base64){
        const png=await this.imageConverter(avatar,{width:144,height:144});
        prepared={source:avatar,png,bytes:imageBytes(png)};
      }
    }
    if(renderId!==this.serial)return;
    if(prepared)this.preparedAvatar=prepared;
    const kind=`list:${hasHeader}:${Boolean(prepared)}:${state.settings.language}:${JSON.stringify([items,menuItems])}`;
    const textObject=[
      ...(hasHeader?[{xPosition:8,yPosition:0,width:560,height:34,containerID:13,containerName:'header',content:header||' ',isEventCapture:0,paddingLength:0,textColor:4}]:[]),
      {xPosition:8,yPosition:254,width:560,height:34,containerID:11,containerName:'footer',content:footer||' ',isEventCapture:0,paddingLength:0,textColor:4},
    ];
    await this.run(async b=>{
      if(renderId!==this.serial)return;
      if(this.layout!==kind){
        if(!await b.rebuildPageContainer(RebuildPageContainer.fromJson({containerTotalNum:(hasHeader?3:2)+(prepared?1:0),
          listObject:[{xPosition:8,yPosition:hasHeader?40:0,width:prepared?400:560,height:hasHeader?210:250,containerID:3,containerName:'list',isEventCapture:1,
            itemContainer:{itemCount:items.length,itemWidth:0,isItemSelectBorderEn:1,itemName:items.map(x=>x.slice(0,60))}}],
          textObject,
          ...(prepared?{imageObject:[{xPosition:424,yPosition:68,width:144,height:144,containerID:2,containerName:'avatar'}]}:{}),
          menuObject:{menuItems}})))throw new Error('G2 menu');
        // Commit only after native accepted the layout; an earlier render may still be in flight.
        this.layout=kind;this.invalidateImage();
      }else for(const t of textObject){
        if(renderId!==this.serial)return;
        if(!await b.textContainerUpgrade(TextContainerUpgrade.fromJson({containerID:t.containerID,containerName:t.containerName,content:t.content,contentOffset:0,contentLength:0,textColor:t.textColor})))throw new Error('G2 display');
      }
      if(prepared)await this.sendImage(b,prepared.bytes,renderId,'avatar');
    });
  }
}
