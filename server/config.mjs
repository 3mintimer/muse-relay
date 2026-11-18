import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG = resolve('.local/relay-config.json');
export async function loadConfig() {
  const path = process.env.MUSE_RELAY_CONFIG || DEFAULT_CONFIG;
  let saved = {};
  try { saved = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read relay configuration.'); }
  return {
    ...saved,
    relayToken: process.env.RELAY_TOKEN || saved.relayToken,
    deviceToken: process.env.DEVICE_TOKEN || saved.deviceToken,
    museToken: process.env.MUSE_TOKEN || saved.museToken,
    sonioxApiKey: process.env.SONIOX_API_KEY || saved.sonioxApiKey,
    allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : saved.allowedOrigins || [],
    publicUrl: process.env.PUBLIC_URL || saved.publicUrl,
    imagesEnabled: process.env.GADGET_IMAGES_ENABLED === 'true' || saved.imagesEnabled === true,
  };
}
