import type { Session } from "../session.js";

export async function handleDiscard(
  session: Session
): Promise<{ discarded: true; count: number }> {
  const count = session.pending.length;
  session.discard();
  return { discarded: true, count };
}
