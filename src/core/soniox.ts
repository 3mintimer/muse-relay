import type { Settings } from './types';
import { endpoint, resolveSonioxConnection } from './config';
import { jsonResponse, record } from '../relay/protocol';
import { speechLanguage } from './i18n';

const PCM_CHUNK_BYTES = 3200; // 100 ms of 16 kHz, signed 16-bit mono audio.
const SOCKET_BUFFER_LIMIT = 512000;

function waitForSocketBuffer(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 20);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class SonioxStream {
  private readonly abort = new AbortController();
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private ready = false;
  private readonly queuedAudio: Uint8Array[] = [];
  private finalText='';
  private resolve?: (value:string)=>void;
  private reject?: (error:Error)=>void;
  private completed=false;
  private onText: (text:string)=>void;
  private onError: (error:Error)=>void;
  private onEndpoint?: () => void;
  constructor(onText:(text:string)=>void,onError:(error:Error)=>void,onEndpoint?:()=>void){
    this.onText=onText;this.onError=onError;this.onEndpoint=onEndpoint;
  }

  start(settings: Settings, viaRelay = false): Promise<void> {
    this.opening ??= this.connect(settings, viaRelay)
      .then(() => this.flushStartupAudio())
      .catch(error => { this.fail(error); throw error; });
    return this.opening;
  }

  private async connect(settings: Settings, viaRelay: boolean): Promise<void> {
    const signal = this.abort.signal;
    signal.throwIfAborted();
    let url = 'wss://stt-rt.soniox.com/transcribe-websocket';
    let protocols: string[];
    if (viaRelay) {
      const relayUrl = new URL(`${endpoint(settings.relayUrl)}/v1/voice/live`);
      relayUrl.protocol = relayUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      url = relayUrl.href;
      const token = settings.relayToken.trim();
      if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new Error('Relay token');
      protocols = ['muse-relay-voice', token];
    } else {
      const connection = resolveSonioxConnection(settings);
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
      protocols = ['soniox-api-key', key];
    }
    signal.throwIfAborted();
    const ws = new WebSocket(url, protocols);
    this.socket = ws;
    ws.onmessage=event=>{
      if(signal.aborted||this.completed)return;
      try {
        const data=record(JSON.parse(String(event.data)));
        if(data.error_code){this.fail(new Error(`Soniox ${Number(data.error_code)}`));return;}
        let partial='', ended=false;
        if(Array.isArray(data.tokens))for(const token of data.tokens){const t=record(token);const text=typeof t.text==='string'?t.text:'';
          if(text==='<end>'){ended=t.is_final===true;continue;}
          if(text==='<fin>')continue;
          if(text.trim())ended=false;
          if(t.is_final)this.finalText+=text;else partial+=text;}
        this.onText(this.finalText+partial);
        if(data.finished){this.completed=true;this.resolve?.(this.finalText.trim());}
        else if(ended && this.finalText.trim() && !partial.trim())this.onEndpoint?.();
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
    if (!this.ready) this.queuedAudio.push(pcm.slice());
    else this.sendAudio(pcm);
  }

  private sendAudio(pcm: Uint8Array): void {
    this.abort.signal.throwIfAborted();
    if(this.socket?.readyState!==WebSocket.OPEN)throw new Error('Soniox disconnected');
    if(this.socket.bufferedAmount>SOCKET_BUFFER_LIMIT)throw new Error('Soniox network slow');
    this.socket.send(pcm.slice().buffer);
  }

  // Flush the startup backlog right after configuration, then hand off to live audio.
  // Waiting for each chunk's playback time would keep captions behind the speaker.
  private async flushStartupAudio(): Promise<void> {
    const signal = this.abort.signal;
    signal.throwIfAborted();
    const socket = this.socket!;
    for (const pcm of this.queuedAudio) {
      for (let offset = 0; offset < pcm.length; offset += PCM_CHUNK_BYTES) {
        const chunk = pcm.subarray(offset, offset + PCM_CHUNK_BYTES);
        const deadline = Date.now() + 10000;
        while (socket.bufferedAmount + chunk.length > SOCKET_BUFFER_LIMIT) {
          if (Date.now() >= deadline) throw new Error('Soniox network slow');
          await waitForSocketBuffer(signal);
        }
        this.sendAudio(chunk);
      }
    }
    this.queuedAudio.length = 0;
    this.ready = true;
  }

  async finish(): Promise<string> {
    if (!this.opening) throw new Error('Soniox disconnected');
    await this.opening;
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

// The deployed relay accepts 30 seconds per live socket. Finish each part
// independently while the next socket buffers its opening audio.
export class RelayVoiceSession {
  private parts: { stream: SonioxStream; text: string; result?: Promise<string> }[] = [];
  private bytes = 0;
  private stopped = false;
  private settings: Settings;
  private onText: (text: string) => void;
  private onError: (error: Error) => void;
  private onEndpoint?: () => void;
  constructor(settings: Settings, onText: (text: string) => void, onError: (error: Error) => void, onEndpoint?: () => void) {
    this.settings = settings; this.onText = onText; this.onError = onError; this.onEndpoint = onEndpoint;
  }

  private openPart() {
    const part = {text: '', stream: new SonioxStream(text => {
      if (this.stopped) return;
      part.text = text;
      this.onText(this.parts.map(part => part.text).filter(Boolean).join(' '));
    }, this.onError, () => {
      // A closing 30-second segment can report its endpoint after the next segment starts.
      if (!this.stopped && this.parts.at(-1) === part) this.onEndpoint?.();
    }), result: undefined as Promise<string> | undefined};
    this.parts.push(part);
    this.bytes = 0;
    return part.stream.start(this.settings, true);
  }

  start() { return this.openPart(); }
  push(pcm: Uint8Array) {
    const limit = 30 * 32000;
    for (let offset = 0; offset < pcm.length;) {
      if (this.bytes === limit) {
        const previous = this.parts.at(-1)!;
        previous.result = previous.stream.finish();
        void previous.result.catch(() => {}); // The stream reports failures to the controller.
        void this.openPart().catch(() => {});
      }
      const count = Math.min(limit - this.bytes, pcm.length - offset);
      this.parts.at(-1)!.stream.push(pcm.subarray(offset, offset + count));
      this.bytes += count;
      offset += count;
    }
  }
  async finish() {
    const texts = await Promise.all(this.parts.map(part => part.result ?? part.stream.finish()));
    return texts.filter(Boolean).join(' ');
  }
  cancel() {
    this.stopped = true;
    for (const part of this.parts) part.stream.cancel();
  }
}
