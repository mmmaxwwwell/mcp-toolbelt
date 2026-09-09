import { existsSync, readFileSync } from "node:fs";
import TOML from "@iarna/toml";

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
}

export const defaultPolicy: Policy = {
  add: { allow: [], deny: [], require_dev: [] },
  run: { allow: [], deny: [] },
  update: { default: "patch" },
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
    };
    return p;
  } catch (err) {
    throw new Error(
      `Failed to parse policy at ${path}: ${(err as Error).message}`
    );
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normalizeUpdate(v: unknown): "patch" | "minor" | "latest" {
  if (v === "minor" || v === "latest") return v;
  return "patch";
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
