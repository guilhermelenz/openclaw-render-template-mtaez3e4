import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceSubscription } from '../runtime/enforce-openai-subscription.mjs';

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
