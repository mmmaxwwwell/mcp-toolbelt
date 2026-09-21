import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ArgSchema, Operation, Registry } from "./registry.js";
import { buildBwrapArgv, type BuiltBwrap } from "./sandbox.js";

export class ValidationError extends Error {}
export class ExecError extends Error {}

const DEFAULT_DENY_RE = /[&|;<>`$()\\'"\s]/;

export interface ExpandedCommand {
  argv: string[];
  fullArgv: string[];
}

export interface SandboxMetadata {
  mode: "bwrap" | "off";
  preset?: "dev" | "strict" | "install";
  network?: boolean;
  warning?: string;
  bwrap_argv?: string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  timed_out: boolean;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
  expanded_command: string[];
  sandbox: SandboxMetadata;
}

function coerceInt(name: string, raw: unknown): string {
  if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) return raw;
  throw new ValidationError(`Arg '${name}': expected int, got ${JSON.stringify(raw)}.`);
}

function simpleGlobMatch(pattern: string, target: string): boolean {
  // Minimal glob support: * matches any chars except '/', ** matches any incl '/'.
  const re =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "::DOUBLESTAR::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DOUBLESTAR::/g, ".*")
      .replace(/\?/g, "[^/]") +
    "$";
  return new RegExp(re).test(target);
}

function validateArg(
  argName: string,
  schema: ArgSchema,
  raw: unknown,
  projectRoot: string
): string {
  let value: string;

  const provided = raw !== undefined && raw !== null && raw !== "";
  if (!provided) {
    if (schema.default !== undefined) {
      value = String(schema.default);
    } else if (schema.type === "string" || schema.type === "path") {
      value = "";
    } else {
      throw new ValidationError(`Arg '${argName}' is required.`);
    }
  } else {
    switch (schema.type) {
      case "string":
      case "path":
        if (typeof raw !== "string") {
          throw new ValidationError(
            `Arg '${argName}': expected string, got ${JSON.stringify(raw)}.`
          );
        }
        value = raw;
        break;
      case "int":
        value = coerceInt(argName, raw);
        break;
      case "enum":
        if (typeof raw !== "string" && typeof raw !== "number") {
          throw new ValidationError(
            `Arg '${argName}': enum expects string, got ${JSON.stringify(raw)}.`
          );
        }
        value = String(raw);
        break;
    }
  }

  if (schema.type === "enum") {
    if (!schema.values!.includes(value)) {
      throw new ValidationError(
        `Arg '${argName}': '${value}' not in allowed values [${schema.values!.join(", ")}].`
      );
    }
    return value;
  }

  if (value === "" && schema.default === "") return "";

  if (schema.validate) {
    let re: RegExp;
    try {
      re = new RegExp(schema.validate);
    } catch (err) {
      throw new ValidationError(
        `Arg '${argName}': invalid validate regex: ${(err as Error).message}`
      );
    }
    if (!re.test(value)) {
      throw new ValidationError(
        `Arg '${argName}': value '${value}' does not match /${schema.validate}/.`
      );
    }
  } else if (schema.type === "string" || schema.type === "path") {
    if (value !== "" && DEFAULT_DENY_RE.test(value)) {
      throw new ValidationError(
        `Arg '${argName}': value contains disallowed character (no validate regex defined, using default deny list).`
      );
    }
  }

  if (schema.type === "path" && value !== "") {
    const absolute = isAbsolute(value) ? value : resolve(projectRoot, value);
    if (schema.must_exist && !existsSync(absolute)) {
      throw new ValidationError(
        `Arg '${argName}': path '${value}' does not exist.`
      );
    }
    if (schema.must_match && !simpleGlobMatch(schema.must_match, value)) {
      throw new ValidationError(
        `Arg '${argName}': path '${value}' does not match glob '${schema.must_match}'.`
      );
    }
  }

  return value;
}

// Shell-safety guarantee: the command template is parsed as a whitespace-split
// argv list at load time. Each {placeholder} occupies its own argv slot; we
// substitute the validated string value 1:1 into that slot with no
// concatenation, quoting, or shell interpretation. The final argv is passed to
// spawn() with shell:false — the OS never sees a shell string.
export function expandTemplate(
  op: Operation,
  args: Record<string, unknown>
): ExpandedCommand {
  const argv: string[] = [];
  for (const tok of op.argv) {
    const m = tok.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
    if (m) {
      const argName = m[1];
      const schema = op.args[argName];
      const raw = args[argName];
      const value = validateArg(argName, schema, raw, op.cwd);
      argv.push(value);
    } else {
      argv.push(tok);
    }
  }
  const fullArgv = ["develop", "-c", ...argv];
  return { argv, fullArgv };
}

/**
 * Build the bwrap wrapper prefix for an operation, or null if sandbox is off.
 * Exposed so tools like dry_run + describe_sandbox can preview it.
 */
export function buildSandboxPrefix(
  op: Operation,
  projectRoot: string
): BuiltBwrap | null {
  if (op.sandbox.mode === "off") return null;
  return buildBwrapArgv({
    preset: op.sandbox.preset!,
    projectRoot,
    opCwd: op.cwd,
    extraRw: op.sandbox.extraRw ?? [],
    extraRo: op.sandbox.extraRo ?? [],
  });
}

export async function runOperation(
  op: Operation,
  args: Record<string, unknown>,
  registry: Registry
): Promise<ExecResult> {
  if (op.interactive) {
    throw new ExecError(
      `Operation '${op.name}' is marked interactive; MCP cannot handle interactive I/O. Run it manually or use the non-interactive variant.`
    );
  }
  const { fullArgv, argv } = expandTemplate(op, args);
  const started = Date.now();

  // Decide sandboxing.
  let spawnBin: string;
  let spawnArgs: string[];
  let sandboxMeta: SandboxMetadata;
  if (op.sandbox.mode === "off") {
    const warning =
      `Operation '${op.name}' is running WITHOUT sandbox (sandbox = "off"). ` +
      `This bypasses filesystem/network isolation. Only allow via reviewed registry changes.`;
    process.stderr.write(`nix-dev-exec WARNING: ${warning}\n`);
    spawnBin = "nix";
    spawnArgs = fullArgv;
    sandboxMeta = { mode: "off", warning };
  } else {
    const built = buildBwrapArgv({
      preset: op.sandbox.preset!,
      projectRoot: registry.projectRoot,
      opCwd: op.cwd,
      extraRw: op.sandbox.extraRw ?? [],
      extraRo: op.sandbox.extraRo ?? [],
    });
    spawnBin = "bwrap";
    // The `--` separator prevents bwrap from parsing later flags.
    spawnArgs = [...built.argv, "--", "nix", ...fullArgv];
    sandboxMeta = {
      mode: "bwrap",
      preset: built.preset,
      network: built.network,
      bwrap_argv: built.argv,
    };
  }

  return new Promise<ExecResult>((resolvePromise) => {
    let child;
    try {
      child = spawn(spawnBin, spawnArgs, {
        cwd: op.cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({
        stdout: "",
        stderr: `Failed to spawn ${spawnBin}: ${(err as Error).message}`,
        exit_code: null,
        signal: null,
        duration_ms: Date.now() - started,
        timed_out: false,
        truncated_stdout: false,
        truncated_stderr: false,
        expanded_command: argv,
        sandbox: sandboxMeta,
      });
      return;
    }

    const cap = op.max_output_bytes;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncStdout = false;
    let truncStderr = false;
    let timedOut = false;

    const collect = (
      chunks: Buffer[],
      bytesRef: { n: number },
      truncRef: { v: boolean }
    ) => (data: Buffer) => {
      if (truncRef.v) return;
      if (bytesRef.n + data.length > cap) {
        const remaining = cap - bytesRef.n;
        if (remaining > 0) chunks.push(data.subarray(0, remaining));
        bytesRef.n = cap;
        truncRef.v = true;
      } else {
        chunks.push(data);
        bytesRef.n += data.length;
      }
    };

    const stdoutRef = { n: 0 };
    const stderrRef = { n: 0 };
    const truncStdoutRef = { v: false };
    const truncStderrRef = { v: false };

    child.stdout!.on(
      "data",
      collect(stdoutChunks, stdoutRef, truncStdoutRef)
    );
    child.stderr!.on(
      "data",
      collect(stderrChunks, stderrRef, truncStderrRef)
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, op.timeout_ms);

    child.on("error", (err) => {
      clearTimeout(timer);
      const errno = (err as NodeJS.ErrnoException).code;
      let msg: string;
      if (errno === "ENOENT") {
        msg =
          spawnBin === "bwrap"
            ? `bwrap binary not found on PATH. The sandbox requires bubblewrap; install it (nix: pkgs.bubblewrap).`
            : `nix binary not found on PATH. Install nix or wrap the server with nix on PATH.`;
      } else {
        msg = `spawn error: ${err.message}`;
      }
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr:
          (Buffer.concat(stderrChunks).toString("utf8") +
            (stderrChunks.length ? "\n" : "") +
            msg),
        exit_code: null,
        signal: null,
        duration_ms: Date.now() - started,
        timed_out: false,
        truncated_stdout: truncStdoutRef.v,
        truncated_stderr: truncStderrRef.v,
        expanded_command: argv,
        sandbox: sandboxMeta,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (truncStdoutRef.v) stdout += "\n[...truncated]";
      if (truncStderrRef.v) stderr += "\n[...truncated]";
      if (timedOut) {
        stderr +=
          (stderr.length ? "\n" : "") +
          `[operation timed out after ${op.timeout_ms} ms]`;
      }
      // Surface classic unprivileged-userns failure loudly.
      if (
        spawnBin === "bwrap" &&
        code !== 0 &&
        /setting up uid map|clone.*Operation not permitted|user namespaces/i.test(stderr)
      ) {
        stderr +=
          (stderr.length ? "\n" : "") +
          `[bwrap sandbox failed: this kernel may not allow unprivileged user namespaces. ` +
          `On Debian/Ubuntu: 'sudo sysctl kernel.unprivileged_userns_clone=1'. ` +
          `On NixOS: 'security.unprivilegedUsernsClone = true;'.]`;
      }
      resolvePromise({
        stdout,
        stderr,
        exit_code: code,
        signal: signal ? String(signal) : null,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
        truncated_stdout: truncStdoutRef.v,
        truncated_stderr: truncStderrRef.v,
        expanded_command: argv,
        sandbox: sandboxMeta,
      });
    });
  });
}
