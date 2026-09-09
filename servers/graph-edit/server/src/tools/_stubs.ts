import { NotImplementedError } from "../errors.js";
import type { Session } from "../session.js";
import type { ModulePath, SymbolId, SymbolKind } from "../types.js";
import { handleAddMethod } from "./add-method.js";
import { handleAddProperty } from "./add-property.js";
import { handleCreateSymbol } from "./create-symbol.js";
import { handleGetReferences } from "./get-references.js";
import { handleListSymbols } from "./list-symbols.js";
import { handleGetSymbol } from "./get-symbol.js";
import { handleListModules } from "./list-modules.js";
import { handleDescribeModule } from "./describe-module.js";
import { handleEditSymbolBody } from "./edit-symbol-body.js";
import { handleEditSymbolSignature } from "./edit-symbol-signature.js";
import { handleAddImport } from "./add-import.js";
import { handleAddExport } from "./add-export.js";
import { handleAddDecorator } from "./add-decorator.js";
import { handleSetDocComment } from "./set-doc-comment.js";
import { handleRenameSymbol } from "./rename-symbol.js";
import { handleMoveSymbol } from "./move-symbol.js";
import { handleDeleteSymbol, type RefactorCallers } from "./delete-symbol.js";

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
  create_symbol: async (s, a) =>
    handleCreateSymbol(s, {
      kind: str(a, "kind"),
      name: str(a, "name"),
      module: strOpt(a, "module"),
      signature: str(a, "signature"),
      body: strOpt(a, "body"),
      doc: strOpt(a, "doc"),
    }),
  add_method: async (s, a) =>
    handleAddMethod(s, {
      class_id: str(a, "class_id") as SymbolId,
      name: str(a, "name"),
      signature: str(a, "signature"),
      body: str(a, "body"),
      visibility: strOpt(a, "visibility") as "public" | "private" | "protected" | undefined,
      static: boolOpt(a, "static"),
    }),
  add_property: async (s, a) =>
    handleAddProperty(s, {
      class_id: str(a, "class_id") as SymbolId,
      name: str(a, "name"),
      type: str(a, "type"),
      initializer: strOpt(a, "initializer"),
      visibility: strOpt(a, "visibility") as "public" | "private" | "protected" | undefined,
      readonly: boolOpt(a, "readonly"),
    }),
  edit_symbol_body: async (s, a) =>
    handleEditSymbolBody(s, { id: str(a, "id") as SymbolId, body: str(a, "body") }),
  edit_symbol_signature: async (s, a) =>
    handleEditSymbolSignature(s, {
      id: str(a, "id") as SymbolId,
      signature: str(a, "signature"),
    }),
  rename_symbol: async (s, a) =>
    handleRenameSymbol(s, {
      id: str(a, "id") as SymbolId,
      new_name: str(a, "new_name"),
    }),
  move_symbol: async (s, a) =>
    handleMoveSymbol(s, {
      id: str(a, "id") as SymbolId,
      target_module: str(a, "target_module") as ModulePath,
    }),
  delete_symbol: async (s, a) =>
    handleDeleteSymbol(s, {
      id: str(a, "id") as SymbolId,
      refactor_callers: (strOpt(a, "refactor_callers") ?? undefined) as
        | RefactorCallers
        | undefined,
    }),

  // Write — supporting
  add_import: async (s, a) => {
    const importsArr = Array.isArray(a.imports) ? (a.imports as Array<{ name: string; alias?: string }>) : [];
    return handleAddImport(s, {
      target_module: strOpt(a, "target_module"),
      module_path: str(a, "module_path"),
      imports: importsArr,
    });
  },
  add_export: async (s, a) =>
    handleAddExport(s, {
      id: str(a, "id") as SymbolId,
      from_module: strOpt(a, "from_module"),
    }),
  add_decorator: async (s, a) =>
    handleAddDecorator(s, {
      id: str(a, "id") as SymbolId,
      decorator_source: str(a, "decorator_source"),
    }),
  set_doc_comment: async (s, a) =>
    handleSetDocComment(s, {
      id: str(a, "id") as SymbolId,
      jsdoc_source: str(a, "jsdoc_source"),
    }),

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
