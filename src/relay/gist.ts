import type { Attachment, Relay, RelayRequest, Settings, Snapshot } from '../core/types';
import { gistId } from '../core/config';
import { combinedSignal, jsonResponse, parseSnapshot, record } from './protocol';

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
    if (res.status === 304 && this.cached) return this.cached;
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
    snapshot.capabilities = {audio:true,images:true,spaces:true};
    this.etag = res.headers.get('ETag') || '';
    this.cached = snapshot;
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
    files[`muse-relay-request-${request.id}.json`] = {content:JSON.stringify(payload)};
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
