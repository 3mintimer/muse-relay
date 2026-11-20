import type { Attachment } from './types';

// A short window avoids averaging a new syllable into a long silent PCM batch.
// This only extends a pending endpoint. Sound alone never triggers a send.
export function hasAudiblePcm(pcm: Uint8Array): boolean {
  const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const count = Math.floor(pcm.byteLength / 2);
  for (let start = 0; start < count; start += 320) {
    const end = Math.min(count, start + 320);
    let energy = 0;
    for (let i = start; i < end; i++) energy += samples.getInt16(i * 2, true) ** 2;
    if (energy > (end - start) * 256 ** 2) return true;
  }
  return false;
}

export function base64(bytes: Uint8Array): string {
  let text='';
  for (let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
}
export function wav(pcm: Uint8Array[], compact = false): Uint8Array {
  const inputLength=pcm.reduce((n,b)=>n+b.byteLength,0);
  // A two-minute voice note fits the existing 1.1 MB Gadget WAV envelope
  // as standard telephone-band mono PCM. Preserve full quality for shorter notes.
  const length = compact ? Math.ceil(inputLength / 4) : inputLength;
  const out=new Uint8Array(44+length+(length % 2)), v=new DataView(out.buffer);
  const str=(offset:number,s:string)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,out.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,compact ? 8000 : 16000,true);v.setUint32(28,compact ? 8000 : 32000,true);
  v.setUint16(32,compact ? 1 : 2,true);v.setUint16(34,compact ? 8 : 16,true);str(36,'data');v.setUint32(40,length,true);
  if (compact) {
    const bytes = new Uint8Array(inputLength);
    let cursor = 0;
    for (const frame of pcm) { bytes.set(frame, cursor); cursor += frame.length; }
    const samples = new DataView(bytes.buffer);
    for (let i = 0; i < length; i++) {
      const a = samples.getInt16(i * 4, true);
      const b = i * 4 + 4 <= inputLength ? samples.getInt16(i * 4 + 2, true) : a;
      out[44 + i] = 128 + ((a + b) >> 9);
    }
    return out;
  }
  let offset=44;for(const b of pcm){out.set(b,offset);offset+=b.byteLength;}return out;
}

async function decodeImage(asset: Attachment): Promise<HTMLImageElement> {
  if (!['image/jpeg','image/png','image/webp'].includes(asset.mime) || asset.data_base64.length>30_000_000) throw new Error('Unsupported image');
  const img=new Image();
  // Load events also work in WebViews whose Image.decode() implementation rejects data URLs.
  await new Promise<void>((resolve,reject)=>{
    const finish=(error?:Error)=>{clearTimeout(timer);img.onload=null;img.onerror=null;error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error('Image decode timeout')),15000);
    img.onload=()=>finish();img.onerror=()=>finish(new Error('Image decode'));
    try{img.src=`data:${asset.mime};base64,${asset.data_base64}`;}catch{finish(new Error('Image decode'));}
  });
  if(!img.width||!img.height)throw new Error('Image decode');
  return img;
}

function grayscale(ctx: CanvasRenderingContext2D, width:number, height:number): void {
  const pixels=ctx.getImageData(0,0,width,height);
  for(let i=0;i<pixels.data.length;i+=4){const gray=Math.round((pixels.data[i]!*0.299+pixels.data[i+1]!*0.587+pixels.data[i+2]!*0.114)/17)*17;
    pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=gray;pixels.data[i+3]=255;}
  ctx.putImageData(pixels,0,0);
}

export async function resizeImage(asset: Attachment, glasses=false, dimensions={width:288,height:144}): Promise<Attachment> {
  const img=await decodeImage(asset);
  try{
  const maxW=glasses?dimensions.width:1024,maxH=glasses?dimensions.height:1024;
  const scale=Math.min(maxW/img.width,maxH/img.height,1);
  const canvas=document.createElement('canvas');
  canvas.width=glasses?maxW:Math.max(1,Math.round(img.width*scale));canvas.height=glasses?maxH:Math.max(1,Math.round(img.height*scale));
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image conversion');
  ctx.fillStyle=glasses?'black':'white';ctx.fillRect(0,0,canvas.width,canvas.height);
  const width=Math.round(img.width*scale),height=Math.round(img.height*scale);
  ctx.drawImage(img,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
  if(glasses)grayscale(ctx,canvas.width,canvas.height);
  const mime=glasses?'image/png':'image/jpeg';
  return {mime,name:glasses?'glasses.png':'image.jpg',data_base64:canvas.toDataURL(mime,0.8).split(',')[1]!};
  }catch{throw new Error('Image conversion');}
}

export interface GlassImageTile {
  x:number;
  y:number;
  width:number;
  height:number;
  bytes:Uint8Array;
}

/** Fit one photo to the G2 viewport, then crop encoded PNGs in row-major order. */
export async function glassImageTiles(asset: Attachment, viewport: {width:number;height:number}): Promise<GlassImageTile[]> {
  const {width,height}=viewport;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>576||height>288)throw new Error('Image conversion');
  const img=await decodeImage(asset);
  try{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image conversion');
    ctx.fillStyle='black';ctx.fillRect(0,0,width,height);
    // Photo viewing can enlarge small inputs; resizeImage keeps its no-upscale behavior.
    const scale=Math.min(width/img.width,height/img.height);
    const drawWidth=Math.max(1,Math.round(img.width*scale)),drawHeight=Math.max(1,Math.round(img.height*scale));
    ctx.drawImage(img,(width-drawWidth)/2,(height-drawHeight)/2,drawWidth,drawHeight);
    grayscale(ctx,width,height);
    const columns=Math.ceil(width/288),rows=Math.ceil(height/144),tiles:GlassImageTile[]=[];
    for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
      // Balanced integer boundaries cover every pixel without a tiny final strip.
      const x=Math.floor(column*width/columns),y=Math.floor(row*height/rows);
      const tileWidth=Math.floor((column+1)*width/columns)-x,tileHeight=Math.floor((row+1)*height/rows)-y;
      const tile=document.createElement('canvas');tile.width=tileWidth;tile.height=tileHeight;
      const tileCtx=tile.getContext('2d');if(!tileCtx)throw new Error('Image conversion');
      // Copy the final pixels rather than resampling individual tiles at their seams.
      tileCtx.putImageData(ctx.getImageData(x,y,tileWidth,tileHeight),0,0);
      const bytes=imageBytes({mime:'image/png',name:'glasses.png',data_base64:tile.toDataURL('image/png').split(',')[1]!});
      tiles.push({x,y,width:tileWidth,height:tileHeight,bytes});
    }
    return tiles;
  }catch{throw new Error('Image conversion');}
}

/** Encoded PNG/JPEG bytes for the native List<int> bridge, not raw RGBA pixels. */
export function imageBytes(asset:Attachment):Uint8Array{
  try{
    const bytes=Uint8Array.from(atob(asset.data_base64),char=>char.charCodeAt(0));
    if(!bytes.length)throw new Error('Empty image');
    return bytes;
  }catch{throw new Error('Image conversion');}
}

export const MOTION_SIZE = 144;
export const MOTION_COUNT = 16;
export const MOTION_FRAME_MS = 250;
const SHEET_SIZE = MOTION_SIZE * 4;

function motionCanvas(size:number) {
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=size;
  const ctx=canvas.getContext('2d', {willReadFrequently:true});
  if (!ctx) throw new Error('Image conversion');
  ctx.fillStyle='black';ctx.fillRect(0,0,size,size);
  return ctx;
}

export async function motionFrames(sheet:Attachment,local=false):Promise<Uint8Array[]> {
  if (sheet.mime!=='image/png' || sheet.data_base64.length>(local?2_000_000:333336)) throw new Error('Invalid motion sheet');
  const bytes=imageBytes(sheet);
  const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (bytes.length<24 || (!local && bytes.length>250000) || header.getUint32(0)!==0x89504e47 || header.getUint32(4)!==0x0d0a1a0a
    || header.getUint32(12)!==0x49484452 || header.getUint32(16)!==SHEET_SIZE || header.getUint32(20)!==SHEET_SIZE) throw new Error('Invalid motion sheet');
  const img=await decodeImage(sheet);
  if (img.width!==SHEET_SIZE || img.height!==SHEET_SIZE) throw new Error('Invalid motion sheet');
  const ctx=motionCanvas(MOTION_SIZE);
  return Array.from({length:MOTION_COUNT},(_,index)=>{
    ctx.fillRect(0,0,MOTION_SIZE,MOTION_SIZE);
    ctx.drawImage(img,(index%4)*MOTION_SIZE,Math.floor(index/4)*MOTION_SIZE,MOTION_SIZE,MOTION_SIZE,0,0,MOTION_SIZE,MOTION_SIZE);
    grayscale(ctx,MOTION_SIZE,MOTION_SIZE);
    return imageBytes({mime:'image/png',name:'frame.png',data_base64:ctx.canvas.toDataURL().split(',')[1]!});
  });
}

export async function importMotionSheet(files:File[]):Promise<Attachment> {
  if (files.length!==MOTION_COUNT || new Set(files.map(f=>f.name)).size!==MOTION_COUNT) throw new Error('16 frames required');
  const ctx=motionCanvas(SHEET_SIZE);
  const ordered=[...files].sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));
  for (const [index,file] of ordered.entries()) {
    if (file.size>8_000_000) throw new Error('Image too large');
    const img=await decodeImage({mime:file.type,name:file.name,data_base64:base64(new Uint8Array(await file.arrayBuffer()))});
    if(img.width!==img.height) throw new Error('Square frames required');
    ctx.drawImage(img,index%4*MOTION_SIZE,Math.floor(index/4)*MOTION_SIZE,MOTION_SIZE,MOTION_SIZE);
  }
  grayscale(ctx,SHEET_SIZE,SHEET_SIZE);
  return {mime:'image/png',name:'motion.png',data_base64:ctx.canvas.toDataURL().split(',')[1]!};
}
