import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  claimNextGmailJob,
  completeGmailDelivery,
  completeGmailProcessing,
  DEFAULT_STATE_DATABASE_PATH,
  DEFAULT_STATE_KEY_PATH,
  failGmailJob,
  fingerprintGmailRoute,
  loadGmailDelivery,
  markGmailDeliveryDispatched,
  TRIAGE_AGENT_ID,
  TRIAGE_MODEL,
} from "../managed-hooks/gmail/gmail-transform.mjs";

const DEFAULT_POLL_INTERVAL_MS = 5_000;

function classifyError(error) {
  const code =
    typeof error?.code === "string" && error.code.trim()
      ? error.code.trim()
      : "";
  const name =
    typeof error?.name === "string" && error.name.trim()
      ? error.name.trim()
      : "Error";
  return `${name}:${code || "unknown"}`.slice(0, 120);
}

function isPermanentPreSendError(error) {
  const message = String(error?.message || error || "");
  return /unsupported channel|unknown channel|not configured|invalid target/i.test(
    message,
  );
}

export function createGmailTriageWorker(options) {
  const {
    runtime,
    logger = console,
    databasePath = DEFAULT_STATE_DATABASE_PATH,
    keyPath = DEFAULT_STATE_KEY_PATH,
    deliveryPath,
    route: fixedRoute,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    clock = Date.now,
  } = options;
  let active = false;
  let stopped = true;
  let timer;
  let abortController;

  const currentRoute = () => fixedRoute || loadGmailDelivery(deliveryPath);

  async function fail(claim, error, extra = {}) {
    const outcome = await failGmailJob({
      databasePath,
      jobId: claim.jobId,
      token: claim.token,
      stage: claim.stage,
      errorClass: classifyError(error),
      now: clock(),
      ...extra,
    });
    const log = outcome.outcome === "ambiguous_delivery" ? "warn" : "info";
    logger[log]?.(`Gmail triage ${outcome.outcome}`, {
      jobId: claim.jobId,
      stage: claim.stage,
      attempts: claim.attempts,
    });
    return outcome;
  }

  async function processClaim(claim) {
    let route;
    try {
      route = currentRoute();
    } catch (error) {
      return fail(claim, error, { retryable: true });
    }
    if (fingerprintGmailRoute(route, keyPath) !== claim.routeFingerprint) {
      return fail(claim, new Error("Gmail delivery route changed"), {
        retryable: false,
      });
    }

    if (claim.stage === "processing") {
      try {
        const result = await runtime.llm.complete({
          messages: [{ role: "user", content: claim.text }],
          model: TRIAGE_MODEL,
          maxTokens: 512,
          temperature: 0,
          purpose: "gmail.triage",
          agentId: TRIAGE_AGENT_ID,
          signal: abortController?.signal,
        });
        return await completeGmailProcessing({
          databasePath,
          keyPath,
          jobId: claim.jobId,
          token: claim.token,
          output: result?.text,
          now: clock(),
        });
      } catch (error) {
        return fail(claim, error, { retryable: true });
      }
    }

    let dispatched = false;
    try {
      const adapter = await runtime.channel.outbound.loadAdapter(route.channel);
      if (!adapter?.sendText) {
        throw new Error(`Unsupported channel: ${route.channel}`);
      }
      // Telegram has no unknown-send reconciliation. Persist the uncertainty
      // boundary before handing the alert to the adapter; any later error is
      // quarantined instead of blindly resent.
      await markGmailDeliveryDispatched({
        databasePath,
        jobId: claim.jobId,
        token: claim.token,
        now: clock(),
      });
      dispatched = true;
      const result = await adapter.sendText({
        cfg: runtime.config.current(),
        to: route.to,
        text: claim.text,
      });
      if (!result?.messageId) {
        throw new Error("Delivery returned no message receipt");
      }
      return await completeGmailDelivery({
        databasePath,
        jobId: claim.jobId,
        token: claim.token,
        receiptId: result.messageId,
        now: clock(),
      });
    } catch (error) {
      return fail(claim, error, {
        dispatched,
        retryable: !isPermanentPreSendError(error),
      });
    }
  }

  async function runOnce() {
    if (active) return { worked: false, reason: "busy" };
    active = true;
    abortController = new AbortController();
    try {
      const claim = await claimNextGmailJob({
        databasePath,
        keyPath,
        now: clock(),
      });
      if (!claim) return { worked: false, reason: "empty" };
      const outcome = await processClaim(claim);
      return { worked: true, claim, outcome };
    } finally {
      abortController = undefined;
      active = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    const tick = () => {
      if (stopped) return;
      void runOnce().catch((error) => {
        logger.error?.("Gmail triage worker failed", {
          error: classifyError(error),
        });
      });
    };
    tick();
    timer = setInterval(tick, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    abortController?.abort(new Error("Gmail triage worker stopped"));
  }

  return { runOnce, start, stop };
}

export default definePluginEntry({
  id: "gmail-triage-recovery",
  name: "Gmail triage recovery",
  description: "Durable bounded Gmail triage and delivery",
  register(api) {
    let worker;
    api.registerService({
      id: "gmail-triage-recovery",
      start(ctx) {
        worker = createGmailTriageWorker({
          runtime: api.runtime,
          logger: ctx.logger,
          databasePath: `${ctx.stateDir}/runtime/gmail-triage.sqlite`,
          keyPath: `${ctx.stateDir}/runtime/gmail-triage.key`,
          deliveryPath: `${ctx.stateDir}/runtime/gmail-delivery.json`,
        });
        worker.start();
      },
      stop() {
        worker?.stop();
        worker = undefined;
      },
    });
  },
});
