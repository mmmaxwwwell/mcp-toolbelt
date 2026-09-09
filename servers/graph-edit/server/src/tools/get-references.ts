import { buildRelated } from "../related.js";
import { TsMorphBackend } from "../backends/ts-morph.js";
import type { Session } from "../session.js";
import type { NextCall, ReadResponse, Reference, SymbolId } from "../types.js";

export async function handleGetReferences(
  session: Session,
  id: SymbolId
): Promise<ReadResponse<Reference[]>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("get_references: only ts-morph backend supported in v1");
  }
  const project = backend.read.getProject();
  const root = backend.read.getRoot();

  const references = await backend.getReferences(id);
  const related = await buildRelated(project, root, id);

  const nextCalls: NextCall[] = [];
  if (references.length > 0) {
    nextCalls.push({
      tool: "get_symbol",
      args: { id },
      rationale: "review the target symbol's full detail alongside its call sites",
    });
    const first = references[0];
    nextCalls.push({
      tool: "describe_module",
      args: { path: first.file },
      rationale: "understand the caller module's exports and imports",
    });
  } else {
    nextCalls.push({
      tool: "get_symbol",
      args: { id },
      rationale: "no references found — inspect the definition to confirm it is used",
    });
  }

  return { data: references, related, next_calls: nextCalls };
}
