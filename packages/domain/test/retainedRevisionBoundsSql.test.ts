import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createBundledRecipeRevision } from '@cookmate/catalogue/content';
import { retainCookingRevisionInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import { COOKING_CONTENT_RECORDS_DDL } from '../../../apps/mobile/src/data/cookingContentSchema';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

test('retaining an existing revision bounds corrupt stored fingerprints before JavaScript materialization', async (t) => {
  const store = desktopConnection();
  await configureConnection(store.connection);
  const writer = new SerializedWriter(store.connection);
  t.after(() => writer.close());
  store.database.exec(COOKING_CONTENT_RECORDS_DDL);
  const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
  const revision = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256);
  await writer.transaction((session) => retainCookingRevisionInSnapshot(session, revision, sha256));
  const observed: unknown[] = [];
  const original = store.connection.all;
  store.connection.all = async <Row extends object>(
    sql: string,
    values?: Parameters<typeof original>[1],
  ) => {
    const rows = await original<Row>(sql, values);
    if (sql.includes('FROM recipe_content_revision WHERE recipe_id=? AND revision_id=?'))
      for (const row of rows) observed.push((row as { fingerprint?: unknown }).fingerprint);
    return rows;
  };
  // A valid duplicate still checks its exact body and original source records.
  await writer.transaction((session) => retainCookingRevisionInSnapshot(session, revision, sha256));
  assert.deepEqual(observed, [revision.ref.contentFingerprint]);
  observed.length = 0;
  const corruptBytes = 2 * 1024 * 1024;
  // Corruption fixture only: ordinary application writes cannot create this stored value.
  store.database.exec('PRAGMA foreign_keys=OFF');
  store.database.exec('PRAGMA ignore_check_constraints=ON');
  store.database
    .prepare(
      'UPDATE recipe_content_revision SET content_fingerprint=? WHERE recipe_id=? AND revision_id=?',
    )
    .run('x'.repeat(corruptBytes), revision.ref.recipeId, revision.ref.revisionId);
  store.database.exec('PRAGMA ignore_check_constraints=OFF');
  store.database.exec('PRAGMA foreign_keys=ON');
  await assert.rejects(
    writer.transaction((session) => retainCookingRevisionInSnapshot(session, revision, sha256)),
    /Cooking content evidence is invalid/,
  );
  assert.deepEqual(observed, [null]);
  assert.equal(
    store.database
      .prepare(
        'SELECT length(CAST(content_fingerprint AS BLOB)) bytes FROM recipe_content_revision',
      )
      .get()!.bytes,
    corruptBytes,
  );
});
