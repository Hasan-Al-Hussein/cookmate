import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { OverlayHead, RecipeContentRef } from '@cookmate/catalogue/content';
import type { RepositoryResult } from '@cookmate/domain';
import { openContentCookingStore } from '../../mobile/src/data/contentCookingStore';
import type { openContentReleaseStore } from '../../mobile/src/data/contentReleaseStore';
import { initializeDatabase } from '../../mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../mobile/src/data/accountContentHistoryMigration';
import { configureConnection, SerializedWriter } from '../../mobile/src/data/sql';
import { desktopConnection } from '../../../packages/domain/test/helpers/sqlite';

function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

/** Uses the actual signed/media store supplied by the private bridge integration test. */
export async function assertContentCookingStoreBridge(input: {
  directory: string;
  contentStore: Awaited<ReturnType<typeof openContentReleaseStore>>;
  head: OverlayHead;
  ref: RecipeContentRef;
  baseRef: RecipeContentRef;
  expectedTitle: string;
  media: { assetId: string; sha256: string };
  sha256(text: string): Promise<string>;
  sha256Bytes(bytes: Uint8Array): Promise<string>;
  at: string;
}) {
  const path = join(input.directory, 'composed-content-cooking.sqlite');
  const seed = desktopConnection(path);
  await configureConnection(seed.connection);
  const writer = new SerializedWriter(seed.connection);
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  try {
    await initializeDatabase(
      writer,
      {
        identity: catalogue.identity,
        recipes: catalogue.recipes,
        recipeSources: catalogueProvenance.recipeSources,
      },
      ids,
      {
        enablePortableRestore: true,
        enableCooking: true,
        enablePersonal: true,
        enableAccountHistory: true,
      },
    );
    await migrateCookingContentDatabase(writer, { sha256: input.sha256 });
    await migrateAccountContentHistoryDatabase(writer, { sha256: input.sha256 });
  } finally {
    await writer.close();
  }
  let access = { ownerId: null, authGeneration: 1 };
  const options: Parameters<typeof openContentCookingStore>[0] = {
    schemaVersion: 8,
    installationId: ids.installationId,
    async openConnection() {
      return desktopConnection(path).connection;
    },
    contentStore: input.contentStore,
    platform: { newId: randomUUID, sha256: input.sha256 },
    now: () => input.at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    getAccess: () => access,
    assertAccess(scope) {
      assert.deepEqual(scope, access);
      return undefined;
    },
  };
  let store = await openContentCookingStore(options);
  const observer = desktopConnection(path);
  try {
    async function plan(day: string) {
      const review = ready(
        await store.commands.reviewDirect({
          kind: 'placeRecipe',
          recipeId: input.ref.recipeId,
          placement: { actualDate: day, mealKey: 'dinner' },
        }),
      );
      const command = ready(await store.commands.prepareDirect(review));
      assert.equal((await store.commands.execute(command)).kind, 'receipt');
      return command;
    }
    await plan('2026-10-04');
    const prior = observer.database.prepare('SELECT * FROM plan_content_pin').all();
    assert.equal(prior[0]!.content_fingerprint, input.baseRef.contentFingerprint);
    const review = await store.adoption.review({ candidateHead: input.head });
    let laterCalls = 0;
    store.subscribe((change) => {
      if (change.kind === 'adoption') access = { ownerId: null, authGeneration: 2 };
    });
    store.subscribe(() => {
      laterCalls++;
    });
    await assert.rejects(store.adoption.adopt(review), { code: 'storage_failure' });
    assert.equal(laterCalls, 0);
    assert.equal(
      observer.database.prepare('SELECT COUNT(*) n FROM content_adoption_operation').get()!.n,
      1,
    );
    assert.deepEqual(observer.database.prepare('SELECT * FROM plan_content_pin').all(), prior);
    await store.close();
    store = await openContentCookingStore(options);
    const recovered = await store.adoption.recover({
      installationId: review.installationId,
      ownerId: review.ownerId,
      operationId: review.operationId,
      requestFingerprint: review.requestFingerprint,
    });
    assert.equal(recovered?.status, 'adopted_in_cooking_store');
    assert.deepEqual(recovered?.head, input.head);
    const current = await store.content.readCurrent(input.ref.recipeId);
    assert.deepEqual(current.head, input.head);
    assert.equal(current.value.kind, 'readable');
    if (current.value.kind !== 'readable') assert.fail();
    assert.equal(current.value.recipe.title, input.expectedTitle);
    assert.deepEqual(current.value.recipe.contentRef, input.ref);
    const photo = await store.content.readPhoto(input.ref, input.media.assetId);
    assert.equal(await input.sha256Bytes(photo.value.bytes), input.media.sha256);
    const command = await plan('2026-10-05');
    const pins = observer.database.prepare('SELECT * FROM plan_content_pin').all();
    assert.equal(pins.length, 2);
    assert.ok(pins.some((pin) => pin.content_fingerprint === input.baseRef.contentFingerprint));
    assert.ok(pins.some((pin) => pin.content_fingerprint === input.ref.contentFingerprint));
    const savedPlan = ready(await store.queries.readPlan('2026-10-04', '2026-10-05'));
    assert.equal(savedPlan.occurrences.length, 2);
    assert.deepEqual(savedPlan.occurrences[0]!.contentRef, input.baseRef);
    assert.deepEqual(savedPlan.occurrences[1]!.contentRef, input.ref);
    assert.equal(savedPlan.occurrences[0]!.content.kind, 'readable');
    const publishedRow = savedPlan.occurrences[1]!.content;
    assert.equal(publishedRow.kind, 'readable');
    if (publishedRow.kind !== 'readable') assert.fail();
    assert.equal(publishedRow.title, input.expectedTitle);
    assert.equal(publishedRow.photoAssetId, input.media.assetId);
    const selection = ready(
      await store.commands.reviewDirect({
        kind: 'setShoppingSelection',
        occurrenceIds: savedPlan.occurrences.map((item) => item.occurrence.occurrenceId),
      }),
    );
    const selectionCommand = ready(await store.commands.prepareDirect(selection));
    assert.equal((await store.commands.execute(selectionCommand)).kind, 'receipt');
    const shopping = ready(await store.queries.readShopping());
    assert.equal(shopping.kind, 'current');
    if (shopping.kind !== 'current') assert.fail();
    assert.equal(shopping.selected.length, 2);
    const contributions = shopping.snapshot.groups.flatMap((group) => group.contributions);
    assert.ok(
      contributions.some(
        (part) => part.contentRef.contentFingerprint === input.baseRef.contentFingerprint,
      ),
    );
    assert.ok(
      contributions.some(
        (part) => part.contentRef.contentFingerprint === input.ref.contentFingerprint,
      ),
    );
    assert.ok(ready(await store.commands.recover(command)));
    assert.equal((await store.content.readExact(input.baseRef)).value.kind, 'readable');
    assert.deepEqual(observer.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await store.close();
    await observer.connection.close();
  }
}
