import { TsMorphBackend } from "../backends/ts-morph.js";
import type { Session } from "../session.js";
import type { ModulePath, NextCall, ReadResponse } from "../types.js";

export async function handleListModules(
  session: Session,
  args: { pattern?: string }
): Promise<ReadResponse<Array<{ path: ModulePath; exports: string[]; imports_count: number }>>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("list_modules: only ts-morph backend supported in v1");
  }
  const modules = await backend.read.listModules(args.pattern);

  const next_calls: NextCall[] = [];
  if (modules.length > 0) {
    next_calls.push({
      tool: "describe_module",
      args: { path: modules[0].path },
      rationale: `Inspect exports of '${modules[0].path}'.`,
    });
  }
  return { data: modules, related: [], next_calls };
}
