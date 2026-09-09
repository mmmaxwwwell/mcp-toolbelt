import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  Node,
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  type ModuleDeclaration,
  type Project,
  type PropertyDeclaration,
  type PropertySignature,
  type SourceFile,
  type TypeAliasDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import type { ModulePath, ProjectRoot, SymbolId, SymbolKind } from "../types.js";

export interface FtsHit {
  id: SymbolId;
  name: string;
  signature: string;
  jsdoc_summary: string;
  module: ModulePath;
  kind: SymbolKind;
  bm25_score: number;
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

/** Compute the cache DB path for a project root. */
export function dbPathForRoot(root: ProjectRoot): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME || join(process.env.HOME || "/tmp", ".cache");
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return join(cacheHome, "mcp-toolbelt", `graph-edit-${hash}.db`);
}

/**
 * (Re)build the FTS5 index for `project` at `dbPath`.
 * Truncates and repopulates from scratch — cheap for the target project sizes
 * (~100 symbols) and avoids stale-row invalidation logic.
 */
export async function buildFtsIndex(
  project: Project,
  root: ProjectRoot,
  dbPath: string
): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols USING fts5(
        id UNINDEXED,
        name,
        signature,
        jsdoc_summary,
        module UNINDEXED,
        kind UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `);
    db.exec("DELETE FROM symbols;");

    const insert = db.prepare(
      `INSERT INTO symbols (id, name, signature, jsdoc_summary, module, kind)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const insertAll = db.transaction((rows: Array<[string, string, string, string, string, string]>) => {
      for (const row of rows) insert.run(...row);
    });

    const rows: Array<[string, string, string, string, string, string]> = [];
    for (const sf of project.getSourceFiles()) {
      if (sf.isDeclarationFile()) continue;
      const modulePath = toRelPath(root, sf.getFilePath());
      collectFromSourceFile(sf, modulePath, rows);
    }
    insertAll(rows);
  } finally {
    db.close();
  }
}

/**
 * Search the FTS5 index. Returns rows ordered by BM25 (best first), with a
 * normalized `bm25_score` in [0, 1] where higher = better.
 */
export async function searchFts(
  dbPath: string,
  query: string,
  limit = 10
): Promise<FtsHit[]> {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const stmt = db.prepare(
      `SELECT id, name, signature, jsdoc_summary, module, kind, bm25(symbols) AS bm25
       FROM symbols
       WHERE symbols MATCH ?
       ORDER BY bm25 ASC
       LIMIT ?`
    );
    const rows = stmt.all(ftsQuery, limit) as Array<{
      id: string;
      name: string;
      signature: string;
      jsdoc_summary: string;
      module: string;
      kind: string;
      bm25: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      // The stored `name` column carries token-expansion for camelCase support
      // (see `expandTokens` in the indexer). Recover the original identifier
      // from the SymbolId — it's always the segment after the final `.` (or
      // after `#` for non-member symbols).
      name: originalNameFromId(r.id) ?? r.name.split(" ")[0],
      signature: r.signature,
      jsdoc_summary: r.jsdoc_summary,
      module: r.module,
      kind: r.kind as SymbolKind,
      bm25_score: normalizeBm25(r.bm25),
    }));
  } finally {
    db.close();
  }
}

/**
 * Translate a user query into an FTS5 MATCH expression.
 * - Quoted queries pass through so users can express phrase matches.
 * - Bare tokens become prefix matches (`foo*`) so partial identifiers work
 *   even without an explicit wildcard.
 */
function buildFtsQuery(raw: string): string | null {
  const q = raw.trim();
  if (q.length === 0) return null;
  if (q.startsWith('"') || q.includes(":")) return q;

  const tokens = q
    .split(/\s+/)
    .map((t) => sanitizeToken(t))
    .filter((t): t is string => t !== null && t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => (t.endsWith("*") ? t : `${t}*`)).join(" ");
}

function sanitizeToken(t: string): string | null {
  // Strip FTS5 syntax chars that would otherwise blow up the parser.
  // We intentionally preserve `*` (prefix marker) and `_` (identifier body).
  const cleaned = t.replace(/[\"'()^:{}\\/\-+~,;<>?!@#$%&=]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned;
}

/**
 * BM25 in SQLite FTS5 is negative — smaller (more negative) means better.
 * Map roughly to [0, 1] where 1 is a perfect match. -20 is treated as the
 * "excellent" floor; scores worse than -1 taper toward 0.
 */
function normalizeBm25(bm25: number): number {
  if (!Number.isFinite(bm25)) return 0;
  const clamped = Math.max(-20, Math.min(0, bm25));
  return Math.min(1, -clamped / 20);
}

function collectFromSourceFile(
  sf: SourceFile,
  modulePath: ModulePath,
  rows: Array<[string, string, string, string, string, string]>
): void {
  for (const cls of sf.getClasses()) {
    pushDecl(cls, modulePath, "class", rows);
    for (const m of cls.getMethods()) {
      pushMember(m, modulePath, cls.getName() ?? "?", "method", rows);
    }
    for (const p of cls.getProperties()) {
      pushMember(p, modulePath, cls.getName() ?? "?", "property", rows);
    }
  }
  for (const fn of sf.getFunctions()) {
    pushDecl(fn, modulePath, "function", rows);
  }
  for (const iface of sf.getInterfaces()) {
    pushDecl(iface, modulePath, "interface", rows);
  }
  for (const alias of sf.getTypeAliases()) {
    pushDecl(alias, modulePath, "type", rows);
  }
  for (const en of sf.getEnums()) {
    pushDecl(en, modulePath, "enum", rows);
  }
  for (const ns of sf.getModules()) {
    pushDecl(ns, modulePath, "namespace", rows);
  }
  for (const v of sf.getVariableDeclarations()) {
    pushDecl(v, modulePath, "variable", rows);
  }
}

function pushDecl(
  decl: NamedDecl,
  modulePath: ModulePath,
  kind: SymbolKind,
  rows: Array<[string, string, string, string, string, string]>
): void {
  const name = (decl as unknown as { getName?: () => string | undefined }).getName?.();
  if (!name) return;
  const signature = extractSignature(decl, name);
  const doc = extractJsDocSummary(decl);
  const id: SymbolId = `sym:${modulePath}#${name}`;
  rows.push([id, expandTokens(name), signature, doc, modulePath, kind]);
}

function pushMember(
  decl: MethodDeclaration | PropertyDeclaration,
  modulePath: ModulePath,
  parentName: string,
  kind: SymbolKind,
  rows: Array<[string, string, string, string, string, string]>
): void {
  const name = decl.getName();
  if (!name) return;
  const signature = extractSignature(decl, name);
  const doc = extractJsDocSummary(decl);
  const id: SymbolId = `sym:${modulePath}#${parentName}.${name}`;
  rows.push([id, expandTokens(name), signature, doc, modulePath, kind]);
}

/**
 * Expand an identifier so FTS5's word-boundary tokenizer can match on parts.
 * `UserService` → `UserService User Service`, `useDebounce` → `useDebounce use Debounce`.
 * The original identifier is kept as the first token so exact-name matches
 * still rank highly under BM25.
 */
function expandTokens(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((p) => p.length > 0);
  if (parts.length <= 1) return name;
  return [name, ...parts].join(" ");
}

// Mirrors the shape used in ts-morph-read.ts's private extractSignature.
// Kept local because that one isn't exported and we don't want to widen its
// API surface just for indexing.
function extractSignature(decl: NamedDecl, name: string): string {
  try {
    if (Node.isFunctionDeclaration(decl)) {
      const asyncKw = decl.isAsync() ? "async " : "";
      const params = decl.getParameters().map((p) => p.getText()).join(", ");
      const ret = decl.getReturnTypeNode()?.getText();
      return `${asyncKw}function ${name}(${params})${ret ? `: ${ret}` : ""}`;
    }
    if (Node.isMethodDeclaration(decl) || Node.isMethodSignature(decl)) {
      const params = (decl as MethodDeclaration | MethodSignature)
        .getParameters()
        .map((p) => p.getText())
        .join(", ");
      const ret = (decl as MethodDeclaration | MethodSignature).getReturnTypeNode()?.getText();
      return `${name}(${params})${ret ? `: ${ret}` : ""}`;
    }
    if (Node.isClassDeclaration(decl)) {
      const heritage = decl.getExtends()?.getText();
      return `class ${name}${heritage ? ` extends ${heritage}` : ""}`;
    }
    if (Node.isInterfaceDeclaration(decl)) {
      return `interface ${name}`;
    }
    if (Node.isTypeAliasDeclaration(decl)) {
      const t = decl.getTypeNode()?.getText() ?? "";
      return `type ${name} = ${t}`.slice(0, 200);
    }
    if (Node.isEnumDeclaration(decl)) {
      return `enum ${name}`;
    }
    if (Node.isPropertyDeclaration(decl) || Node.isPropertySignature(decl)) {
      const t = (decl as PropertyDeclaration | PropertySignature).getTypeNode()?.getText();
      return `${name}${t ? `: ${t}` : ""}`;
    }
    if (Node.isVariableDeclaration(decl)) {
      const t = decl.getTypeNode()?.getText();
      return `${name}${t ? `: ${t}` : ""}`.slice(0, 200);
    }
    if (Node.isModuleDeclaration(decl)) {
      return `namespace ${name}`;
    }
  } catch {
    // fall through
  }
  return firstLine((decl as unknown as { getText: () => string }).getText());
}

function extractJsDocSummary(decl: NamedDecl): string {
  const anyDecl = decl as unknown as {
    getJsDocs?: () => Array<{ getDescription?: () => string; getInnerText?: () => string }>;
  };
  const docs = anyDecl.getJsDocs?.();
  if (!docs || docs.length === 0) return "";
  const first = docs[0];
  const raw =
    (typeof first.getDescription === "function" ? first.getDescription() : undefined) ??
    (typeof first.getInnerText === "function" ? first.getInnerText() : "") ??
    "";
  return raw.trim().slice(0, 200);
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  return relative(root, absPath).split(/[\\/]/).join("/");
}

function originalNameFromId(id: string): string | null {
  if (!id.startsWith("sym:")) return null;
  const hashIdx = id.indexOf("#");
  if (hashIdx < 0) return null;
  const qualified = id.slice(hashIdx + 1);
  const dot = qualified.lastIndexOf(".");
  return dot >= 0 ? qualified.slice(dot + 1) : qualified;
}
