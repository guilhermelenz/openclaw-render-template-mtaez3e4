// Remove only Section 11's routing and agent entry. Preserve archived sessions,
// uploads, provider tokens, shared model credentials, and every other agent.
export function detachSection11(config) {
  const result = structuredClone(config);
  if (result.agents?.entries) delete result.agents.entries['section-11-coach'];
  if (Array.isArray(result.agents?.list)) result.agents.list = result.agents.list.filter(agent => agent.id !== 'section-11-coach');
  if (Array.isArray(result.bindings)) result.bindings = result.bindings.filter(binding => binding.agentId !== 'section-11-coach');
  return result;
}
