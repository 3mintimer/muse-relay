import {parseSpaceControl,parseSpaceAction,matchesSpaceAction} from '../../protocol/space-controls.mjs';
import { validateProfile } from '../../server/core.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUEST_PREFIX = 'muse-relay-request-';
const ROOT = 'g2muse-relay.json';
const SPACES = 'muse-relay-spaces.json';
const PROFILE = 'muse-relay-profile.json';
const MAX_FILE = 6_000_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const replyId = id => `muse_${id.length <= 123 ? id : createHash('sha256').update(id).digest('hex')}`;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
class InspectionError extends Error {}
function responseError(response, operation) {
  const error = new Error(`GitHub ${operation} failed (HTTP ${response.status}).`);
  if ([403, 429].includes(response.status)) error.retryAfterMs = Math.max(60_000, Number(response.headers.get('retry-after') || 0) * 1000, response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset') || 0) * 1000 - Date.now() : 0);
  return error;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeJson = text => { try { return JSON.parse(text); } catch { throw new Error('Invalid JSON in relay data.'); } };

async function limitedText(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Relay data exceeds the configured limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

/** One writer owns g2muse-relay.json. The phone owns only immutable request filenames. */
export class GistStore {
  constructor({ gistId, token, fetchImpl = fetch }) {
    if (!/^[a-fA-F0-9]{20,64}$/.test(gistId || '') || !token) throw new Error('Set GIST_ID and GITHUB_TOKEN.');
    this.url = `https://api.github.com/gists/${gistId}`;
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    this.fetch = fetchImpl;
    this.etag = '';
    this.files = {};
  }
  async read(force = false) {
    const response = await this.fetch(this.url, { headers: { ...this.headers, ...(!force && this.etag ? { 'If-None-Match': this.etag } : {}) }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (response.status === 304) return false;
    if (!response.ok) throw responseError(response, 'read');
    this.minimumPollSeconds = Number(response.headers.get('x-poll-interval')) || 0;
    const gist = safeJson(await limitedText(response, 15_000_000));
    if (gist.truncated) throw new Error('Gist file list is truncated. Remove processed files before continuing.');
    if (!object(gist.files)) throw new Error('Gist files are missing.');
    this.files = gist.files;
    this.etag = response.headers.get('etag') || '';
    return true;
  }
  async file(name) {
    const file = this.files[name];
    if (!file) throw new Error('Referenced relay file is missing.');
    if (!file.truncated && typeof file.content === 'string') {
      if (Buffer.byteLength(file.content) > MAX_FILE) throw new Error('Relay file too large.');
      return file.content;
    }
    let url;
    try { url = new URL(file.raw_url); } catch { throw new Error('Invalid raw Gist URL.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com' || url.username || url.password) throw new Error('Raw Gist host is not permitted.');
    // Never pass the GitHub credential to raw hosts or follow redirects.
    const response = await this.fetch(url.href, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Raw Gist read failed (HTTP ${response.status}).`);
    return limitedText(response, MAX_FILE);
  }
  async patch(files) {
    const response = await this.fetch(this.url, { method: 'PATCH', headers: { ...this.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ files }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw responseError(response, 'update');
    await response.body?.cancel();
    this.etag = '';
  }
}
function validateRequest(raw, name) {
  if (!object(raw) || raw.protocol !== 'muse-relay/1' || !ID.test(raw.id || '') || name !== `${REQUEST_PREFIX}${raw.id}.json`) throw new Error('Invalid request envelope.');
  if (!['chat', 'space'].includes(raw.kind) || typeof raw.text !== 'string' || raw.text.length > 20_000 || !Number.isFinite(raw.created_at)) throw new Error('Invalid request content.');
  if (raw.kind === 'space' && !ID.test(raw.space_id || '')) throw new Error('Invalid space identifier.');
  if (raw.space_action !== undefined) {
    if (raw.kind !== 'space') throw new Error('Invalid space action.');
    raw.space_action = parseSpaceAction(raw.space_action);
  }
  for (const kind of ['audio', 'image']) if (raw[`${kind}_file`] && raw[`${kind}_file`] !== `muse-relay-${kind}-${raw.id}.base64`) throw new Error('Attachment must belong to the same request.');
  return raw;
}
function validateResult(result) {
  if (!object(result) || typeof result.text !== 'string' || result.text.length > 20_000) throw new Error('Handler must return JSON with a text string (at most 20000 characters).');
  if (result.transcript !== undefined && (typeof result.transcript !== 'string' || result.transcript.length > 20_000)) throw new Error('Invalid transcript from handler.');
  if (result.spaces !== undefined) {
    if (!Array.isArray(result.spaces) || result.spaces.length > 20) throw new Error('Invalid spaces from handler.');
    for (const space of result.spaces) {
      if (!object(space) || !ID.test(space.id || '') || typeof space.title !== 'string' || space.title.length > 100 || !Array.isArray(space.items) || space.items.length > 50) throw new Error('Invalid space from handler.');
      for (const item of space.items) if (!object(item) || !ID.test(item.id || '') || typeof item.title !== 'string' || item.title.length > 100 || typeof item.text !== 'string' || item.text.length > 20_000) throw new Error('Invalid space item from handler.');
      if (space.layout !== undefined && !['list','cards'].includes(space.layout)) throw new Error('Invalid space layout.');
      for (const item of space.items) if (item.control !== undefined) parseSpaceControl(item.control);
    }
  }
  if (result.image !== undefined) {
    const image = result.image;
    if (!object(image) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime) || typeof image.data_base64 !== 'string' || image.data_base64.length > 5_500_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data_base64)) throw new Error('Invalid output image.');
  }
  if (!result.text && !result.image && result.spaces === undefined && result.profile === undefined) throw new Error('Handler returned no display result.');
  // Emit only protocol fields, never incidental handler metadata.
  const clean = { text: result.text };
  if (result.profile !== undefined) clean.profile = validateProfile(result.profile);
  if (result.transcript !== undefined) clean.transcript = result.transcript;
  if (result.image) clean.image = { mime: result.image.mime, data_base64: result.image.data_base64, name: typeof result.image.name === 'string' ? result.image.name.slice(0, 128) : 'reply.png' };
  if (result.spaces !== undefined) clean.spaces = result.spaces.map(space => ({
    id: space.id, title: space.title, layout:space.layout || 'list', ...(Number.isFinite(space.updated_at) ? { updated_at: space.updated_at } : {}),
    items: space.items.map(item => ({ id: item.id, title: item.title, text: item.text, ...(item.control ? {control:parseSpaceControl(item.control)} : {}), ...(Number.isFinite(item.ts) ? { ts: item.ts } : {}) })),
  }));
  return clean;
}

export function executableHandler(executable, args = []) {
  if (!isAbsolute(executable || '') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('MUSE_HANDLER must be an absolute executable path; MUSE_HANDLER_ARGS must be a JSON string array.');
  return payload => new Promise((resolveResult, reject) => {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GIST_TOKEN;
    const child = spawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    child.stdout.setEncoding('utf8');
    let output = '';
    let settled = false;
    let forceKill;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000); forceKill.unref();
      finish(new Error('Handler timed out. Its action may have completed; inspect before retrying.'));
    }, 10 * 60_000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolveResult(value);
    }
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > MAX_FILE) { child.kill('SIGTERM'); finish(new Error('Handler output too large.')); }
    });
    // Handler stderr may contain private data: consume, do not relay or log it.
    child.stderr.resume();
    child.on('error', () => finish(new Error('Handler could not be started.')));
    child.on('close', code => {
      clearTimeout(forceKill);
      if (code !== 0) return finish(new Error('Handler failed. Inspect its own local status before retrying.'));
      try { finish(null, validateResult(safeJson(output))); } catch (error) { finish(error); }
    });
    child.stdin.on('error', () => finish(new Error('Handler input could not be delivered.')));
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function createWatcher({ store, stateFile, handler, now = Date.now }) {
  let state = { version: 1, requests: {} };
  try { state = safeJson(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.version !== 1 || !object(state.requests)) throw new Error('Unsupported watcher state.');
  state.writerId ||= randomUUID();
  if (typeof state.writerId !== 'string' || !ID.test(state.writerId)) throw new Error('Unsupported watcher state.');
  for (const name of ['requests', 'rows', 'files', 'completed']) {
    if (state[name] !== undefined && !object(state[name])) throw new Error('Unsupported watcher state.');
    state[name] = Object.assign(Object.create(null), state[name]);
  }
  async function save() {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
  }
  async function inbound() {
    const value = store.files[ROOT] ? safeJson(await store.file(ROOT)) : { messages: [] };
    if (!object(value) || !Array.isArray(value.messages)) throw new Error('Inbound messages must be an array.');
    return value;
  }
  const ownedRow = message => {
    const owner = object(message) && message.muse_relay_owner;
    return object(owner) && owner.writer === state.writerId && ID.test(owner.request_id || '')
      && ((message.id === owner.request_id && message.from === 'You')
        || (message.id === replyId(owner.request_id) && message.from === 'Muse' && message.reply_to === owner.request_id))
      && state.rows[message.id] === hash(message);
  };
  async function hydrate(raw, inputs) {
    const request = { id: raw.id, kind: raw.kind, text: raw.text, created_at: raw.created_at, ...(raw.space_id ? { space_id: raw.space_id } : {}) };
    if (raw.space_action) {
      const spaces = store.files[SPACES] ? safeJson(await store.file(SPACES)).spaces : [];
      const control = spaces?.find(space=>space.id===raw.space_id)?.items?.find(item=>item.id===raw.space_action.item_id)?.control;
      if (!matchesSpaceAction(control,raw.space_action)) throw new InspectionError('Space control changed; refresh before trying again.');
      request.space_action = raw.space_action;
    }
    for (const kind of ['audio', 'image']) {
      const name = raw[`${kind}_file`];
      if (!name) continue;
      if (!store.files[name]) throw new InspectionError('Request attachment is missing; inspect before handling.');
      const mime = raw[`${kind}_mime`];
      const allowed = kind === 'audio' ? ['audio/wav', 'audio/ogg'] : ['image/png', 'image/jpeg', 'image/webp'];
      const original = await store.file(name), data = original.replace(/[\r\n]/g, '');
      if (!allowed.includes(mime) || data.length > 5_500_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new InspectionError('Invalid request attachment.');
      inputs[name] = hash(original);
      request[kind] = { mime, data_base64: data, name: typeof raw[`${kind}_name`] === 'string' ? raw[`${kind}_name`].slice(0, 128) : name };
    }
    return request;
  }
  async function verifiedInputs(raw, record, requireAttachments = false) {
    const names = [`${REQUEST_PREFIX}${raw.id}.json`, ...['audio', 'image'].map(kind => raw[`${kind}_file`]).filter(Boolean)];
    for (const name of names) {
      if (!record.inputs?.[name]) return false;
      if (!store.files[name]) { if (requireAttachments || name === names[0]) return false; continue; }
      const content = await store.file(name);
      if (hash(content) !== record.inputs[name]) return false;
      if (name === names[0] && hash(validateRequest(safeJson(content), name)) !== record.digest) return false;
    }
    return true;
  }
  async function published(id, record, root) {
    const matches = root.messages.filter(message => object(message) && message.id === replyId(id));
    if (matches.length !== 1 || !record.receipt || hash(matches[0]) !== record.receipt.reply
      || !ownedRow(matches[0]) || matches[0].reply_to !== id || matches[0].muse_relay_owner.digest !== record.digest) return false;
    for (const [name, digest] of Object.entries(record.receipt.outputs)) {
      if (!store.files[name] || hash(await store.file(name)) !== digest) return false;
    }
    return true;
  }
  async function output(files, name, content) {
    const digest = hash(content);
    if (store.files[name]) {
      if (hash(await store.file(name)) !== digest) throw new InspectionError('Output filename collision; inspect the existing file before continuing.');
      // Identical unowned content can be referenced, but never adopted for deletion.
    } else { files[name] = { content }; state.files[name] = digest; }
    return digest;
  }
  async function cleanup(files, inputs = {}) {
    const candidates = new Set(), contents = new Map();
    let externalReads = 0, bytes = 0;
    const content = async name => {
      if (!contents.has(name)) {
        if (!files[name] && (store.files[name]?.truncated || typeof store.files[name]?.content !== 'string') && ++externalReads > 4) throw new Error('Cleanup read budget');
        const text = files[name]?.content ?? await store.file(name);
        bytes += Buffer.byteLength(text);
        if (bytes > 12_000_000) throw new Error('Cleanup byte budget');
        contents.set(name, text);
      }
      return contents.get(name);
    };
    try {
      for (const [name, digest] of Object.entries({ ...state.files, ...inputs })) {
        if (store.files[name] && !Object.hasOwn(files, name) && hash(await content(name)) === digest) candidates.add(name);
      }
      if (!candidates.size) return;
      // Search all retained Gist documents, including other histories and Spaces.
      // If a retained request references an input, retain that input as well.
      const names = new Set([...Object.keys(store.files), ...Object.keys(files)]);
      let changed;
      do {
        changed = false;
        for (const name of names) if (files[name] !== null && !candidates.has(name)) {
          const text = await content(name);
          for (const candidate of candidates) if (text.includes(candidate)) { candidates.delete(candidate); changed = true; }
        }
      } while (changed);
    } catch {
      return; // An unreadable shared document is not evidence that its references are absent.
    }
    for (const name of candidates) files[name] = null;
  }
  async function patch(files) {
    if (!Object.keys(files).length) return;
    await store.patch(files);
    for (const [name, value] of Object.entries(files)) if (value === null) delete state.files[name];
  }
  async function cleanupCompleted(raw, record) {
    await store.read(true);
    if (!await published(raw.id, record, await inbound()) || !await verifiedInputs(raw, record)) return false;
    const files = {};
    await cleanup(files, record.inputs);
    await patch(files);
    return files[`${REQUEST_PREFIX}${raw.id}.json`] === null;
  }
  async function publish(raw, record) {
    const result = record.result;
    // Refresh before updating the single inbound file. Other writers to ROOT are unsupported.
    await store.read(true);
    const root = await inbound();
    if (!await verifiedInputs(raw, record, true)) throw new InspectionError('Request files changed or ownership is unknown; inspect before publishing.');
    const time = Math.floor(now() / 1000);
    const ownId = replyId(raw.id);
    if ([raw.id, ownId].some(id => root.messages.filter(message => object(message) && message.id === id).length > 1)) {
      throw new InspectionError('Message ownership collision; existing history was preserved.');
    }
    for (const message of root.messages) if (object(message) && ([raw.id, ownId].includes(message.id)
      || (['You', 'Muse'].includes(message.from) && message.reply_to === raw.id))
      && (!ownedRow(message) || message.muse_relay_owner.request_id !== raw.id || message.muse_relay_owner.digest !== record.digest)) {
      throw new InspectionError('Message ownership collision; existing history was preserved.');
    }
    const owner = { writer: state.writerId, request_id: raw.id, digest: record.digest };
    const input = { id: raw.id, from: 'You', type: raw.audio_file ? 'voice-note' : raw.image_file ? 'image' : 'text', text: result.transcript ?? raw.text, ts: raw.created_at, muse_relay_owner: owner };
    const message = { id: ownId, from: 'Muse', type: result.image ? 'image' : 'text', text: result.text, ts: time, reply_to: raw.id, muse_relay_owner: owner };
    const keep = root.messages.filter(message => !object(message) || ![ownId, raw.id].includes(message.id));
    const files = {};
    const outputs = {};
    if (result.image) {
      message.image_file = `muse-relay-output-${raw.id}.base64`;
      message.mime_type = result.image.mime;
      outputs[message.image_file] = await output(files, message.image_file, result.image.data_base64);
    }
    keep.push(input, message);
    state.rows[input.id] = hash(input); state.rows[message.id] = hash(message);
    const counts = new Map();
    for (const message of keep) if (object(message)) counts.set(message.id, (counts.get(message.id) || 0) + 1);
    let remaining = 50;
    const retained = keep.slice().reverse().filter(message => !ownedRow(message) || counts.get(message.id) !== 1 || remaining-- > 0).reverse();
    files[ROOT] = { content: JSON.stringify({ ...root, messages: retained }) };
    if (result.spaces !== undefined) {
      const previous = store.files[SPACES] ? safeJson(await store.file(SPACES)) : {};
      if (!object(previous)) throw new Error('Spaces document must be an object.');
      files[SPACES] = { content: JSON.stringify({ ...previous, spaces: result.spaces }) };
    }
    if (result.profile !== undefined) {
      const profile = structuredClone(result.profile);
      if (profile.avatar) {
        profile.avatar_file = `muse-relay-avatar-${hash(profile.avatar)}.base64`;
        await output(files, profile.avatar_file, profile.avatar.data_base64);
        delete profile.avatar;
      }
      const previous = store.files[PROFILE] ? safeJson(await store.file(PROFILE)) : {};
      if (!object(previous)) throw new Error('Profile document must be an object.');
      files[PROFILE] = { content: JSON.stringify({ ...previous, profile }) };
    }
    record.receipt = { reply: hash(message), outputs };
    await save(); // Proof survives a successful PATCH whose response is lost.
    await cleanup(files, record.inputs);
    await patch(files);
    state.rows = Object.assign(Object.create(null), Object.fromEntries(retained.filter(ownedRow).map(message => [message.id, hash(message)])));
  }
  async function tick() {
    await store.read();
    const names = Object.keys(store.files).filter(name => name.startsWith(REQUEST_PREFIX) && name.endsWith('.json'));
    // A PATCH can succeed even if its response is lost. Detect that without rerunning the handler.
    for (const [id, entry] of Object.entries(state.requests)) if (entry.status === 'handled' && !names.includes(`${REQUEST_PREFIX}${id}.json`)) {
      if (await published(id, entry, await inbound())) {
        entry.status = 'done'; entry.doneAt = now(); delete entry.result;
      } else entry.status = 'uncertain';
      await save();
    }
    const requests = [];
    let handled = 0, inspection = 0;
    for (const name of names) {
      const content = await store.file(name);
      try { requests.push(validateRequest(safeJson(content), name)); } catch { inspection++; }
    }
    requests.sort((a, b) => a.created_at - b.created_at);
    for (const raw of requests) {
      try {
        const digest = hash(raw);
        let record = state.requests[raw.id];
        if ((record && record.digest !== digest) || (state.completed[raw.id] && state.completed[raw.id] !== digest)) throw new InspectionError('A completed request ID was reused with different content.');
        if (state.completed[raw.id]) { inspection++; continue; }
        if (record?.status === 'done') { if (!await cleanupCompleted(raw, record)) inspection++; continue; }
        if (record?.status === 'claimed') {
          if (record.claimUntil <= now()) { record.status = 'uncertain'; await save(); }
          continue;
        }
        if (record?.status === 'uncertain') continue;
        if (!record) {
          if ((await inbound()).messages.some(message => object(message) && ([raw.id, replyId(raw.id)].includes(message.id)
            || (['You', 'Muse'].includes(message.from) && message.reply_to === raw.id)))) {
            throw new InspectionError('Request ID already appears in shared history; inspect before handling.');
          }
          const inputs = { [`${REQUEST_PREFIX}${raw.id}.json`]: hash(await store.file(`${REQUEST_PREFIX}${raw.id}.json`)) };
          const request = await hydrate(raw, inputs);
          record = { status: 'claimed', digest, inputs, claimedAt: now(), claimUntil: now() + 10 * 60_000 };
          state.requests[raw.id] = record;
          await save();
          try {
            record.result = validateResult(await handler(request));
            record.status = 'handled';
            await save();
          } catch {
            record.status = 'uncertain';
            await save();
            throw new Error('Handler result is unknown. Inspect it before explicitly retrying this request.');
          }
        }
        if (record.status === 'handled') {
          await publish(raw, record);
          record.status = 'done';
          record.doneAt = now();
          delete record.result;
          await save();
          handled++;
        }
      } catch (error) {
        if (!(error instanceof InspectionError)) throw error;
        inspection++;
      }
    }
    // Compact old receipts, but retain ID/digest tombstones to prevent replaying old work.
    for (const [id, record] of Object.entries(state.requests)) if (record.status === 'done' && now() - record.doneAt > 30 * 86400_000 && !names.includes(`${REQUEST_PREFIX}${id}.json`)) {
      state.completed[id] = record.digest; delete state.requests[id];
    }
    await save();
    return { handled, pending: requests.length, inspection, uncertain: Object.values(state.requests).filter(record => record.status === 'uncertain').length };
  }
  async function retry(id) {
    const entry = state.requests[id];
    if (!entry || !['claimed', 'uncertain'].includes(entry.status)) throw new Error('Only an interrupted request can be explicitly retried.');
    delete state.requests[id];
    await save();
  }
  return { tick, retry };
}

async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(`${path}/pid`, 'utf8').catch(() => '0'));
    if (!pid) throw new Error('Watcher lock exists without a PID. Inspect it before removing the lock directory.');
    try { process.kill(pid, 0); throw new Error('A watcher already owns this local state.'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    await rm(path, { recursive: true });
    await mkdir(path, { mode: 0o700 });
  }
  await writeFile(`${path}/pid`, String(process.pid), { mode: 0o600 });
  return () => rm(path, { recursive: true, force: true });
}
async function main() {
  const stateFile = resolve(process.env.GIST_STATE_FILE || '.local/gist-watcher/state.json');
  const release = await acquireLock(`${stateFile}.lock`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
  try {
    const store = new GistStore({ gistId: process.env.GIST_ID, token: process.env.GITHUB_TOKEN });
    const watcher = await createWatcher({
      store, stateFile,
      handler: executableHandler(process.env.MUSE_HANDLER, safeJson(process.env.MUSE_HANDLER_ARGS || '[]')),
    });
    if (process.argv[2] === '--retry') { await watcher.retry(process.argv[3]); console.log('Interrupted request cleared for an explicit retry.'); }
    const poll = Math.max(10, Math.min(300, Number(process.env.GIST_POLL_SECONDS) || 15)) * 1000;
    let lastUncertain = 0, lastInspection = 0;
    do {
      let delay = Math.max(poll, (store.minimumPollSeconds || 0) * 1000);
      try {
        const result = await watcher.tick();
        if (result.handled) console.log(`Completed ${result.handled} request(s).`);
        if (result.uncertain && result.uncertain !== lastUncertain) console.log(`${result.uncertain} interrupted request(s) require inspection before retrying.`);
        if (result.inspection && result.inspection !== lastInspection) console.log(`${result.inspection} shared request(s) were preserved for inspection; no automatic retry.`);
        lastUncertain = result.uncertain;
        lastInspection = result.inspection;
      } catch (error) { console.error(error.message); delay = Math.max(poll, error.retryAfterMs || 60_000); }
      if (process.argv.includes('--once')) break;
      for (let elapsed = 0; elapsed < delay && !stopping; elapsed += 1000) await new Promise(resolveTimer => setTimeout(resolveTimer, 1000));
    } while (!stopping);
  } finally { await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
