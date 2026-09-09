import { RefusalError } from "../errors.js";
import type { Session } from "../session.js";
import type { CommitResult } from "../types.js";

export async function handleCommit(
  session: Session,
  args: { accept_breaking_callers?: boolean }
): Promise<CommitResult | { refused: true; reason: string; message: string }> {
  try {
    return await session.commit(args.accept_breaking_callers ?? false);
  } catch (err) {
    if (err instanceof RefusalError) {
      // Preserve pending state so the agent can inspect / fix / retry.
      return {
        refused: true,
        reason: err.reason,
        message: err.message,
      };
    }
    throw err;
  }
}
