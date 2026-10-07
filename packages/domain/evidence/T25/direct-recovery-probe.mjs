import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalStore} from '../../../../apps/mobile/src/data/localStore.ts';
import {desktopConnection,removeFixtureDirectory} from '../../test/helpers/sqlite.ts';
const date={localDate:'2026-09-28',timeZone:'Asia/Dubai',utcOffsetMinutes:240};
const ready=r=>{assert.equal(r.kind,'ready',JSON.stringify(r));return r.value};
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'cookmate-repository-T15-')),path=join(directory,'review.db');
 const connections=[];let failRead=false,failClose=false,hashGate=null;
 const platform={newId:randomUUID,sha256:async text=>{if(hashGate)await hashGate;return createHash('sha256').update(text).digest('hex')}};
 const open=()=>createLocalStore({platform,now:()=> '2026-09-28T00:00:00.000Z',dateContext:()=>date,openConnection:async mode=>{
  if(mode==='read'&&failRead)throw Error('injected read-open failure');
  const db=desktopConnection(path),originalClose=db.connection.close,tracked={...db,mode,closes:0};connections.push(tracked);
  db.connection.close=async()=>{tracked.closes++;await originalClose();if(failClose)throw Error('injected close acknowledgement failure')};
  return db.connection;
 }});
 const initial=await open();assert.equal(initial.kind,'ready');const stores=[initial.services];
 const action=async(s,input)=>{const review=ready(await s.commands.reviewDirect(input)),command=ready(await s.commands.prepareDirect(review)),result=await s.commands.execute(command);assert.equal(result.kind,'receipt',JSON.stringify(result));return {review,command,result}};
 return {directory,path,connections,services:initial.services,stores,open,action,setFailRead:v=>failRead=v,setFailClose:v=>failClose=v,setGate:v=>hashGate=v,cleanup:async()=>{for(const s of stores)await s.close().catch(()=>{});await removeFixtureDirectory(directory)}};
}
{
 const f=await fixture();
 try{
  const done=await f.action(f.services,{kind:'setFavourite',recipeId:'53064',saved:true});
  const db=f.connections[0].database;
  const intent=JSON.parse(db.prepare('SELECT intent_json FROM pending_intent WHERE user_intent_id=?').get(done.command.userIntentId).intent_json);
  const tampered=structuredClone(done.command);tampered.command={kind:'clearPreferences',expectedPreferenceRevision:0};
  intent.slots[0].command=tampered;
  db.prepare('UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?').run(JSON.stringify(intent),done.command.userIntentId);
  db.prepare('UPDATE command_slot SET command_json=? WHERE operation_id=?').run(JSON.stringify(tampered),done.command.operationId);
  const inventory=await f.services.queries.readDirectRecovery();
  assert.equal(inventory.kind,'failed');assert.equal(inventory.error.code,'storage_failure');
  const execution=await f.services.commands.execute(tampered);
  assert.equal(execution.kind,'failed');assert.equal(execution.error.code,'operation_conflict');
  const ack=await f.services.commands.acknowledgeDirectRecovery(done.command.operationId);assert.equal(ack.kind,'failed');assert.equal(ack.error.code,'storage_failure');assert.equal(db.prepare('SELECT count(*) n FROM direct_command_recovery').get().n,1);
  assert.deepEqual(await f.services.commands.execute(done.command),done.result);
  assert.equal(ready(await f.services.queries.readFavourites()).length,1);
  console.log(JSON.stringify({probe:'direct-recovery-corrupt-fingerprint-recheck',inventory:inventory.error.code,execution:execution.error.code,acknowledgement:ack.error.code,recoveryRowRetained:true,originalHistoricalReceiptPreserved:true,favouriteRetained:true}));
 }finally{await f.cleanup()}
}
