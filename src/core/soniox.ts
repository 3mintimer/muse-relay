import type { Settings } from './types';
import { resolveSonioxConnection } from './config';
import { jsonResponse, record } from '../relay/protocol';
import { speechLanguage } from './i18n';

export class SonioxStream {
  private socket?: WebSocket;
  private finalText='';
  private resolve?: (value:string)=>void;
  private reject?: (error:Error)=>void;
  private completed=false;
  private failure?: Error;
  private onText: (text:string)=>void;
  private onError: (error:Error)=>void;
  constructor(onText:(text:string)=>void,onError:(error:Error)=>void){this.onText=onText;this.onError=onError;}
  async start(settings: Settings): Promise<void> {
    const connection=resolveSonioxConnection(settings);
    let key: string;
    if (connection.mode === 'api-key') key = connection.apiKey;
    else {
      // Endpoint credentials belong only to that endpoint, never the Soniox socket.
      const data=record(await jsonResponse(await fetch(connection.url,{method:'POST',
        headers:{...(connection.token?{Authorization:`Bearer ${connection.token}`} : {}),
          ...(connection.gatewayToken?{'OAI-Sites-Authorization':`Bearer ${connection.gatewayToken}`}:{})},
        signal:AbortSignal.timeout(15000),redirect:'error',credentials:'omit'})));
      key=String(data.api_key||'');
      if(!/^snx_temp_[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))throw new Error('Soniox temporary key');
    }
    const ws=new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket',['soniox-api-key',key]);this.socket=ws;
    const fail=(e:Error)=>{if(this.failure||this.completed)return;this.failure=e;this.reject?.(e);this.onError(e);};
    ws.onmessage=event=>{
      try {
        const data=record(JSON.parse(String(event.data)));
        if(data.error_code){fail(new Error(`Soniox ${Number(data.error_code)}`));ws.close();return;}
        let partial='';
        if(Array.isArray(data.tokens))for(const token of data.tokens){const t=record(token);const text=typeof t.text==='string'?t.text:'';
          if(text==='<end>'||text==='<fin>')continue;
          if(t.is_final)this.finalText+=text;else partial+=text;}
        this.onText(this.finalText+partial);
        if(data.finished){this.completed=true;this.resolve?.(this.finalText.trim());}
      }catch{fail(new Error('Soniox response'));ws.close();}
    };
    ws.onclose=()=>{if(!this.completed)fail(new Error('Soniox disconnected'));};
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.close();reject(new Error('Soniox timeout'));},10000);
      ws.onopen=()=>{clearTimeout(timer);ws.send(JSON.stringify({model:'stt-rt-v6',audio_format:'pcm_s16le',sample_rate:16000,num_channels:1,language_hints:[speechLanguage(settings.language)],enable_endpoint_detection:true}));resolve();};
      ws.onerror=()=>{clearTimeout(timer);const e=new Error('Soniox connection');reject(e);fail(e);};
    });
  }
  push(pcm: Uint8Array): void {
    if(this.failure)throw this.failure;
    if(this.socket?.readyState!==WebSocket.OPEN)throw new Error('Soniox disconnected');
    if(this.socket.bufferedAmount>512000)throw new Error('Soniox network slow');
    this.socket.send(pcm.slice().buffer);
  }
  async finish(): Promise<string> {
    if(this.failure)throw this.failure;
    if(this.completed)return this.finalText.trim();
    return new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.socket?.close();reject(new Error('Soniox finalization timeout'));},15000);
      this.resolve=text=>{clearTimeout(timer);this.socket?.close();resolve(text);};
      this.reject=e=>{clearTimeout(timer);reject(e);};
      this.socket?.send('');
    });
  }
  cancel():void{this.completed=true;this.socket?.close();}
}

/** Verify a completed session, not just onopen (which also fires for invalid keys).
 * Sends one second of synthetic silence. Never opens a microphone or contacts Muse. */
export async function checkSonioxConnection(settings: Settings): Promise<void> {
  const stream = new SonioxStream(() => {}, () => {});
  try { await stream.start(settings); stream.push(new Uint8Array(32000)); await stream.finish(); }
  finally { stream.cancel(); }
}
