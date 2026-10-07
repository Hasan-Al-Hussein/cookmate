import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { formatContentShoppingShare } from '../../mobile/src/features/shopping/shoppingShareText';
import { readCompleteManualShopping } from '../../mobile/src/features/shopping/readShoppingShareManual';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import type { RepositoryResult } from '@cookmate/domain';
import type { ContentCookedRecoveryReference } from '../../mobile/src/data/contentCookingHistoryRecords';
import {
  openContentReleaseStore,
  type ContentVerificationPorts,
  type ContentReleaseStageInput,
} from '../../mobile/src/data/contentReleaseStore';
import { openContentCookingStore } from '../../mobile/src/data/contentCookingStore';
import { initializeDatabase } from '../../mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../mobile/src/data/accountContentHistoryMigration';
import { configureConnection, SerializedWriter } from '../../mobile/src/data/sql';
import { createContentWorkspaceHost } from '../../mobile/src/features/content/contentWorkspaceHost';
import { createOrdinaryContentWorkspace } from '../../mobile/src/features/content/ordinaryContentWorkspace';
import {
  createContentOrdinaryCatalogue,
  type OrdinaryCatalogueController,
} from '../../mobile/src/features/content/ordinaryCatalogueState';
import { createLocalContentUpdateJournal } from '../../mobile/src/features/content/contentUpdateJournal';
import { openPrivateContentRuntime } from '../../mobile/src/features/content/privateContentRuntime';
import {
  privateContentDatabaseNames,
  readPrivateContentConfiguration,
} from '../../mobile/src/features/content/privateContentConfig';
import type { ContentTrustKey } from '@cookmate/catalogue/content-trust';
import { desktopConnection } from '../../../packages/domain/test/helpers/sqlite';

function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

async function ordinaryReady(reader: OrdinaryCatalogueController) {
  if (reader.getSnapshot().kind === 'loading')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error('Ordinary catalogue did not settle'));
      }, 5_000);
      const stop = reader.subscribe(() => {
        if (reader.getSnapshot().kind === 'loading') return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  const snapshot = reader.getSnapshot();
  if (snapshot.kind !== 'ready') assert.fail(`Ordinary catalogue: ${snapshot.kind}`);
  return snapshot;
}
async function actionRecoveryReady(adapter: ReturnType<typeof createOrdinaryContentWorkspace>) {
  const complete = () => {
    const state = adapter.getSnapshot();
    return state.kind !== 'ready' || state.recoveryState.kind !== 'loading';
  };
  if (!complete())
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error('Content action recovery did not settle'));
      }, 5_000);
      const stop = adapter.subscribe(() => {
        if (!complete()) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  const state = adapter.getSnapshot();
  if (state.kind !== 'ready' || state.recoveryState.kind !== 'ready')
    assert.fail('Content action recovery unavailable');
  return state;
}
/** Actual separate SQLite caches, signed bytes and file-backed journal; no browser/service claim. */
export async function assertContentWorkspaceHostBridge(input: {
  directory: string;
  ports: ContentVerificationPorts;
  stage: ContentReleaseStageInput;
  ref: RecipeContentRef;
  baseRef: RecipeContentRef;
  expectedTitle: string;
  expectedTranslation?: { title: string; translationId: string; translationRevision: number };
  at: string;
  trustKeys: readonly ContentTrustKey[];
}) {
  const journalPath = join(input.directory, 'private-host-pending.json');
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  const names = privateContentDatabaseNames(ids.installationId);
  const cookingPath = join(input.directory, names.cooking);
  const contentPath = join(input.directory, names.content);
  const seed = desktopConnection(cookingPath);
  await configureConnection(seed.connection);
  const writer = new SerializedWriter(seed.connection);
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
    await migrateCookingContentDatabase(writer, { sha256: input.ports.sha256 });
    await migrateAccountContentHistoryDatabase(writer, { sha256: input.ports.sha256 });
  } finally {
    await writer.close();
  }
  let access = { ownerId: null, authGeneration: 1 };
  const listeners = new Set<() => void>();
  const journal = createLocalContentUpdateJournal(ids.installationId, null, {
    async read() {
      try {
        return await readFile(journalPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(_key, value) {
      await writeFile(journalPath, value, 'utf8');
    },
    async remove() {
      try {
        await unlink(journalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  });
  const originalEventId = randomUUID();
  const originalNote = 'Disposable cooking note for the original recipe revision.';
  const recipeNoteId = randomUUID();
  const recipeNote = 'Disposable private recipe reminder, separate from the cooking event.';
  const editedRecipeNote = `${recipeNote} Edited after publication.`;
  const manualItemId = randomUUID();
  const sessionId = randomUUID();
  const cookedEventId = randomUUID();
  const newCookedNote = 'Disposable deliberate cooked event for the adopted revision.';
  let cookedRecovery: Readonly<ContentCookedRecoveryReference> | undefined;
  const collectionId = randomUUID();
  const collectionName = 'Disposable recipe collection';
  const renamedCollectionName = 'Disposable collection after publication';
  const manualFields = {
    name: 'Disposable household extra',
    amountText: '1',
    unitText: 'box',
    category: 'other' as const,
  };
  let initialHistoryWritten = false;
  async function open() {
    const delivery = await openContentReleaseStore({
      ...input.ports,
      now: () => new Date(input.at),
      readConnection: desktopConnection(contentPath).connection,
      writeConnection: desktopConnection(contentPath).connection,
    });
    const cooking = await openContentCookingStore({
      schemaVersion: 8,
      installationId: ids.installationId,
      openConnection: async () => desktopConnection(cookingPath).connection,
      contentStore: delivery,
      platform: { newId: randomUUID, sha256: input.ports.sha256 },
      now: () => input.at,
      dateContext: () => ({
        localDate: '2026-10-01',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      getAccess: () => access,
      assertAccess: (scope) => {
        assert.deepEqual(scope, access);
        return undefined;
      },
    });
    if (!initialHistoryWritten) {
      // An actual saved cooking event predates publication. Once ownership transfers
      // below, every history read/clear goes through the same normal-app host.
      const saved = await cooking.cooked.saveCooked({
        eventId: originalEventId,
        contentRef: input.baseRef,
        expectedHistoryEpoch: 0,
        cookedOn: '2026-10-01',
        timeZone: 'Asia/Dubai',
        note: originalNote,
      });
      assert.equal(saved.kind, 'ready', JSON.stringify(saved));
      if (saved.kind !== 'ready') assert.fail();
      assert.equal(saved.value.kind, 'saved');
      initialHistoryWritten = true;
    }
    return createContentWorkspaceHost({
      cooking,
      delivery,
      journal,
      instanceId: randomUUID(),
      newId: randomUUID,
      getAccess: () => access,
      subscribeAccess: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  }
  let host = await open();
  let ordinary: OrdinaryCatalogueController | undefined;
  let ordinaryActions: ReturnType<typeof createOrdinaryContentWorkspace> | undefined;
  const observer = desktopConnection(cookingPath);
  try {
    const noteBefore = ready(await host.notes.readRecipeNote(input.baseRef.recipeId));
    const savedNote = await host.notes.execute({
      kind: 'saveNote',
      operationId: randomUUID(),
      noteId: recipeNoteId,
      recipeId: input.baseRef.recipeId,
      expectedEpoch: noteBefore.epoch,
      expectedRevision: null,
      text: recipeNote,
    });
    assert.equal(savedNote.kind, 'ready', JSON.stringify(savedNote));
    if (savedNote.kind !== 'ready') assert.fail();
    assert.equal(savedNote.value.outcome, 'committed');
    const manualBefore = ready(await host.manual.readManualShopping());
    const addedManual = await host.manual.execute({
      kind: 'addManualItem',
      operationId: randomUUID(),
      expectedEpoch: manualBefore.epoch,
      itemId: manualItemId,
      fields: manualFields,
    });
    assert.equal(addedManual.kind, 'ready', JSON.stringify(addedManual));
    const newlyAdded = ready(await host.manual.readManualShopping());
    assert.equal(newlyAdded.total, 1);
    const purchasedManual = await host.manual.execute({
      kind: 'setManualPurchased',
      operationId: randomUUID(),
      expectedEpoch: newlyAdded.epoch,
      itemId: manualItemId,
      expectedRevision: newlyAdded.items[0]!.revision,
      purchased: true,
    });
    assert.equal(purchasedManual.kind, 'ready', JSON.stringify(purchasedManual));
    const collectionBefore = ready(await host.collections.readCollections());
    const createdCollection = await host.collections.execute({
      kind: 'createCollection',
      operationId: randomUUID(),
      expectedEpoch: collectionBefore.epoch,
      collectionId,
      name: collectionName,
    });
    assert.equal(createdCollection.kind, 'ready', JSON.stringify(createdCollection));
    const newCollection = ready(await host.collections.readCollection(collectionId));
    const membership = await host.collections.execute({
      kind: 'setCollectionMembership',
      operationId: randomUUID(),
      expectedEpoch: newCollection.epoch,
      collectionId,
      recipeId: input.baseRef.recipeId,
      expectedCollectionRevision: newCollection.collection.revision,
      expectedRevision: null,
      present: true,
    });
    assert.equal(membership.kind, 'ready', JSON.stringify(membership));
    const deletionBeforeAdoption = ready(
      await host.collections.reviewDeleteCollection(collectionId),
    );
    const reviewed = ready(
      await host.commands.reviewDirect({
        kind: 'placeRecipe',
        recipeId: input.ref.recipeId,
        placement: { actualDate: '2026-10-06', mealKey: 'dinner' },
      }),
    );
    const command = ready(await host.commands.prepareDirect(reviewed));
    assert.equal((await host.commands.execute(command)).kind, 'receipt');
    const pinnedBefore = ready(await host.queries.readPlan('2026-10-06', '2026-10-06'));
    const initialReading = await host.content.readExact(input.baseRef);
    assert.equal(initialReading.value.kind, 'readable');
    if (initialReading.value.kind !== 'readable') assert.fail();
    const progressRequest = {
      operationId: randomUUID(),
      sessionId,
      contentRef: input.baseRef,
      expectedRevision: null,
      passageSequence: initialReading.value.recipe.instructions[0]!.sequence,
    };
    const initialProgress = await host.sessions.saveSession(progressRequest);
    assert.equal(initialProgress.kind, 'ready', JSON.stringify(initialProgress));
    if (initialProgress.kind !== 'ready') assert.fail();
    assert.equal(ready(await host.sessions.readResumeSession())?.resume, 'exact');
    assert.equal(
      ready(await host.history.readHistory()).items.length,
      1,
      'reading creates no cooked event',
    );
    assert.deepEqual(pinnedBefore.occurrences[0]!.contentRef, input.baseRef);
    await host.delivery.stage(input.stage);
    const releaseReview = await host.delivery.review(input.stage.stageId);
    assert.equal(releaseReview.retainedRefCount, 1);
    const activated = await host.delivery.activate(releaseReview);
    assert.equal(activated.status, 'activated_in_content_store');
    assert.equal(host.getSnapshot().status, 'result_ready');
    assert.equal(
      (JSON.parse(await readFile(journalPath, 'utf8')) as { operationId: string }).operationId,
      activated.operationId,
    );
    assert.equal(
      observer.database.prepare('SELECT head_json FROM app_content_adoption').get()!.head_json,
      null,
    );
    await host.acknowledgeUpdate();
    assert.equal((await host.content.readCurrent(input.ref.recipeId)).head, null);
    const adoption = await host.adoption.review({ candidateHead: activated.head });
    assert.equal(adoption.preservedPlanCount, 1);
    const adopted = await host.adoption.adopt(adoption);
    assert.equal(adopted.status, 'adopted_in_cooking_store');
    // Simulate a consumer closing before acknowledgement, then recover from the real disk identity.
    await host.close();
    host = await open();
    assert.equal(host.getSnapshot().status, 'recovery_required');
    const recovered = await host.recoverUpdate();
    assert.equal(recovered?.status, 'adopted_in_cooking_store');
    assert.equal(recovered?.operationId, adopted.operationId);
    await host.acknowledgeUpdate();
    const recipe = await host.content.readCurrent(input.ref.recipeId);
    const retainedProgress = ready(await host.sessions.readResumeSession());
    assert.equal(retainedProgress?.resume, 'exact');
    assert.deepEqual(retainedProgress?.recipe?.contentRef, input.baseRef);
    assert.deepEqual(
      ready(await host.sessions.recover({ kind: 'save', input: progressRequest })),
      initialProgress.value,
    );
    assert.equal(recipe.value.kind, 'readable');
    if (recipe.value.kind !== 'readable') assert.fail();
    assert.equal(recipe.value.recipe.title, input.expectedTitle);
    if (input.expectedTranslation) {
      const translation = recipe.value.recipe.translations?.[0];
      assert.equal(translation?.content.title, input.expectedTranslation.title);
      assert.equal(translation?.translationId, input.expectedTranslation.translationId);
      assert.equal(translation?.translationRevision, input.expectedTranslation.translationRevision);
      assert.deepEqual(translation?.sourceRef, input.ref);
    }
    assert.deepEqual(recipe.value.recipe.contentRef, input.ref);
    const retainedCollection = ready(await host.collections.readCollection(collectionId));
    assert.equal(retainedCollection.collection.name, collectionName);
    assert.equal(retainedCollection.items.length, 1);
    assert.equal(retainedCollection.items[0]!.recipeId, input.ref.recipeId);
    assert.equal(retainedCollection.items[0]!.present, true);
    const narrowMemberships = ready(
      await host.collections.readRecipeMemberships(input.ref.recipeId),
    );
    assert.deepEqual(Object.keys(narrowMemberships).sort(), ['epoch', 'memberships']);
    assert.equal(narrowMemberships.memberships[0]!.collectionId, collectionId);
    assert.equal(
      (await host.collections.deleteCollection(deletionBeforeAdoption, randomUUID())).kind,
      'failed',
    );
    const renameCollection = {
      kind: 'renameCollection',
      operationId: randomUUID(),
      expectedEpoch: retainedCollection.epoch,
      collectionId,
      expectedRevision: retainedCollection.collection.revision,
      name: renamedCollectionName,
    } as const;
    const renamedCollection = await host.collections.execute(renameCollection);
    assert.equal(renamedCollection.kind, 'ready', JSON.stringify(renamedCollection));
    assert.deepEqual(await host.collections.execute(renameCollection), renamedCollection);
    assert.equal((await host.content.readExact(input.baseRef)).value.kind, 'readable');
    assert.deepEqual(
      ready(await host.queries.readPlan('2026-10-06', '2026-10-06')).occurrences[0]!.contentRef,
      input.baseRef,
    );
    const originalHistory = ready(await host.history.readHistory({ limit: 20 }));
    assert.equal(originalHistory.items.length, 1);
    assert.equal(originalHistory.items[0]!.entry.eventId, originalEventId);
    assert.equal(originalHistory.items[0]!.entry.note, originalNote);
    assert.deepEqual(originalHistory.items[0]!.pin, { kind: 'exact', ref: input.baseRef });
    assert.equal(ready(await host.readInstallationId()), ids.installationId);
    // A recipe note belongs to its identity; publication must neither overwrite it
    // nor mistake it for the private note stored on the historical cooking event.
    const retainedNote = ready(await host.notes.readRecipeNote(input.ref.recipeId));
    assert.equal(retainedNote.note?.noteId, recipeNoteId);
    assert.equal(retainedNote.note?.text, recipeNote);
    const editNote = {
      kind: 'saveNote' as const,
      operationId: randomUUID(),
      noteId: recipeNoteId,
      recipeId: input.ref.recipeId,
      expectedEpoch: retainedNote.epoch,
      expectedRevision: retainedNote.note!.revision,
      text: editedRecipeNote,
    };
    const editedNote = await host.notes.execute(editNote);
    assert.equal(editedNote.kind, 'ready', JSON.stringify(editedNote));
    if (editedNote.kind !== 'ready') assert.fail();
    assert.equal(editedNote.value.outcome, 'committed');
    assert.deepEqual(await host.notes.execute(editNote), editedNote);
    assert.deepEqual(ready(await host.notes.readReceipt(editNote.operationId)), editedNote.value);
    assert.equal(ready(await host.history.readHistory()).items[0]!.entry.note, originalNote);
    const retainedManual = ready(await host.manual.readManualShopping());
    assert.equal(retainedManual.total, 1);
    assert.equal(retainedManual.items[0]!.itemId, manualItemId);
    assert.equal(retainedManual.items[0]!.name, manualFields.name);
    assert.equal(retainedManual.items[0]!.amountText, '1');
    assert.equal(retainedManual.items[0]!.purchased, true);
    const editManual = {
      kind: 'editManualItem' as const,
      operationId: randomUUID(),
      expectedEpoch: retainedManual.epoch,
      itemId: manualItemId,
      expectedRevision: retainedManual.items[0]!.revision,
      fields: { ...manualFields, amountText: '2' },
    };
    const changedManual = await host.manual.execute(editManual);
    assert.equal(changedManual.kind, 'ready', JSON.stringify(changedManual));
    if (changedManual.kind !== 'ready') assert.fail();
    assert.deepEqual(await host.manual.execute(editManual), changedManual);
    assert.deepEqual(
      ready(await host.manual.readReceipt(editManual.operationId)),
      changedManual.value,
    );
    assert.equal(ready(await host.manual.readManualShopping()).items[0]!.purchased, false);
    const media = recipe.value.recipe.media[0]!;
    assert.equal(
      (await host.content.readPhoto(input.ref, media.assetId)).value.sha256,
      media.sha256,
    );
    // The actual normal Discover reader consumes the reopened, signed/adopted host.
    // No catalogue body is injected; this is local integration, not rendered UI proof.
    ordinary = createContentOrdinaryCatalogue(host);
    const normal = await ordinaryReady(ordinary);
    assert.equal(normal.mode, 'content');
    assert.equal(normal.photoMode, 'verified');
    assert.deepEqual(normal.current(input.ref.recipeId)?.contentRef, input.ref);
    assert.ok(
      normal
        .search({ query: input.expectedTitle })
        .matches.some((match) => match.recipeId === input.ref.recipeId),
    );
    const normalCurrent = await ordinary.readCurrent(input.ref.recipeId);
    assert.equal(normalCurrent.kind, 'readable');
    if (normalCurrent.kind !== 'readable') assert.fail();
    assert.equal(normalCurrent.recipe.title, input.expectedTitle);
    assert.deepEqual(normalCurrent.recipe.translations, recipe.value.recipe.translations);
    const savedOriginal = await ordinary.readExact(input.baseRef);
    assert.equal(savedOriginal.kind, 'readable');
    if (savedOriginal.kind !== 'readable') assert.fail();
    assert.deepEqual(savedOriginal.recipe.contentRef, input.baseRef);
    assert.equal((await ordinary.readPhoto(input.ref, media.assetId)).value.sha256, media.sha256);
    // The ordinary action adapter uses real persisted recovery and existing reviewed
    // commands. It shares this host; no legacy facade or second cooking writer opens.
    ordinaryActions = createOrdinaryContentWorkspace(host);
    let controls = await actionRecoveryReady(ordinaryActions);
    assert.equal(controls.actions.blocked, true);
    await controls.recovery.dismiss(command.operationId);
    controls = await actionRecoveryReady(ordinaryActions);
    assert.equal(controls.actions.blocked, false);
    await controls.actions.begin(
      {
        kind: 'placeRecipe',
        recipeId: input.ref.recipeId,
        placement: { actualDate: '2026-10-07', mealKey: 'dinner' },
      },
      { confirm: true },
    );
    assert.equal(controls.actions.state.kind, 'confirmation');
    await controls.actions.confirm();
    controls = await actionRecoveryReady(ordinaryActions);
    assert.equal(controls.actions.state.kind, 'receipt');
    const ordinaryPlan = ready(await controls.queries.readPlan('2026-10-06', '2026-10-07'));
    assert.deepEqual(
      ordinaryPlan.occurrences.find((row) => row.occurrence.placement.actualDate === '2026-10-06')!
        .contentRef,
      input.baseRef,
    );
    assert.deepEqual(
      ordinaryPlan.occurrences.find((row) => row.occurrence.placement.actualDate === '2026-10-07')!
        .contentRef,
      input.ref,
    );
    // The ordinary sharing formatter consumes the exact host projection, not bundled-ID lookups.
    const selectionBeforeShare = ready(await controls.queries.readShopping());
    if (selectionBeforeShare.kind !== 'current') assert.fail('Selection baseline unavailable');
    await controls.actions.begin(
      {
        kind: 'setShoppingSelection',
        occurrenceIds: ordinaryPlan.occurrences.map((row) => row.occurrence.occurrenceId),
      },
      { confirm: true, observedSelectionRevision: selectionBeforeShare.snapshot.scope.revision },
    );
    controls = await actionRecoveryReady(ordinaryActions);
    assert.equal(controls.actions.state.kind, 'confirmation');
    await controls.actions.confirm();
    controls = await actionRecoveryReady(ordinaryActions);
    assert.equal(controls.actions.state.kind, 'receipt');
    const shareRead = await controls.queries.readShopping();
    assert.equal(shareRead.kind, 'ready');
    if (shareRead.kind !== 'ready' || shareRead.value.kind !== 'current')
      assert.fail('Exact sharing projection unavailable');
    const manualForShare = await readCompleteManualShopping(host.manual);
    assert.equal(manualForShare.revision, shareRead.revision);
    const sharedText = formatContentShoppingShare(shareRead.value, manualForShare.value.items);
    assert.ok(sharedText.includes(input.expectedTitle));
    assert.ok(sharedText.includes('(selected version 1)'));
    assert.ok(sharedText.includes('(selected version 2)'));
    assert.ok(sharedText.includes(manualFields.name));
    for (const group of shareRead.value.snapshot.groups)
      assert.ok(sharedText.includes(group.displayName + ' — ' + group.quantityLabel));
    for (const privateText of [
      recipeNote,
      editedRecipeNote,
      originalNote,
      collectionName,
      renamedCollectionName,
      manualItemId,
      ...ordinaryPlan.occurrences.map((row) => row.occurrence.occurrenceId),
    ])
      assert.equal(sharedText.includes(privateText), false);
    const afterShare = await controls.queries.readShopping();
    assert.equal(afterShare.kind, 'ready');
    if (afterShare.kind !== 'ready') assert.fail();
    assert.equal(afterShare.revision, shareRead.revision);
    assert.deepEqual(afterShare.value, shareRead.value);
    // Explicitly move to the adopted version; old progress never silently reinterprets its anchor.
    if (recipe.value.kind !== 'readable') assert.fail();
    const adoptedProgress = await host.sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: input.ref,
      expectedRevision: initialProgress.value.session.revision,
      passageSequence: recipe.value.recipe.instructions[0]!.sequence,
    });
    assert.equal(adoptedProgress.kind, 'ready', JSON.stringify(adoptedProgress));
    if (adoptedProgress.kind !== 'ready') assert.fail();
    assert.equal(ready(await host.history.readHistory()).items.length, 1);
    const cookedInput = {
      eventId: cookedEventId,
      contentRef: input.ref,
      expectedHistoryEpoch: ready(await host.history.readHistory()).historyEpoch,
      cookedOn: '2026-10-01',
      timeZone: 'Asia/Dubai',
      note: newCookedNote,
      session: {
        sessionId: adoptedProgress.value.session.sessionId,
        expectedRevision: adoptedProgress.value.session.revision,
      },
    };
    cookedRecovery = ready(await host.cooked.prepareCookedRecovery(cookedInput));
    assert.equal(JSON.stringify(cookedRecovery).includes(newCookedNote), false);
    assert.equal(ready(await host.cooked.readCookedRecovery(cookedRecovery)), null);
    assert.equal(ready(await host.history.readHistory()).items.length, 1);
    const cooked = await host.cooked.saveCooked(cookedInput);
    assert.equal(cooked.kind, 'ready', JSON.stringify(cooked));
    if (cooked.kind !== 'ready') assert.fail();
    assert.equal(cooked.value.kind, 'saved');
    if (cooked.value.kind !== 'saved') assert.fail();
    assert.deepEqual(cooked.value.event.contentRef, input.ref);
    assert.equal(cooked.value.event.recipeTitle, input.expectedTitle);
    assert.equal(cooked.value.closedSession?.state, 'completed');
    assert.equal(ready(await host.sessions.readResumeSession()), null);
    assert.deepEqual(ready(await host.cooked.readCookedRecovery(cookedRecovery)), cooked.value);
    assert.deepEqual(await host.cooked.saveCooked(cookedInput), cooked);
    const cookedResolution = await host.cooked.resolveCookedRecovery(cookedRecovery);
    assert.equal(cookedResolution.kind, 'ready', JSON.stringify(cookedResolution));
    if (cookedResolution.kind !== 'ready') assert.fail();
    assert.deepEqual(cookedResolution.value, cooked.value);
    assert.equal(ready(await host.history.readHistory()).items.length, 2);
    assert.deepEqual(ready(await host.queries.readShopping()), shareRead.value);
    assert.equal(
      ready(await host.notes.readRecipeNote(input.ref.recipeId)).note?.text,
      editedRecipeNote,
    );
    assert.equal(ready(await host.manual.readManualShopping()).items[0]!.amountText, '2');
    await controls.actions.begin({
      kind: 'setFavourite',
      recipeId: input.ref.recipeId,
      saved: true,
    });
    controls = await actionRecoveryReady(ordinaryActions);
    assert.equal(controls.actions.state.kind, 'receipt');
    const savedFavourite = ready(await controls.queries.readFavourites()).find(
      (row) => row.favourite.recipeId === input.ref.recipeId,
    );
    assert.ok(savedFavourite);
    assert.equal(savedFavourite.content.kind, 'readable');
    if (savedFavourite.content.kind !== 'readable') assert.fail();
    assert.deepEqual(savedFavourite.content.contentRef, input.ref);
    assert.equal(savedFavourite.content.title, input.expectedTitle);
    assert.deepEqual(observer.database.prepare('PRAGMA foreign_key_check').all(), []);
    access = { ownerId: null, authGeneration: 2 };
    for (const listener of listeners) listener();
    assert.equal(host.getSnapshot().status, 'revoked');
    assert.equal(ordinary.getSnapshot().kind, 'unavailable');
    assert.throws(() => normal.current(input.ref.recipeId));
    await assert.rejects(ordinary.readCurrent(input.ref.recipeId));
    assert.equal(ordinaryActions.getSnapshot().kind, 'unavailable');
    await assert.rejects(controls.queries.readShopping());
    await assert.rejects(controls.queries.readFavourites());
    await assert.rejects(host.history.readHistory());
    await assert.rejects(host.clearHistory.reviewClearHistory());
    await assert.rejects(host.notes.readRecipeNote(input.ref.recipeId));
    await assert.rejects(host.notes.execute(editNote));
    await assert.rejects(host.manual.readManualShopping());
    await assert.rejects(host.manual.execute(editManual));
    await assert.rejects(host.collections.readCollections());
    await assert.rejects(host.collections.execute(renameCollection));
    await assert.rejects(host.sessions.readResumeSession());
    await assert.rejects(host.cooked.readCookedRecovery(cookedRecovery));
    await host.awaitClosed();
    await assert.rejects(host.content.readCurrent(input.ref.recipeId));
  } finally {
    ordinaryActions?.close();
    ordinary?.close();
    await host.close();
    await observer.connection.close();
  }
  // The route's actual bootstrap consumes the same prepared/adopted disk stores and
  // independent trust configuration. No fake reader or normal workspace is substituted.
  const config = readPrivateContentConfiguration(
    JSON.stringify({
      version: 1,
      origin: 'http://localhost:19092',
      installationId: ids.installationId,
      releaseId: 'configured-delivery-not-requested',
      trustKeys: input.trustKeys,
    }),
    'http://localhost:19092',
  )!;
  const runtime = await openPrivateContentRuntime({
    config,
    verification: async () => input.ports,
    journal,
    openConnection: async (name) => {
      assert.ok(name === names.cooking || name === names.content);
      return desktopConnection(join(input.directory, name)).connection;
    },
    platform: { newId: randomUUID, sha256: input.ports.sha256 },
    now: () => input.at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    fetch: async () => {
      throw new Error('Reading adopted content must not request another release');
    },
  });
  try {
    const current = await runtime.host.content.readCurrent(input.ref.recipeId);
    assert.equal(current.value.kind, 'readable');
    if (current.value.kind !== 'readable') assert.fail();
    assert.equal(current.value.recipe.title, input.expectedTitle);
    if (input.expectedTranslation) {
      const translation = current.value.recipe.translations?.[0];
      assert.equal(translation?.content.title, input.expectedTranslation.title);
      assert.equal(translation?.translationId, input.expectedTranslation.translationId);
      assert.equal(translation?.translationRevision, input.expectedTranslation.translationRevision);
      assert.deepEqual(translation?.sourceRef, input.ref);
    }
    assert.deepEqual(current.value.recipe.contentRef, input.ref);
    const photo = current.value.recipe.media[0]!;
    assert.equal(
      (await runtime.host.content.readPhoto(input.ref, photo.assetId)).value.sha256,
      photo.sha256,
    );
    assert.deepEqual(
      ready(await runtime.host.queries.readPlan('2026-10-06', '2026-10-06')).occurrences[0]!
        .contentRef,
      input.baseRef,
    );
    assert.equal((await runtime.host.content.readExact(input.baseRef)).value.kind, 'readable');
    let reopenedFavourite = ready(await runtime.host.queries.readFavourites()).find(
      (row) => row.favourite.recipeId === input.ref.recipeId,
    );
    assert.ok(reopenedFavourite);
    assert.equal(reopenedFavourite.content.kind, 'readable');
    if (reopenedFavourite.content.kind !== 'readable') assert.fail();
    assert.deepEqual(reopenedFavourite.content.contentRef, input.ref);
    let reopenedHistory = ready(await runtime.host.history.readHistory());
    assert.equal(reopenedHistory.items.length, 2);
    const originalEntry = reopenedHistory.items.find(
      (item) => item.entry.eventId === originalEventId,
    )!;
    assert.equal(originalEntry.entry.note, originalNote);
    assert.deepEqual(originalEntry.pin, { kind: 'exact', ref: input.baseRef });
    const adoptedEntry = reopenedHistory.items.find(
      (item) => item.entry.eventId === cookedEventId,
    )!;
    assert.equal(adoptedEntry.entry.note, newCookedNote);
    assert.deepEqual(adoptedEntry.pin, { kind: 'exact', ref: input.ref });
    assert.equal(ready(await runtime.host.sessions.readResumeSession()), null);
    assert.ok(cookedRecovery);
    const recoveredCooked = ready(await runtime.host.cooked.readCookedRecovery(cookedRecovery));
    assert.equal(recoveredCooked?.kind, 'saved');
    const reopenedResolution = await runtime.host.cooked.resolveCookedRecovery(cookedRecovery);
    assert.equal(reopenedResolution.kind, 'ready', JSON.stringify(reopenedResolution));
    if (reopenedResolution.kind !== 'ready') assert.fail();
    assert.deepEqual(reopenedResolution.value, recoveredCooked);
    let reopenedNote = ready(await runtime.host.notes.readRecipeNote(input.ref.recipeId));
    assert.equal(reopenedNote.note?.text, editedRecipeNote);
    let reopenedManual = ready(await runtime.host.manual.readManualShopping());
    assert.equal(reopenedManual.items[0]!.itemId, manualItemId);
    assert.equal(reopenedManual.items[0]!.amountText, '2');
    assert.equal(reopenedManual.items[0]!.purchased, false);
    const reopenedCollection = ready(await runtime.host.collections.readCollection(collectionId));
    assert.equal(reopenedCollection.collection.name, renamedCollectionName);
    assert.equal(reopenedCollection.items[0]!.recipeId, input.ref.recipeId);
    // Same real configured composition, no second database or backup-specific writer.
    const backup = ready(await runtime.host.backup.capture());
    assert.equal(backup.schemaVersion, 3);
    assert.equal(backup.databaseSchemaVersion, 8);
    assert.equal(Object.hasOwn(backup.data, 'cookingHistory'), false);
    assert.equal(backup.data.personal.notes[0]!.text, editedRecipeNote);
    assert.equal(backup.data.personal.manualItems[0]!.itemId, manualItemId);
    assert.equal(backup.data.personal.collections[0]!.name, renamedCollectionName);
    assert.ok(
      backup.data.planReferences.some(
        (row) => row.contentRef.contentFingerprint === input.baseRef.contentFingerprint,
      ),
    );
    const withoutHistory = await runtime.host.backup.inspect(JSON.stringify(backup));
    assert.equal(withoutHistory.kind, 'ready', JSON.stringify(withoutHistory));
    if (withoutHistory.kind !== 'ready') assert.fail();
    assert.deepEqual(withoutHistory.value.counts, backup.counts);
    assert.equal(withoutHistory.value.restoreAvailable, false);
    assert.equal(withoutHistory.value.exactReferencesAvailable, true);
    const withHistory = ready(await runtime.host.backup.capture({ includeCookingHistory: true }));
    assert.equal(withHistory.data.cookingHistory?.entries.length, 2);
    const checked = await runtime.host.backup.inspect(JSON.stringify(withHistory));
    assert.equal(checked.kind, 'ready', JSON.stringify(checked));
    if (checked.kind !== 'ready') assert.fail();
    assert.deepEqual(checked.value.counts, withHistory.counts);
    assert.deepEqual(checked.value.historyIssues, []);
    assert.equal(checked.value.exactReferencesAvailable, true);
    // Read-only export/inspection did not change any private scope.
    assert.deepEqual(ready(await runtime.host.history.readHistory()), reopenedHistory);
    assert.deepEqual(ready(await runtime.host.manual.readManualShopping()), reopenedManual);
    assert.deepEqual(
      ready(await runtime.host.collections.readCollection(collectionId)),
      reopenedCollection,
    );
    assert.deepEqual(
      ready(await runtime.host.notes.readRecipeNote(input.ref.recipeId)),
      reopenedNote,
    );
    // Reviewed restore uses this same owner-bound host and the exact issued capability.
    // An omitted history scope must retain both real local cooking entries and their exact pins.
    // Earlier direct-action result notices were deliberately retained across reopen.
    // Restore must remain blocked until those actual receipts are checked and acknowledged.
    const heldRestore = ready(await runtime.host.restore.review(JSON.stringify(backup)));
    assert.deepEqual(heldRestore.blockers, ['active_actions']);
    const notices = ready(await runtime.host.commands.readDirectRecovery());
    assert.equal(notices.nextAfterSequence, null);
    assert.ok(notices.entries.length > 0);
    for (const notice of notices.entries) {
      assert.equal(notice.outcome, 'receipt');
      assert.ok(ready(await runtime.host.commands.readReceipt(notice.operationId)));
      ready(await runtime.host.commands.acknowledgeDirectRecovery(notice.operationId));
    }
    const restoreReview = ready(await runtime.host.restore.review(JSON.stringify(backup)));
    assert.deepEqual(restoreReview.blockers, []);
    const restorePrepared = ready(await runtime.host.restore.prepare(restoreReview));
    const restored = await runtime.host.restore.execute(restorePrepared);
    assert.equal(restored.kind, 'receipt', JSON.stringify(restored));
    if (restored.kind !== 'receipt') assert.fail();
    assert.deepEqual(
      ready(await runtime.host.restore.readReceipt(restored.receipt.operationId)),
      restored.receipt,
    );
    const archive = ready(
      await runtime.host.restore.readArchive(restored.receipt.operationId, 'before'),
    );
    assert.ok(archive);
    assert.deepEqual(JSON.parse(archive).data.personal, backup.data.personal);
    const restoredBackup = ready(await runtime.host.backup.capture());
    // A replacement receives the new local revision; imported item identity/body stay intact.
    for (const kind of ['notes', 'manualItems', 'collections', 'memberships'] as const)
      assert.deepEqual(
        restoredBackup.data.personal[kind],
        backup.data.personal[kind].map((row): typeof row => ({
          ...row,
          revision: restored.receipt.revision,
        })),
      );
    assert.deepEqual(restoredBackup.data.planReferences, backup.data.planReferences);
    assert.deepEqual(ready(await runtime.host.history.readHistory()).items, reopenedHistory.items);
    // Mutating operations below use fresh authoritative epochs after the reviewed replacement.
    reopenedHistory = ready(await runtime.host.history.readHistory());
    reopenedNote = ready(await runtime.host.notes.readRecipeNote(input.ref.recipeId));
    reopenedManual = ready(await runtime.host.manual.readManualShopping());
    reopenedFavourite = ready(await runtime.host.queries.readFavourites()).find(
      (row) => row.favourite.recipeId === input.ref.recipeId,
    );
    const collectionDeleteReview = ready(
      await runtime.host.collections.reviewDeleteCollection(collectionId),
    );
    assert.deepEqual(collectionDeleteReview.affectedRecipeIds, [input.ref.recipeId]);
    const collectionDeleteId = randomUUID();
    const collectionDeletion = await runtime.host.collections.deleteCollection(
      collectionDeleteReview,
      collectionDeleteId,
    );
    assert.equal(collectionDeletion.kind, 'ready', JSON.stringify(collectionDeletion));
    if (collectionDeletion.kind !== 'ready') assert.fail();
    assert.equal(collectionDeletion.value.affectedMemberships, 1);
    assert.deepEqual(
      await runtime.host.collections.deleteCollection(collectionDeleteReview, collectionDeleteId),
      collectionDeletion,
    );
    const collectionResolution =
      await runtime.host.collections.resolveOperation(collectionDeleteId);
    assert.equal(collectionResolution.kind, 'ready', JSON.stringify(collectionResolution));
    if (collectionResolution.kind !== 'ready') assert.fail();
    assert.deepEqual(collectionResolution.value, collectionDeletion.value);
    assert.equal(ready(await runtime.host.collections.readCollections()).items.length, 0);
    assert.deepEqual(ready(await runtime.host.manual.readManualShopping()), reopenedManual);
    assert.deepEqual(
      ready(await runtime.host.notes.readRecipeNote(input.ref.recipeId)),
      reopenedNote,
    );
    assert.deepEqual(ready(await runtime.host.history.readHistory()), reopenedHistory);
    assert.deepEqual(
      ready(await runtime.host.queries.readFavourites()).find(
        (row) => row.favourite.recipeId === input.ref.recipeId,
      ),
      reopenedFavourite,
    );
    const beforeManualDelete = ready(await runtime.host.queries.readShopping());
    const manualDeletionId = randomUUID();
    const deletedManual = await runtime.host.manual.execute({
      kind: 'deleteManualItem',
      operationId: manualDeletionId,
      expectedEpoch: reopenedManual.epoch,
      itemId: manualItemId,
      expectedRevision: reopenedManual.items[0]!.revision,
    });
    assert.equal(deletedManual.kind, 'ready', JSON.stringify(deletedManual));
    if (deletedManual.kind !== 'ready') assert.fail();
    const manualDeletionReceipt = await runtime.host.manual.resolveOperation(manualDeletionId);
    assert.equal(manualDeletionReceipt.kind, 'ready', JSON.stringify(manualDeletionReceipt));
    if (manualDeletionReceipt.kind !== 'ready') assert.fail();
    assert.deepEqual(manualDeletionReceipt.value, deletedManual.value);
    assert.equal(ready(await runtime.host.manual.readManualShopping()).total, 0);
    assert.deepEqual(ready(await runtime.host.queries.readShopping()), beforeManualDelete);
    assert.deepEqual(
      ready(await runtime.host.notes.readRecipeNote(input.ref.recipeId)),
      reopenedNote,
    );
    const noteDeletionId = randomUUID();
    const deletedNote = await runtime.host.notes.execute({
      kind: 'deleteNote',
      operationId: noteDeletionId,
      noteId: recipeNoteId,
      expectedEpoch: reopenedNote.epoch,
      expectedRevision: reopenedNote.note!.revision,
    });
    assert.equal(deletedNote.kind, 'ready', JSON.stringify(deletedNote));
    if (deletedNote.kind !== 'ready') assert.fail();
    assert.equal(deletedNote.value.outcome, 'committed');
    const deletionReceipt = await runtime.host.notes.resolveOperation(noteDeletionId);
    assert.equal(deletionReceipt.kind, 'ready', JSON.stringify(deletionReceipt));
    if (deletionReceipt.kind !== 'ready') assert.fail();
    assert.deepEqual(deletionReceipt.value, deletedNote.value);
    const deletedSnapshot = ready(await runtime.host.notes.readRecipeNote(input.ref.recipeId));
    assert.equal(deletedSnapshot.note?.deleted, true);
    assert.equal(deletedSnapshot.note?.text, null);
    assert.deepEqual(ready(await runtime.host.history.readHistory()), reopenedHistory);
    const retainedPlan = ready(await runtime.host.queries.readPlan('2026-10-06', '2026-10-07'));
    const retainedFavourites = ready(await runtime.host.queries.readFavourites());
    const clearReview = ready(await runtime.host.clearHistory.reviewClearHistory());
    assert.equal(clearReview.count, 2);
    const clearId = randomUUID();
    const clearing = await runtime.host.clearHistory.clearHistory(clearReview, clearId);
    assert.equal(clearing.kind, 'ready', JSON.stringify(clearing));
    if (clearing.kind !== 'ready') assert.fail();
    assert.equal(clearing.value.outcome, 'cleared');
    assert.equal(clearing.value.clearedCount, 2);
    assert.deepEqual(
      ready(await runtime.host.clearHistory.readClearHistoryReceipt(clearId)),
      clearing.value,
    );
    // Replay the resolution path for this committed receipt; no fault is injected here.
    const resolved = await runtime.host.clearHistory.resolveClearHistoryOperation(clearId);
    assert.equal(resolved.kind, 'ready', JSON.stringify(resolved));
    if (resolved.kind !== 'ready') assert.fail();
    assert.deepEqual(resolved.value, clearing.value);
    assert.equal(ready(await runtime.host.history.readHistory()).items.length, 0);
    assert.equal(
      ready(await runtime.host.cooked.readCookedRecovery(cookedRecovery))?.kind,
      'cleared',
    );
    assert.deepEqual(
      ready(await runtime.host.queries.readPlan('2026-10-06', '2026-10-07')),
      retainedPlan,
    );
    assert.deepEqual(ready(await runtime.host.queries.readFavourites()), retainedFavourites);
  } finally {
    await runtime.close();
  }
}
