import { authenticateAdmin, maintenanceHeaders, maintenancePage, maintenanceStatus, issueCommand, recordDiagnostics } from './maintenance.mjs';
import { fileMaintenanceStore } from './maintenance-store.mjs';
import { offerFirmware, recordFirmwareStatus } from './firmware.mjs';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MAX_BODY, LEASE_MS, HttpError, fail, equal, validateConfig, validateRequest, isOriginAllowed,
  validatePublishedMessage, validateProfile, spaceExportRoute, validateSpaceWrite, exportSpaces, prepareMuseRequest, buildMuseRequest, fingerprint,
  emptyState, validateState, createMachine, byteLength,
} from './core.mjs';
export { validateConfig, buildMuseRequest } from './core.mjs';

async function readJson(req, limit = MAX_BODY) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > limit) fail(413, 'request_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
}
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

/** Single-process Node adapter. Cloudflare uses the same transitions with D1 CAS storage. */
export async function createRelay(options) {
  const config = validateConfig(options.config);
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || fetch;
  const maintenance = fileMaintenanceStore(options.stateFile);
  const firmware = options.firmware;
  let state = emptyState();
  if (options.stateFile) {
    try { state = validateState(JSON.parse(await readFile(options.stateFile, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Relay state could not be loaded; restore a valid state file before starting.'); }
  }
  const machine = createMachine(state, { now });
  let transaction = Promise.resolve();
  function atomic(work) { const task = transaction.then(work); transaction = task.catch(() => {}); return task; }
  async function persist() {
    machine.serialize();
    if (!options.stateFile) return;
    await mkdir(dirname(options.stateFile), { recursive: true, mode: 0o700 });
    await writeFile(`${options.stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${options.stateFile}.tmp`, options.stateFile);
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://relay.local').pathname;
      const origin = req.headers.origin;
      if (origin) {
        const adminOrigin = config.publicUrl ? new URL(config.publicUrl).origin : 'http://' + req.headers.host;
        if (path === '/admin/device-maintenance' ? origin !== adminOrigin : !isOriginAllowed(origin, config.allowedOrigins)) fail(403, 'origin_not_allowed');
        res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,OAI-Sites-Authorization', 'access-control-max-age': '600' }); return res.end(); }
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, service: 'muse-relay', version: 1 });
      if (path === '/maintenance' && req.method === 'GET') {
        res.writeHead(200, maintenanceHeaders);
        return res.end(maintenancePage(req.headers['accept-language']));
      }
      if (path === '/admin/device-maintenance') {
        await authenticateAdmin(req.headers.authorization, config);
        if (req.method === 'GET') return send(res, 200, await atomic(() => maintenanceStatus(maintenance)));
        if (req.method !== 'POST') fail(405, 'method_not_allowed');
        const intent = await readJson(req, 1024);
        return send(res, 202, await atomic(() => issueCommand(maintenance, intent, now())));
      }
      const spaces = spaceExportRoute(req.method, path);
      const muse = spaces || (path === '/v1/profile' && req.method === 'PUT') || (path === '/v1/messages' && req.method === 'POST');
      const token = path.startsWith('/device/') ? config.deviceToken : muse ? config.museToken : config.relayToken;
      if (!equal(req.headers.authorization, `Bearer ${token}`)) fail(401, 'unauthorized');
      if (path === '/device/diagnostics') {
        if (req.method !== 'POST') fail(405, 'method_not_allowed');
        const data = await readJson(req, 4096);
        return send(res, 200, await atomic(() => recordDiagnostics(maintenance, data, now())));
      }
      if (firmware && req.method === 'GET' && path === '/device/firmware/' + firmware.manifest.sha256) {
        const data = Buffer.from(firmware.base64, 'base64');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store' });
        return res.end(data);
      }
      if (path === '/device/firmware/status') {
        if (req.method === 'GET') return send(res, 200, (await maintenance.get('firmware')).value);
        if (req.method !== 'POST') fail(405, 'method_not_allowed');
        const data = await readJson(req, 1024);
        return send(res, 200, await atomic(() => recordFirmwareStatus(maintenance, data, now())));
      }
      if (spaces?.kind === 'read') return send(res, 200, await atomic(() => exportSpaces(state.spaces)));
      if (req.method === 'POST' && path === '/v1/soniox-token') {
        if (!config.sonioxApiKey) fail(503, 'soniox_not_configured');
        await atomic(async () => { machine.useSoniox(); await persist(); });
        const upstream = await fetchImpl('https://api.soniox.com/v1/auth/temporary-api-key', { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${config.sonioxApiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 150 }), signal: AbortSignal.timeout(10_000) });
        if (!upstream.ok) fail(502, `soniox_upstream_${upstream.status}`);
        const data = await upstream.json(); if (typeof data.api_key !== 'string') fail(502, 'soniox_invalid_response');
        return send(res, 200, { api_key: data.api_key, expires_at: data.expires_at });
      }
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : undefined;
      const result = await atomic(async () => {
        machine.sweep();
        if (path.startsWith('/device/')) state.deviceSeen = now();
        let reply;
        if (req.method === 'GET' && path === '/v1/snapshot') {
          const snapshot = machine.snapshot(config.imagesEnabled, Boolean(config.sonioxApiKey));
          // The phone fetches changed avatar bytes separately, only when images are enabled.
          if (snapshot.profile) snapshot.profile = { ...snapshot.profile, avatar: undefined };
          reply = [200, snapshot];
        }
        else if (req.method === 'POST' && path === '/v1/requests') {
          const value = validateRequest(body, config.imagesEnabled);
          reply = [202, machine.addRequest(prepareMuseRequest(value), await fingerprint(value))];
        } else if (req.method === 'GET' && path.startsWith('/v1/files/')) {
          const name = decodeURIComponent(path.slice('/v1/files/'.length)); if (!Object.hasOwn(state.files, name)) fail(404, 'file_not_found'); reply = [200, state.files[name]];
        } else if (req.method === 'POST' && path === '/v1/messages') reply = [200, machine.publishMessage(validatePublishedMessage(body))];
        else if (spaces) {
          const updated = validateSpaceWrite(spaces, body);
          reply = [200, spaces.kind === 'upsert' ? machine.upsertSpace(updated[0]) : machine.setSpaces(updated)];
        }
        else if (req.method === 'PUT' && path === '/v1/profile') {
          const profile = validateProfile(body);
          if (profile.avatar) profile.avatar_file = `profile_avatar_${await fingerprint(profile.avatar)}.base64`;
          reply = [200, machine.setProfile(profile)];
        }
        else if (req.method === 'GET' && path === '/device/jobs') {
          const job = machine.leaseNext();
          const result = job ? { job: { id: job.request.id, kind: job.request.kind, created_at: job.request.created_at, session_id: job.request.session_id, request_bytes: job.requestBytes, lease_seconds: LEASE_MS / 1000 } }
            : { job: null, ...offerFirmware(firmware, req.headers['x-muse-target'], req.headers['x-muse-version']) };
          reply = [200, result];
        } else if (req.method === 'GET' && /^\/device\/jobs\/[A-Za-z0-9_-]+\/request$/.test(path)) reply = [200, buildMuseRequest(machine.takeRequest(path.split('/')[3]))];
        else if (req.method === 'POST' && path === '/device/events') reply = [200, machine.handleDeviceEvent(body)];
        else fail(404, 'not_found');
        await persist(); return reply;
      });
      send(res, ...result);
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'relay_error' }); else res.destroy();
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return server;
}
