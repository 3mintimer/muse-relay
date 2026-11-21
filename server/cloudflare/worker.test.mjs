import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createWorker } from './worker.mjs';
import { D1StateStore } from './storage.mjs';
import { linkLiveVoice, LIVE_VOICE_PROTOCOL } from './live-voice.mjs';
import { buildMuseRequest, createMachine, emptyState, fingerprint, validateRequest } from '../core.mjs';

// Execute the adapter's actual SQL. Each batch is a SQLite transaction, like D1.
class TestD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.conflicts = 0; }
  prepare(sql) {
    const database = this;
    return { sql, args: [], bind(...args) { return { ...this, args }; },
      async run() { const result = database.sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes) } }; },
      async all() { return { results: database.sqlite.prepare(this.sql).all(...this.args) }; },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => ({ meta: { changes: Number(this.sqlite.prepare(statement.sql).run(...statement.args).changes) } }));
      this.sqlite.exec('COMMIT');
      if (statements[0].sql.startsWith('UPDATE relay_head') && results[0].meta.changes === 0) this.conflicts++;
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
class TestR2 {
  objects = new Map();
  revisions = new Map();
  async put(key, bytes, {onlyIf} = {}) {
    const etag = this.revisions.get(key);
    if (onlyIf?.etagDoesNotMatch === '*' && etag || onlyIf?.etagMatches && onlyIf.etagMatches !== etag) return null;
    this.objects.set(key, new Uint8Array(bytes));
    this.revisions.set(key, crypto.randomUUID());
    return {etag:this.revisions.get(key)};
  }
  async get(key) { const bytes = this.objects.get(key); return bytes ? { etag:this.revisions.get(key), size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null; }
  async delete(key) { this.objects.delete(key); }
}

async function applyMigrations(DB) {
  const dir = new URL('./drizzle/', import.meta.url);
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort())
    DB.sqlite.exec(await readFile(new URL(file, dir), 'utf8'));
}

test('live transcription is opt-in and requires the phone credential and upgrade before Soniox', async t => {
  const DB = new TestD1(), BUCKET = new TestR2();
  t.after(() => DB.sqlite.close());
  await applyMigrations(DB);
  const env = { DB, BUCKET, RELAY_TOKEN: 'p'.repeat(40), DEVICE_TOKEN: 'd'.repeat(40), MUSE_TOKEN: 'm'.repeat(40),
    SONIOX_API_KEY: 'synthetic-key', ALLOWED_ORIGINS: 'http://127.0.0.1:*' };
  let sonioxCalls = 0;
  const worker = createWorker({ fetchImpl: async (url, options) => {
    sonioxCalls++;
    assert.equal(url, 'https://stt-rt.soniox.com/transcribe-websocket');
    assert.deepEqual(options.headers, { upgrade: 'websocket', authorization: 'Bearer synthetic-key' });
    return new Response(null, { status: 503 });
  } });
  const snapshot = async () => (await worker.fetch(new Request('https://relay.example/v1/snapshot', {
    headers: { authorization: `Bearer ${env.RELAY_TOKEN}` },
  }), env)).json();
  const stream = (token, origin = 'http://127.0.0.1:53210', upgrade = 'websocket') => worker.fetch(new Request('https://relay.example/v1/voice/live', {
    headers: { 'sec-websocket-protocol': `${LIVE_VOICE_PROTOCOL}, ${token}`, upgrade, origin },
  }), env);
  assert.equal((await snapshot()).capabilities.live_transcription, undefined);
  assert.equal((await stream(env.RELAY_TOKEN)).status, 503);
  env.SONIOX_RELAY_LIVE = 'true';
  assert.equal((await snapshot()).capabilities.live_transcription, true);
  assert.equal((await stream(env.DEVICE_TOKEN)).status, 401);
  assert.equal((await stream(env.MUSE_TOKEN)).status, 401);
  assert.equal((await stream(env.RELAY_TOKEN, 'https://example.net')).status, 403);
  assert.equal((await stream(env.RELAY_TOKEN, undefined, '')).status, 426);
  assert.equal(sonioxCalls, 0);
  assert.equal((await stream(env.RELAY_TOKEN)).status, 502);
  assert.equal(sonioxCalls, 1);
});

test('live relay forwards bounded PCM and interim/final tokens without forwarding caller configuration', () => {
  class Socket extends EventTarget {
    sent = [];
    closed = [];
    accept() {}
    send(data) { this.sent.push(data); }
    receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close(code) { this.closed.push(code); }
  }
  const phone = new Socket(), soniox = new Socket();
  linkLiveVoice(phone, soniox);
  phone.receive(JSON.stringify({ model: 'user-chosen-model', api_key: 'untrusted', language_hints: ['ja'] }));
  assert.deepEqual(JSON.parse(soniox.sent[0]), {
    model: 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1, language_hints: ['ja'], enable_endpoint_detection: true,
  });
  const audio = new Uint8Array([0, 1, 2, 3]).buffer;
  phone.receive(audio);
  assert.equal(soniox.sent[1], audio);
  soniox.receive(JSON.stringify({ tokens: [{ text: '予定', is_final: false, start_ms: 42 }], request_id: 'upstream-id' }));
  assert.deepEqual(JSON.parse(phone.sent[0]), { tokens: [{ text: '予定', is_final: false }], finished: false });
  assert.deepEqual(phone.closed, []);
  phone.receive('');
  soniox.receive(JSON.stringify({ tokens: [{ text: '予定の確認', is_final: true }], finished: true }));
  assert.equal(soniox.sent[2], '');
  assert.deepEqual(JSON.parse(phone.sent[1]), { tokens: [{ text: '予定の確認', is_final: true }], finished: true });
  assert.deepEqual(phone.closed, [1000]);
  assert.deepEqual(soniox.closed, [1000]);

  const oversized = new Socket(), limited = new Socket();
  linkLiveVoice(oversized, limited);
  oversized.receive('{"language_hints":["ja"]}');
  const frame = new ArrayBuffer(64_000);
  for (let sent = 0; sent < 16; sent++) oversized.receive(frame);
  assert.equal(limited.sent.length, 16, 'only 30 seconds of PCM reach Soniox');
  assert.deepEqual(oversized.closed, [1009]);
  assert.deepEqual(limited.closed, [1009]);
});

test('Soniox admission keeps the legacy rolling quota without rewriting the relay state', async t => {
  const DB = new TestD1(), BUCKET = new TestR2();
  t.after(() => DB.sqlite.close());
  await applyMigrations(DB);
  let clock = Date.now();
  const seed = [clock - 50000, clock - 3000, clock - 2000, clock - 1000];
  const store = new D1StateStore(DB);
  await store.update(state => { state.sonioxCalls = seed; });
  const prior = (await store.load()).revision;
  const env = { DB, BUCKET, RELAY_TOKEN: 'p'.repeat(40), DEVICE_TOKEN: 'd'.repeat(40), MUSE_TOKEN: 'm'.repeat(40), SONIOX_API_KEY: 'synthetic-issuer-key' };
  let issued = 0;
  const call = (token = env.RELAY_TOKEN) => createWorker({
    now: () => clock, fetchImpl: async () => {
      issued++;
      return Response.json({ api_key: 'snx_temp_test' });
    },
  }).fetch(new Request('https://relay.example/v1/soniox-token', { method: 'POST', headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal((await call(env.DEVICE_TOKEN)).status, 401);
  const concurrent = await Promise.all([call(), call()]);
  assert.deepEqual(concurrent.map(reply => reply.status).sort(), [200, 429]);
  assert.equal(issued, 1);
  assert.equal((await store.load()).revision, prior, 'issuance does not contend for the relay state pointer');
  clock += 10000;
  assert.equal((await call()).status, 200, 'the oldest legacy call has left the minute');
  assert.equal((await call()).status, 429);
  assert.equal(issued, 2);
  assert.equal((await store.load()).revision, prior);
});

test('Muse reads back a slider export and updates one space without losing other spaces', async t => {
  const DB = new TestD1(), BUCKET = new TestR2();
  t.after(() => DB.sqlite.close());
  await applyMigrations(DB);
  const env = { DB, BUCKET, RELAY_TOKEN: 'p'.repeat(40), DEVICE_TOKEN: 'd'.repeat(40), MUSE_TOKEN: 'm'.repeat(40) };
  const call = (path, token, method = 'GET', body) => createWorker().fetch(new Request(`https://relay.example${path}`, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body),
  }), env);
  const daily = { id: 'daily', title: 'Focus', items: [{ id: 'timer', title: 'Minutes', text: '', control: { type: 'slider', min: 5, max: 60, step: 5, value: 25 } }] };
  const image = { mime: 'image/png', name: 'card.png', data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6sAAAAASUVORK5CYII=' };
  const news = { id: 'news', title: 'News', items: [{ id: 'today', title: 'Today', text: 'Keep this card', image }] };
  const { MUSE_TOKEN: muse, RELAY_TOKEN: phone, DEVICE_TOKEN: device } = env;
  assert.equal((await call('/v1/spaces', muse, 'PUT', { spaces: [daily, news] })).status, 200);
  for (const token of [undefined, phone, device]) {
    assert.equal((await call('/v1/spaces', token)).status, 401);
    assert.equal((await call('/v1/spaces/daily', token, 'PUT', daily)).status, 401);
  }
  assert.equal((await call('/v1/snapshot', muse)).status, 401);
  const readback = await call('/v1/spaces', muse);
  assert.equal(readback.status, 200);
  const exported = await readback.json();
  assert.deepEqual(Object.keys(exported), ['spaces']);
  assert.deepEqual(exported.spaces[1].items[0], news.items[0], 'R2 image is returned in the public export format');

  const requested = { id: 'adjust', kind: 'space', text: 'Focus: 30', created_at: Math.floor(Date.now() / 1000), space_id: 'daily', space_action: { item_id: 'timer', type: 'slider', value: 30 } };
  // A job queued before the server upgrade has a fingerprint and byte count in the original format.
  const legacy = validateRequest({ ...requested, id: 'legacy' }, false);
  await new D1StateStore(DB).update(async state => createMachine(state).addRequest(legacy, await fingerprint(legacy)));
  assert.equal((await (await call('/v1/requests', phone, 'POST', legacy)).json()).duplicate, true);
  const oldJob = (await (await call('/device/jobs', device)).json()).job;
  const oldPacket = await call('/device/jobs/legacy/request', device);
  assert.equal(Number(oldPacket.headers.get('content-length')), oldJob.request_bytes);
  assert.doesNotMatch((await oldPacket.json()).message, /PUT \/v1\/spaces\/daily/);
  assert.equal((await call('/device/events', device, 'POST', { job_id: 'legacy', session_id: oldJob.session_id, event_id: 'legacy-done', type: 'error', code: 'test-completed' })).status, 200);

  assert.equal((await call('/v1/requests', phone, 'POST', requested)).status, 202);
  const { job } = await (await call('/device/jobs', device)).json();
  const packet = await call('/device/jobs/adjust/request', device);
  assert.equal(Number(packet.headers.get('content-length')), job.request_bytes);
  const { message } = await packet.json();
  assert.match(message, /"type":"slider","value":30/);
  assert.match(message, /PUT \/v1\/spaces\/daily/);
  assert.match(message, /GET \/v1\/spaces with the same token/);

  const updated = exported.spaces[0];
  updated.items[0].control.value = 30;
  assert.equal((await call('/v1/spaces/news', muse, 'PUT', updated)).status, 400);
  const writes = await Promise.all([
    call('/v1/spaces/daily', muse, 'PUT', updated),
    call('/v1/spaces/news', muse, 'PUT', { ...exported.spaces[1], title: 'Updated news' }),
  ]);
  assert.deepEqual(writes.map(result => result.status), [200, 200]);
  const { spaces } = await (await call('/v1/spaces', muse)).json();
  assert.deepEqual(spaces.map(({ id }) => id), ['daily', 'news']);
  assert.equal(spaces[0].items[0].control.value, 30);
  assert.equal(spaces[1].title, 'Updated news');
  assert.deepEqual(spaces[1].items[0], news.items[0]);
});

test('Worker persists CAS leases, streams, attachments, and issues bounded Soniox keys', async t => {
  const DB = new TestD1(), BUCKET = new TestR2();
  await applyMigrations(DB);
  const env = { DB, BUCKET, RELAY_TOKEN: 'p'.repeat(40), DEVICE_TOKEN: 'd'.repeat(40), MUSE_TOKEN: 'm'.repeat(40), ALLOWED_ORIGINS: 'https://app.example,http://127.0.0.1:*' };
  let clock = Date.now(), sequence = 0, sessionId;
  // A fresh Worker factory for every call: no in-memory queue or stream buffer survives.
  const call = async (path, token = env.RELAY_TOKEN, body, method, headers = {}) => {
    const request = new Request(`https://relay.example${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await createWorker({ now: () => clock }).fetch(request, env);
    return { status: result.status, headers: result.headers, body: result.status === 204 ? null : await result.json() };
  };
  const event = (id, type, fields) => call('/device/events', env.DEVICE_TOKEN, { job_id: id, session_id: sessionId, event_id: `evt_${++sequence}`, type, ...fields });
  try {
    assert.equal((await call('/v1/snapshot', 'wrong')).status, 401);
    assert.equal((await call('/v1/snapshot')).body.capabilities.soniox, false);
    env.SONIOX_API_KEY = 'test-server-only-key';
    const configuredSnapshot = (await call('/v1/snapshot')).body;
    assert.equal(configuredSnapshot.capabilities.soniox, true);
    assert.ok(!JSON.stringify(configuredSnapshot).includes(env.SONIOX_API_KEY));
    const upstreamRequests = [], warnings = [];
    let upstreamMode = 'success';
    const mockedFetch = t.mock.method(globalThis, 'fetch', async function (url, options) {
      assert.equal(this, globalThis, 'the native fetch receiver is preserved');
      upstreamRequests.push({ url, options });
      if (upstreamMode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://other.example' } });
      if (upstreamMode === 'throw') throw new TypeError(`Illegal invocation: function called with incorrect this reference ${env.SONIOX_API_KEY}`);
      return Response.json({ api_key: 'snx_temp_test', expires_at: '2026-11-17T00:00:00Z' }, { status: 201 });
    });
    const mockedWarning = t.mock.method(console, 'warn', value => warnings.push(value));
    try {
      const issued = await call('/v1/soniox-token', env.RELAY_TOKEN, {});
      assert.equal(issued.status, 200);
      assert.match(issued.headers.get('server-timing'), /^relay-quota;dur=\d+, soniox-issuer;dur=\d+$/);
      assert.deepEqual(issued.body, { api_key: 'snx_temp_test', expires_at: '2026-11-17T00:00:00Z' });
      assert.equal(upstreamRequests[0].url, 'https://api.soniox.com/v1/auth/temporary-api-key');
      assert.equal(upstreamRequests[0].options.headers.authorization, `Bearer ${env.SONIOX_API_KEY}`);
      assert.equal(upstreamRequests[0].options.redirect, 'manual');
      assert.deepEqual(JSON.parse(upstreamRequests[0].options.body), { usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 150 });
      upstreamMode = 'redirect';
      assert.deepEqual((await call('/v1/soniox-token', env.RELAY_TOKEN, {})).body, { error: 'soniox_redirect_blocked' });
      assert.equal(upstreamRequests.length, 2, 'the redirect target is never fetched');
      upstreamMode = 'throw';
      const failed = await call('/v1/soniox-token', env.RELAY_TOKEN, {});
      assert.equal(failed.status, 502);
      assert.equal(failed.body.error, 'soniox_upstream_unavailable');
      assert.deepEqual(JSON.parse(warnings[0]), { event: 'soniox_token_failure', phase: 'fetch', name: 'TypeError', reason: 'illegal_invocation' });
      assert.ok(!JSON.stringify(warnings).includes(env.SONIOX_API_KEY));
    } finally { mockedFetch.mock.restore(); mockedWarning.mock.restore(); }
    delete env.SONIOX_API_KEY;
    assert.equal((await call('/v1/snapshot', env.RELAY_TOKEN, undefined, 'GET', { origin: 'https://other.example' })).status, 403);
    const preflight = await call('/v1/snapshot', 'no-token', undefined, 'OPTIONS', { origin: 'https://app.example', 'access-control-request-headers': 'authorization,oai-sites-authorization' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /OAI-Sites-Authorization/);
    for (const origin of ['http://127.0.0.1:54848', 'http://127.0.0.1:54914']) {
      const localPreflight = await createWorker().fetch(new Request('https://relay.example/v1/snapshot', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }), env);
      assert.equal(localPreflight.status, 204);
      assert.equal(localPreflight.headers.get('access-control-allow-origin'), origin);
      const snapshot = await call('/v1/snapshot', env.RELAY_TOKEN, undefined, 'GET', { origin });
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.headers.get('access-control-allow-origin'), origin);
    }
    assert.equal((await call('/v1/snapshot', 'wrong', undefined, 'GET', { origin: 'http://127.0.0.1:54914' })).status, 401);
    assert.equal((await call('/device/jobs', env.RELAY_TOKEN, undefined, 'GET', { origin: 'http://127.0.0.1:54914' })).status, 401);
    assert.equal((await call('/v1/snapshot', env.RELAY_TOKEN, undefined, 'GET', { origin: 'http://127.0.0.1.example:54914' })).status, 403);
    const request = { id: 'turn_1', kind: 'chat', text: 'hello', created_at: Math.floor(clock / 1000) };
    assert.equal((await call('/v1/requests', env.RELAY_TOKEN, request)).status, 202);
    assert.equal((await call('/v1/requests', env.RELAY_TOKEN, request)).body.duplicate, true);
    await call('/v1/requests', env.RELAY_TOKEN, { ...request, id: 'turn_2' });
    const leases = await Promise.all([call('/device/jobs', env.DEVICE_TOKEN), call('/device/jobs', env.DEVICE_TOKEN)]);
    assert.equal(leases.filter(result => result.body.job?.id === 'turn_1').length, 1);
    assert.equal(leases.filter(result => result.body.job === null).length, 1);
    const leased = leases.find(result => result.body.job).body.job;
    sessionId = leased.session_id;
    assert.ok(DB.conflicts > 0, 'the simultaneous readers exercised CAS retry');
    const raw = await call('/device/jobs/turn_1/request', env.DEVICE_TOKEN);
    assert.equal(raw.body.message, 'hello');
    assert.equal(raw.body.session_id, sessionId);
    assert.equal(Number(raw.headers.get('content-length')), Buffer.byteLength(JSON.stringify(raw.body)));
    assert.equal(leased.request_bytes, Number(raw.headers.get('content-length')));

    // Events can precede the ACK, and raw frames can split a Japanese character.
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 5000, event_name: 'delta.message_start', payload: { message_id: 'reply_1' } } });
    const line = Buffer.from(JSON.stringify({ type: 'event', seq: 5001, event_name: 'delta.text_append', payload: { message_id: 'reply_1', text: 'こんにちは' } }) + '\n');
    const split = line.indexOf(Buffer.from('こん')) + 1;
    await event('turn_1', 'muse_chunk', { body_base64: line.subarray(0, split).toString('base64') });
    const partial = await new D1StateStore(DB).load();
    assert.equal(partial.state.pending.turn_1.length, 1);
    assert.equal(Buffer.from(partial.state.streams.turn_1, 'base64').length, split);
    await event('turn_1', 'muse_ack', { subscription_fresh: true, body: { result: { message_id: 'own_note', session_id: sessionId, is_thread: true } } });
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 1000, event_name: 'message.user', payload: { message_id: 'own_note' } } });
    const chunk = { job_id: 'turn_1', session_id: sessionId, event_id: 'stable_chunk', type: 'muse_chunk', body_base64: line.subarray(split).toString('base64') };
    await call('/device/events', env.DEVICE_TOKEN, chunk);
    await call('/device/events', env.DEVICE_TOKEN, chunk);
    assert.equal((await call('/v1/snapshot')).body.messages.at(-1).text, 'こんにちは');
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 9000, event_name: 'message.assistant', payload: { message_id: 'unrelated', reply_to_message_id: 'someone_else', text: 'unrelated private chat' } } });
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 9001, event_name: 'message.assistant', payload: { message_id: 'wrong_session', session_id: 'another-chat', text: 'unrelated private chat' } } });
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 1001, event_name: 'message.user', payload: { message_id: 'someone_else' } } });
    await event('turn_1', 'muse_ack', { subscription_fresh: true, body: { result: { message_id: 'own_note', session_id: sessionId, is_thread: true } } });
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 1002, event_name: 'message.assistant', payload: { message_id: 'after_foreign_user', text: 'unrelated private chat' } } });
    assert.equal((await event('turn_1', 'muse_event', { body: { type: 'event', seq: 1003, event_name: 'message.assistant', payload: { message_id: 'reply_1', display_text: 'こんにちは' } } })).body.terminal, true);
    const next = (await call('/device/jobs', env.DEVICE_TOKEN)).body.job;
    assert.equal(next.id, 'turn_2'); assert.equal(next.session_id, sessionId);
    const restored = (await call('/v1/snapshot')).body;
    assert.ok(!JSON.stringify(restored).includes('unrelated private chat'));
    assert.equal(restored.messages.find(message => message.id === 'muse_turn_1').text, 'こんにちは');
    assert.equal((await event('turn_2', 'muse_ack', { subscription_fresh: true, body: { result: { message_id: 'own_note_2', session_id: sessionId, is_thread: true } } })).status, 409);
    await event('turn_2', 'muse_ack', { body: { result: { message_id: 'own_note_2', session_id: sessionId, is_thread: true } } });
    await event('turn_2', 'muse_event', { body: { type: 'event', seq: 1004, event_name: 'message.user', payload: { message_id: 'own_note_2' } } });
    assert.equal((await event('turn_2', 'muse_event', { body: { type: 'event', seq: 1005, event_name: 'message.assistant', payload: { message_id: 'reply_1', text: 'old answer replay' } } })).body.terminal, false);
    assert.ok(!(await call('/v1/snapshot')).body.messages.some(message => message.id === 'muse_turn_2'));

    const image = { mime: 'image/png', name: 'reply.png', data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' };
    const published = { id: 'muse_export_photo', type: 'image', image };
    assert.equal((await call('/v1/messages', env.RELAY_TOKEN, published)).status, 401);
    await call('/v1/messages', env.MUSE_TOKEN, published);
    await call('/v1/messages', env.MUSE_TOKEN, published); // deterministic ID; old blob becomes an orphan
    assert.equal(BUCKET.objects.size, 2);
    const snapshot = (await call('/v1/snapshot')).body;
    assert.equal(snapshot.capabilities.images, false);
    assert.equal(snapshot.messages.filter(message => message.id === published.id).length, 1);
    assert.equal(snapshot.messages.at(-1).type, 'image');
    assert.equal(snapshot.messages.at(-1).text, '');
    assert.equal(snapshot.messages.at(-1).mime_type, 'image/png');
    assert.ok(!JSON.stringify(snapshot).includes('_blob'));
    assert.deepEqual((await call(`/v1/files/${snapshot.messages.at(-1).image_file}`)).body, image);
    assert.ok(!JSON.stringify((await new D1StateStore(DB).load()).state).includes(image.data_base64));
    const spaces = { spaces: [{ id: 'news', title: 'ニュース', items: [{ id: 'card', title: '今日', text: 'Muse export', image }] }] };
    assert.equal((await call('/v1/spaces', env.MUSE_TOKEN, spaces, 'PUT')).status, 200);
    assert.equal((await call('/v1/files/space_4_news_card')).body.data_base64, image.data_base64);
    const profile = { name: 'Test avatar', avatar: image, updated_at: Math.floor(clock / 1000) };
    assert.equal((await call('/v1/profile', env.RELAY_TOKEN, profile, 'PUT')).status, 401);
    assert.equal((await call('/v1/profile', env.MUSE_TOKEN, profile, 'PUT')).status, 200);
    const profileSnapshot = (await call('/v1/snapshot')).body.profile;
    assert.equal(profileSnapshot.name, profile.name);
    assert.equal(profileSnapshot.mime_type, image.mime);
    assert.equal(profileSnapshot.avatar, undefined, 'R2 storage metadata is not exposed to the phone');
    assert.ok(!JSON.stringify(profileSnapshot).includes('_blob'));
    assert.deepEqual((await call(`/v1/files/${profileSnapshot.avatar_file}`)).body, image);
    assert.ok(!JSON.stringify((await new D1StateStore(DB).load()).state).includes(image.data_base64));
    assert.equal((await call('/admin/gc', env.MUSE_TOKEN, {})).body.deleted, 0);
    clock += 25 * 60 * 60_000;
    assert.equal((await call('/admin/gc', env.MUSE_TOKEN, {})).body.deleted, 1);
    assert.equal(BUCKET.objects.size, 3, 'referenced message, space and profile images survive collection');
    assert.deepEqual((await call(`/v1/files/${profileSnapshot.avatar_file}`)).body, image);
    assert.equal((await call('/v1/profile', env.MUSE_TOKEN, {}, 'PUT')).status, 200);
    assert.deepEqual((await call('/v1/snapshot')).body.profile, {});
    assert.equal((await call(`/v1/files/${profileSnapshot.avatar_file}`)).status, 404);
    assert.equal((await call('/admin/gc', env.MUSE_TOKEN, {})).body.deleted, 1);
    assert.equal(BUCKET.objects.size, 2);
  } finally { DB.sqlite.close(); }
});

test('Worker diagnostics and recovery commands use R2 without taking jobs', async t => {
  const { checkMaintenance, testFirmware, adminDigest } = await import('../../tests/maintenance-contract.mjs');
  const DB = new TestD1(), BUCKET = new TestR2();
  t.after(() => DB.sqlite.close());
  await applyMigrations(DB);
  const config = { relayToken:'p'.repeat(40), deviceToken:'d'.repeat(40), museToken:'m'.repeat(40) };
  const env = {DB,BUCKET,RELAY_TOKEN:config.relayToken,DEVICE_TOKEN:config.deviceToken,MUSE_TOKEN:config.museToken,RECOVERY_ADMIN_SHA256:adminDigest};
  let clock = Date.now();
  const worker = createWorker({firmware:testFirmware,now:()=>clock});
  const call = (path,token,body,headers={}) => worker.fetch(new Request('https://relay.example'+path,{method:body?'POST':'GET',
    headers:{...(token?{authorization:'Bearer '+token}:{}),...headers},body:body && JSON.stringify(body)}),env);
  await checkMaintenance(call,config,ms=>{clock+=ms});
});

test('chat location reaches the Muse file item without changing the message or leaking to the snapshot', async () => {
  const location = { latitude: 12.125, longitude: -34.5, captured_at: 100, accuracy: 20 };
  const input = { id: 'loc1', kind: 'chat', created_at: 101, text: 'Where am I?' };
  const plain = validateRequest(input, false);
  const request = validateRequest({ ...input, location: { ...location, private_note: 'drop' } }, false);
  const packet = buildMuseRequest(request);
  assert.equal(packet.message, input.text);
  assert.deepEqual(packet.items[0], { type: 'text', text: input.text });
  assert.equal(packet.items[1].filename, 'phone-location.json');
  assert.deepEqual(JSON.parse(atob(packet.items[1].data_base64)), location);
  assert.deepEqual(buildMuseRequest(plain), { message: input.text, output_modality: 'text' });
  assert.deepEqual(validateRequest({ ...input, location: { ...location, latitude: 91 } }, false), plain);
  assert.equal(validateRequest({ ...input, kind: 'space', space_id: 'test', location }, false).location, undefined);
  const machine = createMachine(emptyState(), { now: () => 101000 });
  machine.addRequest(request, await fingerprint(request));
  assert.doesNotMatch(JSON.stringify(machine.snapshot(false)), /latitude|12\.125/);
});
