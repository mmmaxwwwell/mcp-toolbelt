import { TsMorphBackend } from "../backends/ts-morph.js";
import type { Session } from "../session.js";
import type { MutationResponse, PendingMutation, SymbolId, Warning } from "../types.js";

export async function handleEditSymbolSignature(
  session: Session,
  args: { id: SymbolId; signature: string }
): Promise<MutationResponse<PendingMutation>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("edit_symbol_signature: only ts-morph backend supported in v1");
  }
  const mutation = await backend.editSymbolSignature(args.id, args.signature);
  session.registerPending(mutation);
  const warnings: Warning[] = mutation.warnings ?? [];
  return { data: mutation, warnings };
}
