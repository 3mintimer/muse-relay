// The operator selects a local, already verified application from the board ZIP.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function loadFirmware(env = process.env) {
  const path = env.FIRMWARE_IMAGE;
  if (!path) return null;
  if ((await stat(path)).size > 2 * 1024 * 1024) throw Error('Firmware exceeds the OTA slot');
  const image = await readFile(path);
  const version = image.subarray(48, 80).toString('ascii').replace(/\0+$/, '');
  const targets = ['atoms3', 'atoms3-lite'].map(board => 'muse-relay/' + board + '/8m-ab-v1')
    .filter(target => image.includes(Buffer.from(target + '\0')));
  const sha256 = createHash('sha256').update(image).digest('hex');
  const generation = Number(env.FIRMWARE_GENERATION ?? '1');
  if (image.length < 8192 || image.length > 2097152 || image.length % 4096 !== 0 ||
      image[0] !== 0xe9 || image.readUInt32LE(32) !== 0xabcd5432 || image.at(-4096) !== 0xe7 ||
      image.subarray(80, 112).toString('ascii').replace(/\0+$/, '') !== 'muse-relay' ||
      !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) || targets.length !== 1 ||
      sha256 !== env.FIRMWARE_SHA256 || !Number.isInteger(generation) || generation < 1 || generation > 2147483647)
    throw Error('Check firmware image, SHA-256, board marker, version and generation');
  return { manifest: { target: targets[0], version, size: image.length, sha256, generation },
    offer: env.FIRMWARE_OFFER === 'true', base64: image.toString('base64') };
}
