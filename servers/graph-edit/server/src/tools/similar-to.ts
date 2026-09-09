import { TsMorphBackend } from "../backends/ts-morph.js";
import type { SimilarResult } from "../backends/ts-morph-bundled.js";
import { buildRelated } from "../related.js";
import type { Session } from "../session.js";
import type { NextCall, ReadResponse, RelatedItem, SymbolId } from "../types.js";

export async function handleSimilarTo(
  session: Session,
  args: { id: SymbolId; k?: number }
): Promise<ReadResponse<SimilarResult[]>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("similar_to: only ts-morph backend supported in v1");
  }

  const k = args.k ?? 5;
  const data = (await backend.bundled.similarTo(args.id, k)) as SimilarResult[];

  const related = await computeRelated(backend, args.id);
  const next_calls: NextCall[] = [];
  if (data.length > 0) {
    next_calls.push({
      tool: "open_symbol",
      args: { id_or_query: data[0].id },
      rationale: `open the most-similar peer '${data[0].name}' to compare implementations`,
    });
  }

  return { data, related, next_calls };
}

async function computeRelated(
  backend: TsMorphBackend,
  id: SymbolId
): Promise<RelatedItem[]> {
  try {
    return await buildRelated(backend.read.getProject(), backend.read.getRoot(), id, 3);
  } catch {
    return [];
  }
}
