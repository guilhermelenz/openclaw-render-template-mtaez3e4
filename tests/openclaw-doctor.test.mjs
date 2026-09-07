import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  doctorMarkerPath,
  runOpenClawDoctor,
} from "../runtime/run-openclaw-doctor.mjs";

const INSTALLED = {
  cliPath: "/app/node_modules/openclaw/openclaw.mjs",
  version: "2026.8.2",
};

function stateFixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-doctor-test-"));
  writeFileSync(join(stateDir, "openclaw.json"), "{}\n", { mode: 0o600 });
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test("doctor runs once with explicit state paths and records success", (t) => {
  const stateDir = stateFixture(t);
  let invocation;
  const first = runOpenClawDoctor({
    stateDir,
    installedOpenClaw: INSTALLED,
    runDoctor(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: "sensitive output is not persisted" };
    },
  });

  assert.equal(first.status, "updated");
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    INSTALLED.cliPath,
    "doctor",
    "--fix",
    "--non-interactive",
  ]);
  assert.equal(invocation.options.env.OPENCLAW_STATE_DIR, stateDir);
  assert.equal(
    invocation.options.env.OPENCLAW_CONFIG_PATH,
    join(stateDir, "openclaw.json"),
  );
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);

  const markerPath = doctorMarkerPath(stateDir, INSTALLED.version);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(marker.version, INSTALLED.version);
  assert.equal(existsSync(markerPath), true);

  const second = runOpenClawDoctor({
    stateDir,
    installedOpenClaw: INSTALLED,
    runDoctor() {
      throw new Error("doctor must not run twice");
    },
  });
  assert.equal(second.status, "unchanged");
});

test("doctor failure does not create a completion marker", (t) => {
  const stateDir = stateFixture(t);
  assert.throws(
    () =>
      runOpenClawDoctor({
        stateDir,
        installedOpenClaw: INSTALLED,
        runDoctor: () => ({ status: 1, stderr: "secret-shaped output" }),
      }),
    /repair failed \(exit 1\)/,
  );
  assert.equal(
    existsSync(doctorMarkerPath(stateDir, INSTALLED.version)),
    false,
  );
});

test("doctor skips an unconfigured state directory", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-doctor-empty-"));
  mkdirSync(join(stateDir, "runtime"), { recursive: true });
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  assert.deepEqual(
    runOpenClawDoctor({ stateDir, installedOpenClaw: INSTALLED }),
    { status: "skipped", reason: "OpenClaw is not configured yet" },
  );
});

test("doctor refuses an unreviewed OpenClaw version", (t) => {
  const stateDir = stateFixture(t);
  assert.throws(
    () =>
      runOpenClawDoctor({
        stateDir,
        installedOpenClaw: { ...INSTALLED, version: "2026.8.3" },
        runDoctor: () => ({ status: 0 }),
      }),
    /Unsupported OpenClaw version 2026\.8\.3/,
  );
});
