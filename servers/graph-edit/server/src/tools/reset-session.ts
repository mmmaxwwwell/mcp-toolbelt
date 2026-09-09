import type { Session } from "../session.js";

export async function handleResetSession(session: Session): Promise<{ reset: true }> {
  await session.resetSession();
  return { reset: true };
}
