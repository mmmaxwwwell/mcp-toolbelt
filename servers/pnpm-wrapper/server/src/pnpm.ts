import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import {
  buildBwrapArgv,
  interpretBwrapError,
  type SandboxDecision,
  type SandboxPreset,
} from "./sandbox.js";

export interface PnpmResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  sandbox: SandboxDecision;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 512 * 1024;

// Hardcoded refusals — applied to argv before invoking pnpm. These are non-negotiable.
const BANNED_ARGS_EXACT = new Set(["--global", "-g", "dlx", "exec"]);
const BANNED_ARG_PREFIXES = ["--registry="];

export interface GuardError {
  ok: false;
  error: string;
}

export function guardArgs(args: string[]): GuardError | null {
  for (const a of args) {
    if (BANNED_ARGS_EXACT.has(a)) {
      return { ok: false, error: `Refused argument: "${a}"` };
    }
    for (const p of BANNED_ARG_PREFIXES) {
      if (a.startsWith(p)) {
        return { ok: false, error: `Refused argument prefix: "${a}"` };
      }
    }
  }
  return null;
}

// Package specifier guard — reject non-registry sources.
export function guardPackageSpec(spec: string): GuardError | null {
  if (
    spec.startsWith("git+") ||
    spec.startsWith("file:") ||
    spec.startsWith("http:") ||
    spec.startsWith("https:")
  ) {
    return {
      ok: false,
      error: `Refused package specifier "${spec}": only registry packages are allowed`,
    };
  }
  return null;
}

// Sandbox spec passed by callers. `preset === undefined` and `disabled` mean
// the caller has decided (via policy.effectiveSandbox) that this verb is
// exempt from the sandbox. Every non-exempt call runs inside bwrap.
export interface RunSandbox {
  disabled: false;
  preset: SandboxPreset;
  projectRoot: string;
  extraRw: string[];
  extraRo: string[];
}

export interface RunSandboxOff {
  disabled: true;
  reason: string;
  projectRoot: string;
}

export type RunSandboxInput = RunSandbox | RunSandboxOff;

export interface RunOpts {
  timeoutMs?: number;
}

export async function runPnpm(
  args: string[],
  sandbox: RunSandboxInput,
  opts: RunOpts = {}
): Promise<PnpmResult> {
  const guard = guardArgs(args);
  if (guard) {
    return {
      code: -1,
      stdout: "",
      stderr: guard.error,
      timedOut: false,
      truncated: false,
      sandbox: sandbox.disabled
        ? { mode: "off", reason: sandbox.reason }
        : {
            mode: "bwrap",
            preset: sandbox.preset,
            network: presetHasNetwork(sandbox.preset),
            projectRoot: sandbox.projectRoot,
            home: homedir(),
            user: userInfo().username,
            extraRw: sandbox.extraRw,
            extraRo: sandbox.extraRo,
          },
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sandboxDecision: SandboxDecision = sandbox.disabled
    ? { mode: "off", reason: sandbox.reason }
    : {
        mode: "bwrap",
        preset: sandbox.preset,
        network: presetHasNetwork(sandbox.preset),
        projectRoot: sandbox.projectRoot,
        home: homedir(),
        user: userInfo().username,
        extraRw: sandbox.extraRw,
        extraRo: sandbox.extraRo,
      };

  const { command, spawnArgs } = buildSpawn(args, sandbox);

  return await new Promise<PnpmResult>((resolve) => {
    const child = spawn(command, spawnArgs, {
      cwd: sandbox.projectRoot,
      shell: false,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      } else {
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) {
        stderr += chunk.toString("utf8");
      } else {
        truncated = true;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        timedOut,
        truncated,
        sandbox: sandboxDecision,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // Diagnose known bwrap failures (e.g. unprivileged userns disabled).
      const hint = interpretBwrapError(stderr);
      if (hint) {
        stderr = `${stderr}\n\n[pnpm-wrapper diagnosis] ${hint}`;
      }
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        truncated,
        sandbox: sandboxDecision,
      });
    });
  });
}

function buildSpawn(
  pnpmArgs: string[],
  sandbox: RunSandboxInput
): { command: string; spawnArgs: string[] } {
  if (sandbox.disabled) {
    return { command: "pnpm", spawnArgs: pnpmArgs };
  }
  const bwrapArgv = buildBwrapArgv({
    preset: sandbox.preset,
    projectRoot: sandbox.projectRoot,
    extraRw: sandbox.extraRw,
    extraRo: sandbox.extraRo,
  });
  // The `--` separator is required — it tells bwrap "argv after this is
  // the command to run". Without it bwrap would parse `pnpm` as a flag.
  return {
    command: "bwrap",
    spawnArgs: [...bwrapArgv, "--", "pnpm", ...pnpmArgs],
  };
}

function presetHasNetwork(preset: SandboxPreset): boolean {
  return preset === "install" || preset === "script";
}
