import { NotImplementedError } from "../errors.js";
import type { Session } from "../session.js";
import type { ModulePath, SymbolId, SymbolKind } from "../types.js";
import { handleGetReferences } from "./get-references.js";
import { handleListSymbols } from "./list-symbols.js";
import { handleGetSymbol } from "./get-symbol.js";
import { handleListModules } from "./list-modules.js";
import { handleDescribeModule } from "./describe-module.js";

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string arg: ${key}`);
  }
  return v;
}

function strOpt(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function boolOpt(args: Args, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function kindsOpt(args: Args, key: string): SymbolKind[] | undefined {
  const v = args[key];
  if (Array.isArray(v)) return v.filter((x): x is SymbolKind => typeof x === "string");
  if (typeof v === "string") return [v as SymbolKind];
  return undefined;
}

// Handler map — every tool routes here. Behavior lands in later phases;
// for now every path throws NotImplementedError via session.
export const stubHandlers: Record<string, (session: Session, args: Args) => Promise<unknown>> = {
  // Read
  list_symbols: async (s, a) =>
    handleListSymbols(s, {
      query: strOpt(a, "query"),
      kind: kindsOpt(a, "kind") ?? kindsOpt(a, "kinds"),
      module: strOpt(a, "module") ?? strOpt(a, "scope"),
    }),
  get_symbol: async (s, a) => handleGetSymbol(s, { id: str(a, "id") as SymbolId }),
  get_references: async (s, a) => handleGetReferences(s, str(a, "id") as SymbolId),
  list_modules: async (s, a) => handleListModules(s, { pattern: strOpt(a, "pattern") }),
  describe_module: async (s, a) => handleDescribeModule(s, { path: str(a, "path") as ModulePath }),

  // Write — structural
  create_symbol: async (s, a) => s.createSymbol(a),
  add_method: async (s, a) => s.addMethod(a),
  add_property: async (s, a) => s.addProperty(a),
  edit_symbol_body: async (s, a) => s.editSymbolBody(str(a, "id") as SymbolId, str(a, "body")),
  edit_symbol_signature: async (s, a) =>
    s.editSymbolSignature(str(a, "id") as SymbolId, str(a, "signature")),
  rename_symbol: async (s, a) => s.renameSymbol(str(a, "id") as SymbolId, str(a, "new_name")),
  move_symbol: async (s, a) =>
    s.moveSymbol(str(a, "id") as SymbolId, str(a, "target_module") as ModulePath),
  delete_symbol: async (s, a) => {
    const refactor = (strOpt(a, "refactor_callers") ?? "refuse") as
      | "refuse"
      | "inline_last_use"
      | "leave_broken";
    return s.deleteSymbol(str(a, "id") as SymbolId, refactor);
  },

  // Write — supporting
  add_import: async (s, a) => s.addImport(a),
  add_export: async (s, a) => s.addExport(a),
  add_decorator: async (s, a) =>
    s.addDecorator(str(a, "id") as SymbolId, str(a, "decorator_source")),
  set_doc_comment: async (s, a) =>
    s.setDocComment(str(a, "id") as SymbolId, str(a, "jsdoc_source")),

  // Session
  preview: async (s) => s.preview(),
  preview_types: async (s) => s.previewTypes(),
  commit: async (s, a) => s.commit(boolOpt(a, "accept_breaking_callers") ?? false),
  discard: async (s) => {
    s.discard();
    return { discarded: true };
  },
  reset_session: async (s) => {
    await s.resetSession();
    return { reset: true };
  },
  session_summary: async (s) => s.sessionSummary(),

  // Bundled
  open_symbol: async (s, a) => s.openSymbol(str(a, "id_or_query")),
  explore: async (s, a) => s.explore(str(a, "intent"), strOpt(a, "target")),
  describe_change_zone: async (s, a) => s.describeChangeZone(str(a, "id") as SymbolId),
  similar_to: async (s, a) => {
    const k = a.k;
    return s.similarTo(str(a, "id") as SymbolId, typeof k === "number" ? k : undefined);
  },
  find: async (s, a) => {
    const mode = strOpt(a, "mode") as "name" | "concept" | "usage" | "auto" | undefined;
    return s.find(str(a, "query"), {
      kinds: kindsOpt(a, "kinds"),
      scope: strOpt(a, "scope"),
      mode,
    });
  },

  // Escape hatch
  raw_edit_symbol: async (s, a) =>
    s.rawEditSymbol(str(a, "id") as SymbolId, str(a, "new_source")),
};

export function dispatch(session: Session, name: string, args: Args): Promise<unknown> {
  const handler = stubHandlers[name];
  if (!handler) {
    return Promise.reject(new NotImplementedError(name, "not registered"));
  }
  return handler(session, args);
}
