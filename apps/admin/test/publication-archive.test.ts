import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { SQLInputValue } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogue } from '@cookmate/catalogue';
import type { AdminDraftInput } from '../src/contracts';
import type { Actor, AdminDatabase } from '../src/storage/database';
import { openAdminDatabase } from '../src/storage/database';
import { DraftRepository } from '../src/drafts/repository';
import { AdminMedia } from '../src/media/service';
import { PreparedPublicationArchive } from '../src/publishing/archive';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-preparation-test-'));
  const filename = join(directory, 'admin.sqlite');
  let db = openAdminDatabase(filename);
  let clock = Date.parse('2026-09-30T12:00:00.000Z');
  const now = () => new Date(clock);
  // Synthetic operator/session fixtures exercise repository authority, not real password sign-in.
  db.createFirstAdministrator({
    userId: 'fixture-admin',
    username: 'fixture.admin',
    passwordHash: '$argon2id$synthetic-unused-test-hash',
  });
  const actor: Actor = {
    user: { userId: 'fixture-admin', username: 'fixture.admin', role: 'administrator' },
    authEpoch: 1,
    sessionId: 'fixture-session',
  };
  db.run(
    'INSERT INTO admin_session VALUES(?,?,?)',
    actor.sessionId,
    JSON.stringify({
      userId: actor.user.userId,
      authEpoch: 1,
      recentAuthAt: clock,
      absoluteExpiresAt: clock + 86_400_000,
    }),
    clock + 86_400_000,
  );
  let drafts = new DraftRepository(db, now);
  let draft = (await drafts.create(actor, 'fixture-create', catalogue.recipes[0]!.recipeId)).draft;
  draft = drafts.mutate(actor, draft.draftId, 'fixture-save', draft.revision, {
    kind: 'save',
    input: { ...draft.input, changeSummary: 'Synthetic private archive fixture.' },
  }).draft;
  for (const scope of [
    'recipe_text',
    'photo',
    ...(draft.input.videoUrl ? (['video_embed'] as const) : []),
  ] as const) {
    draft = drafts.mutate(actor, draft.draftId, `fixture-rights-${scope}`, draft.revision, {
      kind: 'rights',
      input: {
        scope,
        status: 'permitted',
        statement: `Synthetic test assertion only: ${scope}`,
        sourceUrl: null,
      },
    }).draft;
  }
  draft = drafts.mutate(actor, draft.draftId, 'fixture-approve', draft.revision, {
    kind: 'review',
    decision: 'approved',
    note: 'Synthetic review; no real permission claim.',
  }).draft;
  function media() {
    return new AdminMedia(
      db,
      drafts,
      join(directory, 'media'),
      fileURLToPath(new URL('../../../packages/catalogue/assets/photos/', import.meta.url)),
      now,
    );
  }
  function archive() {
    return new PreparedPublicationArchive(db, media(), now);
  }
  const request = {
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    revisionId: 'fixture-immutable-1',
  };
  t.after(async () => {
    db.close();
    const target = resolve(directory);
    const path = relative(resolve(tmpdir()), target);
    if (path.startsWith('..') || isAbsolute(path) || !path.startsWith('cookmate-preparation-test-'))
      throw new Error('Fixture cleanup escaped temporary workspace');
    await rm(target, { recursive: true, force: true });
  });
  return {
    actor,
    request,
    now,
    media,
    archive,
    get db() {
      return db;
    },
    get draft() {
      return draft;
    },
    get drafts() {
      return drafts;
    },
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    reopen() {
      db.close();
      db = openAdminDatabase(filename);
      drafts = new DraftRepository(db, now);
    },
    edit(patch: Partial<AdminDraftInput>) {
      draft = drafts.mutate(actor, draft.draftId, `edit-${draft.revision}`, draft.revision, {
        kind: 'save',
        input: { ...draft.input, ...patch },
      }).draft;
    },
    preparedCount() {
      return db.get<{ count: number }>(
        "SELECT COUNT(*) count FROM admin_operation WHERE kind IN ('prepare_publication','prepare_publication_identity')",
      )!.count;
    },
  };
}

test('private preparation durably retains exact content and original evidence without publishing', async (t) => {
  const f = await fixture(t);
  const first = await f.archive().prepare(f.actor, 'prepare-1', f.request);
  assert.equal(first.status, 'prepared_not_published');
  assert.equal(first.draftRevision, f.request.expectedRevision);
  assert.deepEqual(
    first.publication.revision.document.recipe.ingredients.map(({ rawName, rawMeasure }) => ({
      rawName,
      rawMeasure,
    })),
    f.draft.input.ingredients,
  );
  assert.deepEqual(first.originalEvidence!.document.recipe, catalogue.getRecipe(f.draft.recipeId));
  assert.ok(Object.isFrozen(first.publication.revision.document.recipe.ingredients));
  assert.equal(f.preparedCount(), 2);
  assert.equal(f.drafts.read(f.draft.draftId).revision, f.request.expectedRevision);
  assert.equal(
    f.db.get<{ count: number }>("SELECT COUNT(*) count FROM admin_operation WHERE kind='publish'")!
      .count,
    0,
  );
  f.reopen();
  assert.deepEqual(await f.archive().receipt(f.actor, 'prepare-1'), first);
  assert.deepEqual(
    await f.archive().readRevision(f.actor, f.draft.recipeId, f.request.revisionId),
    first,
  );
  assert.equal(await f.archive().readRevision(f.actor, f.draft.recipeId, 'unknown-revision'), null);
});

test('lost-response retry recovers the original bytes after draft edits and expiry of recent authentication', async (t) => {
  const f = await fixture(t);
  const first = await f.archive().prepare(f.actor, 'prepare-retry', f.request);
  f.edit({ title: 'Later draft, never silently substituted' });
  f.advance(16 * 60 * 1000);
  f.reopen();
  const unusedMedia = {
    asset: async () => {
      throw new Error('Replay must not inspect media again');
    },
    baseline: async () => {
      throw new Error('Replay must not inspect media again');
    },
  };
  const recovered = await new PreparedPublicationArchive(f.db, unusedMedia, f.now).prepare(
    f.actor,
    'prepare-retry',
    f.request,
  );
  assert.deepEqual(recovered, first);
  assert.equal(f.preparedCount(), 2);
});

test('simultaneous retries commit one preparation and one identity pointer', async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    f.archive().prepare(f.actor, 'prepare-concurrent', f.request),
    f.archive().prepare(f.actor, 'prepare-concurrent', f.request),
  ]);
  assert.deepEqual(first, second);
  assert.equal(f.preparedCount(), 2);
});

for (const change of [
  'draft_edit',
  'recent_auth_expiry',
  'revocation',
  'uncommitted_edit',
] as const) {
  test(
    `paused duplicate preparation handles ${change} after another request can commit`,
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture(t);
      const source = f.media();
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const archive = new PreparedPublicationArchive(
        f.db,
        {
          asset: (id) => source.asset(id),
          async baseline(id) {
            const photo = await source.baseline(id);
            signalEntered();
            await paused;
            return photo;
          },
        },
        f.now,
      );
      const duplicate = archive.prepare(f.actor, 'prepare-race', f.request).then(
        (receipt) => ({ kind: 'receipt' as const, receipt }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      let committed: Awaited<ReturnType<PreparedPublicationArchive['prepare']>> | undefined;
      try {
        await Promise.race([
          entered,
          duplicate.then((outcome) => {
            throw outcome.kind === 'error'
              ? outcome.error
              : new Error('Preparation completed before its media pause');
          }),
        ]);
        if (change !== 'uncommitted_edit')
          committed = await f.archive().prepare(f.actor, 'prepare-race', f.request);
        if (change === 'draft_edit' || change === 'uncommitted_edit')
          f.edit({ title: 'Changed while duplicate preparation was paused' });
        else if (change === 'recent_auth_expiry') f.advance(16 * 60 * 1000);
        else f.db.run('UPDATE admin_user SET auth_epoch=2 WHERE user_id=?', f.actor.user.userId);
      } finally {
        release();
        await duplicate;
      }
      const outcome = await duplicate;
      if (change === 'revocation' || change === 'uncommitted_edit') {
        assert.equal(outcome.kind, 'error');
        if (outcome.kind !== 'error')
          assert.fail('Expected failure instead of a recovered receipt');
        assert.equal(
          (outcome.error as { code: string }).code,
          change === 'revocation' ? 'session_expired' : 'revision_conflict',
        );
      } else {
        assert.equal(outcome.kind, 'receipt');
        assert.deepEqual(outcome.receipt, committed);
      }
      assert.equal(f.preparedCount(), change === 'uncommitted_edit' ? 0 : 2);
    },
  );
}

test('changed requests and fresh operations cannot rebind an already prepared identity', async (t) => {
  const f = await fixture(t);
  const first = await f.archive().prepare(f.actor, 'prepare-original', f.request);
  await assert.rejects(
    f
      .archive()
      .prepare(f.actor, 'prepare-original', { ...f.request, revisionId: 'another-revision' }),
    { code: 'operation_conflict' },
  );
  f.advance(1000);
  await assert.rejects(f.archive().prepare(f.actor, 'prepare-rebind', f.request), {
    code: 'revision_already_prepared',
  });
  assert.deepEqual(await f.archive().receipt(f.actor, 'prepare-original'), first);
  assert.equal(f.preparedCount(), 2);
});

test('cancelled operations and revoked sessions cannot prepare or recover private content', async (t) => {
  const f = await fixture(t);
  f.drafts.cancel(f.actor, 'cancelled-preparation');
  await assert.rejects(f.archive().prepare(f.actor, 'cancelled-preparation', f.request), {
    code: 'operation_cancelled',
  });
  await f.archive().prepare(f.actor, 'prepare-private', f.request);
  f.db.run('UPDATE admin_user SET auth_epoch=2 WHERE user_id=?', f.actor.user.userId);
  await assert.rejects(f.archive().receipt(f.actor, 'prepare-private'), {
    code: 'session_expired',
  });
  await assert.rejects(f.archive().prepare(f.actor, 'prepare-private', f.request), {
    code: 'session_expired',
  });
  await assert.rejects(f.archive().readRevision(f.actor, f.draft.recipeId, f.request.revisionId), {
    code: 'session_expired',
  });
});

test('operation recovery is actor-scoped and private revision reads require a review role', async (t) => {
  const f = await fixture(t);
  const first = await f.archive().prepare(f.actor, 'prepare-owner', f.request);
  function operator(role: 'editor' | 'reviewer'): Actor {
    const userId = `fixture-${role}`;
    f.db.run(
      'INSERT INTO admin_user VALUES(?,?,?,?,1,1)',
      userId,
      userId,
      '$argon2id$synthetic-unused-test-hash',
      role,
    );
    const sessionId = `session-${role}`;
    const clock = f.now().getTime();
    f.db.run(
      'INSERT INTO admin_session VALUES(?,?,?)',
      sessionId,
      JSON.stringify({
        userId,
        authEpoch: 1,
        recentAuthAt: clock,
        absoluteExpiresAt: clock + 86_400_000,
      }),
      clock + 86_400_000,
    );
    return { user: { userId, username: userId, role }, sessionId, authEpoch: 1 };
  }
  const reviewer = operator('reviewer');
  await assert.rejects(f.archive().receipt(reviewer, 'prepare-owner'), {
    code: 'preparation_unknown',
  });
  await assert.rejects(f.archive().prepare(reviewer, 'prepare-owner', f.request), {
    code: 'operation_conflict',
  });
  assert.deepEqual(
    await f.archive().readRevision(reviewer, f.draft.recipeId, f.request.revisionId),
    first,
  );
  const editor = operator('editor');
  await assert.rejects(f.archive().readRevision(editor, f.draft.recipeId, f.request.revisionId), {
    code: 'role_required',
  });
  await assert.rejects(f.archive().prepare(editor, 'editor-prepare', f.request), {
    code: 'role_required',
  });
});

test('failure between receipt and identity insertion rolls the whole transaction back', async (t) => {
  const f = await fixture(t);
  const run = f.db.run.bind(f.db);
  f.db.run = (sql, ...values) => {
    if (
      sql === 'INSERT INTO admin_operation VALUES(?,?,?,?,?)' &&
      values[2] === 'prepare_publication_identity'
    )
      throw new Error('Synthetic second-write failure');
    return run(sql, ...values);
  };
  await assert.rejects(
    f.archive().prepare(f.actor, 'prepare-atomic', f.request),
    /Synthetic second-write failure/,
  );
  f.db.run = run;
  assert.equal(f.preparedCount(), 0);
  assert.equal(
    f.db.get('SELECT 1 FROM admin_operation WHERE operation_id=?', 'prepare-atomic'),
    undefined,
  );
  assert.equal(
    (await f.archive().prepare(f.actor, 'prepare-atomic', f.request)).status,
    'prepared_not_published',
  );
  assert.equal(f.preparedCount(), 2);
});

test('an edit after asynchronous preparation still fails the commit transaction CAS', async (t) => {
  const f = await fixture(t);
  const transaction = f.db.transaction.bind(f.db);
  let calls = 0;
  f.db.transaction = <Value>(body: () => Value): Value => {
    if (++calls === 3) f.edit({ title: 'Changed between preparation and archive commit' });
    return transaction(body);
  };
  await assert.rejects(f.archive().prepare(f.actor, 'prepare-stale', f.request), {
    code: 'revision_conflict',
  });
  f.db.transaction = transaction;
  assert.equal(f.preparedCount(), 0);
});

test('recent authentication is checked again in the archive commit transaction', async (t) => {
  const f = await fixture(t);
  const transaction = f.db.transaction.bind(f.db);
  let calls = 0;
  f.db.transaction = <Value>(body: () => Value): Value => {
    if (++calls === 3) f.advance(16 * 60 * 1000);
    return transaction(body);
  };
  await assert.rejects(f.archive().prepare(f.actor, 'prepare-auth-expired', f.request), {
    code: 'reauth_required',
  });
  f.db.transaction = transaction;
  assert.equal(f.preparedCount(), 0);
});

test('tampered receipt content and identity pointers fail closed on reads and replay', async (t) => {
  const f = await fixture(t);
  await f.archive().prepare(f.actor, 'prepare-integrity', f.request);
  const row = f.db.get<{ result: string }>(
    'SELECT result FROM admin_operation WHERE operation_id=?',
    'prepare-integrity',
  )!;
  const changed = JSON.parse(row.result);
  changed.publication.revision.document.recipe.ingredients[0].rawMeasure = '999 kg';
  f.db.run(
    'UPDATE admin_operation SET result=? WHERE operation_id=?',
    JSON.stringify(changed),
    'prepare-integrity',
  );
  await assert.rejects(f.archive().receipt(f.actor, 'prepare-integrity'), /revision_integrity/);
  f.db.run(
    'UPDATE admin_operation SET result=? WHERE operation_id=?',
    row.result,
    'prepare-integrity',
  );
  f.db.run(
    "UPDATE admin_operation SET fingerprint=? WHERE kind='prepare_publication_identity'",
    '0'.repeat(64),
  );
  await assert.rejects(f.archive().receipt(f.actor, 'prepare-integrity'), {
    code: 'preparation_integrity',
  });
  await assert.rejects(f.archive().prepare(f.actor, 'prepare-integrity', f.request), {
    code: 'preparation_integrity',
  });
  await assert.rejects(f.archive().readRevision(f.actor, f.draft.recipeId, f.request.revisionId), {
    code: 'preparation_integrity',
  });
});

test('approval, preparing operator and timestamp are covered by the retained receipt digest', async (t) => {
  const f = await fixture(t);
  const first = await f.archive().prepare(f.actor, 'prepare-envelope', f.request);
  const original = f.db.get<{ result: string }>(
    'SELECT result FROM admin_operation WHERE operation_id=?',
    'prepare-envelope',
  )!.result;
  for (const change of [
    { approval: { ...first.approval, note: 'Unrecorded replacement approval note' } },
    { approval: { ...first.approval, reviewerId: 'different-reviewer' } },
    { approval: { ...first.approval, reviewedAt: '2026-09-30T12:01:00.000Z' } },
    { preparedBy: { ...first.preparedBy, username: 'different.operator' } },
    { preparedBy: { ...first.preparedBy, role: 'reviewer' } },
    { preparedAt: '2026-09-30T12:01:00.000Z' },
  ]) {
    f.db.run(
      'UPDATE admin_operation SET result=? WHERE operation_id=?',
      JSON.stringify({ ...first, ...change }),
      'prepare-envelope',
    );
    await assert.rejects(f.archive().receipt(f.actor, 'prepare-envelope'), {
      code: 'preparation_integrity',
    });
    await assert.rejects(f.archive().prepare(f.actor, 'prepare-envelope', f.request), {
      code: 'preparation_integrity',
    });
    await assert.rejects(
      f.archive().readRevision(f.actor, f.draft.recipeId, f.request.revisionId),
      { code: 'preparation_integrity' },
    );
  }
  f.db.run(
    'UPDATE admin_operation SET result=? WHERE operation_id=?',
    original,
    'prepare-envelope',
  );
  assert.deepEqual(await f.archive().receipt(f.actor, 'prepare-envelope'), first);
});

function observeWithheldRows(db: AdminDatabase, operationId: string, maximum: number) {
  const get = db.get.bind(db);
  let observations = 0;
  db.get = <Value>(sql: string, ...values: SQLInputValue[]): Value | undefined => {
    const result = get<Value>(sql, ...values);
    if (values.at(-1) === operationId && result !== undefined) {
      const row = result as { result: unknown; result_bytes: number };
      assert.ok(
        row.result_bytes > maximum,
        'The database reports the oversized stored byte count.',
      );
      assert.equal(
        row.result,
        null,
        'SQLite withholds the oversized value before returning it to JavaScript.',
      );
      observations++;
    }
    return result;
  };
  return () => observations;
}

test('oversized retained data is withheld by SQLite on every recovery path', async (t) => {
  const f = await fixture(t);
  await f.archive().prepare(f.actor, 'prepare-bounded', f.request);
  f.db.run(
    'UPDATE admin_operation SET result=? WHERE operation_id=?',
    ' '.repeat(3 * 1024 * 1024 + 1),
    'prepare-bounded',
  );
  const observations = observeWithheldRows(f.db, 'prepare-bounded', 3 * 1024 * 1024);
  await assert.rejects(f.archive().receipt(f.actor, 'prepare-bounded'), {
    code: 'preparation_integrity',
  });
  await assert.rejects(f.archive().prepare(f.actor, 'prepare-bounded', f.request), {
    code: 'preparation_integrity',
  });
  await assert.rejects(f.archive().readRevision(f.actor, f.draft.recipeId, f.request.revisionId), {
    code: 'preparation_integrity',
  });
  assert.equal(observations(), 3);
});

test('oversized identity pointers are withheld by SQLite before receipt recovery', async (t) => {
  const f = await fixture(t);
  await f.archive().prepare(f.actor, 'prepare-pointer-bound', f.request);
  const pointerId = f.db.get<{ operation_id: string }>(
    "SELECT operation_id FROM admin_operation WHERE kind='prepare_publication_identity'",
  )!.operation_id;
  f.db.run('UPDATE admin_operation SET result=? WHERE operation_id=?', ' '.repeat(4097), pointerId);
  const observations = observeWithheldRows(f.db, pointerId, 4096);
  await assert.rejects(f.archive().receipt(f.actor, 'prepare-pointer-bound'), {
    code: 'preparation_integrity',
  });
  await assert.rejects(f.archive().prepare(f.actor, 'prepare-pointer-bound', f.request), {
    code: 'preparation_integrity',
  });
  await assert.rejects(f.archive().readRevision(f.actor, f.draft.recipeId, f.request.revisionId), {
    code: 'preparation_integrity',
  });
  assert.equal(observations(), 3);
});
