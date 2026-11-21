import { fail } from './core.mjs';

const versionPattern = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
export function offerFirmware(release, target, installed) {
  if (!release?.offer || release.manifest.target !== target || !versionPattern.test(installed)) return {};
  const parts = v => v.split('.').reduce((n, x) => n * 10000 + Number(x), 0);
  return parts(release.manifest.version) > parts(installed) ? { firmware: release.manifest } : {};
}

export async function recordFirmwareStatus(store, data, now) {
  const { attempt, version, slot, status } = data || {};
  if (typeof attempt !== 'string' || !/^[a-f0-9]{64}\.[1-9][0-9]{0,9}$/.test(attempt) ||
      typeof version !== 'string' || !versionPattern.test(version) || !['ota_0', 'ota_1'].includes(slot) ||
      !['confirmed', 'verifying', 'previous_running'].includes(status)) fail(400, 'invalid_firmware_status');
  await store.put('firmware', { attempt, version, slot, status, seen: now });
  return { ok: true };
}
