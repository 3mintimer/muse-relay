import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../server/app.mjs';
import { isOriginAllowed,emptyState,createMachine,validateSpaces,validateRequest,buildMuseRequest } from '../server/core.mjs';

const config = { relayToken: 'p'.repeat(40), deviceToken: 'd'.repeat(40), museToken: 'm'.repeat(40), allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:*'], sonioxApiKey: 'server-only-test-key' };
test('space actions survive the SDK boundary, validate exported controls and remain idempotent',()=>{
  const machine=createMachine(emptyState());
  const spaces=validateSpaces({spaces:[{id:'daily',title:'Today',layout:'list',items:[{id:'focus',title:'Focus',text:'',control:{type:'slider',min:5,max:60,step:5,value:25}}]}]});
  machine.setSpaces(spaces);
  const raw={id:'action',kind:'space',space_id:'daily',space_action:{item_id:'focus',type:'slider',value:30},text:'Focus: 30',created_at:1};
  const request=validateRequest(raw,false);assert.equal(machine.addRequest(request,'hash').duplicate,false);
  assert.match(buildMuseRequest(request).message,/space action.*"item_id":"focus".*"value":30/);
  assert.doesNotMatch(buildMuseRequest(request).message,/read-only export/);
  assert.match(buildMuseRequest({...request,space_action:undefined}).message,/read-only export/);
  machine.setSpaces([]);
  assert.equal(machine.addRequest(validateRequest(raw,false),'hash').duplicate,true,'accepted requests stay idempotent after a space changes');
  assert.throws(()=>machine.addRequest(validateRequest({...raw,id:'new'},false),'newhash'),/space_control_changed/);
  assert.throws(()=>validateRequest({...raw,kind:'chat'},false),/invalid_space_action/);
});
test('authenticated relay keeps delivery distinct from correlated Muse completion and persists spaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-relay-test-'));
  const stateFile = join(directory, 'state.json');
  let clock = Date.now();
  let sonioxRequest;
  let server = await createRelay({ config, stateFile, now: () => clock, fetchImpl: async (_url, options) => { sonioxRequest = options; return Response.json({ api_key: 'snx_temp_test', expires_at: '2026-11-17T00:00:00Z' }); } });
  const listen = async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
  let base = await listen();
  const call = async (path, token = config.relayToken, body, method, headers = {}) => {
    const response = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  let sequence = 0, sessionId;
  const event = (job, type, fields) => call('/device/events', config.deviceToken, { job_id: job, session_id: sessionId, event_id: `evt_${++sequence}`, type, ...fields });
  try {
    assert.equal((await call('/v1/snapshot', 'wrong')).status, 401);
    const configuredSnapshot = (await call('/v1/snapshot')).body;
    assert.equal(configuredSnapshot.capabilities.soniox, true);
    assert.ok(!JSON.stringify(configuredSnapshot).includes(config.sonioxApiKey));
    const blocked = await fetch(base + '/v1/snapshot', { headers: { origin: 'https://untrusted.example', authorization: `Bearer ${config.relayToken}` } });
    assert.equal(blocked.status, 403);
    for (const origin of ['http://127.0.0.1:54848', 'http://127.0.0.1:54914']) {
      const preflight = await fetch(base + '/v1/snapshot', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      const snapshot = await call('/v1/snapshot', config.relayToken, undefined, 'GET', { origin });
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.headers.get('access-control-allow-origin'), origin);
    }
    assert.equal((await call('/v1/snapshot', 'wrong', undefined, 'GET', { origin: 'http://127.0.0.1:54914' })).status, 401);
    assert.equal((await call('/device/jobs', config.relayToken, undefined, 'GET', { origin: 'http://127.0.0.1:54914' })).status, 401);
    assert.equal((await call('/v1/snapshot', config.relayToken, undefined, 'GET', { origin: 'http://127.0.0.1.example:54914' })).status, 403);
    assert.equal(isOriginAllowed('http://127.0.0.1:54914', ['http://localhost:5173']), false);
    for (const origin of ['https://127.0.0.1:54914', 'http://user@127.0.0.1:54914', 'http://127.0.0.1:54914/', 'http://127.0.0.1:54914?q=1', 'http://127.0.0.1:54914#x', 'http://127.1:54914', 'http://127.0.0.1:65536', 'http://127.0.0.1:054914', 'http://127.0.0.1:*']) {
      assert.equal(isOriginAllowed(origin, ['http://127.0.0.1:*']), false, origin);
    }
    const request = { id: 'turn_1', kind: 'chat', text: 'hello', created_at: Math.floor(clock / 1000) };
    assert.equal((await call('/v1/requests', config.relayToken, request)).body.status, 'queued');
    assert.equal((await call('/v1/requests', config.relayToken, request)).body.duplicate, true);
    assert.equal((await call('/device/jobs', config.relayToken)).status, 401);
    const leased = (await call('/device/jobs', config.deviceToken)).body.job;
    assert.equal(leased.id, 'turn_1'); sessionId = leased.session_id;
    assert.match(sessionId, /^[A-Za-z0-9-]{1,80}$/);
    assert.equal((await call('/device/jobs', config.deviceToken)).body.job, null);
    const packet = await call('/device/jobs/turn_1/request', config.deviceToken);
    assert.deepEqual(packet.body, { message: 'hello', output_modality: 'text', session_id: sessionId });
    assert.equal(Number(packet.headers.get('content-length')), Buffer.byteLength(JSON.stringify(packet.body)));
    assert.equal(leased.request_bytes, Number(packet.headers.get('content-length')));
    assert.equal((await event('turn_1', 'heartbeat', { session_id: 'wrong-session' })).status, 409);
    await event('turn_1', 'muse_ack', { body: JSON.stringify({ result: { message_id: 'own-note', session_id: sessionId, is_thread: true } }) });
    // An unrelated main-chat reply must not appear on the glasses.
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 9000, event_name: 'message.assistant', payload: { message_id: 'other', reply_to_message_id: 'someone-else', text: 'private unrelated text' } } });
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 9001, event_name: 'message.assistant', payload: { message_id: 'historical', text: 'Old parentless answer' } } });
    assert.equal((await call('/v1/snapshot')).body.messages.length, 1);
    // Message-row sequence is independent of the smaller live delta sequence.
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 9002, event_name: 'message.user', payload: { message_id: 'own-note' } } });
    await event('turn_1', 'muse_event', { body: { type: 'event', seq: 2, event_name: 'delta.message_start', payload: { message_id: 'assistant-1' } } });
    // Split a Japanese character across raw byte frames to exercise buffering.
    const bytes = Buffer.from(JSON.stringify({ type: 'event', seq: 3, event_name: 'delta.text_append', payload: { id: 'assistant-1', text: 'こんにちは' } }) + '\n');
    const split = bytes.indexOf(Buffer.from('こん')) + 1;
    await event('turn_1', 'muse_chunk', { body_base64: bytes.subarray(0, split).toString('base64') });
    const finalChunk = { job_id: 'turn_1', session_id: sessionId, event_id: 'repeatable', type: 'muse_chunk', body_base64: bytes.subarray(split).toString('base64') };
    await call('/device/events', config.deviceToken, finalChunk);
    await event('turn_1', 'muse_event', { body: JSON.parse(bytes.toString()) });
    await call('/device/events', config.deviceToken, finalChunk);
    assert.equal((await call('/v1/snapshot')).body.messages.at(-1).text, 'こんにちは');
    assert.equal((await event('turn_1', 'muse_event', { body: { type: 'event', seq: 4, event_name: 'delta.message_done', payload: { message_id: 'assistant-1' } } })).body.terminal, true);
    const spaces = { spaces: [{ id: 'news', title: 'ニュース', items: [{ id: 'today', title: '今日', text: 'Export created by Muse.' }] }] };
    assert.equal((await call('/v1/spaces', config.relayToken, spaces, 'PUT')).status, 401);
    assert.equal((await call('/v1/spaces', config.museToken, spaces, 'PUT')).status, 200);
    assert.equal((await call('/v1/spaces')).status, 401);
    assert.equal((await call('/v1/spaces/daily', config.relayToken, { id: 'daily' }, 'PUT')).status, 401);
    const daily = { id: 'daily', title: 'Daily', items: [] };
    assert.equal((await call('/v1/spaces/daily', config.museToken, daily, 'PUT')).status, 200);
    const readback = (await call('/v1/spaces', config.museToken)).body;
    assert.deepEqual(readback.spaces.map(({ id }) => id), ['news', 'daily']);
    assert.deepEqual(readback.spaces[0].items, spaces.spaces[0].items);
    assert.equal(readback.messages, undefined, 'Muse can read the export without access to chat');
    // A complete one-pixel PNG; image output is independent of image-input capability.
    const published = { id: 'muse_export_image1', from: 'Muse', type: 'image', ts: Math.floor(clock / 1000), image: { mime: 'image/png', name: 'reply.png', data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' } };
    assert.equal((await call('/v1/messages', config.relayToken, published)).status, 401);
    assert.equal((await call('/v1/messages', config.museToken, published)).body.updated, false);
    assert.equal((await call('/v1/messages', config.museToken, published)).body.updated, true);
    const imageSnapshot = (await call('/v1/snapshot')).body;
    assert.equal(imageSnapshot.capabilities.images, false);
    assert.equal(imageSnapshot.messages.filter(item => item.id === published.id).length, 1);
    const receivedImage = imageSnapshot.messages.find(item => item.id === published.id);
    assert.equal(receivedImage.type, 'image');
    assert.equal(receivedImage.text, '');
    assert.equal(receivedImage.mime_type, 'image/png');
    assert.deepEqual((await call(`/v1/files/${receivedImage.image_file}`)).body, published.image);
    const profile = { name: 'Test avatar', avatar: published.image, updated_at: Math.floor(clock / 1000) };
    for (const token of [config.relayToken, config.deviceToken]) assert.equal((await call('/v1/profile', token, profile, 'PUT')).status, 401);
    assert.equal((await call('/v1/profile', config.museToken, { avatar: { mime: 'image/png', url: 'https://untrusted.example/avatar.png' } }, 'PUT')).status, 400);
    assert.equal((await call('/v1/profile', config.museToken, { avatar: { mime: 'image/png', data_base64: Buffer.alloc(250_001).toString('base64') } }, 'PUT')).status, 413);
    assert.equal((await call('/v1/profile', config.museToken, profile, 'PUT')).status, 200);
    const receivedProfile = (await call('/v1/snapshot')).body.profile;
    assert.equal(receivedProfile.name, profile.name);
    assert.equal(receivedProfile.mime_type, 'image/png');
    assert.equal(receivedProfile.avatar, undefined, 'polling returns avatar metadata without repeating image bytes');
    assert.deepEqual((await call(`/v1/files/${receivedProfile.avatar_file}`)).body, profile.avatar);
    const soniox = await call('/v1/soniox-token', config.relayToken, {});
    assert.equal(soniox.body.api_key, 'snx_temp_test');
    assert.equal(sonioxRequest.headers.authorization, 'Bearer server-only-test-key');
    assert.deepEqual(JSON.parse(sonioxRequest.body), { usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 150 });
    // Once the body was fetched, timeout is ambiguous: never automatically resend it.
    const wav = Buffer.alloc(46);
    wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
    const audio = { mime: 'audio/wav', name: 'voice_note.wav', data_base64: wav.toString('base64') };
    const instructions = 'この音声を日本語で短くまとめてください';
    await call('/v1/requests', config.relayToken, { ...request, id: 'turn_2', text: instructions, audio });
    const audioJob = (await call('/device/jobs', config.deviceToken)).body.job;
    assert.equal(audioJob.session_id, sessionId);
    const audioPacket = await call('/device/jobs/turn_2/request', config.deviceToken);
    // The pinned SDK send_voice schema places instructions before the voice file.
    assert.equal(audioPacket.body.message, instructions);
    assert.deepEqual(audioPacket.body.items, [
      { type: 'text', text: instructions },
      { type: 'file', mime_type: audio.mime, filename: audio.name, data_base64: audio.data_base64 },
    ]);
    assert.equal(audioJob.request_bytes, Buffer.byteLength(JSON.stringify(audioPacket.body)));
    assert.equal(Number(audioPacket.headers.get('content-length')), audioJob.request_bytes);
    clock += 181_000;
    assert.equal((await call('/device/jobs', config.deviceToken)).body.job, null);
    assert.match((await call('/v1/snapshot')).body.messages.at(-1).text, /timed out after delivery/);
    await new Promise(resolve => server.close(resolve));
    server = await createRelay({ config, stateFile, now: () => clock });
    base = await listen();
    const restored = (await call('/v1/snapshot')).body;
    assert.equal(restored.spaces[0].id, 'news');
    assert.deepEqual(restored.profile, receivedProfile, 'profile survives subsequent chat writes and restart');
    assert.deepEqual((await call(`/v1/files/${receivedProfile.avatar_file}`)).body, profile.avatar);
    assert.equal((await call('/v1/profile', config.museToken, {}, 'PUT')).status, 200);
    assert.deepEqual((await call('/v1/snapshot')).body.profile, {});
    assert.equal((await call(`/v1/files/${receivedProfile.avatar_file}`)).status, 404);
    assert.ok(restored.messages.some(message => message.text === 'こんにちは'));
    assert.equal((await call('/v1/requests', config.relayToken, request)).body.duplicate, true);
    await call('/v1/requests', config.relayToken, { ...request, id: 'turn_after_restart' });
    assert.equal((await call('/device/jobs', config.deviceToken)).body.job.session_id, sessionId);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Node diagnostics, recovery and firmware offers persist independently of chat', async t => {
  const { checkMaintenance, testFirmware, adminToken, adminDigest } = await import('./maintenance-contract.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'muse-maint-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  let clock = Date.now(), base, server;
  const start = async () => {
    server = await createRelay({config:{...config,recoveryAdminSha256:adminDigest},
      firmware:testFirmware, stateFile:join(dir,'state.json'), now:()=>clock});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  const call = (path,token,body,headers={}) => fetch(base+path,{method:body?'POST':'GET',
    headers:{...(token?{authorization:'Bearer '+token}:{}),...headers},body:body && JSON.stringify(body)});
  await start();
  t.after(stop);
  const last = await checkMaintenance(call,config,ms=>{clock+=ms});
  await stop();
  await start();
  assert.equal((await (await call('/admin/device-maintenance',adminToken)).json()).command.id,last);
});
