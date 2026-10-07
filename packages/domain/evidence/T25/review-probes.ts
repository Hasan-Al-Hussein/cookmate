import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type {
  AssistantTurnRequest,
  NormalAssistantTurnResponse,
  MemoryUpdate,
} from '@cookmate/contracts';
import type { RepositoryResult, StoreChange } from '../../src/index';
import { createAssistantTurnRepository } from '../../../../apps/mobile/src/data/assistantTurnRepository';
import { createAssistantContextRepository } from '../../../../apps/mobile/src/data/assistantContextRepository';
import { createConversationRepository } from '../../../../apps/mobile/src/data/conversationRepository';
import { recoverInterruptedAssistantWork } from '../../../../apps/mobile/src/data/assistantRecovery';
import { initializeDatabase } from '../../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from '../../test/helpers/sqlite';

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

async function main() {
  {
    const f = await fixture();
    try {
      const request = await f.request('Keep the original evidence');
      await f.begin(request);
      const response = f.response(request);
      const accepted = ready(await f.accept(request, response));
      const baseline = JSON.stringify(accepted.acknowledgement);
      const cases: [string, (value: any) => void][] = [
        ['phase', v => {v.intent.phase='confirmation';}],
        ['intent-origin-conversation', v => {v.intent.origin.conversationId=randomUUID();}],
        ['intent-origin-generation', v => {v.intent.origin.generation++;}],
        ['guard-conversation', v => {v.guards.conversationId=randomUUID();}],
        ['guard-generation', v => {v.guards.conversationGeneration++;}],
        ['guard-connection', v => {v.guards.connectionGeneration++;}],
        ['guard-date', v => {v.guards.relativeDateContext.localDate='2026-09-29';}],
        ['guard-context-revision', v => {v.guards.contextRevision+=1000;}],
        ['unexpected-plan-guard', v => {v.guards.planRevision=0;}],
      ];
      const outcomes=[];
      for (const [name, mutate] of cases) {
        const value=JSON.parse(baseline);mutate(value);
        f.database.prepare('UPDATE assistant_acceptance SET acknowledgement_json=? WHERE user_intent_id=?').run(JSON.stringify(value),request.userIntentId);
        const read = await f.turns.readAcceptance(request.userIntentId);
        const replay = await f.turns.acceptResponse({response,...accepted.acknowledgement.acceptanceEnvelope!});
        outcomes.push({case:name,read:read.kind,replay:replay.kind});
        assert.equal(read.kind,'failed');
        assert.equal(replay.kind,'failed');
        if(read.kind==='failed')assert.equal(read.error.code,'storage_failure');
        if(replay.kind==='failed')assert.equal(replay.error.code,'storage_failure');
      }
      const bad=JSON.parse(baseline);bad.response.text='Changed protected response';
      f.database.prepare('UPDATE assistant_acceptance SET acknowledgement_json=? WHERE user_intent_id=?').run(JSON.stringify(bad),request.userIntentId);
      assert.equal((await f.turns.readAcceptance(request.userIntentId)).kind,'failed');
      f.database.prepare('UPDATE assistant_acceptance SET acknowledgement_json=? WHERE user_intent_id=?').run(baseline,request.userIntentId);
      f.changeRuntime();
      assert.deepEqual(ready(await f.turns.acceptResponse({response,...accepted.acknowledgement.acceptanceEnvelope!})).acknowledgement,accepted.acknowledgement);
      console.log(JSON.stringify({probe:'acceptance-metadata-corruption-recheck',outcomes,inputFingerprintUntouched:true,protectedResponseChangeRejected:true,validHistoricalReplayAfterRuntimeChange:true}));
    } finally {await f.writer.close();}
  }
  {
    const f=await fixture();
    try {
      const request=await f.request('Retain original context');
      await f.begin(request);ready(await f.accept(request));
      const before=ready(await f.context.readMemoryPage());
      const input={expectedContextRevision:before.header.revision,afterSequence:before.header.nextSequence-1,carryMemoryIds:[]};
      f.events.length=0;
      const exec=f.connection.exec,read=f.reader.transaction.bind(f.reader);let fault=true;
      f.connection.exec=async sql=>{if(sql==='COMMIT'&&fault){fault=false;throw Error('rollback at COMMIT');}await exec(sql);};
      f.reader.transaction=async()=>{throw Error('reader unavailable');};
      assert.equal((await f.context.setWorkingContext(input)).kind,'failed');assert.equal(f.events.length,0);
      f.connection.exec=exec;f.reader.transaction=read;
      const after=ready(await f.context.setWorkingContext(input));
      assert.equal(after.revision,before.header.revision+1);
      assert.equal(f.events.length,1);
      console.log(JSON.stringify({probe:'scope-rollback-exact-retry-notification-recheck',events:f.events,scopeChangedOnce:after.revision===before.header.revision+1}));
    } finally {await f.writer.close();}
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
