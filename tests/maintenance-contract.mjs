import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const adminToken = 'a'.repeat(48);
export const adminDigest = createHash('sha256').update(adminToken).digest('hex');
export const testFirmware = {
  manifest: { target: 'muse-relay/atoms3-lite/8m-ab-v1', version: '0.1.7', size: 3, sha256: 'a'.repeat(64), generation: 1 },
  base64: 'AQID', offer: true,
};

export async function checkMaintenance(call, config, advance) {
  const page = await call('/maintenance');
  assert.match(await page.text(), /device-maintenance/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const admin = '/admin/device-maintenance', diag = '/device/diagnostics';
  const report = { fw:'0.1.7', boot:8, uptime:61, wifi:1, muse:0, phase:0, poll:200,
    transport:0, tls:0, poll_age:10, command:'', action:0, command_boot:0, history:[[8,1,1,3]] };
  for (const token of [config.relayToken, config.deviceToken, config.museToken, undefined]) {
    assert.equal((await call(admin, token)).status, 401);
    assert.equal((await call(admin, token, {action:'reboot'})).status, 401);
  }
  const request = () => ({ id:crypto.randomUUID(), action:'reboot', previous:null });
  assert.equal((await call(admin, adminToken, request(), {origin:'https://other.example'})).status,403);
  assert.equal((await call(diag, adminToken, report)).status,401);
  assert.equal((await call(diag, config.deviceToken, {...report, text:'invalid extra field'})).status,400);
  assert.equal((await call(diag, config.deviceToken, {...report, history:Array(13).fill(report.history[0])})).status,400);
  const concurrent = await Promise.all([request(), request()].map(intent => call(admin, adminToken, intent)));
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[202,409]);
  const command = await concurrent.find(r=>r.status===202).json();
  const retry = {id:command.id,action:'reboot',previous:null};
  assert.deepEqual(await (await call(admin, adminToken, retry)).json(), command);
  const offer = await (await call(diag, config.deviceToken, report)).json();
  assert.deepEqual(offer,{id:command.id,action:'reboot',ttl:300});
  assert.equal((await (await call('/v1/snapshot', config.relayToken)).json()).device.connected,false);
  advance(300001);
  assert.deepEqual(await (await call(diag, config.deviceToken, report)).json(),{});
  const next = await (await call(admin, adminToken, {id:crypto.randomUUID(),previous:command.id,action:'reconnect'})).json();
  assert.equal((await call(admin, adminToken, retry)).status,409);
  assert.deepEqual(await (await call(diag, config.deviceToken, {...report, command:next.id, action:1, command_boot:8})).json(),{});
  const state = await (await call(admin, adminToken)).json();
  assert.equal(state.report.command,next.id);
  assert.equal(state.command.id,next.id);

  const getJobs = (version, target = testFirmware.manifest.target) =>
    call('/device/jobs',config.deviceToken,undefined,{'x-muse-target':target,'x-muse-version':version});
  assert.deepEqual(await (await getJobs('0.1.7')).json(),{job:null});
  assert.deepEqual(await (await getJobs('0.1.8')).json(),{job:null});
  assert.deepEqual(await (await getJobs('0.1.4','muse-relay/atoms3/8m-ab-v1')).json(),{job:null});
  assert.deepEqual((await (await getJobs('0.1.4')).json()).firmware,testFirmware.manifest);
  const binary = '/device/firmware/'+testFirmware.manifest.sha256;
  assert.equal((await call(binary, config.relayToken)).status,401);
  const image = await call(binary,config.deviceToken);
  assert.equal(image.headers.get('content-length'),'3');
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())],[1,2,3]);
  const submission = {id:'test-maintenance-job',kind:'chat',text:'dummy',created_at:100};
  assert.equal((await call('/v1/requests',config.relayToken,submission)).status,202);
  await call(diag,config.deviceToken,report);
  const leased=await (await getJobs('0.1.4')).json();
  assert.equal(leased.job.id,submission.id);
  assert.equal(leased.firmware,undefined);
  const url='/device/firmware/status';
  const ota={attempt:testFirmware.manifest.sha256+'.1',version:'0.1.7',slot:'ota_0',status:'confirmed'};
  assert.equal((await call(url,config.relayToken)).status,401);
  assert.equal((await call(url,config.deviceToken,{...ota,slot:'bad'})).status,400);
  assert.equal((await call(url,config.deviceToken,ota)).status,200);
  const saved=await (await call(url,config.deviceToken)).json();
  assert.deepEqual(saved,{...ota,seen:saved.seen});
  assert.ok(Number.isFinite(saved.seen));
  return next.id;
}
