import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRIAGE_AGENT_ID = "mail-triage";
const TRIAGE_MODEL = "anthropic/claude-haiku-4-5";
const ALPHACLAW_TRANSFORM_MODULE = "gmail/gmail-transform.mjs";
const MANAGED_TRANSFORM_MODULE = "gmail/gmail-triage-v1.mjs";
const MANAGED_TRANSFORM = fileURLToPath(
  new URL("../managed-hooks/gmail/gmail-transform.mjs", import.meta.url),
);
const RECOVERY_PLUGIN_ID = "gmail-triage-recovery";
const RECOVERY_PLUGIN_PATH = "/app/managed-plugins/gmail-triage-recovery.mjs";
const RECOVERY_PLUGIN_SOURCE = fileURLToPath(
  new URL("../managed-plugins/gmail-triage-recovery.mjs", import.meta.url),
);
const OPENCLAW_8_2_BACKUP_MODULE =
  "backups/pre-openclaw-2026.8.2-config.json";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeAgentId(value) {
  const trimmed = stringValue(value);
  const normalized = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return normalized;
  return (
    normalized
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function sanitizeSecretInput(value) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const source = value.source;
  const provider = value.provider;
  const id = value.id;
  if (
    !["env", "file", "exec", "store"].includes(source) ||
    typeof provider !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(provider) ||
    typeof id !== "string"
  ) {
    return undefined;
  }
  const environmentId = /^[A-Z][A-Z0-9_]{0,127}$/.test(id);
  const fileId =
    id === "value" ||
    (id.startsWith("/") &&
      id
        .slice(1)
        .split("/")
        .every((segment) => /^(?:[^~]|~0|~1)*$/.test(segment)));
  const execId =
    /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(id) &&
    id.split("/").every((segment) => segment !== "." && segment !== "..");
  if (
    ((source === "env" || source === "store") && !environmentId) ||
    (source === "file" && !fileId) ||
    (source === "exec" && !execId)
  ) {
    return undefined;
  }
  return { source, provider, id };
}

function sanitizeMemorySearchConfig(value) {
  if (!isRecord(value)) return {};
  const sanitized = {};

  if (typeof value.enabled === "boolean") sanitized.enabled = value.enabled;
  if (typeof value.rememberAcrossConversations === "boolean") {
    sanitized.rememberAcrossConversations = value.rememberAcrossConversations;
  }
  if (Array.isArray(value.sources)) {
    sanitized.sources = value.sources.filter(
      (source) => source === "memory" || source === "sessions",
    );
  }
  if (Array.isArray(value.extraPaths)) {
    sanitized.extraPaths = value.extraPaths
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!isRecord(entry) || typeof entry.path !== "string") return null;
        return {
          path: entry.path,
          ...(typeof entry.pattern === "string"
            ? { pattern: entry.pattern }
            : {}),
        };
      })
      .filter((entry) => entry !== null);
  }
  if (isRecord(value.multimodal)) {
    const multimodal = {};
    if (typeof value.multimodal.enabled === "boolean") {
      multimodal.enabled = value.multimodal.enabled;
    }
    if (Array.isArray(value.multimodal.modalities)) {
      multimodal.modalities = value.multimodal.modalities.filter((modality) =>
        ["image", "audio", "all"].includes(modality),
      );
    }
    if (isPositiveInteger(value.multimodal.maxFileBytes)) {
      multimodal.maxFileBytes = value.multimodal.maxFileBytes;
    }
    if (Object.keys(multimodal).length > 0) sanitized.multimodal = multimodal;
  }
  if (
    isRecord(value.experimental) &&
    typeof value.experimental.sessionMemory === "boolean"
  ) {
    sanitized.experimental = {
      sessionMemory: value.experimental.sessionMemory,
    };
  }
  if (typeof value.provider === "string") {
    sanitized.provider =
      value.provider.trim().toLowerCase() === "auto" ? "openai" : value.provider;
  }
  if (isRecord(value.remote)) {
    const remote = {};
    if (typeof value.remote.baseUrl === "string") {
      remote.baseUrl = value.remote.baseUrl;
    }
    const apiKey = sanitizeSecretInput(value.remote.apiKey);
    if (apiKey !== undefined) remote.apiKey = apiKey;
    if (isRecord(value.remote.headers)) {
      const headers = {};
      for (const [key, header] of Object.entries(value.remote.headers)) {
        if (
          !["__proto__", "prototype", "constructor"].includes(key) &&
          typeof header === "string"
        ) {
          Object.defineProperty(headers, key, {
            configurable: true,
            enumerable: true,
            value: header,
            writable: true,
          });
        }
      }
      remote.headers = headers;
    }
    if (
      isRecord(value.remote.batch) &&
      typeof value.remote.batch.enabled === "boolean"
    ) {
      remote.batch = { enabled: value.remote.batch.enabled };
    }
    if (Object.keys(remote).length > 0) sanitized.remote = remote;
  }
  for (const key of [
    "fallback",
    "model",
  ]) {
    if (typeof value[key] === "string") sanitized[key] = value[key];
  }
  for (const key of ["inputType", "queryInputType", "documentInputType"]) {
    if (typeof value[key] === "string" && value[key].length > 0) {
      sanitized[key] = value[key];
    }
  }
  if (isPositiveInteger(value.outputDimensionality)) {
    sanitized.outputDimensionality = value.outputDimensionality;
  }
  if (isRecord(value.local) && typeof value.local.modelPath === "string") {
    sanitized.local = { modelPath: value.local.modelPath };
  }
  if (isRecord(value.store)) {
    const store = {};
    if (
      isRecord(value.store.fts) &&
      ["unicode61", "trigram"].includes(value.store.fts.tokenizer)
    ) {
      store.fts = { tokenizer: value.store.fts.tokenizer };
    }
    if (isRecord(value.store.vector)) {
      const vector = {};
      if (typeof value.store.vector.enabled === "boolean") {
        vector.enabled = value.store.vector.enabled;
      }
      if (typeof value.store.vector.extensionPath === "string") {
        vector.extensionPath = value.store.vector.extensionPath;
      }
      if (Object.keys(vector).length > 0) store.vector = vector;
    }
    if (Object.keys(store).length > 0) sanitized.store = store;
  }
  if (isRecord(value.query)) {
    const query = {};
    if (isPositiveInteger(value.query.maxResults)) {
      query.maxResults = value.query.maxResults;
    }
    if (
      typeof value.query.minScore === "number" &&
      Number.isFinite(value.query.minScore) &&
      value.query.minScore >= 0 &&
      value.query.minScore <= 1
    ) {
      query.minScore = value.query.minScore;
    }
    if (Object.keys(query).length > 0) sanitized.query = query;
  }
  if (
    isPositiveInteger(value.maxResults) &&
    !Object.hasOwn(sanitized.query || {}, "maxResults")
  ) {
    sanitized.query = {
      ...(sanitized.query || {}),
      maxResults: value.maxResults,
    };
  }
  if (isRecord(value.cache) && typeof value.cache.enabled === "boolean") {
    sanitized.cache = { enabled: value.cache.enabled };
  }
  return sanitized;
}

function mergeMissing(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) {
      target[key] = clone(value);
    } else if (isRecord(target[key]) && isRecord(value)) {
      mergeMissing(target[key], value);
    }
  }
}

function mergeLegacyAgentMemorySearch(entry) {
  if (!isRecord(entry) || !Object.hasOwn(entry, "memorySearch")) return;
  const legacy = sanitizeMemorySearchConfig(entry.memorySearch);
  if (Object.keys(legacy).length > 0) {
    if (!Object.hasOwn(entry, "memory")) entry.memory = {};
    if (isRecord(entry.memory)) {
      if (!Object.hasOwn(entry.memory, "search")) {
        entry.memory.search = legacy;
      } else if (isRecord(entry.memory.search)) {
        mergeMissing(entry.memory.search, legacy);
      }
    }
  }
  delete entry.memorySearch;
}

function mergeLegacyGlobalMemorySearch(config, legacyValue) {
  const legacy = sanitizeMemorySearchConfig(legacyValue);
  if (Object.keys(legacy).length === 0) return;
  if (!Object.hasOwn(config, "memory")) config.memory = {};
  if (!isRecord(config.memory)) return;
  if (!Object.hasOwn(config.memory, "search")) {
    config.memory.search = legacy;
  } else if (isRecord(config.memory.search)) {
    mergeMissing(config.memory.search, legacy);
  }
}

function usesVoyageMemory(config) {
  const searches = [config.memory?.search];
  const entries = isRecord(config.agents?.entries)
    ? Object.values(config.agents.entries)
    : [];
  for (const entry of entries) searches.push(entry?.memory?.search);
  return searches.some(
    (search) =>
      isRecord(search) &&
      [search.provider, search.fallback].some(
        (provider) => stringValue(provider).toLowerCase() === "voyage",
      ),
  );
}

function disableUnusedVoyagePlugin(config) {
  const voyageProfile = Object.values(config.auth?.profiles || {}).some(
    (profile) =>
      isRecord(profile) &&
      stringValue(profile.provider).toLowerCase() === "voyage",
  );
  if (!voyageProfile || usesVoyageMemory(config)) return;

  if (!isRecord(config.plugins)) config.plugins = {};
  if (!isRecord(config.plugins.entries)) config.plugins.entries = {};
  if (!Object.hasOwn(config.plugins.entries, "voyage")) {
    config.plugins.entries.voyage = { enabled: false };
  }
}

function migrateOpenClaw2Config(config) {
  if (isRecord(config.meta)) delete config.meta.lastTouchedAt;
  if (isRecord(config.gateway?.tailscale)) {
    delete config.gateway.tailscale.resetOnExit;
  }

  const agents = isRecord(config.agents) ? config.agents : null;
  let entries = agents && isRecord(agents.entries) ? agents.entries : null;
  if (agents) {
    if (Object.hasOwn(agents, "entries")) {
      delete agents.list;
    } else if (Array.isArray(agents.list)) {
      entries = {};
      for (const agent of agents.list) {
        if (!isRecord(agent)) continue;
        const requestedId = normalizeAgentId(stringValue(agent.id) || "agent");
        let id = requestedId;
        let suffix = 2;
        while (Object.hasOwn(entries, id)) {
          id = `${requestedId}-${suffix}`;
          suffix += 1;
        }
        const { id: _legacyId, ...legacyEntry } = agent;
        Object.defineProperty(entries, id, {
          configurable: true,
          enumerable: true,
          value: legacyEntry,
          writable: true,
        });
      }
      agents.entries = entries;
      delete agents.list;
    }

    if (
      isRecord(agents.defaults) &&
      Object.hasOwn(agents.defaults, "memorySearch")
    ) {
      mergeLegacyGlobalMemorySearch(config, agents.defaults.memorySearch);
      delete agents.defaults.memorySearch;
    }
  }

  if (Object.hasOwn(config, "memorySearch")) {
    mergeLegacyGlobalMemorySearch(config, config.memorySearch);
    delete config.memorySearch;
  }

  if (entries) {
    for (const entry of Object.values(entries)) {
      mergeLegacyAgentMemorySearch(entry);
    }
  }

  // OpenClaw 2026.8.2 treats a retained Voyage credential as a request to
  // install the new embedding plugin. Keep an unused credential available
  // without silently granting that plugin a new runtime capability.
  disableUnusedVoyagePlugin(config);

  return entries;
}

function gmailMapping(config) {
  return (config.hooks?.mappings || []).find(
    (mapping) =>
      mapping?.id === "gmail" || mapping?.match?.path === "gmail",
  );
}

function quotedProperty(source, property) {
  const quoted = source.match(
    new RegExp(`\\b${property}\\s*:\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`),
  );
  if (quoted) return quoted[2].replace(/\\([\\"'])/g, "$1").trim();
  if (property === "to") {
    return source.match(/\bto\s*:\s*(\d+)/)?.[1] || "";
  }
  return "";
}

function readRoute(path) {
  const route = JSON.parse(readFileSync(path, "utf8"));
  const channel = stringValue(route?.channel);
  const to = stringValue(route?.to);
  if (!channel || !to) throw new Error("Existing Gmail delivery route is incomplete");
  return { channel, to };
}

function routeFromTransform(transformPath) {
  if (!existsSync(transformPath)) return null;
  const source = readFileSync(transformPath, "utf8");
  const channel = quotedProperty(source, "channel");
  const to = quotedProperty(source, "to");
  return channel && to ? { channel, to } : null;
}

function resolveRoute(mapping, transformPath, deliveryPath) {
  const stored = existsSync(deliveryPath) ? readRoute(deliveryPath) : null;
  const mappedTo = stringValue(mapping?.to);
  if (mappedTo) {
    const mappedChannel = stringValue(mapping?.channel);
    const channel = mappedChannel && mappedChannel !== "last"
      ? mappedChannel
      : stored?.channel;
    if (channel) return { channel, to: mappedTo };
  }
  return routeFromTransform(transformPath) || stored;
}

function atomicWrite(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, { mode });
  renameSync(temporaryPath, path);
  chmodSync(path, mode);
}

function writeIfChanged(path, content, mode) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) return false;
  atomicWrite(path, content, mode);
  return true;
}

function ensurePrivateRuntimeFilesStayLocal(stateDir) {
  const gitDir = join(stateDir, ".git");
  if (!existsSync(gitDir)) return false;

  const excludePath = join(gitDir, "info/exclude");
  const rules = [
    "runtime/gmail-delivery.json*",
    "runtime/gmail-triage.sqlite*",
    "runtime/gmail-triage.key*",
    "runtime/openclaw-doctor-*.json",
    `${OPENCLAW_8_2_BACKUP_MODULE}*`,
    "backups/pre-gmail-cost-fix-v1.json*",
    "backups/pre-gmail-cost-fix-v1-transform.mjs*",
    "workspace-mail-triage/",
  ];
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const existing = new Set(
    current
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = rules.filter((rule) => !existing.has(rule));
  if (missing.length === 0) return false;

  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
  atomicWrite(excludePath, `${prefix}${missing.join("\n")}\n`, 0o600);
  return true;
}

async function validateWithInstalledOpenClaw(config, customValidator) {
  if (customValidator) {
    const result = await customValidator(config);
    if (result === false) throw new Error("Managed OpenClaw config was rejected");
    return;
  }

  const validationDir = mkdtempSync(join(tmpdir(), "openclaw-config-validate-"));
  const validationPath = join(validationDir, "openclaw.json");
  const validationConfig = clone(config);
  if (Array.isArray(validationConfig.plugins?.load?.paths)) {
    validationConfig.plugins.load.paths = validationConfig.plugins.load.paths.map(
      (path) => path === RECOVERY_PLUGIN_PATH ? RECOVERY_PLUGIN_SOURCE : path,
    );
  }

  try {
    atomicWrite(
      validationPath,
      `${JSON.stringify(validationConfig, null, 2)}\n`,
      0o600,
    );
    const entryPath = fileURLToPath(import.meta.resolve("openclaw"));
    const cliPath = join(dirname(dirname(entryPath)), "openclaw.mjs");
    const result = spawnSync(
      process.execPath,
      [cliPath, "config", "validate", "--json"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          NO_COLOR: "1",
          OPENCLAW_CONFIG_PATH: validationPath,
          OPENCLAW_STATE_DIR: validationDir,
        },
      },
    );
    if (result.error) throw result.error;
    let report;
    try {
      report = JSON.parse(result.stdout || "{}");
    } catch {
      throw new Error("OpenClaw config validation returned unreadable output");
    }
    if (result.status === 0 && report.valid === true) return;
    const issues = Array.isArray(report.issues)
      ? report.issues
          .slice(0, 10)
          .map((issue) => `${issue.path || "config"}: ${issue.message || "invalid"}`)
          .join("; ")
      : report.error?.message || "validation failed";
    throw new Error(`Managed OpenClaw config failed validation: ${issues}`);
  } finally {
    rmSync(validationDir, { recursive: true, force: true });
  }
}

export function patchOpenClawConfig(current, stateDir) {
  const config = clone(current);
  migrateOpenClaw2Config(config);
  const mapping = gmailMapping(config);
  if (!mapping) return config;

  if (!isRecord(config.agents)) config.agents = {};
  if (!isRecord(config.agents.defaults)) config.agents.defaults = {};
  if (!isRecord(config.agents.entries)) config.agents.entries = {};
  const agentEntries = config.agents.entries;
  const configuredModels = config.agents.defaults.models;
  if (
    configuredModels &&
    typeof configuredModels === "object" &&
    Object.keys(configuredModels).length > 0
  ) {
    config.agents.defaults.models = {
      ...configuredModels,
      [TRIAGE_MODEL]: configuredModels[TRIAGE_MODEL] || {},
    };
  }
  if (
    Object.keys(agentEntries).length === 0 ||
    Object.keys(agentEntries).every((id) => id === TRIAGE_AGENT_ID)
  ) {
    config.agents.entries = {
      main: { default: true },
      ...agentEntries,
    };
  }
  const existing = isRecord(config.agents.entries[TRIAGE_AGENT_ID])
    ? config.agents.entries[TRIAGE_AGENT_ID]
    : {};
  const managedAgent = {
    ...existing,
    default: false,
    name: "Mail triage",
    description: "Low-cost isolated filter for untrusted Gmail notifications",
    workspace: join(stateDir, "workspace-mail-triage"),
    model: { primary: TRIAGE_MODEL, fallbacks: [] },
    utilityModel: TRIAGE_MODEL,
    thinkingDefault: "off",
    reasoningDefault: "off",
    contextInjection: "never",
    skills: [],
    memory: { search: { enabled: false } },
    params: {
      ...(existing.params || {}),
      cacheRetention: "none",
      maxTokens: 512,
    },
    tools: { profile: "minimal", deny: ["session_status"] },
  };
  delete managedAgent.memorySearch;

  config.agents.entries[TRIAGE_AGENT_ID] = managedAgent;

  mapping.action = "agent";
  mapping.agentId = TRIAGE_AGENT_ID;
  mapping.wakeMode = "now";
  mapping.deliver = true;
  mapping.model = TRIAGE_MODEL;
  mapping.thinking = "off";
  mapping.timeoutSeconds = 60;
  mapping.channel = "last";
  delete mapping.to;
  mapping.transform = { module: ALPHACLAW_TRANSFORM_MODULE };

  if (Array.isArray(config.hooks?.allowedAgentIds)) {
    config.hooks.allowedAgentIds = [
      ...new Set([...config.hooks.allowedAgentIds, TRIAGE_AGENT_ID]),
    ];
  }

  config.plugins ||= {};
  config.plugins.load ||= {};
  const pluginPaths = Array.isArray(config.plugins.load.paths)
    ? config.plugins.load.paths
    : [];
  config.plugins.load.paths = [
    ...new Set([...pluginPaths, RECOVERY_PLUGIN_PATH]),
  ];
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = [
      ...new Set([...config.plugins.allow, RECOVERY_PLUGIN_ID]),
    ];
  }
  config.plugins.entries ||= {};
  config.plugins.entries[RECOVERY_PLUGIN_ID] = {
    ...(config.plugins.entries[RECOVERY_PLUGIN_ID] || {}),
    enabled: true,
    llm: {
      ...(config.plugins.entries[RECOVERY_PLUGIN_ID]?.llm || {}),
      allowAgentIdOverride: true,
      allowModelOverride: true,
      allowedModels: [TRIAGE_MODEL],
    },
  };
  return config;
}

export async function applyManagedRuntime(options = {}) {
  const stateDir = resolve(
    options.stateDir || process.env.OPENCLAW_STATE_DIR || "/data/.openclaw",
  );
  const configPath = options.configPath || join(stateDir, "openclaw.json");
  const transformsDir = join(stateDir, "hooks/transforms");
  const managedTransformPath =
    options.transformPath || join(transformsDir, MANAGED_TRANSFORM_MODULE);
  const alphaclawTransformPath =
    options.alphaclawTransformPath ||
    join(transformsDir, ALPHACLAW_TRANSFORM_MODULE);
  const deliveryPath =
    options.deliveryPath || join(stateDir, "runtime/gmail-delivery.json");
  const bundledTransform = options.bundledTransform || MANAGED_TRANSFORM;

  if (!existsSync(configPath)) {
    return { status: "skipped", reason: "OpenClaw is not configured yet" };
  }

  const originalText = readFileSync(configPath, "utf8");
  let original;
  try {
    original = JSON.parse(originalText);
  } catch {
    return { status: "skipped", reason: "Config uses a non-JSON format" };
  }
  if (Object.hasOwn(original, "$include")) {
    return { status: "skipped", reason: "Config uses includes" };
  }

  const normalized = clone(original);
  migrateOpenClaw2Config(normalized);
  const normalizedText = `${JSON.stringify(normalized, null, 2)}\n`;
  const compatibilityChanged =
    normalizedText !== `${originalText.trimEnd()}\n`;
  const compatibilityBackupPath = join(
    stateDir,
    OPENCLAW_8_2_BACKUP_MODULE,
  );
  const persistCompatibilityOnly = async (result) => {
    if (!compatibilityChanged) return result;
    await validateWithInstalledOpenClaw(normalized, options.validateConfig);
    if (!existsSync(compatibilityBackupPath)) {
      atomicWrite(
        compatibilityBackupPath,
        `${originalText.trimEnd()}\n`,
        0o600,
      );
    }
    ensurePrivateRuntimeFilesStayLocal(stateDir);
    const mode = statSync(configPath).mode & 0o777;
    atomicWrite(configPath, normalizedText, mode || 0o600);
    return {
      ...result,
      status: "updated",
      compatibilityUpdated: true,
    };
  };

  const mapping = gmailMapping(normalized);
  if (!mapping) {
    return persistCompatibilityOnly({
      status: "unchanged",
      gmailManaged: false,
    });
  }
  const sourceModule = stringValue(mapping.transform?.module);
  const sourceTransformPath = sourceModule
    ? join(transformsDir, sourceModule)
    : join(transformsDir, "gmail/gmail-transform.mjs");
  const route = resolveRoute(mapping, sourceTransformPath, deliveryPath);
  if (!route) {
    return persistCompatibilityOnly({
      status: "skipped",
      gmailManaged: true,
      reason: existsSync(sourceTransformPath)
        ? "Private Gmail delivery route must be restored"
        : "Gmail delivery is not configured yet",
    });
  }

  const patched = patchOpenClawConfig(normalized, stateDir);
  await validateWithInstalledOpenClaw(patched, options.validateConfig);

  let changed = false;
  const patchedText = `${JSON.stringify(patched, null, 2)}\n`;
  const configChanged = patchedText !== `${originalText.trimEnd()}\n`;
  const gmailConfigChanged = patchedText !== normalizedText;
  if (compatibilityChanged && !existsSync(compatibilityBackupPath)) {
    atomicWrite(
      compatibilityBackupPath,
      `${originalText.trimEnd()}\n`,
      0o600,
    );
  }
  const backupPath = join(stateDir, "backups/pre-gmail-cost-fix-v1.json");
  if (gmailConfigChanged && !existsSync(backupPath)) {
    atomicWrite(backupPath, normalizedText, 0o600);
  }
  const transformBackupPath = join(
    stateDir,
    "backups/pre-gmail-cost-fix-v1-transform.mjs",
  );
  const bundledTransformSource = readFileSync(bundledTransform, "utf8");
  if (
    existsSync(alphaclawTransformPath) &&
    !existsSync(transformBackupPath) &&
    readFileSync(alphaclawTransformPath, "utf8") !== bundledTransformSource
  ) {
    atomicWrite(
      transformBackupPath,
      readFileSync(alphaclawTransformPath, "utf8"),
      0o600,
    );
  }

  changed = ensurePrivateRuntimeFilesStayLocal(stateDir) || changed;
  mkdirSync(join(stateDir, "workspace-mail-triage"), {
    recursive: true,
    mode: 0o700,
  });
  changed =
    writeIfChanged(
      deliveryPath,
      `${JSON.stringify(route, null, 2)}\n`,
      0o600,
    ) || changed;
  changed =
    writeIfChanged(
      managedTransformPath,
      bundledTransformSource,
      0o644,
    ) || changed;
  changed =
    writeIfChanged(
      alphaclawTransformPath,
      bundledTransformSource,
      0o644,
    ) || changed;
  if (configChanged) {
    const mode = statSync(configPath).mode & 0o777;
    atomicWrite(configPath, patchedText, mode || 0o600);
    changed = true;
  }

  return { status: changed ? "updated" : "unchanged", gmailManaged: true };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await applyManagedRuntime();
  const suffix = result.reason ? ` (${result.reason})` : "";
  console.log(`Managed OpenClaw runtime: ${result.status}${suffix}`);
}
