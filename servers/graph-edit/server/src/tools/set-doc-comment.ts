import { TsMorphBackend } from "../backends/ts-morph.js";
import * as imports from "../backends/ts-morph-imports.js";
import { RefusalError } from "../errors.js";
import type { Session } from "../session.js";
import type {
  MutationResponse,
  PendingMutation,
  SymbolId,
  Warning,
} from "../types.js";

export interface SetDocCommentArgs {
  id: SymbolId;
  jsdoc_source: string;
}

export async function handleSetDocComment(
  session: Session,
  args: SetDocCommentArgs
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("set_doc_comment: only ts-morph backend supported in v1");
  }
  try {
    const mut = await imports.setDocComment(
      backend.read.getProject(),
      backend.read.getRoot(),
      args.id,
      args.jsdoc_source
    );
    session.registerPending(mut);
    return { data: mut, warnings: mut.warnings ?? [] };
  } catch (err) {
    if (err instanceof RefusalError) {
      const warnings: Warning[] = [
        { kind: err.reason, message: err.message, symbol_id: args.id },
      ];
      return { data: null, warnings };
    }
    throw err;
  }
}
