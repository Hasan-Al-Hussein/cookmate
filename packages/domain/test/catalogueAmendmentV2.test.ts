import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueProvenance, createCatalogue } from '@cookmate/catalogue';
import type { PlanOccurrence } from '@cookmate/contracts';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { configureConnection, runBound, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { buildShoppingProjection } from '../src/shoppingProjection';
import { shiftPlanDate } from '../src/dates';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';
import historical from './fixtures/source-amendment-v1.json';

const oldCatalogue = createCatalogue(historical);
const seed = {
  identity: catalogue.identity,
  recipes: catalogue.recipes,
  recipeSources: catalogueProvenance.recipeSources,
};
const oldSeed = { ...seed, identity: oldCatalogue.identity, recipes: oldCatalogue.recipes };
const identifiers = () => ({
  installationId: randomUUID(),
  shoppingScopeId: randomUUID(),
  conversationId: randomUUID(),
});
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');

test('v2 fresh disposable seed has 20 notes while the preserved v1 fixture has 17', async () => {
  const baselineBytes = await readFile(
    new URL('./fixtures/source-amendment-v1.json', import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(baselineBytes).digest('hex'),
    'f153eb9e31928233602109a2cbae5d7598475d7dc5f641d9b47074fac8062193',
  );
  assert.equal(catalogue.identity.version, 'cookmate-2026-09-28.v2');
  assert.equal(oldCatalogue.identity.version, 'cookmate-2026-09-27.v1');
  assert.equal(
    oldCatalogue.identity.fingerprint,
    '1c564aed197f0ff13e0c8a81c95d775960f8c7f021cd3e948f116ae471b5e1ef',
  );
  assert.notEqual(catalogue.identity.fingerprint, oldCatalogue.identity.fingerprint);
  assert.equal(oldCatalogue.recipes.flatMap((recipe) => recipe.annotations).length, 17);
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    assert.equal(await initializeDatabase(writer, seed, identifiers()), 'created');
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM quality_annotation').get()?.count,
      20,
    );
    assert.equal(await initializeDatabase(writer, seed, identifiers()), 'existing');
  } finally {
    await writer.close();
  }
});

test('real v1 state rejects v2 and either identity mismatch without changing the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-amendment-'));
  const path = join(directory, 'retained.db');
  let fixture = desktopConnection(path);
  await configureConnection(fixture.connection);
  let writer = new SerializedWriter(fixture.connection);
  const snapshot = () =>
    fixture.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((table) => ({
        name: table.name,
        rows: fixture.database
          .prepare(`SELECT * FROM "${String(table.name).replaceAll('"', '""')}"`)
          .all(),
      }));
  try {
    await initializeDatabase(writer, oldSeed, identifiers());
    await writer.transaction(async (tx) => {
      await runBound(tx, 'INSERT INTO favourite VALUES (?, 1, 1, ?, ?)', [
        '53064',
        '2026-09-28T00:00:00.000Z',
        '2026-09-28T00:00:00.000Z',
      ]);
      await runBound(tx, 'INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)', [
        randomUUID(),
        randomUUID(),
        'a'.repeat(64),
        'committed',
        '2026-09-28T00:00:00.000Z',
        'unchanged',
        '[]',
      ]);
    });
    const before = snapshot();
    await writer.close();
    const bytesBefore = await readFile(path);
    fixture = desktopConnection(path);
    await configureConnection(fixture.connection);
    writer = new SerializedWriter(fixture.connection);
    for (const incompatible of [
      seed,
      { ...oldSeed, identity: { ...oldSeed.identity, version: seed.identity.version } },
      { ...oldSeed, identity: { ...oldSeed.identity, fingerprint: seed.identity.fingerprint } },
    ]) {
      await assert.rejects(
        initializeDatabase(writer, incompatible, identifiers()),
        /Stored and bundled catalogues differ/,
      );
      assert.deepEqual(snapshot(), before);
      assert.equal(fixture.database.prepare('PRAGMA user_version').get()?.user_version, 2);
    }
    assert.equal(await initializeDatabase(writer, oldSeed, identifiers()), 'existing');
    assert.deepEqual(snapshot(), before);
    await writer.close();
    assert.deepEqual(await readFile(path), bytesBefore);
  } finally {
    await writer.close();
    await removeFixtureDirectory(directory);
  }
});

test('v2 keeps the complete v1 shopping projection including every quantity and demand identity', async () => {
  const occurrences: PlanOccurrence[] = catalogue.recipes.map((recipe, index) => ({
    occurrenceId: randomUUID(),
    recipeId: recipe.recipeId,
    placement: {
      actualDate: shiftPlanDate('2026-09-28', Math.floor(index / 3))!,
      mealKey: (['breakfast', 'lunch', 'dinner'] as const)[index % 3]!,
    },
    revision: 1,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  }));
  const previous = await buildShoppingProjection(occurrences, {
    readRecipe: oldCatalogue.getRecipe,
    sha256,
  });
  const current = await buildShoppingProjection(occurrences, {
    readRecipe: catalogue.getRecipe,
    sha256,
  });
  assert.deepEqual(current, previous);
  assert.equal(current.length, 601);
  const contributions = current.flatMap((group) => group.contributions);
  assert.equal(contributions.length, 966);
  assert.equal(contributions.filter((entry) => entry.quantity.kind === 'review_source').length, 6);
});
