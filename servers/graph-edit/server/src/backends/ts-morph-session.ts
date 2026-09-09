import { NotImplementedError } from "../errors.js";
import type {
  CommitResult,
  PolicyConfig,
  PreviewResult,
  ProjectRoot,
  SymbolId,
} from "../types.js";

export class TsMorphSessionBackend {
  async load(_root: ProjectRoot, _policy: PolicyConfig): Promise<void> {
    throw new NotImplementedError("session.load");
  }

  async reload(): Promise<void> {
    throw new NotImplementedError("reset_session");
  }

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

  async openSymbol(_idOrQuery: string): Promise<unknown> {
    throw new NotImplementedError("open_symbol");
  }

  async describeChangeZone(_id: SymbolId): Promise<unknown> {
    throw new NotImplementedError("describe_change_zone");
  }

  async similarTo(_id: SymbolId, _k?: number): Promise<unknown> {
    throw new NotImplementedError("similar_to");
  }
}
