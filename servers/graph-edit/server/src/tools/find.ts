import type { Project } from "ts-morph";
import type {
  NextCall,
  ProjectRoot,
  RelatedItem,
  SymbolId,
  SymbolKind,
} from "../types.js";
import { NameSearchIndex, type NameHit } from "../search/name-search.js";
import { parseUsageQuery, runUsageSearch, type UsageHit } from "../search/usage-search.js";

export type FindMode = "name" | "usage" | "concept" | "auto";

export interface FindArgs {
  query: string;
  kinds?: SymbolKind[];
  scope?: string;
  mode?: FindMode;
}

export interface FindHit {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  signature: string;
  snippet: string;
  score: number;
  source_index: "name" | "usage";
}

export interface FindResponse {
  hits: number;
  top: FindHit[];
  related: RelatedItem[];
  next_calls: NextCall[];
  message?: string;
  error?: string;
}

const AUTO_MIN_HITS = 3;
const AUTO_MIN_SCORE = 0.4;
const TOP_N = 10;
const REFUSE_FLOOD = 20;

export interface FindContext {
  project: Project;
  root: ProjectRoot;
  index: NameSearchIndex;
  buildRelated?: (project: Project, root: ProjectRoot, id: SymbolId, limit?: number) => Promise<RelatedItem[]>;
}

export async function runFind(ctx: FindContext, args: FindArgs): Promise<FindResponse> {
  const mode: FindMode = args.mode ?? "auto";

  if (mode === "concept") {
    return {
      hits: 0,
      top: [],
      related: [],
      next_calls: [],
      error: "concept search deferred to v2 — use mode:'name' or mode:'usage'",
    };
  }

  ctx.index.ensureBuilt(ctx.project, ctx.root);

  if (mode === "name") {
    return finalizeNameResponse(ctx, args);
  }
  if (mode === "usage") {
    return finalizeUsageResponse(ctx, args);
  }

  // auto: name first; if weak, fall back to usage
  const nameResults = ctx.index.search(args.query, { kinds: args.kinds, scope: args.scope });
  const topScore = nameResults[0]?.score ?? 0;
  if (nameResults.length >= AUTO_MIN_HITS && topScore >= AUTO_MIN_SCORE) {
    return finalizeNameResponse(ctx, args, nameResults);
  }
  const parsed = parseUsageQuery(args.query);
  if (parsed) {
    const usageResp = await finalizeUsageResponse(ctx, args);
    if (usageResp.hits > 0) return usageResp;
  }
  return finalizeNameResponse(ctx, args, nameResults);
}

async function finalizeNameResponse(
  ctx: FindContext,
  args: FindArgs,
  precomputed?: NameHit[]
): Promise<FindResponse> {
  const results =
    precomputed ?? ctx.index.search(args.query, { kinds: args.kinds, scope: args.scope });
  const hits = results.length;

  if (hits > REFUSE_FLOOD) {
    return {
      hits,
      top: results.slice(0, 5).map(toFindHit),
      related: [],
      next_calls: [],
      message: "narrow with kinds= or scope=",
    };
  }

  const top = results.slice(0, TOP_N).map(toFindHit);
  const related = await computeRelated(ctx, top);
  const next_calls = suggestNextCalls(top);
  return { hits, top, related, next_calls };
}

async function finalizeUsageResponse(
  ctx: FindContext,
  args: FindArgs
): Promise<FindResponse> {
  const parsed = parseUsageQuery(args.query);
  if (!parsed) {
    return finalizeNameResponse(ctx, args);
  }

  const usageHits: UsageHit[] = runUsageSearch(ctx.project, ctx.root, ctx.index, parsed);
  const filtered = filterUsageHits(usageHits, args);
  const hits = filtered.length;

  if (hits > REFUSE_FLOOD) {
    return {
      hits,
      top: filtered.slice(0, 5).map(toFindHitFromUsage),
      related: [],
      next_calls: [],
      message: "narrow with kinds= or scope=",
    };
  }

  const top = filtered.slice(0, TOP_N).map(toFindHitFromUsage);
  const related = await computeRelated(ctx, top);
  const next_calls = suggestNextCalls(top);
  return { hits, top, related, next_calls };
}

function filterUsageHits(hits: UsageHit[], args: FindArgs): UsageHit[] {
  let out = hits;
  if (args.kinds && args.kinds.length > 0) {
    const set = new Set(args.kinds);
    out = out.filter((h) => set.has(h.kind));
  }
  if (args.scope && args.scope.startsWith("sym:")) {
    const hashIdx = args.scope.indexOf("#");
    if (hashIdx > 0) {
      const scopeModule = args.scope.slice(4, hashIdx);
      out = out.filter((h) => h.id.startsWith(`sym:${scopeModule}#`));
    }
  }
  return out;
}

function toFindHit(h: NameHit): FindHit {
  return {
    id: h.id,
    kind: h.kind,
    name: h.name,
    signature: h.signature,
    snippet: h.snippet,
    score: h.score,
    source_index: "name",
  };
}

function toFindHitFromUsage(h: UsageHit): FindHit {
  return {
    id: h.id,
    kind: h.kind,
    name: h.name,
    signature: h.signature,
    snippet: h.snippet,
    score: h.score,
    source_index: "usage",
  };
}

async function computeRelated(ctx: FindContext, top: FindHit[]): Promise<RelatedItem[]> {
  if (!ctx.buildRelated || top.length === 0) return [];
  try {
    return await ctx.buildRelated(ctx.project, ctx.root, top[0].id, 3);
  } catch {
    return [];
  }
}

function suggestNextCalls(top: FindHit[]): NextCall[] {
  if (top.length === 0) return [];
  const first = top[0];
  const out: NextCall[] = [
    {
      tool: "open_symbol",
      args: { id_or_query: first.id },
      rationale: "open the top hit for full context",
    },
  ];
  const highScoring = top.filter((h) => h.score >= 0.5);
  if (highScoring.length >= 2) {
    out.push({
      tool: "describe_change_zone",
      args: { id: first.id },
      rationale: "multiple strong hits — inspect blast radius before editing",
    });
  }
  return out;
}
