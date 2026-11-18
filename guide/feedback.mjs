// Public submission only. Maintainers read and remove receipts through their private D1 tools.
const MAX_BODY = 16_384;
const MIN_MESSAGE = 10;
const MAX_MESSAGE = 4_000;
const DAY = 86_400;
const HOUR = 3_600;
const KINDS = new Set(['idea', 'problem', 'question']);
const encoder = new TextEncoder();

class FeedbackError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const fail = (status, code) => { throw new FeedbackError(status, code); };
function json(status, body, headers = {}) {
  return Response.json(body, { status, headers: {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
  } });
}
async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'json_required');
  if (Number(request.headers.get('content-length')) > MAX_BODY) fail(413, 'too_large');
  if (!request.body) fail(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); fail(413, 'too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'invalid_json'); }
}
async function dailyActor(request, secret, day) {
  // Only Cloudflare's edge-supplied address is considered; never trust X-Forwarded-For.
  // Missing edge metadata shares a conservative limit instead of bypassing it.
  const candidate = request.headers.get('cf-connecting-ip') || '';
  const address = candidate.length <= 64 && /^[0-9a-fA-F:.]+$/.test(candidate) ? candidate : 'unknown';
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${day}:${address}`));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Required bindings: DB (D1) and FEEDBACK_RATE_SECRET (server-only random 32+ characters). */
export async function handleFeedback(request, env) {
  try {
    const url = new URL(request.url);
    if (url.pathname !== '/api/feedback') return json(404, { error: 'not_found' });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    if ((url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      || request.headers.get('origin') !== url.origin
      || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) fail(403, 'origin_not_allowed');
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'invalid_input');
    if (input.website !== undefined && typeof input.website !== 'string') fail(422, 'invalid_website');
    // Use the same response shape without storing or echoing honeypot content.
    if (input.website?.trim()) return json(201, { receipt: crypto.randomUUID() });
    if (!KINDS.has(input.kind)) fail(422, 'invalid_kind');
    if (typeof input.message !== 'string') fail(422, 'invalid_message');
    const message = input.message.trim().replace(/\r\n?/g, '\n');
    const length = Array.from(message).length;
    if (length < MIN_MESSAGE || length > MAX_MESSAGE || message.includes('\u0000')) fail(422, 'invalid_message');
    if (input.share !== undefined && typeof input.share !== 'boolean') fail(422, 'invalid_share');
    if (!env?.DB || typeof env.FEEDBACK_RATE_SECRET !== 'string' || env.FEEDBACK_RATE_SECRET.length < 32) fail(503, 'unavailable');

    const now = Math.floor(Date.now() / 1000), day = Math.floor(now / DAY), hour = Math.floor(now / HOUR);
    const actor = await dailyActor(request, env.FEEDBACK_RATE_SECRET, day);
    const buckets = [
      { key: `hour:${hour}:${actor}`, limit: 3 },
      { key: `day:${day}:${actor}`, limit: 10 },
      { key: `total:${day}`, limit: 100 },
    ];
    const receipt = crypto.randomUUID(), expires = (day + 2) * DAY;
    const allowed = buckets.map(() => 'COALESCE((SELECT count FROM feedback_limits WHERE bucket = ?), 0) < ?').join(' AND ');
    const insert = env.DB.prepare(`INSERT INTO feedback_receipts (receipt, kind, message, share, created_at)
      SELECT ?, ?, ?, ?, ? WHERE ${allowed}`)
      .bind(receipt, input.kind, message, input.share === true ? 1 : 0, now, ...buckets.flatMap(bucket => [bucket.key, bucket.limit]));
    // The insert and all counters commit together, including under concurrent submissions.
    const statements = [insert, ...buckets.map(bucket => env.DB.prepare(`
      INSERT INTO feedback_limits (bucket, count, expires_at)
      SELECT ?, 1, ? WHERE EXISTS (SELECT 1 FROM feedback_receipts WHERE receipt = ?)
      ON CONFLICT(bucket) DO UPDATE SET count = feedback_limits.count + 1, expires_at = excluded.expires_at`)
      .bind(bucket.key, expires, receipt)),
    env.DB.prepare(`DELETE FROM feedback_limits WHERE bucket IN
      (SELECT bucket FROM feedback_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT 200)`).bind(now),
    env.DB.prepare(`DELETE FROM feedback_receipts WHERE receipt IN
      (SELECT receipt FROM feedback_receipts WHERE created_at < ? ORDER BY created_at LIMIT 100)`).bind(now - 90 * DAY)];
    const result = await env.DB.batch(statements);
    if (Number(result[0]?.meta?.changes) !== 1) {
      // Daily/global limits can last until midnight UTC; return a useful next opportunity.
      const current = await env.DB.prepare('SELECT bucket, count FROM feedback_limits WHERE bucket IN (?, ?, ?)')
        .bind(...buckets.map(bucket => bucket.key)).all();
      const counts = new Map((current.results || []).map(row => [row.bucket, Number(row.count)]));
      const daily = buckets.slice(1).some(bucket => (counts.get(bucket.key) || 0) >= bucket.limit);
      return json(429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, (daily ? (day + 1) * DAY : (hour + 1) * HOUR) - now)) });
    }
    return json(201, { receipt });
  } catch (error) {
    // Do not log the body, address, headers, or exception (D1 errors can include SQL values).
    return json(error instanceof FeedbackError ? error.status : 503, { error: error instanceof FeedbackError ? error.message : 'unavailable' });
  }
}
