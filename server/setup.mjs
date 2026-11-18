import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from './config.mjs';
import { validateConfig } from './app.mjs';

const host = '127.0.0.1';
const port = Number(process.env.SETUP_PORT || 8788);
const origin = `http://${host}:${port}`;
const csrf = randomBytes(32).toString('base64url');
const configPath = process.env.MUSE_RELAY_CONFIG || DEFAULT_CONFIG;
const token = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
let saved = await loadConfig();
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${host}:${port}` || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: 'origin_not_allowed' });
    const path = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && path === '/') {
      const page = (await readFile(new URL('./setup.html', import.meta.url), 'utf8')).replace('__CSRF__', csrf);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
      return res.end(page);
    }
    if (!equal(req.headers['x-setup-token'], csrf)) return json(res, 403, { error: 'setup_token_required' });
    if (req.method === 'GET' && path === '/config') return json(res, 200, { publicUrl: saved.publicUrl || '', allowedOrigins: saved.allowedOrigins || [], configured: Boolean(saved.relayToken), sonioxConfigured: Boolean(saved.sonioxApiKey), gatewayConfigured: Boolean(saved.gatewayToken) });
    if (req.method === 'POST' && path === '/configure') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16_384) return json(res, 413, { error: 'too_large' }); }
      const value = JSON.parse(body);
      const publicUrl = String(value.publicUrl || '').replace(/\/+$/, '');
      const url = new URL(publicUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return json(res, 400, { error: 'HTTPS のホストURLを入力してください（例: https://relay.example.com）。' });
      const gatewayToken = value.clearGateway ? '' : String(value.gatewayToken || saved.gatewayToken || '');
      if (gatewayToken && !/^[\x21-\x7e]{1,1024}$/.test(gatewayToken)) return json(res, 400, { error: 'ホスティング用接続キーの形式を確認してください。' });
      const evenLocalOrigin = 'http://127.0.0.1:*';
      const allowEvenLocal = typeof value.allowEvenLocal === 'boolean' ? value.allowEvenLocal : saved.allowedOrigins?.includes(evenLocalOrigin);
      const allowedOrigins = String(value.allowedOrigins || '').split(/[\n,]/).map(s => s.trim()).filter(s => s && s !== evenLocalOrigin);
      if (allowEvenLocal) allowedOrigins.push(evenLocalOrigin);
      const config = validateConfig({
        publicUrl,
        gatewayToken,
        allowedOrigins: [...new Set(allowedOrigins)],
        relayToken: saved.relayToken || token(), deviceToken: saved.deviceToken || token(), museToken: saved.museToken || token(),
        sonioxApiKey: value.clearSoniox ? '' : String(value.sonioxApiKey || saved.sonioxApiKey || ''),
        imagesEnabled: false,
      });
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      await writeFile(`${configPath}.tmp`, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      await rename(`${configPath}.tmp`, configPath);
      saved = config;
      return json(res, 200, { ok: true, path: configPath });
    }
    if (req.method === 'GET' && path === '/export') {
      validateConfig(saved);
      return json(res, 200, {
        phone: { relay: 'gadget', relayUrl: saved.publicUrl, relayToken: saved.relayToken, gatewayToken: saved.gatewayToken || '', sonioxTokenUrl: `${saved.publicUrl}/v1/soniox-token`, sonioxTokenAuth: saved.relayToken, sonioxGatewayToken: saved.gatewayToken || '' },
        device: { relay_url: saved.publicUrl, device_token: saved.deviceToken, gateway_token: saved.gatewayToken || '' },
        muse: { messages_url: `${saved.publicUrl}/v1/messages`, spaces_url: `${saved.publicUrl}/v1/spaces`, muse_token: saved.museToken, gateway_token: saved.gatewayToken || '' },
        server: saved,
      });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) { json(res, 400, { error: error.message }); }
}).listen(port, host, () => console.log(`Muse Relay setup: ${origin}`));
