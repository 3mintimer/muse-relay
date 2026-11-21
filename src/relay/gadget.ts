import type { Attachment, Relay, RelayRequest, Settings, Snapshot } from '../core/types';
import { endpoint, httpsConnection } from '../core/config';
import { combinedSignal, jsonResponse, parseAttachment, parseSnapshot } from './protocol';
export class HttpsRelay implements Relay {
  private url: string;
  private headers: Record<string,string>;
  constructor(settings: Settings) {
    const { url, token, gatewayToken } = httpsConnection(settings);
    this.url = endpoint(url);
    this.headers = { 'Content-Type': 'application/json' };
    if (token) this.headers.Authorization = `Bearer ${token}`;
    if(gatewayToken)this.headers['OAI-Sites-Authorization']=`Bearer ${gatewayToken}`;
  }
  private async call(path: string, data?: unknown, signal?: AbortSignal): Promise<unknown> {
    return jsonResponse(await fetch(this.url+path,{method:data===undefined?'GET':'POST',headers:this.headers,
      body:data===undefined?undefined:JSON.stringify(data),signal:combinedSignal(signal),redirect:'error',credentials:'omit'}));
  }
  async read(signal?: AbortSignal): Promise<Snapshot> { return parseSnapshot(await this.call('/v1/snapshot',undefined,signal)); }
  async send(request: RelayRequest, signal?: AbortSignal): Promise<void> { await this.call('/v1/requests',request,signal); }
  async attachment(file: string, _mime: string, signal?: AbortSignal): Promise<Attachment> {
    return parseAttachment(await this.call(`/v1/files/${encodeURIComponent(file)}`,undefined,signal));
  }
}
