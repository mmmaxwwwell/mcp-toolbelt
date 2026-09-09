import { TsMorphBackend } from "../backends/ts-morph.js";
import { renameSymbol } from "../backends/ts-morph-move.js";
import type { Session } from "../session.js";
import type { MutationResponse, PendingMutation, SymbolId } from "../types.js";

export async function handleRenameSymbol(
  session: Session,
  args: { id: SymbolId; new_name: string }
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("rename_symbol: only ts-morph backend supported in v1");
  }
  const result = await renameSymbol(
    backend.read.getProject(),
    backend.read.getRoot(),
    args.id,
    args.new_name
  );
  return { data: result.mutation, warnings: result.warnings };
}
