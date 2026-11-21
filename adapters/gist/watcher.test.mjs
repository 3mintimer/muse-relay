import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GistStore, createWatcher } from './watcher.mjs';

async function memoryWatcher(t, files, handler, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-gist-shared-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'state.json'), patches = [];
  const store = {
    files, async read() { return true; },
    async file(name) { if (!files[name]) throw new Error('Missing fixture file'); return files[name].content; },
    async patch(patch) {
      patches.push(structuredClone(patch));
      for (const [name, value] of Object.entries(patch)) { if (value === null) delete files[name]; else files[name] = value; }
    },
  };
  const restart = () => createWatcher({ store, stateFile, handler, ...options });
  return { watcher: await restart(), restart, stateFile, store, patches };
}

test('publishing into a shared Gist preserves legacy history, root fields and unrelated files', async t => {
  const legacy = Array.from({ length: 60 }, (_, i) => ({ id: `legacy-${i}`, from: 'Muse', type: 'text', text: `Legacy ${i}`, ts: i }));
  legacy[59].reply_to = 'already-handled'; // Another implementation used its own reply ID.
  const root = { messages: legacy, legacy_meta: { cursor: 'keep' }, spaces: [{ id: 'legacy-space', items: [{ image_file: 'muse-relay-output-legacy.base64' }] }] };
  const request = { protocol: 'muse-relay/1', id: 'new', kind: 'chat', text: 'New request', created_at: 100 };
  const files = {
    'g2muse-relay.json': { content: JSON.stringify(root) },
    'muse-relay-request-new.json': { content: JSON.stringify(request) },
    'muse-relay-output-legacy.base64': { content: 'legacy-image' },
    'muse-relay-output-unrelated.base64': { content: 'unrelated-data' },
    'muse-relay-avatar-unrelated.base64': { content: 'unrelated-avatar' },
    'muse-relay-request-already-handled.json': { content: JSON.stringify({ ...request, id: 'already-handled', created_at: 1 }) },
    'muse-relay-request-legacy-0.json': { content: JSON.stringify({ ...request, id: 'legacy-0', created_at: 2 }) },
    'muse-relay-request-invalid.json': { content: 'not JSON' },
  };
  let calls = 0;
  const { watcher } = await memoryWatcher(t, files, async () => { calls++; return { text: 'New reply' }; });
  const result = await watcher.tick();
  const after = JSON.parse(files['g2muse-relay.json'].content);
  assert.equal(calls, 1); assert.equal(result.inspection, 3, 'unproven collisions must not rerun work or block an independent request');
  assert.equal(after.messages.filter(message => message.id.startsWith('legacy-')).length, 60);
  assert.deepEqual(after.messages.filter(message => message.id.startsWith('legacy-')), legacy, 'all 60 unowned rows must survive publication');
  assert.deepEqual({ ...after, messages: legacy }, root);
  for (const name of ['muse-relay-output-legacy.base64', 'muse-relay-output-unrelated.base64', 'muse-relay-avatar-unrelated.base64']) assert.ok(files[name], name);
  for (const id of ['already-handled', 'legacy-0', 'invalid']) assert.ok(files[`muse-relay-request-${id}.json`]);
});

test('owned retention and completed-request cleanup survive restart without deleting shared references or replaying work', async t => {
  const files = { 'g2muse-relay.json': { content: JSON.stringify({ messages: [{ id: 'legacy', from: 'Muse', text: 'Keep', ts: 0 }] }) } };
  let calls = 0, time = 1_800_000_000_000;
  const testStore = await memoryWatcher(t, files, async request => {
    calls++;
    return { text: 'Reply', ...(['r0', 'r1', 'r2', 'file-collision'].includes(request.id) ? { image: { mime: 'image/png', data_base64: 'AQID' } } : {}) };
  }, { now: () => time });
  let watcher = testStore.watcher;
  const add = (id, audio = false) => {
    const raw = { protocol: 'muse-relay/1', id, kind: 'chat', text: 'Request', created_at: time / 1000,
      ...(audio ? { audio_file: `muse-relay-audio-${id}.base64`, audio_mime: 'audio/wav' } : {}) };
    files[`muse-relay-request-${id}.json`] = { content: JSON.stringify(raw) };
    if (audio) files[raw.audio_file] = { content: 'YXVkaW8=' };
    return raw;
  };
  files['another-history.json'] = { content: JSON.stringify({ archive: [{ audio_file: 'muse-relay-audio-r0.base64', image_file: 'muse-relay-output-r0.base64' }] }) };
  files['legacy-spaces.json'] = { content: JSON.stringify({ spaces: [{ items: [{ image_file: 'muse-relay-output-r1.base64' }] }] }) };
  const first = add('r0', true); await watcher.tick();
  assert.equal(testStore.patches[0]['muse-relay-request-r0.json'], null, 'reply and verified request removal share one PATCH');
  assert.ok(testStore.patches[0]['g2muse-relay.json']);assert.ok(files[first.audio_file], 'a history reference protects an otherwise processed input');
  for (let i = 1; i < 28; i++) {
    time += 1000; add(`r${i}`); await watcher.tick();
    if (i === 13) watcher = await testStore.restart();
  }
  const rows = JSON.parse(files['g2muse-relay.json'].content).messages;
  assert.equal(rows.length, 51);assert.equal(rows.filter(row => row.muse_relay_owner).length, 50);
  assert.equal(rows[0].id, 'legacy');
  assert.ok(files['muse-relay-output-r0.base64']);assert.ok(files['muse-relay-output-r1.base64']);
  assert.equal(files['muse-relay-output-r2.base64'], undefined, 'only a proven, now-unreferenced output is collected');

  const replay = add('with-audio', true);await watcher.tick();
  const completedCalls = calls, envelope = `muse-relay-request-${replay.id}.json`;
  const putReplay = () => { files[envelope] = { content: JSON.stringify(replay) };files[replay.audio_file] = { content: 'YXVkaW8=' }; };
  watcher = await testStore.restart();putReplay();files[replay.audio_file].content = 'Y2hhbmdlZA==';
  assert.equal((await watcher.tick()).inspection, 1);assert.ok(files[envelope]);assert.equal(calls, completedCalls);
  putReplay();files['retained-request.json'] = { content: JSON.stringify({ request_file: envelope }) };
  await watcher.tick();assert.ok(files[envelope]);assert.ok(files[replay.audio_file], 'references propagate from a retained request to its input');
  delete files['retained-request.json'];await watcher.tick();
  assert.equal(files[envelope], undefined);assert.equal(files[replay.audio_file], undefined);assert.equal(calls, completedCalls);
  assert.equal(testStore.patches.at(-1)[envelope], null);assert.equal(testStore.patches.at(-1)[replay.audio_file], null);

  putReplay();const changedRoot = JSON.parse(files['g2muse-relay.json'].content);
  const reply = changedRoot.messages.find(row => row.reply_to === replay.id);reply.text = 'Changed by another writer';
  files['g2muse-relay.json'].content = JSON.stringify(changedRoot);
  assert.equal((await watcher.tick()).inspection, 1);assert.ok(files[envelope]);assert.equal(calls, completedCalls);
  delete files[envelope];delete files[replay.audio_file];
  time += 31 * 86400_000;await watcher.tick();watcher = await testStore.restart();putReplay();
  assert.equal((await watcher.tick()).inspection, 1);assert.equal(calls, completedCalls);
  const state = JSON.parse(await readFile(testStore.stateFile, 'utf8'));
  assert.ok(state.completed[replay.id]);assert.equal(state.requests[replay.id], undefined, 'compact dedupe proof remains after old receipts expire');

  add('file-collision');files['muse-relay-output-file-collision.base64'] = { content: 'unrelated' };
  const beforeCollision = files['g2muse-relay.json'].content;
  await watcher.tick();const afterCollisionCalls = calls;await watcher.tick();
  assert.equal(calls, afterCollisionCalls, 'a known handler result is not executed again after an output collision');
  assert.equal(files['g2muse-relay.json'].content, beforeCollision);assert.equal(files['muse-relay-output-file-collision.base64'].content, 'unrelated');
});

test('Gist watcher preserves handler result across ambiguous publish, without leaking token to raw files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-gist-'));
  const stateFile = join(dir, 'state.json');
  let calls = 0;
  let handlerCalls = 0;
  let revision = 1;
  let losePatchResponse = true;
  const avatar = { mime: 'image/png', name: 'avatar.png', data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' };
  const request = { protocol: 'muse-relay/1', id: 'request_1', kind: 'chat', text: '', created_at: 1794880000, audio_file: 'muse-relay-audio-request_1.base64', audio_mime: 'audio/wav', audio_name: 'voice.wav' };
  const files = {
    'g2muse-relay.json': { content: '{"messages":[]}' },
    'muse-relay-request-request_1.json': { content: JSON.stringify(request) },
    [request.audio_file]: { truncated: true, raw_url: 'https://gist.githubusercontent.com/example/raw/audio', content: 'truncated' },
  };
  const fetchImpl = async (url, options) => {
    calls++;
    if (String(url).startsWith('https://gist.githubusercontent.com/')) {
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, 'error');
      return new Response(Buffer.from('sample WAV test payload').toString('base64'));
    }
    assert.equal(url, 'https://api.github.com/gists/' + 'a'.repeat(32));
    assert.equal(options.headers.Authorization, 'Bearer test-private-token');
    if (options.method === 'PATCH') {
      for (const [name, value] of Object.entries(JSON.parse(options.body).files)) { if (value === null) delete files[name]; else files[name] = value; }
      revision++;
      if (losePatchResponse) { losePatchResponse = false; throw new Error('Connection lost after server commit'); }
      return Response.json({ files });
    }
    if (options.headers['If-None-Match'] === `"${revision}"`) return new Response(null, { status: 304 });
    return Response.json({ files, truncated: false }, { headers: { etag: `"${revision}"` } });
  };
  const handler = async payload => {
    handlerCalls++;
    if (payload.id === 'clear_profile') return { text: '', profile: {} };
    if(payload.space_action){assert.deepEqual(payload.space_action,{item_id:'today',type:'button'});return {text:'Action done'};}
    assert.equal(payload.audio.mime, 'audio/wav');
    return { text: 'Reply', transcript: 'Question', profile: { name: 'Test avatar', avatar }, spaces: [{ id: 'news', title: 'ニュース', layout:'list', items: [{ id: 'today', title: '今日', text: 'Current cards',control:{type:'button',label:'Refresh'} }] }] };
  };
  try {
    let watcher = await createWatcher({ store: new GistStore({ gistId: 'a'.repeat(32), token: 'test-private-token', fetchImpl }), stateFile, handler });
    await assert.rejects(watcher.tick(), /Connection lost/);
    assert.equal(handlerCalls, 1);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).requests.request_1.status, 'handled');
    watcher = await createWatcher({ store: new GistStore({ gistId: 'a'.repeat(32), token: 'test-private-token', fetchImpl }), stateFile, handler });
    await watcher.tick();
    assert.equal(handlerCalls, 1);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).requests.request_1.status, 'done');
    const messages = JSON.parse(files['g2muse-relay.json'].content).messages;
    assert.deepEqual(messages.map(m => m.text), ['Question', 'Reply']);
    assert.equal(messages[1].reply_to, 'request_1');
    const published=JSON.parse(files['muse-relay-spaces.json'].content).spaces[0];
    assert.equal(published.layout,'list');assert.deepEqual(published.items[0].control,{type:'button',label:'Refresh'});
    assert.equal(files[request.audio_file], undefined);
    const profile = JSON.parse(files['muse-relay-profile.json'].content).profile;
    assert.equal(profile.name, 'Test avatar');
    assert.equal(profile.mime_type, 'image/png');
    assert.equal(profile.avatar, undefined);
    assert.equal(files[profile.avatar_file].content, avatar.data_base64);
    await watcher.tick();
    assert.equal(handlerCalls, 1);
    files['muse-relay-request-action_1.json']={content:JSON.stringify({protocol:'muse-relay/1',id:'action_1',kind:'space',space_id:'news',space_action:{item_id:'today',type:'button'},text:'Refresh',created_at:1794880001})};revision++;
    await watcher.tick();assert.equal(handlerCalls,2);
    assert.deepEqual(JSON.parse(files['muse-relay-profile.json'].content).profile, profile, 'ordinary replies keep the configured profile');
    assert.equal(files[profile.avatar_file].content, avatar.data_base64);
    files['muse-relay-request-clear_profile.json'] = { content: JSON.stringify({ protocol: 'muse-relay/1', id: 'clear_profile', kind: 'chat', text: 'Clear avatar', created_at: 1794880002 }) }; revision++;
    await watcher.tick(); assert.equal(handlerCalls, 3);
    assert.deepEqual(JSON.parse(files['muse-relay-profile.json'].content), { profile: {} });
    assert.equal(files[profile.avatar_file], undefined);
    const badStore = new GistStore({ gistId: 'a'.repeat(32), token: 'test-private-token', fetchImpl });
    badStore.files.bad = { truncated: true, raw_url: 'https://untrusted.example/file' };
    const priorCalls = calls;
    await assert.rejects(badStore.file('bad'), /not permitted/);
    assert.equal(calls, priorCalls);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gist handler receives optional chat location separately from its visible input', async t => {
  const location = { latitude: 0, longitude: -1, captured_at: 10 };
  const raw = { protocol: 'muse-relay/1', id: 'loc', kind: 'chat', created_at: 11, text: 'Where?', location };
  const files = { 'muse-relay-request-loc.json': { content: JSON.stringify(raw) } };
  const { watcher } = await memoryWatcher(t, files, async request => {
    assert.deepEqual(request.location, location);
    return { text: 'Test reply' };
  });
  await watcher.tick();
  const root = JSON.parse(files['g2muse-relay.json'].content);
  assert.equal(root.messages.find(m => m.from === 'You').text, raw.text);
  assert.doesNotMatch(JSON.stringify(root), /latitude/);
});
