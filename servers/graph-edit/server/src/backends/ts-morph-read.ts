import { NotImplementedError } from "../errors.js";
import type {
  ModulePath,
  Reference,
  SymbolDetail,
  SymbolId,
  SymbolKind,
  SymbolRecord,
} from "../types.js";

export class TsMorphReadBackend {
  async listSymbols(
    _query?: string,
    _kinds?: SymbolKind[],
    _scope?: string
  ): Promise<SymbolRecord[]> {
    throw new NotImplementedError("list_symbols");
  }

  async getSymbol(_id: SymbolId): Promise<SymbolDetail> {
    throw new NotImplementedError("get_symbol");
  }

  async getReferences(_id: SymbolId): Promise<Reference[]> {
    throw new NotImplementedError("get_references");
  }

  async listModules(
    _pattern?: string
  ): Promise<Array<{ path: ModulePath; exports: string[]; imports_count: number }>> {
    throw new NotImplementedError("list_modules");
  }

  async describeModule(
    _path: ModulePath
  ): Promise<{
    exports: SymbolRecord[];
    imports: Array<{ module: ModulePath; symbols: string[] }>;
  }> {
    throw new NotImplementedError("describe_module");
  }
}
