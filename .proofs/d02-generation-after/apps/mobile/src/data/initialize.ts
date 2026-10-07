import { DATABASE_SCHEMA_VERSION, validateRecipe } from '@cookmate/contracts';
import type { CatalogueIdentity, Recipe } from '@cookmate/contracts';
import type { Immutable } from '@cookmate/domain';
import type { RecipeProvenance } from '@cookmate/catalogue';
import { SCHEMA_V2 } from './schema';
import { verifySchemaCompatibility } from './schemaCompatibility';
import { runBound, StorageFault } from './sql';
import type { SerializedWriter, SqlSession, SqlValue } from './sql';
import { encodeStoredText } from './storedText';

export interface CatalogueSeed {
  identity: CatalogueIdentity;
  recipes: readonly Immutable<Recipe>[];
  recipeSources: readonly RecipeProvenance[];
}
export interface InitialIdentifiers {
  installationId: string;
  shoppingScopeId: string;
  conversationId: string;
}

async function insertRows(
  session: SqlSession,
  sql: string,
  rows: readonly (readonly SqlValue[])[],
): Promise<void> {
  const statement = await session.prepare(sql);
  try {
    for (const row of rows) await statement.run(row);
  } finally {
    await statement.finalize();
  }
}

function counts(seed: CatalogueSeed) {
  return {
    recipes: seed.recipes.length,
    ingredients: seed.recipes.reduce((total, recipe) => total + recipe.ingredients.length, 0),
    instructions: seed.recipes.reduce((total, recipe) => total + recipe.instructions.length, 0),
    annotations: seed.recipes.reduce((total, recipe) => total + recipe.annotations.length, 0),
  };
}

function validateSeed(seed: CatalogueSeed): void {
  const count = counts(seed);
  if (
    count.recipes !== 100 ||
    count.ingredients !== 960 ||
    count.instructions !== 706 ||
    !/^[0-9a-f]{64}$/.test(seed.identity.fingerprint)
  )
    throw new StorageFault('incompatible_version', 'Unsupported source catalogue');
  const ids = new Set<string>();
  const sourceRows = new Set<number>();
  for (const recipe of seed.recipes) {
    if (!validateRecipe(recipe) || ids.has(recipe.recipeId))
      throw new StorageFault('incompatible_version', 'Invalid source catalogue');
    ids.add(recipe.recipeId);
    const source = seed.recipeSources.find((item) => item.recipeId === recipe.recipeId);
    if (
      !source ||
      source.source.sheet !== 'Recipes' ||
      sourceRows.has(source.source.row) ||
      source.declaredIngredientEntries !== recipe.ingredients.length
    )
      throw new StorageFault('incompatible_version', 'Invalid recipe provenance');
    sourceRows.add(source.source.row);
    recipe.ingredients.forEach((entry, index) => {
      if (entry.recipeId !== recipe.recipeId || entry.position !== index + 1)
        throw new StorageFault('incompatible_version', 'Invalid source ingredient order');
    });
    recipe.instructions.forEach((entry, index) => {
      if (entry.recipeId !== recipe.recipeId || entry.sequence !== index + 1)
        throw new StorageFault('incompatible_version', 'Invalid source instruction order');
    });
    for (const annotation of recipe.annotations) {
      if (annotation.recipeId !== recipe.recipeId)
        throw new StorageFault('incompatible_version', 'Invalid annotation owner');
      for (const locator of annotation.evidence) {
        const belongs =
          locator.sheet === 'Recipes'
            ? locator.row === source.source.row
            : locator.sheet === 'Ingredients'
              ? recipe.ingredients.some((entry) => entry.source.row === locator.row)
              : recipe.instructions.some((entry) => entry.source.row === locator.row);
        if (!belongs)
          throw new StorageFault('incompatible_version', 'Invalid annotation evidence owner');
      }
    }
  }
}

async function verifyStoredSeed(session: SqlSession, seed: CatalogueSeed): Promise<void> {
  const expected = counts(seed);
  const actual = (
    await session.all<{
      recipes: number;
      ingredients: number;
      instructions: number;
      annotations: number;
    }>(
      'SELECT (SELECT COUNT(*) FROM recipe) AS recipes, (SELECT COUNT(*) FROM ingredient_entry) AS ingredients, (SELECT COUNT(*) FROM instruction_passage) AS instructions, (SELECT COUNT(*) FROM quality_annotation) AS annotations',
    )
  )[0];
  if (
    !actual ||
    Object.keys(expected).some(
      (key) => actual[key as keyof typeof actual] !== expected[key as keyof typeof expected],
    )
  )
    throw new StorageFault('migration_failure', 'Stored catalogue counts are inconsistent');
  if ((await session.all('PRAGMA foreign_key_check')).length > 0)
    throw new StorageFault('migration_failure', 'Stored relationships are invalid');
}

export async function initializeDatabase(
  writer: SerializedWriter,
  seed: CatalogueSeed,
  identifiers: InitialIdentifiers,
): Promise<'created' | 'existing'> {
  validateSeed(seed);
  if (
    new Set(Object.values(identifiers)).size !== 3 ||
    Object.values(identifiers).some(
      (id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
    )
  )
    throw new StorageFault('storage_failure', 'Invalid installation identities');
  return writer.transaction(async (session) => {
    const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
      ?.user_version;
    if (version === DATABASE_SCHEMA_VERSION) {
      await verifySchemaCompatibility(session);
      const manifest = (
        await session.all<{ catalogue_version: string; fingerprint: string }>(
          'SELECT catalogue_version, fingerprint FROM catalogue_manifest WHERE singleton = 1',
        )
      )[0];
      if (
        !manifest ||
        manifest.catalogue_version !== seed.identity.version ||
        manifest.fingerprint !== seed.identity.fingerprint
      )
        throw new StorageFault('incompatible_version', 'Stored and bundled catalogues differ');
      await verifyStoredSeed(session, seed);
      return 'existing';
    }
    if (version !== 0)
      throw new StorageFault('incompatible_version', 'Unsupported database schema version');
    const existingTables = await session.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    if (existingTables.length > 0)
      throw new StorageFault(
        'incompatible_version',
        'Unversioned database contains existing state',
      );
    await session.exec(SCHEMA_V2);
    await verifySchemaCompatibility(session);
    const provenance = new Map(seed.recipeSources.map((item) => [item.recipeId, item]));
    await insertRows(
      session,
      'INSERT INTO recipe VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      seed.recipes.map((recipe) => {
        const source = provenance.get(recipe.recipeId)!;
        return [
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
        ];
      }),
    );
    await insertRows(
      session,
      'INSERT INTO ingredient_entry VALUES (?, ?, ?, ?, ?, ?)',
      seed.recipes.flatMap((recipe) =>
        recipe.ingredients.map((entry) => [
          entry.recipeId,
          entry.position,
          entry.rawName,
          entry.rawMeasure,
          entry.source.row,
          entry.source.column ?? 'D',
        ]),
      ),
    );
    await insertRows(
      session,
      'INSERT INTO instruction_passage VALUES (?, ?, ?, ?, ?, ?)',
      seed.recipes.flatMap((recipe) =>
        recipe.instructions.map((entry) => [
          entry.recipeId,
          entry.sequence,
          entry.rawText,
          entry.presentation,
          entry.source.row,
          entry.source.column ?? 'D',
        ]),
      ),
    );
    await insertRows(
      session,
      'INSERT INTO quality_annotation VALUES (?, ?, ?, ?, ?, ?)',
      seed.recipes.flatMap((recipe) =>
        recipe.annotations.map((entry, ordinal) => [
          entry.recipeId,
          entry.annotationId,
          entry.kind,
          entry.note,
          entry.ruleVersion,
          ordinal,
        ]),
      ),
    );
    await insertRows(
      session,
      'INSERT INTO annotation_evidence VALUES (?, ?, ?, ?, ?, ?)',
      seed.recipes.flatMap((recipe) =>
        recipe.annotations.flatMap((entry) =>
          entry.evidence.map((locator, ordinal) => [
            entry.recipeId,
            entry.annotationId,
            ordinal,
            locator.sheet,
            locator.row,
            locator.column ?? null,
          ]),
        ),
      ),
    );
    await insertRows(
      session,
      'INSERT INTO state_revision VALUES (?, ?)',
      ['store', 'favourites', 'plan', 'shopping', 'preferences', 'conversation'].map(
        (collection) => [collection, 0],
      ),
    );
    await runBound(session, 'INSERT INTO shopping_scope VALUES (?, 1, 0, 0, ?)', [
      identifiers.shoppingScopeId,
      'current',
    ]);
    await runBound(session, 'INSERT INTO conversation VALUES (?, 1, 0, ?, 0)', [
      identifiers.conversationId,
      encodeStoredText(''),
    ]);
    await runBound(session, 'INSERT INTO conversation_memory_state VALUES (?, 0, 0, NULL, ?)', [
      identifiers.conversationId,
      '[]',
    ]);
    await session.exec('INSERT INTO preference_state VALUES (1, NULL)');
    await runBound(session, 'INSERT INTO app_metadata VALUES (?, ?)', [
      'installation_id',
      identifiers.installationId,
    ]);
    await verifyStoredSeed(session, seed);
    const count = counts(seed);
    await runBound(session, 'INSERT INTO catalogue_manifest VALUES (1, ?, ?, ?, ?, ?, ?)', [
      seed.identity.version,
      seed.identity.fingerprint,
      count.recipes,
      count.ingredients,
      count.instructions,
      count.annotations,
    ]);
    await session.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    return 'created';
  });
}
