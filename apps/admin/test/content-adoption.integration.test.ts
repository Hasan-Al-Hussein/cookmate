import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  createBundledContentSnapshot,
  createContentReader,
  TRANSLATED_PUBLICATION_READER_VERSION,
  type OverlayEntry,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { cookingContentIdentity } from '@cookmate/domain';
import type { AccountSnapshotOptions } from '@cookmate/account-sync';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../../packages/account-sync/src/contentSnapshot';
import { createContentAccountServices } from '../../mobile/src/data/contentAccountServices';
import { ACCOUNT_BINDING_KEY } from '../../mobile/src/data/accountReplicationRecords';
import { migrateAccountContentHistoryDatabase } from '../../mobile/src/data/accountContentHistoryMigration';
import { createContentEvidenceBuilder } from '../../gateway/src/evidence';
import { createVerifiedContentGateway } from '../../gateway/src/contentGateway';
import type { ModelProvider, ProviderInput } from '../../gateway/src/provider-contract';
import { memoryRegistry, nonMemoryUpdate, request } from '../../gateway/test/helpers';
import { createAdoptedContentReader } from '../../mobile/src/data/adoptedContentReader';
import { createContentAdoptionService } from '../../mobile/src/data/contentAdoption';
import { createContentDirectCommands } from '../../mobile/src/data/contentDirectCommands';
import { createDirectRecoveryRepository } from '../../mobile/src/data/directRecoveryRepository';
import { createContentCookingSessions } from '../../mobile/src/data/contentCookingSessions';
import { createContentCookingHistory } from '../../mobile/src/data/contentCookingHistory';
import { createContentCookingHistoryReader } from '../../mobile/src/data/contentCookingHistoryRead';
import { createContentCookingHistoryClear } from '../../mobile/src/data/contentCookingHistoryClear';
import { createPortableContentBackupReader } from '../../mobile/src/data/portableContentBackup';
import { createPortableContentBackupInspector } from '../../mobile/src/data/portableContentInspection';
import { validatePortableContentBackup } from '../../../packages/domain/src/portableBackupContent';
import {
  openContentReleaseStore,
  type ContentVerificationPorts,
} from '../../mobile/src/data/contentReleaseStore';
import { migrateCookingContentDatabase } from '../../mobile/src/data/cookingContentMigration';
import { readAdoptionInSnapshot } from '../../mobile/src/data/cookingContentRepository';
import { initializeDatabase } from '../../mobile/src/data/initialize';
import { readPinnedShoppingContextInSnapshot } from '../../mobile/src/data/pinnedShoppingRepository';
import {
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from '../../mobile/src/data/shoppingRepository';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../mobile/src/data/sql';
import { desktopConnection } from '../../../packages/domain/test/helpers/sqlite';
import type {
  AdminDraft,
  AdminPublicationIssueReceipt,
  AdminPublicationPreparation,
} from '../src/contracts';
import type { IssuedReleasePackage } from '../src/publishing/delivery';
import { fixture } from './helpers';
import { assertContentCookingStoreBridge } from './contentCookingStoreBridge';
import { assertContentWorkspaceHostBridge } from './contentWorkspaceHostBridge';
import { prepareReviewedTranslationFixture } from './reviewedTranslationFixture';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const sha256Bytes = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-01T12:00:00.000Z';

// Actual local HTTP authority, Ed25519, media and two SQLite stores. All users, approvals,
// rights statements and releases are disposable fixtures, not hosted/native acceptance.
test('private admin release reaches cooking adoption and matching gateway evidence, preserves history, archives and rolls back as a new release', async (t) => {
  const pair = generateKeyPairSync('ed25519');
  const trust = [
    {
      keyId: 'fixture-integration-key',
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
        'hex',
      ),
    },
  ];
  const f = await fixture(t, (directory) => ({
    publication: {
      issuedDatabaseFile: join(directory, 'issued.sqlite'),
      signingKeyId: trust[0]!.keyId,
      signingPrivateKey: pair.privateKey,
      trustedKeys: trust,
    },
  }));
  const client = f.client();
  await client.login();
  const recipe = catalogue.recipes[0]!;
  let draft = (await client.create('bridge-create', recipe.recipeId)).draft;
  const saved = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
    operationId: 'bridge-save',
    expectedRevision: draft.revision,
    input: {
      ...draft.input,
      title: `${recipe.title} — local revision`,
      changeSummary: 'Synthetic integration fixture: title only; original quantities unchanged.',
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  draft = saved.json().draft as AdminDraft;
  for (const scope of ['recipe_text', 'photo', ...(draft.input.videoUrl ? ['video_embed'] : [])]) {
    const result = await client.request('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
      operationId: `bridge-rights-${scope}`,
      expectedRevision: draft.revision,
      scope,
      status: 'permitted',
      statement: 'Synthetic fixture assertion, not actual rights permission.',
      sourceUrl: null,
    });
    assert.equal(result.statusCode, 200, result.body);
    draft = result.json().draft as AdminDraft;
  }
  const approved = await client.request('POST', `/admin/api/drafts/${draft.draftId}/reviews`, {
    operationId: 'bridge-review',
    expectedRevision: draft.revision,
    decision: 'approved',
    note: 'Synthetic local integration only.',
  });
  assert.equal(approved.statusCode, 200, approved.body);
  draft = approved.json().draft as AdminDraft;
  const translated = await prepareReviewedTranslationFixture(client, draft);
  const prepared = await client.request(
    'POST',
    `/admin/api/drafts/${draft.draftId}/publication-preparation`,
    { expectedRevision: draft.revision, translations: [translated.selection] },
  );
  assert.equal(prepared.statusCode, 200, prepared.body);
  const preparation = prepared.json() as AdminPublicationPreparation;
  const ref = {
    recipeId: preparation.recipeId,
    revisionId: preparation.revisionId,
    contentFingerprint: preparation.contentFingerprint,
  };
  const current: OverlayEntry = {
    state: 'current',
    ref,
    publicationFingerprint: preparation.publicationFingerprint,
  };
  const baseline = await createBundledContentSnapshot(sha256);
  const baseRef = baseline.revisions.find((item) => item.ref.recipeId === recipe.recipeId)!.ref;
  const bundledMedia = new Map(
    baseline.revisions.flatMap((item) =>
      item.document.media.map((media) => [media.sha256, item.ref.recipeId] as const),
    ),
  );
  const contentWrite = desktopConnection(join(f.directory, 'content.sqlite'));
  const contentRead = desktopConnection(join(f.directory, 'content.sqlite'));
  const verification: ContentVerificationPorts = {
    baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
    readerVersion: TRANSLATED_PUBLICATION_READER_VERSION,
    trustVerifier: createContentTrustVerifier(trust),
    sha256,
    sha256Bytes,
    async inspectImage(bytes) {
      const image = sharp(bytes);
      try {
        const meta = await image.metadata();
        if (!meta.width || !meta.height || !['jpeg', 'png', 'webp'].includes(meta.format!))
          return null;
        return {
          mimeType: `image/${meta.format}` as 'image/jpeg' | 'image/png' | 'image/webp',
          width: meta.width,
          height: meta.height,
        };
      } finally {
        image.destroy();
      }
    },
    async readBundledMedia(media) {
      const id = bundledMedia.get(media.sha256);
      return id
        ? readFile(new URL(`../../../packages/catalogue/assets/photos/${id}.jpg`, import.meta.url))
        : null;
    },
  };
  const content = await openContentReleaseStore({
    ...verification,
    readConnection: contentRead.connection,
    writeConnection: contentWrite.connection,
    now: () => new Date(at),
  });
  const cookingWrite = desktopConnection(join(f.directory, 'cooking.sqlite'));
  const cookingRead = desktopConnection(join(f.directory, 'cooking.sqlite'));
  await configureConnection(cookingWrite.connection);
  await configureConnection(cookingRead.connection);
  const queue = new SqlTransactionQueue();
  const writer = new SerializedWriter(cookingWrite.connection, queue);
  const reader = new SerializedReader(cookingRead.connection, queue);
  let runningGateway: Awaited<ReturnType<typeof createVerifiedContentGateway>> | undefined;
  let directCommands: ReturnType<typeof createContentDirectCommands> | undefined;
  let cookingSessions: ReturnType<typeof createContentCookingSessions> | undefined;
  let cookingHistory: ReturnType<typeof createContentCookingHistory> | undefined;
  let historyReader: ReturnType<typeof createContentCookingHistoryReader> | undefined;
  let historyClear: ReturnType<typeof createContentCookingHistoryClear> | undefined;
  let contentBackup: ReturnType<typeof createPortableContentBackupReader> | undefined;
  try {
    const ids = {
      installationId: randomUUID(),
      shoppingScopeId: randomUUID(),
      conversationId: randomUUID(),
    };
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
    const occurrence = randomUUID();
    await writer.transaction(async (session) => {
      const options = { readRecipe: catalogue.getRecipe, sha256 };
      const before = await readShoppingLedgerInSnapshot(session, options);
      cookingWrite.database
        .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
        .run(occurrence, recipe.recipeId, '2026-10-01', 'dinner', at, at);
      cookingWrite.database
        .prepare('INSERT INTO shopping_selection VALUES (?,?)')
        .run(ids.shoppingScopeId, occurrence);
      await rebuildShoppingInSnapshot(session, before, options);
    });
    cookingWrite.database.exec('UPDATE purchase_state SET purchased=1');
    const event = {
      ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
      eventId: randomUUID(),
      recipeTitle: recipe.title,
      photoKey: recipe.photoKey,
      cookedOn: '2026-10-01',
      timeZone: 'Asia/Dubai',
      recordedAt: at,
      note: 'Synthetic retained history',
      historyEpoch: 0,
      revision: 1,
    };
    cookingWrite.database
      .prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)")
      .run(
        event.eventId,
        event.cookedOn,
        at,
        'a'.repeat(64),
        JSON.stringify({ kind: 'saved', event, closedSession: null }),
      );
    cookingWrite.database.exec('UPDATE cooking_state SET history_revision=1 WHERE singleton=1');
    await migrateCookingContentDatabase(writer, { sha256 });
    const historyBefore = cookingWrite.database.prepare('SELECT * FROM cooking_event').all();
    const pinsBefore = cookingWrite.database
      .prepare('SELECT * FROM local_history_content_pin')
      .all();
    const planBefore = cookingWrite.database.prepare('SELECT * FROM plan_occurrence').all();
    const purchaseBefore = cookingWrite.database.prepare('SELECT * FROM purchase_state').all();
    const activePurchases = () =>
      cookingWrite.database
        .prepare(
          "SELECT g.group_key,g.demand_fingerprint,g.quantity_label,p.purchased FROM shopping_group g JOIN shopping_scope s ON s.scope_id=g.scope_id AND s.projection_revision=g.projection_revision JOIN purchase_state p ON p.scope_id=g.scope_id AND p.group_key=g.group_key WHERE EXISTS (SELECT 1 FROM shopping_contribution c WHERE c.scope_id=g.scope_id AND c.group_key=g.group_key AND c.source_kind='ingredient') ORDER BY g.group_key",
        )
        .all();
    const demandBefore = activePurchases();
    assert.ok(demandBefore.length > 0);
    let access: { ownerId: string | null; authGeneration: number } = {
      ownerId: null,
      authGeneration: 0,
    };
    const adoption = createContentAdoptionService({
      reader,
      writer,
      contentStore: content,
      sha256,
      now: () => at,
      newId: randomUUID,
      getAccess: () => access,
      assertAccess: (scope) => {
        assert.deepEqual(scope, access);
        return undefined;
      },
    });
    const readingOptions = {
      reader,
      contentStore: content,
      installationId: ids.installationId,
      sha256,
      getAccess: () => access,
      assertAccess: (scope: Readonly<typeof access>) => {
        assert.deepEqual(scope, access);
        return undefined;
      },
    };
    let recipeReads = createAdoptedContentReader(readingOptions);
    assert.equal((await recipeReads.discover()).value.length, catalogue.recipes.length);
    assert.equal((await recipeReads.readCurrent(recipe.recipeId)).head, null);
    const originalMedia = baseline.revisions.find((item) => item.ref.recipeId === recipe.recipeId)!
      .document.media[0]!;
    const originalPhoto = await recipeReads.readPhoto(baseRef, originalMedia.assetId);
    assert.equal(originalPhoto.head, null);
    assert.equal(await sha256Bytes(originalPhoto.value.bytes), originalMedia.sha256);
    let head: OverlayHead | null = null;
    let firstPackage: IssuedReleasePackage | undefined;
    let firstMedia: { sha256: string; bytes: Uint8Array }[] = [];
    async function adoptedHead(expected: OverlayHead, revision: number) {
      const persisted = await reader.transaction(readAdoptionInSnapshot, { kind: 'read_only' });
      assert.deepEqual(persisted, { head: expected, revision });
      assert.ok(persisted.head);
      return persisted.head;
    }
    async function issueAndCache(entry: OverlayEntry) {
      const sequence = (head?.sequence ?? 0) + 1;
      const issued = await client.request('POST', '/admin/api/publication/releases', {
        operationId: `bridge-issue-${sequence}`,
        expectedHead: head,
        entries: [entry],
      });
      assert.equal(issued.statusCode, 200, issued.body);
      const receipt = issued.json() as AdminPublicationIssueReceipt;
      assert.equal(receipt.status, 'issued_not_activated');
      const exported = await client.request(
        'GET',
        `/admin/api/publication/releases/${receipt.envelope.manifest.releaseId}/package`,
      );
      assert.equal(exported.statusCode, 200, exported.body);
      const bundle = exported.json() as IssuedReleasePackage;
      assert.equal(bundle.status, 'issued_export_not_adopted');
      assert.equal(
        bundle.envelope.manifest.minimumReaderVersion,
        TRANSLATED_PUBLICATION_READER_VERSION,
      );
      if (sequence === 1) {
        assert.equal(bundle.publications.length, 1);
        const publication = bundle.publications[0]!;
        assert.equal(publication.formatVersion, 3);
        if (publication.formatVersion !== 3) assert.fail();
        assert.equal(publication.translations.length, 1);
        assert.deepEqual(publication.translations[0]!.sourceRef, ref);
        assert.equal(
          publication.translations[0]!.content.title,
          translated.translation.input.title,
        );
        assert.equal(
          publication.translations[0]!.translationRevision,
          translated.translation.revision,
        );
        assert.deepEqual(
          publication.revision.document.recipe.ingredients.map((row) => row.rawMeasure),
          draft.input.ingredients.map((row) => row.rawMeasure),
        );
        const expectedMedia = bundle.publications[0]!.revision.document.media.map(
          ({ sha256, bytes, mimeType }) => ({ sha256, bytes, mimeType }),
        );
        assert.ok(expectedMedia.length > 0);
        assert.deepEqual(bundle.media, expectedMedia);
      }
      firstPackage ??= bundle;
      const media = [];
      for (const descriptor of bundle.media) {
        const result = await client.request(
          'GET',
          `/admin/api/publication/releases/${receipt.envelope.manifest.releaseId}/media/${descriptor.sha256}`,
        );
        assert.equal(result.statusCode, 200);
        assert.equal(result.rawPayload.byteLength, descriptor.bytes);
        assert.equal(await sha256Bytes(result.rawPayload), descriptor.sha256);
        media.push({ sha256: descriptor.sha256, bytes: result.rawPayload });
      }
      if (sequence === 1) {
        assert.ok(media.length > 0);
        assert.equal(media.length, bundle.media.length);
        firstMedia = media;
      }
      const staged = await content.stage({
        stageId: `bridge-stage-${sequence}`,
        envelope: bundle.envelope,
        publications: bundle.publications,
        media,
      });
      const review = await content.reviewStage(staged.stageId, {
        expectedHead: head,
        retainedRefs: entry.state === 'withdrawn' ? [] : [baseRef, ...(head ? [ref] : [])],
      });
      const cached = await content.activate(review, `bridge-cache-${sequence}`);
      assert.equal(cached.status, 'activated_in_content_store');
      assert.equal(cached.head.sequence, sequence);
      head = cached.head;
      return cached.head;
    }
    const first = await issueAndCache(current);
    // Caching a valid release cannot impersonate adoption into the user's cooking store.
    assert.equal(
      (await reader.transaction(readAdoptionInSnapshot, { kind: 'read_only' })).head,
      null,
    );
    const notYetAdopted = await recipeReads.readCurrent(recipe.recipeId);
    assert.equal(notYetAdopted.head, null);
    assert.equal(notYetAdopted.value.kind, 'readable');
    if (notYetAdopted.value.kind !== 'readable') assert.fail();
    assert.equal(notYetAdopted.value.recipe.title, recipe.title);
    assert.deepEqual(notYetAdopted.value.recipe.translations, []);
    const preAdoptionChoices = await adoption.readMealChoices({ candidateHead: first });
    assert.equal(preAdoptionChoices.total, 1);
    assert.equal(preAdoptionChoices.nextOffset, null);
    assert.equal(preAdoptionChoices.items[0]!.occurrence.occurrenceId, occurrence);
    assert.deepEqual(preAdoptionChoices.items[0]!.current, {
      contentRef: baseRef,
      title: recipe.title,
      state: 'readable',
    });
    assert.deepEqual(preAdoptionChoices.items[0]!.target, {
      contentRef: ref,
      title: draft.input.title,
    });
    const retainReview = await adoption.review({ candidateHead: first });
    assert.equal(retainReview.changes.length, 0);
    const retained = await adoption.adopt(retainReview);
    assert.equal(retained.status, 'adopted_in_cooking_store');
    await assert.rejects(
      adoption.review(
        {
          candidateHead: first,
          changes: [{ occurrenceId: occurrence, expectedRef: baseRef, targetRef: ref }],
        },
        preAdoptionChoices.contextFingerprint,
      ),
      { code: 'review_changed' },
      'a previously shown selection cannot cross a changed adoption context',
    );
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM plan_occurrence').all(),
      planBefore,
    );
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM purchase_state').all(),
      purchaseBefore,
    );
    const snapshot = (await content.readRetainedHead(await adoptedHead(first, 1), [baseRef, ref]))
      .snapshot;
    const app = createContentReader(snapshot);
    const gateway = createContentEvidenceBuilder(snapshot);
    assert.deepEqual(app.identity, gateway.identity);
    assert.deepEqual(app.getRecipe(recipe.recipeId)!.contentRef, ref);
    assert.equal(app.getRecipe(recipe.recipeId)!.title, draft.input.title);
    assert.equal(
      app.getRecipe(recipe.recipeId)!.translations?.[0]?.content.title,
      translated.translation.input.title,
    );
    assert.deepEqual(gateway.packet([recipe.recipeId])[0]!.contentRef, ref);
    assert.equal(app.lookupExact(baseRef).kind, 'readable');
    recipeReads.close();
    // A fresh service reconstructs current content from cooking persistence, not a supplied head.
    recipeReads = createAdoptedContentReader(readingOptions);
    const adoptedRead = await recipeReads.readCurrent(recipe.recipeId);
    assert.deepEqual(adoptedRead.head, first);
    assert.deepEqual(adoptedRead.identity, gateway.identity);
    assert.equal(adoptedRead.value.kind, 'readable');
    if (adoptedRead.value.kind !== 'readable') assert.fail();
    assert.deepEqual(adoptedRead.value.recipe.contentRef, ref);
    // A real loopback socket and paired HTTP requests, using an explicitly controlled model.
    // No Gemini/API key is read and this is not provider quality or deployed TLS acceptance.
    const providerCalls: ProviderInput[] = [];
    const provider: ModelProvider = {
      async complete(input) {
        providerCalls.push(input);
        return {
          value: {
            kind: 'respond',
            sufficiency: 'sufficient',
            missingFacts: [],
            memoryUpdate: nonMemoryUpdate(input.request),
            response: {
              kind: 'answer',
              text: 'This is the selected recipe from the verified release.',
              sources: [{ recipeId: recipe.recipeId, section: 'recipe' }],
              recipeIds: [recipe.recipeId],
            },
          },
          usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 },
        };
      },
    };
    const { registry } = await memoryRegistry();
    runningGateway = await createVerifiedContentGateway({
      registry,
      provider,
      content: { head: adoptedRead.head!, withVerifiedReading: content.withVerifiedReading },
    });
    const address = await runningGateway.app.listen({ host: '127.0.0.1', port: 0 });
    const pairingResponse = await fetch(`${address}/v2/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: '2', code: runningGateway.pairing.openWindow().code }),
    });
    assert.equal(pairingResponse.status, 200);
    const paired = (await pairingResponse.json()) as {
      token: string;
      catalogue: typeof catalogue.identity;
    };
    assert.deepEqual(paired.catalogue, adoptedRead.identity);
    async function gatewayTurn(identity = adoptedRead.identity) {
      const input = request();
      input.requestId = randomUUID();
      input.catalogue = { ...identity };
      input.context.selectedRecipeId = recipe.recipeId;
      input.message.text = 'Tell me about this recipe.';
      return fetch(`${address}/v2/assistant/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${paired.token}` },
        body: JSON.stringify(input),
      });
    }
    const mismatch = await gatewayTurn(catalogue.identity);
    assert.equal(mismatch.status, 409);
    await mismatch.arrayBuffer();
    assert.equal(providerCalls.length, 0);
    const matched = await gatewayTurn();
    assert.equal(matched.status, 200, await matched.clone().text());
    assert.deepEqual(
      ((await matched.json()) as { catalogue: unknown }).catalogue,
      adoptedRead.identity,
    );
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0]!.evidence[0]!.contentRef, ref);
    assert.equal(providerCalls[0]!.evidence[0]!.title, draft.input.title);
    const publishedMedia = adoptedRead.value.recipe.media[0]!;
    const deliveredPhoto = await recipeReads.readPhoto(ref, publishedMedia.assetId);
    assert.deepEqual(deliveredPhoto.head, first);
    assert.equal(deliveredPhoto.value.sha256, firstMedia[0]!.sha256);
    assert.deepEqual(deliveredPhoto.value.bytes, new Uint8Array(firstMedia[0]!.bytes));
    deliveredPhoto.value.bytes[0] = deliveredPhoto.value.bytes[0]! ^ 0xff;
    assert.equal(
      await sha256Bytes((await recipeReads.readPhoto(ref, publishedMedia.assetId)).value.bytes),
      publishedMedia.sha256,
    );
    await assert.rejects(recipeReads.readPhoto(ref, 'unknown-asset'), {
      code: 'exact_unavailable',
    });
    const oldRead = await recipeReads.readExact(baseRef);
    assert.equal(oldRead.value.kind, 'readable');
    if (oldRead.value.kind !== 'readable') assert.fail();
    assert.equal(oldRead.value.recipe.title, recipe.title);
    await assert.rejects(recipeReads.readExact({ ...ref, contentFingerprint: '0'.repeat(64) }), {
      code: 'exact_unavailable',
    });
    const currentChoices = await adoption.readMealChoices({ candidateHead: first });
    const selectedMeal = currentChoices.items[0]!;
    assert.ok(selectedMeal.target);
    assert.deepEqual(selectedMeal.current.contentRef, baseRef);
    assert.deepEqual(selectedMeal.target.contentRef, ref);
    const changeReview = await adoption.review(
      {
        candidateHead: currentChoices.candidateHead,
        changes: [
          {
            occurrenceId: selectedMeal.occurrence.occurrenceId,
            expectedRef: selectedMeal.current.contentRef,
            targetRef: selectedMeal.target.contentRef,
          },
        ],
      },
      currentChoices.contextFingerprint,
    );
    assert.equal(changeReview.shopping.rebuilt, true);
    assert.deepEqual(
      changeReview.shopping.notices.find((notice) => notice.disposition === 'inherited_unresolved')
        ?.annotations,
      recipe.annotations,
    );
    assert.ok(
      changeReview.shopping.groups.some(
        (group) =>
          group.previousQuantity === 'Review source instructions' && group.quantity === null,
      ),
      'ancestor-only warning stays explicit in review, not invented authored demand',
    );
    assert.ok(
      changeReview.shopping.groups
        .filter((group) => group.quantity !== null)
        .every((group) => group.purchased),
    );
    const changed = await adoption.adopt(changeReview);
    assert.equal(changed.changedOccurrences, 1);
    await adoptedHead(first, 2);
    const ledger = await reader.transaction(
      async (session) => {
        const context = await readPinnedShoppingContextInSnapshot(session, {
          lookupExact: app.lookupExact,
          sha256,
        });
        assert.deepEqual(context.pinnedOccurrences[0]!.contentRef, ref);
        return readShoppingLedgerInSnapshot(session, context.options);
      },
      { kind: 'read_only' },
    );
    assert.ok(ledger.snapshot.groups.length > 0);
    assert.deepEqual(activePurchases(), demandBefore);
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM cooking_event').all(),
      historyBefore,
    );
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM local_history_content_pin').all(),
      pinsBefore,
    );
    const directOptions = {
      ...readingOptions,
      writer,
      platform: { newId: randomUUID, sha256 },
      now: () => at,
      dateContext: () => ({
        localDate: '2026-10-01',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      onCommitted: () => {},
    };
    directCommands = createContentDirectCommands(directOptions);
    const directReview = await directCommands.reviewDirect({
      kind: 'placeRecipe',
      recipeId: recipe.recipeId,
      placement: { actualDate: '2026-10-09', mealKey: 'dinner' },
    });
    assert.equal(directReview.kind, 'ready', JSON.stringify(directReview));
    if (directReview.kind !== 'ready') assert.fail();
    const preparedCommand = await directCommands.prepareDirect(directReview.value);
    assert.equal(preparedCommand.kind, 'ready', JSON.stringify(preparedCommand));
    if (preparedCommand.kind !== 'ready') assert.fail();
    const repeatedPreparation = await directCommands.prepareDirect(directReview.value);
    assert.equal(repeatedPreparation.kind, 'ready');
    if (repeatedPreparation.kind !== 'ready') assert.fail();
    assert.deepEqual(repeatedPreparation.value, preparedCommand.value);
    directCommands.close();
    directCommands = createContentDirectCommands(directOptions);
    const directSaved = await directCommands.execute(preparedCommand.value);
    assert.equal(directSaved.kind, 'receipt', JSON.stringify(directSaved));
    if (directSaved.kind !== 'receipt') assert.fail();
    assert.deepEqual(await directCommands.execute(preparedCommand.value), directSaved);
    assert.deepEqual(
      {
        ...cookingWrite.database
          .prepare(
            `SELECT s.recipe_id recipeId,s.revision_id revisionId,
        s.content_fingerprint contentFingerprint FROM plan_content_pin s JOIN plan_occurrence p
        ON p.occurrence_id=s.occurrence_id WHERE p.local_date='2026-10-09' AND p.meal_key='dinner'`,
          )
          .get(),
      },
      ref,
      'A recreated host executes the registered command using the exact signed recipe revision',
    );
    assert.deepEqual(
      activePurchases(),
      demandBefore,
      'An unselected new meal does not change shopping',
    );
    const sessionOptions = { ...readingOptions, writer, now: () => at, onCommitted: () => {} };
    cookingSessions = createContentCookingSessions(sessionOptions);
    const saveProgress = {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: ref,
      expectedRevision: null,
      passageSequence: adoptedRead.value.recipe.instructions[0]!.sequence,
    };
    const savedProgress = await cookingSessions.saveSession(saveProgress);
    assert.equal(savedProgress.kind, 'ready', JSON.stringify(savedProgress));
    if (savedProgress.kind !== 'ready') assert.fail();
    cookingSessions.close();
    cookingSessions = createContentCookingSessions(sessionOptions);
    assert.deepEqual(await cookingSessions.saveSession(saveProgress), savedProgress);
    assert.equal(await migrateCookingContentDatabase(writer, { sha256 }), 'existing');
    const resumed = await cookingSessions.readSession(recipe.recipeId);
    assert.equal(resumed.kind, 'ready', JSON.stringify(resumed));
    if (resumed.kind !== 'ready') assert.fail();
    assert.deepEqual(resumed.value.recipe?.contentRef, ref);
    assert.equal(resumed.value.session?.sessionId, saveProgress.sessionId);
    assert.deepEqual(activePurchases(), demandBefore, 'Reading progress never changes Shopping');
    const archived = await issueAndCache({
      ...current,
      state: 'archived',
      reason: 'Synthetic archive fixture',
    });
    const archivedChoices = await adoption.readMealChoices({ candidateHead: archived });
    assert.equal(archivedChoices.items[0]!.current.title, draft.input.title);
    assert.equal(archivedChoices.items[0]!.target, null, 'archive offers no current replacement');
    assert.ok(
      (await recipeReads.discover()).value.some((item) => item.recipeId === recipe.recipeId),
      'new cache head stays inactive until cooking adopts',
    );
    await adoption.adopt(await adoption.review({ candidateHead: archived }));
    const archivedApp = createContentReader(
      (await content.readRetainedHead(await adoptedHead(archived, 3), [baseRef, ref])).snapshot,
    );
    assert.equal(archivedApp.getRecipe(recipe.recipeId), undefined);
    assert.equal(archivedApp.lookupExact(ref).kind, 'readable');
    const newerClient = await gatewayTurn(archivedApp.identity);
    assert.equal(newerClient.status, 409);
    await newerClient.arrayBuffer();
    assert.equal(providerCalls.length, 1, 'a new app identity cannot use stale gateway evidence');
    assert.equal(
      (await recipeReads.discover()).value.some((item) => item.recipeId === recipe.recipeId),
      false,
    );
    assert.equal((await recipeReads.readExact(ref)).value.kind, 'readable');
    const archivedProgress = await cookingSessions.readSession(recipe.recipeId);
    assert.equal(archivedProgress.kind, 'ready', JSON.stringify(archivedProgress));
    if (archivedProgress.kind !== 'ready') assert.fail();
    assert.deepEqual(archivedProgress.value.recipe?.contentRef, ref);
    assert.equal(archivedProgress.value.resume, 'exact');
    const rollback = await issueAndCache(current);
    assert.equal(rollback.sequence, 3);
    const rollbackChoices = await adoption.readMealChoices({ candidateHead: rollback });
    assert.deepEqual(rollbackChoices.items[0]!.current.contentRef, ref);
    assert.equal(rollbackChoices.items[0]!.target, null, 'the same exact version is not a change');
    await adoption.adopt(await adoption.review({ candidateHead: rollback }));
    const restored = createContentReader(
      (await content.readRetainedHead(await adoptedHead(rollback, 4), [baseRef, ref])).snapshot,
    );
    assert.deepEqual(restored.getRecipe(recipe.recipeId)!.contentRef, ref);
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM local_history_content_pin').all(),
      pinsBefore,
    );
    assert.deepEqual(cookingWrite.database.prepare('PRAGMA foreign_key_check').all(), []);
    const historyOptions = { ...sessionOptions, dateContext: directOptions.dateContext };
    cookingHistory = createContentCookingHistory(historyOptions);
    const cookedInput = {
      eventId: randomUUID(),
      contentRef: ref,
      expectedHistoryEpoch: 0,
      cookedOn: '2026-10-01',
      timeZone: 'Asia/Dubai',
      note: 'Synthetic exact-revision history fixture.',
    };
    const cookedResult = await cookingHistory.saveCooked(cookedInput);
    assert.equal(cookedResult.kind, 'ready', JSON.stringify(cookedResult));
    if (cookedResult.kind !== 'ready' || cookedResult.value.kind !== 'saved') assert.fail();
    assert.deepEqual(cookedResult.value.event.contentRef, ref);
    assert.equal(cookedResult.value.event.recipeTitle, draft.input.title);
    cookingHistory.close();
    cookingHistory = createContentCookingHistory(historyOptions);
    assert.deepEqual(await cookingHistory.saveCooked(cookedInput), cookedResult);
    assert.equal(await migrateCookingContentDatabase(writer, { sha256 }), 'existing');
    const historyWithExact = cookingWrite.database.prepare('SELECT * FROM cooking_event').all();
    assert.deepEqual(
      historyWithExact.filter((row) => row.event_id === event.eventId),
      historyBefore,
    );
    assert.equal(historyWithExact.length, historyBefore.length + 1);
    assert.deepEqual(activePurchases(), demandBefore, 'Recording a meal never changes Shopping');
    // Changes during actual content verification cannot leak results into a changed owner/head.
    for (const fault of ['generation', 'closed', 'adoption'] as const) {
      let raced!: ReturnType<typeof createAdoptedContentReader>;
      raced = createAdoptedContentReader({
        ...readingOptions,
        contentStore: {
          withVerifiedReading(selected, refs, work) {
            return content.withVerifiedReading(selected, refs, async (view) => {
              if (fault === 'generation') access = { ...access, authGeneration: 1 };
              if (fault === 'closed') raced.close();
              if (fault === 'adoption')
                await writer.transaction((session) =>
                  session.exec('UPDATE app_content_adoption SET revision=revision+1'),
                );
              return work(view);
            });
          },
        },
      });
      try {
        await assert.rejects(raced.readCurrent(recipe.recipeId), {
          code:
            fault === 'generation'
              ? 'access_changed'
              : fault === 'closed'
                ? 'closed'
                : 'adoption_changed',
        });
      } finally {
        raced.close();
        access = { ownerId: null, authGeneration: 0 };
        if (fault === 'adoption')
          await writer.transaction((session) =>
            session.exec('UPDATE app_content_adoption SET revision=4'),
          );
      }
    }
    // Re-delivering an old signed release is not the authorized rollback sequence.
    assert.ok(firstPackage);
    const replay = await content.stage({
      stageId: 'bridge-old-replay',
      envelope: firstPackage.envelope,
      publications: firstPackage.publications,
      media: firstMedia,
    });
    await assert.rejects(
      content.reviewStage(replay.stageId, { expectedHead: rollback, retainedRefs: [baseRef, ref] }),
    );
    await content.discardStage(replay.stageId, replay.packageFingerprint, replay.stageEpoch);
    await t.test(
      'private host verifies a real signed release, adopts separately, and reopens durable recovery without changing old plan pins',
      async () => {
        await assertContentWorkspaceHostBridge({
          directory: f.directory,
          trustKeys: trust,
          ports: verification,
          stage: {
            stageId: 'host-first-release',
            envelope: firstPackage!.envelope,
            publications: firstPackage!.publications,
            media: firstMedia,
          },
          ref,
          baseRef,
          expectedTitle: draft.input.title,
          expectedTranslation: {
            title: translated.translation.input.title,
            translationId: translated.translation.translationId,
            translationRevision: translated.translation.revision,
          },
          at,
        });
      },
    );
    await t.test(
      'private schema8 factory composes actual signed adoption/media, exact plans and revoked-listener recovery',
      async () => {
        await assertContentCookingStoreBridge({
          directory: f.directory,
          contentStore: content,
          head: rollback,
          ref,
          baseRef,
          expectedTitle: draft.input.title,
          media: originalMedia,
          sha256,
          sha256Bytes,
          at,
        });
      },
    );
    await t.test(
      'private account wrapper applies actual signed content with exact pins and late local edits',
      async (t) => {
        // Independent cooking storage adopts the already verified release before the later
        // withdrawal test. A permanently withdrawn recipe is never revived for this fixture.
        const cookingWrite = desktopConnection(join(f.directory, 'account-cooking.sqlite'));
        const cookingRead = desktopConnection(join(f.directory, 'account-cooking.sqlite'));
        const queue = new SqlTransactionQueue(),
          writer = new SerializedWriter(cookingWrite.connection, queue),
          reader = new SerializedReader(cookingRead.connection, queue);
        t.after(async () => {
          await reader.close();
          await writer.close();
        });
        await configureConnection(cookingWrite.connection);
        await configureConnection(cookingRead.connection);
        const ids = {
          installationId: randomUUID(),
          shoppingScopeId: randomUUID(),
          conversationId: randomUUID(),
        };
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
        await migrateCookingContentDatabase(writer, { sha256 });
        const ownerId = randomUUID(),
          accountScope = { ownerId, authGeneration: 1 };
        cookingWrite.database
          .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
          .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
        const adoption = createContentAdoptionService({
          reader,
          writer,
          contentStore: content,
          sha256,
          now: () => at,
          newId: randomUUID,
          getAccess: () => accountScope,
          assertAccess: (scope) => {
            assert.deepEqual(scope, accountScope);
            return undefined;
          },
        });
        await adoption.adopt(await adoption.review({ candidateHead: rollback }));
        const existingOptions = {
          reader,
          writer,
          contentStore: content,
          installationId: ids.installationId,
          sha256,
          now: () => at,
          getAccess: () => accountScope,
          assertAccess: (scope: Readonly<{ ownerId: string | null; authGeneration: number }>) => {
            assert.deepEqual(scope, accountScope);
            return undefined;
          },
          dateContext: () => ({
            localDate: '2026-10-01',
            timeZone: 'Asia/Dubai',
            utcOffsetMinutes: 240,
          }),
          onCommitted: () => {},
        };
        const existingCommands = createContentDirectCommands({
          ...existingOptions,
          platform: { newId: randomUUID, sha256 },
        });
        const existingHistory = createContentCookingHistory(existingOptions);
        try {
          const reviewed = await existingCommands.reviewDirect({
            kind: 'placeRecipe',
            recipeId: recipe.recipeId,
            placement: { actualDate: '2026-10-09', mealKey: 'lunch' },
          });
          assert.equal(reviewed.kind, 'ready', JSON.stringify(reviewed));
          if (reviewed.kind !== 'ready') assert.fail();
          const prepared = await existingCommands.prepareDirect(reviewed.value);
          assert.equal(prepared.kind, 'ready', JSON.stringify(prepared));
          if (prepared.kind !== 'ready') assert.fail();
          const saved = await existingCommands.execute(prepared.value);
          assert.equal(saved.kind, 'receipt', JSON.stringify(saved));
          if (saved.kind !== 'receipt') assert.fail();
          assert.equal(saved.receipt.outcome, 'committed');
          assert.ok(
            cookingWrite.database
              .prepare(
                "SELECT 1 FROM plan_occurrence WHERE recipe_id=? AND local_date='2026-10-09' AND meal_key='lunch'",
              )
              .get(recipe.recipeId),
            'the seeded command committed its actual Plan effect',
          );
          const recoveryBoundary = createContentReader(
            (await content.readRetainedHead(rollback, [ref])).snapshot,
          ).boundary;
          const acknowledged = await createDirectRecoveryRepository(writer, recoveryBoundary, {
            sha256,
          }).acknowledgeDirectRecovery(prepared.value.operationId);
          assert.equal(acknowledged.kind, 'ready', JSON.stringify(acknowledged));
          const cooked = await existingHistory.saveCooked({
            eventId: randomUUID(),
            contentRef: ref,
            expectedHistoryEpoch: 0,
            cookedOn: '2026-10-01',
            timeZone: 'Asia/Dubai',
            note: 'Existing local history must survive account apply.',
          });
          assert.equal(cooked.kind, 'ready', JSON.stringify(cooked));
          if (cooked.kind !== 'ready' || cooked.value.kind !== 'saved') assert.fail();
        } finally {
          existingCommands.close();
          existingHistory.close();
        }
        await migrateAccountContentHistoryDatabase(writer, { sha256 });
        const localSettings: AccountSnapshotOptions = {
          appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
          profile: { displayName: null },
        };
        const accountOptions = {
          reader,
          writer,
          installationId: ids.installationId,
          catalogue: catalogue.identity,
          currentScope: () => accountScope,
          getLocalSettings: () => localSettings,
          now: () => at,
          sha256,
        };
        let held = false,
          notifications = 0;
        const account = await createContentAccountServices({
          ...accountOptions,
          scope: accountScope,
          newId: randomUUID,
          contentStore: content,
          acquireExclusive: () => {
            if (held) return null;
            held = true;
            return () => {
              held = false;
            };
          },
          onCommitted: () => {
            notifications++;
          },
        });
        try {
          await account.approval.approve(
            accountScope,
            await account.approval.review(accountScope),
            {
              historyIncluded: true,
            },
          );
          const capturedLocal = await account.capture();
          const proposed: AccountContentSnapshot = JSON.parse(
            JSON.stringify(capturedLocal.snapshot),
          );
          const noteId = randomUUID(),
            eventId = randomUUID(),
            nextOccurrence = randomUUID();
          proposed.personal.notes.push({
            noteId,
            recipeId: recipe.recipeId,
            text: '  Signed-recipe private note\nملاحظة  ',
            deleted: false,
            createdAt: at,
            updatedAt: at,
          });
          proposed.plan.push({
            occurrenceId: nextOccurrence,
            recipeId: recipe.recipeId,
            placement: { actualDate: '2026-10-08', mealKey: 'dinner' },
            createdAt: at,
            updatedAt: at,
          });
          proposed.planReferences.push({ occurrenceId: nextOccurrence, contentRef: ref });
          proposed.shopping.selectedOccurrenceIds.push(nextOccurrence);
          proposed.cookingHistory!.entries.push({
            kind: 'exact',
            entry: {
              readerVersion: 2,
              eventId,
              recipeId: recipe.recipeId,
              contentRef: ref,
              recipeTitle: draft.input.title,
              photoAssetId: publishedMedia.assetId,
              cookedOn: '2026-10-01',
              timeZone: 'Asia/Dubai',
              recordedAt: at,
              note: 'Account history retains its original event ID.',
            },
          });
          const operationId = randomUUID();
          const staged = await account.journal.stage(accountScope, {
            operationId,
            expectedJournalRevision: 0,
            expectedDeviceDataOwnerId: ownerId,
            initialImportReviewed: false,
            capturedLocal,
            remote: {
              ownerId,
              revision: 1,
              snapshot: proposed,
              updatedAt: at,
              deletionOperationId: null,
            },
            proposed,
            mode: 'pull',
          });
          assert.ok(staged.pending);
          // A later local save must survive the rebase; it must not be misreported as server state.
          const lateRecipeId = catalogue.recipes[1]!.recipeId;
          cookingWrite.database
            .prepare(
              'INSERT INTO favourite VALUES (?,1,10000,?,?) ON CONFLICT(recipe_id) DO UPDATE SET saved=1,revision=10000,saved_at=excluded.saved_at,updated_at=excluded.updated_at',
            )
            .run(lateRecipeId, at, at);
          cookingWrite.database
            .prepare(
              "UPDATE state_revision SET revision=10000 WHERE collection IN ('store','favourites')",
            )
            .run();
          const identity = { operationId, requestFingerprint: staged.pending.requestFingerprint };
          const reviewed = await account.apply.review(accountScope, identity);
          assert.equal(reviewed.merge.status, 'merged');
          const originalEvents = cookingWrite.database
            .prepare('SELECT * FROM cooking_event ORDER BY event_id')
            .all();
          const originalReceipts = cookingWrite.database
            .prepare('SELECT * FROM operation_receipt ORDER BY operation_id')
            .all();
          assert.ok(
            originalEvents.length > 0,
            'preservation baseline contains genuine saved local history',
          );
          assert.ok(
            originalReceipts.length > 0,
            'preservation baseline contains a genuinely executed command receipt',
          );
          const receipt = await account.apply.apply(accountScope, reviewed);
          assert.ok(receipt.storeRevision > 10000);
          assert.equal(receipt.serverRevision, 1);
          assert.equal(notifications, 1);
          assert.equal(held, false);
          assert.deepEqual(await account.apply.recover(accountScope, identity), receipt);
          await assert.rejects(account.apply.apply(accountScope, reviewed), {
            reason: 'operation_changed',
          });
          assert.equal(notifications, 1, 'repeat does not reapply or notify');
          const saved = await account.journal.read(accountScope);
          assert.equal(saved?.pending, null);
          assert.equal(
            canonicalAccountContentSnapshot(saved!.base!.snapshot),
            canonicalAccountContentSnapshot(proposed),
            'base remains the exact accepted server snapshot',
          );
          assert.equal(
            saved?.base?.snapshot?.favourites.some((item) => item.recipeId === lateRecipeId),
            false,
          );
          assert.equal(
            cookingWrite.database
              .prepare('SELECT saved FROM favourite WHERE recipe_id=?')
              .get(lateRecipeId)?.saved,
            1,
          );
          assert.deepEqual(
            cookingWrite.database.prepare('SELECT * FROM cooking_event ORDER BY event_id').all(),
            originalEvents,
          );
          assert.deepEqual(
            cookingWrite.database
              .prepare('SELECT * FROM operation_receipt ORDER BY operation_id')
              .all(),
            originalReceipts,
          );
          const pin = cookingWrite.database
            .prepare(
              'SELECT recipe_id,revision_id,content_fingerprint FROM account_history_content_pin WHERE owner_id=? AND event_id=?',
            )
            .get(ownerId, eventId);
          assert.ok(pin);
          assert.deepEqual(
            { ...pin },
            {
              recipe_id: ref.recipeId,
              revision_id: ref.revisionId,
              content_fingerprint: ref.contentFingerprint,
            },
          );
          const currentCapture = await account.capture();
          assert.equal(
            currentCapture.snapshot.personal.notes.find((item) => item.noteId === noteId)?.text,
            proposed.personal.notes[0]!.text,
          );
          assert.equal(
            currentCapture.snapshot.cookingHistory?.entries.some(
              (item) => item.entry.eventId === eventId,
            ),
            true,
          );
          assert.deepEqual(
            currentCapture.snapshot.planReferences.find(
              (item) => item.occurrenceId === nextOccurrence,
            )?.contentRef,
            ref,
          );
          assert.deepEqual(
            currentCapture.snapshot.shopping.selectedOccurrenceIds,
            proposed.shopping.selectedOccurrenceIds,
          );
          assert.equal(providerCalls.length, 1, 'account apply performs no model call');
        } finally {
          account.close();
          await reader.close();
          await writer.close();
        }
      },
    );
    const withdrawn = await issueAndCache({
      state: 'withdrawn',
      recipeId: recipe.recipeId,
      reason: 'Synthetic rights withdrawal',
    });
    const withdrawnChoices = await adoption.readMealChoices({ candidateHead: withdrawn });
    assert.ok(withdrawnChoices.items.length > 0);
    assert.ok(
      withdrawnChoices.items.every(
        (item) =>
          item.current.title === null &&
          item.current.state === 'unavailable' &&
          item.target === null,
      ),
      'withdrawn source bodies stay absent even in the saved-meal chooser',
    );
    await assert.rejects(recipeReads.readCurrent(recipe.recipeId), { code: 'policy_changed' });
    await assert.rejects(recipeReads.readExact(ref), { code: 'policy_changed' });
    await assert.rejects(recipeReads.readPhoto(ref, publishedMedia.assetId), {
      code: 'policy_changed',
    });
    const denied = await gatewayTurn();
    assert.equal(denied.status, 409);
    assert.equal(
      ((await denied.json()) as { error: { messageKey: string } }).error.messageKey,
      'gateway.content_release_unavailable',
    );
    assert.equal(providerCalls.length, 1, 'withdrawal must reject before a model request');
    const recoveredCommand = await directCommands.recover(preparedCommand.value);
    assert.equal(recoveredCommand.kind, 'ready', JSON.stringify(recoveredCommand));
    if (recoveredCommand.kind !== 'ready') assert.fail();
    assert.deepEqual(
      recoveredCommand.value,
      directSaved.receipt,
      'Later adoption and withdrawal do not erase proven owner-scoped command history',
    );
    const unavailableProgress = await cookingSessions.readSession(recipe.recipeId);
    assert.equal(unavailableProgress.kind, 'ready', JSON.stringify(unavailableProgress));
    if (unavailableProgress.kind !== 'ready') assert.fail();
    assert.equal(unavailableProgress.value.resume, 'unavailable');
    assert.equal(unavailableProgress.value.recipe, null);
    assert.equal(unavailableProgress.value.session?.sessionId, saveProgress.sessionId);
    const recoveredProgress = await cookingSessions.recover({ kind: 'save', input: saveProgress });
    assert.equal(recoveredProgress.kind, 'ready', JSON.stringify(recoveredProgress));
    if (recoveredProgress.kind !== 'ready') assert.fail();
    assert.deepEqual(recoveredProgress.value, savedProgress.value);
    const dismissedProgress = await cookingSessions.dismissSession({
      operationId: randomUUID(),
      recipeId: recipe.recipeId,
      sessionId: saveProgress.sessionId,
      expectedRevision: savedProgress.value.session.revision,
    });
    assert.equal(dismissedProgress.kind, 'ready', JSON.stringify(dismissedProgress));
    if (dismissedProgress.kind !== 'ready') assert.fail();
    assert.equal(dismissedProgress.value.session.state, 'dismissed');
    const recoveredCooked = await cookingHistory.recover(cookedInput);
    assert.equal(recoveredCooked.kind, 'ready', JSON.stringify(recoveredCooked));
    if (recoveredCooked.kind !== 'ready') assert.fail();
    assert.deepEqual(recoveredCooked.value, cookedResult.value);
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM cooking_event').all(),
      historyWithExact,
    );
    historyReader = createContentCookingHistoryReader(readingOptions);
    const historyPage = await historyReader.readHistory({ limit: 1 });
    assert.equal(historyPage.kind, 'ready', JSON.stringify(historyPage));
    if (historyPage.kind !== 'ready') assert.fail();
    assert.ok(historyPage.value.nextCursor);
    const historyNext = await historyReader.readHistory({
      cursor: historyPage.value.nextCursor,
      limit: 1,
    });
    assert.equal(historyNext.kind, 'ready', JSON.stringify(historyNext));
    if (historyNext.kind !== 'ready') assert.fail();
    const mixedHistory = [...historyPage.value.items, ...historyNext.value.items];
    assert.deepEqual(
      mixedHistory.map((item) => item.entry.eventId).sort(),
      [event.eventId, cookedInput.eventId].sort(),
    );
    assert.deepEqual(mixedHistory.find((item) => item.entry.eventId === cookedInput.eventId)?.pin, {
      kind: 'exact',
      ref,
    });
    assert.equal(historyNext.value.nextCursor, null);
    contentBackup = createPortableContentBackupReader({
      ...readingOptions,
      catalogue: catalogue.identity,
      now: () => at,
    });
    const capturedBackup = await contentBackup.capture({ includeCookingHistory: true });
    assert.equal(capturedBackup.kind, 'ready', JSON.stringify(capturedBackup));
    if (capturedBackup.kind !== 'ready') assert.fail();
    assert.deepEqual(
      capturedBackup.value.data.planReferences.find((pin) => pin.occurrenceId === occurrence)
        ?.contentRef,
      ref,
    );
    assert.equal(capturedBackup.value.data.cookingHistory?.entries.length, 2);
    const backupFile = join(f.directory, 'exact-history-backup.json');
    await writeFile(backupFile, JSON.stringify(capturedBackup.value), 'utf8');
    const inspectedBackup = await validatePortableContentBackup(
      await readFile(backupFile, 'utf8'),
      { sha256 },
    );
    assert.equal(inspectedBackup.kind, 'ready', JSON.stringify(inspectedBackup));
    if (inspectedBackup.kind !== 'ready') assert.fail();
    assert.deepEqual(inspectedBackup.value, capturedBackup.value);
    assert.equal(inspectedBackup.preview.archiveVerification, 'not_performed');
    assert.equal(inspectedBackup.preview.restoreAvailable, false);
    const archiveInspector = createPortableContentBackupInspector(readingOptions);
    try {
      const verifiedFile = await archiveInspector.inspect(await readFile(backupFile, 'utf8'));
      assert.equal(verifiedFile.kind, 'ready', JSON.stringify(verifiedFile));
      if (verifiedFile.kind !== 'ready') assert.fail();
      assert.equal(verifiedFile.value.archiveVerification, 'performed');
      assert.equal(verifiedFile.value.exactReferencesAvailable, false);
      assert.ok(verifiedFile.value.references.length > 0);
      assert.ok(verifiedFile.value.references.every((item) => item.state === 'withdrawn'));
      assert.equal(verifiedFile.value.restoreAvailable, false);
      assert.deepEqual(verifiedFile.value.historyIssues, []);
    } finally {
      archiveInspector.close();
    }
    const progressBeforeClear = cookingWrite.database
      .prepare('SELECT * FROM cooking_session')
      .all();
    const clearOptions = { ...sessionOptions, newId: randomUUID };
    historyClear = createContentCookingHistoryClear(clearOptions);
    const historyReview = await historyClear.reviewClearHistory();
    assert.equal(historyReview.kind, 'ready', JSON.stringify(historyReview));
    if (historyReview.kind !== 'ready') assert.fail();
    assert.equal(historyReview.value.count, 2);
    const clearId = randomUUID();
    const clearedHistory = await historyClear.clearHistory(historyReview.value, clearId);
    assert.equal(clearedHistory.kind, 'ready', JSON.stringify(clearedHistory));
    if (clearedHistory.kind !== 'ready') assert.fail();
    historyClear.close();
    historyClear = createContentCookingHistoryClear(clearOptions);
    assert.deepEqual(await historyClear.readClearHistoryReceipt(clearId), clearedHistory);
    assert.deepEqual(await historyClear.clearHistory(historyReview.value, clearId), clearedHistory);
    const afterClear = await historyReader.readHistory();
    assert.equal(afterClear.kind, 'ready', JSON.stringify(afterClear));
    if (afterClear.kind !== 'ready') assert.fail();
    assert.deepEqual(afterClear.value.items, []);
    const capturedAfterClear = await contentBackup.capture({ includeCookingHistory: true });
    assert.equal(capturedAfterClear.kind, 'ready', JSON.stringify(capturedAfterClear));
    if (capturedAfterClear.kind !== 'ready') assert.fail();
    assert.deepEqual(capturedAfterClear.value.data.cookingHistory?.entries, []);
    const afterClearInspector = createPortableContentBackupInspector(readingOptions);
    try {
      const oldFile = await afterClearInspector.inspect(await readFile(backupFile, 'utf8'));
      assert.equal(oldFile.kind, 'ready', JSON.stringify(oldFile));
      if (oldFile.kind !== 'ready') assert.fail();
      assert.deepEqual(
        [...oldFile.value.historyIssues].sort((a, b) => a.eventId.localeCompare(b.eventId)),
        [event.eventId, cookedInput.eventId]
          .map((eventId) => ({ eventId, reason: 'previously_removed' }))
          .sort((a, b) => a.eventId.localeCompare(b.eventId)),
      );
    } finally {
      afterClearInspector.close();
    }
    const clearedRecovery = await cookingHistory.recover(cookedInput);
    assert.equal(clearedRecovery.kind, 'ready', JSON.stringify(clearedRecovery));
    if (clearedRecovery.kind !== 'ready') assert.fail();
    assert.deepEqual(clearedRecovery.value, {
      kind: 'cleared',
      eventId: cookedInput.eventId,
      historyEpoch: cookedInput.expectedHistoryEpoch,
    });
    assert.equal(
      (await historyReader.readHistory({ cursor: historyPage.value.nextCursor })).kind,
      'failed',
    );
    assert.deepEqual(
      activePurchases(),
      demandBefore,
      'An explicit history clear never changes Shopping',
    );
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM cooking_session').all(),
      progressBeforeClear,
      'Clear history preserves reading progress',
    );
    assert.deepEqual(
      cookingWrite.database.prepare('SELECT * FROM local_history_content_pin').all(),
      [],
    );
    assert.equal(await migrateCookingContentDatabase(writer, { sha256 }), 'existing');
    recipeReads.close();
    assert.deepEqual(
      await adoption.recover({
        operationId: changeReview.operationId,
        requestFingerprint: changeReview.requestFingerprint,
        ownerId: changeReview.ownerId,
        installationId: changeReview.installationId,
      }),
      changed,
    );
  } finally {
    contentBackup?.close();
    historyClear?.close();
    historyReader?.close();
    cookingHistory?.close();
    cookingSessions?.close();
    directCommands?.close();
    await runningGateway?.app.close();
    await reader.close();
    await writer.close();
    await content.close();
  }
});
