import type { Attachment, Relay, RelayRequest, Settings, Snapshot } from '../core/types';
import { endpoint } from '../core/config';
import { combinedSignal, jsonResponse, parseAttachment, parseSnapshot } from './protocol';
export class GadgetRelay implements Relay {
  private url: string;
  private headers: Record<string,string>;
  constructor(settings: Settings) {
    this.url=endpoint(settings.relayUrl);
    this.headers={Authorization:`Bearer ${settings.relayToken}`,'Content-Type':'application/json'};
    const gatewayToken=settings.gatewayToken?.trim();
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
