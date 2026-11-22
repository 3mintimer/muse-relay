import type { Message, Snapshot, Space, Attachment } from '../core/types';
import { MOTION_SPACE_ID, motionKinds } from '../core/types';
import { parseSpaceControl } from '../../protocol/space-controls.mjs';
import { chatLocation } from '../../protocol/chat-location.mjs';

export function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid relay data');
  return v as Record<string, unknown>;
}
function string(v: unknown, max = 20000): string { return typeof v === 'string' ? v.slice(0,max) : ''; }
export function parseAttachment(value: unknown): Attachment {
  const a = record(value);
  if (!['image/jpeg','image/png','image/webp','audio/wav','audio/ogg'].includes(String(a.mime))
    || typeof a.data_base64 !== 'string' || a.data_base64.length > 6_000_000
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data_base64)) throw new Error('Invalid attachment');
  return { mime: String(a.mime), data_base64: a.data_base64, name: string(a.name,128) };
}
export function parseMotionRecord(value:unknown):Snapshot['motions'] {
  const s=record(value);
  if (s.id!==MOTION_SPACE_ID || !Array.isArray(s.items)) return;
  const motions:NonNullable<Snapshot['motions']>={};
  for (const kind of motionKinds) {
    const item=s.items.find(i=>i && i.id===kind);
    if (!item) continue;
    try {
      const image=item.image ? parseAttachment(item.image) : undefined;
      if (image && (image.mime!=='image/png' || image.data_base64.length>333336)) continue;
      const file=string(item.image_file,256)||undefined;
      if (image || file) motions[kind]={image,file,revision:Number(s.updated_at)||0};
    } catch { /* A malformed optional loop cannot break chat or its sibling. */ }
  }
  return motions;
}

export function parseSnapshot(value: unknown, source: 'relay' | 'cache' = 'relay'): Snapshot {
  const v = record(value);
  if (!Array.isArray(v.messages)) throw new Error('Relay messages missing');
  const messages: Message[] = [];
  const ids = new Set<string>();
  for (const raw of v.messages.slice(-200)) {
    const m = record(raw);
    if (typeof m.id !== 'string' || ids.has(m.id) || !Number.isFinite(m.ts)) continue;
    ids.add(m.id);
    const sentLocation = source === 'cache' && m.from === 'You' && chatLocation({kind:'chat', location:m.sentLocation});
    messages.push({id:string(m.id,128), from:string(m.from,100),
      ...(sentLocation ? {sentLocation} : {}),
      type:m.type === 'voice-note' ? 'voice-note' : m.type === 'image' ? 'image' : 'text',
      text:string(m.text), ts:Number(m.ts), audio_file:string(m.audio_file,256) || undefined,
      image_file:string(m.image_file,256) || undefined, mime_type:string(m.mime_type,100) || undefined,
      reply_to:string(m.reply_to,128) || undefined,
      ...(m.image ? {image:parseAttachment(m.image)} : {}),
    });
  }
  const spaces: Space[] = [];
  let motions: Snapshot['motions'];
  for (const raw of (Array.isArray(v.spaces) ? v.spaces : []).slice(0,24)) {
    const s = record(raw);
    if (typeof s.id !== 'string' || !Array.isArray(s.items)) continue;
    if (s.id === MOTION_SPACE_ID) {
      motions = parseMotionRecord(s);
      continue;
    }
    spaces.push({id:string(s.id,128),title:string(s.title,100),layout:s.layout==='cards'?'cards':'list',updated_at:Number(s.updated_at)||undefined,
      items:s.items.slice(0,50).map(raw => {
        const i = record(raw);
        let control;
        if(i.control!==undefined){try{control=parseSpaceControl(i.control);}catch{control={type:'unsupported' as const,disabled:true as const};}}
        return {id:string(i.id,128),title:string(i.title,100),text:string(i.text),ts:Number(i.ts)||undefined,...(control?{control}:{}),
          image_file:string(i.image_file,256)||undefined,...(i.image ? {image:parseAttachment(i.image)}:{})};
      }).filter(i=>i.id),
    });
  }
  messages.sort((a,b)=>a.ts-b.ts);
  const snapshot: Snapshot = {messages,spaces};
  if (motions) snapshot.motions = motions;
  // A missing or malformed optional profile must not interrupt chat and space access.
  if(v.profile&&typeof v.profile==='object'&&!Array.isArray(v.profile)){
    const p=record(v.profile);
    snapshot.profile={name:string(p.name,120)||undefined,avatar_file:string(p.avatar_file,256)||undefined,
      mime_type:['image/png','image/jpeg','image/webp'].includes(String(p.mime_type))?String(p.mime_type):'image/png',
      updated_at:Number.isFinite(p.updated_at)?Number(p.updated_at):undefined};
    if(p.avatar)try{
      const avatar=parseAttachment(p.avatar);
      if(!avatar.mime.startsWith('image/')||!avatar.data_base64.length||avatar.data_base64.length>333336)throw new Error('Invalid avatar');
      snapshot.profile.avatar=avatar;
    }catch{/* Optional image; preserve readable profile metadata. */}
  }
  if (v.device) { const d=record(v.device); snapshot.device={connected:d.connected===true,last_seen:Number(d.last_seen)||undefined}; }
  if (v.capabilities) {
    const c=record(v.capabilities);
    snapshot.capabilities={audio:c.audio===true,images:c.images===true,spaces:c.spaces===true,
      ...(typeof c.soniox==='boolean'?{soniox:c.soniox}:{}),...(c.live_transcription===true?{live_transcription:true}:{})};
  }
  return snapshot;
}

export async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 8_000_000) throw new Error('Relay data too large');
  return JSON.parse(text);
}

export function combinedSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal,AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
}
