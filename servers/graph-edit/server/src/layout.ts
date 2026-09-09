import { isAbsolute, relative } from "node:path";
import type { Project, SourceFile } from "ts-morph";
import { LayoutAmbiguousError } from "./errors.js";
import { defaultPolicy } from "./policy.js";
import { normalizeName } from "./naming.js";
import type { ModulePath, PolicyConfig, ProjectRoot, SymbolKind } from "./types.js";

interface LayoutCtx {
  project?: Project;
  root?: ProjectRoot;
  policy?: PolicyConfig;
}

function joinRel(dir: string, filename: string): string {
  const clean = dir.replace(/\/+$/, "");
  return clean.length > 0 ? `${clean}/${filename}` : filename;
}

// Heuristic: React components (JSX) get .tsx. We detect by a target_dir hint
// (contains "component") OR by the group name (case-insensitive "component").
function isComponentGroup(name: string, targetDir: string): boolean {
  return /component/i.test(name) || /component/i.test(targetDir);
}

// If a symbol with `name` already lives in the project (by declaration name),
// return that source file's project-relative path. Only used defensively for
// edits that reach layoutForNewSymbol; creates typically don't hit this branch.
function findExistingSymbolModule(
  name: string,
  project: Project,
  root: ProjectRoot
): ModulePath | null {
  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    // Skip node_modules, declaration files, and anything outside root.
    if (filePath.includes("/node_modules/")) continue;
    if (filePath.endsWith(".d.ts")) continue;
    if (hasDeclarationNamed(sf, name)) {
      let rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
      // Normalize to forward slashes for ModulePath.
      rel = rel.split(/[\\/]/).join("/");
      return rel;
    }
  }
  return null;
}

function hasDeclarationNamed(sf: SourceFile, name: string): boolean {
  for (const d of sf.getClasses()) if (d.getName() === name) return true;
  for (const d of sf.getFunctions()) if (d.getName() === name) return true;
  for (const d of sf.getInterfaces()) if (d.getName() === name) return true;
  for (const d of sf.getTypeAliases()) if (d.getName() === name) return true;
  for (const d of sf.getEnums()) if (d.getName() === name) return true;
  for (const vs of sf.getVariableStatements()) {
    for (const decl of vs.getDeclarations()) {
      if (decl.getName() === name) return true;
    }
  }
  return false;
}

/**
 * Decide the file placement for a new symbol per policy precedence:
 *   1. First matching [layout.<group>] regex (by declaration order) wins.
 *   2. Existing declaration of the same name in the project (defensive fallback).
 *   3. Global fallback: `<root_dir>/<kebab-name>.ts`.
 * Throws LayoutAmbiguousError if none of the above yield a defensible path.
 *
 * NOTE: The caller (typically create_symbol) is expected to have handled the
 * explicit `module` arg upstream — this function is only invoked when the
 * agent left placement to policy.
 */
export function layoutForNewSymbol(
  kind: SymbolKind | string,
  name: string,
  ctx: LayoutCtx = {}
): ModulePath {
  const policy = ctx.policy ?? defaultPolicy();

  // 1. Groups — first regex match wins.
  const groups = policy.layout.groups ?? [];
  for (const g of groups) {
    let rx: RegExp;
    try {
      rx = new RegExp(g.pattern);
    } catch {
      // Malformed pattern shouldn't have made it past policy validation, but
      // don't let one bad rule wedge the whole decision — skip it.
      continue;
    }
    if (!rx.test(name)) continue;
    const naming = g.naming ?? "kebab-case";
    const base = normalizeName(name, naming);
    const ext = isComponentGroup(g.name, g.target_dir) ? ".tsx" : ".ts";
    return joinRel(g.target_dir, `${base}${ext}`);
  }

  // 2. Existing declaration in the project.
  if (ctx.project && ctx.root) {
    const existing = findExistingSymbolModule(name, ctx.project, ctx.root);
    if (existing) return existing;
  }

  // 3. Global fallback.
  const rootDir = policy.project.root_dir;
  if (rootDir && rootDir.length > 0) {
    const base = normalizeName(name, "kebab-case");
    return joinRel(rootDir, `${base}.ts`);
  }

  throw new LayoutAmbiguousError(
    String(kind),
    name,
    "no [layout] rule matched and no project.root_dir is configured — pass module="
  );
}
