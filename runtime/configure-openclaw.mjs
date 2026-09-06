import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRIAGE_AGENT_ID = "mail-triage";
const TRIAGE_MODEL = "anthropic/claude-haiku-4-5";
const ALPHACLAW_TRANSFORM_MODULE = "gmail/gmail-transform.mjs";
const MANAGED_TRANSFORM_MODULE = "gmail/gmail-triage-v1.mjs";
const MANAGED_TRANSFORM = fileURLToPath(
  new URL("../managed-hooks/gmail/gmail-transform.mjs", import.meta.url),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
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

  const { OpenClawSchema } = await import("openclaw/plugin-sdk/config-schema");
  const result = OpenClawSchema.safeParse(config);
  if (result.success) return;
  const issues = result.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Managed OpenClaw config failed validation: ${issues}`);
}

export function patchOpenClawConfig(current, stateDir) {
  const config = clone(current);
  const mapping = gmailMapping(config);
  if (!mapping) return config;

  config.agents ||= {};
  config.agents.defaults ||= {};
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
  config.agents.list = Array.isArray(config.agents.list)
    ? config.agents.list
    : [];
  if (
    config.agents.list.length === 0 ||
    config.agents.list.every((agent) => agent?.id === TRIAGE_AGENT_ID)
  ) {
    config.agents.list.unshift({ id: "main", default: true });
  }
  const existingIndex = config.agents.list.findIndex(
    (agent) => agent?.id === TRIAGE_AGENT_ID,
  );
  const existing = existingIndex >= 0 ? config.agents.list[existingIndex] : {};
  const managedAgent = {
    ...existing,
    id: TRIAGE_AGENT_ID,
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
    memorySearch: { enabled: false },
    params: {
      ...(existing.params || {}),
      cacheRetention: "none",
      maxTokens: 512,
    },
    tools: { profile: "minimal", deny: ["session_status"] },
  };

  if (existingIndex >= 0) config.agents.list[existingIndex] = managedAgent;
  else config.agents.list.push(managedAgent);

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

  const mapping = gmailMapping(original);
  if (!mapping) return { status: "unchanged", gmailManaged: false };
  const sourceModule = stringValue(mapping.transform?.module);
  const sourceTransformPath = sourceModule
    ? join(transformsDir, sourceModule)
    : join(transformsDir, "gmail/gmail-transform.mjs");
  const route = resolveRoute(mapping, sourceTransformPath, deliveryPath);
  if (!route) {
    return {
      status: "skipped",
      reason: existsSync(sourceTransformPath)
        ? "Private Gmail delivery route must be restored"
        : "Gmail delivery is not configured yet",
    };
  }

  const patched = patchOpenClawConfig(original, stateDir);
  await validateWithInstalledOpenClaw(patched, options.validateConfig);

  let changed = false;
  const patchedText = `${JSON.stringify(patched, null, 2)}\n`;
  const configChanged = patchedText !== `${originalText.trimEnd()}\n`;
  const backupPath = join(stateDir, "backups/pre-gmail-cost-fix-v1.json");
  if (configChanged && !existsSync(backupPath)) {
    atomicWrite(backupPath, `${originalText.trimEnd()}\n`, 0o600);
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
