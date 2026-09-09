import type {
  Backend,
  CommitResult,
  ModulePath,
  PendingMutation,
  PolicyConfig,
  PreviewResult,
  ProjectRoot,
  Reference,
  SymbolDetail,
  SymbolId,
  SymbolKind,
  SymbolRecord,
} from "../types.js";
import { RefusalError } from "../errors.js";
import { TsMorphReadBackend } from "./ts-morph-read.js";
import { TsMorphSessionBackend } from "./ts-morph-session.js";
import { TsMorphWriteBackend } from "./ts-morph-write.js";
import type { MoveResult } from "./ts-morph-move.js";

function unwrapMove(result: MoveResult): PendingMutation {
  // The Backend interface returns PendingMutation. Refusals from
  // rename/move/delete are first-class response shapes; consumers that go
  // through the Backend interface (rather than the tool handler) get a
  // RefusalError. Tool handlers call the move module directly and preserve
  // the { data: null, warnings } envelope.
  if (result.mutation) return result.mutation;
  const w = result.warnings[0];
  throw new RefusalError(w?.kind ?? "refused", w?.message);
}

export class TsMorphBackend implements Backend {
  readonly name = "ts-morph";
  readonly extensions = [".ts", ".tsx", ".js", ".jsx"];

  readonly read = new TsMorphReadBackend();
  readonly write = new TsMorphWriteBackend(this.read);
  readonly session = new TsMorphSessionBackend();

  async load(root: ProjectRoot, policy: PolicyConfig): Promise<void> {
    await this.read.load(root, policy);
  }
  async reload(): Promise<void> {
    await this.read.reload();
  }

  listSymbols(query?: string, kinds?: SymbolKind[], scope?: string): Promise<SymbolRecord[]> {
    return this.read.listSymbols(query, kinds, scope);
  }
  getSymbol(id: SymbolId): Promise<SymbolDetail> {
    return this.read.getSymbol(id);
  }
  getReferences(id: SymbolId): Promise<Reference[]> {
    return this.read.getReferences(id);
  }
  listModules(
    pattern?: string
  ): Promise<Array<{ path: ModulePath; exports: string[]; imports_count: number }>> {
    return this.read.listModules(pattern);
  }
  describeModule(
    path: ModulePath
  ): Promise<{
    exports: SymbolRecord[];
    imports: Array<{ module: ModulePath; symbols: string[] }>;
  }> {
    return this.read.describeModule(path);
  }

  createSymbol(args: unknown): Promise<PendingMutation> {
    return this.write.createSymbol(args);
  }
  addMethod(args: unknown): Promise<PendingMutation> {
    return this.write.addMethod(args);
  }
  addProperty(args: unknown): Promise<PendingMutation> {
    return this.write.addProperty(args);
  }
  editSymbolBody(id: SymbolId, body: string): Promise<PendingMutation> {
    return this.write.editSymbolBody(id, body);
  }
  editSymbolSignature(id: SymbolId, signature: string): Promise<PendingMutation> {
    return this.write.editSymbolSignature(id, signature);
  }
  async renameSymbol(id: SymbolId, newName: string): Promise<PendingMutation> {
    return unwrapMove(await this.write.renameSymbol(id, newName));
  }
  async moveSymbol(id: SymbolId, target: ModulePath): Promise<PendingMutation> {
    return unwrapMove(await this.write.moveSymbol(id, target));
  }
  async deleteSymbol(
    id: SymbolId,
    refactorCallers: "refuse" | "inline_last_use" | "leave_broken"
  ): Promise<PendingMutation> {
    return unwrapMove(await this.write.deleteSymbol(id, refactorCallers));
  }
  addImport(args: unknown): Promise<PendingMutation> {
    return this.write.addImport(args);
  }
  addExport(args: unknown): Promise<PendingMutation> {
    return this.write.addExport(args);
  }
  addDecorator(id: SymbolId, source: string): Promise<PendingMutation> {
    return this.write.addDecorator(id, source);
  }
  setDocComment(id: SymbolId, source: string): Promise<PendingMutation> {
    return this.write.setDocComment(id, source);
  }
  rawEditSymbol(id: SymbolId, newSource: string): Promise<PendingMutation> {
    return this.write.rawEditSymbol(id, newSource);
  }

  preview(): Promise<PreviewResult> {
    return this.session.preview();
  }
  previewTypes(): Promise<PreviewResult["type_check"]> {
    return this.session.previewTypes();
  }
  commit(acceptBreakingCallers: boolean): Promise<CommitResult> {
    return this.session.commit(acceptBreakingCallers);
  }
  discard(): void {
    this.session.discard();
  }

  openSymbol(idOrQuery: string): Promise<unknown> {
    return this.session.openSymbol(idOrQuery);
  }
  describeChangeZone(id: SymbolId): Promise<unknown> {
    return this.session.describeChangeZone(id);
  }
  similarTo(id: SymbolId, k?: number): Promise<unknown> {
    return this.session.similarTo(id, k);
  }
}
