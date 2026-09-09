import { readFileSync, existsSync } from "node:fs";
import TOML from "@iarna/toml";
import type { PolicyConfig } from "./types.js";

export function defaultPolicy(): PolicyConfig {
  return {
    project: { tsconfig: "tsconfig.json", root_dir: "src" },
    layout: {
      one_class_per_file: true,
      one_component_per_file: true,
      function_grouping: "keep_existing",
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
    reexports: { barrel_files: "manual", public_marker: "@public" },
    formatter: { command: "prettier", args: ["--write"], skip_if_missing: false },
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
    groups.push({
      name,
      pattern: g.pattern,
      target_dir: g.target_dir,
      naming: typeof g.naming === "string" ? g.naming : undefined,
    });
  }
  return groups;
}

export function loadPolicy(configPath: string | null): PolicyConfig {
  if (!configPath || !existsSync(configPath)) return defaultPolicy();
  const text = readFileSync(configPath, "utf8");
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
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

  return {
    project: {
      tsconfig: asString(project.tsconfig, defaults.project.tsconfig),
      root_dir: asString(project.root_dir, defaults.project.root_dir),
    },
    layout: {
      one_class_per_file: asBool(layoutRaw.one_class_per_file, true),
      one_component_per_file: asBool(layoutRaw.one_component_per_file, true),
      function_grouping:
        (typeof layoutRaw.function_grouping === "string"
          ? (layoutRaw.function_grouping as PolicyConfig["layout"]["function_grouping"])
          : undefined) ?? "keep_existing",
      groups: parseLayoutGroups(namedGroupEntries),
    },
    imports: {
      sort_order:
        asStringArray(importsRaw.sort_order).length > 0
          ? asStringArray(importsRaw.sort_order)
          : defaults.imports.sort_order,
      absolute_prefix:
        typeof importsRaw.absolute_prefix === "string"
          ? importsRaw.absolute_prefix
          : undefined,
      merge_duplicates: asBool(importsRaw.merge_duplicates, true),
      remove_unused: asBool(importsRaw.remove_unused, true),
    },
    naming,
    reexports: {
      barrel_files:
        (typeof reexportsRaw.barrel_files === "string"
          ? (reexportsRaw.barrel_files as PolicyConfig["reexports"]["barrel_files"])
          : undefined) ?? "manual",
      public_marker: asString(reexportsRaw.public_marker, defaults.reexports.public_marker),
    },
    formatter: {
      command: asString(formatterRaw.command, defaults.formatter.command),
      args:
        asStringArray(formatterRaw.args).length > 0
          ? asStringArray(formatterRaw.args)
          : defaults.formatter.args,
      skip_if_missing: asBool(formatterRaw.skip_if_missing, false),
    },
    type_check: {
      strict: asBool(typeCheckRaw.strict, true),
    },
  };
}
