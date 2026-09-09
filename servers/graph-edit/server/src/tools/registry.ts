import type { Session } from "../session.js";
import { dispatch } from "./_stubs.js";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolEntry {
  schema: ToolSchema;
  handler: (session: Session, args: Record<string, unknown>) => Promise<unknown>;
}

const SYMBOL_KINDS = [
  "class",
  "function",
  "interface",
  "type",
  "enum",
  "variable",
  "method",
  "property",
  "namespace",
];

const VISIBILITY = ["public", "private", "protected"];

// -------- Read (5) --------
const readTools: ToolSchema[] = [
  {
    name: "list_symbols",
    description:
      "List symbols in the project. Filter by name query, kind (class/function/interface/type/enum/variable/method/property/namespace), and module glob. Returns [{ id, kind, name, module, signature }].",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name substring or pattern to filter by." },
        kind: {
          oneOf: [
            { type: "string", enum: SYMBOL_KINDS },
            { type: "array", items: { type: "string", enum: SYMBOL_KINDS } },
          ],
          description: "Symbol kind or array of kinds.",
        },
        module: { type: "string", description: "Module glob to restrict search to." },
      },
    },
  },
  {
    name: "get_symbol",
    description:
      "Full detail for one symbol: signature, source_render, doc_comment, references_count, defined_in, members. Prefer open_symbol for a bundled view with callers + tests + related.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Symbol id (sym:<module>#<qualifiedName>)." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_references",
    description:
      "Every call/read/import/type-ref site for a symbol. Returns [{ file, line, column, context_line, kind }].",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Symbol id." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_modules",
    description:
      "The module graph. Returns [{ path, exports: [...], imports_count }]. Optional glob restricts the listing.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Module glob (e.g. 'src/services/**')." },
      },
    },
  },
  {
    name: "describe_module",
    description:
      "Signatures of everything exported from a module, plus what the module imports.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative module path." },
      },
      required: ["path"],
    },
  },
];

// -------- Write — structural (8) --------
const writeStructuralTools: ToolSchema[] = [
  {
    name: "create_symbol",
    description:
      "Create a new function / class / interface / type / enum / variable. module is optional; if omitted, [layout] policy decides placement (refuses if ambiguous).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: SYMBOL_KINDS, description: "Symbol kind." },
        name: { type: "string" },
        module: { type: "string", description: "Optional target module path." },
        signature: { type: "string", description: "Full signature source." },
        body: { type: "string", description: "Body source for functions/methods." },
        doc: { type: "string", description: "JSDoc source." },
      },
      required: ["kind", "name", "signature"],
    },
  },
  {
    name: "add_method",
    description:
      "Add a method to a class. Signature parsed to insert at policy-decided position (function_grouping).",
    inputSchema: {
      type: "object",
      properties: {
        class_id: { type: "string" },
        name: { type: "string" },
        signature: { type: "string" },
        body: { type: "string" },
        visibility: { type: "string", enum: VISIBILITY },
        static: { type: "boolean" },
      },
      required: ["class_id", "name", "signature", "body"],
    },
  },
  {
    name: "add_property",
    description: "Add a property to a class.",
    inputSchema: {
      type: "object",
      properties: {
        class_id: { type: "string" },
        name: { type: "string" },
        type: { type: "string", description: "Type annotation source." },
        initializer: { type: "string" },
        visibility: { type: "string", enum: VISIBILITY },
        readonly: { type: "boolean" },
      },
      required: ["class_id", "name", "type"],
    },
  },
  {
    name: "edit_symbol_body",
    description:
      "Replace the body of a function or method. Signature untouched. Fast — no cross-file effects.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
      },
      required: ["id", "body"],
    },
  },
  {
    name: "edit_symbol_signature",
    description:
      "Change params / return type. Response includes breaking_callers; commit will refuse unless accept_breaking_callers=true covers those failures.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        signature: { type: "string" },
      },
      required: ["id", "signature"],
    },
  },
  {
    name: "rename_symbol",
    description:
      "Atomic project-wide rename: updates definition and every reference across files. Refuses on name clash in the target scope.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        new_name: { type: "string" },
      },
      required: ["id", "new_name"],
    },
  },
  {
    name: "move_symbol",
    description:
      "Move a definition to another module. Rewrites imports at every call site. If source module becomes empty, marks it for deletion.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        target_module: { type: "string" },
      },
      required: ["id", "target_module"],
    },
  },
  {
    name: "delete_symbol",
    description:
      "Remove a symbol. If callers exist, refactor_callers must be one of: 'refuse' (reject) | 'inline_last_use' (only if 1 trivial caller) | 'leave_broken' (agent takes responsibility).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        refactor_callers: {
          type: "string",
          enum: ["refuse", "inline_last_use", "leave_broken"],
        },
      },
      required: ["id"],
    },
  },
];

// -------- Write — supporting (4) --------
const writeSupportingTools: ToolSchema[] = [
  {
    name: "add_import",
    description:
      "Add an import declaration to a file. Usually automatic; exposed for side-effect and dynamic imports the inferrer can't handle. Dedupes and sorts per policy.",
    inputSchema: {
      type: "object",
      properties: {
        target_module: { type: "string", description: "File to add the import to." },
        module_path: { type: "string", description: "Module being imported from." },
        imports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              alias: { type: "string" },
            },
            required: ["name"],
          },
        },
      },
      required: ["module_path", "imports"],
    },
  },
  {
    name: "add_export",
    description:
      "Add or re-export a symbol from a module. Barrel-file regeneration happens on commit per [reexports] policy.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        from_module: { type: "string", description: "Module to add the export to." },
      },
      required: ["id"],
    },
  },
  {
    name: "add_decorator",
    description: "Prepend a decorator to a symbol declaration. Validates decorator syntax.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        decorator_source: { type: "string", description: "Full decorator source, e.g. '@Injectable()'." },
      },
      required: ["id", "decorator_source"],
    },
  },
  {
    name: "set_doc_comment",
    description: "Replace or add a JSDoc block on a symbol. Preserves indentation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        jsdoc_source: { type: "string" },
      },
      required: ["id", "jsdoc_source"],
    },
  },
];

// -------- Session (6) --------
const sessionTools: ToolSchema[] = [
  {
    name: "preview",
    description:
      "Health check + diff for the pending mutation set. Returns { diff, type_check: pass/errors, formatter, imports_added, imports_removed, tests_likely_affected, breaking_callers }. Cheap — always call before commit.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "preview_types",
    description:
      "Run the type checker only (tsc --noEmit) against the pending session. Fastest way to gate an edit on type-safety without generating a full diff.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "commit",
    description:
      "Write pending mutations to disk, run the formatter, trigger a code-graph re-index. Refuses on type errors unless accept_breaking_callers=true AND failures match a prior breaking_callers list.",
    inputSchema: {
      type: "object",
      properties: {
        accept_breaking_callers: {
          type: "boolean",
          description:
            "Allow commit despite type errors — only if the errors are covered by a prior edit_symbol_signature / delete_symbol response's breaking_callers list.",
        },
      },
    },
  },
  {
    name: "discard",
    description: "Drop pending mutations. Keeps the session open. Fast.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reset_session",
    description:
      "Re-parse the project from disk. Use when another process has edited files or you want a clean session after a task switch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "session_summary",
    description:
      "Compact summary of pending state: pending_count, symbols_touched, files_touched, breaking_callers_pending, diff_preview. Useful for producing a PR-description-quality intent recap.",
    inputSchema: { type: "object", properties: {} },
  },
];

// -------- Bundled (5) --------
const bundledTools: ToolSchema[] = [
  {
    name: "open_symbol",
    description:
      "Workhorse read tool: returns symbol + callers + type deps + siblings + tests + related in one shot. Prefer over list_symbols + get_symbol + get_references.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_query: {
          type: "string",
          description: "Symbol id (sym:...) or a name query resolved to the best match.",
        },
      },
      required: ["id_or_query"],
    },
  },
  {
    name: "explore",
    description:
      "Task-oriented briefing: given a natural-language intent (and optional target symbol), returns relevant symbols + patterns + related infra + tests + the file .graph-edit.toml would pick for a new symbol. Replaces 10+ exploratory calls with 1.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "What you're trying to do." },
        target: { type: "string", description: "Optional symbol id to anchor the briefing on." },
      },
      required: ["intent"],
    },
  },
  {
    name: "describe_change_zone",
    description:
      "Pre-edit blast radius: every caller + type-ref + mocking test + re-export, plus is_public_api heuristic. Call before edit_symbol_signature / delete_symbol / rename_symbol.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "similar_to",
    description:
      "Show k other symbols like this one (same-module + same-kind + shared type refs for v1). Answers 'what convention do peers use?' without grepping.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        k: { type: "number", description: "How many neighbors to return (default 5)." },
      },
      required: ["id"],
    },
  },
  {
    name: "find",
    description:
      "Search over symbols. mode: 'name' (FTS5, exact identifiers, fastest) | 'usage' (graph query for callers/constructors) | 'concept' (vector index over doc comments — deferred to v2; returns a clean error in v1) | 'auto' (default: try name, escalate to usage on low confidence). Refuses hit floods (>20) with a narrowing hint.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kinds: { type: "array", items: { type: "string", enum: SYMBOL_KINDS } },
        scope: { type: "string", description: "Module glob or symbol id to restrict search." },
        mode: {
          type: "string",
          enum: ["name", "concept", "usage", "auto"],
          description: "Search index to consult.",
        },
      },
      required: ["query"],
    },
  },
];

// -------- Escape hatch (1) --------
const escapeHatchTools: ToolSchema[] = [
  {
    name: "raw_edit_symbol",
    description:
      "Escape hatch: replace a symbol's entire source with a raw string. Bypasses AST tooling but still runs through formatter + type check. Use rarely — every use erodes the 'server owns organization' guarantee.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        new_source: { type: "string" },
      },
      required: ["id", "new_source"],
    },
  },
];

export const ALL_TOOLS: ToolSchema[] = [
  ...readTools,
  ...writeStructuralTools,
  ...writeSupportingTools,
  ...sessionTools,
  ...bundledTools,
  ...escapeHatchTools,
];

export function buildRegistry(): Map<string, ToolEntry> {
  const map = new Map<string, ToolEntry>();
  for (const schema of ALL_TOOLS) {
    map.set(schema.name, {
      schema,
      handler: (session, args) => dispatch(session, schema.name, args),
    });
  }
  return map;
}

export const TOOL_COUNT = ALL_TOOLS.length;
