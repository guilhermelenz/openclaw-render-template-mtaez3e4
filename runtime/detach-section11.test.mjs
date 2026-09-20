import test from 'node:test';
import assert from 'node:assert/strict';
import {detachSection11} from './detach-section11.mjs';

test('detaches only the coach, without mutating source or other agents', () => {
  const config = {agents:{entries:{main:{name:'Main'},'section-11-coach':{name:'Coach'},research:{name:'Research'}}}, bindings:[{agentId:'main'},{agentId:'section-11-coach'}], channels:{telegram:{enabled:true}}};
  const detached = detachSection11(config);
  assert.deepEqual(Object.keys(detached.agents.entries), ['main','research']);
  assert.deepEqual(detached.bindings, [{agentId:'main'}]);
  assert.deepEqual(detached.channels, config.channels);
  assert.ok(config.agents.entries['section-11-coach']);
  assert.deepEqual(detachSection11(detached), detached);
});
