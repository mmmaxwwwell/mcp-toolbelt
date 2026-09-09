import { RefusalError } from "../errors.js";
import type { Session } from "../session.js";
import type {
  MutationResponse,
  PendingMutation,
  Warning,
} from "../types.js";

export interface AddPropertyArgs {
  class_id: string;
  name: string;
  type: string;
  initializer?: string;
  visibility?: "public" | "private" | "protected";
  readonly?: boolean;
}

export async function handleAddProperty(
  session: Session,
  args: AddPropertyArgs
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  try {
    const pending = (await session.addProperty(args)) as PendingMutation & {
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
