import { TsMorphBackend } from "../backends/ts-morph.js";
import type { Session } from "../session.js";
import type {
  ModulePath,
  NextCall,
  ReadResponse,
  SymbolRecord,
} from "../types.js";

export async function handleDescribeModule(
  session: Session,
  args: { path: ModulePath }
): Promise<
  ReadResponse<{
    exports: SymbolRecord[];
    imports: Array<{ module: ModulePath; symbols: string[] }>;
  }>
> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("describe_module: only ts-morph backend supported in v1");
  }
  const desc = await backend.read.describeModule(args.path);

  const topExport = pickMostReferenced(backend, desc.exports);
  const next_calls: NextCall[] = [];
  if (topExport) {
    next_calls.push({
      tool: "open_symbol",
      args: { id_or_query: topExport.id },
      rationale: `Open the most-referenced export '${topExport.name}'.`,
    });
  }
  return { data: desc, related: [], next_calls };
}

function pickMostReferenced(
  backend: TsMorphBackend,
  exports: SymbolRecord[]
): SymbolRecord | null {
  if (exports.length === 0) return null;
  const project = backend.read.getProject();
  const ls = project.getLanguageService();
  let best: { rec: SymbolRecord; count: number } | null = null;
  for (const rec of exports) {
    try {
      const decl = backend.read.resolveSymbolIdToNode(rec.id);
      if (!decl) continue;
      const nameNode = (decl as unknown as { getNameNode?: () => unknown }).getNameNode?.();
      if (!nameNode) continue;
      const count = ls.findReferencesAsNodes(nameNode as never).length;
      if (!best || count > best.count) best = { rec, count };
    } catch {
      // skip individual symbol failures
    }
  }
  return best?.rec ?? exports[0];
}
