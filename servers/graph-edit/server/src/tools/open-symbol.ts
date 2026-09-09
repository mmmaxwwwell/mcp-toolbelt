import { TsMorphBackend } from "../backends/ts-morph.js";
import type { OpenSymbolData } from "../backends/ts-morph-bundled.js";
import { buildRelated } from "../related.js";
import type { Session } from "../session.js";
import type { NextCall, ReadResponse, RelatedItem } from "../types.js";

export async function handleOpenSymbol(
  session: Session,
  args: { id_or_query: string }
): Promise<ReadResponse<OpenSymbolData>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("open_symbol: only ts-morph backend supported in v1");
  }

  const data = (await backend.bundled.openSymbol(args.id_or_query)) as OpenSymbolData;

  const related = await computeRelated(backend, data.symbol.id);
  const next_calls = buildNextCalls(data);

  return { data, related, next_calls };
}

async function computeRelated(
  backend: TsMorphBackend,
  id: string
): Promise<RelatedItem[]> {
  try {
    return await buildRelated(backend.read.getProject(), backend.read.getRoot(), id, 3);
  } catch {
    return [];
  }
}

function buildNextCalls(data: OpenSymbolData): NextCall[] {
  const out: NextCall[] = [];
  if (data.callers.length > 0) {
    out.push({
      tool: "describe_change_zone",
      args: { id: data.symbol.id },
      rationale: "callers exist — inspect blast radius before editing the signature",
    });
  }
  if (data.siblings.length > 0) {
    // Suggest the first sibling; downstream agents can decide whether to open.
    const sib = data.siblings[0];
    out.push({
      tool: "open_symbol",
      args: { id_or_query: sib.id },
      rationale: `open sibling export '${sib.name}' for module context`,
    });
  }
  if (data.tests.length > 0) {
    out.push({
      tool: "find",
      args: { query: data.tests[0], mode: "name" },
      rationale: "sibling tests exist — locate them by name for follow-up",
    });
  }
  return out.slice(0, 3);
}
