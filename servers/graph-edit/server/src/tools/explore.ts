import { relative, basename } from "node:path";
import micromatch from "micromatch";
import type { Project, SourceFile } from "ts-morph";
import { TsMorphBackend } from "../backends/ts-morph.js";
import { LayoutAmbiguousError } from "../errors.js";
import { layoutForNewSymbol } from "../layout.js";
import { buildRelated } from "../related.js";
import type { Session } from "../session.js";
import type {
  ModulePath,
  NextCall,
  ProjectRoot,
  RelatedItem,
  SymbolDetail,
  SymbolId,
  SymbolKind,
} from "../types.js";

export interface ExploreArgs {
  intent: string;
  target?: string;
}

export interface ExplorePattern {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  module: ModulePath;
  signature: string;
  why: string;
}

export interface ExploreRelevantImport {
  module: string; // the imported module specifier (not necessarily project-relative)
  symbols: string[];
}

export interface ExploreRelatedInfra {
  relevant_imports: ExploreRelevantImport[];
  config_files: ModulePath[];
  env_vars: string[];
}

export interface ExploreLayoutPreview {
  module: ModulePath;
  naming: string;
}

export interface ExploreData {
  target: SymbolDetail | null;
  patterns: ExplorePattern[];
  related_infra: ExploreRelatedInfra;
  tests: ModulePath[];
  layout_preview: ExploreLayoutPreview;
}

export interface ExploreResponse {
  data: ExploreData;
  related: RelatedItem[];
  next_calls: NextCall[];
}

// Stop-words dropped during keyword extraction. Kept small: only closed-class
// words that carry no signal about what the intent is *about*.
const STOP_WORDS = new Set([
  "add", "to", "the", "a", "for", "is", "of", "with", "and", "or",
  "in", "on", "at", "by", "an", "be", "it", "this", "that", "into",
  "from", "as", "using", "use",
]);

// Domain markers: intent keyword → import module substrings that indicate
// the same domain. These help the "relevant_imports" walk pick up
// vocabulary the intent uses without needing exact substring matches.
const DOMAIN_MARKERS: Record<string, string[]> = {
  cache: ["redis", "ioredis", "memcached", "lru-cache", "node-cache", "cache-manager"],
  caching: ["redis", "ioredis", "memcached", "lru-cache", "node-cache", "cache-manager"],
  auth: ["passport", "jwt", "jsonwebtoken", "oauth", "@auth", "next-auth"],
  authn: ["passport", "jwt", "jsonwebtoken", "oauth"],
  authz: ["casbin", "@casl", "accesscontrol"],
  login: ["passport", "jwt", "oauth"],
  queue: ["bullmq", "bull", "sqs", "@aws-sdk/client-sqs", "amqplib", "kafkajs"],
  jobs: ["bullmq", "bull", "agenda"],
  log: ["winston", "pino", "bunyan", "log4js"],
  logging: ["winston", "pino", "bunyan", "log4js"],
  metrics: ["prom-client", "statsd", "@opentelemetry"],
  trace: ["@opentelemetry", "dd-trace"],
  tracing: ["@opentelemetry", "dd-trace"],
  http: ["axios", "got", "node-fetch", "undici"],
  fetch: ["axios", "got", "node-fetch", "undici"],
  api: ["axios", "got", "node-fetch", "undici", "express", "fastify", "@nestjs"],
  db: ["pg", "mysql", "mysql2", "mongodb", "mongoose", "typeorm", "prisma", "knex", "drizzle-orm"],
  database: ["pg", "mysql", "mysql2", "mongodb", "mongoose", "typeorm", "prisma", "knex", "drizzle-orm"],
  sql: ["pg", "mysql", "mysql2", "knex", "drizzle-orm", "kysely"],
  rate: ["express-rate-limit", "rate-limiter-flexible", "bottleneck"],
  limit: ["express-rate-limit", "rate-limiter-flexible", "bottleneck"],
  limiting: ["express-rate-limit", "rate-limiter-flexible", "bottleneck"],
  throttle: ["bottleneck", "p-throttle", "lodash.throttle"],
  retry: ["p-retry", "async-retry", "retry"],
  circuit: ["opossum"],
  websocket: ["ws", "socket.io"],
  event: ["eventemitter3", "mitt", "rxjs"],
  events: ["eventemitter3", "mitt", "rxjs"],
  test: ["jest", "vitest", "mocha", "chai", "sinon"],
  validation: ["zod", "yup", "joi", "class-validator", "ajv"],
  crypto: ["bcrypt", "argon2", "crypto-js"],
};

// Config-ish filename patterns for `related_infra.config_files`.
const CONFIG_PATTERNS = [
  ".env",
  ".env.*",
  "*.env",
  "*.config.js",
  "*.config.ts",
  "*.config.mjs",
  "*.config.cjs",
  "tsconfig*.json",
  "package.json",
  ".graph-edit.toml",
];

// Test-file patterns (project-relative).
const TEST_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/__tests__/**/*.{ts,tsx,js,jsx}",
];

const SYMBOL_HINT_RX = /[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)?/g;
const ENV_VAR_RX = /process\.env\.([A-Z][A-Z0-9_]*)/g;

export async function handleExplore(
  session: Session,
  args: ExploreArgs
): Promise<ExploreResponse> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("explore: only ts-morph backend supported in v1");
  }
  const project = backend.read.getProject();
  const root = backend.read.getRoot();
  const policy = backend.read.getPolicy();

  const { keywords, symbolHints } = extractIntent(args.intent);

  // 1. Target resolution.
  const target = await resolveTarget(backend, args.target, symbolHints);

  // 2. Patterns via name-search.
  const patterns = collectPatterns(project, root, keywords, target?.id);

  // 3. Related infra.
  const relevant_imports = collectRelevantImports(project, root, keywords);
  const config_files = collectConfigFiles(project, root);
  const env_vars = collectEnvVars(project, keywords);

  // 4. Tests.
  const tests = collectTests(project, root, target?.defined_in);

  // 5. Layout preview.
  const layout_preview = computeLayoutPreview(
    project,
    root,
    policy,
    keywords,
    target,
  );

  // 6. Related items.
  const anchorId = target?.id ?? patterns[0]?.id;
  let related: RelatedItem[] = [];
  if (anchorId) {
    try {
      related = await buildRelated(project, root, anchorId, 3);
    } catch {
      related = [];
    }
  }

  // 7. Next calls.
  const next_calls = buildNextCalls(target, patterns, keywords);

  return {
    data: {
      target,
      patterns,
      related_infra: { relevant_imports, config_files, env_vars },
      tests,
      layout_preview,
    },
    related,
    next_calls,
  };
}

interface ExtractedIntent {
  keywords: string[];
  symbolHints: string[];
}

function extractIntent(intent: string): ExtractedIntent {
  // Grab symbol-shaped identifiers first so we can suggest a target hint.
  const symbolHints: string[] = [];
  for (const match of intent.matchAll(SYMBOL_HINT_RX)) {
    symbolHints.push(match[0]);
  }

  // Tokenize on non-alphanumeric so quoted/backticked symbols split cleanly.
  const rawTokens = intent
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

  // Preserve first-seen order; drop stop words + very short tokens.
  const seen = new Set<string>();
  const kws: string[] = [];
  for (const t of rawTokens) {
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    kws.push(t);
  }

  // Cap to 8 salient tokens.
  return { keywords: kws.slice(0, 8), symbolHints };
}

async function resolveTarget(
  backend: TsMorphBackend,
  explicit: string | undefined,
  symbolHints: string[]
): Promise<SymbolDetail | null> {
  if (explicit && explicit.length > 0) {
    // Accept sym:... ids directly; otherwise try to interpret as a name query.
    try {
      if (explicit.startsWith("sym:")) {
        return await backend.read.getSymbol(explicit);
      }
    } catch {
      // fall through to name-based resolution
    }
    const byName = await resolveByName(backend, explicit);
    if (byName) return byName;
  }

  for (const hint of symbolHints) {
    const detail = await resolveByName(backend, hint);
    if (detail) return detail;
  }
  return null;
}

async function resolveByName(
  backend: TsMorphBackend,
  query: string
): Promise<SymbolDetail | null> {
  // Support qualified names like "UserService.load" by peeling the class part
  // first, then retrying with the head token if the qualified form misses.
  const candidates = query.includes(".") ? [query, query.split(".")[0]] : [query];
  for (const q of candidates) {
    let records;
    try {
      records = await backend.read.listSymbols(q);
    } catch {
      continue;
    }
    if (!records || records.length === 0) continue;
    // Prefer exact name match, then case-insensitive equality, then first hit.
    const exact = records.find((r) => r.name === q);
    const ci = records.find((r) => r.name.toLowerCase() === q.toLowerCase());
    const rec = exact ?? ci ?? records[0];
    try {
      return await backend.read.getSymbol(rec.id);
    } catch {
      continue;
    }
  }
  return null;
}

function collectPatterns(
  project: Project,
  root: ProjectRoot,
  keywords: string[],
  excludeId?: SymbolId
): ExplorePattern[] {
  if (keywords.length === 0) return [];
  const seen = new Set<SymbolId>();
  const out: ExplorePattern[] = [];
  // Expand keywords with morphological siblings so "caching" also matches
  // symbols named after "cache" (and vice versa).
  const expanded = expandKeywordsForPatternScan(keywords);
  for (const kw of expanded) {
    if (out.length >= 10) break;
    const hits = scanSymbolsByKeyword(project, root, kw, 5);
    for (const h of hits) {
      if (out.length >= 10) break;
      if (excludeId && h.id === excludeId) continue;
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      const { score: _score, ...rest } = h;
      out.push({ ...rest, why: `matches keyword: ${kw}` });
    }
  }
  return out;
}

// Expand each keyword with common morphological variants.
// Preserves order + dedups. Trivial rules only — we deliberately avoid a
// stemmer dep here.
function expandKeywordsForPatternScan(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (w: string) => {
    if (w.length < 2 || seen.has(w)) return;
    seen.add(w);
    out.push(w);
  };
  for (const kw of keywords) {
    push(kw);
    // "caching" → "cache" (stem+e) first, then bare stem "cach" as fallback.
    // Order matters: the first variant that yields hits is reported as `why`.
    if (kw.endsWith("ing")) {
      const stem = kw.slice(0, -3);
      push(stem + "e");
      push(stem);
    }
    // "caches" / "caching" already covered; also strip trailing s.
    if (kw.endsWith("s") && kw.length > 3) push(kw.slice(0, -1));
    // "cache" → "caching" reverse hop (helps when the intent phrases as noun
    // but the code uses a gerund method).
    if (kw.endsWith("e")) push(kw.slice(0, -1) + "ing");
  }
  return out;
}

interface PatternHit {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  module: ModulePath;
  signature: string;
  score: number;
}

// Lightweight keyword scan directly against ts-morph declarations. We don't
// reuse the shared NameSearchIndex here because that state is owned by
// Session for find(); explore is a one-shot briefing and shouldn't
// implicitly rebuild the shared index.
function scanSymbolsByKeyword(
  project: Project,
  root: ProjectRoot,
  keyword: string,
  limit: number
): PatternHit[] {
  const lower = keyword.toLowerCase();
  const out: PatternHit[] = [];
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const modulePath = toRelPath(root, sf.getFilePath());
    for (const cls of sf.getClasses()) {
      const n = cls.getName();
      if (!n) continue;
      const score = scoreName(n, lower);
      if (score > 0) {
        out.push({
          id: `sym:${modulePath}#${n}`,
          kind: "class",
          name: n,
          module: modulePath,
          signature: firstLine(cls.getText()),
          score,
        });
      }
    }
    for (const fn of sf.getFunctions()) {
      const n = fn.getName();
      if (!n) continue;
      const score = scoreName(n, lower);
      if (score > 0) {
        out.push({
          id: `sym:${modulePath}#${n}`,
          kind: "function",
          name: n,
          module: modulePath,
          signature: firstLine(fn.getText()),
          score,
        });
      }
    }
    for (const iface of sf.getInterfaces()) {
      const n = iface.getName();
      const score = scoreName(n, lower);
      if (score > 0) {
        out.push({
          id: `sym:${modulePath}#${n}`,
          kind: "interface",
          name: n,
          module: modulePath,
          signature: firstLine(iface.getText()),
          score,
        });
      }
    }
    for (const alias of sf.getTypeAliases()) {
      const n = alias.getName();
      const score = scoreName(n, lower);
      if (score > 0) {
        out.push({
          id: `sym:${modulePath}#${n}`,
          kind: "type",
          name: n,
          module: modulePath,
          signature: firstLine(alias.getText()),
          score,
        });
      }
    }
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

function scoreName(name: string, lowerKw: string): number {
  const lower = name.toLowerCase();
  if (lower === lowerKw) return 1.0;
  if (lower.startsWith(lowerKw)) return 0.7;
  if (lower.includes(lowerKw)) return 0.5;
  return 0;
}

function collectRelevantImports(
  project: Project,
  root: ProjectRoot,
  keywords: string[]
): ExploreRelevantImport[] {
  if (keywords.length === 0) return [];
  // Precompute the set of module-specifier substrings we consider a match:
  // (a) each keyword itself, (b) any domain markers for that keyword.
  const needles = new Set<string>();
  for (const kw of keywords) {
    needles.add(kw);
    const markers = DOMAIN_MARKERS[kw];
    if (markers) {
      for (const m of markers) needles.add(m.toLowerCase());
    }
  }

  // Aggregate per module specifier so multiple import statements collapse.
  const byModule = new Map<string, Set<string>>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    if (sf.getFilePath().includes("/node_modules/")) continue;
    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue();
      const lowerSpec = spec.toLowerCase();
      let match = false;
      for (const n of needles) {
        if (lowerSpec.includes(n)) {
          match = true;
          break;
        }
      }
      if (!match) continue;
      const set = byModule.get(spec) ?? new Set<string>();
      const def = imp.getDefaultImport()?.getText();
      if (def) set.add(def);
      const ns = imp.getNamespaceImport()?.getText();
      if (ns) set.add(`* as ${ns}`);
      for (const named of imp.getNamedImports()) {
        const alias = named.getAliasNode()?.getText();
        set.add(alias ? `${named.getName()} as ${alias}` : named.getName());
      }
      byModule.set(spec, set);
    }
  }
  const out: ExploreRelevantImport[] = [];
  for (const [module, symbols] of byModule) {
    out.push({ module, symbols: [...symbols].sort() });
  }
  // Stable ordering; cap defensively.
  // Note: we intentionally don't dedupe relative-path imports across files —
  // agents get the full picture of what the project actually pulls in.
  out.sort((a, b) => a.module.localeCompare(b.module));
  return out.slice(0, 20);
}

function collectConfigFiles(project: Project, root: ProjectRoot): ModulePath[] {
  // The ts-morph Project only tracks source files; config lookup goes through
  // ts-morph's file-system host so it stays sandbox-safe.
  const fs = project.getFileSystem();
  const out = new Set<ModulePath>();
  // Only look at the project root — recursing arbitrarily explodes cost.
  let entries: Array<{ name: string; isFile: boolean } | string> = [];
  try {
    entries = fs.readDirSync(root) as Array<
      { name: string; isFile: boolean } | string
    >;
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const abs = typeof entry === "string" ? entry : entry.name;
    const base = basename(abs);
    for (const pattern of CONFIG_PATTERNS) {
      if (micromatch.isMatch(base, pattern, { dot: true })) {
        out.add(toRelPath(root, abs));
        break;
      }
    }
    if (out.size >= 10) break;
  }
  return [...out];
}

function collectEnvVars(project: Project, keywords: string[]): string[] {
  if (keywords.length === 0) return [];
  const lowerKws = keywords.map((k) => k.toLowerCase());
  const seen = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    if (sf.getFilePath().includes("/node_modules/")) continue;
    const text = sf.getFullText();
    for (const match of text.matchAll(ENV_VAR_RX)) {
      const varName = match[1];
      if (seen.has(varName)) continue;
      const lower = varName.toLowerCase();
      // Only keep vars whose name references any intent keyword; otherwise
      // we'd flood the response with unrelated env plumbing.
      if (lowerKws.some((k) => lower.includes(k))) {
        seen.add(varName);
        if (seen.size >= 20) return [...seen];
      }
    }
  }
  return [...seen];
}

function collectTests(
  project: Project,
  root: ProjectRoot,
  targetModule?: ModulePath
): ModulePath[] {
  const out: ModulePath[] = [];
  const seen = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const modulePath = toRelPath(root, sf.getFilePath());
    if (!isTestFile(modulePath)) continue;
    if (seen.has(modulePath)) continue;
    if (targetModule) {
      if (!testImportsModule(sf, targetModule)) continue;
    }
    seen.add(modulePath);
    out.push(modulePath);
    if (out.length >= 20) break;
  }
  return out;
}

function isTestFile(modulePath: ModulePath): boolean {
  return TEST_PATTERNS.some((p) => micromatch.isMatch(modulePath, p));
}

// Heuristic import-target match: compare the raw module specifier's basename
// against the target module's basename (without extension). Works for both
// "./user" and "../services/user" resolving to "src/services/user.ts".
function testImportsModule(sf: SourceFile, targetModule: ModulePath): boolean {
  const targetBase = basename(targetModule).replace(/\.(tsx?|jsx?)$/, "");
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    const specBase = basename(spec).replace(/\.(tsx?|jsx?)$/, "");
    if (specBase === targetBase) return true;
  }
  return false;
}

function computeLayoutPreview(
  project: Project,
  root: ProjectRoot,
  policy: ReturnType<TsMorphBackend["read"]["getPolicy"]>,
  keywords: string[],
  target: SymbolDetail | null
): ExploreLayoutPreview {
  const derivedName = deriveNewSymbolName(keywords, target);
  try {
    const module = layoutForNewSymbol("function", derivedName, {
      project,
      root,
      policy,
    });
    // The naming convention is whichever the matched group used, or the
    // project-wide default for functions if no group matched. Approximate
    // by inspecting the layout groups against derivedName; fallback to
    // policy.naming.functions.
    const naming = pickNamingForName(derivedName, policy);
    return { module, naming };
  } catch (err) {
    if (err instanceof LayoutAmbiguousError) {
      return { module: "<ambiguous>", naming: "specify explicit module=" };
    }
    return { module: "<ambiguous>", naming: "specify explicit module=" };
  }
}

function deriveNewSymbolName(keywords: string[], target: SymbolDetail | null): string {
  if (target) return `${target.name}V2`;
  if (keywords.length === 0) return "newSymbol";
  // Take the first 1-2 salient keywords, camelCase them.
  const slice = keywords.slice(0, Math.min(3, keywords.length));
  return slice
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("");
}

function pickNamingForName(
  name: string,
  policy: ReturnType<TsMorphBackend["read"]["getPolicy"]>
): string {
  for (const g of policy.layout.groups ?? []) {
    try {
      if (new RegExp(g.pattern).test(name)) {
        return g.naming ?? "kebab-case";
      }
    } catch {
      continue;
    }
  }
  return policy.naming.functions ?? "camelCase";
}

function buildNextCalls(
  target: SymbolDetail | null,
  patterns: ExplorePattern[],
  keywords: string[]
): NextCall[] {
  const calls: NextCall[] = [];
  if (target) {
    calls.push({
      tool: "open_symbol",
      args: { id_or_query: target.id },
      rationale: `Full context for the resolved target '${target.name}'.`,
    });
    if (target.kind === "class" || target.kind === "method") {
      calls.push({
        tool: "describe_change_zone",
        args: { id: target.id },
        rationale: `Blast radius before editing '${target.name}'.`,
      });
    }
  } else if (keywords.length > 0) {
    calls.push({
      tool: "find",
      args: { query: keywords[0], mode: "name" },
      rationale: `No target resolved — search by top keyword '${keywords[0]}'.`,
    });
  }
  if (!target && patterns.length > 0) {
    const top = patterns[0];
    calls.push({
      tool: "open_symbol",
      args: { id_or_query: top.id },
      rationale: `Open top pattern hit '${top.name}'.`,
    });
  }
  return calls;
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  return relative(root, absPath).split(/[\\/]/).join("/");
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i >= 0 ? s.slice(0, i) : s).trim().slice(0, 200);
}
