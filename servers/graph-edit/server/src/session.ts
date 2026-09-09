import { NotImplementedError } from "./errors.js";
import type {
  Backend,
  CommitResult,
  ModulePath,
  MutationResponse,
  PolicyConfig,
  PreviewResult,
  ProjectRoot,
  ReadResponse,
  Reference,
  SymbolDetail,
  SymbolId,
  SymbolKind,
  SymbolRecord,
} from "./types.js";

export interface SessionOptions {
  root: ProjectRoot;
  policy: PolicyConfig;
  backend: Backend;
}

export class Session {
  readonly root: ProjectRoot;
  readonly policy: PolicyConfig;
  readonly backend: Backend;
  loaded = false;

  constructor(opts: SessionOptions) {
    this.root = opts.root;
    this.policy = opts.policy;
    this.backend = opts.backend;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // Real load happens in Phase 3; keep skeleton no-op-throw semantics for now.
    throw new NotImplementedError("session.load");
  }

  // ---- Read tools ----
  async listSymbols(
    _query?: string,
    _kinds?: SymbolKind[],
    _scope?: string
  ): Promise<ReadResponse<SymbolRecord[]>> {
    throw new NotImplementedError("list_symbols");
  }

  async getSymbol(_id: SymbolId): Promise<ReadResponse<SymbolDetail>> {
    throw new NotImplementedError("get_symbol");
  }

  async getReferences(_id: SymbolId): Promise<ReadResponse<Reference[]>> {
    throw new NotImplementedError("get_references");
  }

  async listModules(
    _pattern?: string
  ): Promise<ReadResponse<Array<{ path: ModulePath; exports: string[]; imports_count: number }>>> {
    throw new NotImplementedError("list_modules");
  }

  async describeModule(
    _path: ModulePath
  ): Promise<
    ReadResponse<{
      exports: SymbolRecord[];
      imports: Array<{ module: ModulePath; symbols: string[] }>;
    }>
  > {
    throw new NotImplementedError("describe_module");
  }

  // ---- Write structural ----
  async createSymbol(_args: unknown): Promise<MutationResponse> {
    throw new NotImplementedError("create_symbol");
  }

  async addMethod(_args: unknown): Promise<MutationResponse> {
    throw new NotImplementedError("add_method");
  }

  async addProperty(_args: unknown): Promise<MutationResponse> {
    throw new NotImplementedError("add_property");
  }

  async editSymbolBody(_id: SymbolId, _body: string): Promise<MutationResponse> {
    throw new NotImplementedError("edit_symbol_body");
  }

  async editSymbolSignature(_id: SymbolId, _signature: string): Promise<MutationResponse> {
    throw new NotImplementedError("edit_symbol_signature");
  }

  async renameSymbol(_id: SymbolId, _newName: string): Promise<MutationResponse> {
    throw new NotImplementedError("rename_symbol");
  }

  async moveSymbol(_id: SymbolId, _target: ModulePath): Promise<MutationResponse> {
    throw new NotImplementedError("move_symbol");
  }

  async deleteSymbol(
    _id: SymbolId,
    _refactorCallers: "refuse" | "inline_last_use" | "leave_broken"
  ): Promise<MutationResponse> {
    throw new NotImplementedError("delete_symbol");
  }

  // ---- Write supporting ----
  async addImport(_args: unknown): Promise<MutationResponse> {
    throw new NotImplementedError("add_import");
  }

  async addExport(_args: unknown): Promise<MutationResponse> {
    throw new NotImplementedError("add_export");
  }

  async addDecorator(_id: SymbolId, _source: string): Promise<MutationResponse> {
    throw new NotImplementedError("add_decorator");
  }

  async setDocComment(_id: SymbolId, _source: string): Promise<MutationResponse> {
    throw new NotImplementedError("set_doc_comment");
  }

  async rawEditSymbol(_id: SymbolId, _newSource: string): Promise<MutationResponse> {
    throw new NotImplementedError("raw_edit_symbol");
  }

  // ---- Session lifecycle ----
  async preview(): Promise<PreviewResult> {
    throw new NotImplementedError("preview");
  }

  async previewTypes(): Promise<PreviewResult["type_check"]> {
    throw new NotImplementedError("preview_types");
  }

  async commit(_acceptBreakingCallers: boolean): Promise<CommitResult> {
    throw new NotImplementedError("commit");
  }

  discard(): void {
    throw new NotImplementedError("discard");
  }

  async resetSession(): Promise<void> {
    throw new NotImplementedError("reset_session");
  }

  async sessionSummary(): Promise<unknown> {
    throw new NotImplementedError("session_summary");
  }

  // ---- Bundled ----
  async openSymbol(_idOrQuery: string): Promise<unknown> {
    throw new NotImplementedError("open_symbol");
  }

  async explore(_intent: string, _target?: string): Promise<unknown> {
    throw new NotImplementedError("explore");
  }

  async describeChangeZone(_id: SymbolId): Promise<unknown> {
    throw new NotImplementedError("describe_change_zone");
  }

  async similarTo(_id: SymbolId, _k?: number): Promise<unknown> {
    throw new NotImplementedError("similar_to");
  }

  async find(
    _query: string,
    _opts?: { kinds?: SymbolKind[]; scope?: string; mode?: "name" | "concept" | "usage" | "auto" }
  ): Promise<unknown> {
    throw new NotImplementedError("find");
  }
}
