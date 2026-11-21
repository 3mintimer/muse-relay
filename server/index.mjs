import { resolve } from 'node:path';
import { createRelay } from './app.mjs';
import { loadFirmware } from './load-firmware.mjs';
import { loadConfig } from './config.mjs';

try {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const config = await loadConfig();
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !config.publicUrl?.startsWith('https://')) throw new Error('Set PUBLIC_URL to your HTTPS reverse proxy URL before listening outside loopback.');
  const server = await createRelay({ config, firmware: await loadFirmware(), stateFile: resolve(process.env.RELAY_STATE_FILE || '.local/relay-state.json') });
  server.listen(port, host, () => console.log(`Muse Relay listening on ${host}:${port}. No message bodies or credentials are logged.`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
