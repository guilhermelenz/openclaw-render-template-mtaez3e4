import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { enforceSubscription, migrateSessionAuth } from '../runtime/enforce-openai-subscription.mjs';

test('only OAuth credentials remain eligible, including utility routes', () => {
 const cfg = {auth:{profiles:{paid:{provider:'openai',mode:'api_key'},sub:{provider:'openai',mode:'oauth'},other:{provider:'anthropic',mode:'token'}},order:{openai:['paid'],anthropic:['other']}},agents:{defaults:{model:'openai/gpt-5.6-sol'},entries:{coach:{model:{primary:'openai/gpt-6-astra',fallbacks:[]},utilityModel:'openai/gpt-6-astra'},mail:{model:'anthropic/claude-haiku-4-5'}}}};
 const out=enforceSubscription(cfg);
 assert.deepEqual(out.auth.order.openai,['sub']);
 assert.deepEqual(out.auth.order.anthropic,['other']);
 assert.equal(out.agents.entries.coach.models['openai/gpt-6-astra'].agentRuntime.id,'codex');
 assert.equal(out.agents.defaults.models['openai/gpt-5.6-sol'].agentRuntime.id,'codex');
 assert.deepEqual(out.agents.entries.mail,cfg.agents.entries.mail);
 assert.deepEqual(enforceSubscription(out),out);
 assert.deepEqual(cfg.auth.order.openai,['paid']);
});
test('missing subscription never silently permits API auth',()=>{
 assert.throws(()=>enforceSubscription({auth:{profiles:{paid:{provider:'openai',mode:'api_key'}}}}),/subscription login is required/);
});

test('migrates paid session pins without changing history or other providers', () => {
 const dir=mkdtempSync(join(tmpdir(),'subscription-test-'));
 const path=join(dir,'agent.sqlite');
 try {
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY,entry_json TEXT); CREATE TABLE transcript_events(body TEXT);');
  const paid={authProfileOverride:'openai:default',authProfileOverrideSource:'auto',model:'gpt-6-astra',sessionId:'preserve'};
  const other={authProfileOverride:'anthropic:default',custom:'preserve'};
  const insert=db.prepare('INSERT INTO session_nodes VALUES(?,?)');
  insert.run('paid',JSON.stringify(paid)); insert.run('other',JSON.stringify(other));
  db.prepare('INSERT INTO transcript_events VALUES(?)').run('history stays intact'); db.close();
  assert.equal(migrateSessionAuth(path,{},['openai:codex-cli']),1);
  assert.equal(migrateSessionAuth(path,{},['openai:codex-cli']),0);
  const check=new DatabaseSync(path);
  assert.deepEqual(JSON.parse(check.prepare('SELECT entry_json FROM session_nodes WHERE session_key=?').get('paid').entry_json),{...paid,authProfileOverride:'openai:codex-cli'});
  assert.deepEqual(JSON.parse(check.prepare('SELECT entry_json FROM session_nodes WHERE session_key=?').get('other').entry_json),other);
  assert.equal(check.prepare('SELECT body FROM transcript_events').get().body,'history stays intact'); check.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
