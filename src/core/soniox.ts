import type { Settings } from './types';
import { resolveSonioxConnection } from './config';
import { jsonResponse, record } from '../relay/protocol';
import { speechLanguage } from './i18n';

const PCM_BYTES_PER_MS = 32; // 16 kHz, signed 16-bit mono.
const PCM_CHUNK_BYTES = 100 * PCM_BYTES_PER_MS;

function waitForAudioTime(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class SonioxStream {
  private readonly abort = new AbortController();
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private ready = false;
  private readonly queuedAudio: Uint8Array[] = [];
  private draining?: Promise<void>;
  private finalText='';
  private resolve?: (value:string)=>void;
  private reject?: (error:Error)=>void;
  private completed=false;
  private onText: (text:string)=>void;
  private onError: (error:Error)=>void;
  constructor(onText:(text:string)=>void,onError:(error:Error)=>void){this.onText=onText;this.onError=onError;}

  start(settings: Settings): Promise<void> {
    this.opening ??= this.connect(settings).then(() => {
      this.abort.signal.throwIfAborted();
      this.ready = true;
      if (this.queuedAudio.length) this.draining = this.drainAudio();
    }).catch(error => { this.fail(error); throw error; });
    return this.opening;
  }

  private async connect(settings: Settings): Promise<void> {
    const signal = this.abort.signal;
    signal.throwIfAborted();
    const connection=resolveSonioxConnection(settings);
    let key: string;
    if (connection.mode === 'api-key') key = connection.apiKey;
    else {
      // Endpoint credentials belong only to that endpoint, never the Soniox socket.
      const data=record(await jsonResponse(await fetch(connection.url,{method:'POST',
        headers:{...(connection.token?{Authorization:`Bearer ${connection.token}`} : {}),
          ...(connection.gatewayToken?{'OAI-Sites-Authorization':`Bearer ${connection.gatewayToken}`}:{})},
        signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),redirect:'error',credentials:'omit'})));
      key=String(data.api_key||'');
      if(!/^snx_temp_[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))throw new Error('Soniox temporary key');
    }
    signal.throwIfAborted();
    const ws=new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket',['soniox-api-key',key]);this.socket=ws;
    ws.onmessage=event=>{
      if(signal.aborted||this.completed)return;
      try {
        const data=record(JSON.parse(String(event.data)));
        if(data.error_code){this.fail(new Error(`Soniox ${Number(data.error_code)}`));return;}
        let partial='';
        if(Array.isArray(data.tokens))for(const token of data.tokens){const t=record(token);const text=typeof t.text==='string'?t.text:'';
          if(text==='<end>'||text==='<fin>')continue;
          if(t.is_final)this.finalText+=text;else partial+=text;}
        this.onText(this.finalText+partial);
        if(data.finished){this.completed=true;this.resolve?.(this.finalText.trim());}
      }catch{this.fail(new Error('Soniox response'));}
    };
    ws.onclose=()=>this.fail(new Error('Soniox disconnected'));
    ws.onerror=()=>this.fail(new Error('Soniox connection'));
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => this.fail(new Error('Soniox timeout')), 10000);
      signal.addEventListener('abort', abort, { once: true });
      ws.onopen = () => {
        if (signal.aborted) return;
        try {
          ws.send(JSON.stringify({model:'stt-rt-v6',audio_format:'pcm_s16le',sample_rate:16000,num_channels:1,language_hints:[speechLanguage(settings.language)],enable_endpoint_detection:true}));
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve();
        } catch (error) { this.fail(error); }
      };
    });
  }

  push(pcm: Uint8Array): void {
    this.abort.signal.throwIfAborted();
    if (!this.opening || this.completed) throw new Error('Soniox disconnected');
    if (!pcm.length) return;
    if (!this.ready || this.draining) this.queuedAudio.push(pcm.slice());
    else this.sendAudio(pcm);
  }

  private sendAudio(pcm: Uint8Array): void {
    this.abort.signal.throwIfAborted();
    if(this.socket?.readyState!==WebSocket.OPEN)throw new Error('Soniox disconnected');
    if(this.socket.bufferedAmount>512000)throw new Error('Soniox network slow');
    this.socket.send(pcm.slice().buffer);
  }

  // Soniox tolerates short bursts and expects a near-real-time pace for longer audio.
  // Incoming frames join the same queue until the audio recorded during setup is sent.
  private async drainAudio(): Promise<void> {
    try {
      while (this.queuedAudio.length) {
        const pcm = this.queuedAudio.shift()!;
        for (let offset = 0; offset < pcm.length; offset += PCM_CHUNK_BYTES) {
          const chunk = pcm.subarray(offset, offset + PCM_CHUNK_BYTES);
          this.sendAudio(chunk);
          await waitForAudioTime(chunk.length / PCM_BYTES_PER_MS, this.abort.signal);
        }
      }
    } catch (error) { this.fail(error); }
    finally { this.draining = undefined; }
  }

  async finish(): Promise<string> {
    if (!this.opening) throw new Error('Soniox disconnected');
    await this.opening;
    await this.draining;
    this.abort.signal.throwIfAborted();
    if(this.completed)return this.finalText.trim();
    return new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error('Soniox finalization timeout')),15000);
      this.resolve=text=>{clearTimeout(timer);this.socket?.close();resolve(text);};
      this.reject=e=>{clearTimeout(timer);reject(e);};
      try { this.socket!.send(''); } catch (error) { this.fail(error); }
    });
  }

  private fail(error: unknown): void {
    if (this.completed || this.abort.signal.aborted) return;
    const failure = error instanceof Error ? error : new Error('Soniox connection');
    this.close(failure);
    this.onError(failure);
  }
  private close(reason: Error): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort(reason);
    this.queuedAudio.length = 0;
    this.reject?.(reason);
    this.socket?.close();
  }
  cancel(): void { this.close(new Error('Soniox cancelled')); }
}

/** Verify a completed session, not just onopen (which also fires for invalid keys).
 * Sends one second of synthetic silence. Never opens a microphone or contacts Muse. */
export async function checkSonioxConnection(settings: Settings): Promise<void> {
  const stream = new SonioxStream(() => {}, () => {});
  try { await stream.start(settings); stream.push(new Uint8Array(32000)); await stream.finish(); }
  finally { stream.cancel(); }
}
