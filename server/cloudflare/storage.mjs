import { emptyState, validateState, encodeBase64, decodeBase64, fail, SONIOX_TOKEN_LIMIT, SONIOX_TOKEN_WINDOW_MS } from '../core.mjs';

const CHUNK_BYTES = 128 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 8;

/** The pointer and all chunks switch in one D1 batch transaction. No isolate-local lock. */
export class D1StateStore {
  constructor(db) { this.db = db.withSession ? db.withSession('first-primary') : db; }
  async load() {
    await this.db.prepare("INSERT OR IGNORE INTO relay_head (id, revision) VALUES (1, 'initial')").run();
    const result = await this.db.prepare('SELECT h.revision, c.ordinal, c.data FROM relay_head h LEFT JOIN relay_chunks c ON c.revision = h.revision WHERE h.id = 1 ORDER BY c.ordinal').all();
    const rows = result.results || [];
    if (!rows.length) throw new Error('Relay state pointer is missing');
    const parts = rows.filter(row => row.data !== null).map(row => decodeBase64(row.data));
    if (!parts.length) return { revision: rows[0].revision, state: emptyState() };
    const total = parts.reduce((length, part) => length + part.length, 0);
    if (total > MAX_STATE_BYTES) throw new Error('Relay metadata exceeds limit');
    const bytes = new Uint8Array(total); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return { revision: rows[0].revision, state: validateState(JSON.parse(new TextDecoder().decode(bytes))) };
  }
  async compareAndSwap(previous, state) {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    if (bytes.length > MAX_STATE_BYTES) fail(413, 'relay_metadata_full');
    const revision = crypto.randomUUID();
    const statements = [
      this.db.prepare('UPDATE relay_head SET revision = ? WHERE id = 1 AND revision = ?').bind(revision, previous),
      this.db.prepare('DELETE FROM relay_chunks WHERE EXISTS (SELECT 1 FROM relay_head WHERE id = 1 AND revision = ?)').bind(revision),
    ];
    for (let offset = 0, ordinal = 0; offset < bytes.length; offset += CHUNK_BYTES, ordinal++) {
      statements.push(this.db.prepare('INSERT INTO relay_chunks (revision, ordinal, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM relay_head WHERE id = 1 AND revision = ?)').bind(revision, ordinal, encodeBase64(bytes.subarray(offset, offset + CHUNK_BYTES)), revision));
    }
    const result = await this.db.batch(statements);
    return result[0]?.meta?.changes === 1;
  }
  async update(change) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { revision, state } = await this.load();
      const result = await change(state);
      if (await this.compareAndSwap(revision, state)) return result;
    }
    fail(409, 'relay_busy_retry');
  }
  async reserveSonioxToken(time) {
    const cutoff = time - SONIOX_TOKEN_WINDOW_MS;
    // D1 serializes this update, so concurrent issuers see the same rolling quota.
    const reserve = this.db.prepare(`
      UPDATE relay_soniox_quota
      SET allowed = (SELECT COUNT(*) FROM json_each(calls) WHERE value > ?) < ?,
          calls = (SELECT json_group_array(value) FROM (
            SELECT value FROM json_each(relay_soniox_quota.calls) WHERE value > ?
            UNION ALL
            SELECT ? WHERE (SELECT COUNT(*) FROM json_each(relay_soniox_quota.calls) WHERE value > ?) < ?
          ))
      WHERE id = 1 RETURNING allowed
    `).bind(cutoff, SONIOX_TOKEN_LIMIT, cutoff, time, cutoff, SONIOX_TOKEN_LIMIT);
    let { results: rows } = await reserve.all();
    if (!rows.length) {
      // The first request after an upgrade carries the current window over from the old store.
      const { state } = await this.load();
      const calls = state.sonioxCalls.filter(call => Number.isFinite(call) && call > cutoff);
      await this.db.prepare('INSERT OR IGNORE INTO relay_soniox_quota (id, calls) VALUES (1, ?)').bind(JSON.stringify(calls)).run();
      ({ results: rows } = await reserve.all());
    }
    if (rows[0]?.allowed !== 1) fail(429, 'soniox_token_rate_limit');
  }
}

export class R2Attachments {
  constructor(db, bucket, now = Date.now) { this.db = db; this.bucket = bucket; this.now = now; }
  async put(attachment) {
    const bytes = decodeBase64(attachment.data_base64);
    const key = `attachments/${crypto.randomUUID()}`;
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    // Catalog first: a failed upload is also discoverable by the bounded orphan collector.
    await this.db.prepare('INSERT INTO relay_blobs (object_key, created_at, byte_length) VALUES (?, ?, ?)').bind(key, this.now(), bytes.length).run();
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: attachment.mime }, customMetadata: { sha256 } });
    return { mime: attachment.mime, name: attachment.name, _blob: key, _bytes: bytes.length };
  }
  async get(attachment) {
    if (!attachment?._blob) return attachment;
    const object = await this.bucket.get(attachment._blob);
    if (!object) fail(410, 'attachment_unavailable');
    if (object.size > 1_100_000) fail(413, 'attachment_too_large');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== attachment._bytes) fail(502, 'attachment_incomplete');
    return { mime: attachment.mime, name: attachment.name, data_base64: encodeBase64(bytes) };
  }
  async collect(store, maxDeletes = 20) {
    const { state } = await store.load();
    const used = new Set();
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value._blob === 'string') used.add(value._blob);
      for (const child of Object.values(value)) visit(child);
    };
    visit(state);
    const cutoff = this.now() - 24 * 60 * 60_000;
    // Rotate checked rows so a retained prefix cannot hide later orphan uploads.
    const result = await this.db.prepare('SELECT object_key FROM relay_blobs WHERE created_at < ? ORDER BY checked_at, created_at LIMIT 80').bind(cutoff).all();
    let deleted = 0;
    const checked = [];
    for (const row of result.results || []) {
      if (deleted >= maxDeletes) break;
      if (used.has(row.object_key)) { checked.push(row.object_key); continue; }
      // Opaque keys are never reused. No future write can resurrect this old, unreferenced key.
      await this.bucket.delete(row.object_key);
      await this.db.prepare('DELETE FROM relay_blobs WHERE object_key = ? AND created_at < ?').bind(row.object_key, cutoff).run();
      deleted++;
    }
    if (checked.length) await this.db.prepare(`UPDATE relay_blobs SET checked_at = ? WHERE object_key IN (${checked.map(() => '?').join(',')})`).bind(this.now(), ...checked).run();
    return { ok: true, deleted, scanned: result.results?.length || 0, grace_hours: 24 };
  }
}
