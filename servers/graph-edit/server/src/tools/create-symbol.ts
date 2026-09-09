import { LayoutAmbiguousError, RefusalError } from "../errors.js";
import type { Session } from "../session.js";
import type {
  MutationResponse,
  PendingMutation,
  Warning,
} from "../types.js";

export interface CreateSymbolArgs {
  kind: string;
  name: string;
  module?: string;
  signature: string;
  body?: string;
  doc?: string;
}

export async function handleCreateSymbol(
  session: Session,
  args: CreateSymbolArgs
): Promise<MutationResponse<PendingMutation | null>> {
  await session.ensureLoaded();
  try {
    const pending = (await session.createSymbol(args)) as PendingMutation & {
      __warnings?: Warning[];
    };
    const warnings = pending.__warnings ?? [];
    if (pending.__warnings) delete pending.__warnings;
    return { data: pending, warnings };
  } catch (err) {
    // Refuse cleanly for layout-ambiguous / policy-refusal outcomes instead
    // of surfacing as an MCP error. The handler is the boundary that turns
    // controlled failures into a well-formed response envelope.
    if (err instanceof LayoutAmbiguousError) {
      return {
        data: null,
        warnings: [
          {
            kind: "layout_ambiguous",
            message: err.message,
          },
        ],
      };
    }
    if (err instanceof RefusalError) {
      return {
        data: null,
        warnings: [{ kind: "refused", message: err.message }],
      };
    }
    throw err;
  }
}
