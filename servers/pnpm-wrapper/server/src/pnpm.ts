import { spawn } from "node:child_process";

export interface PnpmResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
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

export async function runPnpm(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number } = {}
): Promise<PnpmResult> {
  const guard = guardArgs(args);
  if (guard) {
    return {
      code: -1,
      stdout: "",
      stderr: guard.error,
      timedOut: false,
      truncated: false,
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await new Promise<PnpmResult>((resolve) => {
    const child = spawn("pnpm", args, {
      cwd,
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
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        truncated,
      });
    });
  });
}
