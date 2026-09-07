import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  patchAlphaClawAgentSharedSource,
  patchAlphaClawCodexRuntimeSource,
  patchAlphaClawExecDefaultsSource,
  patchAlphaClawSystemRouteSource,
  patchAlphaClawWebhookConfigSource,
  patchAlphaClawWorkspaceSource,
  patchInstalledAlphaClawAgentsEntries,
} from "../runtime/patch-alphaclaw-agents-entries.mjs";

const SOURCE_PACKAGE_ROOT = fileURLToPath(
  new URL("../node_modules/@chrysb/alphaclaw/", import.meta.url),
);
const OPENCLAW_CLI = fileURLToPath(
  new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url),
);

function patchedCandidate(t) {
  const root = mkdtempSync(join(tmpdir(), "alphaclaw-entries-patch-"));
  const packageRoot = join(root, "alphaclaw");
  cpSync(SOURCE_PACKAGE_ROOT, packageRoot, { recursive: true });
  const result = patchInstalledAlphaClawAgentsEntries({ packageRoot });
  assert.equal(result.changed, true);
  assert.equal(
    patchInstalledAlphaClawAgentsEntries({ packageRoot }).changed,
    false,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, packageRoot };
}

function canonicalConfig() {
  return {
    agents: {
      entries: {
        main: {
          default: true,
          name: "Primary",
          workspace: "/data/.openclaw/workspace",
        },
        "mail-triage": {
          default: false,
          name: "Mail triage",
          workspace: "/data/.openclaw/workspace-mail-triage",
          memory: { search: { enabled: false } },
        },
      },
    },
  };
}

function readConfig(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf8"));
}

test("the AlphaClaw entries patches apply exactly once to the pinned source", () => {
  const shared = readFileSync(
    join(SOURCE_PACKAGE_ROOT, "lib/server/agents/shared.js"),
    "utf8",
  );
  const webhook = readFileSync(
    join(SOURCE_PACKAGE_ROOT, "lib/server/webhooks.js"),
    "utf8",
  );
  const codexRuntime = readFileSync(
    join(SOURCE_PACKAGE_ROOT, "lib/server/codex-runtime-config.js"),
    "utf8",
  );
  const workspace = readFileSync(
    join(SOURCE_PACKAGE_ROOT, "lib/server/onboarding/workspace.js"),
    "utf8",
  );
  const systemRoute = readFileSync(
    join(SOURCE_PACKAGE_ROOT, "lib/server/routes/system.js"),
    "utf8",
  );
  const execDefaults = readFileSync(
    join(SOURCE_PACKAGE_ROOT, "lib/server/exec-defaults-config.js"),
    "utf8",
  );

  const patchedShared = patchAlphaClawAgentSharedSource(shared);
  assert.equal(patchedShared.changed, true);
  assert.equal(
    patchAlphaClawAgentSharedSource(patchedShared.source).changed,
    false,
  );
  const patchedWebhook = patchAlphaClawWebhookConfigSource(webhook);
  assert.equal(patchedWebhook.changed, true);
  assert.equal(
    patchAlphaClawWebhookConfigSource(patchedWebhook.source).changed,
    false,
  );
  const patchedCodexRuntime = patchAlphaClawCodexRuntimeSource(codexRuntime);
  assert.equal(patchedCodexRuntime.changed, true);
  assert.equal(
    patchAlphaClawCodexRuntimeSource(patchedCodexRuntime.source).changed,
    false,
  );
  const patchedWorkspace = patchAlphaClawWorkspaceSource(workspace);
  assert.equal(patchedWorkspace.changed, true);
  assert.equal(
    patchAlphaClawWorkspaceSource(patchedWorkspace.source).changed,
    false,
  );
  const patchedSystemRoute = patchAlphaClawSystemRouteSource(systemRoute);
  assert.equal(patchedSystemRoute.changed, true);
  assert.equal(
    patchAlphaClawSystemRouteSource(patchedSystemRoute.source).changed,
    false,
  );
  const patchedExecDefaults = patchAlphaClawExecDefaultsSource(execDefaults);
  assert.equal(patchedExecDefaults.changed, true);
  assert.equal(
    patchAlphaClawExecDefaultsSource(patchedExecDefaults.source).changed,
    false,
  );
});

test("AlphaClaw does not recreate the retired exec approvals JSON", (t) => {
  const { root, packageRoot } = patchedCandidate(t);
  const stateDir = join(root, "state-no-legacy-approvals");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "openclaw.json"), "{}\n");

  const require = createRequire(join(packageRoot, "compatibility-test.cjs"));
  const { ensureManagedExecDefaults } = require(
    join(packageRoot, "lib/server/exec-defaults-config.js"),
  );
  const result = ensureManagedExecDefaults({ fsModule: fs, openclawDir: stateDir });
  assert.equal(result.approvalsChanged, false);
  assert.equal(fs.existsSync(join(stateDir, "exec-approvals.json")), false);
});

test("AlphaClaw agent reads and writes round-trip canonical entries only", (t) => {
  const { root, packageRoot } = patchedCandidate(t);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "openclaw.json"),
    `${JSON.stringify(canonicalConfig(), null, 2)}\n`,
  );

  const require = createRequire(join(packageRoot, "compatibility-test.cjs"));
  const shared = require(join(packageRoot, "lib/server/agents/shared.js"));
  const internal = shared.withNormalizedAgentsConfig({
    OPENCLAW_DIR: stateDir,
    cfg: canonicalConfig(),
  });
  assert.equal(Object.hasOwn(internal.agents, "entries"), false);
  assert.deepEqual(
    internal.agents.list.map((agent) => agent.id),
    ["main", "mail-triage"],
  );
  assert.equal(
    internal.agents.list.find((agent) => agent.id === "mail-triage").memory
      .search.enabled,
    false,
  );

  shared.saveConfig({ fsImpl: fs, OPENCLAW_DIR: stateDir, config: internal });
  let saved = readConfig(stateDir);
  assert.equal(Object.hasOwn(saved.agents, "list"), false);
  assert.deepEqual(Object.keys(saved.agents.entries), ["main", "mail-triage"]);

  const { createAgentsDomain } = require(
    join(packageRoot, "lib/server/agents/agents.js"),
  );
  const agents = createAgentsDomain({ fsImpl: fs, OPENCLAW_DIR: stateDir });
  assert.deepEqual(
    agents.listAgents().map((agent) => agent.id),
    ["main", "mail-triage"],
  );
  agents.setDefaultAgent("mail-triage");
  saved = readConfig(stateDir);
  assert.equal(Object.hasOwn(saved.agents, "list"), false);
  assert.equal(saved.agents.entries.main.default, false);
  assert.equal(saved.agents.entries["mail-triage"].default, true);
  assert.equal(saved.agents.entries["mail-triage"].memory.search.enabled, false);

  const validation = spawnSync(
    process.execPath,
    [OPENCLAW_CLI, "config", "validate", "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
        OPENCLAW_STATE_DIR: stateDir,
      },
    },
  );
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
});

test("explicit ownership survives reads until AlphaClaw chooses a default", (t) => {
  const { root, packageRoot } = patchedCandidate(t);
  const stateDir = join(root, "state-explicit");
  mkdirSync(stateDir, { recursive: true });
  const config = canonicalConfig();
  config.agents.ownership = "explicit";
  delete config.agents.entries.main.default;
  delete config.agents.entries["mail-triage"].default;
  writeFileSync(
    join(stateDir, "openclaw.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const require = createRequire(join(packageRoot, "explicit-test.cjs"));
  const { createAgentsDomain } = require(
    join(packageRoot, "lib/server/agents/agents.js"),
  );
  const agents = createAgentsDomain({ fsImpl: fs, OPENCLAW_DIR: stateDir });
  assert.equal(agents.listAgents().some((agent) => agent.default), false);

  const shared = require(join(packageRoot, "lib/server/agents/shared.js"));
  const internal = shared.withNormalizedAgentsConfig({
    OPENCLAW_DIR: stateDir,
    cfg: readConfig(stateDir),
  });
  shared.saveConfig({ fsImpl: fs, OPENCLAW_DIR: stateDir, config: internal });
  let saved = readConfig(stateDir);
  assert.equal(saved.agents.ownership, "explicit");
  assert.equal(
    Object.values(saved.agents.entries).some((agent) => agent.default === true),
    false,
  );

  agents.setDefaultAgent("mail-triage");
  saved = readConfig(stateDir);
  assert.equal(saved.agents.ownership, undefined);
  assert.equal(saved.agents.entries["mail-triage"].default, true);
  assert.equal(Object.hasOwn(saved.agents, "list"), false);
});

test("a canonical explicit home/work roster never grows an implicit main", (t) => {
  const { root, packageRoot } = patchedCandidate(t);
  const stateDir = join(root, "state-no-main");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    agents: {
      ownership: "explicit",
      entries: {
        home: { workspace: join(root, "workspace-home") },
        work: { workspace: join(root, "workspace-work") },
      },
    },
  };
  writeFileSync(
    join(stateDir, "openclaw.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const require = createRequire(join(packageRoot, "no-main-test.cjs"));
  const shared = require(join(packageRoot, "lib/server/agents/shared.js"));
  const internal = shared.withNormalizedAgentsConfig({
    OPENCLAW_DIR: stateDir,
    cfg: config,
  });
  assert.deepEqual(
    internal.agents.list.map((agent) => agent.id),
    ["home", "work"],
  );

  shared.saveConfig({ fsImpl: fs, OPENCLAW_DIR: stateDir, config: internal });
  const saved = readConfig(stateDir);
  assert.equal(saved.agents.ownership, "explicit");
  assert.equal(Object.hasOwn(saved.agents, "list"), false);
  assert.deepEqual(Object.keys(saved.agents.entries), ["home", "work"]);
  assert.equal(Object.hasOwn(saved.agents.entries, "main"), false);

  const validation = spawnSync(
    process.execPath,
    [OPENCLAW_CLI, "config", "validate", "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
        OPENCLAW_STATE_DIR: stateDir,
      },
    },
  );
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
});

test("remaining AlphaClaw readers consume canonical agent entries", (t) => {
  const { root, packageRoot } = patchedCandidate(t);
  const stateDir = join(root, "state-readers");
  const mainWorkspace = join(root, "workspace-main");
  const triageWorkspace = join(root, "workspace-mail-triage");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(mainWorkspace, { recursive: true });
  mkdirSync(triageWorkspace, { recursive: true });
  const config = canonicalConfig();
  config.agents.entries.main.workspace = mainWorkspace;
  config.agents.entries["mail-triage"].workspace = triageWorkspace;
  config.agents.entries["mail-triage"].model = {
    primary: "openai/gpt-5.4",
  };
  writeFileSync(
    join(stateDir, "openclaw.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const require = createRequire(join(packageRoot, "reader-test.cjs"));
  const { configUsesCodexRuntime } = require(
    join(packageRoot, "lib/server/codex-runtime-config.js"),
  );
  assert.equal(configUsesCodexRuntime(config), true);

  const { syncBootstrapPromptFiles } = require(
    join(packageRoot, "lib/server/onboarding/workspace.js"),
  );
  syncBootstrapPromptFiles({
    fs,
    workspaceDir: mainWorkspace,
    baseUrl: "http://localhost:3000",
    openclawDir: stateDir,
  });
  assert.equal(
    fs.existsSync(join(triageWorkspace, "hooks/bootstrap/AGENTS.md")),
    true,
  );
  const saved = readConfig(stateDir);
  assert.equal(Object.hasOwn(saved.agents, "list"), false);
  assert.deepEqual(Object.keys(saved.agents.entries), ["main", "mail-triage"]);
});

test("AlphaClaw webhook resolution recognizes mail-triage in entries", (t) => {
  const { root, packageRoot } = patchedCandidate(t);
  const stateDir = join(root, "state-webhook");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "openclaw.json"),
    `${JSON.stringify(canonicalConfig(), null, 2)}\n`,
  );

  const require = createRequire(join(packageRoot, "webhook-test.cjs"));
  const { createWebhook } = require(
    join(packageRoot, "lib/server/webhooks.js"),
  );
  createWebhook({
    fs,
    constants: { OPENCLAW_DIR: stateDir },
    name: "custom-hook",
    destination: {
      agentId: "mail-triage",
      channel: "telegram",
      to: "123456",
    },
  });

  const saved = readConfig(stateDir);
  assert.equal(Object.hasOwn(saved.agents, "list"), false);
  assert.deepEqual(Object.keys(saved.agents.entries), ["main", "mail-triage"]);
  const mapping = saved.hooks.mappings.find(
    (entry) => entry.match?.path === "custom-hook",
  );
  assert.equal(mapping.agentId, "mail-triage");
});
