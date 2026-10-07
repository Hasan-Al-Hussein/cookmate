import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogue } from '@cookmate/catalogue';
import {
  checkAssistantRequest,
  checkAssistantResponse,
  checkMemoryResponseForRequest,
} from '@cookmate/contracts';
import type {
  AiProposal,
  AssistantTurnRequest,
  AssistantTurnResponse,
  DateContext,
  ReferenceSet,
} from '@cookmate/contracts';
import type {
  AssistantContextSelection,
  DirectActionInput,
  RepositoryResult,
} from '@cookmate/domain';
import { createAssistantCoordinator } from '../../mobile/src/assistant-core/coordinator';
import { buildAssistantRequest } from '../../mobile/src/assistant-core/context';
import type { GatewayConnection } from '../../mobile/src/connection';
import {
  ConnectionError,
  connectionError,
  readHttpError,
} from '../../mobile/src/connection/errors';
import { createLocalStore } from '../../mobile/src/data/localStore';
import { desktopConnection } from '../../../packages/domain/test/helpers/sqlite';
import { createEvidenceBuilder, evidenceSourceKeys, sourceKey } from '../src/evidence';
import { safeError } from '../src/errors';
import { expandMemoryUpdate } from '../src/memory';
import { responseEnvelope } from '../src/orchestrator';
import { DATE } from './plan';
import type { EvaluationCase } from './plan';
import { fullSetup } from './full-setup';

export class SetupCleanupFailure extends Error {
  constructor(primary: unknown) {
    super('materialization_failed_with_cleanup_failure', { cause: primary });
  }
}
export async function cleanupFailedMaterialization(
  primary: unknown,
  close: () => Promise<void>,
): Promise<never> {
  try {
    await close();
  } catch {
    throw new SetupCleanupFailure(primary);
  }
  throw primary;
}

function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', 'real_service_read_failed');
  if (result.kind !== 'ready') throw new Error('real_service_read_failed');
  return result.value;
}
const platform = {
  newId: randomUUID,
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
};
export interface SetupScript {
  user: string;
  text: string;
  ids: string[];
  proposal?: AiProposal;
  retain?: 'context' | 'unresolved_intent';
  selection?: AssistantContextSelection;
}
export const SCRIPTS = {
  RC: {
    user: 'Show Fettuccine Alfredo and Fettucine alfredo in that order.',
    text: '1. Fettuccine Alfredo\n2. Fettucine alfredo',
    ids: ['53064', '52835'],
  },
  RA: {
    user: 'List Padron peppers, Adana kebab and Bread omelette in that order.',
    text: '1. Padron peppers\n2. Adana kebab\n3. Bread omelette',
    ids: ['53150', '53262', '53076'],
  },
  RB: {
    user: 'List Ajo blanco, Spaghetti alla Carbonara and Apam balik in that order.',
    text: '1. Ajo blanco\n2. Spaghetti alla Carbonara\n3. Apam balik',
    ids: ['53169', '52982', '53049'],
  },
  neutral: { user: 'Thanks.', text: 'You’re welcome.', ids: [] },
  preference: {
    user: 'Remember that I prefer Italian cuisine.',
    text: 'Review saving Italian as a cuisine preference.',
    ids: [],
    proposal: { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
    retain: 'context',
  },
  correction: {
    user: 'Save Adana kebab to my favourites.',
    text: 'Review saving Adana kebab to favourites.',
    ids: ['53262'],
    proposal: { kind: 'saveRecipe', recipeId: '53262' },
    retain: 'unresolved_intent',
    selection: { selectedRecipeId: '53262' },
  },
} satisfies Record<string, SetupScript>;

/** Only normal response values are scripted. Data alone writes acceptance/authority records. */
function setupResponse(request: AssistantTurnRequest, script: SetupScript): AssistantTurnResponse {
  assert.equal(request.message.text, script.user);
  assert.ok(checkAssistantRequest(request, catalogue.boundary).ok);
  assert.deepEqual(request.context.memory.reviewTargetMessageIds, [request.message.messageId]);
  const sources = script.ids.map((recipeId) => ({ recipeId, section: 'recipe' as const }));
  const allowed = evidenceSourceKeys(createEvidenceBuilder().packet(script.ids));
  assert.ok(sources.every((source) => allowed.has(sourceKey(source))));
  const response: AssistantTurnResponse = {
    ...responseEnvelope(request),
    ...(script.proposal
      ? { kind: 'proposal' as const, proposals: [script.proposal] }
      : { kind: 'answer' as const }),
    text: script.text,
    sources,
    referenceSets: script.ids.length
      ? [
          {
            referenceSetId: platform.newId(),
            messageId: platform.newId(),
            recipeIds: [script.ids[0]!, ...script.ids.slice(1)],
          },
        ]
      : [],
    memoryUpdate: expandMemoryUpdate(
      {
        baseRevision: request.context.memory.projectionRevision,
        baseContextRevision: request.context.memory.baseContextRevision,
        reviews: [
          {
            sourceMessageId: request.message.messageId,
            disposition: script.retain ? 'retain' : 'non_memory',
          },
        ],
        entries: script.retain
          ? [
              {
                sourceMessageId: request.message.messageId,
                kind: script.retain,
                scope: { kind: 'conversation' },
                relations: [],
              },
            ]
          : [],
      },
      request,
    ),
  };
  assert.ok(checkAssistantResponse(response, catalogue.boundary).ok);
  assert.ok(checkMemoryResponseForRequest(response, request).ok);
  return response;
}

export async function materialize(
  directory: string,
  item: EvaluationCase,
  options: { fullSuite?: boolean } = {},
) {
  await mkdir(directory, { recursive: false });
  let generation = 1;
  let stamp = Date.parse('2026-09-28T08:00:00.000Z');
  let date: DateContext = { ...DATE };
  let handler: ((request: AssistantTurnRequest) => Promise<AssistantTurnResponse>) | undefined;
  let acceptance: unknown = null;
  const unused = async (): Promise<never> => {
    throw new Error('fixture_network_denied');
  };
  const connection: GatewayConnection = {
    getState: () => ({ status: 'paired', generation }),
    restore: unused,
    health: unused,
    pair: unused,
    forget: unused,
    revokeAndForget: unused,
    cancel: () => {
      generation++;
    },
    turn: async (request) => {
      if (!handler) throw new Error('fixture_network_denied');
      return handler(request);
    },
  };
  const openStore = () =>
    createLocalStore({
      openConnection: async () => desktopConnection(join(directory, 'state.sqlite')).connection,
      platform,
      now: () => new Date(stamp++).toISOString(),
      dateContext: () => ({ ...date }),
    });
  const initialized = await openStore();
  assert.equal(initialized.kind, 'ready', 'store_initialization_failed');
  if (initialized.kind !== 'ready') throw new Error('store_initialization_failed');
  let services = initialized.services;
  let closed = false;
  let persistence = services.assistant({ connectionGeneration: () => generation });
  const makeCore = () =>
    createAssistantCoordinator({
      persistence:
        options.fullSuite && item.id === 'L45'
          ? {
              ...persistence,
              beginTurn: (input) =>
                persistence.beginTurn({
                  ...input,
                  request: { ...input.request, capabilities: [] },
                }),
            }
          : persistence,
      services,
      connection,
      platform,
      currentDate: () => ({ ...date }),
    });
  let core = makeCore();
  const setup: unknown[] = [];
  const bindings: Record<string, string | ReferenceSet> = {};
  async function snapshot() {
    return {
      favourites: ready(await services.queries.readFavourites()),
      preferences: ready(await services.queries.readPreferences()),
      plan: ready(await services.queries.readPlan('2026-09-28', '2026-10-11')),
      shopping: ready(await services.queries.readShopping()),
    };
  }
  async function scripted(script: SetupScript) {
    let actualRequest: AssistantTurnRequest | undefined;
    handler = async (request) => {
      actualRequest = structuredClone(request);
      return setupResponse(request, script);
    };
    const outcome = await core.send(script.user, script.selection ?? {});
    handler = undefined;
    assert.equal(outcome.kind, 'reply', 'scripted_setup_not_accepted');
    assert.ok(actualRequest);
    if (outcome.kind !== 'reply') throw new Error('scripted_setup_not_accepted');
    if (outcome.response.kind === 'error') throw new Error('scripted_setup_error');
    const accepted = ready(await persistence.readAcceptance(actualRequest.userIntentId));
    assert.ok(accepted?.response);
    setup.push({
      kind: 'OFFLINE_SYNTHETIC_RESPONSE',
      script,
      request: actualRequest,
      outcome,
      accepted,
    });
    return { request: actualRequest, response: outcome.response, accepted };
  }
  async function direct(input: DirectActionInput) {
    const review = ready(await services.commands.reviewDirect(input));
    const command = ready(await services.commands.prepareDirect(review));
    const result = await services.commands.execute(command);
    assert.equal(result.kind, 'receipt', 'setup_command_failed');
    if (result.kind !== 'receipt') throw new Error('setup_command_failed');
    assert.deepEqual(
      ready(await services.queries.readReceipt(command.operationId)),
      result.receipt,
    );
    setup.push({ kind: 'REAL_SETUP_COMMAND', input, review, command, result });
    return result;
  }
  async function reopen(localDate: string) {
    const before = await persisted();
    core.invalidate();
    await services.close();
    date = { ...date, localDate };
    stamp = Math.max(stamp, Date.parse(`${localDate}T08:00:00.000Z`));
    const reopened = await openStore();
    assert.equal(reopened.kind, 'ready', 'real_store_reopen_failed');
    if (reopened.kind !== 'ready') throw new Error('real_store_reopen_failed');
    services = reopened.services;
    persistence = services.assistant({ connectionGeneration: () => generation });
    core = makeCore();
    const after = await persisted();
    assert.deepEqual(after, before, 'reopen_changed_persisted_records');
    const proof = {
      kind: 'REAL_FILE_STORE_CLOSE_REOPEN',
      scope: 'desktop_persistence_only',
      before,
      after,
      date: { ...date },
    };
    setup.push(proof);
    return proof;
  }
  async function persisted() {
    // Read-only evidence from the same file; never patch, summarize or inject memory.
    const owned = desktopConnection(join(directory, 'state.sqlite'));
    try {
      await owned.connection.exec('PRAGMA query_only=ON');
      const tables = await owned.connection.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const records: Record<string, unknown> = {};
      for (const { name } of tables) {
        assert.match(name, /^[a-z_]+$/);
        const rows = await owned.connection.all(`SELECT * FROM "${name}" ORDER BY rowid`);
        records[name] = [
          'recipe',
          'ingredient_entry',
          'instruction_passage',
          'quality_annotation',
          'annotation_evidence',
        ].includes(name)
          ? {
              rowCount: rows.length,
              sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
            }
          : rows;
      }
      return records;
    } finally {
      await owned.connection.close();
    }
  }
  try {
    const baseline = await snapshot();
    assert.equal(baseline.favourites.length, 0);
    assert.equal(baseline.preferences.revision, 0);
    assert.equal(baseline.plan.occurrences.length, 0);
    if (item.id === 'L14') {
      const result = await scripted(SCRIPTS.RC);
      bindings.RC = structuredClone(result.response.referenceSets[0]!);
    }
    if (item.id === 'L21') {
      const first = await scripted(SCRIPTS.RA);
      bindings.RA = structuredClone(first.response.referenceSets[0]!);
      bindings.MA = first.accepted.acceptanceEnvelope.assistantMessageId;
      for (let i = 0; i < 10; i++) await scripted(SCRIPTS.neutral);
      const recent = await scripted(SCRIPTS.RB);
      bindings.RB = structuredClone(recent.response.referenceSets[0]!);
    }
    if (item.id === 'L30') {
      const result = await scripted(SCRIPTS.preference);
      assert.equal(result.response.kind, 'proposal');
      if (result.response.kind !== 'proposal') throw new Error('setup_proposal_missing');
      const plan = await core.approve(result.request.userIntentId, {
        source: 'explicit_user',
        proposals: result.response.proposals,
        replacementConfirmations: [],
      });
      const outcome = await core.dispatch(result.request.userIntentId);
      const receipts = await Promise.all(
        plan.slots.map(async (slot) => ready(await services.queries.readReceipt(slot.operationId))),
      );
      assert.ok(receipts.every(Boolean));
      setup.push({ kind: 'TRUSTED_SETUP_CONFIRMATION', plan, outcome, receipts });
      const prefs = ready(await services.queries.readPreferences());
      assert.equal(prefs.revision, 1);
      const row = prefs.items[0];
      assert.ok(row);
      bindings.preferenceId = row.preferenceId;
      bindings.preferenceSourceId = result.request.message.messageId;
      await direct({ kind: 'removePreference', preferenceId: row.preferenceId });
    }
    if (item.id === 'L35') {
      await direct({
        kind: 'placeRecipe',
        recipeId: '53076',
        placement: { actualDate: '2026-10-06', mealKey: 'breakfast' },
      });
      const occurrence = ready(await services.queries.readPlan('2026-10-06', '2026-10-06'))
        .occurrences[0];
      assert.ok(occurrence);
      bindings.OB = occurrence.occurrenceId;
      for (const mealKey of ['lunch', 'breakfast', 'dinner'] as const)
        await direct({
          kind: 'placeRecipe',
          recipeId: '53076',
          occurrenceId: occurrence.occurrenceId,
          placement: { actualDate: '2026-10-06', mealKey },
        });
      for (let i = 0; i < 9; i++)
        await direct({
          kind: 'setShoppingSelection',
          occurrenceIds: i % 2 ? [] : [occurrence.occurrenceId],
        });
    }
    if (item.id === 'L37') {
      const result = await scripted(SCRIPTS.correction);
      bindings.predecessorIntent = result.request.userIntentId;
      await core.cancel(result.request.userIntentId);
      const cancelled = ready(await persistence.readIntent(result.request.userIntentId));
      assert.equal(cancelled?.intent.phase, 'cancelled');
      assert.equal(cancelled?.actionPlan, null);
      setup.push({ kind: 'REAL_CANCELLATION', cancelled });
    }
    if (options.fullSuite)
      await fullSetup(item.id, {
        scripted,
        direct,
        bindings,
        setup,
        setClock: (next, instant) => {
          date = { ...date, localDate: next };
          stamp = Date.parse(instant);
        },
        reopen,
        persisted,
        commit: async (result) => {
          assert.equal(result.response.kind, 'proposal');
          if (result.response.kind !== 'proposal') throw new Error('setup_proposal_missing');
          const plan = await core.approve(result.request.userIntentId, {
            source: 'explicit_user',
            proposals: result.response.proposals,
            replacementConfirmations: [],
          });
          const outcome = await core.dispatch(result.request.userIntentId);
          const receipts = await Promise.all(
            plan.slots.map((slot) => services.queries.readReceipt(slot.operationId)),
          );
          assert.ok(receipts.every((receipt) => receipt.kind === 'ready' && receipt.value));
          setup.push({ kind: 'TRUSTED_SETUP_CONFIRMATION', plan, outcome, receipts });
        },
      });
    let currentItem = item;
    let selection: AssistantContextSelection = item.input.selectedRecipeExpectation
      ? { selectedRecipeId: item.input.selectedRecipeExpectation }
      : {};
    async function prepareRequest(next: EvaluationCase) {
      currentItem = next;
      selection = next.input.selectedRecipeExpectation
        ? { selectedRecipeId: next.input.selectedRecipeExpectation }
        : {};
      const messageId = platform.newId();
      const context = await persistence.readContext({
        text: next.input.prompt,
        selection,
        messageId,
      });
      assert.equal(context.kind, 'ready', 'setup_context_unavailable');
      if (context.kind !== 'ready') throw new Error('setup_context_unavailable');
      const built = buildAssistantRequest(context.value, {
        text: next.input.prompt,
        selection,
        date: { ...date },
        ids: {
          requestId: platform.newId(),
          userIntentId: platform.newId(),
          intentRevision: 0,
          messageId,
          connectionGeneration: generation,
        },
      });
      assert.equal(built.kind, 'ready', 'setup_request_unavailable');
      if (built.kind !== 'ready') throw new Error('setup_request_unavailable');
      return options.fullSuite && item.id === 'L45'
        ? { ...built.request, capabilities: [] }
        : built.request;
    }
    const request = await prepareRequest(item);
    const state = await snapshot();
    assert.equal(state.favourites.length, 0);
    if (!['L40', 'L41'].includes(item.id)) assert.equal(state.preferences.items.length, 0);
    if (!['L35', 'L38'].includes(item.id)) assert.equal(state.plan.occurrences.length, 0);
    if (item.id === 'L14')
      assert.deepEqual(
        request.context.referenceSets.map((set) => set.recipeIds),
        [['53064', '52835']],
      );
    if (item.id === 'L21') {
      assert.equal(request.context.referenceSets.length, 2);
      const ra = bindings.RA as ReferenceSet;
      const rb = bindings.RB as ReferenceSet;
      assert.deepEqual(
        request.context.referenceSets.find((set) => set.referenceSetId === ra.referenceSetId)
          ?.recipeIds,
        ['53150', '53262', '53076'],
      );
      assert.deepEqual(
        request.context.referenceSets.find((set) => set.referenceSetId === rb.referenceSetId)
          ?.recipeIds,
        ['53169', '52982', '53049'],
      );
      assert.ok(!request.context.history.some((message) => message.messageId === bindings.MA));
      assert.deepEqual(ready(await persistence.readReferenceSets([ra.referenceSetId])), [ra]);
      assert.equal(request.context.history.length, 20);
      assert.equal(request.context.selectedRecipeId, undefined);
    }
    if (item.id === 'L30') {
      assert.equal(request.context.preferences.revision, 2);
      assert.equal(request.context.preferences.lastRemovalRevision, 2);
      const source = request.context.memory.items.find(
        (memory) => memory.sourceMessageId === bindings.preferenceSourceId,
      );
      assert.ok(source, 'deleted_preference_source_missing');
      assert.equal(source.preferenceRevisionAtSource, 0);
      assert.equal(source.preferenceLinks[0]?.savedRevision, 1);
      assert.equal(source.preferenceLinks[0]?.removedRevision, 2);
    }
    if (item.id === 'L35') {
      assert.equal(state.plan.occurrences[0]?.occurrenceId, bindings.OB);
      assert.equal(state.plan.occurrences[0]?.revision, 4);
      assert.equal(state.plan.occurrences[0]?.placement.mealKey, 'dinner');
      assert.equal(state.shopping.scope.revision, 9);
      assert.equal(state.shopping.projectionRevision, 9);
      assert.equal(state.shopping.selectedOccurrences[0]?.occurrenceId, bindings.OB);
    }
    if (item.id === 'L37')
      assert.ok(
        request.context.history.some((message) => message.text === SCRIPTS.correction.user),
      );
    if (options.fullSuite) {
      if (['L13', 'L16', 'L19', 'L39', 'L42'].includes(item.id))
        assert.equal(request.context.referenceSets.length, 1, 'explicit_reference_setup_missing');
      if (['L20', 'L22', 'L24'].includes(item.id))
        assert.equal(request.context.referenceSets.length, 2, 'two_reference_setup_missing');
      if (item.id === 'L22') {
        assert.equal(request.context.history.length, 20);
        assert.ok(
          !request.context.history.some(
            (message) => message.messageId === bindings.MA || message.messageId === bindings.MB,
          ),
          'old_reference_in_recent_history',
        );
      }
      if (item.id === 'L23') assert.equal(request.context.selectedRecipeId, '53076');
      if (item.id === 'L26') {
        assert.equal(request.context.date.localDate, '2026-09-29');
        assert.equal(request.context.memory.items.length, 2, 'relative_date_sources_missing');
        assert.ok(
          request.context.memory.items.every(
            (memory) => memory.sourceDateContext.localDate === '2026-09-28',
          ),
          'relative_date_source_rewritten',
        );
      }
      if (item.id === 'L27') {
        assert.equal(request.context.memory.items.length, 2, 'unresolved_sources_missing');
        assert.ok(
          request.context.memory.items.every(
            (memory) =>
              !request.context.history.some(
                (message) => message.messageId === memory.sourceMessageId,
              ),
          ),
          'unresolved_sources_not_old',
        );
      }
      if (item.id === 'L36')
        assert.ok(
          request.context.history.some((message) => message.text === 'Saved Padron peppers'),
        );
      if (item.id === 'L38') {
        assert.equal(state.plan.occurrences.length, 1);
        assert.equal(state.plan.occurrences[0]?.recipeId, '53262');
        assert.deepEqual(state.plan.occurrences[0]?.placement, {
          actualDate: '2026-10-05',
          mealKey: 'dinner',
        });
      }
      if (item.id === 'L40') assert.equal(state.preferences.items[0]?.value, 'Italian');
      if (item.id === 'L41') {
        assert.equal(state.preferences.items[0]?.value, 'peanut butter');
        assert.equal(state.preferences.items[0]?.type, 'ingredient_avoid');
        assert.equal(request.conversationGeneration, 1);
        assert.equal(request.context.history.length, 0);
        assert.equal(request.context.memory.items.length, 0);
        assert.equal(request.context.referenceSets.length, 0);
      }
      if (item.id === 'L45') assert.deepEqual(request.capabilities, []);
    }
    const initialEvidence = createEvidenceBuilder().initial(request);
    const artifact = {
      status: 'OFFLINE_SETUP_VERIFIED',
      liveCredit: false,
      caseId: item.id,
      baseline,
      bindings,
      setup,
      request,
      state,
      initialEvidence,
    };
    return {
      artifact,
      async prepareTurn(next: EvaluationCase) {
        artifact.request = await prepareRequest(next);
        artifact.initialEvidence = createEvidenceBuilder().initial(artifact.request);
        artifact.state = await snapshot();
        return artifact;
      },
      async judge(turn: (request: AssistantTurnRequest) => Promise<AssistantTurnResponse>) {
        let actual: AssistantTurnRequest | undefined;
        acceptance = null;
        handler = async (request) => {
          actual = structuredClone(request);
          try {
            return await turn(request);
          } catch (error) {
            // Preserve the server JSON/mobile error boundary without opening a transport.
            const body: unknown = JSON.parse(JSON.stringify({ error: safeError(error).detail }));
            const detail = readHttpError(body);
            throw detail ? new ConnectionError(detail) : connectionError('invalid_model_result');
          }
        };
        try {
          const outcome = await core.send(currentItem.input.prompt, selection);
          if (options.fullSuite && actual) {
            acceptance = ready(await persistence.readAcceptance(actual.userIntentId));
            if (outcome.kind === 'reply') {
              assert.ok(acceptance, 'judged_acceptance_missing');
              assert.deepEqual(
                (acceptance as { request: unknown }).request,
                actual,
                'accepted_request_differs_from_dispatch',
              );
            }
          }
          if (options.fullSuite && item.id === 'L45' && outcome.kind === 'reply') {
            assert.equal(
              outcome.response.kind === 'proposal',
              false,
              'restricted_capabilities_proposal',
            );
          }
          return outcome;
        } finally {
          handler = undefined;
        }
      },
      snapshot,
      acceptanceEvidence: () => acceptance,
      reopen,
      persisted,
      async resume() {
        assert.ok(closed, 'fixture_already_open');
        const restored = await openStore();
        assert.equal(restored.kind, 'ready');
        if (restored.kind !== 'ready') throw new Error('fixture_resume_failed');
        services = restored.services;
        persistence = services.assistant({ connectionGeneration: () => generation });
        core = makeCore();
        closed = false;
      },
      async close() {
        if (!closed) {
          await services.close();
          closed = true;
        }
      },
    };
  } catch (error) {
    return cleanupFailedMaterialization(error, () => services.close());
  }
}
