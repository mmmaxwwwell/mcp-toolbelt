import { RefusalError } from "../errors.js";
import type { Session } from "../session.js";
import type {
  MutationResponse,
  PendingMutation,
  Warning,
} from "../types.js";

export interface AddMethodArgs {
  class_id: string;
  name: string;
  signature: string;
  body: string;
  visibility?: "public" | "private" | "protected";
  static?: boolean;
}

export async function handleAddMethod(
  session: Session,
  args: AddMethodArgs
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  try {
    const pending = (await session.addMethod(args)) as PendingMutation & {
      __warnings?: Warning[];
    };
    const warnings = pending.__warnings ?? [];
    if (pending.__warnings) delete pending.__warnings;
    return { data: pending, warnings };
  } catch (err) {
    if (err instanceof RefusalError) {
      return {
        data: null,
        warnings: [{ kind: "refused", message: err.message }],
      };
    }
    throw err;
  }
}
