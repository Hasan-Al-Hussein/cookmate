import assert from 'node:assert/strict';
import test from 'node:test';
import { readonlyIds } from '../src/catalogue';

test('readonly IDs do not bind Object mutation helpers or expose the backing Set', () => {
  const ids = readonlyIds(new Set(['53064', '52835']));
  for (const key of [
    'add',
    'delete',
    'clear',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    '__proto__',
    'constructor',
  ]) {
    assert.equal(Reflect.get(ids, key), undefined, key);
    assert.equal(Reflect.has(ids, key), false, key);
  }
  assert.equal(
    Reflect.defineProperty(ids, 'raw', {
      get() {
        return this;
      },
    }),
    false,
  );
  assert.equal(Reflect.set(ids, 'raw', ids), false);
  assert.equal(Reflect.setPrototypeOf(ids, {}), false);
  const defineGetter = Reflect.get(Object.prototype, '__defineGetter__');
  assert.throws(
    () =>
      defineGetter.call(ids, 'raw', function (this: object) {
        return this;
      }),
    TypeError,
  );
  assert.throws(() => Set.prototype.add.call(ids, 'attacker-id'), TypeError);
  assert.equal(Reflect.get(ids, 'raw'), undefined);
  assert.equal(ids.valueOf(), ids);
  ids.forEach((_value, _key, publicIds) => assert.equal(publicIds, ids));
  assert.deepEqual([...ids], ['53064', '52835']);
  assert.equal(ids.has('attacker-id'), false);
});

test('supported ReadonlySet operations preserve iteration and return independent derived sets', () => {
  const ids = readonlyIds(new Set(['one', 'two']));
  assert.equal(ids.size, 2);
  assert.deepEqual(
    [...ids.entries()],
    [
      ['one', 'one'],
      ['two', 'two'],
    ],
  );
  assert.deepEqual([...ids.keys()], ['one', 'two']);
  assert.deepEqual([...ids.values()], ['one', 'two']);
  // Node24 supports these; older native engines may lack them, so no polyfill is installed.
  const union = Reflect.get(ids, 'union') as (other: ReadonlySet<string>) => Set<string>;
  const result = union(new Set(['three']));
  assert.deepEqual([...result], ['one', 'two', 'three']);
  result.add('independent');
  assert.equal(ids.has('independent'), false);
  assert.equal(
    (Reflect.get(ids, 'isDisjointFrom') as (other: ReadonlySet<string>) => boolean)(
      new Set(['three']),
    ),
    true,
  );
});
