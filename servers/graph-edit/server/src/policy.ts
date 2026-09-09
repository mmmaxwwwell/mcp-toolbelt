import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import TOML from "@iarna/toml";
import type { PolicyConfig } from "./types.js";
import { isKnownConvention } from "./naming.js";

export const POLICY_FILENAME = ".graph-edit.toml";

export function defaultPolicy(): PolicyConfig {
  return {
    project: { tsconfig: "tsconfig.json", root_dir: "src" },
    layout: {
      one_class_per_file: true,
      one_component_per_file: true,
      function_grouping: "topic",
      groups: [],
    },
    imports: {
      sort_order: ["node", "external", "absolute", "relative"],
      merge_duplicates: true,
      remove_unused: true,
    },
    naming: {
      functions: "camelCase",
      classes: "PascalCase",
      types: "PascalCase",
      constants: "SCREAMING_SNAKE_CASE",
      enums: "PascalCase",
      enum_members: "PascalCase",
    },
    // Safest default when no config: don't rewrite index.ts files without explicit opt-in.
    reexports: { barrel_files: "none", public_marker: "@public" },
    // Missing formatter shouldn't kill the server by default.
    formatter: { command: "prettier", args: ["--write"], skip_if_missing: true },
    type_check: { strict: true },
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function parseLayoutGroups(raw: unknown): PolicyConfig["layout"]["groups"] {
  const groups: PolicyConfig["layout"]["groups"] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return groups;
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const g = val as Record<string, unknown>;
    if (typeof g.pattern !== "string" || typeof g.target_dir !== "string") continue;
    // Validate: regex compiles.
    try {
      new RegExp(g.pattern);
    } catch (err) {
      throw new Error(
        `.graph-edit.toml [layout.${name}] pattern is not a valid regex: ${(err as Error).message}`
      );
    }
    // Validate: naming, if set, must be a known convention.
    const naming = typeof g.naming === "string" ? g.naming : undefined;
    if (naming !== undefined && !isKnownConvention(naming)) {
      throw new Error(
        `.graph-edit.toml [layout.${name}] naming '${naming}' is not a known convention ` +
          `(expected one of: camelCase, PascalCase, SCREAMING_SNAKE_CASE, kebab-case, snake_case)`
      );
    }
    groups.push({
      name,
      pattern: g.pattern,
      target_dir: g.target_dir,
      naming,
    });
  }
  return groups;
}

function parsePolicyText(text: string, sourceLabel: string): PolicyConfig {
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${sourceLabel}: ${(err as Error).message}`);
  }

  const project = (parsed.project as Record<string, unknown>) || {};
  const layoutRaw = (parsed.layout as Record<string, unknown>) || {};
  const importsRaw = (parsed.imports as Record<string, unknown>) || {};
  const namingRaw = (parsed.naming as Record<string, unknown>) || {};
  const reexportsRaw = (parsed.reexports as Record<string, unknown>) || {};
  const formatterRaw = (parsed.formatter as Record<string, unknown>) || {};
  const typeCheckRaw = (parsed.type_check as Record<string, unknown>) || {};

  // Sub-tables under [layout.*] show up as nested object keys on layoutRaw.
  const namedGroupEntries: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(layoutRaw)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      namedGroupEntries[k] = v;
    }
  }

  const defaults = defaultPolicy();
  const naming: Record<string, string> = { ...defaults.naming };
  for (const [k, v] of Object.entries(namingRaw)) {
    if (typeof v === "string") naming[k] = v;
  }

  const functionGroupingRaw =
    typeof layoutRaw.function_grouping === "string" ? layoutRaw.function_grouping : undefined;
  const functionGrouping: PolicyConfig["layout"]["function_grouping"] =
    functionGroupingRaw === "topic" ||
    functionGroupingRaw === "one_per_file" ||
    functionGroupingRaw === "keep_existing"
      ? functionGroupingRaw
      : "topic";

  const barrelFilesRaw =
    typeof reexportsRaw.barrel_files === "string" ? reexportsRaw.barrel_files : undefined;
  const barrelFiles: PolicyConfig["reexports"]["barrel_files"] =
    barrelFilesRaw === "auto" || barrelFilesRaw === "manual" || barrelFilesRaw === "none"
      ? barrelFilesRaw
      : "none";

  return {
    project: {
      tsconfig: asString(project.tsconfig, defaults.project.tsconfig),
      root_dir: asString(project.root_dir, defaults.project.root_dir),
    },
    layout: {
      one_class_per_file: asBool(layoutRaw.one_class_per_file, true),
      one_component_per_file: asBool(layoutRaw.one_component_per_file, true),
      function_grouping: functionGrouping,
      groups: parseLayoutGroups(namedGroupEntries),
    },
    imports: {
      sort_order:
        asStringArray(importsRaw.sort_order).length > 0
          ? asStringArray(importsRaw.sort_order)
          : defaults.imports.sort_order,
      absolute_prefix:
        typeof importsRaw.absolute_prefix === "string" ? importsRaw.absolute_prefix : undefined,
      merge_duplicates: asBool(importsRaw.merge_duplicates, true),
      remove_unused: asBool(importsRaw.remove_unused, true),
    },
    naming,
    reexports: {
      barrel_files: barrelFiles,
      public_marker: asString(reexportsRaw.public_marker, defaults.reexports.public_marker),
    },
    formatter: {
      command: asString(formatterRaw.command, defaults.formatter.command),
      args:
        asStringArray(formatterRaw.args).length > 0
          ? asStringArray(formatterRaw.args)
          : defaults.formatter.args,
      // Default to skip_if_missing=true so a missing prettier binary doesn't
      // kill the server; explicit `false` in the config still forces failure.
      skip_if_missing: asBool(formatterRaw.skip_if_missing, true),
    },
    type_check: {
      strict: asBool(typeCheckRaw.strict, true),
    },
  };
}

// Walk up from `startDir` looking for POLICY_FILENAME. Returns null if none found.
function findPolicyFile(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, POLICY_FILENAME);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * loadPolicy accepts either:
 *  - a direct path to a `.graph-edit.toml` file, or
 *  - a directory (project root) to walk up from, or
 *  - null/undefined to yield defaults.
 * Missing config → defaultPolicy(). Malformed config → thrown Error.
 */
export function loadPolicy(pathOrRoot: string | null | undefined): PolicyConfig {
  if (!pathOrRoot) return defaultPolicy();
  let configPath: string | null = null;
  try {
    if (existsSync(pathOrRoot)) {
      const st = statSync(pathOrRoot);
      if (st.isDirectory()) {
        configPath = findPolicyFile(pathOrRoot);
      } else if (st.isFile()) {
        configPath = pathOrRoot;
      }
    }
  } catch {
    // fall through
  }
  if (!configPath) return defaultPolicy();
  const text = readFileSync(configPath, "utf8");
  return parsePolicyText(text, configPath);
}
