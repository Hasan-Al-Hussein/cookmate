import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountSnapshotError, mergeAccountSnapshots, validateAccountSnapshot } from '../src';
import type { AccountMergeResult, AccountMergeResolutions, AccountSnapshotV2 } from '../src';
import {
  collection,
  expandedSnapshot,
  history,
  manual,
  membership,
  note,
} from './expandedFixtures';
import { id, later } from './fixtures';

const preferAccount = (
  local: AccountSnapshotV2,
  account: AccountSnapshotV2,
  resolutions?: AccountMergeResolutions,
  historyIncluded = false,
) =>
  mergeAccountSnapshots({
    base: local,
    local,
    account,
    expandedScope: { historyIncluded },
    reviewPersonalRemovals: true,
    ...(resolutions ? { resolutions } : {}),
  });
function merged(result: AccountMergeResult): AccountSnapshotV2 {
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged' || result.snapshot.schemaVersion !== 2)
    throw new Error('Expected expanded result');
  assert.ok(validateAccountSnapshot(result.snapshot));
  return result.snapshot;
}
const deletedNote = () => ({ ...note(), deleted: true, text: null, updatedAt: later });
const deletedManual = () => ({
  ...manual(),
  deleted: true,
  name: null,
  amountText: null,
  unitText: null,
  category: null,
  updatedAt: later,
});

test('account preference requires exact note/manual removal choices in both replica directions', () => {
  for (const localRemoved of [true, false]) {
    const removed = expandedSnapshot(),
      live = expandedSnapshot();
    removed.personal.notes = [deletedNote()];
    removed.personal.manualItems = [deletedManual()];
    live.personal.notes = [note()];
    live.personal.manualItems = [manual()];
    const local = localRemoved ? removed : live,
      account = localRemoved ? live : removed;
    const result = preferAccount(local, account);
    assert.equal(result.status, 'needs_review');
    if (result.status !== 'needs_review') continue;
    assert.deepEqual(
      result.conflicts.map((value) => value.kind),
      ['delete_edit', 'delete_edit'],
    );
    for (const choice of ['local', 'account'] as const) {
      const resolutions = Object.fromEntries(result.conflicts.map((value) => [value.id, choice]));
      const selected = merged(preferAccount(local, account, resolutions));
      assert.deepEqual(
        selected.personal.notes,
        (choice === 'local' ? local : account).personal.notes,
      );
      assert.deepEqual(
        selected.personal.manualItems,
        (choice === 'local' ? local : account).personal.manualItems,
      );
    }
  }
});

test('broad account preference never reuses a removal choice after the live value changes', () => {
  const local = expandedSnapshot(),
    account = expandedSnapshot();
  local.personal.notes = [deletedNote()];
  account.personal.notes = [note()];
  const result = preferAccount(local, account);
  assert.equal(result.status, 'needs_review');
  if (result.status !== 'needs_review') return;
  const resolutions = { [result.conflicts[0]!.id]: 'account' as const };
  account.personal.notes[0]!.text = 'Changed since the separate revival review';
  assert.throws(
    () => preferAccount(local, account, resolutions),
    (error) => error instanceof AccountSnapshotError && error.reason === 'invalid_resolution',
  );
});

test('removed membership on a live parent needs its own exact choice in either direction', () => {
  for (const localRemoved of [true, false]) {
    const local = expandedSnapshot(),
      account = expandedSnapshot();
    local.personal.collections = [collection()];
    account.personal.collections = [collection()];
    local.personal.memberships = [{ ...membership(), present: !localRemoved }];
    account.personal.memberships = [{ ...membership(), present: localRemoved }];
    const result = preferAccount(local, account);
    assert.equal(result.status, 'needs_review');
    if (result.status !== 'needs_review') continue;
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]!.kind, 'delete_edit');
    assert.equal(result.conflicts[0]!.path, `personal/memberships/${id(2)}/52819`);
    for (const choice of ['local', 'account'] as const) {
      const selected = merged(preferAccount(local, account, { [result.conflicts[0]!.id]: choice }));
      assert.deepEqual(
        selected.personal.memberships,
        (choice === 'local' ? local : account).personal.memberships,
      );
    }
  }
});

test('collection removal versus a live subtree is one coherent review in both directions, without child duplicates', () => {
  for (const localRemoved of [true, false]) {
    const removed = expandedSnapshot(),
      live = expandedSnapshot();
    removed.personal.collections = [
      { ...collection(), name: null, deleted: true, updatedAt: later },
    ];
    removed.personal.memberships = [{ ...membership(), present: false, updatedAt: later }];
    live.personal.collections = [collection()];
    live.personal.memberships = [membership(), membership(2, '52835')];
    const local = localRemoved ? removed : live,
      account = localRemoved ? live : removed;
    const result = preferAccount(local, account);
    assert.equal(result.status, 'needs_review');
    if (result.status !== 'needs_review') continue;
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]!.kind, 'collection_subtree');
    for (const choice of ['local', 'account'] as const) {
      const selected = merged(preferAccount(local, account, { [result.conflicts[0]!.id]: choice }));
      const choosesRemoval = choice === 'local' ? localRemoved : !localRemoved;
      assert.equal(selected.personal.collections[0]!.deleted, choosesRemoval);
      assert.ok(selected.personal.memberships.every((item) => item.present === !choosesRemoval));
      if (!choosesRemoval) assert.equal(selected.personal.memberships.length, 2);
    }
  }
});

test('matching live account edits and local-only uploads remain intact with history union and withdrawals', () => {
  const local = expandedSnapshot(),
    account = expandedSnapshot();
  local.personal.notes = [note(), note(9, '52835', 'Only local')];
  account.personal.notes = [note(1, '52819', 'Account version')];
  local.personal.manualItems = [manual(), manual(9)];
  account.personal.manualItems = [{ ...manual(), name: 'Account lemons', purchased: true }];
  local.personal.collections = [collection()];
  account.personal.collections = [collection(2, 'Account dinners')];
  local.cookingHistory = { entries: [history(4), history(7)], removedEventIds: [id(5)] };
  account.cookingHistory = { entries: [history(5), history(8)], removedEventIds: [id(4)] };
  const value = merged(preferAccount(local, account, undefined, true));
  assert.equal(
    value.personal.notes.find((item) => item.recipeId === '52819')!.text,
    'Account version',
  );
  assert.equal(value.personal.notes.find((item) => item.recipeId === '52835')!.text, 'Only local');
  assert.equal(
    value.personal.manualItems.find((item) => item.itemId === id(3))!.name,
    'Account lemons',
  );
  assert.equal(value.personal.manualItems.length, 2);
  assert.equal(value.personal.collections[0]!.name, 'Account dinners');
  assert.deepEqual(value.cookingHistory, {
    entries: [history(7), history(8)],
    removedEventIds: [id(4), id(5)],
  });
});

test('unmatched and matching tombstones remain preserved without manufactured revival conflicts', () => {
  const removed = expandedSnapshot(),
    absent = expandedSnapshot();
  removed.personal.notes = [deletedNote()];
  removed.personal.manualItems = [deletedManual()];
  for (const [local, account] of [
    [removed, absent],
    [absent, removed],
    [removed, structuredClone(removed)],
  ] as const) {
    assert.deepEqual(merged(preferAccount(local, account)).personal, removed.personal);
  }
});
