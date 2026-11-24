import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPackageDigests, releaseTarget } from '../scripts/record-release.mjs';

test('only the requested live Even Hub channel can produce its distinct GitHub tag', async () => {
  const version = '1.2.3';
  const row = { version, id: 8, status: 'Private', channels: ['beta'] };
  const list = { ok: true, package_id: 'com.threemintimer.muserelay', versions: [row] };
  assert.deepEqual(await releaseTarget(list, version, 'beta'), { id: 8, pre: true, tag: 'v1.2.3-beta.1' });
  await assert.rejects(releaseTarget(list, version, 'public'));
  row.channels = ['public'];
  row.status = 'Approved';
  await assert.rejects(releaseTarget(list, version, 'public'));
  row.status = 'Published';
  assert.deepEqual(await releaseTarget(list, version, 'public'), { id: 8, pre: false, tag: 'v1.2.3' });
  await assert.rejects(releaseTarget(list, version, 'beta'));
  await assert.rejects(releaseTarget({ ...list, package_id: 'example.app' }, version, 'public'));
});

test('an Approved build needs an independently matching public catalogue entry', async () => {
  const row = { version: '1.2.3', id: 8, size: 123, created_at: '2026-11-24T00:00:00Z', status: 'Approved', channels: ['public'] };
  const list = { ok: true, package_id: 'com.threemintimer.muserelay', versions: [row] };
  const publicVersion = { version: row.version, file_size: row.size, created_at: row.created_at, branch_name: 'public' };
  const confirm = (version, packageId = list.package_id) => releaseTarget(list, row.version, 'public', async url => {
    assert.equal(url.searchParams.get('package_id'), list.package_id);
    return Response.json({ code: 0, data: { package_id: packageId, version } });
  });
  assert.equal((await confirm(publicVersion)).id, row.id);
  await assert.rejects(confirm(publicVersion, 'other.app'));
  for (const mismatch of [{ version: '1.2.2' }, { branch_name: 'beta' }, { file_size: 122 }, { created_at: '' }]) {
    await assert.rejects(confirm({ ...publicVersion, ...mismatch }));
  }
  await assert.rejects(releaseTarget(list, row.version, 'public', async () => new Response(null, { status: 503 })));
});

test('a repackaged store binary needs both exact reviewed digests for this build and commit', () => {
  const pair = { channel: 'public', version: '1.2.3', id: 8, commit: 'a'.repeat(40), ciDigest: 'b'.repeat(64), storeDigest: 'c'.repeat(64) };
  const receipt = { packageId: 'com.threemintimer.muserelay', version: pair.version, buildId: pair.id,
    sourceCommit: pair.commit, ciSha256: pair.ciDigest, storeSha256: pair.storeDigest };
  checkPackageDigests(pair, receipt);
  checkPackageDigests({ ...pair, storeDigest: pair.ciDigest });
  assert.throws(() => checkPackageDigests(pair));
  for (const mismatch of [{ channel: 'beta' }, { version: '1.2.4' }, { commit: 'd'.repeat(40) }, { id: 9 },
    { ciDigest: 'e'.repeat(64) }, { storeDigest: 'f'.repeat(64) }]) {
    assert.throws(() => checkPackageDigests({ ...pair, ...mismatch }, receipt));
  }
  assert.throws(() => checkPackageDigests(pair, { ...receipt, packageId: 'example.app' }));
});
