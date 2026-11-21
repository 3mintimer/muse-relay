// Shared protocol and state transitions. No Node, network, or filesystem dependencies.
import { chatLocation } from '../protocol/chat-location.mjs';
import {parseSpaceControl,parseSpaceAction,matchesSpaceAction} from '../protocol/space-controls.mjs';
export const byteLength = text => new TextEncoder().encode(text).byteLength;
export const decodeBase64 = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
export function encodeBase64(bytes) { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); }
export function concatBytes(a, b) { const value = new Uint8Array(a.length + b.length); value.set(a); value.set(b, a.length); return value; }
export async function fingerprint(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), n => n.toString(16).padStart(2, '0')).join(''); }
export function emptyState() { return {version:1,messages:[],spaces:[],jobs:[],files:{},deviceSeen:0,streams:{},pending:{},sonioxCalls:[]}; }
export function validateState(state) {
  if (state.version !== 1 || !Array.isArray(state.messages) || !Array.isArray(state.spaces) || !Array.isArray(state.jobs) || !state.files) throw new Error('Unsupported relay state');
  state.streams ||= {}; state.pending ||= {}; state.sonioxCalls ||= [];
  state.museSessionId ||= crypto.randomUUID(); state.retiredMessageIds ||= [];
  state.museSessionAcknowledged ??= state.jobs.some(job => job.request.session_id === state.museSessionId && (job.acknowledged || job.museIds?.length));
  if (!/^[A-Za-z0-9-]{1,80}$/.test(state.museSessionId) || !Array.isArray(state.retiredMessageIds)) throw new Error('Invalid Muse session state');
  return state;
}

export const MAX_AUDIO = 1_100_000;
export const MAX_IMAGE = 250_000;
export const MAX_BODY = 2_000_000;
export const MAX_EVENT_LINE = 262_144;
export const MAX_SPACES = 20;
export const MAX_MESSAGES = 100;
export const MAX_JOBS = 200;
export const LEASE_MS = 180_000;
export const JOB_TTL_MS = 15 * 60_000;
export const SONIOX_TOKEN_LIMIT = 5;
export const SONIOX_TOKEN_WINDOW_MS = 60_000;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,200}$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const TERMINAL = new Set(['done', 'error']);

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
export const fail = (status, code) => { throw new HttpError(status, code); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const bounded = (value, max, fallback = '') => typeof value === 'string' ? value.slice(0, max) : fallback;
export const timestamp = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : Math.floor(Date.now() / 1000);
export const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let difference = 0; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i); return difference === 0; };

export function spaceExportRoute(method, path) {
  if (path === '/v1/spaces') return method === 'GET' ? { kind: 'read' } : method === 'PUT' ? { kind: 'replace' } : undefined;
  const id = method === 'PUT' && /^\/v1\/spaces\/([A-Za-z0-9_-]{1,100})$/.exec(path)?.[1];
  if (id) return { kind: 'upsert', id };
}

const LOOPBACK_PORT_ORIGIN = 'http://127.0.0.1:*';
function isCanonicalOrigin(origin) {
  try { return new URL(origin).origin === origin; } catch { return false; }
}
export function isOriginAllowed(origin, allowedOrigins) {
  if (typeof origin !== 'string') return false;
  return allowedOrigins.some(allowed => allowed === LOOPBACK_PORT_ORIGIN
    // Match the complete serialized Origin before URL parsing can normalize aliases.
    ? /^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?$/.test(origin) && isCanonicalOrigin(origin)
    : allowed === origin);
}

export function validateConfig(config) {
  for (const key of ['relayToken', 'deviceToken', 'museToken']) {
    if (!TOKEN_PATTERN.test(config[key] || '')) throw new Error(`${key} must be a random token of at least 32 characters; run server/setup.mjs.`);
  }
  if (new Set([config.relayToken, config.deviceToken, config.museToken]).size !== 3) throw new Error('Use a separate token for phone, ATOM, and Muse.');
  const allowedOrigins = config.allowedOrigins || [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => typeof origin !== 'string' || (origin !== 'null' && origin !== LOOPBACK_PORT_ORIGIN && (origin.includes('*') || !isCanonicalOrigin(origin))))) throw new Error('allowedOrigins must contain exact origins, null, or the explicit http://127.0.0.1:* opt-in.');
  if (config.publicUrl && new URL(config.publicUrl).protocol !== 'https:') throw new Error('publicUrl must use HTTPS.');
  return { ...config, allowedOrigins, imagesEnabled: config.imagesEnabled === true };
}

export function attachment(value, kind) {
  if (!object(value)) fail(400, `invalid_${kind}`);
  const mime = value.mime;
  const allowed = kind === 'audio' ? ['audio/wav', 'audio/x-wav'] : ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(mime)) fail(400, `unsupported_${kind}_format`);
  const data = value.data_base64;
  if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail(400, `invalid_${kind}_base64`);
  const bytes = decodeBase64(data);
  if (bytes.length === 0 || bytes.length > (kind === 'audio' ? MAX_AUDIO : MAX_IMAGE)) fail(413, `${kind}_too_large`);
  if (kind === 'audio' && (bytes.length < 44 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WAVE')) fail(400, 'audio_must_be_wav');
  return { mime, data_base64: data, name: bounded(value.name, 120, kind === 'audio' ? 'voice.wav' : 'image.png') };
}
export function validateRequest(value, imagesEnabled) {
  if (!object(value) || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id || '') || /^(muse_|status_)/.test(value.id)) fail(400, 'invalid_request_id');
  if (!['chat', 'space'].includes(value.kind)) fail(400, 'invalid_request_kind');
  if (typeof value.text !== 'string' || value.text.length > 10_000) fail(400, 'invalid_text');
  if (value.image && !imagesEnabled) fail(422, 'gadget_images_not_enabled');
  const request = { id: value.id, kind: value.kind, text: value.text.trim(), created_at: timestamp(value.created_at) };
  if (value.kind === 'space') {
    if (!ID_PATTERN.test(value.space_id || '')) fail(400, 'invalid_space_id');
    request.space_id = value.space_id;
  }
  if (value.space_action !== undefined) {
    if (value.kind !== 'space') fail(400, 'invalid_space_action');
    try { request.space_action = parseSpaceAction(value.space_action); } catch { fail(400, 'invalid_space_action'); }
  }
  const location = chatLocation(value);
  if (location) request.location = location;
  if (value.audio) request.audio = attachment(value.audio, 'audio');
  if (value.image) request.image = attachment(value.image, 'image');
  if (!request.text && !request.audio && !request.image && request.kind !== 'space') fail(400, 'empty_request');
  return request;
}
// Keep queued jobs on their original prompt: ATOM requires the leased byte count to match exactly.
// This server-owned flag is assigned after hashing the client request so retries across upgrades still match.
export function prepareMuseRequest(request) {
  return request.kind === 'space' ? { ...request, spaceExportUpsert: true } : request;
}
export function buildMuseRequest(request) {
  const body = { message: request.text, output_modality: 'text' };
  if (request.session_id) body.session_id = request.session_id;
  if (request.kind === 'space') {
    const publish = `Publish only this space with PUT /v1/spaces/${request.space_id} using the Muse writer token and a single space object (id, title, layout, updated_at, items), not a list. Read the current export using GET /v1/spaces with the same token if needed. Do not replace the full list.`;
    const actionPublish = request.spaceExportUpsert ? publish : 'Publish the resulting values/content to the spaces endpoint, preserving other spaces.';
    const refreshPublish = request.spaceExportUpsert ? `${publish} Give a short confirmation. Do not create a space or operate devices from this request.`
      : 'Publish the updated cards to the Muse Relay spaces endpoint using your configured secure credential, then give a short confirmation. Do not create a space or operate devices from this request.';
    body.message = request.space_action
      ? `Muse Relay space action: ${JSON.stringify({request_id:request.id,space_id:request.space_id,...request.space_action})}. The user selected this exported control. Handle it once using the owner's configured item mapping; use the attached voice or following transcript only as input to that item. ${actionPublish} Give a short result with reply_to ${JSON.stringify(request.id)}. ${request.text}`
      : `Muse Relay: refresh the read-only export for the configured space id ${JSON.stringify(request.space_id)}. Use the space mapping the owner configured. ${refreshPublish} ${request.text}`;
  }
  const files = [request.audio, request.image].filter(Boolean);
  if (request.location) {
    const data = new TextEncoder().encode(JSON.stringify(request.location));
    files.push({ mime: 'application/json', name: 'phone-location.json', data_base64: encodeBase64(data) });
  }
  if (files.length) {
    if (request.audio || request.image) body.device = 'mcu-wearable';
    // Muse reads items, rather than the top-level message, when attachments exist.
    const textItems = body.message.trim() ? [{ type: 'text', text: body.message }] : [];
    body.items = [...textItems, ...files.map(file => ({ type: 'file', mime_type: file.mime, filename: file.name, data_base64: file.data_base64 }))];
  }
  return body;
}
export function validatePublishedMessage(value) {
  if (!object(value) || !/^muse_export_[A-Za-z0-9_-]{1,80}$/.test(value.id || '')) fail(400, 'invalid_published_message_id');
  const text = value.type === 'image' && value.text === undefined ? '' : value.text;
  if (!['text', 'image'].includes(value.type) || typeof text !== 'string' || text.length > 20_000) fail(400, 'invalid_published_message');
  if (value.type === 'image' && !value.image) fail(400, 'image_required');
  const message = { id: value.id, from: 'Muse', type: value.type, text, ts: timestamp(value.ts) };
  if (value.reply_to !== undefined) {
    if (typeof value.reply_to !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.reply_to)) fail(400, 'invalid_reply_id');
    message.reply_to = value.reply_to;
  }
  if (value.image) {
    message.image = attachment(value.image, 'image');
    message.image_file = `output_${value.id}.base64`;
    message.mime_type = message.image.mime;
  }
  return message;
}
/** Writer input is a full replacement. File references are generated by the adapter. */
export function validateProfile(value) {
  if (!object(value)) fail(400, 'invalid_profile');
  if (value.avatar_file !== undefined) fail(400, 'profile_avatar_must_be_inline');
  const profile = {};
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || value.name.length > 120) fail(400, 'invalid_profile_name');
    if (value.name.trim()) profile.name = value.name.trim();
  }
  if (value.updated_at !== undefined) {
    if (!Number.isSafeInteger(value.updated_at) || value.updated_at <= 0) fail(400, 'invalid_profile_timestamp');
    profile.updated_at = value.updated_at;
  }
  if (value.avatar !== undefined) {
    profile.avatar = attachment(value.avatar, 'image');
    profile.mime_type = profile.avatar.mime;
  }
  if (value.mime_type !== undefined && value.mime_type !== profile.mime_type) fail(400, 'invalid_profile_mime');
  return profile;
}
export function validateSpaces(value) {
  if (!object(value) || !Array.isArray(value.spaces) || value.spaces.length > MAX_SPACES) fail(400, 'invalid_spaces');
  const seen = new Set();
  return value.spaces.map(space => {
    if (!object(space) || !ID_PATTERN.test(space.id || '') || seen.has(space.id) || typeof space.title !== 'string' || space.title.length > 120 || !Array.isArray(space.items) || space.items.length > 50) fail(400, 'invalid_space');
    seen.add(space.id);
    if (space.layout !== undefined && !['list','cards'].includes(space.layout)) fail(400,'invalid_space_layout');
    const itemIds = new Set();
    return {
      id: space.id, title: space.title, layout: space.layout || 'list', updated_at: timestamp(space.updated_at),
      items: space.items.map(item => {
        if (!object(item) || !ID_PATTERN.test(item.id || '') || itemIds.has(item.id) || typeof item.title !== 'string' || item.title.length > 200 || typeof item.text !== 'string' || item.text.length > 10_000) fail(400, 'invalid_space_item');
        itemIds.add(item.id);
        const result = { id: item.id, title: item.title, text: item.text };
        if (item.control !== undefined) { try { result.control = parseSpaceControl(item.control); } catch { fail(400,'invalid_space_control'); } }
        if (item.ts) result.ts = timestamp(item.ts);
        if (item.image) result.image = attachment(item.image, 'image');
        return result;
      }),
    };
  });
}

export function validateSpaceWrite(route, body) {
  if (route.kind === 'replace') return validateSpaces(body);
  if (!object(body) || body.id !== route.id) fail(400, 'space_id_mismatch');
  return validateSpaces({ spaces: [body] });
}

export async function exportSpaces(spaces, loadImage = image => image) {
  const result = [];
  for (const { items, ...space } of spaces) {
    const exported = [];
    for (const { image, image_file: _file, ...item } of items) {
      exported.push(image ? { ...item, image: await loadImage(image) } : item);
    }
    result.push({ ...space, items: exported });
  }
  return { spaces: result };
}

export function createMachine(state, {now = Date.now} = {}) {
  validateState(state);
  const streamBuffers = new Map(Object.entries(state.streams).map(([id,value])=>[id,decodeBase64(value)]));
  const beforeAck = new Map(Object.entries(state.pending));
  function note(text, job, from = 'Relay') {
    const id = `status_${job.request.id}`;
    const message = { id, from, type: 'text', text, ts: Math.floor(now() / 1000), reply_to: job.request.id };
    const previous = state.messages.findIndex(item => item.id === id);
    if (previous >= 0) state.messages[previous] = message; else state.messages.push(message);
    trimMessages();
  }
  function trimMessages() {
    state.messages = state.messages.slice(-MAX_MESSAGES);
    const used = new Set([...state.messages.flatMap(m => [m.audio_file, m.image_file]), ...state.spaces.flatMap(space => space.items.map(item => item.image_file)), state.profile?.avatar_file].filter(Boolean));
    for (const name of Object.keys(state.files)) if (!used.has(name)) delete state.files[name];
  }
  function terminal(job, status, error) {
    state.retiredMessageIds = [...new Set([...state.retiredMessageIds, ...(job.museIds || []), ...(job.responseIds || []), ...(job.rejectedIds || []), job.responseId].filter(Boolean))].slice(-1024);
    job.status = status;
    job.completedAt = now();
    job.error = error || undefined;
    delete job.request.location;
    delete job.request.audio;
    delete job.request.image;
    job.request.text = '';
    job.responseText = '';
    job.museIds = [];
    job.rejectedIds = [];
    job.eventIds = [];
    job.responseId = null;
    job.responseIds = [];
    job.afterOwnUser = false;
    streamBuffers.delete(job.request.id);
    beforeAck.delete(job.request.id);
    if (error) note(error, job);
  }
  function sweep() {
    for (const job of state.jobs) {
      if (TERMINAL.has(job.status)) continue;
      if (!job.request.session_id) {
        if (job.deliveredAt || job.status === 'leased') { terminal(job, 'error', 'The relay now uses a dedicated Muse chat. Check the earlier request before sending again.'); continue; }
        job.requestBytes = scopeRequest(job.request, job.requestBytes);
      }
      if (now() - job.queuedAt > JOB_TTL_MS) terminal(job, 'error', 'Request expired. Send again if still needed.');
      else if (job.status === 'leased' && job.leaseUntil <= now()) {
        if (job.deliveredAt) terminal(job, 'error', 'ATOM connection timed out after delivery. Muse may have received this request; check before sending again.');
        else { job.status = 'queued'; job.leaseUntil = 0; }
      }
    }
    if (state.jobs.length > MAX_JOBS) state.jobs = [...state.jobs.filter(job => TERMINAL.has(job.status)).slice(-(MAX_JOBS - state.jobs.filter(job => !TERMINAL.has(job.status)).length)), ...state.jobs.filter(job => !TERMINAL.has(job.status))];
  }
  function scopeRequest(request, requestBytes) {
    const before = byteLength(JSON.stringify(buildMuseRequest(request)));
    request.session_id = state.museSessionId;
    // Worker requestBytes includes the R2 payload; only the session-field overhead changes.
    return (requestBytes ?? before) + byteLength(JSON.stringify(buildMuseRequest(request))) - before;
  }
  function addRequest(request, fingerprint, requestBytes) {
    const existing = state.jobs.find(job => job.request.id === request.id);
    if (existing) {
      if (existing.fingerprint && existing.fingerprint !== fingerprint) fail(409, 'request_id_conflict');
      return { accepted: true, duplicate: true, status: existing.status, id: request.id };
    }
    if (request.space_action) {
      const control = state.spaces.find(space=>space.id===request.space_id)?.items.find(item=>item.id===request.space_action.item_id)?.control;
      if (!matchesSpaceAction(control,request.space_action)) fail(409,'space_control_changed');
    }
    if (state.jobs.filter(job => !TERMINAL.has(job.status)).length >= 20) fail(429, 'queue_full');
    requestBytes = scopeRequest(request, requestBytes);
    const job = { request, fingerprint, requestBytes, queuedAt: now(), status: 'queued', leaseUntil: 0, eventIds: [], museIds: [], responseId: null, responseIds: [], responseText: '', afterOwnUser: false, acknowledged: false };
    state.jobs.push(job);
    const message = { id: request.id, from: 'You', type: request.audio ? 'voice-note' : request.image ? 'image' : 'text', text: request.text || (request.kind === 'space' ? `Space: ${request.space_id}` : ''), ts: request.created_at };
    if (request.audio) { message.audio_file = `audio_${request.id}.wav`; message.mime_type = request.audio.mime; state.files[message.audio_file] = request.audio; }
    if (request.image) { message.image_file = `image_${request.id}`; message.image = request.image; state.files[message.image_file] = request.image; }
    state.messages.push(message);
    trimMessages();
    return { accepted: true, duplicate: false, status: 'queued', id: request.id };
  }
  function updateAssistant(job, text, append) {
    if (append) job.responseText += text; else if (text) job.responseText = text;
    job.responseText = job.responseText.slice(0, 30_000);
    if (!job.responseText) return;
    const id = `muse_${job.request.id}`;
    const message = { id, from: 'Muse', type: 'text', text: job.responseText, ts: Math.floor(now() / 1000), reply_to: job.request.id };
    const index = state.messages.findIndex(m => m.id === id);
    if (index < 0) state.messages.push(message); else state.messages[index] = message;
    trimMessages();
  }
  function handleMuseEvent(job, event) {
    if (!object(event) || event.type !== 'event' || !object(event.payload)) return;
    const eventName = event.event_name || event.event;
    if (!['message.user', 'message.assistant', 'delta.message_start', 'delta.text_append', 'delta.message_done'].includes(eventName)) return;
    const payload = event.payload;
    // The outer device event proves subscription scope when Muse omits it here.
    if ([payload.session_id, event.session_id].some(session => session !== undefined && session !== job.request.session_id)) return;
    if (!job.museIds.length) {
      const queue = beforeAck.get(job.request.id) || [];
      if (queue.length < 64 && byteLength(JSON.stringify(queue)) + byteLength(JSON.stringify(event)) <= MAX_EVENT_LINE) queue.push(event);
      beforeAck.set(job.request.id, queue);
      return;
    }
    const messageId = payload.message_id || event.message_id || payload.id;
    const replyId = payload.reply_to_message_id || payload.parent_message_id;
    if (typeof messageId !== 'string' || !messageId || messageId.length > 200) return;
    const user = eventName === 'message.user';
    if (!user && payload.role === 'user') return;
    job.responseIds ||= job.responseId ? [job.responseId] : [];
    const knownReply = job.responseIds.includes(messageId);
    const matches = user ? job.museIds.includes(messageId) : typeof replyId === 'string' && (job.museIds.includes(replyId) || job.responseIds.includes(replyId));
    job.rejectedIds ||= [];
    const reject = () => {
      if (!job.rejectedIds.includes(messageId)) job.rejectedIds.push(messageId);
      job.rejectedIds = job.rejectedIds.slice(-100);
    };
    if (!user) {
      // A scoped self-parent is used by Muse message rows, but still needs the own-user boundary.
      if (replyId && !matches && replyId !== messageId) { reject(); return; }
      if (state.retiredMessageIds.includes(messageId) || job.rejectedIds.includes(messageId)) return;
      if (!matches && !knownReply && !job.afterOwnUser) { reject(); return; }
    }
    // Persisted message rows and live delta events have independent sequence numbers.
    // Ignore the old shared lastSeq field when reading pre-upgrade state.
    const sequenceKey = user || eventName === 'message.assistant' ? 'lastMessageSeq' : 'lastDeltaSeq';
    if (Number.isSafeInteger(event.seq) && event.seq > 0) {
      if (event.seq <= (job[sequenceKey] || 0)) return;
      job[sequenceKey] = event.seq;
    }
    if (user) {
      job.afterOwnUser = matches;
      if (!matches) return;
      const text = bounded(payload.display_text || payload.text || payload.content, 10_000);
      if (text && job.request.audio) {
        const source = state.messages.find(m => m.id === job.request.id);
        if (source) source.text = text;
      }
      return;
    }
    if (!knownReply) {
      if (job.responseIds.length >= 32) { terminal(job, 'error', 'Muse returned too many reply messages.'); return; }
      job.responseIds.push(messageId);
    }
    job.responseId = messageId;
    if (eventName === 'delta.text_append') updateAssistant(job, bounded(payload.display_text || payload.content || payload.text, 30_000), true);
    if (eventName === 'message.assistant') {
      if (payload.display_text_ready !== false) {
        updateAssistant(job, bounded(payload.display_text || payload.content || payload.text, 30_000), false);
        if (job.responseText) terminal(job, 'done');
      }
    }
    if (eventName === 'delta.message_done') {
      updateAssistant(job, bounded(payload.display_text || payload.content || payload.text, 30_000), false);
      if (!job.responseText) note('Muse completed without display text.', job);
      terminal(job, 'done');
    }
  }
  function handleLine(job, line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { fail(400, 'invalid_muse_event_json'); }
    handleMuseEvent(job, event);
  }
  function handleDeviceEvent(value) {
    if (!object(value) || !ID_PATTERN.test(value.job_id || '') || !ID_PATTERN.test(value.event_id || '')) fail(400, 'invalid_device_event');
    const job = state.jobs.find(job => job.request.id === value.job_id);
    if (!job) fail(404, 'job_not_found');
    if (!job.request.session_id || value.session_id !== job.request.session_id) fail(409, 'job_session_mismatch');
    if (job.eventIds.includes(value.event_id) || TERMINAL.has(job.status)) return { ok: true, terminal: TERMINAL.has(job.status) };
    if (job.status !== 'leased') fail(409, 'job_not_leased');
    if (!['heartbeat', 'muse_ack', 'muse_event', 'muse_chunk', 'error'].includes(value.type)) fail(400, 'invalid_event_type');
    job.leaseUntil = now() + LEASE_MS;
    if (value.type === 'error') terminal(job, 'error', `ATOM: ${bounded(value.error, 500, 'Request failed.')}`);
    if (value.type === 'muse_ack') {
      if (value.subscription_fresh !== undefined && typeof value.subscription_fresh !== 'boolean') fail(400, 'invalid_subscription_fresh');
      let ack = value.body;
      if (typeof ack === 'string') { try { ack = JSON.parse(ack); } catch { fail(400, 'invalid_muse_ack'); } }
      if (!object(ack)) fail(400, 'invalid_muse_ack');
      const result = object(ack.result) ? ack.result : ack;
      if (ack.error || result.error) { terminal(job, 'error', 'Muse rejected the request.'); }
      else if (result.session_id !== job.request.session_id || result.is_thread !== true) {
        terminal(job, 'error', 'Muse did not acknowledge the dedicated relay chat.');
      }
      else {
        const ids = [result.message_id, result.reply_to_message_id].filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200);
        if (!ids.length) terminal(job, 'error', 'Muse did not return a message identifier; delivery cannot be correlated.');
        else {
          // Device attestation of a real subscription 404. Never infer freshness from time.
          const fresh = value.subscription_fresh === true;
          if (fresh && state.museSessionAcknowledged && !job.freshSession) fail(409, 'fresh_session_not_available');
          if (!job.acknowledged) {
            job.afterOwnUser = fresh;
            job.freshSession = fresh;
            job.acknowledged = true;
          }
          job.museIds = ids;
          state.museSessionAcknowledged = true;
          const queue = beforeAck.get(job.request.id) || [];
          beforeAck.delete(job.request.id);
          for (const event of queue) { if (!TERMINAL.has(job.status)) handleMuseEvent(job, event); }
        }
      }
    }
    if (value.type === 'muse_event') {
      if (typeof value.body === 'string') {
        if (byteLength(value.body) > MAX_EVENT_LINE) fail(413, 'muse_event_too_large');
        for (const line of value.body.split('\n')) { if (!TERMINAL.has(job.status)) handleLine(job, line); }
      } else if (object(value.body)) handleMuseEvent(job, value.body);
      else fail(400, 'invalid_muse_event');
    }
    if (value.type === 'muse_chunk') {
      if (typeof value.body_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.body_base64)) fail(400, 'invalid_muse_chunk');
      const bytes = decodeBase64(value.body_base64);
      if (bytes.length > 8192) fail(413, 'muse_chunk_too_large');
      let buffer = concatBytes(streamBuffers.get(job.request.id) || new Uint8Array(0), bytes);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > MAX_EVENT_LINE) fail(413, 'muse_event_too_large');
        if (!TERMINAL.has(job.status)) handleLine(job, new TextDecoder().decode(line));
      }
      if (buffer.length > MAX_EVENT_LINE) fail(413, 'muse_event_too_large');
      if (!TERMINAL.has(job.status)) streamBuffers.set(job.request.id, buffer);
    }
    job.eventIds.push(value.event_id);
    job.eventIds = job.eventIds.slice(-4096);
    return { ok: true, terminal: TERMINAL.has(job.status) };
  }

  function leaseNext() {
    const active = state.jobs.find(job => job.status === 'leased');
    const job = active ? null : state.jobs.find(job => job.status === 'queued');
    if (job) { job.status = 'leased'; job.leaseUntil = now() + LEASE_MS; }
    return job;
  }
  function takeRequest(id) {
    const job = state.jobs.find(job => job.request.id === id);
    if (!job) fail(404, 'job_not_found');
    if (job.status !== 'leased') fail(409, 'job_not_leased');
    job.deliveredAt ||= now(); job.leaseUntil = now() + LEASE_MS;
    return job.request;
  }
  function publishMessage(message) {
    const index = state.messages.findIndex(item => item.id === message.id);
    if (index >= 0) state.messages[index] = message; else state.messages.push(message);
    if (message.image) state.files[message.image_file] = message.image;
    trimMessages(); return {ok:true,id:message.id,updated:index >= 0};
  }
  function setSpaces(spaces) { state.spaces = spaces; for (const space of spaces) for (const item of space.items) if (item.image_file && item.image) state.files[item.image_file] = item.image; trimMessages(); return {ok:true,count:spaces.length}; }
  function upsertSpace(space, imageLimit = Infinity) {
    const index = state.spaces.findIndex(s => s.id === space.id);
    const spaces = state.spaces.slice();
    if (index === -1) {
      if (spaces.length >= MAX_SPACES) fail(409, 'space_limit_reached');
      spaces.push(space);
    } else spaces[index] = space;
    if (spaces.reduce((count, entry) => count + entry.items.filter(item => item.image).length, 0) > imageLimit) fail(413, 'too_many_attachments');
    return setSpaces(spaces);
  }
  function setProfile(profile) { state.profile = profile; if (profile.avatar_file && profile.avatar) state.files[profile.avatar_file] = profile.avatar; trimMessages(); return {ok:true}; }
  function snapshot(imagesEnabled, sonioxConfigured = false) { return {messages:state.messages,spaces:state.spaces,...(state.profile === undefined ? {} : {profile:state.profile}),device:{connected:Boolean(state.deviceSeen) && now()-state.deviceSeen<45000,last_seen:state.deviceSeen?Math.floor(state.deviceSeen/1000):undefined},capabilities:{audio:true,images:imagesEnabled,spaces:true,soniox:Boolean(sonioxConfigured)}}; }
  function useSoniox() {
    const time = now();
    state.sonioxCalls = state.sonioxCalls.filter(call => call > time - SONIOX_TOKEN_WINDOW_MS);
    if (state.sonioxCalls.length >= SONIOX_TOKEN_LIMIT) fail(429, 'soniox_token_rate_limit');
    state.sonioxCalls.push(time);
  }
  function serialize() { state.streams = Object.fromEntries([...streamBuffers].map(([id,bytes])=>[id,encodeBase64(bytes)])); state.pending=Object.fromEntries(beforeAck); return state; }
  return {state,sweep,addRequest,handleDeviceEvent,leaseNext,takeRequest,publishMessage,setSpaces,upsertSpace,setProfile,snapshot,useSoniox,serialize};
}
