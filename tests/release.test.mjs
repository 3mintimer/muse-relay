import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseTarget } from '../scripts/record-release.mjs';

test('only the requested live Even Hub channel can produce its distinct GitHub tag', () => {
  const version = '1.2.3';
  const row = { version, id: 8, status: 'Private', channels: ['beta'] };
  const list = { package_id: 'com.threemintimer.muserelay', versions: [row] };
  assert.deepEqual(releaseTarget(list, version, 'beta'), { id: 8, pre: true, tag: 'v1.2.3-beta.1' });
  assert.throws(() => releaseTarget(list, version, 'public'));
  row.channels = ['public'];
  row.status = 'Approved';
  assert.throws(() => releaseTarget(list, version, 'public'));
  row.status = 'Published';
  assert.deepEqual(releaseTarget(list, version, 'public'), { id: 8, pre: false, tag: 'v1.2.3' });
  assert.throws(() => releaseTarget(list, version, 'beta'));
  assert.throws(() => releaseTarget({ ...list, package_id: 'example.app' }, version, 'public'));
});
