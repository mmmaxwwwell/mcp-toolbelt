import { TsMorphBackend } from "../backends/ts-morph.js";
import * as imports from "../backends/ts-morph-imports.js";
import { RefusalError } from "../errors.js";
import type { Session } from "../session.js";
import type { MutationResponse, PendingMutation, Warning } from "../types.js";

export interface AddImportArgs {
  target_module?: string;
  module_path: string;
  imports: Array<{ name: string; alias?: string }>;
}

export async function handleAddImport(
  session: Session,
  args: AddImportArgs
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("add_import: only ts-morph backend supported in v1");
  }
  try {
    const mut = await imports.addImport(backend.read.getProject(), backend.read.getRoot(), args);
    return imports.toMutationResponse(mut);
  } catch (err) {
    if (err instanceof RefusalError) {
      const warnings: Warning[] = [{ kind: err.reason, message: err.message }];
      return { data: null, warnings };
    }
    throw err;
  }
}
