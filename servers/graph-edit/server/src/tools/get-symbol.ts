import { buildRelated } from "../related.js";
import { TsMorphBackend } from "../backends/ts-morph.js";
import type { Session } from "../session.js";
import type {
  NextCall,
  ReadResponse,
  RelatedItem,
  SymbolDetail,
  SymbolId,
} from "../types.js";

export async function handleGetSymbol(
  session: Session,
  args: { id: SymbolId }
): Promise<ReadResponse<SymbolDetail>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("get_symbol: only ts-morph backend supported in v1");
  }
  const detail = await backend.read.getSymbol(args.id);

  const related = await computeRelated(backend, detail.id);
  const next_calls: NextCall[] = [
    {
      tool: "get_references",
      args: { id: detail.id },
      rationale: "See every call/type/import site for this symbol.",
    },
    {
      tool: "describe_module",
      args: { path: detail.defined_in },
      rationale: "See what else lives in this module.",
    },
  ];
  return { data: detail, related, next_calls };
}

async function computeRelated(backend: TsMorphBackend, id: SymbolId): Promise<RelatedItem[]> {
  try {
    return await buildRelated(backend.read.getProject(), backend.read.getRoot(), id, 3);
  } catch {
    return [];
  }
}
