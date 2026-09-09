import type { Session } from "../session.js";
import type { PreviewResult } from "../types.js";

export async function handlePreview(session: Session): Promise<PreviewResult> {
  return session.preview();
}
