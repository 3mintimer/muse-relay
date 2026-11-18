import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleFeedback } from './feedback.mjs';
import { createLocalDb } from './local-db.mjs';

test('private feedback validates consent, survives fresh handlers, limits concurrent submissions and cleans old rows', async () => {
  const DB = createLocalDb();
  const env = { DB, FEEDBACK_RATE_SECRET: 'test-only-secret-'.repeat(3) };
  const origin = 'https://guide.example';
  const payload = { kind: 'idea', message: 'This is an artificial feedback test.', website: '' };
  const submit = (body = payload, headers = {}, method = 'POST') => handleFeedback(new Request(`${origin}/api/feedback`, {
    method, headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const count = () => Number(DB.sqlite.prepare('SELECT count(*) AS count FROM feedback_receipts').get().count);
  try {
    assert.equal((await submit(payload, {}, 'GET')).status, 405, 'there is no anonymous receipt reader');
    assert.equal((await submit(payload, { origin: 'https://other.example' })).status, 403);
    assert.equal((await submit(payload, { origin: '' })).status, 403);
    assert.equal((await submit(payload, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await submit({ ...payload, message: 'short' })).status, 422);
    assert.equal((await submit({ ...payload, message: '😀'.repeat(4001) })).status, 422);
    assert.equal((await submit({ ...payload, share: 'yes' })).status, 422);
    assert.equal((await submit({ ...payload, message: 'x'.repeat(17000) })).status, 413);
    const honeypot = await submit({ ...payload, website: 'https://bot.example' });
    assert.equal(honeypot.status, 201); assert.ok((await honeypot.json()).receipt);
    assert.equal(count(), 0);
    const receiptResponse = await submit();
    assert.equal(receiptResponse.status, 201);
    const { receipt } = await receiptResponse.json();
    assert.match(receipt, /^[0-9a-f-]{36}$/);
    const first = DB.sqlite.prepare('SELECT * FROM feedback_receipts WHERE receipt = ?').get(receipt);
    assert.equal(first.message, payload.message);
    assert.equal(first.share, 0, 'sharing is off unless explicitly true');
    const consented = await submit({ ...payload, kind: 'problem', share: true, message: '😀'.repeat(4000) }, { 'cf-connecting-ip': '192.0.2.2' });
    assert.equal(consented.status, 201, 'the text limit counts Unicode code points');
    const sharedReceipt = (await consented.json()).receipt;
    assert.equal(DB.sqlite.prepare('SELECT share FROM feedback_receipts WHERE receipt = ?').get(sharedReceipt).share, 1);
    assert.throws(() => DB.sqlite.prepare('UPDATE feedback_receipts SET issue_url = ? WHERE receipt = ?').run('https://github.com/3mintimer/muse-relay/issues/1', receipt), /CHECK/);
    const concurrent = await Promise.all(Array.from({ length: 7 }, () => submit()));
    assert.equal(concurrent.filter(response => response.status === 201).length, 2);
    assert.equal(concurrent.filter(response => response.status === 429).length, 5);
    assert.ok(Number(concurrent.find(response => response.status === 429).headers.get('retry-after')) > 0);
    assert.equal(count(), 4);
    const limits = DB.sqlite.prepare('SELECT * FROM feedback_limits').all();
    assert.ok(!JSON.stringify(limits).includes('192.0.2.'), 'raw addresses are not stored');
    assert.ok(!JSON.stringify(limits).includes(env.FEEDBACK_RATE_SECRET));
    const now = Math.floor(Date.now() / 1000);
    DB.sqlite.prepare("INSERT INTO feedback_receipts (receipt, kind, message, share, created_at) VALUES ('expired', 'question', 'Old artificial test message', 0, ?)").run(now - 91 * 86400);
    DB.sqlite.prepare("INSERT INTO feedback_limits VALUES ('expired-counter', 1, ?)").run(now - 1);
    assert.equal((await submit(payload, { 'cf-connecting-ip': '192.0.2.3' })).status, 201);
    assert.equal(DB.sqlite.prepare("SELECT receipt FROM feedback_receipts WHERE receipt = 'expired'").get(), undefined);
    assert.equal(DB.sqlite.prepare("SELECT bucket FROM feedback_limits WHERE bucket = 'expired-counter'").get(), undefined);
    const day = Math.floor(now / 86400);
    DB.sqlite.prepare('UPDATE feedback_limits SET count = 100 WHERE bucket = ?').run(`total:${day}`);
    assert.equal((await submit(payload, { 'cf-connecting-ip': '192.0.2.4' })).status, 429, 'global daily cap applies across addresses');
    // Maintainer deletion uses the receipt and needs no public read/delete endpoint.
    DB.sqlite.prepare('DELETE FROM feedback_receipts WHERE receipt = ?').run(receipt);
    assert.equal(DB.sqlite.prepare('SELECT receipt FROM feedback_receipts WHERE receipt = ?').get(receipt), undefined);
  } finally { DB.close(); }
});
