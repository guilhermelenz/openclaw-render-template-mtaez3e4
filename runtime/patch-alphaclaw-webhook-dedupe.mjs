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
const PATCH_MARKER =
  "// Managed Gmail dedupe: commit IDs only after durable gateway acceptance.";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`AlphaClaw Gmail dedupe patch drifted at ${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

export function patchAlphaClawWebhookSource(source) {
  if (source.includes(PATCH_MARKER)) {
    if (
      !source.includes("pendingGmailDedupeKeys.set(dedupeKey, nowMs)") ||
      !source.includes("gatewayStatus >= 200 && gatewayStatus < 300")
    ) {
      throw new Error("AlphaClaw Gmail dedupe patch is incomplete");
    }
    return { source, changed: false };
  }

  let patched = replaceExactlyOnce(
    source,
    "  return (req, res) => {\n    const resolvedGatewayUrl =",
    `  return (req, res) => {\n    ${PATCH_MARKER}\n    const pendingGmailDedupeKeys = new Map();\n    const resolvedGatewayUrl =`,
    "request state",
  );
  patched = replaceExactlyOnce(
    patched,
    "          if (gmailSeenMessageIds.has(dedupeKey)) {\n            continue;\n          }\n          gmailSeenMessageIds.set(dedupeKey, nowMs);\n          unseenMessages.push(message);",
    "          if (\n            gmailSeenMessageIds.has(dedupeKey) ||\n            pendingGmailDedupeKeys.has(dedupeKey)\n          ) {\n            continue;\n          }\n          pendingGmailDedupeKeys.set(dedupeKey, nowMs);\n          unseenMessages.push(message);",
    "early reservation",
  );
  patched = replaceExactlyOnce(
    patched,
    "        const gatewayBody = responseTruncated ? `${responseText}\\n[TRUNCATED]` : responseText;\n        try {",
    `        const gatewayBody = responseTruncated ? \`${"${responseText}"}\\n[TRUNCATED]\` : responseText;\n        const gatewayStatus = proxyRes.statusCode || 0;\n        if (gatewayStatus >= 200 && gatewayStatus < 300) {\n          for (const [messageKey, seenAt] of pendingGmailDedupeKeys) {\n            gmailSeenMessageIds.set(messageKey, seenAt);\n          }\n        }\n        try {`,
    "successful acceptance",
  );
  return { source: patched, changed: true };
}

export function patchInstalledAlphaClaw(options = {}) {
  const packageRoot = resolve(
    options.packageRoot ||
      join(process.cwd(), "node_modules/@chrysb/alphaclaw"),
  );
  const packagePath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.version !== SUPPORTED_ALPHACLAW_VERSION) {
    throw new Error(
      `Unsupported AlphaClaw version ${packageJson.version || "unknown"}; expected ${SUPPORTED_ALPHACLAW_VERSION}`,
    );
  }

  const middlewarePath = join(packageRoot, "lib/server/webhook-middleware.js");
  const original = readFileSync(middlewarePath, "utf8");
  const result = patchAlphaClawWebhookSource(original);
  if (!result.changed) return { changed: false, middlewarePath };

  const mode = statSync(middlewarePath).mode & 0o777;
  const temporaryPath = `${middlewarePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, result.source, { mode });
  renameSync(temporaryPath, middlewarePath);
  chmodSync(middlewarePath, mode);
  return { changed: true, middlewarePath };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = patchInstalledAlphaClaw();
  console.log(
    `Managed AlphaClaw Gmail dedupe patch: ${result.changed ? "applied" : "already applied"}`,
  );
}
