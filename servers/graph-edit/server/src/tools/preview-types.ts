import type { Session } from "../session.js";
import type { PreviewResult } from "../types.js";

export async function handlePreviewTypes(
  session: Session
): Promise<{ type_check: PreviewResult["type_check"] }> {
  const type_check = await session.previewTypes();
  return { type_check };
}
