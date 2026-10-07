import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogueBoundary } from '@cookmate/catalogue';
import type { AssistantTurnRequest, AssistantTurnResponse, DateContext } from '@cookmate/contracts';
import type {
  AssistantPersistencePort,
  CookMateServices,
  RepositoryResult,
} from '@cookmate/domain';
import { createAssistantCoordinator } from '../../mobile/src/assistant-core/coordinator';
import type { TurnOutcome } from '../../mobile/src/assistant-core/coordinator';
import { AssistantCoreError } from '../../mobile/src/assistant-core/actions';
import { createSecureCredentialStore } from '../../mobile/src/connection/credentials';
import { createGatewayConnection } from '../../mobile/src/connection/transport';
import { createLocalStore } from '../../mobile/src/data/localStore';
import {
  desktopConnection,
  removeFixtureDirectory,
} from '../../../packages/domain/test/helpers/sqlite';
import { createGateway } from '../src/server';
import { createCredentialRegistry, createFileRegistryStorage } from '../src/registry';
import { createOrchestrator } from '../src/orchestrator';
import type { ModelProvider, ProviderInput } from '../src/provider-contract';
import { deferred, nonMemoryUpdate } from './helpers';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const date: DateContext = {
  localDate: '2026-09-28',
  timeZone: 'Asia/Dubai',
  utcOffsetMinutes: 240,
};
const endpoint = 'https://cookmate-fixture.invalid';

function ready<Value>(result: RepositoryResult<Value>): Value {
  if (result.kind !== 'ready') assert.fail(JSON.stringify(result.error));
  return result.value;
}

function reply(outcome: TurnOutcome) {
  if (outcome.kind !== 'reply' || outcome.response.kind === 'error')
    assert.fail(JSON.stringify(outcome));
  assert.equal(outcome.actionStatus, 'not_executed');
  return outcome.response;
}

test(
  'two file-backed clients keep equal-ID gateway proposals, confirmations and reopened receipts isolated',
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-isolation-'));
    const gates = [deferred<void>(), deferred<void>()];
    const bothEntered = deferred<void>();
    const actionInputs: ProviderInput[] = [];
    let providerCalls = 0;
    let holdActions = true;
    const clients: Awaited<ReturnType<typeof openClient>>[] = [];
    const inFlight: Promise<TurnOutcome>[] = [];
    let storage: Awaited<ReturnType<typeof createFileRegistryStorage>> | undefined;
    let gateway: ReturnType<typeof createGateway> | undefined;
    t.after(async () => {
      gates.forEach((gate) => gate.resolve());
      clients.forEach((client) => client.connection.cancel());
      await Promise.allSettled(inFlight);
      const closed = await Promise.allSettled([
        ...clients.map((client) => client.close()),
        gateway?.app.close(),
        storage?.close(),
      ]);
      await removeFixtureDirectory(directory);
      const failures = closed.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, 'Fixture resource cleanup failed');
    });

    // Only the model's decisions are fictional. Retrieval, normalization, authentication,
    // context persistence, action authorization, commands and receipts use production code.
    const provider: ModelProvider = {
      async complete(input) {
        providerCalls++;
        const preference = input.request.context.preferences.items[0]?.value;
        assert.ok(preference === 'Italian' || preference === 'French');
        const clientIndex = preference === 'Italian' ? 0 : 1;
        if (input.request.message.text === 'Show two source recipes.') {
          if (input.remainingRetrievalRounds === 1)
            return {
              value: {
                kind: 'retrieve',
                criteria: { query: '' },
                recipeIds: [],
                requiredFacts: [],
              },
              usage: { inputTokens: 100, outputTokens: 10, thoughtTokens: 0 },
            };
          assert.ok(input.evidence.length >= 4);
          const recipeIds = input.evidence
            .slice(clientIndex * 2, clientIndex * 2 + 2)
            .map((recipe) => recipe.recipeId);
          return {
            value: {
              kind: 'respond',
              sufficiency: 'sufficient',
              missingFacts: [],
              memoryUpdate: nonMemoryUpdate(input.request),
              response: {
                kind: 'answer',
                text: 'Two source recipes to compare.',
                recipeIds,
                sources: recipeIds.map((recipeId) => ({ recipeId, section: 'recipe' })),
              },
            },
            usage: { inputTokens: 100, outputTokens: 50, thoughtTokens: 0 },
          };
        }
        assert.equal(input.request.message.text, 'Save the second recipe.');
        actionInputs.push(structuredClone(input));
        if (actionInputs.length === 2) bothEntered.resolve();
        if (holdActions) await gates[clientIndex]!.promise;
        const recipeId = input.evidence[0]?.recipeId;
        assert.ok(recipeId);
        assert.equal(input.evidence.length, 1);
        return {
          value: {
            kind: 'respond',
            sufficiency: 'sufficient',
            missingFacts: [],
            memoryUpdate: nonMemoryUpdate(input.request),
            response: {
              kind: 'proposal',
              text: 'Review the requested recipe save.',
              recipeIds: [recipeId],
              sources: [{ recipeId, section: 'recipe' }],
              proposals: [{ kind: 'saveRecipe', recipeId }],
            },
          },
          usage: { inputTokens: 100, outputTokens: 50, thoughtTokens: 0 },
        };
      },
    };
    storage = await createFileRegistryStorage(join(directory, 'registry'));
    const registry = await createCredentialRegistry(storage);
    const app = createGateway({
      registry,
      catalogue: catalogueBoundary,
      turn: createOrchestrator(provider),
    });
    gateway = app;

    async function openClient(label: string) {
      const path = join(directory, `${label}.sqlite`);
      const credentialPath = join(directory, `${label}-credentials.json`);
      const requests: AssistantTurnRequest[] = [];
      const wireReplies: AssistantTurnResponse[] = [];
      let substitution: AssistantTurnResponse | undefined;
      const credentials = createSecureCredentialStore({
        async getItemAsync() {
          try {
            return await readFile(credentialPath, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        },
        async setItemAsync(_key, value) {
          await writeFile(credentialPath, value, { mode: 0o600 });
        },
        async deleteItemAsync() {
          try {
            await unlink(credentialPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      });
      const connection = createGatewayConnection({
        credentials,
        // In-process HTTP bridge, not a server/transport behavior mock. No socket or TLS
        // is exercised; the one deliberate misdelivery below tests production correlation.
        async fetch(input, init) {
          const request = new Request(input, init);
          const url = new URL(request.url);
          assert.equal(url.origin, endpoint);
          const body = request.method === 'GET' ? undefined : await request.text();
          if (url.pathname === '/v2/assistant/turn') requests.push(JSON.parse(body!));
          const response = await app.app.inject({
            method: request.method as 'GET' | 'POST' | 'DELETE',
            url: url.pathname,
            headers: Object.fromEntries(request.headers),
            ...(body ? { payload: body } : {}),
          });
          let text = response.body;
          if (url.pathname === '/v2/assistant/turn') {
            wireReplies.push(JSON.parse(text));
            if (substitution) {
              text = JSON.stringify(substitution);
              substitution = undefined;
            }
          }
          return new Response(text, {
            status: response.statusCode,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
      let services: CookMateServices;
      let openServices: CookMateServices | undefined;
      let persistence: AssistantPersistencePort;
      let core: ReturnType<typeof createAssistantCoordinator>;
      const queuedIds: string[] = [];
      async function close() {
        const owned = openServices;
        openServices = undefined;
        await owned?.close();
      }
      async function open() {
        const result = await createLocalStore({
          openConnection: async () => desktopConnection(path).connection,
          platform,
          now: () => `${date.localDate}T08:00:00.000Z`,
          dateContext: () => ({ ...date }),
        });
        if (result.kind !== 'ready') assert.fail(JSON.stringify(result.error));
        services = openServices = result.services;
        try {
          await connection.restore(ready(await services.queries.readInstallationId()));
          persistence = services.assistant({
            connectionGeneration: () => connection.getState().generation,
          });
          core = createAssistantCoordinator({
            services,
            persistence,
            connection,
            currentDate: () => ({ ...date }),
            platform: { ...platform, newId: () => queuedIds.shift() ?? randomUUID() },
          });
        } catch (error) {
          await close();
          throw error;
        }
      }
      await open();
      return {
        connection,
        requests,
        wireReplies,
        get services() {
          return services;
        },
        get persistence() {
          return persistence;
        },
        get core() {
          return core;
        },
        substitute(response: AssistantTurnResponse) {
          substitution = structuredClone(response);
        },
        send(text: string, requestId: string) {
          assert.equal(queuedIds.length, 0);
          // Coordinator's documented send order is messageId, requestId, userIntentId.
          queuedIds.push(randomUUID(), requestId, randomUUID());
          return core.send(text);
        },
        async snapshot() {
          const observer = desktopConnection(path).connection;
          try {
            await observer.exec('PRAGMA query_only=ON');
            return {
              favourites: ready(await services.queries.readFavourites()),
              preferences: ready(await services.queries.readPreferences()),
              receipts: await observer.all('SELECT * FROM operation_receipt ORDER BY operation_id'),
            };
          } finally {
            await observer.close();
          }
        },
        async reopen() {
          await close();
          await open();
        },
        close,
      };
    }

    const a = await openClient('a');
    clients.push(a);
    const b = await openClient('b');
    clients.push(b);
    for (const [index, client] of clients.entries()) {
      await client.connection.pair(endpoint, app.pairing.openWindow().code);
      const review = ready(
        await client.services.commands.reviewDirect({
          kind: 'savePreference',
          type: 'cuisine',
          explicitValue: index === 0 ? 'Italian' : 'French',
        }),
      );
      const command = ready(await client.services.commands.prepareDirect(review));
      const seeded = await client.services.commands.execute(command);
      assert.equal(seeded.kind, 'receipt');
      if (seeded.kind !== 'receipt') assert.fail(JSON.stringify(seeded));
      assert.deepEqual(
        ready(await client.services.queries.readReceipt(command.operationId)),
        seeded.receipt,
      );
    }
    assert.notEqual(a.connection.getState().clientId, b.connection.getState().clientId);
    const seedRequestId = randomUUID();
    const seedA = reply(await a.send('Show two source recipes.', seedRequestId));
    const seedB = reply(await b.send('Show two source recipes.', seedRequestId));
    const listA = seedA.referenceSets[0]!;
    const listB = seedB.referenceSets[0]!;
    assert.equal(listA.recipeIds.length, 2);
    assert.equal(listB.recipeIds.length, 2);
    assert.equal(new Set([...listA.recipeIds, ...listB.recipeIds]).size, 4);
    const beforeA = await a.snapshot();
    const beforeB = await b.snapshot();
    assert.deepEqual(beforeA.favourites, []);
    assert.deepEqual(beforeB.favourites, []);
    assert.equal(beforeA.receipts.length, 1);
    assert.equal(beforeB.receipts.length, 1);

    const requestId = randomUUID();
    const pendingA = a.send('Save the second recipe.', requestId);
    const pendingB = b.send('Save the second recipe.', requestId);
    inFlight.push(pendingA, pendingB);
    await bothEntered.promise;
    assert.equal(app.admission.size, 2);
    const inputA = actionInputs.find(
      (input) => input.request.conversationId === seedA.conversationId,
    )!;
    const inputB = actionInputs.find(
      (input) => input.request.conversationId === seedB.conversationId,
    )!;
    for (const [input, list, own, peer] of [
      [inputA, listA, beforeA, beforeB],
      [inputB, listB, beforeB, beforeA],
    ] as const) {
      assert.equal(input.request.requestId, requestId);
      assert.deepEqual(input.request.context.preferences, own.preferences);
      assert.notDeepEqual(input.request.context.preferences, peer.preferences);
      assert.deepEqual(input.request.context.referenceSets, [list]);
      assert.deepEqual(
        input.evidence.map((recipe) => recipe.recipeId),
        [list.recipeIds[1]],
      );
      assert.equal(input.retrieval[0]?.kind, 'selection');
      assert.equal(input.retrieval[0]?.origin, 'ordered_reference');
    }
    assert.notEqual(inputA.request.conversationId, inputB.request.conversationId);
    assert.notEqual(inputA.request.userIntentId, inputB.request.userIntentId);
    gates[1]!.resolve();
    const proposalB = reply(await pendingB);
    assert.equal(proposalB.kind, 'proposal');
    if (proposalB.kind !== 'proposal') assert.fail('Expected B proposal');
    assert.equal(app.admission.size, 1);
    a.substitute(b.wireReplies.at(-1)!);
    gates[0]!.resolve();
    const misdelivered = await pendingA;
    assert.equal(misdelivered.kind, 'failed');
    if (misdelivered.kind !== 'failed') assert.fail('Foreign reply must fail');
    assert.equal(misdelivered.error.code, 'stale_context');
    assert.equal(ready(await a.persistence.readAcceptance(inputA.request.userIntentId)), null);
    assert.deepEqual(await a.snapshot(), beforeA);
    assert.deepEqual(await b.snapshot(), beforeB);
    assert.equal(app.admission.size, 0);
    const genuineA = a.wireReplies.at(-1)!;
    assert.equal(genuineA.kind, 'proposal');
    if (genuineA.kind !== 'proposal') assert.fail('Expected the actual A gateway proposal');
    assert.equal(genuineA.requestId, proposalB.requestId);
    assert.equal(genuineA.conversationId, inputA.request.conversationId);
    assert.deepEqual(genuineA.proposals, [{ kind: 'saveRecipe', recipeId: listA.recipeIds[1] }]);

    holdActions = false;
    // Stale identity is after_correction, not a retriable transport failure. A fresh
    // explicit user turn gets fresh identities while preserving its own ordered context.
    const proposalA = reply(await a.send('Save the second recipe.', randomUUID()));
    if (proposalA.kind !== 'proposal') assert.fail('Expected A proposal after a fresh user turn');
    assert.notEqual(proposalA.requestId, requestId);
    assert.deepEqual(actionInputs[2]?.request.context.preferences, beforeA.preferences);
    assert.deepEqual(actionInputs[2]?.request.context.referenceSets, [listA]);
    assert.deepEqual(
      actionInputs[2]?.evidence.map((recipe) => recipe.recipeId),
      [listA.recipeIds[1]],
    );
    assert.deepEqual(proposalA.proposals, [{ kind: 'saveRecipe', recipeId: listA.recipeIds[1] }]);
    assert.deepEqual(proposalB.proposals, [{ kind: 'saveRecipe', recipeId: listB.recipeIds[1] }]);
    assert.deepEqual(await a.snapshot(), beforeA);
    assert.deepEqual(await b.snapshot(), beforeB);
    const callsBeforeExecution = providerCalls;
    await assert.rejects(
      a.core.approve(proposalA.userIntentId, {
        source: 'explicit_user',
        proposals: proposalB.proposals,
        replacementConfirmations: [],
      }),
      (error: unknown) =>
        error instanceof AssistantCoreError && error.detail.code === 'unsupported_request',
    );
    assert.deepEqual(await a.snapshot(), beforeA);

    const plans = [];
    for (const [client, response, peer, peerSnapshot] of [
      [a, proposalA, b, beforeB],
      [b, proposalB, a, undefined],
    ] as const) {
      const unchangedPeer = peerSnapshot ?? (await peer.snapshot());
      const plan = await client.core.approve(response.userIntentId, {
        source: 'explicit_user',
        proposals: response.proposals,
        replacementConfirmations: [],
      });
      assert.equal(plan.slots.length, 1);
      assert.deepEqual(ready(await client.services.queries.readFavourites()), []);
      assert.equal(
        ready(await client.services.queries.readReceipt(plan.slots[0]!.operationId)),
        null,
      );
      assert.equal((await client.core.dispatch(plan.userIntentId)).summary, 'complete');
      const receipt = ready(await client.services.queries.readReceipt(plan.slots[0]!.operationId));
      assert.ok(receipt);
      assert.equal(receipt.outcome, 'committed');
      assert.equal(ready(await peer.services.queries.readReceipt(receipt.operationId)), null);
      assert.deepEqual(await peer.snapshot(), unchangedPeer);
      plans.push({ client, plan, receipt });
    }
    const afterA = await a.snapshot();
    const afterB = await b.snapshot();
    assert.deepEqual(
      afterA.favourites.map((item) => item.recipeId),
      [listA.recipeIds[1]],
    );
    assert.deepEqual(
      afterB.favourites.map((item) => item.recipeId),
      [listB.recipeIds[1]],
    );
    assert.deepEqual(afterA.preferences, beforeA.preferences);
    assert.deepEqual(afterB.preferences, beforeB.preferences);
    assert.equal(afterA.receipts.length, 2);
    assert.equal(afterB.receipts.length, 2);
    await a.reopen();
    await b.reopen();
    assert.deepEqual(await a.snapshot(), afterA);
    assert.deepEqual(await b.snapshot(), afterB);
    for (const { client, plan, receipt } of plans) {
      assert.equal((await client.core.reconcile(plan.userIntentId)).summary, 'complete');
      assert.deepEqual(
        ready(await client.services.queries.readReceipt(receipt.operationId)),
        receipt,
      );
      assert.equal(
        ready(await (client === a ? b : a).services.queries.readReceipt(receipt.operationId)),
        null,
      );
    }
    for (const [client, list, foreignList, expected] of [
      [a, listA, listB, afterA],
      [b, listB, listA, afterB],
    ] as const) {
      const context = await client.persistence.readContext({
        text: 'Save the second recipe.',
        messageId: randomUUID(),
        selection: { reference: { referenceSetId: list.referenceSetId, ordinal: 2 } },
      });
      if (context.kind !== 'ready') assert.fail(JSON.stringify(context));
      assert.deepEqual(context.value.preferences, expected.preferences);
      assert.deepEqual(
        context.value.referenceSets.find((set) => set.referenceSetId === list.referenceSetId),
        list,
      );
      assert.equal(
        context.value.referenceSets.some(
          (set) => set.referenceSetId === foreignList.referenceSetId,
        ),
        false,
      );
    }
    assert.equal(providerCalls, callsBeforeExecution);
    assert.equal(providerCalls, 7);
    assert.equal(a.requests.length, 3);
    assert.equal(b.requests.length, 2);
    assert.equal(app.admission.size, 0);
    t.diagnostic(
      'Two isolated file stores; two paired principals; seven fictional provider completions; five real gateway turns; one rejected foreign reply; two confirmed save receipts; both stores reopened. No socket, native or live-provider proof.',
    );
  },
);
