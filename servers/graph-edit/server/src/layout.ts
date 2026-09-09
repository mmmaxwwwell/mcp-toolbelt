import type { Project } from "ts-morph";
import { LayoutAmbiguousError } from "./errors.js";
import type { ModulePath, PolicyConfig, ProjectRoot, SymbolKind } from "./types.js";

// Phase 2 stub — Phase 3 (Agent 3B) replaces this with real policy-driven
// placement using PolicyConfig.layout.groups + naming rules. Until then,
// callers must pass `module` explicitly on create_symbol.
export function layoutForNewSymbol(
  _kind: SymbolKind | string,
  name: string,
  _opts?: { project?: Project; root?: ProjectRoot; policy?: PolicyConfig }
): ModulePath {
  throw new LayoutAmbiguousError(
    String(_kind),
    name,
    "layout rules not yet loaded; pass 'module' explicitly"
  );
}
