import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createGmailTransform } from "../managed-hooks/gmail/gmail-transform.mjs";
import {
  applyManagedRuntime,
  patchOpenClawConfig,
} from "../runtime/configure-openclaw.mjs";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "openclaw-runtime-"));
}

function gmailEvent(overrides = {}) {
  return {
    payload: {
      source: "gmail",
      account: "person@example.com",
      historyId: "history-1",
      messages: [
        {
          id: "message-1",
          threadId: "thread-1",
          from: "Example Sender <sender@example.com>",
          to: "person@example.com",
          subject: "Contract date",
          date: "2026-09-06T12:00:00Z",
          snippet:
            "Please review the attached contract by Friday. This preview is long enough for metadata-first triage.",
          body: "<p>PRIVATE BODY: additional details not needed for first-pass triage.</p>",
          labels: ["INBOX"],
          ...overrides,
        },
      ],
    },
  };
}

function transformOptions(overrides = {}) {
  return {
    route: { channel: "telegram", to: "private-target" },
    databasePath: join(temporaryDirectory(), "gmail-triage.sqlite"),
    ...overrides,
  };
}

function promptRecords(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf("[")));
}

function baseConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-5" },
        models: {
          "anthropic/claude-sonnet-5": { alias: "sonnet" },
        },
      },
      list: [{ id: "main", default: true, tools: { profile: "full" } }],
    },
    hooks: {
      allowedAgentIds: ["main"],
      mappings: [
        {
          id: "gmail",
          match: { path: "gmail" },
          action: "agent",
          agentId: "main",
          deliver: true,
          channel: "last",
          transform: { module: "gmail/gmail-transform.mjs" },
        },
      ],
    },
  };
}

function writeRuntimeFixture({ routeInTransform = true } = {}) {
  const stateDir = temporaryDirectory();
  const configPath = join(stateDir, "openclaw.json");
  const transformPath = join(
    stateDir,
    "hooks/transforms/gmail/gmail-transform.mjs",
  );
  mkdirSync(dirname(transformPath), { recursive: true });
  mkdirSync(join(stateDir, ".git/info"), { recursive: true });
  writeFileSync(join(stateDir, ".git/info/exclude"), "# local only\n");
  if (routeInTransform) {
    writeFileSync(
      transformPath,
      'export default async () => ({ channel: "telegram", to: "private-target", agentId: "main" });\n',
    );
  }
  writeFileSync(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`);
  return { stateDir, configPath, transformPath };
}

test("empty Gmail events stop before route lookup, state, and AI", async () => {
  let stateCalls = 0;
  const transform = createGmailTransform(
    transformOptions({
      processWithReservation: async () => {
        stateCalls += 1;
        return null;
      },
    }),
  );
  assert.equal(
    await transform({
      payload: { source: "gmail", account: "person@example.com", messages: [] },
    }),
    null,
  );
  assert.equal(stateCalls, 0);
});

test("attachment-only mail with real metadata is not silently discarded", async () => {
  const transform = createGmailTransform(transformOptions());
  const result = await transform(
    gmailEvent({ subject: "", snippet: "", body: "", labels: ["INBOX"] }),
  );
  assert.ok(result);
  assert.match(result.message, /Example Sender/);
  assert.doesNotMatch(result.message, /unknown sender|\(no subject\)/i);
});

test("long Gmail snippets avoid exposing the full body to first-pass triage", async () => {
  const result = await createGmailTransform(transformOptions())(gmailEvent());
  assert.equal(result.channel, "telegram");
  assert.equal(result.to, "private-target");
  assert.equal(result.agentId, "mail-triage");
  assert.equal(result.model, "anthropic/claude-haiku-4-5");
  assert.equal(result.thinking, "off");
  assert.equal(result.timeoutSeconds, 60);
  assert.equal(result.deliver, true);
  assert.match(result.message, /review the attached contract by Friday/);
  assert.doesNotMatch(result.message, /PRIVATE BODY/);
  assert.match(result.message, /untrusted data/);
});

test("the real body is used when the Gmail snippet is missing", async () => {
  const result = await createGmailTransform(transformOptions())(
    gmailEvent({ snippet: "", body: "<p>Payment is due on 10 September.</p>" }),
  );
  assert.match(result.message, /Payment is due on 10 September/);
});

test("processed Gmail IDs stay suppressed after the transform reopens", async () => {
  const databasePath = join(temporaryDirectory(), "gmail-triage.sqlite");
  const options = transformOptions({ databasePath });
  assert.ok(await createGmailTransform(options)(gmailEvent()));
  assert.equal(await createGmailTransform(options)(gmailEvent()), null);
});

test("an overlapping history window does not suppress a new Gmail ID", async () => {
  const databasePath = join(temporaryDirectory(), "gmail-triage.sqlite");
  const options = transformOptions({ databasePath });
  assert.ok(await createGmailTransform(options)(gmailEvent()));
  assert.ok(
    await createGmailTransform(options)(gmailEvent({ id: "message-2" })),
  );
});

test("a repeated Gmail ID stays suppressed when history advances", async () => {
  const databasePath = join(temporaryDirectory(), "gmail-triage.sqlite");
  const options = transformOptions({ databasePath });
  assert.ok(await createGmailTransform(options)(gmailEvent()));
  const repeated = gmailEvent();
  repeated.payload.historyId = "history-2";
  assert.equal(await createGmailTransform(options)(repeated), null);
});

test("a partial duplicate batch preserves only its new messages", async () => {
  const databasePath = join(temporaryDirectory(), "gmail-triage.sqlite");
  const options = transformOptions({ databasePath });
  assert.ok(await createGmailTransform(options)(gmailEvent()));

  const batch = gmailEvent();
  batch.payload.messages.push({
    ...batch.payload.messages[0],
    id: "message-2",
    subject: "Second unique message",
  });
  const result = await createGmailTransform(options)(batch);
  const records = promptRecords(result.message);
  assert.equal(records.length, 1);
  assert.equal(records[0].subject, "Second unique message");
});

test("concurrent duplicate calls reserve one Gmail action", async () => {
  const databasePath = join(temporaryDirectory(), "gmail-triage.sqlite");
  const options = transformOptions({ databasePath });
  const results = await Promise.all([
    createGmailTransform(options)(gmailEvent()),
    createGmailTransform(options)(gmailEvent()),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("persistent Gmail state stores hashes, not email content or addresses", async () => {
  const databasePath = join(temporaryDirectory(), "gmail-triage.sqlite");
  await createGmailTransform(transformOptions({ databasePath }))(gmailEvent());
  const rawDatabase = readFileSync(databasePath).toString("utf8");
  assert.doesNotMatch(rawDatabase, /person@example\.com/);
  assert.doesNotMatch(rawDatabase, /Contract date/);
  assert.doesNotMatch(rawDatabase, /PRIVATE BODY/);
});

test("duplicate IDs inside one batch are sent to triage only once", async () => {
  const event = gmailEvent();
  event.payload.messages.push({ ...event.payload.messages[0] });
  const result = await createGmailTransform(transformOptions())(event);
  assert.equal(promptRecords(result.message).length, 1);
});

test("a Gmail state error fails open to preserve useful mail", async () => {
  const result = await createGmailTransform(
    transformOptions({
      processWithReservation: async () => {
        throw new Error("temporary database issue");
      },
    }),
  )(gmailEvent());
  assert.ok(result);
});

test("a missing private route fails before any Gmail ID is reserved", async () => {
  const root = temporaryDirectory();
  const databasePath = join(root, "runtime/gmail-triage.sqlite");
  const transform = createGmailTransform({
    deliveryPath: join(root, "runtime/missing-delivery.json"),
    databasePath,
  });
  await assert.rejects(() => transform(gmailEvent()), /route is unavailable/);
  assert.equal(existsSync(databasePath), false);
});

test("large batches have a hard prompt bound and an explicit omission warning", async () => {
  const event = gmailEvent();
  event.payload.messages = Array.from({ length: 100 }, (_, index) => ({
    ...event.payload.messages[0],
    id: `message-${index}`,
    subject: `Subject ${index} ${"x".repeat(500)}`,
    snippet: `Preview ${index} ${"y".repeat(1_000)}`,
  }));
  const result = await createGmailTransform(transformOptions())(event);
  assert.ok(result.message.length < 12_000);
  assert.match(result.message, /80 message\(s\).*omitted/);
  assert.match(result.message, /do not return NO_REPLY/);
});

test("config patch isolates Gmail and preserves the main agent", () => {
  const original = baseConfig();
  const patched = patchOpenClawConfig(original, "/data/.openclaw");
  assert.deepEqual(original.agents.list, [
    { id: "main", default: true, tools: { profile: "full" } },
  ]);
  assert.deepEqual(original.agents.defaults.models, {
    "anthropic/claude-sonnet-5": { alias: "sonnet" },
  });

  const triage = patched.agents.list.find((agent) => agent.id === "mail-triage");
  assert.equal(triage.model.primary, "anthropic/claude-haiku-4-5");
  assert.equal(triage.contextInjection, "never");
  assert.deepEqual(triage.skills, []);
  assert.deepEqual(triage.memorySearch, { enabled: false });
  assert.deepEqual(triage.tools, {
    profile: "minimal",
    deny: ["session_status"],
  });
  assert.equal(triage.params.cacheRetention, "none");
  assert.equal(triage.params.maxTokens, 512);
  assert.ok(
    Object.hasOwn(
      patched.agents.defaults.models,
      "anthropic/claude-haiku-4-5",
    ),
  );
  assert.equal(patched.agents.defaults.utilityModel, undefined);
  assert.equal(patched.hooks.mappings[0].agentId, "mail-triage");
  assert.equal(patched.hooks.mappings[0].thinking, "off");
  assert.equal(patched.hooks.mappings[0].channel, "last");
  assert.equal(patched.hooks.mappings[0].to, undefined);
  assert.deepEqual(patched.hooks.mappings[0].transform, {
    module: "gmail/gmail-transform.mjs",
  });
  assert.deepEqual(patched.hooks.allowedAgentIds, ["main", "mail-triage"]);
});

test("config patch preserves implicit main and an allow-any model setup", () => {
  const config = baseConfig();
  delete config.agents.list;
  delete config.agents.defaults.models;

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.deepEqual(patched.agents.list[0], { id: "main", default: true });
  assert.equal(patched.agents.defaults.models, undefined);
  assert.equal(
    patched.agents.list.filter((agent) => agent.id === "mail-triage").length,
    1,
  );
});

test("managed runtime migrates the private route and is idempotent", async () => {
  const { stateDir, configPath } = writeRuntimeFixture();
  let validations = 0;
  const options = {
    stateDir,
    validateConfig: async () => {
      validations += 1;
      return true;
    },
  };

  const first = await applyManagedRuntime(options);
  assert.equal(first.status, "updated");
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(stateDir, "runtime/gmail-delivery.json"), "utf8"),
    ),
    { channel: "telegram", to: "private-target" },
  );
  const managedTransformPath = join(
    stateDir,
    "hooks/transforms/gmail/gmail-triage-v1.mjs",
  );
  const alphaclawTransformPath = join(
    stateDir,
    "hooks/transforms/gmail/gmail-transform.mjs",
  );
  assert.doesNotMatch(
    readFileSync(managedTransformPath, "utf8"),
    /private-target/,
  );
  assert.equal(
    readFileSync(alphaclawTransformPath, "utf8"),
    readFileSync(managedTransformPath, "utf8"),
  );
  const excludes = readFileSync(join(stateDir, ".git/info/exclude"), "utf8");
  assert.match(excludes, /runtime\/gmail-delivery\.json/);
  assert.match(excludes, /runtime\/gmail-triage\.sqlite\*/);
  assert.match(excludes, /pre-gmail-cost-fix-v1-transform\.mjs/);
  assert.equal((await applyManagedRuntime(options)).status, "unchanged");
  assert.equal(validations, 2);
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.hooks.mappings[0].transform, {
    module: "gmail/gmail-transform.mjs",
  });
  assert.equal(saved.hooks.mappings[0].channel, "last");
  assert.equal(saved.hooks.mappings[0].to, undefined);
  assert.equal(
    saved.agents.list.filter((agent) => agent.id === "mail-triage").length,
    1,
  );
});

test("the canonical transform stays authoritative after AlphaClaw renewal", async () => {
  const { stateDir, configPath } = writeRuntimeFixture();
  await applyManagedRuntime({
    stateDir,
    validateConfig: async () => true,
  });

  // AlphaClaw renewal upserts the canonical module and default agent. The
  // existing canonical transform must still force the isolated cheap route.
  const renewed = JSON.parse(readFileSync(configPath, "utf8"));
  renewed.hooks.mappings[0].agentId = "main";
  renewed.hooks.mappings[0].transform = {
    module: "gmail/gmail-transform.mjs",
  };
  writeFileSync(configPath, `${JSON.stringify(renewed, null, 2)}\n`);

  const canonicalPath = join(
    stateDir,
    "hooks/transforms/gmail/gmail-transform.mjs",
  );
  const canonical = await import(
    `${pathToFileURL(canonicalPath).href}?renewal=${Date.now()}`
  );
  const result = await canonical.createGmailTransform(transformOptions())(
    gmailEvent(),
  );
  assert.equal(result.agentId, "mail-triage");
  assert.equal(result.model, "anthropic/claude-haiku-4-5");
  assert.equal(result.thinking, "off");
  assert.equal(result.timeoutSeconds, 60);
  assert.equal(result.channel, "telegram");
  assert.equal(result.to, "private-target");
});

test("an explicit updated mapping refreshes the private route", async () => {
  const { stateDir, configPath } = writeRuntimeFixture();
  const options = { stateDir, validateConfig: async () => true };
  await applyManagedRuntime(options);

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.hooks.mappings[0].channel = "telegram";
  config.hooks.mappings[0].to = "new-private-target";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await applyManagedRuntime(options);

  const route = JSON.parse(
    readFileSync(join(stateDir, "runtime/gmail-delivery.json"), "utf8"),
  );
  assert.deepEqual(route, { channel: "telegram", to: "new-private-target" });
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.hooks.mappings[0].channel, "last");
  assert.equal(saved.hooks.mappings[0].to, undefined);
});

test("a missing private route is non-fatal and leaves config untouched", async () => {
  const { stateDir, configPath } = writeRuntimeFixture({
    routeInTransform: false,
  });
  const before = readFileSync(configPath, "utf8");
  const result = await applyManagedRuntime({
    stateDir,
    validateConfig: async () => true,
  });
  assert.equal(result.status, "skipped");
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.equal(existsSync(join(stateDir, "runtime/gmail-delivery.json")), false);
});

test("non-JSON or included configs are skipped without blocking AlphaClaw", async () => {
  const stateDir = temporaryDirectory();
  const configPath = join(stateDir, "openclaw.json");
  writeFileSync(configPath, "{ agents: {}, }\n");
  assert.equal((await applyManagedRuntime({ stateDir })).status, "skipped");

  writeFileSync(configPath, '{"$include":"agents.json"}\n');
  assert.equal((await applyManagedRuntime({ stateDir })).status, "skipped");
});

test("schema rejection leaves config and routing files unchanged", async () => {
  const { stateDir, configPath, transformPath } = writeRuntimeFixture();
  const originalConfig = readFileSync(configPath, "utf8");
  const originalTransform = readFileSync(transformPath, "utf8");
  await assert.rejects(
    () =>
      applyManagedRuntime({
        stateDir,
        validateConfig: async () => false,
      }),
    /rejected/,
  );
  assert.equal(readFileSync(configPath, "utf8"), originalConfig);
  assert.equal(readFileSync(transformPath, "utf8"), originalTransform);
  assert.equal(
    existsSync(
      join(stateDir, "hooks/transforms/gmail/gmail-triage-v1.mjs"),
    ),
    false,
  );
  assert.equal(existsSync(join(stateDir, "runtime/gmail-delivery.json")), false);
});

test("the installed OpenClaw schema accepts the complete candidate", async (t) => {
  try {
    import.meta.resolve("openclaw");
  } catch {
    t.skip("OpenClaw is nested by this local package manager");
    return;
  }
  const { stateDir, configPath } = writeRuntimeFixture();
  const result = await applyManagedRuntime({ stateDir });
  assert.equal(result.status, "updated");
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.hooks.mappings[0].agentId, "mail-triage");
});
