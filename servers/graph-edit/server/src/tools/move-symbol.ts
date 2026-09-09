import { TsMorphBackend } from "../backends/ts-morph.js";
import { moveSymbol } from "../backends/ts-morph-move.js";
import type { Session } from "../session.js";
import type { ModulePath, MutationResponse, PendingMutation, SymbolId } from "../types.js";

export async function handleMoveSymbol(
  session: Session,
  args: { id: SymbolId; target_module: ModulePath }
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("move_symbol: only ts-morph backend supported in v1");
  }
  const result = await moveSymbol(
    backend.read.getProject(),
    backend.read.getRoot(),
    args.id,
    args.target_module
  );
  return { data: result.mutation, warnings: result.warnings };
}
