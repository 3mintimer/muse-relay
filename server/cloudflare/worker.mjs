import {
  MAX_BODY, LEASE_MS, HttpError, fail, equal, validateConfig, validateRequest, isOriginAllowed,
  validatePublishedMessage, validateProfile, spaceExportRoute, validateSpaceWrite, exportSpaces, prepareMuseRequest, buildMuseRequest, fingerprint,
  createMachine, byteLength,
} from '../core.mjs';
import { D1StateStore, R2Attachments } from './storage.mjs';
import { LIVE_VOICE_PROTOCOL, openLiveVoice } from './live-voice.mjs';

const MAX_SPACE_IMAGES = 8;

function configuration(env) {
  return validateConfig({
    relayToken: env.RELAY_TOKEN, deviceToken: env.DEVICE_TOKEN, museToken: env.MUSE_TOKEN,
    sonioxApiKey: env.SONIOX_API_KEY, publicUrl: env.PUBLIC_URL,
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    imagesEnabled: env.GADGET_IMAGES_ENABLED === 'true',
  });
}
async function readJson(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) fail(413, 'request_too_large');
  if (!request.body) fail(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BODY) { await reader.cancel(); fail(413, 'request_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'invalid_json'); }
}
function response(status, data, headers) {
  const body = JSON.stringify(data);
  return new Response(body, { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': String(byteLength(body)), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
function publicSnapshot(value) {
  const result = structuredClone(value);
  // The phone loads an Attachment through /v1/files; storage keys stay server-side.
  for (const message of result.messages) if (message.image?._blob) delete message.image;
  for (const space of result.spaces) for (const item of space.items) if (item.image?._blob) delete item.image;
  if (result.profile?.avatar?._blob) delete result.profile.avatar;
  return result;
}
function reportSonioxFailure(error, phase) {
  const name = ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
  // Only fixed classifications are logged. Error messages can contain credentials or URLs.
  const message = typeof error?.message === 'string' ? error.message : '';
  const reason = /Illegal invocation|incorrect this reference/i.test(message) ? 'illegal_invocation'
    : /redirect/i.test(message) && /unsupported|invalid|not implemented|not a valid/i.test(message) ? 'unsupported_redirect_mode'
    : /AbortSignal\.timeout.*(?:not a function|undefined)/i.test(message) ? 'timeout_api_unavailable'
    : ['AbortError', 'TimeoutError'].includes(name) ? 'timeout'
    : phase === 'response_json' ? 'invalid_json' : 'upstream_fetch_failed';
  console.warn(JSON.stringify({ event: 'soniox_token_failure', phase, name, reason }));
}

/** Each request reconstructs state from D1; the factory only injects a clock/fetch for tests. */
export function createWorker({ now = Date.now, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    async fetch(request, env, context = {}) {
      const headers = {};
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'https_required');
        let config;
        try { config = configuration(env); } catch { fail(503, 'relay_not_configured'); }
        const origin = request.headers.get('origin');
        if (origin) {
          if (!isOriginAllowed(origin, config.allowedOrigins)) fail(403, 'origin_not_allowed');
          headers['access-control-allow-origin'] = origin;
          headers.vary = 'Origin';
        }
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
          ...headers, 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
          'access-control-allow-headers': 'Authorization,Content-Type,OAI-Sites-Authorization', 'access-control-max-age': '600',
        } });
        const path = url.pathname;
        if (request.method === 'GET' && path === '/health') return response(200, { ok: true, service: 'muse-relay', version: 1 }, headers);
        const liveVoice = env.SONIOX_RELAY_LIVE === 'true' && Boolean(config.sonioxApiKey);
        if (request.method === 'GET' && path === '/v1/voice/live') {
          const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(value => value.trim());
          if (protocols?.length !== 2 || protocols[0] !== LIVE_VOICE_PROTOCOL || !equal(protocols[1], config.relayToken)) fail(401, 'unauthorized');
          if (!liveVoice || !env.DB) fail(503, 'live_voice_not_configured');
          if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'upgrade_required');
          await new D1StateStore(env.DB).reserveSonioxToken(now());
          return await openLiveVoice(fetchImpl, config.sonioxApiKey);
        }
        const device = path.startsWith('/device/');
        const spaces = spaceExportRoute(request.method, path);
        const muse = spaces || (path === '/v1/profile' && request.method === 'PUT') || (path === '/v1/messages' && request.method === 'POST') || (path === '/admin/gc' && request.method === 'POST');
        const token = device ? config.deviceToken : muse ? config.museToken : config.relayToken;
        if (!equal(request.headers.get('authorization'), `Bearer ${token}`)) fail(401, 'unauthorized');
        if (!env.DB || !env.BUCKET) fail(503, 'storage_not_configured');
        const store = new D1StateStore(env.DB);
        const blobs = new R2Attachments(env.DB, env.BUCKET, now);
        if (spaces?.kind === 'read') {
          const { state } = await store.load();
          return response(200, await exportSpaces(state.spaces, image => blobs.get(image)), headers);
        }
        const mutate = change => store.update(state => {
          const machine = createMachine(state, { now });
          machine.sweep();
          if (device) state.deviceSeen = now();
          const result = change(machine, state);
          machine.serialize();
          return result;
        });
        if (request.method === 'POST' && path === '/admin/gc') {
          await mutate(() => null);
          return response(200, await blobs.collect(store), headers);
        }
        if (request.method === 'POST' && path === '/v1/soniox-token') {
          if (!config.sonioxApiKey) fail(503, 'soniox_not_configured');
          const started = Date.now();
          await store.reserveSonioxToken(now());
          const admitted = Date.now();
          let upstream;
          try {
            upstream = await fetchImpl('https://api.soniox.com/v1/auth/temporary-api-key', {
              // Workers supports manual/follow only. Reject every redirect below, without forwarding credentials.
              method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${config.sonioxApiKey}`, 'content-type': 'application/json' },
              body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 150 }), signal: AbortSignal.timeout(10_000),
            });
          } catch (error) {
            reportSonioxFailure(error, 'fetch');
            fail(502, 'soniox_upstream_unavailable');
          }
          if (upstream.status >= 300 && upstream.status < 400) fail(502, 'soniox_redirect_blocked');
          if (!upstream.ok) fail(502, `soniox_upstream_${upstream.status}`);
          let data;
          try { data = await upstream.json(); }
          catch (error) { reportSonioxFailure(error, 'response_json'); fail(502, 'soniox_invalid_response'); }
          if (!data || typeof data.api_key !== 'string' || !data.api_key) fail(502, 'soniox_invalid_response');
          return response(200, { api_key: data.api_key, expires_at: data.expires_at }, {
            ...headers, 'Server-Timing': `relay-quota;dur=${admitted - started}, soniox-issuer;dur=${Date.now() - admitted}`,
          });
        }
        const body = ['POST', 'PUT'].includes(request.method) ? await readJson(request) : undefined;
        let status = 200, result, wroteMedia = false;
        if (request.method === 'POST' && path === '/v1/requests') {
          const validated = validateRequest(body, config.imagesEnabled);
          const hash = await fingerprint(validated);
          const value = prepareMuseRequest(validated);
          const requestBytes = byteLength(JSON.stringify(buildMuseRequest(value)));
          // Fresh keys cannot resurrect an object removed by a concurrent collector.
          // An idempotent retry can leave an unreferenced upload for bounded GC.
          for (const field of ['audio', 'image']) if (value[field]) { value[field] = await blobs.put(value[field]); wroteMedia = true; }
          result = await mutate(machine => machine.addRequest(structuredClone(value), hash, requestBytes)); status = 202;
        } else if (request.method === 'GET' && path === '/v1/snapshot') {
          result = publicSnapshot(await mutate(machine => machine.snapshot(config.imagesEnabled, Boolean(config.sonioxApiKey))));
          if (liveVoice) result.capabilities.live_transcription = true;
        }
        else if (request.method === 'GET' && path.startsWith('/v1/files/')) {
          let name;
          try { name = decodeURIComponent(path.slice('/v1/files/'.length)); } catch { fail(400, 'invalid_filename'); }
          const file = await mutate((_machine, state) => { if (!Object.hasOwn(state.files, name)) fail(404, 'file_not_found'); return state.files[name]; });
          result = await blobs.get(file);
        } else if (request.method === 'POST' && path === '/v1/messages') {
          const value = validatePublishedMessage(body);
          if (value.image) { value.image = await blobs.put(value.image); wroteMedia = true; }
          result = await mutate(machine => machine.publishMessage(structuredClone(value)));
        } else if (spaces) {
          const updated = validateSpaceWrite(spaces, body);
          if (updated.flatMap(space => space.items).filter(item => item.image).length > MAX_SPACE_IMAGES) fail(413, 'too_many_attachments');
          for (const space of updated) for (const item of space.items) if (item.image) {
            item.image = await blobs.put(item.image);
            item.image_file = `space_${space.id.length}_${space.id}_${item.id}`; wroteMedia = true;
          }
          result = await mutate(machine => spaces.kind === 'upsert'
            ? machine.upsertSpace(structuredClone(updated[0]), MAX_SPACE_IMAGES)
            : machine.setSpaces(structuredClone(updated)));
        } else if (request.method === 'PUT' && path === '/v1/profile') {
          const profile = validateProfile(body);
          if (profile.avatar) {
            profile.avatar_file = `profile_avatar_${await fingerprint(profile.avatar)}.base64`;
            profile.avatar = await blobs.put(profile.avatar); wroteMedia = true;
          }
          result = await mutate(machine => machine.setProfile(structuredClone(profile)));
        } else if (request.method === 'GET' && path === '/device/jobs') result = await mutate(machine => {
          const job = machine.leaseNext();
          return { job: job ? { id: job.request.id, kind: job.request.kind, created_at: job.request.created_at, session_id: job.request.session_id, request_bytes: job.requestBytes, lease_seconds: LEASE_MS / 1000 } : null };
        });
        else if (request.method === 'GET' && /^\/device\/jobs\/[A-Za-z0-9_-]+\/request$/.test(path)) {
          const value = await mutate(machine => machine.takeRequest(path.split('/')[3]));
          for (const field of ['audio', 'image']) if (value[field]) value[field] = await blobs.get(value[field]);
          result = buildMuseRequest(value);
        } else if (request.method === 'POST' && path === '/device/events') result = await mutate(machine => machine.handleDeviceEvent(body));
        else fail(404, 'not_found');
        if (wroteMedia && context.waitUntil) context.waitUntil(blobs.collect(store, 5).catch(() => {}));
        return response(status, result, headers);
      } catch (error) {
        return response(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'relay_error' }, headers);
      }
    },
  };
}

export default createWorker();
