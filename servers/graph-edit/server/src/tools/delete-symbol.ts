import { TsMorphBackend } from "../backends/ts-morph.js";
import { deleteSymbol } from "../backends/ts-morph-move.js";
import type { Session } from "../session.js";
import type { MutationResponse, PendingMutation, SymbolId } from "../types.js";

export type RefactorCallers = "refuse" | "inline_last_use" | "leave_broken";

export async function handleDeleteSymbol(
  session: Session,
  args: { id: SymbolId; refactor_callers?: RefactorCallers }
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("delete_symbol: only ts-morph backend supported in v1");
  }
  const mode: RefactorCallers = args.refactor_callers ?? "refuse";
  const result = await deleteSymbol(
    backend.read.getProject(),
    backend.read.getRoot(),
    args.id,
    mode
  );
  return { data: result.mutation, warnings: result.warnings };
}
