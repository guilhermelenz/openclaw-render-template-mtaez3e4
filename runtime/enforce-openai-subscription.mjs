import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function enforceSubscription(config) {
  const result = structuredClone(config);
  const profiles = result.auth?.profiles || {};
  const oauth = Object.entries(profiles)
    .filter(([, p]) => p.provider === 'openai' && p.mode === 'oauth')
    .map(([id]) => id);
  if (!oauth.length) throw new Error('OpenAI subscription login is required; API-key fallback is forbidden');
  result.auth.order = { ...result.auth.order, openai: oauth };
  const scopes = [result.agents?.defaults, ...Object.values(result.agents?.entries || {})].filter(Boolean);
  for (const scope of scopes) {
    const model = typeof scope.model === 'string' ? scope.model : scope.model?.primary;
    const refs = new Set([...Object.keys(scope.models || {}), model, scope.utilityModel]);
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ref.startsWith('openai/')) continue;
      scope.models ??= {};
      scope.models[ref] = { ...scope.models[ref], agentRuntime: { id: 'codex' } };
    }
  }
  return result;
}

export function applySubscriptionPolicy(path = '/data/.openclaw/openclaw.json') {
  if (!existsSync(path)) return;
  const original = readFileSync(path, 'utf8');
  const config = JSON.parse(original);
  // This deployment's selected OpenAI account is intentionally subscription-only.
  const updated = enforceSubscription(config);
  const candidate = `${path}.subscription-candidate`;
  writeFileSync(candidate, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
  const check = spawnSync('openclaw', ['config', 'validate', '--json'], {
    env: { ...process.env, OPENCLAW_CONFIG_PATH: candidate }, encoding: 'utf8', timeout: 30000,
  });
  if (check.status !== 0) throw new Error('Subscription routing configuration failed validation');
  const backup = '/data/subscription-routing-backup/openclaw-before-managed-policy.json';
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  if (!existsSync(backup)) writeFileSync(backup, original, { mode: 0o600 });
  renameSync(candidate, path);
  for (const agent of Object.keys(updated.agents?.entries || {})) {
    const order = spawnSync('openclaw', ['models', 'auth', 'order', 'set', '--agent', agent,
      '--provider', 'openai', ...updated.auth.order.openai], { encoding: 'utf8', timeout: 30000 });
    if (order.status !== 0) throw new Error(`Cannot enforce subscription auth for agent ${agent}`);
  }
  console.log('OpenAI subscription-only auth enforced; API profiles excluded from agent selection.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) applySubscriptionPolicy();
