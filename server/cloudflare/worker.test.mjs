import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createWorker } from './worker.mjs';
import { D1StateStore } from './storage.mjs';
import { createMachine, fingerprint, validateRequest } from '../core.mjs';

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
  async put(key, bytes) { this.objects.set(key, new Uint8Array(bytes)); }
  async get(key) { const bytes = this.objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null; }
  async delete(key) { this.objects.delete(key); }
}

test('Muse reads back a slider export and updates one space without losing other spaces', async t => {
  const DB = new TestD1(), BUCKET = new TestR2();
  t.after(() => DB.sqlite.close());
  DB.sqlite.exec(await readFile(new URL('./drizzle/0000_relay.sql', import.meta.url), 'utf8'));
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
  DB.sqlite.exec(await readFile(new URL('./drizzle/0000_relay.sql', import.meta.url), 'utf8'));
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
