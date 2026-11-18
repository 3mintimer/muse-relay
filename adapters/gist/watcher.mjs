import {parseSpaceControl,parseSpaceAction,matchesSpaceAction} from '../../protocol/space-controls.mjs';
import { validateProfile } from '../../server/core.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  async function save() {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
  }
  async function hydrate(raw) {
    const request = { id: raw.id, kind: raw.kind, text: raw.text, created_at: raw.created_at, ...(raw.space_id ? { space_id: raw.space_id } : {}) };
    if (raw.space_action) {
      const spaces = store.files[SPACES] ? safeJson(await store.file(SPACES)).spaces : [];
      const control = spaces?.find(space=>space.id===raw.space_id)?.items?.find(item=>item.id===raw.space_action.item_id)?.control;
      if (!matchesSpaceAction(control,raw.space_action)) throw new Error('Space control changed; refresh before trying again.');
      request.space_action = raw.space_action;
    }
    for (const kind of ['audio', 'image']) {
      const name = raw[`${kind}_file`];
      if (!name) continue;
      const mime = raw[`${kind}_mime`];
      const allowed = kind === 'audio' ? ['audio/wav', 'audio/ogg'] : ['image/png', 'image/jpeg', 'image/webp'];
      const data = (await store.file(name)).replace(/[\r\n]/g, '');
      if (!allowed.includes(mime) || data.length > 5_500_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid request attachment.');
      request[kind] = { mime, data_base64: data, name: typeof raw[`${kind}_name`] === 'string' ? raw[`${kind}_name`].slice(0, 128) : name };
    }
    return request;
  }
  async function publish(raw, result) {
    // Refresh before updating the single inbound file. Other writers to ROOT are unsupported.
    await store.read(true);
    const inbound = store.files[ROOT] ? safeJson(await store.file(ROOT)) : { messages: [] };
    if (!object(inbound) || !Array.isArray(inbound.messages)) throw new Error('Inbound messages must be an array.');
    const time = Math.floor(now() / 1000);
    const ownId = replyId(raw.id);
    const keep = inbound.messages.filter(message => object(message) && message.id !== ownId && message.id !== raw.id);
    keep.push({ id: raw.id, from: 'You', type: raw.audio_file ? 'voice-note' : raw.image_file ? 'image' : 'text', text: result.transcript ?? raw.text, ts: raw.created_at });
    const message = { id: ownId, from: 'Muse', type: result.image ? 'image' : 'text', text: result.text, ts: time, reply_to: raw.id };
    const files = {};
    if (result.image) {
      message.image_file = `muse-relay-output-${raw.id}.base64`;
      message.mime_type = result.image.mime;
      files[message.image_file] = { content: result.image.data_base64 };
    }
    keep.push(message);
    const retained = keep.slice(-50);
    files[ROOT] = { content: JSON.stringify({ ...inbound, messages: retained }) };
    if (result.spaces !== undefined) files[SPACES] = { content: JSON.stringify({ spaces: result.spaces }) };
    let profile;
    if (result.profile !== undefined) {
      profile = structuredClone(result.profile);
      if (profile.avatar) {
        const hash = createHash('sha256').update(JSON.stringify(profile.avatar)).digest('hex');
        profile.avatar_file = `muse-relay-avatar-${hash}.base64`;
        files[profile.avatar_file] = { content: profile.avatar.data_base64 };
        delete profile.avatar;
      }
      files[PROFILE] = { content: JSON.stringify({ profile }) };
    } else profile = store.files[PROFILE] ? safeJson(await store.file(PROFILE)).profile : inbound.profile;
    files[`${REQUEST_PREFIX}${raw.id}.json`] = null;
    for (const kind of ['audio', 'image']) if (raw[`${kind}_file`]) files[raw[`${kind}_file`]] = null;
    const retainedOutput = new Set(retained.map(item => item.image_file).filter(Boolean));
    if (typeof profile?.avatar_file === 'string') retainedOutput.add(profile.avatar_file);
    const spaceDocuments = [inbound.spaces, result.spaces];
    if (result.spaces === undefined && store.files[SPACES]) spaceDocuments.push(safeJson(await store.file(SPACES)).spaces);
    for (const spaces of spaceDocuments) if (Array.isArray(spaces)) {
      for (const space of spaces) if (Array.isArray(space?.items)) {
        for (const item of space.items) if (typeof item?.image_file === 'string') retainedOutput.add(item.image_file);
      }
    }
    // Only this adapter's own output files; never delete unrelated Gist files.
    for (const file of Object.keys(store.files)) if ((file.startsWith('muse-relay-output-') || file.startsWith('muse-relay-avatar-')) && file.endsWith('.base64') && !retainedOutput.has(file)) files[file] = null;
    await store.patch(files);
  }
  async function tick() {
    await store.read();
    const names = Object.keys(store.files).filter(name => name.startsWith(REQUEST_PREFIX) && name.endsWith('.json'));
    // A PATCH can succeed even if its response is lost. Detect that without rerunning the handler.
    for (const [id, entry] of Object.entries(state.requests)) if (entry.status === 'handled' && !names.includes(`${REQUEST_PREFIX}${id}.json`)) {
      const inbound = store.files[ROOT] ? safeJson(await store.file(ROOT)) : {};
      if (Array.isArray(inbound.messages) && inbound.messages.some(message => message.id === replyId(id))) {
        entry.status = 'done'; entry.doneAt = now(); delete entry.result;
      } else entry.status = 'uncertain';
      await save();
    }
    const requests = [];
    for (const name of names) requests.push(validateRequest(safeJson(await store.file(name)), name));
    requests.sort((a, b) => a.created_at - b.created_at);
    let handled = 0;
    for (const raw of requests) {
      const digest = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
      let record = state.requests[raw.id];
      if (record && record.digest !== digest) throw new Error('A completed request ID was reused with different content.');
      if (record?.status === 'done') continue;
      if (record?.status === 'claimed') {
        if (record.claimUntil <= now()) { record.status = 'uncertain'; await save(); }
        continue;
      }
      if (record?.status === 'uncertain') continue;
      if (!record) {
        const request = await hydrate(raw);
        record = { status: 'claimed', digest, claimedAt: now(), claimUntil: now() + 10 * 60_000 };
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
        await publish(raw, record.result);
        record.status = 'done';
        record.doneAt = now();
        delete record.result;
        await save();
        handled++;
      }
    }
    // Retain dedupe records 30 days, and only drop them after the source file is gone.
    for (const [id, record] of Object.entries(state.requests)) if (record.status === 'done' && now() - record.doneAt > 30 * 86400_000 && !names.includes(`${REQUEST_PREFIX}${id}.json`)) delete state.requests[id];
    await save();
    return { handled, pending: requests.length, uncertain: Object.values(state.requests).filter(record => record.status === 'uncertain').length };
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
    let lastUncertain = 0;
    do {
      let delay = Math.max(poll, (store.minimumPollSeconds || 0) * 1000);
      try {
        const result = await watcher.tick();
        if (result.handled) console.log(`Completed ${result.handled} request(s).`);
        if (result.uncertain && result.uncertain !== lastUncertain) console.log(`${result.uncertain} interrupted request(s) require inspection before retrying.`);
        lastUncertain = result.uncertain;
      } catch (error) { console.error(error.message); delay = Math.max(poll, error.retryAfterMs || 60_000); }
      if (process.argv.includes('--once')) break;
      for (let elapsed = 0; elapsed < delay && !stopping; elapsed += 1000) await new Promise(resolveTimer => setTimeout(resolveTimer, 1000));
    } while (!stopping);
  } finally { await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
