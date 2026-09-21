import { runPnpm, type RunSandboxInput } from "./pnpm.js";

export interface DepEntry {
  name: string;
  version: string;
  dev: boolean;
}

export interface Delta {
  added: DepEntry[];
  removed: DepEntry[];
  updated: Array<{ name: string; from: string; to: string; dev: boolean }>;
}

// Pre/post-list snapshots need to run inside the same sandbox as the main
// invocation — the sandbox tmpfs'es $HOME, so a snapshot run outside it
// would see a different view of the pnpm store.
export async function snapshotDeps(
  sandbox: RunSandboxInput
): Promise<DepEntry[]> {
  const r = await runPnpm(["list", "--depth=0", "--json"], sandbox, {
    timeoutMs: 60_000,
  });
  if (r.code !== 0 && !r.stdout) return [];
  return parsePnpmList(r.stdout);
}

function parsePnpmList(json: string): DepEntry[] {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const entries: DepEntry[] = [];
  const projects: any[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const proj of projects) {
    if (!proj || typeof proj !== "object") continue;
    collect(proj.dependencies, false, entries);
    collect(proj.devDependencies, true, entries);
    collect(proj.optionalDependencies, false, entries);
  }
  return entries;
}

function collect(
  section: Record<string, any> | undefined,
  dev: boolean,
  out: DepEntry[]
): void {
  if (!section) return;
  for (const [name, info] of Object.entries(section)) {
    const version =
      info && typeof info === "object" && "version" in (info as any)
        ? String((info as any).version)
        : "";
    out.push({ name, version, dev });
  }
}

export function computeDelta(before: DepEntry[], after: DepEntry[]): Delta {
  const beforeMap = new Map(before.map((d) => [d.name, d]));
  const afterMap = new Map(after.map((d) => [d.name, d]));

  const added: DepEntry[] = [];
  const removed: DepEntry[] = [];
  const updated: Delta["updated"] = [];

  for (const [name, entry] of afterMap) {
    const prev = beforeMap.get(name);
    if (!prev) {
      added.push(entry);
    } else if (prev.version !== entry.version) {
      updated.push({
        name,
        from: prev.version,
        to: entry.version,
        dev: entry.dev,
      });
    }
  }
  for (const [name, entry] of beforeMap) {
    if (!afterMap.has(name)) removed.push(entry);
  }

  return { added, removed, updated };
}
