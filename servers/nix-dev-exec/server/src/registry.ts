import { readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import TOML from "@iarna/toml";
import {
  DEFAULT_GLOBAL_SANDBOX,
  type GlobalSandboxDefaults,
  type SandboxPreset,
  type SandboxSpec,
} from "./sandbox.js";

export type ArgType = "string" | "int" | "path" | "enum";

export interface ArgSchema {
  type: ArgType;
  default?: string | number;
  validate?: string;
  must_exist?: boolean;
  must_match?: string;
  values?: string[];
  description?: string;
}

export interface Operation {
  name: string;
  description: string;
  command: string;
  argv: string[];
  args: Record<string, ArgSchema>;
  interactive: boolean;
  timeout_ms: number;
  max_output_bytes: number;
  cwd: string;
  sandbox: SandboxSpec;
}

export interface Registry {
  path: string;
  projectRoot: string;
  sandboxDefaults: GlobalSandboxDefaults;
  operations: Map<string, Operation>;
}

const VALID_PRESETS: readonly SandboxPreset[] = ["dev", "strict", "install"];

export class RegistryError extends Error {}

const SHELL_META_RE = /[&|;<>`$()\\]/;
const SHELL_META_SUBSTRINGS = ["&&", "||", "$(", "`", ";", "|", ">", "<"];

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

function splitArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter((s) => s.length > 0);
}

function assertTemplateSafe(name: string, command: string): void {
  for (const sub of SHELL_META_SUBSTRINGS) {
    if (command.includes(sub)) {
      throw new RegistryError(
        `Operation '${name}': command template contains shell metacharacter '${sub}'. ` +
          `Templates are argv lists — no shell chaining, redirects, subshells, or expansions allowed.`
      );
    }
  }
}

function assertPlaceholderIsolated(name: string, token: string): void {
  const matches = token.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g);
  if (!matches) return;
  if (matches.length > 1 || matches[0] !== token) {
    throw new RegistryError(
      `Operation '${name}': placeholder must occupy an entire argv slot ` +
        `(got '${token}'). Split into separate tokens.`
    );
  }
}

function parseArgSchema(op: string, arg: string, raw: unknown): ArgSchema {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RegistryError(
      `Operation '${op}': arg '${arg}' must be a table with at least 'type'.`
    );
  }
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (
    type !== "string" &&
    type !== "int" &&
    type !== "path" &&
    type !== "enum"
  ) {
    throw new RegistryError(
      `Operation '${op}': arg '${arg}' has invalid type '${String(type)}'. ` +
        `Must be one of: string, int, path, enum.`
    );
  }
  const schema: ArgSchema = { type };
  if (typeof r.default === "string" || typeof r.default === "number") {
    schema.default = r.default;
  }
  if (typeof r.validate === "string") schema.validate = r.validate;
  if (typeof r.must_exist === "boolean") schema.must_exist = r.must_exist;
  if (typeof r.must_match === "string") schema.must_match = r.must_match;
  if (Array.isArray(r.values)) {
    schema.values = r.values.map((v) => String(v));
  }
  if (typeof r.description === "string") schema.description = r.description;
  if (type === "enum" && (!schema.values || schema.values.length === 0)) {
    throw new RegistryError(
      `Operation '${op}': arg '${arg}' is enum but has no 'values'.`
    );
  }
  return schema;
}

function parseGlobalSandbox(raw: unknown): GlobalSandboxDefaults {
  if (raw === undefined || raw === null) return { ...DEFAULT_GLOBAL_SANDBOX };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RegistryError(`[sandbox] must be a table.`);
  }
  const r = raw as Record<string, unknown>;
  const out: GlobalSandboxDefaults = { ...DEFAULT_GLOBAL_SANDBOX };
  if (r.default_preset !== undefined) {
    if (typeof r.default_preset !== "string" || !VALID_PRESETS.includes(r.default_preset as SandboxPreset)) {
      throw new RegistryError(
        `[sandbox] default_preset must be one of: ${VALID_PRESETS.join(", ")} (got ${JSON.stringify(r.default_preset)}).`
      );
    }
    out.default_preset = r.default_preset as SandboxPreset;
  }
  if (r.extra_rw !== undefined) {
    if (!Array.isArray(r.extra_rw) || !r.extra_rw.every((v) => typeof v === "string")) {
      throw new RegistryError(`[sandbox] extra_rw must be an array of strings.`);
    }
    out.extra_rw = r.extra_rw as string[];
  }
  if (r.extra_ro !== undefined) {
    if (!Array.isArray(r.extra_ro) || !r.extra_ro.every((v) => typeof v === "string")) {
      throw new RegistryError(`[sandbox] extra_ro must be an array of strings.`);
    }
    out.extra_ro = r.extra_ro as string[];
  }
  return out;
}

function parseOpSandbox(
  opName: string,
  raw: unknown,
  defaults: GlobalSandboxDefaults
): SandboxSpec {
  // Absent → global default preset, global extras applied.
  if (raw === undefined) {
    return {
      mode: "bwrap",
      preset: defaults.default_preset,
      extraRw: [...defaults.extra_rw],
      extraRo: [...defaults.extra_ro],
    };
  }
  // Scalar opt-out.
  if (typeof raw === "string") {
    if (raw !== "off") {
      throw new RegistryError(
        `Operation '${opName}': sandbox scalar must literally be the string "off" ` +
          `(got ${JSON.stringify(raw)}). To pick a preset use sandbox.preset = "...".`
      );
    }
    return { mode: "off" };
  }
  if (raw === false || raw === true || raw === null || Array.isArray(raw)) {
    throw new RegistryError(
      `Operation '${opName}': sandbox must be a table or the literal string "off" (got ${JSON.stringify(raw)}).`
    );
  }
  if (typeof raw !== "object") {
    throw new RegistryError(
      `Operation '${opName}': sandbox must be a table or the literal string "off".`
    );
  }
  const r = raw as Record<string, unknown>;
  let preset: SandboxPreset = defaults.default_preset;
  if (r.preset !== undefined) {
    if (typeof r.preset !== "string" || !VALID_PRESETS.includes(r.preset as SandboxPreset)) {
      throw new RegistryError(
        `Operation '${opName}': sandbox.preset must be one of: ${VALID_PRESETS.join(", ")} ` +
          `(got ${JSON.stringify(r.preset)}).`
      );
    }
    preset = r.preset as SandboxPreset;
  }
  const extraRw: string[] = [...defaults.extra_rw];
  if (r.extra_rw !== undefined) {
    if (!Array.isArray(r.extra_rw) || !r.extra_rw.every((v) => typeof v === "string")) {
      throw new RegistryError(
        `Operation '${opName}': sandbox.extra_rw must be an array of strings.`
      );
    }
    extraRw.push(...(r.extra_rw as string[]));
  }
  const extraRo: string[] = [...defaults.extra_ro];
  if (r.extra_ro !== undefined) {
    if (!Array.isArray(r.extra_ro) || !r.extra_ro.every((v) => typeof v === "string")) {
      throw new RegistryError(
        `Operation '${opName}': sandbox.extra_ro must be an array of strings.`
      );
    }
    extraRo.push(...(r.extra_ro as string[]));
  }
  return { mode: "bwrap", preset, extraRw, extraRo };
}

function parseOperation(
  name: string,
  raw: unknown,
  projectRoot: string,
  sandboxDefaults: GlobalSandboxDefaults
): Operation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RegistryError(
      `Operation '${name}' must be a table.`
    );
  }
  const r = raw as Record<string, unknown>;
  const command = r.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new RegistryError(
      `Operation '${name}': missing required string 'command'.`
    );
  }
  assertTemplateSafe(name, command);
  const argv = splitArgv(command);
  for (const tok of argv) assertPlaceholderIsolated(name, tok);

  const description =
    typeof r.description === "string" ? r.description : "";
  const interactive = r.interactive === true;

  let timeout_ms = DEFAULT_TIMEOUT_MS;
  if (typeof r.timeout === "number" && r.timeout > 0) {
    timeout_ms = Math.floor(r.timeout * 1000);
  } else if (typeof r.timeout_ms === "number" && r.timeout_ms > 0) {
    timeout_ms = Math.floor(r.timeout_ms);
  }

  let max_output_bytes = DEFAULT_MAX_OUTPUT;
  if (typeof r.max_output_bytes === "number" && r.max_output_bytes > 0) {
    max_output_bytes = Math.floor(r.max_output_bytes);
  }

  let cwd = projectRoot;
  if (typeof r.cwd === "string" && r.cwd.length > 0) {
    const resolved = isAbsolute(r.cwd)
      ? resolve(r.cwd)
      : resolve(projectRoot, r.cwd);
    const rel = relative(projectRoot, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new RegistryError(
        `Operation '${name}': cwd '${r.cwd}' escapes project root.`
      );
    }
    cwd = resolved;
  }

  const args: Record<string, ArgSchema> = {};
  const rawArgs = r.args;
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    for (const [argName, argRaw] of Object.entries(rawArgs)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(argName)) {
        throw new RegistryError(
          `Operation '${name}': arg name '${argName}' must be an identifier.`
        );
      }
      args[argName] = parseArgSchema(name, argName, argRaw);
    }
  }

  const placeholders = new Set<string>();
  for (const tok of argv) {
    const m = tok.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
    if (m) placeholders.add(m[1]);
  }
  for (const p of placeholders) {
    if (!(p in args)) {
      throw new RegistryError(
        `Operation '${name}': template references '{${p}}' but no schema for arg '${p}'.`
      );
    }
  }

  const sandbox = parseOpSandbox(name, r.sandbox, sandboxDefaults);

  return {
    name,
    description,
    command,
    argv,
    args,
    interactive,
    timeout_ms,
    max_output_bytes,
    cwd,
    sandbox,
  };
}

export function loadRegistry(path: string): Registry {
  const projectRoot = dirname(resolve(path));
  const text = readFileSync(path, "utf8");
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(text);
  } catch (err) {
    throw new RegistryError(
      `Failed to parse TOML at ${path}: ${(err as Error).message}`
    );
  }
  const sandboxDefaults = parseGlobalSandbox(parsed.sandbox);
  const opsRaw = parsed.operations;
  const operations = new Map<string, Operation>();
  if (opsRaw && typeof opsRaw === "object" && !Array.isArray(opsRaw)) {
    for (const [name, raw] of Object.entries(opsRaw)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new RegistryError(
          `Operation name '${name}' must be an identifier.`
        );
      }
      operations.set(name, parseOperation(name, raw, projectRoot, sandboxDefaults));
    }
  }
  return { path, projectRoot, sandboxDefaults, operations };
}
