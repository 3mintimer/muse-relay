import type { Attachment } from './types';

export function base64(bytes: Uint8Array): string {
  let text='';
  for (let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
}
export function wav(pcm: Uint8Array[]): Uint8Array {
  const length=pcm.reduce((n,b)=>n+b.byteLength,0);
  const out=new Uint8Array(44+length), v=new DataView(out.buffer);
  const str=(offset:number,s:string)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+length,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,length,true);
  let offset=44;for(const b of pcm){out.set(b,offset);offset+=b.byteLength;}return out;
}

export async function resizeImage(asset: Attachment, glasses=false, dimensions={width:288,height:144}): Promise<Attachment> {
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
  try{
  const maxW=glasses?dimensions.width:1024,maxH=glasses?dimensions.height:1024;
  const scale=Math.min(maxW/img.width,maxH/img.height,1);
  const canvas=document.createElement('canvas');
  canvas.width=glasses?maxW:Math.max(1,Math.round(img.width*scale));canvas.height=glasses?maxH:Math.max(1,Math.round(img.height*scale));
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image conversion');
  ctx.fillStyle=glasses?'black':'white';ctx.fillRect(0,0,canvas.width,canvas.height);
  const width=Math.round(img.width*scale),height=Math.round(img.height*scale);
  ctx.drawImage(img,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
  if(glasses){const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
    for(let i=0;i<pixels.data.length;i+=4){const gray=Math.round((pixels.data[i]!*0.299+pixels.data[i+1]!*0.587+pixels.data[i+2]!*0.114)/17)*17;
      pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=gray;pixels.data[i+3]=255;}ctx.putImageData(pixels,0,0);}
  const mime=glasses?'image/png':'image/jpeg';
  return {mime,name:glasses?'glasses.png':'image.jpg',data_base64:canvas.toDataURL(mime,0.8).split(',')[1]!};
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
