import { existsSync, readFileSync } from "node:fs";
import TOML from "@iarna/toml";
import type { SandboxPreset } from "./sandbox.js";

// All pnpm verbs the wrapper exposes. Used to key per-verb sandbox opt-outs.
export const KNOWN_VERBS = [
  "add",
  "remove",
  "update",
  "install",
  "install_frozen",
  "prune",
  "list",
  "why",
  "outdated",
  "list_scripts",
  "run",
  "test",
  "lint",
  "typecheck",
  "audit",
  "licenses",
] as const;

export type Verb = (typeof KNOWN_VERBS)[number];

// Verb-kind is what selects the base preset. `install` and `readonly` are
// fixed for their verbs (no override). `script` verbs may be overridden
// per-script via [sandbox.scripts].
export type VerbKind = "install" | "readonly" | "script";

const VERB_KIND: Record<Verb, VerbKind> = {
  add: "install",
  remove: "install",
  update: "install",
  install: "install",
  install_frozen: "install",
  prune: "install",
  list: "readonly",
  why: "readonly",
  outdated: "readonly",
  list_scripts: "readonly",
  licenses: "readonly",
  run: "script",
  test: "script",
  lint: "script",
  typecheck: "script",
  audit: "script",
};

export function verbKind(v: Verb): VerbKind {
  return VERB_KIND[v];
}

const ALLOWED_SCRIPT_PRESETS = new Set<SandboxPreset>([
  "install",
  "readonly",
  "strict",
]);

export interface SandboxPolicy {
  extra_rw: string[];
  extra_ro: string[];
  scripts: {
    default_preset: SandboxPreset; // for script-kind verbs
    per_script: Record<string, SandboxPreset>;
  };
  disabled: Record<string, { reason: string }>; // verb name -> reason
}

export interface Policy {
  add: {
    allow: string[];
    deny: string[];
    require_dev: string[];
  };
  run: {
    allow: string[];
    deny: string[];
  };
  update: {
    default: "patch" | "minor" | "latest";
  };
  sandbox: SandboxPolicy;
}

export const defaultPolicy: Policy = {
  add: { allow: [], deny: [], require_dev: [] },
  run: { allow: [], deny: [] },
  update: { default: "patch" },
  sandbox: {
    extra_rw: [],
    extra_ro: [],
    scripts: {
      default_preset: "install",
      per_script: {},
    },
    disabled: {},
  },
};

export function loadPolicy(path: string): Policy {
  if (!existsSync(path)) return defaultPolicy;
  try {
    const raw = TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const p: Policy = {
      add: {
        allow: asStringArray(raw.add?.allow),
        deny: asStringArray(raw.add?.deny),
        require_dev: asStringArray(raw.add?.require_dev),
      },
      run: {
        allow: asStringArray(raw.run?.allow),
        deny: asStringArray(raw.run?.deny),
      },
      update: {
        default: normalizeUpdate(raw.update?.default),
      },
      sandbox: parseSandbox(raw.sandbox),
    };
    return p;
  } catch (err) {
    throw new Error(
      `Failed to parse policy at ${path}: ${(err as Error).message}`
    );
  }
}

function parseSandbox(raw: unknown): SandboxPolicy {
  const base: SandboxPolicy = {
    extra_rw: [],
    extra_ro: [],
    scripts: { default_preset: "install", per_script: {} },
    disabled: {},
  };
  if (!raw || typeof raw !== "object") return base;
  const s = raw as Record<string, any>;

  base.extra_rw = asStringArray(s.extra_rw);
  base.extra_ro = asStringArray(s.extra_ro);

  if (s.scripts && typeof s.scripts === "object") {
    const sc = s.scripts as Record<string, any>;
    if (typeof sc.default_preset === "string") {
      if (!ALLOWED_SCRIPT_PRESETS.has(sc.default_preset as SandboxPreset)) {
        throw new Error(
          `[sandbox.scripts].default_preset = "${sc.default_preset}" invalid; ` +
            `must be one of: install, readonly, strict`
        );
      }
      base.scripts.default_preset = sc.default_preset as SandboxPreset;
    }
    for (const [k, v] of Object.entries(sc)) {
      if (k === "default_preset") continue;
      if (typeof v !== "string") {
        throw new Error(
          `[sandbox.scripts]."${k}" must be a string preset name, got ${typeof v}`
        );
      }
      if (!ALLOWED_SCRIPT_PRESETS.has(v as SandboxPreset)) {
        throw new Error(
          `[sandbox.scripts]."${k}" = "${v}" invalid; ` +
            `must be one of: install, readonly, strict`
        );
      }
      base.scripts.per_script[k] = v as SandboxPreset;
    }
  }

  if (s.disabled && typeof s.disabled === "object") {
    for (const [verb, entry] of Object.entries(
      s.disabled as Record<string, any>
    )) {
      if (!entry || typeof entry !== "object") {
        throw new Error(
          `[sandbox.disabled]."${verb}" must be a table with { off = true, reason = "…" }`
        );
      }
      const off = (entry as any).off;
      const reason = (entry as any).reason;
      // Per spec: value MUST literally be `off = true`. Any other shape is an error.
      if (off !== true) {
        throw new Error(
          `[sandbox.disabled]."${verb}" must set off = true (got ${JSON.stringify(off)})`
        );
      }
      if (typeof reason !== "string" || !reason.trim()) {
        throw new Error(
          `[sandbox.disabled]."${verb}" requires a non-empty reason string`
        );
      }
      if (!(KNOWN_VERBS as readonly string[]).includes(verb)) {
        throw new Error(
          `[sandbox.disabled]."${verb}" is not a known verb ` +
            `(known: ${KNOWN_VERBS.join(", ")})`
        );
      }
      base.disabled[verb] = { reason };
    }
  }

  return base;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normalizeUpdate(v: unknown): "patch" | "minor" | "latest" {
  if (v === "minor" || v === "latest") return v;
  return "patch";
}

// Resolve the effective sandbox preset for a verb (optionally with a
// script name for script-kind verbs). Returns null when the verb is
// explicitly disabled via [sandbox.disabled].
export interface EffectiveSandbox {
  disabled: boolean;
  reason?: string;
  preset?: SandboxPreset;
}

export function effectiveSandbox(
  policy: Policy,
  verb: Verb,
  scriptName?: string
): EffectiveSandbox {
  const off = policy.sandbox.disabled[verb];
  if (off) return { disabled: true, reason: off.reason };

  const kind = verbKind(verb);
  if (kind === "install") return { disabled: false, preset: "install" };
  if (kind === "readonly") return { disabled: false, preset: "readonly" };

  // script kind
  let preset: SandboxPreset = policy.sandbox.scripts.default_preset;
  // Convention: for `run`, the script name comes from the caller's args.
  // For `test`/`lint`/`typecheck`/`audit`, the effective script name is
  // the verb itself.
  const key = scriptName ?? verb;
  const override = policy.sandbox.scripts.per_script[key];
  if (override) preset = override;
  return { disabled: false, preset };
}

// Simple glob: only supports `*` (matches any run of non-slash chars for our use).
// Package names may contain slashes for scoped packages, but our patterns don't need /.
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function anyGlobMatch(patterns: string[], value: string): boolean {
  return patterns.some((p) => globMatch(p, value));
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function checkAdd(
  policy: Policy,
  pkg: string,
  dev: boolean
): PolicyDecision {
  if (policy.add.deny.length && anyGlobMatch(policy.add.deny, pkg)) {
    return { allowed: false, reason: `Package "${pkg}" is on the deny list` };
  }
  if (policy.add.allow.length && !anyGlobMatch(policy.add.allow, pkg)) {
    return {
      allowed: false,
      reason: `Package "${pkg}" is not on the allow list`,
    };
  }
  if (
    !dev &&
    policy.add.require_dev.length &&
    anyGlobMatch(policy.add.require_dev, pkg)
  ) {
    return {
      allowed: false,
      reason: `Package "${pkg}" must be added as a devDependency (use dev: true)`,
    };
  }
  return { allowed: true };
}

export function checkRun(
  policy: Policy,
  script: string,
  availableScripts: string[]
): PolicyDecision {
  if (!availableScripts.includes(script)) {
    return {
      allowed: false,
      reason: `Script "${script}" not defined in package.json scripts`,
    };
  }
  if (policy.run.deny.includes(script)) {
    return { allowed: false, reason: `Script "${script}" is on the deny list` };
  }
  if (policy.run.allow.length && !policy.run.allow.includes(script)) {
    return {
      allowed: false,
      reason: `Script "${script}" is not on the allow list`,
    };
  }
  return { allowed: true };
}
