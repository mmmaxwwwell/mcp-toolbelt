import { buildRelated } from "../related.js";
import { TsMorphBackend } from "../backends/ts-morph.js";
import type { Session } from "../session.js";
import type {
  NextCall,
  ReadResponse,
  RelatedItem,
  SymbolKind,
  SymbolRecord,
} from "../types.js";

export interface ListSymbolsArgs {
  query?: string;
  kind?: SymbolKind | SymbolKind[];
  module?: string;
}

export async function handleListSymbols(
  session: Session,
  args: ListSymbolsArgs
): Promise<ReadResponse<SymbolRecord[]>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("list_symbols: only ts-morph backend supported in v1");
  }
  const kinds = normalizeKinds(args.kind);
  const records = await backend.read.listSymbols(args.query, kinds, args.module);

  const related = await computeRelated(backend, records);
  const next_calls = buildNextCalls(records);
  return { data: records, related, next_calls };
}

function normalizeKinds(kind?: SymbolKind | SymbolKind[]): SymbolKind[] | undefined {
  if (!kind) return undefined;
  return Array.isArray(kind) ? kind : [kind];
}

async function computeRelated(
  backend: TsMorphBackend,
  records: SymbolRecord[]
): Promise<RelatedItem[]> {
  if (records.length === 0) return [];
  try {
    return await buildRelated(
      backend.read.getProject(),
      backend.read.getRoot(),
      records[0].id,
      3
    );
  } catch {
    return [];
  }
}

function buildNextCalls(records: SymbolRecord[]): NextCall[] {
  if (records.length === 0) return [];
  const top = records[0];
  return [
    {
      tool: "get_symbol",
      args: { id: top.id },
      rationale: `Full detail for top hit '${top.name}'.`,
    },
    {
      tool: "describe_module",
      args: { path: top.module },
      rationale: `Module containing top hit ('${top.module}').`,
    },
  ];
}
