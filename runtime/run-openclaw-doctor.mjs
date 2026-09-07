import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_OPENCLAW_VERSION = "2026.8.2";

function installedOpenClaw() {
  const entryPath = fileURLToPath(import.meta.resolve("openclaw"));
  const packageRoot = dirname(dirname(entryPath));
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  return {
    cliPath: join(packageRoot, "openclaw.mjs"),
    version: packageJson.version,
  };
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

export function doctorMarkerPath(stateDir, version) {
  return join(stateDir, "runtime", `openclaw-doctor-${version}.json`);
}

export function runOpenClawDoctor(options = {}) {
  const stateDir = resolve(
    options.stateDir || process.env.OPENCLAW_STATE_DIR || "/data/.openclaw",
  );
  const configPath = resolve(
    options.configPath ||
      process.env.OPENCLAW_CONFIG_PATH ||
      join(stateDir, "openclaw.json"),
  );
  if (!existsSync(configPath)) {
    return { status: "skipped", reason: "OpenClaw is not configured yet" };
  }

  const installed = options.installedOpenClaw || installedOpenClaw();
  if (installed.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(
      `Unsupported OpenClaw version ${installed.version || "unknown"}; expected ${SUPPORTED_OPENCLAW_VERSION}`,
    );
  }

  const markerPath =
    options.markerPath || doctorMarkerPath(stateDir, installed.version);
  if (existsSync(markerPath)) {
    return { status: "unchanged", version: installed.version };
  }

  const run = options.runDoctor || ((command, args, spawnOptions) =>
    spawnSync(command, args, spawnOptions));
  const result = run(
    process.execPath,
    [installed.cliPath, "doctor", "--fix", "--non-interactive"],
    {
      encoding: "utf8",
      timeout: options.timeoutMs || 180_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result?.error) {
    throw new Error(`OpenClaw repair could not run (${result.error.code || "error"})`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `OpenClaw repair failed (exit ${result?.status ?? "unknown"})`,
    );
  }

  atomicWrite(
    markerPath,
    `${JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        version: installed.version,
      },
      null,
      2,
    )}\n`,
  );
  return { status: "updated", version: installed.version };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runOpenClawDoctor();
  const suffix = result.reason ? ` (${result.reason})` : "";
  console.log(`OpenClaw repair: ${result.status}${suffix}`);
}
