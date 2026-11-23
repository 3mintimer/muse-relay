import type { Attachment, Relay, RelayRequest, Settings, Snapshot } from '../core/types';
import { gistId } from '../core/config';
import { combinedSignal, jsonResponse, parseMotionRecord, parseSnapshot, record } from './protocol';

type GistFile = { content?: string; truncated?: boolean; raw_url?: string };
export class GistRelay implements Relay {
  private url: string;
  private headers: Record<string,string>;
  private files: Record<string,GistFile> = {};
  private etag = '';
  private cached: Snapshot | undefined;
  constructor(settings: Settings) {
    this.url = `https://api.github.com/gists/${gistId(settings.gistId)}`;
    this.headers = {Authorization:`Bearer ${settings.githubToken}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  }
  private async file(name: string, signal?: AbortSignal): Promise<string> {
    const f = this.files[name];
    if (!f) throw new Error('Relay file missing');
    if (!f.truncated && typeof f.content === 'string') return f.content;
    const u = new URL(f.raw_url || '');
    if (u.protocol !== 'https:' || u.hostname !== 'gist.githubusercontent.com') throw new Error('Invalid Gist file URL');
    // Raw URLs are retrieved without the GitHub credential, including redirects.
    const res = await fetch(u,{signal:combinedSignal(signal),redirect:'error',credentials:'omit'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 6_000_000) throw new Error('Gist file too large');
    return text;
  }
  async read(signal?: AbortSignal): Promise<Snapshot> {
    const res = await fetch(this.url,{headers:{...this.headers,...(this.etag ? {'If-None-Match':this.etag}:{})},signal:combinedSignal(signal),cache:'no-cache',redirect:'error'});
    if (res.status === 304 && this.cached) return {...this.cached,messages:[...this.cached.messages]};
    const data = record(await jsonResponse(res));
    this.files = record(data.files) as Record<string,GistFile>;
    const root = record(JSON.parse(await this.file('g2muse-relay.json',signal)));
    if (this.files['muse-relay-spaces.json']) {
      root.spaces = record(JSON.parse(await this.file('muse-relay-spaces.json',signal))).spaces;
    }
    if(this.files['muse-relay-profile.json']){
      try{root.profile=record(JSON.parse(await this.file('muse-relay-profile.json',signal))).profile;}
      catch{delete root.profile;}
    }
    const snapshot = parseSnapshot(root);
    if (this.files['muse-relay-motions.json']) {
      try { snapshot.motions=parseMotionRecord(JSON.parse(await this.file('muse-relay-motions.json',signal))); }
      catch { /* Optional character art must not interrupt messages. */ }
    }
    snapshot.capabilities = {audio:true,images:true,spaces:true,
      ...(snapshot.capabilities?.reply_suggestions ? {reply_suggestions:true} : {})};
    this.etag = res.headers.get('ETag') || '';
    // The controller merges local echoes into its copy. Keep the Gist's row order for selection checks.
    this.cached = {...snapshot,messages:[...snapshot.messages]};
    return snapshot;
  }
  async send(request: RelayRequest, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.id)) throw new Error('Request ID');
    const files: Record<string,{content:string}> = {};
    const payload: Record<string,unknown> = {...request,audio:undefined,image:undefined,protocol:'muse-relay/1'};
    for (const kind of ['audio','image'] as const) {
      const asset = request[kind];
      if (!asset) continue;
      if (asset.data_base64.length > 5_500_000) throw new Error('Attachment too large');
      // A separate filename per request avoids two writers replacing a shared inbox.
      const file = `muse-relay-${kind}-${request.id}.base64`;
      files[file] = {content:asset.data_base64};
      payload[`${kind}_file`] = file;
      payload[`${kind}_mime`] = asset.mime;
      payload[`${kind}_name`] = asset.name;
    }
    const name = `muse-relay-request-${request.id}.json`;
    const content = JSON.stringify(payload);
    if (request.kind === 'suggestion_reply') {
      const current = await this.read(signal);
      if (this.files[name]) {
        if (await this.file(name,signal) === content) return;
        throw new Error('HTTP 409');
      }
      if (current.messages.some(m => m.from === 'You' && m.id === request.id && m.text === request.text)) return;
      const parent = current.messages.findLast(m => m.from === 'Muse');
      const input = current.messages.findLast(m => m.from === 'You' && !m.reply_to);
      if (!current.capabilities?.reply_suggestions || !parent || parent.id !== request.suggestion_for || parent.reply_to !== input?.id
        || !parent.reply_suggestions?.includes(request.text)) throw new Error('HTTP 409');
    }
    files[name] = {content};
    await jsonResponse(await fetch(this.url,{method:'PATCH',headers:{...this.headers,'Content-Type':'application/json'},body:JSON.stringify({files}),signal:combinedSignal(signal),redirect:'error'}));
    this.etag='';
  }
  async attachment(file: string, mime: string, signal?: AbortSignal): Promise<Attachment> {
    if (!this.files[file]) await this.read(signal);
    const data = await this.file(file,signal);
    if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(data) || !['image/png','image/jpeg','image/webp'].includes(mime)) throw new Error('Invalid image');
    return {mime,data_base64:data.replace(/\s/g,''),name:file};
  }
}
