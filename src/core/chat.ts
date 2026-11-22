import type { Message } from './types';

export function unreadMessageIds(visible: readonly Message[], readIds: readonly string[]): string[] {
  return visible.filter(message => message.from.toLowerCase() !== 'you' && !readIds.includes(message.id)).map(message => message.id);
}

export interface SentChat { id: string; previousIds: ReadonlySet<string>; needsReplyId: boolean; }
interface ChatOptions {
  legacy?: boolean;
  following?: SentChat;
  images?: boolean;
}

/** Pair explicit reply IDs first. Legacy messages can use their chronological turn. */
export function chatExchange(messages:readonly Message[],selectedId:string,options:ChatOptions={}):{input:Message;reply?:Message}|undefined{
  const ordered=[...messages].sort((a,b)=>a.ts-b.ts);
  const selected=ordered.find(m=>m.id===selectedId);
  if(!selected)return;
  const own=(m:Message)=>m.from==='You';
  const legacy=options.legacy&&!ordered.some(m=>!own(m)&&m.reply_to);
  const requestId=(m:Message)=>m.reply_to||m.id;
  const inputFor=(id:string)=>{
    const candidates=ordered.filter(m=>own(m)&&(m.id===id||m.reply_to===id));
    return candidates.filter(m=>m.reply_to===id&&chatText(m).trim()).at(-1)
      ||candidates.filter(m=>chatText(m).trim()).at(-1)||candidates.at(-1);
  };
  if(!own(selected)){
    // Never attach an unrelated nearby input when an explicit reference is missing/hidden.
    const preceding=ordered.slice(0,ordered.indexOf(selected)).filter(m=>own(m)&&!m.reply_to).at(-1);
    const input=selected.reply_to?inputFor(selected.reply_to):legacy&&preceding?inputFor(preceding.id):undefined;
    return input?{input,reply:selected}:undefined;
  }
  const id=requestId(selected),input=inputFor(id)||selected;
  const linked=ordered.filter(m=>!own(m)&&m.reply_to===id);
  const original=ordered.find(m=>own(m)&&m.id===id)||selected;
  const sent = options.following?.id === id ? options.following : undefined;
  // With second-resolution legacy timestamps, a previously viewed reply can sort after
  // this input, or an incoming answer can precede its locally appended echo on a tie.
  const after = sent && legacy
    ? ordered.filter(m => m.id !== id && !sent.previousIds.has(m.id) && m.ts >= original.ts)
    : ordered.slice(ordered.indexOf(original)+1);
  const boundary=after.findIndex(m=>own(m)&&requestId(m)!==id);
  const following=legacy&&!sent?.needsReplyId?after.slice(0,boundary<0?undefined:boundary).filter(m=>!own(m)&&!m.reply_to):[];
  const replies=linked.length?linked:following;
  const reply=sent ? replies.filter(m=>displayableReply(m,options.images===true)).at(-1)
    : replies.filter(m=>m.from!=='Relay').at(-1)||replies.at(-1);
  return {input,reply};
}

/** Muse SDK audio rows may include an attachment marker after the transcript. */
export function chatText(message:Message):string{
  if(message.type!=='voice-note')return message.text;
  return message.text.replace(/\s*\[file:audio\/[^\]\r\n]*\]/g,'').trim().replace(/^\[Voice note\]$/i,'');
}

/** Relay status rows and audio without a transcript are not a visible Muse answer. */
function displayableReply(message:Message,images:boolean):boolean{
  return message.from!=='Relay'&&message.from!=='You'&&!message.id.startsWith('status_')
    &&Boolean(chatText(message).trim()||(images&&(message.image?.data_base64||message.image_file)));
}

export function displayableMuseReply(message:Message,images:boolean):boolean{
  return message.from==='Muse' && displayableReply(message,images);
}

/** A paired input is already visible with its reply; swiping must not show it twice. */
export function chatEntries(messages:readonly Message[],options:ChatOptions={}):Message[]{
  return messages.filter(message=>{
    if(message.from!=='You')return true;
    const exchange=chatExchange(messages,message.id,options);
    return !exchange?.reply&&exchange?.input.id===message.id;
  });
}
