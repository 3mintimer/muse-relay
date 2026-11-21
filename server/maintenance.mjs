import { equal, fail } from './core.mjs';
import { maintenancePage } from './maintenance-page.mjs';

export const maintenanceHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
export { maintenancePage };

const reportFields = new Set(['fw', 'boot', 'uptime', 'wifi', 'muse', 'phase', 'poll', 'transport', 'tls', 'poll_age', 'command', 'action', 'command_boot', 'history']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const uint32 = n => integer(n, 0, 0xffffffff);
const int32 = n => integer(n, -2147483648, 2147483647);
const event = row => Array.isArray(row) && row.length === 4 && uint32(row[0]) && uint32(row[1]) &&
  integer(row[2], 1, 16) && int32(row[3]);

export async function authenticateAdmin(authorization, config) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization || '');
  const expected = config.recoveryAdminSha256;
  if (!bearer || !/^[0-9a-f]{64}$/.test(expected || '') ||
      [config.deviceToken, config.relayToken, config.museToken].some(token => equal(token, bearer[1]))) fail(401, 'unauthorized');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer[1]));
  const hex = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
  if (!equal(expected, hex)) fail(401, 'unauthorized');
}

export async function recordDiagnostics(store, data, now) {
  if (!data || typeof data !== 'object' || Object.keys(data).some(key => !reportFields.has(key)) ||
      typeof data.fw !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(data.fw) ||
      ![data.boot, data.uptime, data.command_boot].every(uint32) ||
      ![data.wifi, data.muse].every(n => integer(n, 0, 1)) || !integer(data.phase, 0, 4) ||
      !integer(data.poll, -3, 599) || ![data.transport, data.tls].every(int32) ||
      !integer(data.poll_age, -1, 2147483647) || !(data.command === '' || uuid(data.command)) ||
      !integer(data.action, 0, 2) || !Array.isArray(data.history) || data.history.length > 12 ||
      !data.history.every(event)) fail(400, 'invalid_diagnostics');
  await store.put('report', { ...data, seen: now });
  const { value: command } = await store.get('command');
  if (!command || command.id === data.command || command.expires <= now) return {};
  return { id: command.id, action: command.action, ttl: Math.floor((command.expires - now) / 1000) };
}

export async function maintenanceStatus(store) {
  const [report, command] = await Promise.all([store.get('report'), store.get('command')]);
  return { report: report.value, command: command.value };
}

export async function issueCommand(store, intent, now) {
  const { id, action, previous } = intent || {};
  if (!uuid(id) || !(previous === null || uuid(previous))) fail(400, 'invalid_command');
  if (action !== 'reconnect' && action !== 'reboot') fail(400, 'invalid_action');
  const current = await store.get('command');
  const prior = current.value;
  if (prior?.id === id) {
    if (prior.action !== action) fail(409, 'command_changed');
    return prior;
  }
  if ((prior?.id ?? null) !== previous) fail(409, 'command_changed');
  if (prior && prior.expires > now) {
    const report = await store.get('report');
    if (report.value?.command !== prior.id) fail(409, 'command_pending');
  }
  const command = { id, action, issued: now, expires: now + 300000 };
  await store.put('command', command, current);
  return command;
}
