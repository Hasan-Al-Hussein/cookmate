import assert from 'node:assert/strict';
import test from 'node:test';
import { ordinaryContentStartup } from './ordinaryContentStartup';

const origin = 'http://127.0.0.1:18081';
const configured = JSON.stringify({
  version: 1,
  origin,
  installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  releaseId: 'local-review',
  trustKeys: [
    {
      keyId: 'development-only',
      publicKeyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    },
  ],
});
test('absent configuration alone retains legacy startup', () => {
  for (const input of [undefined, null, ''])
    assert.deepEqual(ordinaryContentStartup(input, 'web', origin), { kind: 'legacy' });
});
test('operator configuration selects exact immutable origin and installation', () => {
  const state = ordinaryContentStartup(configured, 'web', origin);
  assert.equal(state.kind, 'content');
  if (state.kind !== 'content') throw new Error('No configured content startup');
  assert.equal(state.config.installationId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(state.config.origin, origin);
  assert.equal(Object.isFrozen(state.config), true);
});
test('invalid selected configuration cannot fall through to guest, including nonweb and origin mismatch', () => {
  for (const input of [' ', '{}', 'null', false, 0, [], configured.replace('4aaa', '1aaa')])
    assert.deepEqual(ordinaryContentStartup(input, 'web', origin), { kind: 'unavailable' });
  assert.deepEqual(ordinaryContentStartup(configured, 'ios', origin), { kind: 'unavailable' });
  assert.deepEqual(ordinaryContentStartup(configured, 'web', 'http://localhost:8081'), {
    kind: 'unavailable',
  });
});
