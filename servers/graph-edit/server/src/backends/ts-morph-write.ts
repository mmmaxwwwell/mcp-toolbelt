import { NotImplementedError } from "../errors.js";
import type { ModulePath, PendingMutation, SymbolId } from "../types.js";
import type { TsMorphReadBackend } from "./ts-morph-read.js";
import * as create from "./ts-morph-create.js";
import * as edit from "./ts-morph-edit.js";
import * as move from "./ts-morph-move.js";
import * as imports from "./ts-morph-imports.js";

export class TsMorphWriteBackend {
  constructor(private readonly read: TsMorphReadBackend) {}

  private project() {
    return this.read.getProject();
  }
  private root() {
    return this.read.getRoot();
  }

  createSymbol(args: unknown): Promise<PendingMutation> {
    return create.createSymbol(this.project(), this.root(), args as create.CreateSymbolArgs);
  }
  addMethod(args: unknown): Promise<PendingMutation> {
    return create.addMethod(this.project(), this.root(), args as create.AddMethodArgs);
  }
  addProperty(args: unknown): Promise<PendingMutation> {
    return create.addProperty(this.project(), this.root(), args as create.AddPropertyArgs);
  }

  editSymbolBody(id: SymbolId, body: string): Promise<PendingMutation> {
    return edit.editSymbolBody(this.project(), this.root(), id, body);
  }
  editSymbolSignature(id: SymbolId, signature: string): Promise<PendingMutation> {
    return edit.editSymbolSignature(this.project(), this.root(), id, signature);
  }

  renameSymbol(id: SymbolId, newName: string): Promise<move.MoveResult> {
    return move.renameSymbol(this.project(), this.root(), id, newName);
  }
  moveSymbol(id: SymbolId, target: ModulePath): Promise<move.MoveResult> {
    return move.moveSymbol(this.project(), this.root(), id, target);
  }
  deleteSymbol(
    id: SymbolId,
    refactorCallers: "refuse" | "inline_last_use" | "leave_broken"
  ): Promise<move.MoveResult> {
    return move.deleteSymbol(this.project(), this.root(), id, refactorCallers);
  }

  addImport(args: unknown): Promise<PendingMutation> {
    return imports.addImport(this.project(), this.root(), args as imports.AddImportArgs);
  }
  addExport(args: unknown): Promise<PendingMutation> {
    return imports.addExport(this.project(), this.root(), args as imports.AddExportArgs);
  }
  addDecorator(id: SymbolId, source: string): Promise<PendingMutation> {
    return imports.addDecorator(this.project(), this.root(), id, source);
  }
  setDocComment(id: SymbolId, source: string): Promise<PendingMutation> {
    return imports.setDocComment(this.project(), this.root(), id, source);
  }

  async rawEditSymbol(_id: SymbolId, _newSource: string): Promise<PendingMutation> {
    throw new NotImplementedError("raw_edit_symbol");
  }
}
