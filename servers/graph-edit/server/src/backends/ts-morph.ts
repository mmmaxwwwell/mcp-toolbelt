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
import { TsMorphReadBackend } from "./ts-morph-read.js";
import { TsMorphSessionBackend } from "./ts-morph-session.js";
import { TsMorphWriteBackend } from "./ts-morph-write.js";

export class TsMorphBackend implements Backend {
  readonly name = "ts-morph";
  readonly extensions = [".ts", ".tsx", ".js", ".jsx"];

  readonly read = new TsMorphReadBackend();
  readonly write = new TsMorphWriteBackend();
  readonly session = new TsMorphSessionBackend();

  load(root: ProjectRoot, policy: PolicyConfig): Promise<void> {
    return this.session.load(root, policy);
  }
  reload(): Promise<void> {
    return this.session.reload();
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
  renameSymbol(id: SymbolId, newName: string): Promise<PendingMutation> {
    return this.write.renameSymbol(id, newName);
  }
  moveSymbol(id: SymbolId, target: ModulePath): Promise<PendingMutation> {
    return this.write.moveSymbol(id, target);
  }
  deleteSymbol(
    id: SymbolId,
    refactorCallers: "refuse" | "inline_last_use" | "leave_broken"
  ): Promise<PendingMutation> {
    return this.write.deleteSymbol(id, refactorCallers);
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
