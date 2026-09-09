import type { Session, SessionSummary } from "../session.js";

export async function handleSessionSummary(session: Session): Promise<SessionSummary> {
  return session.sessionSummary();
}
