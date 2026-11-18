import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { collectPublicAssets } from './build.mjs';
import { createGuide } from './worker.mjs';
import { createLocalDb } from './local-db.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or newer for the local guide.');
const port = Number(process.env.GUIDE_PORT || 5188);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GUIDE_PORT must be between 1 and 65535.');
const DB = createLocalDb();
const env = { DB, FEEDBACK_RATE_SECRET: randomBytes(32).toString('base64url') };
// Fail on a broken/missing public asset before announcing a working preview.
await collectPublicAssets();
const server = createServer(async (incoming, outgoing) => {
  try {
    const host = incoming.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) {
      outgoing.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); outgoing.end('Invalid host'); return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    // Local requests share the loopback rate bucket. Ignore client-supplied edge headers.
    headers.set('cf-connecting-ip', incoming.socket.remoteAddress || '127.0.0.1');
    const abort = new AbortController();
    incoming.on('aborted', () => abort.abort());
    const method = incoming.method || 'GET';
    const request = new Request(new URL(incoming.url || '/', `http://${host}`), {
      method, headers, signal: abort.signal,
      ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
    });
    const result = await createGuide(await collectPublicAssets()).fetch(request, env);
    outgoing.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) await new Promise((resolve, reject) => {
      const stream = Readable.fromWeb(result.body);
      stream.on('error', reject); outgoing.on('error', reject); outgoing.on('finish', resolve); stream.pipe(outgoing);
    });
    else outgoing.end();
  } catch {
    // Never print request input or database exceptions in the development console.
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    outgoing.end('Local preview unavailable');
  }
});
server.requestTimeout = 30_000; server.headersTimeout = 15_000;
server.once('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Guide port is in use; choose GUIDE_PORT.' : 'Guide preview could not start.'); DB.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}\nFeedback uses a temporary in-memory database; stopping clears it.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { DB.close(); process.exit(0); }));
