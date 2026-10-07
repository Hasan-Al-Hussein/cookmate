import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type {
  AssistantTurnRequest,
  NormalAssistantTurnResponse,
  MemoryUpdate,
} from '@cookmate/contracts';
import type { RepositoryResult, StoreChange } from '../src/index';
import { createAssistantTurnRepository } from '../../../apps/mobile/src/data/assistantTurnRepository';
import { createAssistantContextRepository } from '../../../apps/mobile/src/data/assistantContextRepository';
import { createConversationRepository } from '../../../apps/mobile/src/data/conversationRepository';
import { recoverInterruptedAssistantWork } from '../../../apps/mobile/src/data/assistantRecovery';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
async function fixture(path = ':memory:') {
  const db = desktopConnection(path);
  await configureConnection(db.connection);
  const writer = new SerializedWriter(db.connection);
  const reader = new SerializedReader(db.connection);
  const conversationId = randomUUID();
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId },
  );
  let date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  let connection = 1;
  const events: StoreChange[] = [];
  const options = {
    reader,
    writer,
    catalogue: catalogueBoundary,
    platform,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => date,
    connectionGeneration: () => connection,
    onCommitted: (event: StoreChange) => events.push(event),
  };
  const context = createAssistantContextRepository(options);
  const turns = createAssistantTurnRepository(options);
  const transcript = createConversationRepository(reader, catalogueBoundary);
  const request = async (text: string) => {
    const value = await context.readContext({ text, messageId: randomUUID(), selection: {} });
    if (value.kind !== 'ready') assert.fail(JSON.stringify(value));
    const s = value.value;
    return {
      apiVersion: '2',
      catalogue: catalogue.identity,
      requestId: randomUUID(),
      userIntentId: randomUUID(),
      intentRevision: 0,
      conversationId: s.conversationId,
      conversationGeneration: s.conversationGeneration,
      connectionGeneration: connection,
      message: s.currentMessage,
      context: {
        history: s.history,
        memory: s.memory,
        preferences: s.preferences,
        referenceSets: s.referenceSets,
        planOccurrences: s.planOccurrences,
        date: s.date,
      },
      capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
    } as AssistantTurnRequest;
  };
  const begin = async (req: AssistantTurnRequest) =>
    ready(
      await turns.beginTurn({
        request: req,
        expectedConversationRevision: req.context.memory.baseContextRevision,
      }),
    );
  const response = (req: AssistantTurnRequest, retain = true): NormalAssistantTurnResponse => ({
    apiVersion: '2',
    catalogue: req.catalogue,
    requestId: req.requestId,
    userIntentId: req.userIntentId,
    intentRevision: req.intentRevision,
    conversationId: req.conversationId,
    conversationGeneration: req.conversationGeneration,
    connectionGeneration: req.connectionGeneration,
    preferenceRevision: req.context.preferences.revision,
    kind: 'answer',
    text: 'Understood.',
    sources: [],
    referenceSets: [],
    memoryUpdate: {
      baseRevision: req.context.memory.projectionRevision,
      baseContextRevision: req.context.memory.baseContextRevision,
      reviews: req.context.memory.reviewTargetMessageIds.map((id) => ({
        sourceMessageId: id,
        disposition: retain ? 'retain' : 'non_memory',
      })) as MemoryUpdate['reviews'],
      entries: retain
        ? [
            {
              sourceMessageId: req.message.messageId,
              quote: req.message.text,
              kind: 'constraint',
              scope: { kind: 'conversation' },
              relations: [],
            },
            ...req.context.memory.pendingSources.map((source) => ({
              sourceMessageId: source.sourceMessageId,
              quote: source.quote,
              kind: 'constraint' as const,
              scope: { kind: 'conversation' as const },
              relations: [],
            })),
          ]
        : [],
    },
  });
  const accept = async (req: AssistantTurnRequest, res = response(req)) => {
    const stored = ready(await turns.readIntent(req.userIntentId));
    assert.ok(stored);
    return turns.acceptResponse({ response: res, ...stored.acceptanceEnvelope });
  };
  return {
    ...db,
    writer,
    reader,
    context,
    turns,
    transcript,
    request,
    begin,
    response,
    accept,
    events,
    conversationId,
    changeRuntime: () => {
      date = { ...date, localDate: '2026-09-29' };
      connection++;
    },
  };
}

test('scope change owns its caller input and proves a lost commit acknowledgement before notifying', async () => {
  for (const committed of [false, true]) {
    const f = await fixture();
    try {
      const request = await f.request('Retain this constraint');
      await f.begin(request);
      ready(await f.accept(request));
      const before = ready(await f.context.readMemoryPage());
      f.events.length = 0;
      const originalExec = f.connection.exec;
      let fault = true;
      f.connection.exec = async (sql) => {
        if (sql === 'COMMIT' && fault) {
          fault = false;
          if (committed) await originalExec(sql);
          throw new Error('commit acknowledgement fault');
        }
        await originalExec(sql);
      };
      const readerTransaction = f.reader.transaction.bind(f.reader);
      f.reader.transaction = async () => {
        throw new Error('temporarily unavailable independent reader');
      };
      const input = {
        expectedContextRevision: before.header.revision,
        afterSequence: before.header.nextSequence - 1,
        carryMemoryIds: [] as string[],
      };
      const pending = f.context.setWorkingContext(input);
      input.expectedContextRevision = 999;
      input.afterSequence = 999;
      input.carryMemoryIds.push(randomUUID());
      assert.equal((await pending).kind, 'failed');
      assert.deepEqual(f.events, []);
      f.connection.exec = originalExec;
      f.reader.transaction = readerTransaction;
      const after = ready(await f.context.readMemoryPage());
      assert.equal(
        after.workingContext.afterSequence,
        committed ? before.header.nextSequence - 1 : null,
      );
      assert.equal(after.header.revision, before.header.revision + (committed ? 1 : 0));
      assert.equal(f.events.length, committed ? 1 : 0);
      ready(await f.context.readMemoryPage());
      assert.equal(f.events.length, committed ? 1 : 0);
    } finally {
      await f.writer.close();
    }
  }
});

test('immutable acknowledgement rejects corrupted output metadata without rewriting history', async () => {
  const f = await fixture();
  try {
    const request = await f.request('Retain exact original context');
    await f.begin(request);
    const response = f.response(request);
    const accepted = ready(await f.accept(request, response));
    const original = JSON.stringify(accepted.acknowledgement);
    const changes: [string[], unknown][] = [
      [['intent', 'phase'], 'confirmation'],
      [['intent', 'origin', 'conversationId'], randomUUID()],
      [['intent', 'origin', 'generation'], 1],
      [['guards', 'conversationId'], randomUUID()],
      [['guards', 'conversationGeneration'], 1],
      [['guards', 'connectionGeneration'], 10],
      [['guards', 'relativeDateContext', 'localDate'], '2026-09-29'],
      [['guards', 'contextRevision'], 999],
      [['guards', 'planRevision'], 0],
    ];
    for (const [path, replacement] of changes) {
      const value = JSON.parse(original) as Record<string, unknown>;
      let target = value;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[path.at(-1)!] = replacement;
      const changed = JSON.stringify(value);
      f.database.prepare('UPDATE assistant_acceptance SET acknowledgement_json=?').run(changed);
      assert.equal(
        (await f.turns.readAcceptance(request.userIntentId)).kind,
        'failed',
        path.join('.'),
      );
      assert.equal((await f.accept(request, response)).kind, 'failed', path.join('.'));
      assert.equal(
        f.database.prepare('SELECT acknowledgement_json FROM assistant_acceptance').get()
          ?.acknowledgement_json,
        changed,
      );
    }
    f.database.prepare('UPDATE assistant_acceptance SET acknowledgement_json=?').run(original);
    f.changeRuntime();
    assert.deepEqual(
      ready(await f.accept(request, response)).acknowledgement,
      accepted.acknowledgement,
    );
  } finally {
    await f.writer.close();
  }
});

test('scope rollback followed by exact retry publishes one notification while the earlier reader was unavailable', async () => {
  const f = await fixture();
  try {
    const request = await f.request('Retain original');
    await f.begin(request);
    ready(await f.accept(request));
    const before = ready(await f.context.readMemoryPage());
    f.events.length = 0;
    const input = {
      expectedContextRevision: before.header.revision,
      afterSequence: before.header.nextSequence - 1,
      carryMemoryIds: [],
    };
    const exec = f.connection.exec;
    const read = f.reader.transaction.bind(f.reader);
    let fault = true;
    f.connection.exec = async (sql) => {
      if (sql === 'COMMIT' && fault) {
        fault = false;
        throw new Error('COMMIT did not execute');
      }
      await exec(sql);
    };
    f.reader.transaction = async () => {
      throw new Error('reader unavailable');
    };
    assert.equal((await f.context.setWorkingContext(input)).kind, 'failed');
    assert.equal(f.events.length, 0);
    f.connection.exec = exec;
    f.reader.transaction = read;
    const after = ready(await f.context.setWorkingContext(input));
    assert.equal(after.revision, before.header.revision + 1);
    assert.equal(f.events.length, 1);
    ready(await f.context.readMemoryPage());
    assert.equal(f.events.length, 1);
  } finally {
    await f.writer.close();
  }
});

test('full USER evidence, NUL and correction survive more than 25 turns beyond history window', async () => {
  const f = await fixture();
  try {
    const first = await f.request('No peanuts\0 tonight; Monday.');
    await f.begin(first);
    ready(await f.accept(first));
    const second = await f.request('Tuesday instead.');
    assert.equal(second.context.memory.items.length, 1);
    await f.begin(second);
    const correction = f.response(second);
    correction.memoryUpdate.entries[0]!.kind = 'correction';
    correction.memoryUpdate.entries[0]!.relations = [
      {
        kind: 'supersedes',
        target: {
          kind: 'memory',
          memoryId: second.context.memory.items[0]!.memoryId,
          expectedRevision: 1,
        },
      },
    ];
    ready(await f.accept(second, correction));
    for (let i = 0; i < 26; i++) {
      const req = await f.request(`Unrelated ${i}`);
      await f.begin(req);
      ready(await f.accept(req, f.response(req, false)));
    }
    const current = await f.request('What is the dinner plan?');
    assert.equal(current.context.history.length, 20);
    assert.equal(current.context.memory.items.length, 2);
    assert.deepEqual(
      new Set(current.context.memory.items.map((item) => item.quote)),
      new Set(['No peanuts\0 tonight; Monday.', 'Tuesday instead.']),
    );
    assert.ok(
      current.context.memory.items.every(
        (item) => item.sourceDateContext.localDate === '2026-09-28',
      ),
    );
    const page = ready(await f.transcript.readConversation({ beforeSequence: 2 }));
    assert.equal(page.messages[0]!.text, first.message.text);
    const header = ready(await f.transcript.readConversation()).header;
    ready(
      await f.turns.saveDraft(
        {
          conversationId: header.conversationId,
          generation: header.generation,
          expectedConversationRevision: header.revision,
        },
        'draft\0tail',
      ),
    );
    assert.equal(ready(await f.transcript.readConversation()).header.composerDraft, 'draft\0tail');
  } finally {
    await f.writer.close();
  }
});

test('atomic memory validation rejects altered Unicode/omitted reviews and resolves backlog source links in one batch', async () => {
  const f = await fixture();
  try {
    const a = await f.request('No cafe\u0301; Monday');
    await f.begin(a);
    ready(
      await f.turns.recordTurnFailure({
        userIntentId: a.userIntentId,
        expectedIntentRevision: 0,
        error: {
          code: 'network_unavailable',
          messageKey: 'test.network',
          retry: 'after_reconnect',
        },
      }),
    );
    const b = await f.request('Tuesday instead');
    assert.equal(b.context.memory.pendingSources.length, 1);
    await f.begin(b);
    const response = f.response(b);
    response.memoryUpdate.entries[0]!.relations = [
      { kind: 'supersedes', target: { kind: 'source', sourceMessageId: a.message.messageId } },
    ];
    const bad = structuredClone(response);
    bad.memoryUpdate.entries[1]!.quote = 'No café; Monday';
    assert.equal((await f.accept(b, bad)).kind, 'failed');
    const missing = structuredClone(response);
    missing.memoryUpdate.reviews.pop();
    assert.equal((await f.accept(b, missing)).kind, 'failed');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM memory_entry').get()?.n, 0);
    ready(await f.accept(b, response));
    const entries = ready(await f.context.readMemoryPage()).items;
    assert.equal(entries.length, 2);
    const successor = entries.find((item) => item.sourceMessageId === b.message.messageId)!;
    assert.equal(
      successor.relations[0]!.target.memoryId,
      entries.find((item) => item.sourceMessageId === a.message.messageId)!.memoryId,
    );
  } finally {
    await f.writer.close();
  }
});

test('acceptance envelope is durable and exact replay precedes changed runtime/current phase while mutations conflict', async () => {
  const f = await fixture();
  try {
    const req = await f.request('No peanuts\0\ud800e\u0301🍲"literal\\u0000"');
    const begun = await f.begin(req);
    const response = f.response(req);
    const first = ready(await f.accept(req, response));
    assert.equal(first.replay, false);
    const next = await f.request('Another question');
    await f.begin(next);
    ready(await f.accept(next, f.response(next, false)));
    f.changeRuntime();
    const repeat = ready(await f.turns.acceptResponse({ response, ...begun.acceptanceEnvelope }));
    assert.equal(repeat.replay, true);
    assert.deepEqual(repeat.acknowledgement, first.acknowledgement);
    assert.deepEqual(ready(await f.turns.readAcceptance(req.userIntentId)), first.acknowledgement);
    for (const mutate of [
      (r: NormalAssistantTurnResponse) => {
        r.requestId = randomUUID();
      },
      (r: NormalAssistantTurnResponse) => {
        r.text += '!';
      },
      (r: NormalAssistantTurnResponse) => {
        r.memoryUpdate.entries[0]!.quote += '!';
      },
    ]) {
      const changed = structuredClone(response);
      mutate(changed);
      const result = await f.turns.acceptResponse({
        response: changed,
        ...begun.acceptanceEnvelope,
      });
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.error.code, 'operation_conflict');
    }
    assert.equal(
      (
        await f.turns.acceptResponse({
          response,
          assistantMessageId: randomUUID(),
          expectedIntentRevision: 0,
        })
      ).kind,
      'failed',
    );
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM memory_entry').get()?.n, 1);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM message').get()?.n, 4);
    assert.deepEqual((await f.begin(req)).acceptanceEnvelope, begun.acceptanceEnvelope);
  } finally {
    await f.writer.close();
  }
});

test('oversized retained context narrows, selected carry expands whole correction group, and fresh boundary excludes every old channel', async () => {
  const f = await fixture();
  try {
    const first = await f.request('No peanuts');
    await f.begin(first);
    ready(await f.accept(first));
    const second = await f.request('Tuesday instead');
    await f.begin(second);
    const correction = f.response(second);
    correction.memoryUpdate.entries[0]!.relations = [
      {
        kind: 'supersedes',
        target: {
          kind: 'memory',
          memoryId: second.context.memory.items[0]!.memoryId,
          expectedRevision: 1,
        },
      },
    ];
    ready(await f.accept(second, correction));
    // Add retained independent groups through the same real begin/accept path.
    for (let i = 2; i < 33; i++) {
      const req = await f.request(`Constraint ${i}`);
      await f.begin(req);
      ready(await f.accept(req));
    }
    const narrowed = await f.context.readContext({
      text: 'Next',
      messageId: randomUUID(),
      selection: {},
    });
    assert.equal(narrowed.kind, 'narrowing');
    if (narrowed.kind !== 'narrowing') assert.fail();
    assert.equal(narrowed.reason, 'entry_limit');
    assert.equal(narrowed.coverage.retainedEntryCount, 33);
    const page = ready(await f.context.readMemoryPage({ limit: 100 }));
    assert.equal(page.items.length, 33);
    const old = page.items.find((item) => item.sourceMessageId === first.message.messageId)!;
    const selected = ready(
      await f.context.setWorkingContext({
        expectedContextRevision: page.header.revision,
        afterSequence: page.header.nextSequence - 1,
        carryMemoryIds: [old.memoryId],
      }),
    );
    const context = await f.request('Only selected context');
    assert.equal(context.context.memory.items.length, 2);
    assert.equal(context.context.memory.workingContext.carryMemoryIds.length, 2);
    assert.equal(context.context.history.length, 0);
    ready(
      await f.context.setWorkingContext({
        expectedContextRevision: selected.revision,
        afterSequence: page.header.nextSequence - 1,
        carryMemoryIds: [],
      }),
    );
    const fresh = await f.request('For this dinner: no peanuts; Tuesday');
    assert.equal(fresh.context.history.length, 0);
    assert.equal(fresh.context.memory.items.length, 0);
    assert.equal(fresh.context.memory.pendingSources.length, 0);
    assert.equal(fresh.context.referenceSets.length, 0);
    assert.equal(fresh.context.memory.coverage.retainedEntryCount, 33);
    await f.begin(fresh);
    ready(await f.accept(fresh));
  } finally {
    await f.writer.close();
  }
});

test('fault at acceptance record rolls back reply, memory, review state, projection and context together', async () => {
  const f = await fixture();
  try {
    const req = await f.request('No peanuts\0\ud800e\u0301🍲"literal\\u0000"');
    await f.begin(req);
    const before = f.database
      .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
      .get()?.revision;
    const prepare = f.connection.prepare;
    f.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        run: async (values) => {
          if (sql.startsWith('INSERT INTO assistant_acceptance VALUES'))
            throw new Error('injected');
          await statement.run(values);
        },
      };
    };
    assert.equal((await f.accept(req)).kind, 'failed');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM memory_entry').get()?.n, 0);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM message').get()?.n, 1);
    assert.equal(
      f.database.prepare('SELECT disposition FROM memory_source_review').get()?.disposition,
      'pending',
    );
    assert.equal(
      f.database
        .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
        .get()?.revision,
      before,
    );
    f.connection.prepare = prepare;
    ready(await f.accept(req));
  } finally {
    await f.writer.close();
  }
});

test('explicit retry reuses frozen request/envelope after awaiting, recoverable failure or startup interruption, never after acceptance or later scope change', async () => {
  for (const state of ['awaiting', 'failure', 'interrupted'] as const) {
    const f = await fixture();
    try {
      const req = await f.request('No peanuts');
      const begun = await f.begin(req);
      if (state === 'failure')
        ready(
          await f.turns.recordTurnFailure({
            userIntentId: req.userIntentId,
            expectedIntentRevision: 0,
            error: {
              code: 'network_unavailable',
              messageKey: 'test.offline',
              retry: 'after_reconnect',
            },
          }),
        );
      if (state === 'interrupted')
        await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
      const rearmed = ready(
        await f.turns.rearmTurn({ userIntentId: req.userIntentId, expectedIntentRevision: 0 }),
      );
      assert.deepEqual(rearmed.request, begun.request);
      assert.deepEqual(rearmed.acceptanceEnvelope, begun.acceptanceEnvelope);
      assert.equal(rearmed.intent.phase, 'awaiting_response');
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM message').get()?.n, 1);
      ready(await f.accept(req));
      assert.equal(
        (await f.turns.rearmTurn({ userIntentId: req.userIntentId, expectedIntentRevision: 0 }))
          .kind,
        'failed',
      );
    } finally {
      await f.writer.close();
    }
  }
  const f = await fixture();
  try {
    const req = await f.request('No peanuts');
    await f.begin(req);
    ready(
      await f.turns.recordTurnFailure({
        userIntentId: req.userIntentId,
        expectedIntentRevision: 0,
        error: {
          code: 'network_unavailable',
          messageKey: 'test.offline',
          retry: 'after_reconnect',
        },
      }),
    );
    const page = ready(await f.transcript.readConversation());
    ready(
      await f.context.setWorkingContext({
        expectedContextRevision: page.header.revision,
        afterSequence: 0,
        carryMemoryIds: [],
      }),
    );
    assert.equal(
      (await f.turns.rearmTurn({ userIntentId: req.userIntentId, expectedIntentRevision: 0 })).kind,
      'failed',
    );
  } finally {
    await f.writer.close();
  }
});

test('disk reopen preserves full evidence, explicit scope and immutable acceptance envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-'));
  const path = join(directory, 'memory.db');
  let f = await fixture(path);
  try {
    const exact = 'No peanuts\0\ud800 \udfff e\u0301🍲 "literal\\u0000"';
    const first = await f.request(exact);
    const begun = await f.begin(first);
    const response = f.response(first);
    response.text = exact + '\ud800 reply';
    const accepted = ready(await f.accept(first, response));
    const page = ready(await f.context.readMemoryPage());
    ready(
      await f.context.setWorkingContext({
        expectedContextRevision: page.header.revision,
        afterSequence: page.header.nextSequence - 1,
        carryMemoryIds: [page.items[0]!.memoryId],
      }),
    );
    const header = ready(await f.transcript.readConversation()).header;
    ready(
      await f.turns.saveDraft(
        {
          conversationId: header.conversationId,
          generation: header.generation,
          expectedConversationRevision: header.revision,
        },
        exact + ' draft',
      ),
    );
    await f.writer.close();
    f = await fixture(path);
    const transcript = ready(await f.transcript.readConversation());
    assert.equal(transcript.messages[0]!.text, exact);
    assert.equal(transcript.messages[1]!.text, response.text);
    assert.equal(transcript.header.composerDraft, exact + ' draft');
    const next = await f.request('What still applies?');
    assert.equal(next.context.memory.items[0]!.quote, first.message.text);
    assert.equal(next.context.history.length, 0);
    assert.deepEqual(next.context.memory.workingContext.carryMemoryIds, [page.items[0]!.memoryId]);
    const prior = ready(await f.turns.readIntent(first.userIntentId));
    assert.deepEqual(prior?.acceptanceEnvelope, begun.acceptanceEnvelope);
    assert.deepEqual(
      ready(await f.turns.acceptResponse({ response, ...begun.acceptanceEnvelope }))
        .acknowledgement,
      accepted.acknowledgement,
    );
  } finally {
    await f.writer.close();
    await removeFixtureDirectory(directory);
  }
});

test('pending and expanded UTF-8 budgets narrow before append; explicit fresh brief retains excluded backlog locally', async () => {
  for (const kind of ['pending', 'bytes'] as const) {
    const f = await fixture();
    try {
      const count = kind === 'pending' ? 8 : 4;
      for (let i = 0; i < count; i++) {
        const req = await f.request(kind === 'pending' ? `Pending ${i}` : '🍋'.repeat(4000));
        await f.begin(req);
        ready(
          await f.turns.recordTurnFailure({
            userIntentId: req.userIntentId,
            expectedIntentRevision: 0,
            error: {
              code: 'network_unavailable',
              messageKey: 'test.offline',
              retry: 'after_reconnect',
            },
          }),
        );
      }
      const result = await f.context.readContext({
        text: kind === 'pending' ? 'Next' : '🍋'.repeat(4000),
        messageId: randomUUID(),
        selection: {},
      });
      assert.equal(result.kind, 'narrowing');
      if (result.kind !== 'narrowing') assert.fail();
      assert.equal(result.reason, kind === 'pending' ? 'pending_evidence' : 'byte_limit');
      assert.equal(result.coverage.pendingUserSourceCount, count + 1);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM message').get()?.n, count);
      const page = ready(await f.transcript.readConversation());
      ready(
        await f.context.setWorkingContext({
          expectedContextRevision: page.header.revision,
          afterSequence: page.header.nextSequence - 1,
          carryMemoryIds: [],
        }),
      );
      const fresh = await f.request('New explicit brief');
      assert.equal(fresh.context.memory.pendingSources.length, 0);
      assert.equal(fresh.context.history.length, 0);
      assert.equal(fresh.context.memory.coverage.pendingUserSourceCount, count + 1);
      assert.equal(fresh.context.memory.coverage.pendingWorkingSourceCount, 1);
      await f.begin(fresh);
      ready(await f.accept(fresh));
      assert.equal(
        f.database
          .prepare("SELECT count(*) AS n FROM memory_source_review WHERE disposition='pending'")
          .get()?.n,
        count,
      );
    } finally {
      await f.writer.close();
    }
  }
});

test('a 33-entry linked group cannot be silently severed by explicit carry selection', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 33; i++) {
      const req = await f.request(`Correction ${i}`);
      await f.begin(req);
      const response = f.response(req);
      const previous = [...req.context.memory.items].sort(
        (a, b) => b.sourceSequence - a.sourceSequence,
      )[0];
      if (previous)
        response.memoryUpdate.entries[0]!.relations = [
          {
            kind: 'supersedes',
            target: {
              kind: 'memory',
              memoryId: previous.memoryId,
              expectedRevision: previous.revision,
            },
          },
        ];
      ready(await f.accept(req, response));
    }
    const page = ready(await f.context.readMemoryPage({ limit: 100 }));
    assert.equal(page.items.length, 33);
    const before = f.database.prepare('SELECT * FROM conversation_memory_state').get();
    const revision = page.header.revision;
    const result = await f.context.setWorkingContext({
      expectedContextRevision: revision,
      afterSequence: page.header.nextSequence - 1,
      carryMemoryIds: [page.items[0]!.memoryId],
    });
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.error.code, 'too_large');
    assert.deepEqual(f.database.prepare('SELECT * FROM conversation_memory_state').get(), before);
    assert.equal(ready(await f.transcript.readConversation()).header.revision, revision);
    ready(
      await f.context.setWorkingContext({
        expectedContextRevision: revision,
        afterSequence: page.header.nextSequence - 1,
        carryMemoryIds: [],
      }),
    );
    assert.equal((await f.request('Fresh user-authored task')).context.memory.items.length, 0);
  } finally {
    await f.writer.close();
  }
});
