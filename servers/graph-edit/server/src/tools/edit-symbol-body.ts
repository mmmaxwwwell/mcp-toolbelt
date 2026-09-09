import { TsMorphBackend } from "../backends/ts-morph.js";
import type { Session } from "../session.js";
import type { MutationResponse, PendingMutation, SymbolId, Warning } from "../types.js";

export async function handleEditSymbolBody(
  session: Session,
  args: { id: SymbolId; body: string }
): Promise<MutationResponse<PendingMutation>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("edit_symbol_body: only ts-morph backend supported in v1");
  }
  const mutation = await backend.editSymbolBody(args.id, args.body);
  session.registerPending(mutation);
  const warnings: Warning[] = mutation.warnings ?? [];
  return { data: mutation, warnings };
}
