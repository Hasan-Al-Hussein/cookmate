import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountSnapshotError, canonicalAccountSnapshot, mergeAccountSnapshots } from '../src';
import type { AccountSnapshot, AccountSnapshotV2, AccountMergeResult } from '../src';
import { id, later, snapshot } from './fixtures';
import {
  expandedSnapshot,
  note,
  collection,
  membership,
  manual,
  history,
} from './expandedFixtures';
const merge = (
  base: AccountSnapshot,
  local: AccountSnapshot,
  account: AccountSnapshot,
  historyIncluded = false,
) => mergeAccountSnapshots({ base, local, account, expandedScope: { historyIncluded } });
function merged(result: AccountMergeResult): AccountSnapshotV2 {
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged' || result.snapshot.schemaVersion !== 2)
    throw new Error('Expected expanded result');
  return result.snapshot;
}

test('v2 pure merge fails closed without explicit scope and never upgrades a v1 local writer', () => {
  assert.throws(
    () =>
      mergeAccountSnapshots({ base: snapshot(), local: snapshot(), account: expandedSnapshot() }),
    (error) => error instanceof AccountSnapshotError && error.reason === 'scope_review_required',
  );
  assert.throws(() => merge(snapshot(), snapshot(), expandedSnapshot()), AccountSnapshotError);
  assert.equal(merged(merge(snapshot(), expandedSnapshot(), snapshot())).schemaVersion, 2);
});

test('independent personal additions merge by identity; identical names do not collapse manual items or collections', () => {
  const local = expandedSnapshot(),
    account = expandedSnapshot();
  local.personal.notes = [note()];
  account.personal.notes = [note(9, '52835')];
  local.personal.collections = [collection()];
  account.personal.collections = [collection(9)];
  local.personal.manualItems = [manual()];
  account.personal.manualItems = [manual(9)];
  const result = merged(merge(snapshot(), local, account));
  assert.equal(result.personal.notes.length, 2);
  assert.equal(result.personal.collections.length, 2);
  assert.equal(result.personal.manualItems.length, 2);
  assert.equal(
    canonicalAccountSnapshot(result),
    canonicalAccountSnapshot(merged(merge(snapshot(), account, local))),
  );
});

test('same-recipe independent notes use existing exact conflict IDs; old resolutions cannot approve changed content', () => {
  const base = snapshot(),
    local = expandedSnapshot(),
    account = expandedSnapshot();
  local.personal.notes = [note()];
  account.personal.notes = [note(9, '52819', 'More lime')];
  const result = merge(base, local, account);
  assert.equal(result.status, 'needs_review');
  if (result.status !== 'needs_review') return;
  assert.equal(result.conflicts[0]!.path, 'personal/notes/52819');
  const resolutions = { [result.conflicts[0]!.id]: 'account' as const };
  const selected = merged(
    mergeAccountSnapshots({
      base,
      local,
      account,
      expandedScope: { historyIncluded: false },
      resolutions,
    }),
  );
  assert.deepEqual(selected.personal.notes, account.personal.notes);
  account.personal.notes[0]!.text = 'Different content';
  assert.throws(
    () =>
      mergeAccountSnapshots({
        base,
        local,
        account,
        expandedScope: { historyIncluded: false },
        resolutions,
      }),
    (error) => error instanceof AccountSnapshotError && error.reason === 'invalid_resolution',
  );
});

test('note/manual tombstones persist against an unchanged or missing replica, and explicit delete/edit needs review', () => {
  const base = expandedSnapshot();
  base.personal.notes = [note()];
  base.personal.manualItems = [manual()];
  const local = structuredClone(base),
    account = structuredClone(base);
  local.personal.notes[0] = { ...note(), text: null, deleted: true, updatedAt: later };
  local.personal.manualItems[0] = {
    ...manual(),
    deleted: true,
    name: null,
    amountText: null,
    unitText: null,
    category: null,
    updatedAt: later,
  };
  const deleted = merged(merge(base, local, account));
  assert.ok(deleted.personal.notes[0]!.deleted);
  assert.ok(deleted.personal.manualItems[0]!.deleted);
  assert.deepEqual(
    merged(merge(deleted, expandedSnapshot(), deleted)).personal,
    deleted.personal,
    'missing rows do not withdraw tombstones',
  );
  account.personal.notes[0]!.text = 'Edited on another device';
  account.personal.manualItems[0]!.purchased = true;
  const conflict = merge(base, local, account);
  assert.equal(conflict.status, 'needs_review');
  if (conflict.status === 'needs_review')
    assert.deepEqual(
      conflict.conflicts.map((value) => value.kind),
      ['delete_edit', 'delete_edit'],
    );
});

test('collection deletion against a concurrent member addition reviews the exact subtree as one decision', () => {
  const base = expandedSnapshot();
  base.personal.collections = [collection()];
  base.personal.memberships = [membership()];
  const local = structuredClone(base),
    account = structuredClone(base);
  local.personal.collections[0] = { ...collection(), name: null, deleted: true, updatedAt: later };
  local.personal.memberships[0] = { ...membership(), present: false, updatedAt: later };
  account.personal.memberships.push(membership(2, '52835'));
  const result = merge(base, local, account);
  assert.equal(result.status, 'needs_review');
  if (result.status !== 'needs_review') return;
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.kind, 'collection_subtree');
  for (const choice of ['local', 'account'] as const) {
    const value = merged(
      mergeAccountSnapshots({
        base,
        local,
        account,
        expandedScope: { historyIncluded: false },
        resolutions: { [result.conflicts[0]!.id]: choice },
      }),
    );
    assert.deepEqual(
      value.personal.collections,
      (choice === 'local' ? local : account).personal.collections,
    );
    assert.deepEqual(
      value.personal.memberships,
      (choice === 'local' ? local : account).personal.memberships,
    );
  }
});

test('disjoint collection rename/member edits merge; deleted parent retains explicit child withdrawal identities', () => {
  const base = expandedSnapshot();
  base.personal.collections = [collection()];
  base.personal.memberships = [membership()];
  const local = structuredClone(base),
    account = structuredClone(base);
  local.personal.collections[0]!.name = 'Weeknights';
  account.personal.memberships.push(membership(2, '52835'));
  const combined = merged(merge(base, local, account));
  assert.equal(combined.personal.collections[0]!.name, 'Weeknights');
  assert.equal(combined.personal.memberships.length, 2);
  const deleted = structuredClone(base);
  deleted.personal.collections[0] = {
    ...collection(),
    name: null,
    deleted: true,
    updatedAt: later,
  };
  deleted.personal.memberships = [];
  const value = merged(merge(base, deleted, base));
  assert.equal(value.personal.memberships[0]!.present, false);
  assert.equal(value.personal.memberships[0]!.recipeId, '52819');
});

test('personal timestamp differences do not manufacture content conflicts or choose newest clock', () => {
  const local = expandedSnapshot(),
    account = expandedSnapshot();
  local.personal.notes = [note()];
  account.personal.notes = [{ ...note(), createdAt: later, updatedAt: later }];
  assert.deepEqual(merged(merge(snapshot(), local, account)).personal.notes, local.personal.notes);
});

test('included history uses immutable identity union, explicit monotonic removals and no revision/remapping', () => {
  const base = expandedSnapshot();
  base.cookingHistory = { entries: [history()], removedEventIds: [] };
  const local = structuredClone(base),
    account = structuredClone(base);
  local.cookingHistory!.entries.push(history(5));
  account.cookingHistory!.entries.push(history(6));
  const union = merged(merge(base, local, account, true));
  assert.deepEqual(
    union.cookingHistory!.entries.map((value) => value.eventId),
    [id(4), id(5), id(6)],
  );
  local.cookingHistory = { entries: [history(5)], removedEventIds: [id(4)] };
  const removed = merged(merge(base, local, account, true));
  assert.deepEqual(removed.cookingHistory, {
    entries: [history(5), history(6)],
    removedEventIds: [id(4)],
  });
  const missing = structuredClone(base);
  missing.cookingHistory!.entries = [];
  assert.deepEqual(
    merged(merge(base, missing, base, true)).cookingHistory,
    base.cookingHistory,
    'absence is not history deletion',
  );
});

test('same history event ID with a different immutable payload fails closed even if withdrawn elsewhere', () => {
  const base = expandedSnapshot();
  base.cookingHistory = { entries: [history()], removedEventIds: [] };
  const local = structuredClone(base),
    account = structuredClone(base);
  account.cookingHistory!.entries[0]!.note = 'Conflicting data';
  assert.throws(
    () => merge(base, local, account, true),
    (error) =>
      error instanceof AccountSnapshotError && error.reason === 'history_identity_collision',
  );
  local.cookingHistory = { entries: [], removedEventIds: [id(4)] };
  assert.throws(() => merge(base, local, account, true), AccountSnapshotError);
});

test('excluded history never uploads, removes or compares local history; remote subtree is preserved exactly', () => {
  const base = expandedSnapshot(),
    local = expandedSnapshot(),
    account = expandedSnapshot();
  base.cookingHistory = { entries: [history()], removedEventIds: [] };
  local.cookingHistory = { entries: [history(8)], removedEventIds: [id(4)] };
  account.cookingHistory = {
    entries: [{ ...history(), note: 'Remote unchanged' }],
    removedEventIds: [id(9)],
  };
  local.personal.notes = [note()];
  const result = merged(merge(base, local, account, false));
  assert.deepEqual(result.cookingHistory, account.cookingHistory);
  assert.equal(result.personal.notes.length, 1);
  assert.equal(
    Object.hasOwn(merged(merge(snapshot(), local, snapshot(), false)), 'cookingHistory'),
    false,
  );
  assert.throws(
    () => merge(snapshot(), expandedSnapshot(), snapshot(), true),
    AccountSnapshotError,
  );
});
