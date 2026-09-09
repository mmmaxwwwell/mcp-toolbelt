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

export interface AddExportArgs {
  id: SymbolId;
  from_module?: string;
}

export async function handleAddExport(
  session: Session,
  args: AddExportArgs
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("add_export: only ts-morph backend supported in v1");
  }
  try {
    const mut = await imports.addExport(backend.read.getProject(), backend.read.getRoot(), args);
    session.registerPending(mut);
    return { data: mut, warnings: mut.warnings ?? [] };
  } catch (err) {
    if (err instanceof RefusalError) {
      const warnings: Warning[] = [{ kind: err.reason, message: err.message }];
      return { data: null, warnings };
    }
    throw err;
  }
}
