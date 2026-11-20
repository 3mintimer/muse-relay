import type { Settings } from './types';
import { validLanguage } from './i18n';

export const defaults: Settings = {
  relay: 'gist', gistId: '', githubToken: '', relayUrl: '', relayToken: '', gatewayToken: '',
  sonioxAuth: 'auto', sonioxApiKey: '', sonioxTokenUrl: '', sonioxTokenAuth: '', sonioxGatewayToken: '', voice: 'muse', mic: 'glasses', speakerFilter: 'all',
  theme: 'system', language: 'system',
  headWake: false, headWakeMic: false, headWakeAngle: 30, neutralPitch: 0,
  pollSeconds: 15, autoHideSeconds: 0, returnToChatAfterSend: true, chatLayout: 'exchange', images: false, configured: false,
  homeAvatar: 'animation', waitingAvatar: 'animation',
};

export function gistId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:https:\/\/gist\.github\.com\/(?:[^/]+\/)?)?([a-f\d]{20,40})\/?(?:[#?].*)?$/i);
  if (!match) throw new Error('Gist ID / URL');
  return match[1]!;
}

export function endpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) throw new Error('URL');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('HTTPS URL');
  }
  return url.toString().replace(/\/$/, '');
}

// Preserve existing server setups; a new Gist setup needs only the owner's API key.
export function sonioxAuthMode(settings: Settings): 'api-key' | 'token-server' {
  if (settings.sonioxAuth === 'api-key' || settings.sonioxAuth === 'token-server') return settings.sonioxAuth;
  return settings.sonioxTokenUrl.trim() || settings.relay === 'gadget' ? 'token-server' : 'api-key';
}
export type SonioxConnection = { mode: 'api-key'; apiKey: string } |
  { mode: 'token-server'; url: string; token: string; gatewayToken: string; usesRelay: boolean };
export function resolveSonioxConnection(settings: Settings): SonioxConnection {
  if (sonioxAuthMode(settings) === 'api-key') {
    const apiKey = settings.sonioxApiKey.trim();
    // WebSocket protocol entries must be tokens; never expose a constructor error containing a key.
    if (!apiKey || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(apiKey)) throw new Error('Soniox API key');
    return { mode: 'api-key', apiKey };
  }
  if (settings.sonioxTokenUrl.trim()) {
    return { mode: 'token-server', url: endpoint(settings.sonioxTokenUrl), token: settings.sonioxTokenAuth.trim(), gatewayToken: settings.sonioxGatewayToken.trim(), usesRelay: false };
  }
  if (settings.relay !== 'gadget') throw new Error('Soniox endpoint');
  // Only the relay's fixed token route inherits its credentials. Custom URLs never do.
  return { mode: 'token-server', url: `${endpoint(settings.relayUrl)}/v1/soniox-token`, token: settings.relayToken.trim(), gatewayToken: settings.gatewayToken.trim(), usesRelay: true };
}

export function validateSettings(input: Settings, requireConnection=true): Settings {
  const result = { ...defaults, ...input };
  // A stale locale must not make otherwise valid connection settings unreadable.
  if(!validLanguage(result.language))result.language='system';
  if (!['all','self','other'].includes(result.speakerFilter)) result.speakerFilter = defaults.speakerFilter;
  if (!['auto','api-key','token-server'].includes(result.sonioxAuth)) result.sonioxAuth = 'auto';
  if (typeof result.sonioxApiKey !== 'string') result.sonioxApiKey = '';
  result.sonioxApiKey = result.sonioxApiKey.trim();
  if (!['gist','gadget'].includes(result.relay) || !['muse','soniox'].includes(result.voice)
    || !['glasses','phone'].includes(result.mic)
    || !['system','light','dark'].includes(result.theme)) throw new Error('Settings');
  result.pollSeconds = Math.max(5, Math.min(300, Math.round(Number(result.pollSeconds) || 15)));
  if (![0,5,10,15,20,25,30].includes(result.autoHideSeconds)) result.autoHideSeconds = 0;
  result.headWake = result.headWake === true && result.autoHideSeconds > 0;
  result.headWakeMic = result.headWakeMic === true;
  if (!Number.isInteger(result.headWakeAngle) || result.headWakeAngle < 10 || result.headWakeAngle > 60) result.headWakeAngle = defaults.headWakeAngle;
  if (!Number.isFinite(result.neutralPitch) || Math.abs(result.neutralPitch) > 90) result.neutralPitch = 0;
  if (typeof result.returnToChatAfterSend !== 'boolean') result.returnToChatAfterSend = defaults.returnToChatAfterSend;
  if (!['exchange','single'].includes(result.chatLayout)) result.chatLayout = defaults.chatLayout;
  if (!['animation','still','off'].includes(result.homeAvatar)) result.homeAvatar = defaults.homeAvatar;
  if (!['animation','off'].includes(result.waitingAvatar)) result.waitingAvatar = defaults.waitingAvatar;
  for (const key of ['gatewayToken','sonioxGatewayToken'] as const) {
    if (typeof result[key] !== 'string' || /[\r\n]/.test(result[key])) throw new Error('Settings');
    result[key] = result[key].trim();
  }
  if (!requireConnection) return result;
  if (result.relay === 'gist') {
    result.gistId = gistId(result.gistId);
    result.githubToken = result.githubToken.trim();
    if (!result.githubToken) throw new Error('GitHub token');
  } else {
    result.relayUrl = endpoint(result.relayUrl);
    if (!result.relayToken.trim()) throw new Error('Relay token');
  }
  if (result.voice === 'soniox') {
    resolveSonioxConnection(result);
    if (sonioxAuthMode(result) === 'token-server' && result.sonioxTokenUrl.trim()) result.sonioxTokenUrl = endpoint(result.sonioxTokenUrl);
  }
  return result;
}
