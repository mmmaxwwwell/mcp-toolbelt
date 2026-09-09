import { NotImplementedError } from "./errors.js";
import { NameSearchIndex } from "./search/name-search.js";
import { runFind, type FindResponse } from "./tools/find.js";
import { drainWarnings } from "./backends/ts-morph-imports.js";
import type {
  Backend,
  BreakingCaller,
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
  Warning,
} from "./types.js";
import type { Project } from "ts-morph";

export interface SessionOptions {
  root: ProjectRoot;
  policy: PolicyConfig;
  backend: Backend;
}

export interface SessionSummary {
  pending_count: number;
  symbols_touched: SymbolId[];
  files_touched: ModulePath[];
  breaking_callers_pending: BreakingCaller[];
  diff_preview: string;
}

// PendingWithSidecar: 2A's sidecar shape (Phase 2 create/method used
// `__warnings`). We drain that field into `mut.warnings` at push time.
type PendingWithSidecar = PendingMutation & { __warnings?: Warning[] };

export class Session {
  readonly root: ProjectRoot;
  readonly policy: PolicyConfig;
  readonly backend: Backend;
  loaded = false;
  private readonly nameIndex = new NameSearchIndex();

  // Phase 3 state.
  pending: PendingMutation[] = [];
  breakingHistory: BreakingCaller[] = [];
  warnings: Warning[] = [];

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

  private sessionBackend(): {
    preview: (pending: PendingMutation[]) => Promise<PreviewResult>;
    previewTypes: (pending: PendingMutation[]) => Promise<PreviewResult["type_check"]>;
    commit: (
      pending: PendingMutation[],
      breakingHistory: BreakingCaller[],
      warnings: Warning[],
      acceptBreakingCallers: boolean
    ) => Promise<CommitResult>;
    discard: (pending: PendingMutation[]) => void;
    reload: () => Promise<void>;
  } {
    const b = this.backend as unknown as {
      session?: {
        preview: (pending: PendingMutation[]) => Promise<PreviewResult>;
        previewTypes: (pending: PendingMutation[]) => Promise<PreviewResult["type_check"]>;
        commit: (
          pending: PendingMutation[],
          breakingHistory: BreakingCaller[],
          warnings: Warning[],
          acceptBreakingCallers: boolean
        ) => Promise<CommitResult>;
        discard: (pending: PendingMutation[]) => void;
        reload: () => Promise<void>;
      };
    };
    if (!b.session) throw new NotImplementedError("session", "session backend unavailable");
    return b.session;
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

  // Track a produced PendingMutation: drain sidecar warnings from 2A/2D and
  // stash on both mut.warnings AND the session-level warnings roll-up.
  registerPending(mut: PendingMutation | PendingWithSidecar): PendingMutation {
    const warnings: Warning[] = [];
    // 2A sidecar: __warnings on the mutation.
    const anyMut = mut as PendingWithSidecar;
    if (Array.isArray(anyMut.__warnings)) {
      warnings.push(...anyMut.__warnings);
      delete anyMut.__warnings;
    }
    // 2D side-channel map keyed by mutation id.
    try {
      warnings.push(...drainWarnings(mut.id));
    } catch {
      // ignore
    }
    if (warnings.length > 0) {
      mut.warnings = [...(mut.warnings ?? []), ...warnings];
      this.warnings.push(...warnings);
    }
    if (mut.breaking_callers && mut.breaking_callers.length > 0) {
      this.breakingHistory.push(...mut.breaking_callers);
    }
    this.pending.push(mut);
    return mut;
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
    const mut = await this.backend.createSymbol(args);
    return this.registerPending(mut);
  }

  async addMethod(args: unknown): Promise<PendingMutation> {
    await this.ensureLoaded();
    const mut = await this.backend.addMethod(args);
    return this.registerPending(mut);
  }

  async addProperty(args: unknown): Promise<PendingMutation> {
    await this.ensureLoaded();
    const mut = await this.backend.addProperty(args);
    return this.registerPending(mut);
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
    await this.ensureLoaded();
    return this.sessionBackend().preview(this.pending);
  }

  async previewTypes(): Promise<PreviewResult["type_check"]> {
    await this.ensureLoaded();
    return this.sessionBackend().previewTypes(this.pending);
  }

  async commit(acceptBreakingCallers: boolean): Promise<CommitResult> {
    await this.ensureLoaded();
    const result = await this.sessionBackend().commit(
      this.pending,
      this.breakingHistory,
      this.warnings,
      acceptBreakingCallers
    );
    // Success path: clear session state.
    this.pending = [];
    this.breakingHistory = [];
    this.warnings = [];
    return result;
  }

  discard(): void {
    if (this.pending.length === 0) return;
    this.sessionBackend().discard(this.pending);
    this.pending = [];
    this.breakingHistory = [];
    this.warnings = [];
  }

  async resetSession(): Promise<void> {
    await this.ensureLoaded();
    // Delegate to the read backend's fullReload if available; falls back to
    // per-file refresh via session backend's reload.
    const anyBackend = this.backend as unknown as {
      read?: { fullReload?: () => Promise<void> };
    };
    if (typeof anyBackend.read?.fullReload === "function") {
      await anyBackend.read.fullReload();
    } else {
      await this.sessionBackend().reload();
    }
    this.pending = [];
    this.breakingHistory = [];
    this.warnings = [];
  }

  async sessionSummary(): Promise<SessionSummary> {
    await this.ensureLoaded();
    if (this.pending.length === 0) {
      return {
        pending_count: 0,
        symbols_touched: [],
        files_touched: [],
        breaking_callers_pending: [],
        diff_preview: "",
      };
    }
    const preview = await this.sessionBackend().preview(this.pending);
    const symbols = new Set<SymbolId>();
    const files = new Set<ModulePath>();
    for (const p of this.pending) {
      if (p.target) symbols.add(p.target);
      for (const f of extractTouchedFromMut(p)) files.add(f);
    }
    return {
      pending_count: this.pending.length,
      symbols_touched: [...symbols],
      files_touched: [...files],
      breaking_callers_pending: [...this.breakingHistory],
      diff_preview: preview.diff.slice(0, 2000),
    };
  }

  // ---- Bundled ----
  async openSymbol(_idOrQuery: string): Promise<unknown> {
    throw new NotImplementedError("open_symbol");
  }

  async explore(intent: string, target?: string): Promise<unknown> {
    const { handleExplore } = await import("./tools/explore.js");
    return handleExplore(this, { intent, target });
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

function extractTouchedFromMut(mut: PendingMutation): ModulePath[] {
  const raw = mut.raw_ops as Record<string, unknown> | undefined;
  const out: ModulePath[] = [];
  if (!raw || typeof raw !== "object") return out;
  const pushIf = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  pushIf(raw.target_file);
  pushIf(raw.file);
  pushIf(raw.new_module);
  pushIf(raw.target_module);
  pushIf(raw.from_module);
  pushIf(raw.source_module);
  if (Array.isArray(raw.touched_files)) {
    for (const t of raw.touched_files) if (typeof t === "string") out.push(t);
  }
  if (Array.isArray(raw.files_touched)) {
    for (const t of raw.files_touched) if (typeof t === "string") out.push(t);
  }
  return out;
}
