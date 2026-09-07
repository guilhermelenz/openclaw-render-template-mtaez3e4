import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_ALPHACLAW_VERSION = "0.9.34";
const SUPPORTED_OPENCLAW_VERSION = "2026.8.2";
const SHARED_PATCH_MARKER =
  "// OpenClaw 2026.8.2 compatibility: adapt keyed entries at the AlphaClaw boundary.";
const WEBHOOK_PATCH_MARKER =
  "// OpenClaw 2026.8.2 compatibility: resolve webhook agents from keyed entries.";
const CODEX_RUNTIME_PATCH_MARKER =
  "// OpenClaw 2026.8.2 compatibility: inspect keyed agent entries for Codex use.";
const WORKSPACE_PATCH_MARKER =
  "// OpenClaw 2026.8.2 compatibility: sync workspaces from keyed agent entries.";
const SYSTEM_ROUTE_PATCH_MARKER =
  "// OpenClaw 2026.8.2 compatibility: label sessions from keyed agent entries.";

function replaceExactly(source, before, after, expectedCount, label) {
  let offset = 0;
  let count = 0;
  let patched = "";
  while (true) {
    const index = source.indexOf(before, offset);
    if (index < 0) break;
    patched += source.slice(offset, index) + after;
    offset = index + before.length;
    count += 1;
  }
  if (count !== expectedCount) {
    throw new Error(
      `AlphaClaw agents.entries patch drifted at ${label}: expected ${expectedCount}, found ${count}`,
    );
  }
  return patched + source.slice(offset);
}

export function patchAlphaClawAgentSharedSource(source) {
  if (source.includes(SHARED_PATCH_MARKER)) {
    if (
      !source.includes("const listAgentsFromConfig =") ||
      !source.includes("const toCanonicalAgentsConfig =") ||
      !source.includes("const hasCanonicalEntries =") ||
      !source.includes("delete normalizedAgents.entries") ||
      !source.includes("delete agents.list")
    ) {
      throw new Error("AlphaClaw agents.entries shared patch is incomplete");
    }
    return { source, changed: false };
  }

  let patched = replaceExactly(
    source,
    `const normalizeAgentsList = ({ list }) =>
  (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({ ...entry }));`,
    `${SHARED_PATCH_MARKER}
const isConfigRecord = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeAgentsList = ({ list }) =>
  (Array.isArray(list) ? list : [])
    .filter((entry) => isConfigRecord(entry))
    .map((entry) => ({ ...entry }));

const listAgentsFromConfig = (cfg = {}) => {
  const agents = isConfigRecord(cfg.agents) ? cfg.agents : {};
  if (Object.prototype.hasOwnProperty.call(agents, "entries")) {
    if (!isConfigRecord(agents.entries)) return [];
    return Object.entries(agents.entries)
      .filter(([id, entry]) => String(id || "").trim() && isConfigRecord(entry))
      .map(([id, entry]) => ({ ...entry, id: String(id).trim() }));
  }
  return normalizeAgentsList({ list: agents.list });
};

const toCanonicalAgentsConfig = (config = {}) => {
  const nextConfig = isConfigRecord(config) ? { ...config } : {};
  const agents = isConfigRecord(nextConfig.agents)
    ? { ...nextConfig.agents }
    : {};

  if (!Object.prototype.hasOwnProperty.call(agents, "entries")) {
    const entries = {};
    for (const entry of normalizeAgentsList({ list: agents.list })) {
      const id = String(entry.id || "").trim();
      if (!id) throw new Error("Cannot persist an AlphaClaw agent without an id");
      if (Object.prototype.hasOwnProperty.call(entries, id)) {
        throw new Error(\`Cannot persist duplicate AlphaClaw agent id "\${id}"\`);
      }
      const { id: _id, ...entryConfig } = entry;
      Object.defineProperty(entries, id, {
        configurable: true,
        enumerable: true,
        value: entryConfig,
        writable: true,
      });
    }
    agents.entries = entries;
  }
  delete agents.list;
  if (
    agents.ownership === "explicit" &&
    Object.values(agents.entries || {}).some((entry) => entry?.default === true)
  ) {
    delete agents.ownership;
  }
  nextConfig.agents = agents;
  return nextConfig;
};`,
    1,
    "agent config adapters",
  );

  patched = replaceExactly(
    patched,
    `const saveConfig = ({ fsImpl, OPENCLAW_DIR, config }) => {
  ensureCodexRuntimePlugin(config);
  writeOpenclawConfig({
    fsModule: fsImpl,
    openclawDir: OPENCLAW_DIR,
    config,
    spacing: 2,
  });
};`,
    `const saveConfig = ({ fsImpl, OPENCLAW_DIR, config }) => {
  ensureCodexRuntimePlugin(config);
  writeOpenclawConfig({
    fsModule: fsImpl,
    openclawDir: OPENCLAW_DIR,
    config: toCanonicalAgentsConfig(config),
    spacing: 2,
  });
};`,
    1,
    "canonical agent writes",
  );

  patched = replaceExactly(
    patched,
    "  const existingList = normalizeAgentsList({ list: existingAgents.list });",
    `  const existingList = listAgentsFromConfig({ agents: existingAgents });
  const hasCanonicalEntries = Object.prototype.hasOwnProperty.call(
    existingAgents,
    "entries",
  );`,
    1,
    "canonical agent reads",
  );

  patched = replaceExactly(
    patched,
    `  const nextList = hasMain
    ? existingList
    : [getImplicitMainAgent({ OPENCLAW_DIR, cfg: nextCfg }), ...existingList];`,
    `  const nextList = hasMain || hasCanonicalEntries
    ? existingList
    : [getImplicitMainAgent({ OPENCLAW_DIR, cfg: nextCfg }), ...existingList];`,
    1,
    "canonical roster ownership",
  );

  patched = replaceExactly(
    patched,
    "  if (!hasDefault && listWithSingleDefault.length > 0) {",
    `  if (
    !hasDefault &&
    listWithSingleDefault.length > 0 &&
    existingAgents.ownership !== "explicit"
  ) {`,
    1,
    "explicit ownership",
  );

  patched = replaceExactly(
    patched,
    `  nextCfg.agents = {
    ...existingAgents,
    list: listWithSingleDefault,
  };
  return nextCfg;`,
    `  const normalizedAgents = {
    ...existingAgents,
    list: listWithSingleDefault,
  };
  delete normalizedAgents.entries;
  nextCfg.agents = normalizedAgents;
  return nextCfg;`,
    1,
    "internal list projection",
  );

  patched = replaceExactly(
    patched,
    "  withNormalizedAgentsConfig,\n  isValidAgentId,",
    "  listAgentsFromConfig,\n  toCanonicalAgentsConfig,\n  withNormalizedAgentsConfig,\n  isValidAgentId,",
    1,
    "adapter exports",
  );

  return { source: patched, changed: true };
}

export function patchAlphaClawWebhookConfigSource(source) {
  if (source.includes(WEBHOOK_PATCH_MARKER)) {
    if (
      !source.includes('const { listAgentsFromConfig } = require("./agents/shared");') ||
      (source.match(/const agents = listAgentsFromConfig\(cfg\);/g) || []).length !== 2
    ) {
      throw new Error("AlphaClaw agents.entries webhook patch is incomplete");
    }
    return { source, changed: false };
  }

  let patched = replaceExactly(
    source,
    `const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
} = require("./openclaw-config");`,
    `const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
} = require("./openclaw-config");
${WEBHOOK_PATCH_MARKER}
const { listAgentsFromConfig } = require("./agents/shared");`,
    1,
    "webhook adapter import",
  );
  patched = replaceExactly(
    patched,
    "  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];",
    "  const agents = listAgentsFromConfig(cfg);",
    2,
    "webhook agent reads",
  );
  return { source: patched, changed: true };
}

export function patchAlphaClawCodexRuntimeSource(source) {
  if (source.includes(CODEX_RUNTIME_PATCH_MARKER)) {
    if (
      !source.includes("const listAgentConfigScopes =") ||
      !source.includes("...listAgentConfigScopes(cfg)")
    ) {
      throw new Error("AlphaClaw agents.entries Codex runtime patch is incomplete");
    }
    return { source, changed: false };
  }

  const patched = replaceExactly(
    source,
    `const configUsesCodexRuntime = (cfg = {}) => {
  const scopes = [
    cfg.agents?.defaults || {},
    ...(Array.isArray(cfg.agents?.list) ? cfg.agents.list : []),
  ];`,
    `${CODEX_RUNTIME_PATCH_MARKER}
const listAgentConfigScopes = (cfg = {}) => {
  const agents =
    cfg.agents && typeof cfg.agents === "object" && !Array.isArray(cfg.agents)
      ? cfg.agents
      : {};
  if (Object.prototype.hasOwnProperty.call(agents, "entries")) {
    if (
      !agents.entries ||
      typeof agents.entries !== "object" ||
      Array.isArray(agents.entries)
    ) {
      return [];
    }
    return Object.values(agents.entries).filter(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    );
  }
  return Array.isArray(agents.list)
    ? agents.list.filter(
        (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
};

const configUsesCodexRuntime = (cfg = {}) => {
  const scopes = [
    cfg.agents?.defaults || {},
    ...listAgentConfigScopes(cfg),
  ];`,
    1,
    "Codex runtime agent reads",
  );
  return { source: patched, changed: true };
}

export function patchAlphaClawWorkspaceSource(source) {
  if (source.includes(WORKSPACE_PATCH_MARKER)) {
    if (
      !source.includes('const { listAgentsFromConfig } = require("../agents/shared");') ||
      !source.includes("const list = listAgentsFromConfig(cfg);")
    ) {
      throw new Error("AlphaClaw agents.entries workspace patch is incomplete");
    }
    return { source, changed: false };
  }

  let patched = replaceExactly(
    source,
    `const { reconcileBootstrapExtraFilesEntry } = require("./openclaw");`,
    `const { reconcileBootstrapExtraFilesEntry } = require("./openclaw");
${WORKSPACE_PATCH_MARKER}
const { listAgentsFromConfig } = require("../agents/shared");`,
    1,
    "workspace adapter import",
  );
  patched = replaceExactly(
    patched,
    "    const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];",
    "    const list = listAgentsFromConfig(cfg);",
    1,
    "workspace agent reads",
  );
  return { source: patched, changed: true };
}

export function patchAlphaClawSystemRouteSource(source) {
  if (source.includes(SYSTEM_ROUTE_PATCH_MARKER)) {
    if (
      !source.includes('const { listAgentsFromConfig } = require("../agents/shared");') ||
      !source.includes("const configuredAgents = listAgentsFromConfig(config);")
    ) {
      throw new Error("AlphaClaw agents.entries system route patch is incomplete");
    }
    return { source, changed: false };
  }

  let patched = replaceExactly(
    source,
    `const { shouldSkipSystemCronInstall } = require("../../cli/git-runtime");`,
    `const { shouldSkipSystemCronInstall } = require("../../cli/git-runtime");
${SYSTEM_ROUTE_PATCH_MARKER}
const { listAgentsFromConfig } = require("../agents/shared");`,
    1,
    "system route adapter import",
  );
  patched = replaceExactly(
    patched,
    `    const configuredAgents = Array.isArray(config?.agents?.list)
      ? config.agents.list
      : [];`,
    "    const configuredAgents = listAgentsFromConfig(config);",
    1,
    "system route agent reads",
  );
  return { source: patched, changed: true };
}

function atomicWrite(path, source) {
  const mode = statSync(path).mode & 0o777;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, source, { mode });
  renameSync(temporaryPath, path);
  chmodSync(path, mode);
}

export function patchInstalledAlphaClawAgentsEntries(options = {}) {
  const packageRoot = resolve(
    options.packageRoot ||
      join(process.cwd(), "node_modules/@chrysb/alphaclaw"),
  );
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    packageJson.version !== SUPPORTED_ALPHACLAW_VERSION ||
    packageJson.dependencies?.openclaw !== SUPPORTED_OPENCLAW_VERSION
  ) {
    throw new Error(
      `Unsupported AlphaClaw/OpenClaw pair ${packageJson.version || "unknown"}/${packageJson.dependencies?.openclaw || "unknown"}; expected ${SUPPORTED_ALPHACLAW_VERSION}/${SUPPORTED_OPENCLAW_VERSION}`,
    );
  }

  const sharedPath = join(packageRoot, "lib/server/agents/shared.js");
  const webhookPath = join(packageRoot, "lib/server/webhooks.js");
  const codexRuntimePath = join(packageRoot, "lib/server/codex-runtime-config.js");
  const workspacePath = join(packageRoot, "lib/server/onboarding/workspace.js");
  const systemRoutePath = join(packageRoot, "lib/server/routes/system.js");
  const sharedResult = patchAlphaClawAgentSharedSource(
    readFileSync(sharedPath, "utf8"),
  );
  const webhookResult = patchAlphaClawWebhookConfigSource(
    readFileSync(webhookPath, "utf8"),
  );
  const codexRuntimeResult = patchAlphaClawCodexRuntimeSource(
    readFileSync(codexRuntimePath, "utf8"),
  );
  const workspaceResult = patchAlphaClawWorkspaceSource(
    readFileSync(workspacePath, "utf8"),
  );
  const systemRouteResult = patchAlphaClawSystemRouteSource(
    readFileSync(systemRoutePath, "utf8"),
  );

  if (sharedResult.changed) atomicWrite(sharedPath, sharedResult.source);
  if (webhookResult.changed) atomicWrite(webhookPath, webhookResult.source);
  if (codexRuntimeResult.changed) {
    atomicWrite(codexRuntimePath, codexRuntimeResult.source);
  }
  if (workspaceResult.changed) atomicWrite(workspacePath, workspaceResult.source);
  if (systemRouteResult.changed) {
    atomicWrite(systemRoutePath, systemRouteResult.source);
  }
  return {
    changed:
      sharedResult.changed ||
      webhookResult.changed ||
      codexRuntimeResult.changed ||
      workspaceResult.changed ||
      systemRouteResult.changed,
    sharedPath,
    webhookPath,
    codexRuntimePath,
    workspacePath,
    systemRoutePath,
  };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = patchInstalledAlphaClawAgentsEntries();
  console.log(
    `Managed AlphaClaw agents.entries patch: ${result.changed ? "applied" : "already applied"}`,
  );
}
