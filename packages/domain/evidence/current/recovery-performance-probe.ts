import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { recoveryFixture, finishAudit, ready } from '../../test/helpers/recoveryGate';
import { desktopConnection } from '../../test/helpers/sqlite';
import { createLocalStore } from '../../../../apps/mobile/src/data/localStore';
import { runBound, SqlCleanupFault } from '../../../../apps/mobile/src/data/sql';

// Independent desktop-only corruption/query-plan probe. Production is never edited.
const source = readFileSync('apps/mobile/src/data/recoveryGate.ts', 'utf8');
const inventory = source.match(/const inventory = `([\s\S]*?)`;/)![1]!;
const cold = source.match(/`WITH recovery_ids AS \(\s+SELECT user_intent_id AS id FROM pending_intent[\s\S]*?ORDER BY k.id`/)![0].slice(1, -1).replace('${inventory}', inventory);
const explainFixture = await recoveryFixture();
try {
  const cursorCount = (cold.match(/user_intent_id>\?/g) ?? []).length;
  console.log('COLD_QUERY_PLAN', JSON.stringify(explainFixture.database.prepare(`EXPLAIN QUERY PLAN ${cold}`).all(...Array(cursorCount).fill(''), 33)));
} finally { await explainFixture.close(); }

for (const table of ['assistant_acceptance_envelope', 'assistant_action_plan', 'assistant_acceptance', 'command_slot']) {
  const f = await recoveryFixture();
  try {
    await f.addTurn({ execute: false });
    const gate = f.install();
    const before = await finishAudit(gate);
    assert.equal(before.value.candidates.length, 1);
    const id = randomUUID();
    f.database.exec('PRAGMA foreign_keys=OFF');
    if (table === 'assistant_acceptance_envelope')
      f.database.prepare('INSERT INTO assistant_acceptance_envelope VALUES (?,?,0)').run(id, randomUUID());
    if (table === 'assistant_action_plan')
      f.database.prepare('INSERT INTO assistant_action_plan SELECT ?,plan_json,guards_json,cursor FROM assistant_action_plan LIMIT 1').run(id);
    if (table === 'assistant_acceptance')
      f.database.prepare('INSERT INTO assistant_acceptance SELECT ?,normalization_version,fingerprint,acknowledgement_json FROM assistant_acceptance LIMIT 1').run(id);
    if (table === 'command_slot')
      f.database.prepare('INSERT INTO command_slot SELECT ?,?,position,?,command_json FROM command_slot LIMIT 1').run(randomUUID(), id, randomUUID());
    f.database.exec('PRAGMA foreign_keys=ON');
    assert.equal(f.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_intent_id=?`).get(id)!.n, 1);
    const violations = f.database.prepare('PRAGMA foreign_key_check').all();
    assert.ok(violations.length > 0);
    f.resetCounters();
    const after = await gate.refreshRecoveryGate();
    console.log('ORPHAN', JSON.stringify({ table, violations, result: after.kind, gate: after.kind === 'ready' ? after.value.kind : null, tokenChanged: after.kind === 'ready' && before.value.token !== after.value.token, candidateCount: after.kind === 'ready' && after.value.kind === 'ready' ? after.value.candidates.length : null, counters: f.counters }));
    assert.equal(after.kind, 'failed', `Orphan coverage: ${table}`);
    assert.equal(gate.unchangedCertificate(), undefined);
  } finally { await f.close(); }
}

// Failure after statement finalization must invalidate coverage and make this writer unusable.
const cleanup = await recoveryFixture();
try {
  const gate = cleanup.install();
  await finishAudit(gate);
  const events: {token:string|null}[] = [];
  gate.subscribeRecoveryInvalidation(event => events.push(event));
  const originalPrepare = cleanup.connection.prepare;
  cleanup.connection.prepare = async sql => {
    const statement = await originalPrepare(sql);
    return {run: statement.run, finalize: async () => {await statement.finalize(); throw new SqlCleanupFault();}};
  };
  await assert.rejects(cleanup.writer.transaction(async session => {
    await runBound(session, 'UPDATE conversation SET composer_draft=?', [JSON.stringify('must roll back')]);
  }, {kind:'draft_only'}));
  assert.equal(gate.unchangedCertificate(), undefined);
  assert.equal(events.at(-1)!.token, null);
  assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
  assert.equal(cleanup.database.prepare('SELECT composer_draft FROM conversation').get()!.composer_draft, JSON.stringify(''));
  console.log('CLEANUP_FAILURE', JSON.stringify({unknownInvalidation:true, certificate:false, nextRefresh:'failed', draftRolledBack:true}));
} finally { await cleanup.close(); }

// Public-factory event/lifecycle check, with separately owned file SQLite connections.
const fixture = await recoveryFixture();
let services: Extract<Awaited<ReturnType<typeof createLocalStore>>, {kind:'ready'}>['services'] | undefined;
try {
  await fixture.addTurn({plan:false});
  const opened = await createLocalStore({
    openConnection: async () => desktopConnection(fixture.path).connection,
    platform: fixture.platform,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({localDate:'2026-09-28',timeZone:'Asia/Dubai',utcOffsetMinutes:240}),
  });
  assert.equal(opened.kind,'ready');
  if(opened.kind !== 'ready') assert.fail();
  services = opened.services;
  const assistant = services.assistant({connectionGeneration:()=>1});
  const gate = ready(await assistant.refreshRecoveryGate());
  assert.equal(gate.kind,'ready');
  const notifications: unknown[]=[];
  const invalidations: {token:string|null}[]=[];
  services.queries.subscribe(event=>{assert.ok(Object.isFrozen(event)); assert.ok(Object.isFrozen(event.collections)); assert.ok(Object.isFrozen(event.recovery)); notifications.push(event);});
  services.queries.subscribeRecoveryInvalidation(event=>invalidations.push(event));
  const header = ready(await assistant.readConversation()).header;
  ready(await assistant.saveDraft({conversationId:header.conversationId,generation:header.generation,expectedConversationRevision:header.revision}, 'Typed through public factory'));
  assert.equal(notifications.length,1);
  assert.deepEqual((notifications[0] as {recovery:unknown}).recovery,{kind:'unchanged',token:gate.token});
  assert.equal(invalidations.length,0);
  const unchanged = ready(await assistant.refreshRecoveryGate());
  assert.equal(unchanged.token,gate.token);
  const inFlight = assistant.refreshRecoveryGate();
  const closing = services.close();
  assert.equal((await inFlight).kind,'ready');
  await closing;
  assert.equal(invalidations.at(-1)!.token,null);
  assert.equal((await assistant.refreshRecoveryGate()).kind,'failed');
  const count = invalidations.length;
  await services.close();
  assert.equal(invalidations.length,count);
  console.log('PUBLIC_FACTORY',JSON.stringify({draftCertificateMatches:true,deepFrozenEvent:true,draftInvalidations:0,inFlightFinishedBeforeClose:true,closeInvalidation:'unknown',afterClose:'failed',idempotentClose:true}));
} finally { await services?.close(); await fixture.close(); }
