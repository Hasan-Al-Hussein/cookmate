import { createBundledContentSnapshot } from '@cookmate/catalogue/content';
import { verifySchemaCompatibility } from './schemaCompatibility';
import { readAccountCookingScope } from './cookingHistoryRows';
import { assertLegacyAccountSettledForContentMigration } from './contentMigrationAdmission';
import { recordInheritedCommandAuthoritiesForMigration } from './contentInheritedCommandAuthority';
import {
  COOKING_CONTENT_LIMITS,
  COOKING_CONTENT_RECORDS_DDL,
  COOKING_CONTENT_PINS_DDL,
  CONTENT_REBUILT_TABLES,
  CONTENT_REBUILT_INDEXES,
  contentTableDdl,
  verifyCookingContentSchema,
} from './cookingContentSchema';
import {
  contentStored,
  createLegacyCookingPinProof,
  admitCookingSessionRows,
  admitLegacyHistoryRows,
  parseLegacySessionRow,
  parseLegacyHistoryRow,
  verifyCookingPinBindings,
  readAdoptionInSnapshot,
  retainCookingRevisionInSnapshot,
  type CookingContentPin,
} from './cookingContentRepository';
import {
  runBound,
  StorageFault,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

type Baseline = Awaited<ReturnType<typeof createBundledContentSnapshot>>;
type Hash = (text: string) => Promise<string>;
const batchSize = 32;
/** Compare every original value in SQL; corrupt stored text is never copied into the JS heap. */
async function equalRows(
  session: SqlSession,
  table: string,
  columns: string[],
  rows: SqlValue[][],
) {
  contentStored(
    (await session.all<{ count: number }>(`SELECT COUNT(*) count FROM ${table}`))[0]?.count ===
      rows.length,
  );
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const group = rows.slice(offset, offset + batchSize);
    const count = (
      await session.all<{ count: number }>(
        `WITH expected(${columns.join(',')}) AS (VALUES ${group.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}) SELECT COUNT(*) count FROM expected e JOIN ${table} t ON ${columns.map((column) => `t.${column} IS e.${column}`).join(' AND ')}`,
        group.flat(),
      )
    )[0]?.count;
    contentStored(count === group.length);
  }
}
export async function verifyOriginalSources(session: SqlSession, baseline: Baseline) {
  const recipes: SqlValue[][] = [],
    ingredients: SqlValue[][] = [],
    instructions: SqlValue[][] = [],
    annotations: SqlValue[][] = [],
    evidence: SqlValue[][] = [];
  for (const revision of baseline.revisions) {
    contentStored(revision.document.kind === 'imported');
    const { recipe, provenance } = revision.document,
      source = provenance.recipeSource;
    recipes.push([
      recipe.recipeId,
      recipe.title,
      recipe.category,
      recipe.cuisine,
      recipe.rawTags,
      recipe.photoKey,
      recipe.recipePage,
      recipe.originalSourceUrl,
      recipe.videoUrl,
      source.source.row,
      source.originalImageUrl,
      source.fetchedUtc,
    ]);
    ingredients.push(
      ...recipe.ingredients.map((entry) => [
        entry.recipeId,
        entry.position,
        entry.rawName,
        entry.rawMeasure,
        entry.source.row,
        entry.source.column ?? 'D',
      ]),
    );
    instructions.push(
      ...recipe.instructions.map((entry) => [
        entry.recipeId,
        entry.sequence,
        entry.rawText,
        entry.presentation,
        entry.source.row,
        entry.source.column ?? 'D',
      ]),
    );
    recipe.annotations.forEach((entry, ordinal) => {
      annotations.push([
        entry.recipeId,
        entry.annotationId,
        entry.kind,
        entry.note,
        entry.ruleVersion,
        ordinal,
      ]);
      entry.evidence.forEach((locator, index) =>
        evidence.push([
          entry.recipeId,
          entry.annotationId,
          index,
          locator.sheet,
          locator.row,
          locator.column ?? null,
        ]),
      );
    });
  }
  await equalRows(
    session,
    'recipe',
    [
      'recipe_id',
      'title',
      'category',
      'cuisine',
      'raw_tags',
      'photo_key',
      'recipe_page',
      'original_source_url',
      'video_url',
      'source_row',
      'original_image_url',
      'fetched_utc',
    ],
    recipes,
  );
  await equalRows(
    session,
    'ingredient_entry',
    ['recipe_id', 'position', 'raw_name', 'raw_measure', 'source_row', 'source_column'],
    ingredients,
  );
  await equalRows(
    session,
    'instruction_passage',
    ['recipe_id', 'sequence', 'raw_text', 'presentation', 'source_row', 'source_column'],
    instructions,
  );
  await equalRows(
    session,
    'quality_annotation',
    ['recipe_id', 'annotation_id', 'kind', 'note', 'rule_version', 'ordinal'],
    annotations,
  );
  await equalRows(
    session,
    'annotation_evidence',
    ['recipe_id', 'annotation_id', 'ordinal', 'sheet', 'source_row', 'source_column'],
    evidence,
  );
  await equalRows(
    session,
    'catalogue_manifest',
    [
      'singleton',
      'catalogue_version',
      'fingerprint',
      'recipe_count',
      'ingredient_count',
      'instruction_count',
      'annotation_count',
    ],
    [
      [
        1,
        baseline.catalogue.version,
        baseline.catalogue.fingerprint,
        recipes.length,
        ingredients.length,
        instructions.length,
        annotations.length,
      ],
    ],
  );
}

async function insertPin(
  session: SqlSession,
  table: string,
  keyColumns: string[],
  keys: SqlValue[],
  recipeId: string,
  pin: CookingContentPin,
) {
  await runBound(
    session,
    'INSERT INTO recipe_identity VALUES (?) ON CONFLICT(recipe_id) DO NOTHING',
    [recipeId],
  );
  await runBound(
    session,
    `INSERT INTO ${table} (${keyColumns.join(',')},recipe_id,revision_id,content_fingerprint,unresolved_reason) VALUES (${keys.map(() => '?').join(',')},?,?,?,?)`,
    [
      ...keys,
      recipeId,
      pin.kind === 'exact' ? pin.ref.revisionId : null,
      pin.kind === 'exact' ? pin.ref.contentFingerprint : null,
      pin.kind === 'unresolved' ? pin.reason : null,
    ],
  );
}
async function backfillPins(session: SqlSession, sha256: Hash, ownerId: string | null) {
  const prove = createLegacyCookingPinProof(sha256);
  await session.exec(
    'INSERT INTO plan_content_pin SELECT p.occurrence_id,p.recipe_id,r.revision_id,r.content_fingerprint FROM plan_occurrence p JOIN recipe_content_revision r ON r.recipe_id=p.recipe_id',
  );
  await admitCookingSessionRows(session);
  let after = '';
  for (;;) {
    const rows = await session.all<{
      recipe_id: string;
      session_id: string;
      revision: number;
      state: string;
      updated_at: string;
      operation_id: string;
      request_fingerprint: string;
      session_json: string;
    }>('SELECT * FROM cooking_session WHERE recipe_id>? ORDER BY recipe_id LIMIT ?', [
      after,
      batchSize,
    ]);
    if (!rows.length) break;
    for (const row of rows) {
      const value = parseLegacySessionRow(row);
      await insertPin(
        session,
        'cooking_session_content_pin',
        ['session_id'],
        [value.sessionId],
        value.recipeId,
        await prove(value),
      );
    }
    after = rows.at(-1)!.recipe_id;
  }
  for (const source of ['local', 'backup', 'account'] as const) {
    const table = {
      local: 'cooking_event',
      backup: 'imported_cooking_history',
      account: 'account_cooking_history',
    }[source];
    const predicate = source === 'local' ? "state='saved'" : '1';
    await admitLegacyHistoryRows(session, source);
    let cursor = '';
    for (;;) {
      const rows = await session.all<Record<string, SqlValue>>(
        `SELECT * FROM ${table} WHERE ${predicate} AND event_id>? ORDER BY event_id LIMIT ?`,
        [cursor, batchSize],
      );
      if (!rows.length) break;
      for (const row of rows) {
        const value = parseLegacyHistoryRow(source, row, ownerId);
        await insertPin(
          session,
          {
            local: 'local_history_content_pin',
            backup: 'imported_history_content_pin',
            account: 'account_history_content_pin',
          }[source],
          source === 'account' ? ['owner_id', 'event_id'] : ['event_id'],
          source === 'account' ? [ownerId!, value.eventId] : [value.eventId],
          value.recipeId,
          await prove(value),
        );
      }
      cursor = rows.at(-1)!.event_id as string;
    }
  }
}
async function requireCompletePins(session: SqlSession) {
  for (const [parent, pin, join, filter] of [
    [
      'plan_occurrence',
      'plan_content_pin',
      'p.occurrence_id=s.occurrence_id AND p.recipe_id=s.recipe_id',
      '1',
    ],
    [
      'cooking_session',
      'cooking_session_content_pin',
      'p.recipe_id=s.recipe_id AND p.session_id=s.session_id',
      '1',
    ],
    ['cooking_event', 'local_history_content_pin', 'p.event_id=s.event_id', "p.state='saved'"],
    ['imported_cooking_history', 'imported_history_content_pin', 'p.event_id=s.event_id', '1'],
    [
      'account_cooking_history',
      'account_history_content_pin',
      'p.event_id=s.event_id AND p.owner_id=s.owner_id',
      '1',
    ],
  ])
    contentStored(
      (
        await session.all(
          `SELECT 1 FROM ${parent} p WHERE ${filter} AND NOT EXISTS (SELECT 1 FROM ${pin} s WHERE ${join}) LIMIT 1`,
        )
      ).length === 0,
    );
}

/** Explicit, inactive foundation. No initializer/runtime flag invokes this migration. */
export async function migrateCookingContentDatabase(
  writer: SerializedWriter,
  options: { sha256: Hash },
): Promise<'migrated' | 'existing'> {
  const baseline = await createBundledContentSnapshot(options.sha256);
  return writer.transaction(async (session) => {
    const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
      ?.user_version;
    if (version !== 6 && version !== 7)
      throw new StorageFault('incompatible_version', 'Cooking content requires schema six');
    if (version === 6) {
      await verifySchemaCompatibility(session, 6);
      // Existing account1/2 work must settle while its original repository can still open6.
      // Never carry a pending operation across a schema its recovery path cannot yet read.
      await assertLegacyAccountSettledForContentMigration(session, options.sha256);
    } else await verifyCookingContentSchema(session);
    contentStored((await session.all('PRAGMA foreign_key_check')).length === 0);
    await verifyOriginalSources(session, baseline);
    if (version === 7) {
      await requireCompletePins(session);
      await readAdoptionInSnapshot(session);
      await verifyCookingPinBindings(session, options.sha256);
      for (const revision of baseline.revisions) {
        contentStored(
          (
            await session.all(
              'SELECT 1 FROM recipe_content_revision WHERE recipe_id=? AND revision_id=? AND content_fingerprint=?',
              [revision.ref.recipeId, revision.ref.revisionId, revision.ref.contentFingerprint],
            )
          ).length === 1,
        );
        await retainCookingRevisionInSnapshot(session, revision, options.sha256);
      }
      return 'existing';
    }
    const account = await readAccountCookingScope(session);
    contentStored(account);
    await recordInheritedCommandAuthoritiesForMigration(session, options.sha256);
    // SQL copies retain original encoded strings and avoid materializing personal payloads.
    const columns = new Map<string, string[]>();
    const bounds = {
      favourite: 10_000,
      plan_occurrence: 20_000,
      cooking_session: 10_000,
      recipe_note: 10_000,
      personal_collection_member: 50_000,
      reference_item: 100_000,
      shopping_selection: 1000,
      shopping_contribution: 200_000,
    };
    let copiedBytes = 0;
    for (const table of CONTENT_REBUILT_TABLES) {
      contentStored(
        (await session.all<{ count: number }>(`SELECT COUNT(*) count FROM ${table}`))[0]!.count <=
          bounds[table],
      );
      columns.set(
        table,
        (await session.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(
          (column) => column.name,
        ),
      );
      copiedBytes += (
        await session.all<{ bytes: number }>(
          `SELECT COALESCE(SUM(${columns
            .get(table)!
            .map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`)
            .join('+')}),0) bytes FROM ${table}`,
        )
      )[0]!.bytes;
      contentStored(
        Number.isSafeInteger(copiedBytes) && copiedBytes <= COOKING_CONTENT_LIMITS.archiveBytes,
      );
    }
    for (const table of CONTENT_REBUILT_TABLES) {
      await session.exec(`CREATE TEMP TABLE content_copy_${table} AS SELECT * FROM ${table}`);
    }
    for (const table of [
      'shopping_contribution',
      'shopping_selection',
      ...CONTENT_REBUILT_TABLES.filter(
        (table) => table !== 'shopping_contribution' && table !== 'shopping_selection',
      ),
    ])
      await session.exec(`DROP TABLE ${table}`);
    await session.exec(COOKING_CONTENT_RECORDS_DDL);
    for (const revision of baseline.revisions)
      await retainCookingRevisionInSnapshot(session, revision, options.sha256);
    for (const table of CONTENT_REBUILT_TABLES.filter(
      (table) => table !== 'shopping_contribution' && table !== 'shopping_selection',
    )) {
      await session.exec(contentTableDdl(table));
      await session.exec(`INSERT INTO ${table} SELECT * FROM content_copy_${table}`);
    }
    await session.exec(COOKING_CONTENT_PINS_DDL);
    await backfillPins(session, options.sha256, account.ownerId);
    await session.exec(contentTableDdl('shopping_selection'));
    await session.exec(
      'INSERT INTO shopping_selection SELECT * FROM content_copy_shopping_selection',
    );
    await session.exec(contentTableDdl('shopping_contribution'));
    const contributionColumns = columns.get('shopping_contribution')!;
    await session.exec(
      `INSERT INTO shopping_contribution (${contributionColumns.join(',')},revision_id,content_fingerprint) SELECT ${contributionColumns.map((column) => `c.${column}`).join(',')},p.revision_id,p.content_fingerprint FROM content_copy_shopping_contribution c JOIN plan_content_pin p ON p.occurrence_id=c.occurrence_id AND p.recipe_id=c.recipe_id`,
    );
    await session.exec(CONTENT_REBUILT_INDEXES);
    await session.exec('INSERT INTO app_content_adoption VALUES (1,0,NULL)');
    for (const table of CONTENT_REBUILT_TABLES) {
      const selected = columns.get(table)!.join(',');
      contentStored(
        (
          await session.all(
            `SELECT 1 FROM (SELECT ${selected} FROM content_copy_${table} EXCEPT SELECT ${selected} FROM ${table}) LIMIT 1`,
          )
        ).length === 0 &&
          (
            await session.all(
              `SELECT 1 FROM (SELECT ${selected} FROM ${table} EXCEPT SELECT ${selected} FROM content_copy_${table}) LIMIT 1`,
            )
          ).length === 0,
      );
      await session.exec(`DROP TABLE content_copy_${table}`);
    }
    await requireCompletePins(session);
    contentStored((await session.all('PRAGMA foreign_key_check')).length === 0);
    await verifyCookingContentSchema(session);
    await session.exec('PRAGMA user_version=7');
    return 'migrated';
  });
}
