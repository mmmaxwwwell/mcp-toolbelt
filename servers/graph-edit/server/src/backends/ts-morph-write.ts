import { NotImplementedError } from "../errors.js";
import type { ModulePath, PendingMutation, SymbolId } from "../types.js";

export class TsMorphWriteBackend {
  async createSymbol(_args: unknown): Promise<PendingMutation> {
    throw new NotImplementedError("create_symbol");
  }

  async addMethod(_args: unknown): Promise<PendingMutation> {
    throw new NotImplementedError("add_method");
  }

  async addProperty(_args: unknown): Promise<PendingMutation> {
    throw new NotImplementedError("add_property");
  }

  async editSymbolBody(_id: SymbolId, _body: string): Promise<PendingMutation> {
    throw new NotImplementedError("edit_symbol_body");
  }

  async editSymbolSignature(_id: SymbolId, _signature: string): Promise<PendingMutation> {
    throw new NotImplementedError("edit_symbol_signature");
  }

  async renameSymbol(_id: SymbolId, _newName: string): Promise<PendingMutation> {
    throw new NotImplementedError("rename_symbol");
  }

  async moveSymbol(_id: SymbolId, _target: ModulePath): Promise<PendingMutation> {
    throw new NotImplementedError("move_symbol");
  }

  async deleteSymbol(
    _id: SymbolId,
    _refactorCallers: "refuse" | "inline_last_use" | "leave_broken"
  ): Promise<PendingMutation> {
    throw new NotImplementedError("delete_symbol");
  }

  async addImport(_args: unknown): Promise<PendingMutation> {
    throw new NotImplementedError("add_import");
  }

  async addExport(_args: unknown): Promise<PendingMutation> {
    throw new NotImplementedError("add_export");
  }

  async addDecorator(_id: SymbolId, _source: string): Promise<PendingMutation> {
    throw new NotImplementedError("add_decorator");
  }

  async setDocComment(_id: SymbolId, _source: string): Promise<PendingMutation> {
    throw new NotImplementedError("set_doc_comment");
  }

  async rawEditSymbol(_id: SymbolId, _newSource: string): Promise<PendingMutation> {
    throw new NotImplementedError("raw_edit_symbol");
  }
}
