// Identity
export type SymbolId = string;  // "sym:<project-relative-path>#<qualified-name>"
export type ModulePath = string;  // project-relative "src/foo/bar.ts"
export type ProjectRoot = string;  // absolute path

// Symbol kinds (aligned with ts-morph SyntaxKind but backend-agnostic)
export type SymbolKind =
  | "class" | "function" | "interface" | "type" | "enum"
  | "variable" | "method" | "property" | "namespace";

// Read-side records
export interface SymbolRecord {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  module: ModulePath;
  signature: string;
  doc?: string;
  is_exported: boolean;
  visibility?: "public" | "private" | "protected";
}

export interface SymbolDetail extends SymbolRecord {
  source_render: string;      // formatted source of the symbol
  body?: string;              // just the body (for functions/methods)
  references_count: number;
  defined_in: ModulePath;
  members?: SymbolRecord[];   // for classes/interfaces/enums
}

export interface Reference {
  file: ModulePath;
  line: number;
  column: number;
  context_line: string;
  kind: "call" | "type_ref" | "import" | "reexport" | "extends" | "implements";
}

// Response envelopes — universal across read tools
export interface RelatedItem {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  reason: string;  // "called by target" | "same module sibling" | ...
}

export interface NextCall {
  tool: string;
  args: Record<string, unknown>;
  rationale: string;
}

export interface ReadResponse<T> {
  data: T;
  related: RelatedItem[];
  next_calls: NextCall[];
}

// Mutation response
export interface Warning {
  kind: "unused_import" | "stale_doc" | "layout_bypass" | "naming_convention" | string;
  message: string;
  symbol_id?: SymbolId;
}

export interface MutationResponse<T = { mutation_id: string }> {
  data: T;
  warnings: Warning[];
}

// Session-level records
export interface BreakingCaller {
  caller_id: SymbolId;
  file: ModulePath;
  line: number;
  kind_of_break: "signature_arity" | "return_type" | "removed_symbol" | "renamed_symbol" | string;
  message: string;
}

export interface PendingMutation {
  id: string;                // uuid
  kind: string;              // tool name that produced it
  target?: SymbolId;
  breaking_callers?: BreakingCaller[];
  raw_ops: unknown;          // backend-specific op record
  // Phase 3 amendment: additive optional field. Session collects sidecar
  // warnings (from create/imports/etc.) into this slot when pushing into
  // session.pending so downstream consumers have one place to look.
  warnings?: Warning[];
}

// Preview shape
export interface PreviewResult {
  diff: string;
  type_check: "pass" | Array<{ file: ModulePath; line: number; message: string }>;
  formatter: "applied" | "skipped_missing" | "skipped_error";
  imports_added: Array<{ module: ModulePath; source: string }>;
  imports_removed: Array<{ module: ModulePath; source: string }>;
  tests_likely_affected: ModulePath[];
  breaking_callers: BreakingCaller[];
}

// Commit shape
export interface CommitResult {
  diff: string;
  intent_recap: string;
  files_written: ModulePath[];
  files_deleted: ModulePath[];
  warnings: Warning[];
}

// Policy config (from .graph-edit.toml — see README for full example)
export interface PolicyConfig {
  project: { tsconfig: string; root_dir: string };
  layout: {
    one_class_per_file?: boolean;
    one_component_per_file?: boolean;
    function_grouping?: "topic" | "one_per_file" | "keep_existing";
    groups: Array<{ name: string; pattern: string; target_dir: string; naming?: string }>;
  };
  imports: { sort_order: string[]; absolute_prefix?: string; merge_duplicates: boolean; remove_unused: boolean };
  naming: Record<string, string>;
  reexports: { barrel_files: "auto" | "manual" | "none"; public_marker: string };
  formatter: { command: string; args: string[]; skip_if_missing: boolean };
  type_check: { strict: boolean };
}

// Backend interface (implemented per language)
export interface Backend {
  name: string;
  extensions: string[];  // [".ts", ".tsx", ".js", ".jsx"] for ts-morph

  load(root: ProjectRoot, policy: PolicyConfig): Promise<void>;
  reload(): Promise<void>;

  // Read
  listSymbols(query?: string, kinds?: SymbolKind[], scope?: string): Promise<SymbolRecord[]>;
  getSymbol(id: SymbolId): Promise<SymbolDetail>;
  getReferences(id: SymbolId): Promise<Reference[]>;
  listModules(pattern?: string): Promise<Array<{ path: ModulePath; exports: string[]; imports_count: number }>>;
  describeModule(path: ModulePath): Promise<{ exports: SymbolRecord[]; imports: Array<{ module: ModulePath; symbols: string[] }> }>;

  // Write (return PendingMutation, don't touch disk)
  createSymbol(args: unknown): Promise<PendingMutation>;
  addMethod(args: unknown): Promise<PendingMutation>;
  addProperty(args: unknown): Promise<PendingMutation>;
  editSymbolBody(id: SymbolId, body: string): Promise<PendingMutation>;
  editSymbolSignature(id: SymbolId, signature: string): Promise<PendingMutation>;
  renameSymbol(id: SymbolId, newName: string): Promise<PendingMutation>;
  moveSymbol(id: SymbolId, target: ModulePath): Promise<PendingMutation>;
  deleteSymbol(id: SymbolId, refactorCallers: "refuse" | "inline_last_use" | "leave_broken"): Promise<PendingMutation>;
  addImport(args: unknown): Promise<PendingMutation>;
  addExport(args: unknown): Promise<PendingMutation>;
  addDecorator(id: SymbolId, source: string): Promise<PendingMutation>;
  setDocComment(id: SymbolId, source: string): Promise<PendingMutation>;

  // Session
  preview(): Promise<PreviewResult>;
  previewTypes(): Promise<PreviewResult["type_check"]>;
  commit(acceptBreakingCallers: boolean): Promise<CommitResult>;
  discard(): void;

  // Bundled (delegated to backend for language-specific enrichment)
  openSymbol(idOrQuery: string): Promise<unknown>;  // shape defined in Phase 4
  describeChangeZone(id: SymbolId): Promise<unknown>;
  similarTo(id: SymbolId, k?: number): Promise<unknown>;
}
