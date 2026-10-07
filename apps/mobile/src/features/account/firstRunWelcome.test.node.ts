import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFirstRunWelcome } from './firstRunWelcome';

test('welcome requires both absent prior evidence and a positively created guest database', async () => {
  for (const prior of [true, false])
    for (const initialization of ['created', 'existing', undefined] as const) {
      const welcome = await createFirstRunWelcome({
        hasPriorEvidence: async () => prior,
        saveDecision: async () => undefined,
      });
      assert.equal(welcome.getSnapshot(), false);
      welcome.observeGuestStore(initialization);
      assert.equal(welcome.getSnapshot(), !prior && initialization === 'created');
    }
});
test('unreadable prior evidence conservatively skips welcome', async () => {
  const welcome = await createFirstRunWelcome({
    hasPriorEvidence: async () => {
      throw new Error();
    },
    saveDecision: async () => undefined,
  });
  welcome.observeGuestStore('created');
  assert.equal(welcome.getSnapshot(), false);
});
test('guest dismissal is immediate even while persistence is pending', async () => {
  let release!: () => void;
  let writes = 0;
  const welcome = await createFirstRunWelcome({
    hasPriorEvidence: async () => false,
    saveDecision: () => {
      writes++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  welcome.observeGuestStore('created');
  let updates = 0;
  const unsubscribe = welcome.subscribe(() => {
    updates++;
  });
  const saved = welcome.dismiss();
  assert.equal(welcome.getSnapshot(), false);
  assert.equal(updates, 1);
  welcome.observeGuestStore('created');
  await welcome.dismiss();
  assert.equal(writes, 1);
  release();
  await saved;
  unsubscribe();
});
test('failure to persist the welcome choice never blocks cooking or reopens it in the same lifetime', async () => {
  const welcome = await createFirstRunWelcome({
    hasPriorEvidence: async () => false,
    saveDecision: async () => {
      throw new Error();
    },
  });
  welcome.observeGuestStore('created');
  await welcome.dismiss();
  welcome.observeGuestStore('created');
  assert.equal(welcome.getSnapshot(), false);
});
test('a returning or uncertain first open cannot be reclassified as fresh by a later open', async () => {
  for (const first of ['existing', undefined] as const) {
    const welcome = await createFirstRunWelcome({
      hasPriorEvidence: async () => false,
      saveDecision: async () => undefined,
    });
    welcome.observeGuestStore(first);
    welcome.observeGuestStore('created');
    assert.equal(welcome.getSnapshot(), false);
  }
});
