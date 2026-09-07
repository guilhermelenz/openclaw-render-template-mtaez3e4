import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  claimNextGmailJob,
  completeGmailProcessing,
  createGmailTransform,
  markGmailDeliveryDispatched,
} from "../managed-hooks/gmail/gmail-transform.mjs";
import { createGmailTriageWorker } from "../managed-plugins/gmail-triage-recovery.mjs";
import {
  applyManagedRuntime,
  patchOpenClawConfig,
} from "../runtime/configure-openclaw.mjs";
import {
  patchAlphaClawWebhookSource,
  patchInstalledAlphaClaw,
} from "../runtime/patch-alphaclaw-webhook-dedupe.mjs";

const ROUTE = { channel: "telegram", to: "private-target" };

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "openclaw-runtime-"));
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function waitForOutput(child, pattern, timeoutMs = 20_000) {
  let output = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for gateway output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      if (!pattern.test(output)) return;
      cleanup();
      resolve(output);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `Gateway exited before readiness (${code ?? signal ?? "unknown"}):\n${output}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
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

function stateFixture(overrides = {}) {
  const root = temporaryDirectory();
  return {
    root,
    databasePath: join(root, "runtime/gmail-triage.sqlite"),
    keyPath: join(root, "runtime/gmail-triage.key"),
    route: ROUTE,
    ...overrides,
  };
}

function transformFor(state, overrides = {}) {
  return createGmailTransform({
    route: state.route,
    databasePath: state.databasePath,
    keyPath: state.keyPath,
    ...overrides,
  });
}

function queryAll(databasePath, sql, ...params) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all(...params);
  } finally {
    database.close();
  }
}

function jobs(state) {
  return queryAll(
    state.databasePath,
    "SELECT * FROM triage_jobs ORDER BY created_at, job_id",
  );
}

function messages(state) {
  return queryAll(
    state.databasePath,
    "SELECT * FROM triage_messages ORDER BY seen_at, message_key",
  );
}

function promptRecords(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf("[")));
}

function workerFor(state, overrides = {}) {
  const calls = { model: 0, load: 0, send: 0, prompts: [], alerts: [] };
  const model = overrides.model || (async () => ({ text: "NO_REPLY" }));
  const send =
    overrides.send ||
    (async () => ({ channel: "telegram", messageId: "receipt-1" }));
  const runtime = {
    config: { current: () => ({ channels: { telegram: {} } }) },
    llm: {
      complete: async (request) => {
        calls.model += 1;
        calls.prompts.push(request.messages[0].content);
        return model(request, calls);
      },
    },
    channel: {
      outbound: {
        loadAdapter: async (...args) => {
          calls.load += 1;
          if (overrides.loadAdapter) {
            return overrides.loadAdapter(...args, calls);
          }
          return {
            sendText: async (context) => {
              calls.send += 1;
              calls.alerts.push(context.text);
              return send(context, calls);
            },
          };
        },
      },
    },
  };
  const worker = createGmailTriageWorker({
    runtime,
    logger: { info() {}, warn() {}, error() {} },
    databasePath: state.databasePath,
    keyPath: state.keyPath,
    route: overrides.route || state.route,
    clock: overrides.clock || Date.now,
  });
  return { worker, calls, runtime };
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
      entries: {
        main: { default: true, tools: { profile: "full" } },
      },
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
  const transform = createGmailTransform({
    enqueueJob: async () => {
      stateCalls += 1;
    },
  });
  assert.equal(
    await transform({
      payload: { source: "gmail", account: "person@example.com", messages: [] },
    }),
    null,
  );
  assert.equal(stateCalls, 0);
});

test("webhook acceptance happens only after a durable enqueue", async () => {
  const state = stateFixture();
  assert.equal(await transformFor(state)(gmailEvent()), null);
  assert.equal(jobs(state)[0].status, "pending_process");
  assert.equal(messages(state).length, 1);
  assert.equal(existsSync(state.keyPath), true);
});

test("attachment-only mail with real metadata reaches triage", async () => {
  const state = stateFixture();
  await transformFor(state)(
    gmailEvent({ subject: "", snippet: "", body: "", labels: ["INBOX"] }),
  );
  const { worker, calls } = workerFor(state);
  await worker.runOnce();
  assert.match(calls.prompts[0], /Example Sender/);
  assert.doesNotMatch(calls.prompts[0], /unknown sender|\(no subject\)/i);
});

test("long snippets avoid exposing the full body to first-pass triage", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const { worker, calls } = workerFor(state);
  await worker.runOnce();
  assert.match(calls.prompts[0], /review the attached contract by Friday/);
  assert.doesNotMatch(calls.prompts[0], /PRIVATE BODY/);
  assert.match(calls.prompts[0], /untrusted data/);
});

test("the real body is used when the Gmail snippet is missing", async () => {
  const state = stateFixture();
  await transformFor(state)(
    gmailEvent({ snippet: "", body: "<p>Payment is due on 10 September.</p>" }),
  );
  const { worker, calls } = workerFor(state);
  await worker.runOnce();
  assert.match(calls.prompts[0], /Payment is due on 10 September/);
});

test("duplicate Gmail IDs stay suppressed across transform restarts", async () => {
  const state = stateFixture();
  assert.equal(await transformFor(state)(gmailEvent()), null);
  assert.equal(await transformFor(state)(gmailEvent()), null);
  assert.equal(jobs(state).length, 1);
  assert.equal(messages(state).length, 1);
});

test("legacy accepted Gmail IDs migrate once without being resurrected", async () => {
  const state = stateFixture();
  mkdirSync(dirname(state.databasePath), { recursive: true });
  const legacyKey = createHash("sha256")
    .update("message\0person@example.com\0message-1")
    .digest("hex");
  const database = new DatabaseSync(state.databasePath);
  try {
    database.exec(
      "CREATE TABLE processed_keys (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)",
    );
    database
      .prepare("INSERT INTO processed_keys (key, seen_at) VALUES (?, ?)")
      .run(legacyKey, Date.now());
  } finally {
    database.close();
  }

  await transformFor(state)(gmailEvent());
  assert.equal(jobs(state).length, 0);
  assert.equal(messages(state).length, 1);
  assert.equal(
    queryAll(
      state.databasePath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'processed_keys'",
    ).length,
    0,
  );
  assert.equal(await claimNextGmailJob(state), null);
  assert.equal(messages(state).length, 1);
});

test("an overlapping history window preserves a legitimate new Gmail ID", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  await transformFor(state)(gmailEvent({ id: "message-2" }));
  assert.equal(jobs(state).length, 2);
  assert.equal(messages(state).length, 2);
});

test("history changes do not bypass Gmail message-ID deduplication", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const repeated = gmailEvent();
  repeated.payload.historyId = "history-2";
  await transformFor(state)(repeated);
  assert.equal(jobs(state).length, 1);
});

test("a partial duplicate batch queues only its new messages", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const first = workerFor(state);
  await first.worker.runOnce();

  const batch = gmailEvent();
  batch.payload.messages.push({
    ...batch.payload.messages[0],
    id: "message-2",
    subject: "Second unique message",
  });
  await transformFor(state)(batch);
  const second = workerFor(state);
  await second.worker.runOnce();
  const records = promptRecords(second.calls.prompts[0]);
  assert.equal(records.length, 1);
  assert.equal(records[0].subject, "Second unique message");
});

test("concurrent duplicate webhooks create one durable job", async () => {
  const state = stateFixture();
  await Promise.all([
    transformFor(state)(gmailEvent()),
    transformFor(state)(gmailEvent()),
  ]);
  assert.equal(jobs(state).length, 1);
});

test("persistent Gmail state encrypts email details and addresses", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const rawDatabase = readFileSync(state.databasePath).toString("utf8");
  assert.doesNotMatch(rawDatabase, /person@example\.com/);
  assert.doesNotMatch(rawDatabase, /Contract date/);
  assert.doesNotMatch(rawDatabase, /PRIVATE BODY/);
});

test("a corrupt encrypted job is quarantined without blocking newer mail", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const database = new DatabaseSync(state.databasePath);
  try {
    database
      .prepare("UPDATE triage_jobs SET prompt = ? WHERE job_id = ?")
      .run(Buffer.from("broken"), jobs(state)[0].job_id);
  } finally {
    database.close();
  }

  assert.equal(await claimNextGmailJob(state), null);
  assert.equal(jobs(state)[0].status, "failed_terminal");
  assert.equal(jobs(state)[0].last_error_class, "state_payload_invalid");

  await transformFor(state)(gmailEvent({ id: "message-2" }));
  assert.equal((await claimNextGmailJob(state)).stage, "processing");
});

test("duplicate IDs inside one batch reach triage only once", async () => {
  const state = stateFixture();
  const event = gmailEvent();
  event.payload.messages.push({ ...event.payload.messages[0] });
  await transformFor(state)(event);
  const { worker, calls } = workerFor(state);
  await worker.runOnce();
  assert.equal(promptRecords(calls.prompts[0]).length, 1);
});

test("a state failure fails closed instead of accepting untracked work", async () => {
  const state = stateFixture();
  const transform = transformFor(state, {
    enqueueJob: async () => {
      throw new Error("temporary database issue");
    },
  });
  await assert.rejects(() => transform(gmailEvent()), /database issue/);
});

test("a missing private route fails before any Gmail ID is queued", async () => {
  const state = stateFixture();
  const transform = createGmailTransform({
    deliveryPath: join(state.root, "runtime/missing-delivery.json"),
    databasePath: state.databasePath,
    keyPath: state.keyPath,
  });
  await assert.rejects(() => transform(gmailEvent()), /route is unavailable/);
  assert.equal(existsSync(state.databasePath), false);
});

test("large batches keep a hard prompt bound and an omission warning", async () => {
  const state = stateFixture();
  const event = gmailEvent();
  event.payload.messages = Array.from({ length: 100 }, (_, index) => ({
    ...event.payload.messages[0],
    id: `message-${index}`,
    subject: `Subject ${index} ${"x".repeat(500)}`,
    snippet: `Preview ${index} ${"y".repeat(1_000)}`,
  }));
  await transformFor(state)(event);
  const { worker, calls } = workerFor(state);
  await worker.runOnce();
  assert.ok(calls.prompts[0].length < 12_000);
  assert.match(calls.prompts[0], /80 message\(s\).*omitted/);
  assert.match(calls.prompts[0], /do not return NO_REPLY/);
});

test("duplicates during processing do not create concurrent work", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  assert.ok(await claimNextGmailJob(state));
  await transformFor(state)(gmailEvent());
  assert.equal(jobs(state).length, 1);
  assert.equal(await claimNextGmailJob(state), null);
});

test("only one worker can claim a queued Gmail job", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const claims = await Promise.all([
    claimNextGmailJob(state),
    claimNextGmailJob(state),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test("intentional NO_REPLY completes without Telegram delivery", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const { worker, calls } = workerFor(state);
  await worker.runOnce();
  assert.equal(calls.model, 1);
  assert.equal(calls.send, 0);
  assert.equal(jobs(state)[0].status, "succeeded");
  assert.equal(jobs(state)[0].outcome, "no_reply");
  assert.equal(jobs(state)[0].prompt, null);
});

test("an alert is generated once and completed on a confirmed receipt", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const { worker, calls } = workerFor(state, {
    model: async () => ({ text: "Revise o contrato até sexta-feira." }),
  });
  await worker.runOnce();
  assert.equal(jobs(state)[0].status, "pending_delivery");
  await worker.runOnce();
  assert.equal(calls.model, 1);
  assert.equal(calls.send, 1);
  assert.deepEqual(calls.alerts, ["Revise o contrato até sexta-feira."]);
  assert.equal(jobs(state)[0].status, "succeeded");
  assert.equal(jobs(state)[0].outcome, "delivered");
  assert.equal(jobs(state)[0].receipt_id, "receipt-1");
  assert.equal(jobs(state)[0].alert, null);
});

test("processing failures retry twice and stop after three model attempts", async () => {
  const state = stateFixture();
  let now = Date.now();
  await transformFor(state)(gmailEvent());
  const { worker, calls } = workerFor(state, {
    clock: () => now,
    model: async () => {
      throw new Error("model unavailable");
    },
  });

  await worker.runOnce();
  let row = jobs(state)[0];
  assert.equal(row.status, "retry_wait");
  assert.equal(row.next_attempt_at, now + 60_000);
  assert.equal((await worker.runOnce()).worked, false);

  now = row.next_attempt_at;
  await worker.runOnce();
  row = jobs(state)[0];
  assert.equal(row.next_attempt_at, now + 5 * 60_000);
  now = row.next_attempt_at;
  await worker.runOnce();
  row = jobs(state)[0];
  assert.equal(calls.model, 3);
  assert.equal(row.status, "failed_terminal");
  assert.equal(row.prompt, null);
});

test("pre-send delivery failures retry without another model charge", async () => {
  const state = stateFixture();
  let now = Date.now();
  await transformFor(state)(gmailEvent());
  const { worker, calls } = workerFor(state, {
    clock: () => now,
    model: async () => ({ text: "Alerta importante." }),
    loadAdapter: async () => {
      throw new Error("channel runtime unavailable before dispatch");
    },
  });

  await worker.runOnce();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await worker.runOnce();
    const row = jobs(state)[0];
    if (attempt < 5) {
      assert.equal(row.status, "retry_wait");
      now = row.next_attempt_at;
    } else {
      assert.equal(row.status, "failed_terminal");
    }
  }
  assert.equal(calls.model, 1);
  assert.equal(calls.load, 5);
  assert.equal(calls.send, 0);
});

test("an expired processing lease recovers after restart", async () => {
  const state = stateFixture();
  const start = Date.now();
  await transformFor(state)(gmailEvent());
  assert.ok(
    await claimNextGmailJob({
      ...state,
      now: start,
      processingLeaseMs: 10,
    }),
  );
  const { worker, calls } = workerFor(state, { clock: () => start + 11 });
  await worker.runOnce();
  assert.equal(calls.model, 1);
  assert.equal(jobs(state)[0].processing_attempts, 2);
  assert.equal(jobs(state)[0].outcome, "no_reply");
});

test("an expired pre-send lease safely retries the saved alert", async () => {
  const state = stateFixture();
  const start = Date.now();
  await transformFor(state)(gmailEvent());
  const processing = await claimNextGmailJob({ ...state, now: start });
  await completeGmailProcessing({
    ...state,
    jobId: processing.jobId,
    token: processing.token,
    output: "Alerta salvo.",
    now: start,
  });
  assert.ok(
    await claimNextGmailJob({
      ...state,
      now: start,
      deliveryLeaseMs: 10,
    }),
  );
  const { worker, calls } = workerFor(state, { clock: () => start + 11 });
  await worker.runOnce();
  assert.equal(calls.model, 0);
  assert.equal(calls.send, 1);
  assert.equal(jobs(state)[0].outcome, "delivered");
});

test("an expired post-dispatch lease becomes ambiguous without resend", async () => {
  const state = stateFixture();
  const start = Date.now();
  await transformFor(state)(gmailEvent());
  const processing = await claimNextGmailJob({ ...state, now: start });
  await completeGmailProcessing({
    ...state,
    jobId: processing.jobId,
    token: processing.token,
    output: "Alerta salvo.",
    now: start,
  });
  const delivery = await claimNextGmailJob({
    ...state,
    now: start,
    deliveryLeaseMs: 10,
  });
  await markGmailDeliveryDispatched({
    ...state,
    jobId: delivery.jobId,
    token: delivery.token,
    now: start,
  });
  const { worker, calls } = workerFor(state, { clock: () => start + 11 });
  assert.equal((await worker.runOnce()).worked, false);
  assert.equal(calls.send, 0);
  assert.equal(jobs(state)[0].status, "ambiguous_delivery");
});

test("an error after platform dispatch is quarantined as ambiguous", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const { worker, calls } = workerFor(state, {
    model: async () => ({ text: "Alerta salvo." }),
    send: async () => {
      throw new Error("connection lost after dispatch");
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  assert.equal(calls.send, 1);
  assert.equal(jobs(state)[0].status, "ambiguous_delivery");
  assert.equal((await worker.runOnce()).worked, false);
});

test("a route change fails the queued job instead of misdelivering it", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const { worker, calls } = workerFor(state, {
    route: { channel: "telegram", to: "different-target" },
  });
  await worker.runOnce();
  assert.equal(calls.model, 0);
  assert.equal(calls.send, 0);
  assert.equal(jobs(state)[0].status, "failed_terminal");
});

test("queue capacity fails closed without deleting active work", async () => {
  const state = stateFixture();
  const limited = transformFor(state, { maxActiveJobs: 1 });
  await limited(gmailEvent());
  await assert.rejects(
    () => limited(gmailEvent({ id: "message-2" })),
    /at capacity/,
  );
  assert.equal(jobs(state).length, 1);
  assert.equal(jobs(state)[0].status, "pending_process");
});

test("reusable SQLite pages do not permanently block new Gmail work", async () => {
  const state = stateFixture();
  await transformFor(state)(gmailEvent());
  const database = new DatabaseSync(state.databasePath);
  let maxDatabaseBytes;
  try {
    database.exec(`
      CREATE TABLE capacity_padding (payload BLOB);
      INSERT INTO capacity_padding (payload) VALUES (zeroblob(1048576));
      DELETE FROM capacity_padding;
    `);
    const pageCount = Number(
      database.prepare("PRAGMA page_count").get().page_count,
    );
    const freePages = Number(
      database.prepare("PRAGMA freelist_count").get().freelist_count,
    );
    const pageSize = Number(
      database.prepare("PRAGMA page_size").get().page_size,
    );
    assert.ok(freePages > 0);
    const liveBytes = (pageCount - freePages) * pageSize;
    maxDatabaseBytes = liveBytes + 64 * 1024;
    assert.ok(pageCount * pageSize > maxDatabaseBytes);
  } finally {
    database.close();
  }

  await transformFor(state, { maxDatabaseBytes })(
    gmailEvent({ id: "message-2" }),
  );
  assert.equal(jobs(state).length, 2);
});

test("cleanup never prunes active Gmail jobs", async () => {
  const state = stateFixture();
  await transformFor(state, { maxProcessedKeys: 1 })(gmailEvent());
  await transformFor(state, { maxProcessedKeys: 1 })(
    gmailEvent({ id: "message-2" }),
  );
  assert.equal(jobs(state).length, 2);
  assert.equal(messages(state).length, 2);
});

test("AlphaClaw retries Gmail IDs until the durable gateway accepts them", async () => {
  const installedRoot = fileURLToPath(
    new URL("../node_modules/@chrysb/alphaclaw/", import.meta.url),
  );
  const original = readFileSync(
    join(installedRoot, "lib/server/webhook-middleware.js"),
    "utf8",
  );
  const firstPatch = patchAlphaClawWebhookSource(original);
  assert.equal(firstPatch.changed, true);
  assert.equal(
    patchAlphaClawWebhookSource(firstPatch.source).changed,
    false,
  );
  assert.throws(
    () =>
      patchAlphaClawWebhookSource(
        original.replace(
          "gmailSeenMessageIds.set(dedupeKey, nowMs);",
          "gmailSeenMessageIds.delete(dedupeKey);",
        ),
      ),
    /patch drifted/,
  );

  const root = temporaryDirectory();
  const packageRoot = join(root, "alphaclaw");
  const middlewarePath = join(
    packageRoot,
    "lib/server/webhook-middleware.js",
  );
  mkdirSync(join(packageRoot, "lib/server/utils"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ version: "0.9.34" }),
  );
  writeFileSync(middlewarePath, original);
  writeFileSync(
    join(packageRoot, "lib/server/utils/network.js"),
    "exports.normalizeIp = (value) => String(value || '');\n",
  );
  assert.equal(patchInstalledAlphaClaw({ packageRoot }).changed, true);
  assert.equal(patchInstalledAlphaClaw({ packageRoot }).changed, false);

  const forwardedMessageCounts = [];
  let gatewayRequests = 0;
  const gateway = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      gatewayRequests += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      forwardedMessageCounts.push(body.payload.messages.length);
      res.statusCode = gatewayRequests === 1 ? 500 : 204;
      res.end(gatewayRequests === 1 ? "temporary failure" : "");
    });
  });
  const gatewayPort = await listen(gateway);
  const require = createRequire(import.meta.url);
  const { createWebhookMiddleware } = require(middlewarePath);
  const middleware = createWebhookMiddleware({
    gatewayUrl: "http://127.0.0.1:" + gatewayPort,
    insertRequest() {},
  });
  const proxy = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      req.body = Buffer.concat(chunks);
      req.originalUrl = req.url;
      req.path = String(req.url || "").split("?")[0];
      res.status = (status) => {
        res.statusCode = status;
        return res;
      };
      res.json = (body) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      middleware(req, res);
    });
  });
  const proxyPort = await listen(proxy);
  const event = gmailEvent();
  event.payload.messages.push({ ...event.payload.messages[0] });
  const body = JSON.stringify(event);
  const post = () =>
    fetch("http://127.0.0.1:" + proxyPort + "/hooks/gmail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  try {
    assert.equal((await post()).status, 500);
    assert.equal((await post()).status, 204);
    const deduped = await post();
    assert.equal(deduped.status, 200);
    assert.deepEqual(await deduped.json(), { ok: true, deduped: true });
    assert.equal(gatewayRequests, 2);
    assert.deepEqual(forwardedMessageCounts, [1, 1]);
  } finally {
    await closeServer(proxy);
    await closeServer(gateway);
  }
});

test("the compatible AlphaClaw commit is pinned to the live database schemas", () => {
  const dependency = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).dependencies["@chrysb/alphaclaw"];
  assert.equal(
    dependency,
    "https://github.com/chrysb/alphaclaw/archive/c3c9d023ba3c74a535a3cfb04e063f6c499554fa.tar.gz",
  );
  const alphaclawRoot = fileURLToPath(
    new URL("../node_modules/@chrysb/alphaclaw/", import.meta.url),
  );
  const alphaclawPackage = JSON.parse(
    readFileSync(join(alphaclawRoot, "package.json"), "utf8"),
  );
  const openclawPackage = JSON.parse(
    readFileSync(
      new URL("../node_modules/openclaw/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(alphaclawPackage.dependencies.openclaw, "2026.8.2");
  assert.deepEqual(openclawPackage.openclaw.schemaVersions, {
    state: 15,
    agent: 19,
  });
  const gatewaySource = readFileSync(
    join(alphaclawRoot, "lib/server/gateway.js"),
    "utf8",
  );
  assert.match(gatewaySource, /OPENCLAW_NO_AUTO_UPDATE:\s*"1"/);
  assert.match(gatewaySource, /OPENCLAW_SUPERVISOR_MODE:\s*"external"/);
});

test("config patch isolates Gmail, preserves main, and restricts the worker", () => {
  const original = baseConfig();
  const patched = patchOpenClawConfig(original, "/data/.openclaw");
  assert.deepEqual(original.agents.entries, {
    main: { default: true, tools: { profile: "full" } },
  });
  assert.deepEqual(original.agents.defaults.models, {
    "anthropic/claude-sonnet-5": { alias: "sonnet" },
  });

  const triage = patched.agents.entries["mail-triage"];
  assert.equal(triage.model.primary, "anthropic/claude-haiku-4-5");
  assert.equal(triage.contextInjection, "never");
  assert.deepEqual(triage.skills, []);
  assert.deepEqual(triage.memory, { search: { enabled: false } });
  assert.equal(Object.hasOwn(triage, "memorySearch"), false);
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
  assert.deepEqual(patched.hooks.mappings[0].transform, {
    module: "gmail/gmail-transform.mjs",
  });
  assert.deepEqual(patched.hooks.allowedAgentIds, ["main", "mail-triage"]);
  assert.deepEqual(patched.plugins.entries["gmail-triage-recovery"].llm, {
    allowAgentIdOverride: true,
    allowModelOverride: true,
    allowedModels: ["anthropic/claude-haiku-4-5"],
  });
  assert.deepEqual(patched.plugins.load.paths, [
    "/app/managed-plugins/gmail-triage-recovery.mjs",
  ]);
});

test("config patch preserves implicit main and an allow-any model setup", () => {
  const config = baseConfig();
  delete config.agents.entries;
  delete config.agents.defaults.models;

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.deepEqual(patched.agents.entries.main, { default: true });
  assert.equal(patched.agents.defaults.models, undefined);
  assert.ok(patched.agents.entries["mail-triage"]);
});

test("config patch removes the legacy triage memory key on upgrade", () => {
  const config = baseConfig();
  config.agents.entries["mail-triage"] = {
    memorySearch: { enabled: false },
  };

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  const triage = patched.agents.entries["mail-triage"];
  assert.equal(Object.hasOwn(triage, "memorySearch"), false);
  assert.deepEqual(triage.memory, { search: { enabled: false } });
});

test("config patch normalizes copied OpenClaw 2 compatibility fields", () => {
  const config = baseConfig();
  config.meta = {
    lastTouchedAt: "2026-08-31T00:00:00Z",
    lastTouchedVersion: "2026.7.1",
  };
  config.gateway = { tailscale: { mode: "off", resetOnExit: false } };

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.deepEqual(patched.meta, { lastTouchedVersion: "2026.7.1" });
  assert.deepEqual(patched.gateway.tailscale, { mode: "off" });
});

test("config patch lets entries win and safely deep-merges legacy memory search", () => {
  const config = baseConfig();
  config.agents.entries.main.memory = {
    search: { provider: "local", query: { minScore: 0.4 } },
  };
  config.agents.entries.main.memorySearch = {
    enabled: false,
    provider: "auto",
    inputType: "",
    query: {
      maxResults: 5,
      minScore: 0.1,
      hybrid: { enabled: true },
    },
    maxResults: 9,
    remote: {
      baseUrl: "https://embeddings.example.test",
      apiKey: {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
        unexpected: "drop-me",
      },
      headers: { Authorization: "Bearer token" },
      batch: { enabled: true, concurrency: 3 },
    },
    chunking: { tokens: 999 },
    sync: { watch: true },
    store: {
      path: "/legacy/memory.sqlite",
      driver: "sqlite",
      vector: { enabled: false, unexpected: true },
    },
    cache: { enabled: false, maxEntries: 10 },
  };
  config.agents.list = [
    { id: "main", name: "Stale main" },
    { id: "shadow", name: "Must not be resurrected" },
  ];

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.equal(Object.hasOwn(patched.agents, "list"), false);
  assert.equal(Object.hasOwn(patched.agents.entries, "shadow"), false);
  assert.equal(patched.agents.entries.main.name, undefined);
  assert.deepEqual(patched.agents.entries.main.memory.search, {
    provider: "local",
    query: { minScore: 0.4, maxResults: 5 },
    enabled: false,
    remote: {
      baseUrl: "https://embeddings.example.test",
      apiKey: {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      },
      headers: { Authorization: "Bearer token" },
      batch: { enabled: true },
    },
    store: { vector: { enabled: false } },
    cache: { enabled: false },
  });
  assert.equal(
    Object.hasOwn(patched.agents.entries.main, "memorySearch"),
    false,
  );
});

test("config patch migrates the legacy agent list to canonical entries", () => {
  const config = baseConfig();
  delete config.agents.entries;
  config.agents.list = [
    { id: "main", default: true, tools: { profile: "full" } },
    { id: "mail-triage", memorySearch: { enabled: false } },
  ];

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.equal(Object.hasOwn(patched.agents, "list"), false);
  assert.deepEqual(patched.agents.entries.main, {
    default: true,
    tools: { profile: "full" },
  });
  assert.deepEqual(patched.agents.entries["mail-triage"].memory, {
    search: { enabled: false },
  });
});

test("config patch retains an unused Voyage profile without enabling its plugin", () => {
  const config = baseConfig();
  config.auth = {
    profiles: {
      "voyage:default": { provider: "voyage", mode: "api_key" },
    },
  };

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.deepEqual(patched.auth.profiles["voyage:default"], {
    provider: "voyage",
    mode: "api_key",
  });
  assert.deepEqual(patched.plugins.entries.voyage, { enabled: false });
});

test("config patch does not disable Voyage when memory explicitly selects it", () => {
  const config = baseConfig();
  config.auth = {
    profiles: {
      "voyage:default": { provider: "voyage", mode: "api_key" },
    },
  };
  config.memory = { search: { provider: "voyage" } };

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.equal(Object.hasOwn(patched.plugins.entries, "voyage"), false);
});

test("config patch preserves an explicit Voyage plugin choice", () => {
  const config = baseConfig();
  config.auth = {
    profiles: {
      "voyage:default": { provider: "voyage", mode: "api_key" },
    },
  };
  config.plugins = { entries: {} };
  config.plugins.entries.voyage = { enabled: true };

  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.deepEqual(patched.plugins.entries.voyage, { enabled: true });
});

test("an existing plugin allowlist is extended without replacement", () => {
  const config = baseConfig();
  config.plugins = { allow: ["existing-plugin"] };
  const patched = patchOpenClawConfig(config, "/data/.openclaw");
  assert.deepEqual(patched.plugins.allow, [
    "existing-plugin",
    "gmail-triage-recovery",
  ]);
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

  assert.equal((await applyManagedRuntime(options)).status, "updated");
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(stateDir, "runtime/gmail-delivery.json"), "utf8"),
    ),
    ROUTE,
  );
  const managedTransformPath = join(
    stateDir,
    "hooks/transforms/gmail/gmail-triage-v1.mjs",
  );
  const alphaclawTransformPath = join(
    stateDir,
    "hooks/transforms/gmail/gmail-transform.mjs",
  );
  assert.doesNotMatch(readFileSync(managedTransformPath, "utf8"), /private-target/);
  assert.equal(
    readFileSync(alphaclawTransformPath, "utf8"),
    readFileSync(managedTransformPath, "utf8"),
  );
  const excludes = readFileSync(join(stateDir, ".git/info/exclude"), "utf8");
  assert.match(excludes, /runtime\/gmail-delivery\.json/);
  assert.match(excludes, /runtime\/gmail-triage\.sqlite\*/);
  assert.match(excludes, /runtime\/gmail-triage\.key\*/);
  assert.equal((await applyManagedRuntime(options)).status, "unchanged");
  assert.equal(validations, 2);
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.plugins.entries["gmail-triage-recovery"].enabled, true);
  assert.ok(saved.agents.entries["mail-triage"]);
});

test("the canonical transform and recovery plugin survive AlphaClaw renewal", async () => {
  const { stateDir, configPath } = writeRuntimeFixture();
  await applyManagedRuntime({ stateDir, validateConfig: async () => true });

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
  const state = stateFixture();
  const result = await canonical.createGmailTransform({
    route: ROUTE,
    databasePath: state.databasePath,
    keyPath: state.keyPath,
  })(gmailEvent());
  assert.equal(result, null);
  assert.equal(jobs(state)[0].status, "pending_process");
  assert.equal(
    renewed.plugins.entries["gmail-triage-recovery"].enabled,
    true,
  );
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

test("compatibility normalization runs before a missing-route early return", async () => {
  const { stateDir, configPath } = writeRuntimeFixture({
    routeInTransform: false,
  });
  const original = JSON.parse(readFileSync(configPath, "utf8"));
  original.meta = {
    lastTouchedAt: "2026-09-06T00:00:00Z",
    lastTouchedVersion: "2026.7.1",
  };
  original.gateway = {
    tailscale: { mode: "off", resetOnExit: false },
  };
  original.agents.entries.main.memorySearch = {
    enabled: true,
    maxResults: 7,
    chunking: { tokens: 256 },
  };
  original.agents.list = [{ id: "shadow", default: true }];
  const originalText = `${JSON.stringify(original, null, 2)}\n`;
  writeFileSync(configPath, originalText);

  const result = await applyManagedRuntime({
    stateDir,
    validateConfig: async () => true,
  });
  assert.equal(result.status, "updated");
  assert.equal(result.compatibilityUpdated, true);
  assert.equal(result.reason, "Gmail delivery is not configured yet");
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.meta, { lastTouchedVersion: "2026.7.1" });
  assert.deepEqual(saved.gateway.tailscale, { mode: "off" });
  assert.equal(Object.hasOwn(saved.agents, "list"), false);
  assert.equal(Object.hasOwn(saved.agents.entries, "shadow"), false);
  assert.deepEqual(saved.agents.entries.main.memory.search, {
    enabled: true,
    query: { maxResults: 7 },
  });
  assert.equal(saved.agents.entries["mail-triage"], undefined);
  assert.equal(
    readFileSync(
      join(stateDir, "backups/pre-openclaw-2026.8.2-config.json"),
      "utf8",
    ),
    originalText,
  );
  assert.equal(
    existsSync(join(stateDir, "backups/pre-gmail-cost-fix-v1.json")),
    false,
  );
  assert.match(
    readFileSync(join(stateDir, ".git/info/exclude"), "utf8"),
    /backups\/pre-openclaw-2026\.8\.2-config\.json\*/,
  );
});

test("compatibility normalization runs even without a Gmail mapping", async () => {
  const { stateDir, configPath } = writeRuntimeFixture();
  const original = JSON.parse(readFileSync(configPath, "utf8"));
  delete original.hooks.mappings;
  original.meta = { lastTouchedAt: "2026-09-06T00:00:00Z" };
  writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`);

  const result = await applyManagedRuntime({
    stateDir,
    validateConfig: async () => true,
  });
  assert.deepEqual(result, {
    status: "updated",
    gmailManaged: false,
    compatibilityUpdated: true,
  });
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.meta, {});
  assert.equal(saved.agents.entries["mail-triage"], undefined);
  assert.equal(
    existsSync(join(stateDir, "backups/pre-openclaw-2026.8.2-config.json")),
    true,
  );
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
    existsSync(join(stateDir, "hooks/transforms/gmail/gmail-triage-v1.mjs")),
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
  assert.equal(saved.plugins.entries["gmail-triage-recovery"].enabled, true);
});

test("OpenClaw runtime inspection loads the standalone recovery service", () => {
  const stateDir = temporaryDirectory();
  const pluginPath = fileURLToPath(
    new URL("../managed-plugins/gmail-triage-recovery.mjs", import.meta.url),
  );
  const configPath = join(stateDir, "openclaw.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        plugins: {
          load: { paths: [pluginPath] },
          entries: { "gmail-triage-recovery": { enabled: true } },
        },
      },
      null,
      2,
    )}\n`,
  );
  const cliPath = fileURLToPath(
    new URL("../openclaw.mjs", import.meta.resolve("openclaw")),
  );
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "plugins",
      "inspect",
      "gmail-triage-recovery",
      "--runtime",
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const inspected = JSON.parse(result.stdout);
  assert.equal(inspected.plugin?.id, "gmail-triage-recovery");
  assert.equal(inspected.plugin?.enabled, true);
  assert.equal(inspected.plugin?.status, "loaded");
  assert.ok(inspected.services?.includes("gmail-triage-recovery"));
});

test("a real OpenClaw gateway starts the recovery worker", async () => {
  const stateDir = temporaryDirectory();
  const workspaceDir = join(stateDir, "workspace");
  const pluginPath = fileURLToPath(
    new URL("../managed-plugins/gmail-triage-recovery.mjs", import.meta.url),
  );
  const configPath = join(stateDir, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "none" },
        },
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          load: { paths: [pluginPath] },
          allow: ["gmail-triage-recovery"],
          entries: {
            "gmail-triage-recovery": {
              enabled: true,
              llm: {
                allowAgentIdOverride: true,
                allowModelOverride: true,
                allowedModels: ["anthropic/claude-haiku-4-5"],
              },
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const cliPath = fileURLToPath(
    new URL("../openclaw.mjs", import.meta.resolve("openclaw")),
  );
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--auth",
      "none",
    ],
    {
      cwd: stateDir,
      env: {
        ...process.env,
        HOME: stateDir,
        OPENCLAW_HOME: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const output = await waitForOutput(child, /\[gateway\] ready/);
    assert.match(output, /\d+ plugins?: [^\n]*gmail-triage-recovery/);
    assert.equal(
      existsSync(join(stateDir, "runtime/gmail-triage.sqlite")),
      true,
    );
    assert.equal(
      existsSync(join(stateDir, "runtime/gmail-triage.key")),
      true,
    );
  } finally {
    await stopChild(child);
  }
});

test("the container image includes the recovery plugin", () => {
  const dockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, /COPY managed-plugins \.\/managed-plugins/);
  assert.ok(
    dockerfile.indexOf("RUN npm ci") <
      dockerfile.indexOf("COPY runtime ./runtime"),
  );
  assert.ok(
    dockerfile.indexOf("COPY runtime ./runtime") <
      dockerfile.indexOf(
        "RUN node ./runtime/patch-alphaclaw-webhook-dedupe.mjs",
      ),
  );
  assert.equal(
    JSON.parse(
      readFileSync(
        new URL("../managed-plugins/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    ).activation.onStartup,
    true,
  );
});
