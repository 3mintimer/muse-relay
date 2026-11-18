import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GistStore, createWatcher } from './watcher.mjs';

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
