import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { canonicalAccountSnapshot, type AccountSnapshotOptions } from '@cookmate/account-sync';
import { canonicalContentJson, createBundledRecipeRevision } from '@cookmate/catalogue/content';
import { createAccountContentApplyService } from '../../mobile/src/data/accountContentApply';
import { captureAccountContentLocal } from '../../mobile/src/data/accountContentCapture';
import { createAccountContentJournalRepository } from '../../mobile/src/data/accountContentJournal';
import { createAccountContentScopeApprovalService } from '../../mobile/src/data/accountContentScopeApproval';
import { createAccountLegacyTransitionRepository } from '../../mobile/src/data/accountLegacyTransitionRepository';
import {
  ACCOUNT_BINDING_KEY,
  journalKey,
  remoteState,
} from '../../mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../mobile/src/data/sql';
import {
  desktopConnection,
  removeFixtureDirectory,
} from '../../../packages/domain/test/helpers/sqlite';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const at = '2026-10-01T12:00:00.000Z';

/** Disposable actual SQLite client. Auth/HTTP live in the enclosing local-service fixture.
 * This client's content reservation port supplies independently generated packaged revisions;
 * it adds no signature/media or mounted-runtime evidence to the separate signed-store tests.
 */
export async function localContentClient(t: TestContext, ownerId: string, observed: unknown) {
  const original = remoteState(observed, ownerId);
  assert.ok(original.snapshot);
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-service-content-client-'));
  const path = join(directory, 'client.db'),
    write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  let loseCommit = false;
  const exec = write.connection.exec;
  write.connection.exec = async (sql) => {
    await exec(sql);
    if (sql === 'COMMIT' && loseCommit) {
      loseCommit = false;
      throw new Error('Synthetic lost local COMMIT acknowledgement');
    }
  };
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const installationId = randomUUID();
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    {
      installationId,
      shoppingScopeId: randomUUID(),
      conversationId: randomUUID(),
    },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  write.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
  // This device observed the actual service backup, but has not installed it. No fabricated
  // prior local apply receipt or promoted format3 base is used to initialize this fixture.
  const oldBytes = JSON.stringify(
    {
      schemaVersion: 1,
      ownerId,
      revision: 1,
      base: null,
      lastApply: null,
      pending: null,
      observed: {
        revision: original.revision,
        updatedAt: original.updatedAt,
        snapshotDigest: await sha256(canonicalAccountSnapshot(original.snapshot)),
      },
    },
    null,
    2,
  );
  write.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(journalKey(ownerId), oldBytes);
  write.database
    .prepare('UPDATE conversation SET composer_draft=?')
    .run(JSON.stringify('Unsent local question; never upload'));
  await migrateCookingContentDatabase(writer, { sha256 });
  await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const settings: AccountSnapshotOptions = {
    appPreferences: original.snapshot.appPreferences,
    profile: original.snapshot.profile,
  };
  const scope = { ownerId, authGeneration: 1 };
  const options = {
    installationId,
    catalogue: catalogue.identity,
    currentScope: () => scope,
    getLocalSettings: () => settings,
    now: () => at,
    sha256,
    reader,
    writer,
  };
  const approvals = createAccountContentScopeApprovalService({ ...options, newId: randomUUID });
  await approvals.approve(scope, await approvals.review(scope), { historyIncluded: false });
  approvals.close();
  const transition = createAccountLegacyTransitionRepository({ ...options, newId: randomUUID });
  const journal = createAccountContentJournalRepository(options);
  let exclusive = false,
    notifications = 0;
  const apply = createAccountContentApplyService({
    ...options,
    contentStore: {
      async withVerifiedReferenceInspection(head, refs, work) {
        assert.equal(head, null);
        let active = true;
        const entries = [];
        for (const ref of refs) {
          const revision = await createBundledRecipeRevision(ref.recipeId, sha256);
          assert.equal(canonicalContentJson(revision.ref), canonicalContentJson(ref));
          entries.push({
            ref,
            lookup: {
              kind: 'readable' as const,
              state: 'current' as const,
              value: {
                origin: 'packaged_baseline' as const,
                revision,
                publication: null,
                retainedSources: [],
              },
            },
          });
        }
        try {
          return await work({
            head: null,
            latestHead: null,
            adoptedRecipeIds: catalogue.recipes.map((row) => row.recipeId),
            entries,
            assertActive() {
              assert.ok(active);
              return undefined;
            },
          });
        } finally {
          active = false;
        }
      },
    },
    acquireExclusive() {
      if (exclusive) return null;
      exclusive = true;
      return () => {
        exclusive = false;
      };
    },
    onCommitted() {
      notifications++;
    },
  });
  t.after(() => {
    transition.close();
    journal.close();
    apply.close();
  });
  function note(recipeId: string, text: string) {
    const id = randomUUID();
    const revision =
      Number(
        write.database
          .prepare("SELECT revision FROM state_revision WHERE collection='store'")
          .get()!.revision,
      ) + 1;
    write.database
      .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,?,?,?)')
      .run(id, recipeId, JSON.stringify(text), revision, at, at);
    write.database
      .prepare("UPDATE state_revision SET revision=? WHERE collection='store'")
      .run(revision);
    write.database.prepare('UPDATE personal_state SET revision=?').run(revision);
    return id;
  }
  return {
    transition,
    journal,
    apply,
    scope,
    note,
    removeFavourite(recipeId: string) {
      const revision =
        Number(
          write.database
            .prepare("SELECT revision FROM state_revision WHERE collection='store'")
            .get()!.revision,
        ) + 1;
      write.database
        .prepare('INSERT INTO favourite VALUES (?,0,?,?,?)')
        .run(recipeId, revision, at, at);
      write.database
        .prepare("UPDATE state_revision SET revision=? WHERE collection IN ('store','favourites')")
        .run(revision);
    },
    favouriteSaved(recipeId: string) {
      return write.database.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(recipeId)
        ?.saved;
    },
    loseNextLocalCommit: () => {
      loseCommit = true;
    },
    capture: () =>
      reader.transaction((session) => captureAccountContentLocal(session, scope, options), {
        kind: 'read_only',
      }),
    assertOriginalEvidence() {
      assert.equal(
        write.database
          .prepare('SELECT value FROM app_metadata WHERE key=?')
          .get(journalKey(ownerId))!.value,
        oldBytes,
      );
      assert.equal(
        write.database.prepare('SELECT composer_draft FROM conversation').get()!.composer_draft,
        JSON.stringify('Unsent local question; never upload'),
      );
    },
    notifications: () => notifications,
    writerRequiresRecovery: () => writer.requiresRecovery(),
  };
}
