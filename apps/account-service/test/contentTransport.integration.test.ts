import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { catalogue } from '@cookmate/catalogue';
import { AccountReplicationError, emptyAccountSnapshot } from '@cookmate/account-sync';
import { createAccountContentRemote } from '../../../packages/account-sync/src/contentRemote';
import type { AccountContentSnapshot } from '../../../packages/account-sync/src/contentSnapshot';
import { AccountRemoteError, createAccountRemote } from '../../../packages/account-sync/src/remote';
import { localContentClient } from './localContentClient';
import { canonicalAccountContentSnapshot } from '../../../packages/account-sync/src/contentSnapshot';
import { createSupabaseBackend } from '../src/backend';
import { createAccountHandler } from '../src/handler';

const ownerA = randomUUID(),
  ownerB = randomUUID();
const sessionA = randomUUID(),
  sessionA2 = randomUUID(),
  sessionB = randomUUID();
const at = '2026-10-01T12:00:00.000Z';
const reason = (wanted: string) => (error: unknown) =>
  error instanceof AccountRemoteError && error.reason === wanted;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('private content transport composes reviewed legacy transition, SQL CAS and atomic local apply through lost ACK and competing clients', async (t) => {
  // Real migrations/RPC and real client/handler/backend code. External Auth and HTTP are
  // explicitly controlled in-process fixtures; this is not hosted Supabase/OAuth acceptance.
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key, user_id uuid references auth.users on delete cascade,
        created_at timestamptz not null default clock_timestamp());`);
    for (const migration of [
      '202609300001_account_sync.sql',
      '202609300002_account_deletion_receipts.sql',
      '202610010001_personal_snapshot_v2.sql',
      '202610010002_content_snapshot_v3.sql',
    ])
      await db.exec(
        await readFile(
          new URL(`../../../supabase/migrations/${migration}`, import.meta.url),
          'utf8',
        ),
      );
    await db.query('insert into auth.users values ($1),($2)', [ownerA, ownerB]);
    await db.query('insert into auth.sessions(id,user_id) values ($1,$2),($3,$2),($4,$5)', [
      sessionA,
      ownerA,
      sessionA2,
      sessionB,
      ownerB,
    ]);
    const sessions = new Map<string, { ownerId: string; sessionId: string }>();
    function token(ownerId: string, sessionId: string) {
      const value = `fixture.${Buffer.from(JSON.stringify({ sub: ownerId, session_id: sessionId })).toString('base64url')}.fixture`;
      sessions.set(value, { ownerId, sessionId });
      return value;
    }
    let rpcCalls = 0;
    const fixtureFailures: { layer: string; code: unknown }[] = [];
    const serviceToken = 'synthetic-server-only';
    const backend = createSupabaseBackend({
      url: 'https://local-supabase.example',
      publishableKey: 'synthetic-public',
      serviceKey: serviceToken,
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const headers = new Headers(init?.headers);
        if (path === '/auth/v1/user') {
          const identity = sessions.get(headers.get('authorization')?.slice(7) ?? '');
          return identity ? json({ id: identity.ownerId }) : json({ error: 'Unauthorized' }, 401);
        }
        assert.equal(headers.get('authorization'), `Bearer ${serviceToken}`);
        assert.equal(headers.get('apikey'), serviceToken);
        const input = JSON.parse(String(init?.body));
        const name = path.slice('/rest/v1/rpc/'.length);
        assert.ok(['cookmate_sync_read', 'cookmate_sync_commit'].includes(name));
        const keys =
          name === 'cookmate_sync_read'
            ? ['p_owner', 'p_session']
            : ['p_owner', 'p_session', 'p_operation', 'p_expected_revision', 'p_snapshot'];
        const values = keys.map((key) =>
          key === 'p_snapshot' ? JSON.stringify(input[key]) : input[key],
        );
        rpcCalls++;
        try {
          const result = await db.query<{ value: unknown }>(
            `select public.${name}(${keys.map((_, index) => `$${index + 1}`).join(',')}) as value`,
            values,
          );
          return json(result.rows[0]!.value);
        } catch (error) {
          fixtureFailures.push({ layer: 'sql', code: (error as { code?: string }).code });
          return json(
            { code: (error as { code?: string }).code, message: 'PRIVATE_SQL_FIXTURE' },
            400,
          );
        }
      },
    });
    let handler = createAccountHandler({
      backend,
      allowedOrigins: [],
      enableContentSnapshots: true,
    });
    let loseNextCommitAck = false,
      clientCalls = 0;
    const transport: typeof fetch = async (url, init) => {
      clientCalls++;
      const result = await handler(new Request(String(url), init));
      if (!result.ok)
        fixtureFailures.push({
          layer: 'handler',
          code: ((await result.clone().json()) as { error?: string }).error,
        });
      if (loseNextCommitAck && JSON.parse(String(init?.body)).action === 'commit' && result.ok) {
        loseNextCommitAck = false;
        throw new Error('Synthetic lost acknowledgement after SQL commit');
      }
      return result;
    };
    const config = (ownerId: string, sessionId: string) => {
      const accessToken = token(ownerId, sessionId);
      return {
        endpoint: 'https://account.example/functions/v1/cookmate-account',
        publishableKey: 'sb_publishable_synthetic',
        ownerId,
        session: async () => ({ ownerId, accessToken, generation: 1 }),
        isCurrent: () => true,
        fetch: transport,
      };
    };
    const legacy = createAccountRemote(config(ownerA, sessionA));
    const first = createAccountContentRemote(config(ownerA, sessionA));
    const second = createAccountContentRemote(config(ownerA, sessionA2));
    const other = createAccountContentRemote(config(ownerB, sessionB));
    const original = emptyAccountSnapshot(catalogue.identity, {
      appPreferences: { theme: 'dark', motion: 'system', locale: 'en' },
      profile: { displayName: null },
    });
    const occurrenceId = randomUUID();
    original.plan = [
      {
        occurrenceId,
        recipeId: catalogue.recipes[0]!.recipeId,
        placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
        createdAt: at,
        updatedAt: at,
      },
    ];
    original.shopping.selectedOccurrenceIds = [occurrenceId];
    original.favourites = [{ recipeId: catalogue.recipes[0]!.recipeId, savedAt: at }];
    const legacyOperation = randomUUID();
    const legacyReceipt = await legacy
      .commit({
        operationId: legacyOperation,
        expectedRevision: 0,
        snapshot: original,
      })
      .catch((error: unknown) => {
        throw new Error(
          `Synthetic integration boundary failure: ${String(error)} ${JSON.stringify(fixtureFailures)}`,
        );
      });
    const oldRead = await first.read();
    assert.equal(oldRead.snapshot?.schemaVersion, 1);
    assert.deepEqual(oldRead.snapshot, original);
    assert.equal(oldRead.revision, 1);
    const local = await localContentClient(t, ownerA, oldRead);
    local.note(original.plan[0]!.recipeId, '  Deliberately reviewed fixture note\n量  ');
    local.removeFavourite(original.favourites[0]!.recipeId);
    const review = await local.transition.review(local.scope, oldRead);
    assert.equal(review.initialImportRequired, true);
    assert.equal(review.merge.status, 'merged');
    assert.equal(review.removalReview?.conflicts.length, 1);
    await assert.rejects(
      local.transition.stage(local.scope, review, { initialImportReviewed: true }),
      (error: unknown) =>
        error instanceof AccountReplicationError && error.reason === 'invalid_input',
    );
    const staged = await local.transition.stage(local.scope, review, {
      initialImportReviewed: true,
      removalChoices: { [review.removalReview!.conflicts[0]!.id]: 'keep_local' },
    });
    assert.equal(staged.legacy.base, null);
    assert.equal(staged.lastApply, null);
    const proposed = JSON.parse(
      canonicalAccountContentSnapshot(staged.proposed),
    ) as AccountContentSnapshot;
    const upgrade = {
      operationId: staged.networkOperationId,
      expectedRevision: oldRead.revision,
      snapshot: proposed,
    };
    const transitionIdentity = {
      operationId: staged.networkOperationId,
      requestFingerprint: staged.requestFingerprint,
    };
    const beforeCalls = clientCalls;
    loseNextCommitAck = true;
    await assert.rejects(first.commit(upgrade), reason('unavailable'));
    assert.equal(clientCalls - beforeCalls, 1, 'no hidden retry after uncertain commit');
    assert.equal(
      (await local.transition.recover(local.scope, transitionIdentity))!.acknowledgement,
      null,
    );
    assert.equal(
      await local.journal.read(local.scope),
      null,
      'Uncertain network outcome is not a local applied base',
    );
    assert.equal(oldRead.snapshot?.schemaVersion, 1, 'the original observation remains original');
    const actual = await second.read();
    assert.equal(actual.revision, 2);
    assert.deepEqual(actual.snapshot, proposed);
    assert.deepEqual(
      actual.snapshot!.favourites,
      [],
      'Explicit local deletion is protected before the actual SQL CAS upload',
    );
    const recovered = await first.commit(upgrade);
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.committedAt, actual.updatedAt);
    await local.transition.recordAcknowledgement(local.scope, {
      ...transitionIdentity,
      receipt: recovered,
    });
    const lateNoteId = local.note(
      catalogue.recipes[1]!.recipeId,
      'Late local note stays on this device until its next reviewed sync',
    );
    const handed = await local.transition.handoff(local.scope, transitionIdentity);
    assert.ok(handed.handoff);
    assert.equal(handed.lastApply, null);
    assert.notEqual(handed.localApplyOperationId, handed.networkOperationId);
    const localIdentity = {
      operationId: handed.localApplyOperationId,
      requestFingerprint: handed.handoff.requestFingerprint,
    };
    const localReview = await local.apply.review(local.scope, localIdentity);
    local.loseNextLocalCommit();
    const installed = await local.apply.apply(local.scope, localReview);
    assert.equal(installed.serverRevision, recovered.revision);
    assert.deepEqual(
      (await local.transition.recover(local.scope, transitionIdentity))!.lastApply,
      installed,
    );
    assert.deepEqual(await local.apply.recover(local.scope, localIdentity), installed);
    const localSnapshot = (await local.capture()).snapshot;
    assert.deepEqual(localSnapshot.planReferences, proposed.planReferences);
    assert.equal(
      local.favouriteSaved(original.favourites[0]!.recipeId),
      0,
      'The local tombstone survives the complete network and local-apply journey',
    );
    assert.ok(localSnapshot.personal.notes.some((row) => row.noteId === lateNoteId));
    assert.ok(!proposed.personal.notes.some((row) => row.noteId === lateNoteId));
    assert.equal(
      canonicalAccountContentSnapshot((await local.journal.read(local.scope))!.base!.snapshot!),
      canonicalAccountContentSnapshot(proposed),
      'Accepted server base remains distinct from late local changes',
    );
    assert.equal(local.notifications(), 1);
    assert.equal(
      local.writerRequiresRecovery(),
      true,
      'Lost local COMMIT keeps the writer closed to new writes until the host reopens it',
    );
    local.assertOriginalEvidence();
    const later = structuredClone(proposed);
    later.personal.notes[0]!.text = 'Second independent client edit';
    await second.commit({ operationId: randomUUID(), expectedRevision: 2, snapshot: later });
    assert.deepEqual(await first.commit(upgrade), recovered);
    assert.deepEqual(
      (await first.read()).snapshot,
      later,
      'old receipt retry never reinstalls old data',
    );
    await assert.rejects(
      first.commit({ operationId: randomUUID(), expectedRevision: 2, snapshot: proposed }),
      reason('needs_review'),
    );
    await assert.rejects(
      first.commit({ ...upgrade, snapshot: later }),
      reason('operation_changed'),
    );
    await assert.rejects(
      legacy.commit({ operationId: randomUUID(), expectedRevision: 3, snapshot: original }),
      reason('snapshot_upgrade_required'),
    );
    assert.deepEqual(
      await legacy.commit({
        operationId: legacyOperation,
        expectedRevision: 0,
        snapshot: original,
      }),
      legacyReceipt,
    );
    assert.deepEqual((await first.read()).snapshot, later);
    assert.equal((await other.read()).snapshot, null, 'another account has independent state');
    const beforeInvalid = rpcCalls;
    await assert.rejects(
      first.commit({
        operationId: randomUUID(),
        expectedRevision: 3,
        snapshot: { ...proposed, planReferences: [] },
      }),
      reason('invalid_response'),
    );
    assert.equal(rpcCalls, beforeInvalid, 'malformed candidate never reaches storage');
    handler = createAccountHandler({ backend, allowedOrigins: [] });
    await assert.rejects(first.read(), reason('stored_data_needs_review'));
    handler = createAccountHandler({ backend, allowedOrigins: [], enableContentSnapshots: true });
    await db.query('delete from auth.sessions where id=$1', [sessionA]);
    await assert.rejects(first.read(), reason('sign_in_required'));
    assert.deepEqual(
      (await second.read()).snapshot,
      later,
      'session rejection leaves account data intact',
    );
  } finally {
    await db.close();
  }
});
