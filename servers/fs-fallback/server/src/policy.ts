import { readFileSync, existsSync } from "node:fs";
import micromatch from "micromatch";
import TOML from "@iarna/toml";

export interface SoftDenyRule {
  pattern: string;
  hint: string;
}

export interface ReadPolicy {
  allow: string[];
  deny: string[];
}

export interface WritePolicy {
  allow: string[];
  deny: string[];
  soft_deny: SoftDenyRule[];
  allow_source_override: string[];
  edit_surface_refuse: string[];
}

export interface TrashPolicy {
  retention_days: number;
}

export interface AuditPolicy {
  log: string;
  enabled: boolean;
}

export interface Policy {
  read: ReadPolicy;
  write: WritePolicy;
  trash: TrashPolicy;
  audit: AuditPolicy;
  source: "config" | "default";
  configPath: string | null;
}

// Default patterns edit-surface handles (v0.1 languages). Writing these via
// fs-fallback is refused unless explicitly listed in allow_source_override.
export const DEFAULT_EDIT_SURFACE_PATTERNS: string[] = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.py",
  "**/*.go",
  "**/*.rs",
  "**/*.nix",
];

const DEFAULT_SECRET_DENY: string[] = [
  ".env",
  ".env.*",
  "secrets/**",
  "**/.aws/**",
  "**/.ssh/**",
  "**/id_rsa*",
  "**/*.pem",
];

/**
 * Restrictive default policy applied when no `.fs-fallback.toml` is found.
 * Reads are permissive-minus-secrets; writes are refused entirely to force
 * the operator to opt in via config.
 */
export function defaultPolicy(): Policy {
  return {
    read: {
      allow: ["**/*"],
      deny: [...DEFAULT_SECRET_DENY],
    },
    write: {
      allow: [],
      deny: [],
      soft_deny: [],
      allow_source_override: [],
      edit_surface_refuse: [...DEFAULT_EDIT_SURFACE_PATTERNS],
    },
    trash: { retention_days: 7 },
    audit: { log: ".fs-fallback/audit.jsonl", enabled: true },
    source: "default",
    configPath: null,
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function parseSoftDeny(raw: unknown): SoftDenyRule[] {
  if (!Array.isArray(raw)) return [];
  const out: SoftDenyRule[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const r = entry as Record<string, unknown>;
      if (typeof r.pattern === "string" && typeof r.hint === "string") {
        out.push({ pattern: r.pattern, hint: r.hint });
      }
    }
  }
  return out;
}

export function loadPolicy(configPath: string): Policy {
  if (!existsSync(configPath)) {
    const p = defaultPolicy();
    return p;
  }
  const text = readFileSync(configPath, "utf8");
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${(err as Error).message}`
    );
  }
  const read = (parsed.read as Record<string, unknown>) || {};
  const write = (parsed.write as Record<string, unknown>) || {};
  const trash = (parsed.trash as Record<string, unknown>) || {};
  const audit = (parsed.audit as Record<string, unknown>) || {};

  const readAllow = asStringArray(read.allow);
  const readDeny = asStringArray(read.deny);
  const writeAllow = asStringArray(write.allow);
  const writeDeny = asStringArray(write.deny);
  const writeSoftDeny = parseSoftDeny(write.soft_deny);
  const writeAllowSourceOverride = asStringArray(write.allow_source_override);
  const editSurfaceRefuse =
    asStringArray(write.edit_surface_refuse).length > 0
      ? asStringArray(write.edit_surface_refuse)
      : [...DEFAULT_EDIT_SURFACE_PATTERNS];

  const retentionDays =
    typeof trash.retention_days === "number" && trash.retention_days >= 0
      ? Math.floor(trash.retention_days)
      : 7;

  const auditLog =
    typeof audit.log === "string" && audit.log.length > 0
      ? audit.log
      : ".fs-fallback/audit.jsonl";
  const auditEnabled = audit.enabled === false ? false : true;

  return {
    read: {
      allow: readAllow.length > 0 ? readAllow : ["**/*"],
      deny: readDeny,
    },
    write: {
      allow: writeAllow,
      deny: writeDeny,
      soft_deny: writeSoftDeny,
      allow_source_override: writeAllowSourceOverride,
      edit_surface_refuse: editSurfaceRefuse,
    },
    trash: { retention_days: retentionDays },
    audit: { log: auditLog, enabled: auditEnabled },
    source: "config",
    configPath,
  };
}

// -------- Matching helpers --------

const MM_OPTS: micromatch.Options = { dot: true, nocase: false };

export function matchAny(patterns: string[], relPath: string): string | null {
  for (const p of patterns) {
    if (micromatch.isMatch(relPath, p, MM_OPTS)) return p;
  }
  return null;
}

export function matchSoftDeny(
  rules: SoftDenyRule[],
  relPath: string
): SoftDenyRule | null {
  for (const r of rules) {
    if (micromatch.isMatch(relPath, r.pattern, MM_OPTS)) return r;
  }
  return null;
}

// -------- Read decisions --------

export type ReadDecision =
  | { decision: "allow"; matched_rule: string }
  | { decision: "deny"; matched_rule: string; reason: string };

export function decideRead(policy: Policy, relPath: string): ReadDecision {
  const deniedBy = matchAny(policy.read.deny, relPath);
  if (deniedBy) {
    return {
      decision: "deny",
      matched_rule: `[read.deny] ${deniedBy}`,
      reason: `Path matches [read.deny] pattern '${deniedBy}'`,
    };
  }
  const allowedBy = matchAny(policy.read.allow, relPath);
  if (allowedBy) {
    return { decision: "allow", matched_rule: `[read.allow] ${allowedBy}` };
  }
  return {
    decision: "deny",
    matched_rule: "[read] no-match",
    reason: `Path does not match any [read.allow] pattern`,
  };
}

// -------- Write decisions --------

export type WriteDecision =
  | { decision: "allow"; matched_rule: string }
  | { decision: "deny"; matched_rule: string; reason: string }
  | {
      decision: "soft_deny";
      matched_rule: string;
      hint: string;
    }
  | {
      decision: "edit_surface_refuse";
      matched_rule: string;
      reason: string;
    };

const EDIT_SURFACE_MSG =
  "source-code writes go through graph-edit (preferred: open_symbol → add_method / edit_symbol_body) " +
  "or edit-surface (anchor-based fallback for languages graph-edit doesn't back). " +
  "If you really need a raw write, add this path to [write.allow_source_override] in .fs-fallback.toml.";

export function decideWrite(policy: Policy, relPath: string): WriteDecision {
  // 1. edit-surface refusal (unless overridden).
  const editSurfaceHit = matchAny(policy.write.edit_surface_refuse, relPath);
  if (editSurfaceHit) {
    const overrideHit = matchAny(
      policy.write.allow_source_override,
      relPath
    );
    if (!overrideHit) {
      return {
        decision: "edit_surface_refuse",
        matched_rule: `[write] edit_surface_refuse ${editSurfaceHit}`,
        reason: EDIT_SURFACE_MSG,
      };
    }
  }

  // 2. Hard deny.
  const denyHit = matchAny(policy.write.deny, relPath);
  if (denyHit) {
    return {
      decision: "deny",
      matched_rule: `[write.deny] ${denyHit}`,
      reason: `Path matches [write.deny] pattern '${denyHit}'`,
    };
  }

  // 3. Soft deny.
  const softHit = matchSoftDeny(policy.write.soft_deny, relPath);
  if (softHit) {
    return {
      decision: "soft_deny",
      matched_rule: `[write.soft_deny] ${softHit.pattern}`,
      hint: softHit.hint,
    };
  }

  // 4. Allow.
  const allowHit = matchAny(policy.write.allow, relPath);
  if (allowHit) {
    return { decision: "allow", matched_rule: `[write.allow] ${allowHit}` };
  }

  // 5. No allow match.
  return {
    decision: "deny",
    matched_rule: "[write] no-match",
    reason:
      `Path does not match any [write.allow] pattern. ` +
      `Add a pattern to [write.allow] in .fs-fallback.toml to permit writes here.`,
  };
}

// -------- why_blocked tracing --------

export interface WhyBlockedTrace {
  path: string;
  rel_path: string;
  read: ReadDecision;
  write: WriteDecision;
  config_source: "config" | "default";
  config_path: string | null;
}

export function whyBlocked(
  policy: Policy,
  origPath: string,
  relPath: string
): WhyBlockedTrace {
  return {
    path: origPath,
    rel_path: relPath,
    read: decideRead(policy, relPath),
    write: decideWrite(policy, relPath),
    config_source: policy.source,
    config_path: policy.configPath,
  };
}
