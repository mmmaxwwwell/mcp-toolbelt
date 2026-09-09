import { NotImplementedError } from "./errors.js";
import { NameSearchIndex } from "./search/name-search.js";
import { runFind, type FindResponse } from "./tools/find.js";
import type {
  Backend,
  CommitResult,
  ModulePath,
  MutationResponse,
  PendingMutation,
  PolicyConfig,
  PreviewResult,
  ProjectRoot,
  ReadResponse,
  Reference,
  RelatedItem,
  SymbolDetail,
  SymbolId,
  SymbolKind,
  SymbolRecord,
} from "./types.js";
import type { Project } from "ts-morph";

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
  private readonly nameIndex = new NameSearchIndex();

  constructor(opts: SessionOptions) {
    this.root = opts.root;
    this.policy = opts.policy;
    this.backend = opts.backend;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      await this.backend.load(this.root, this.policy);
      this.loaded = true;
      return;
    } catch (err) {
      if (!(err instanceof NotImplementedError)) throw err;
    }
    // Fallback: some backends split load across sub-modules (e.g. ts-morph read backend
    // is loadable independently of the session backend during Phase 1 development).
    const readBackend = (this.backend as unknown as {
      read?: { load?: (r: ProjectRoot, p: PolicyConfig) => Promise<void> };
    }).read;
    if (readBackend?.load) {
      await readBackend.load(this.root, this.policy);
      this.loaded = true;
      return;
    }
    throw new NotImplementedError("session.load");
  }

  private getProjectForRead(): Project {
    const readBackend = this.backend as unknown as {
      read?: { getProject?: () => Project };
    };
    const getProject = readBackend.read?.getProject;
    if (!getProject) throw new NotImplementedError("session.load", "read backend project unavailable");
    return getProject.call(readBackend.read);
  }

  private async loadBuildRelated(): Promise<
    | ((project: Project, root: ProjectRoot, id: SymbolId, limit?: number) => Promise<RelatedItem[]>)
    | undefined
  > {
    try {
      const mod = (await import("./related.js")) as {
        buildRelated?: (
          project: Project,
          root: ProjectRoot,
          id: SymbolId,
          limit?: number
        ) => Promise<RelatedItem[]>;
      };
      return mod.buildRelated;
    } catch {
      return undefined;
    }
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
  async createSymbol(args: unknown): Promise<PendingMutation> {
    await this.ensureLoaded();
    return this.backend.createSymbol(args);
  }

  async addMethod(args: unknown): Promise<PendingMutation> {
    await this.ensureLoaded();
    return this.backend.addMethod(args);
  }

  async addProperty(args: unknown): Promise<PendingMutation> {
    await this.ensureLoaded();
    return this.backend.addProperty(args);
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
    query: string,
    opts?: { kinds?: SymbolKind[]; scope?: string; mode?: "name" | "concept" | "usage" | "auto" }
  ): Promise<FindResponse> {
    await this.ensureLoaded();
    const project = this.getProjectForRead();
    const buildRelated = await this.loadBuildRelated();
    return runFind(
      { project, root: this.root, index: this.nameIndex, buildRelated },
      { query, kinds: opts?.kinds, scope: opts?.scope, mode: opts?.mode }
    );
  }
}
