import { existsSync } from "node:fs";
import { relative } from "node:path";
import micromatch from "micromatch";
import {
  Node,
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type ModuleDeclaration,
  type Project,
  type PropertyDeclaration,
  type SourceFile,
  type TypeAliasDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import type { ModulePath, ProjectRoot, SymbolId, SymbolKind } from "../types.js";
import { searchFts, type FtsHit } from "./fts-index.js";

export interface NameIndexEntry {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  module: ModulePath;
  signature: string;
  doc: string;
  snippet: string;
}

export interface NameHit extends NameIndexEntry {
  score: number;
  source_index: "name";
}

type NamedDecl =
  | ClassDeclaration
  | FunctionDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | EnumDeclaration
  | ModuleDeclaration
  | MethodDeclaration
  | PropertyDeclaration
  | VariableDeclaration;

const FTS_MIN_HITS = 3;

export class NameSearchIndex {
  private entries: NameIndexEntry[] = [];
  private built = false;
  private projectRef: Project | null = null;
  private rootRef: ProjectRoot | null = null;
  private ftsDbPath: string | undefined;

  build(project: Project, root: ProjectRoot): void {
    this.projectRef = project;
    this.rootRef = root;
    this.entries = [];
    for (const sf of project.getSourceFiles()) {
      if (sf.isDeclarationFile()) continue;
      const modulePath = toRelPath(root, sf.getFilePath());
      this.collectFromSourceFile(sf, modulePath);
    }
    this.built = true;
  }

  ensureBuilt(project: Project, root: ProjectRoot): void {
    if (this.built && this.projectRef === project && this.rootRef === root) return;
    this.build(project, root);
  }

  invalidate(): void {
    this.built = false;
    this.entries = [];
  }

  /** Point the index at a prebuilt SQLite FTS5 file. Missing files are tolerated. */
  setFtsDbPath(dbPath: string | undefined): void {
    this.ftsDbPath = dbPath;
  }

  size(): number {
    return this.entries.length;
  }

  search(
    query: string,
    opts: { kinds?: SymbolKind[]; scope?: string } = {}
  ): NameHit[] {
    const q = query.trim();
    const filtered = this.filterEntries(opts);
    if (q.length === 0) {
      return filtered.map((e) => ({ ...e, score: 0.01, source_index: "name" as const }));
    }
    const lowerQ = q.toLowerCase();
    const results: NameHit[] = [];
    for (const e of filtered) {
      const score = scoreEntry(e, q, lowerQ);
      if (score > 0) {
        results.push({ ...e, score, source_index: "name" });
      }
    }
    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return results;
  }

  /**
   * Preferred search path when an FTS5 index is available. Falls back to (or
   * augments with) the in-memory scorer when FTS returns few hits, or is
   * unavailable / errors out.
   */
  async searchAsync(
    query: string,
    opts: { kinds?: SymbolKind[]; scope?: string; limit?: number } = {}
  ): Promise<NameHit[]> {
    const limit = opts.limit ?? 20;
    const dbPath = this.ftsDbPath;
    if (!dbPath || !existsSync(dbPath)) {
      return this.search(query, opts);
    }

    let ftsHits: FtsHit[] = [];
    try {
      ftsHits = await searchFts(dbPath, query, limit);
    } catch (err) {
      process.stderr.write(
        `graph-edit: FTS5 search failed, falling back to in-memory: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
      return this.search(query, opts);
    }

    const converted = ftsHits.map((h) => fromFtsHit(h, this.lookupEntry(h.id)));
    const filtered = filterHits(converted, opts);

    if (filtered.length >= FTS_MIN_HITS) return filtered;

    // Augment with the in-memory scorer to cover cases the tokenizer misses
    // (camelCase-only splits, symbol suffixes) — dedupe on symbol id.
    const memHits = this.search(query, opts);
    const seen = new Set(filtered.map((h) => h.id));
    const augmented = [...filtered];
    for (const h of memHits) {
      if (seen.has(h.id)) continue;
      augmented.push(h);
      seen.add(h.id);
    }
    return augmented;
  }

  private lookupEntry(id: SymbolId): NameIndexEntry | undefined {
    for (const e of this.entries) if (e.id === id) return e;
    return undefined;
  }

  private filterEntries(opts: { kinds?: SymbolKind[]; scope?: string }): NameIndexEntry[] {
    let filtered = this.entries;
    if (opts.kinds && opts.kinds.length > 0) {
      const set = new Set(opts.kinds);
      filtered = filtered.filter((e) => set.has(e.kind));
    }
    if (opts.scope) {
      filtered = filterByScope(filtered, opts.scope);
    }
    return filtered;
  }

  private collectFromSourceFile(sf: SourceFile, modulePath: ModulePath): void {
    for (const cls of sf.getClasses()) {
      this.pushDecl(cls, modulePath, "class");
      for (const m of cls.getMethods()) {
        this.pushMember(m, modulePath, cls.getName() ?? "?", "method");
      }
      for (const p of cls.getProperties()) {
        this.pushMember(p, modulePath, cls.getName() ?? "?", "property");
      }
    }
    for (const fn of sf.getFunctions()) {
      this.pushDecl(fn, modulePath, "function");
    }
    for (const iface of sf.getInterfaces()) {
      this.pushDecl(iface, modulePath, "interface");
    }
    for (const alias of sf.getTypeAliases()) {
      this.pushDecl(alias, modulePath, "type");
    }
    for (const en of sf.getEnums()) {
      this.pushDecl(en, modulePath, "enum");
    }
    for (const ns of sf.getModules()) {
      this.pushDecl(ns, modulePath, "namespace");
    }
    for (const v of sf.getVariableDeclarations()) {
      this.pushDecl(v, modulePath, "variable");
    }
  }

  private pushDecl(decl: NamedDecl, modulePath: ModulePath, kind: SymbolKind): void {
    const name = (decl as unknown as { getName?: () => string | undefined }).getName?.();
    if (!name) return;
    const signature = extractSignature(decl);
    const doc = extractDocFirstLine(decl);
    const snippet = extractSnippet(decl);
    const id: SymbolId = `sym:${modulePath}#${name}`;
    this.entries.push({ id, kind, name, module: modulePath, signature, doc, snippet });
  }

  private pushMember(
    decl: MethodDeclaration | PropertyDeclaration,
    modulePath: ModulePath,
    parentName: string,
    kind: SymbolKind
  ): void {
    const name = decl.getName();
    if (!name) return;
    const signature = extractSignature(decl);
    const doc = extractDocFirstLine(decl);
    const snippet = extractSnippet(decl);
    const id: SymbolId = `sym:${modulePath}#${parentName}.${name}`;
    this.entries.push({ id, kind, name, module: modulePath, signature, doc, snippet });
  }
}

function fromFtsHit(hit: FtsHit, existing?: NameIndexEntry): NameHit {
  const snippet = existing?.snippet ?? hit.signature;
  const doc = existing?.doc ?? hit.jsdoc_summary;
  return {
    id: hit.id,
    kind: hit.kind,
    name: hit.name,
    module: hit.module,
    signature: hit.signature,
    doc,
    snippet,
    score: hit.bm25_score,
    source_index: "name",
  };
}

function filterHits(
  hits: NameHit[],
  opts: { kinds?: SymbolKind[]; scope?: string }
): NameHit[] {
  let out = hits;
  if (opts.kinds && opts.kinds.length > 0) {
    const set = new Set(opts.kinds);
    out = out.filter((h) => set.has(h.kind));
  }
  if (opts.scope) {
    out = filterHitsByScope(out, opts.scope);
  }
  return out;
}

function filterHitsByScope(hits: NameHit[], scope: string): NameHit[] {
  if (scope.startsWith("sym:")) {
    const hashIdx = scope.indexOf("#");
    if (hashIdx > 0) {
      const modulePath = scope.slice(4, hashIdx);
      return hits.filter((h) => h.module === modulePath);
    }
    return hits;
  }
  return hits.filter((h) => micromatch.isMatch(h.module, scope));
}

function scoreEntry(e: NameIndexEntry, q: string, lowerQ: string): number {
  const name = e.name;
  const lowerName = name.toLowerCase();
  if (name === q) return 1.0;
  if (lowerName.startsWith(lowerQ)) return 0.8;
  if (name.includes(q)) return 0.5;
  if (lowerName.includes(lowerQ)) return 0.3;
  if (e.signature.toLowerCase().includes(lowerQ)) return 0.2;
  if (e.doc.toLowerCase().includes(lowerQ)) return 0.1;
  return 0;
}

function extractSignature(decl: NamedDecl): string {
  try {
    if (Node.isVariableDeclaration(decl)) {
      const stmt = decl.getVariableStatement();
      if (stmt) {
        const text = stmt.getText();
        return firstLine(text);
      }
      return firstLine(decl.getText());
    }
    if (
      Node.isFunctionDeclaration(decl) ||
      Node.isMethodDeclaration(decl) ||
      Node.isClassDeclaration(decl) ||
      Node.isInterfaceDeclaration(decl) ||
      Node.isTypeAliasDeclaration(decl) ||
      Node.isEnumDeclaration(decl) ||
      Node.isModuleDeclaration(decl) ||
      Node.isPropertyDeclaration(decl)
    ) {
      return firstLine(decl.getText());
    }
  } catch {
    // fall through
  }
  return firstLine((decl as unknown as { getText: () => string }).getText());
}

function extractDocFirstLine(decl: NamedDecl): string {
  const anyDecl = decl as unknown as {
    getJsDocs?: () => Array<{ getComment?: () => string | undefined; getInnerText?: () => string }>;
  };
  const docs = anyDecl.getJsDocs?.();
  if (!docs || docs.length === 0) return "";
  const first = docs[0];
  const comment = first.getComment?.() ?? first.getInnerText?.() ?? "";
  return firstLine(comment).slice(0, 200);
}

function extractSnippet(decl: NamedDecl): string {
  try {
    const text = (decl as unknown as { getText: () => string }).getText();
    const line = firstLine(text);
    if (line.length <= 120) return line;
    return line.slice(0, 119) + "…";
  } catch {
    return "";
  }
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  return relative(root, absPath).split(/[\\/]/).join("/");
}

function filterByScope(entries: NameIndexEntry[], scope: string): NameIndexEntry[] {
  if (scope.startsWith("sym:")) {
    const hashIdx = scope.indexOf("#");
    if (hashIdx > 0) {
      const modulePath = scope.slice(4, hashIdx);
      return entries.filter((e) => e.module === modulePath);
    }
    return entries;
  }
  return entries.filter((e) => micromatch.isMatch(e.module, scope));
}
