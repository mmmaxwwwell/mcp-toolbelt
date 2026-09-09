import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  Node,
  SyntaxKind,
  type Project,
  type SourceFile,
} from "ts-morph";
import { NotImplementedError, RefusalError } from "../errors.js";
import { NameSearchIndex } from "../search/name-search.js";
import type {
  ModulePath,
  ProjectRoot,
  SymbolDetail,
  SymbolId,
  SymbolKind,
} from "../types.js";
import { resolveSymbolIdToNode, type TsMorphReadBackend } from "./ts-morph-read.js";

// --------------- open_symbol output types ---------------

export interface OpenCaller {
  id: SymbolId | null;
  file: ModulePath;
  line: number;
  context_line: string;
  kind: "call";
  snippet_3_lines: string;
}

export interface OpenTypeDep {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  module: ModulePath;
  signature: string;
}

export interface OpenSibling {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  signature: string;
}

export interface OpenSymbolData {
  symbol: SymbolDetail;
  callers: OpenCaller[];
  type_deps: OpenTypeDep[];
  siblings: OpenSibling[];
  tests: ModulePath[];
}

// --------------- similar_to output types ---------------

export interface SimilarResult {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  signature: string;
  module: ModulePath;
  similarity_reason: string;
}

// --------------- backend ---------------

// TsMorphBundledBackend composes read-side primitives (getSymbol, getReferences,
// describeModule) with light ts-morph traversal for the enrichment fields
// (type_deps, tests heuristics, similarity scoring). It intentionally does NOT
// re-implement any primitive; enrichment methods walk the same Project handle.
export class TsMorphBundledBackend {
  constructor(private readonly read: TsMorphReadBackend) {}

  private project(): Project {
    return this.read.getProject();
  }
  private root(): ProjectRoot {
    return this.read.getRoot();
  }

  async openSymbol(idOrQuery: string): Promise<OpenSymbolData> {
    const id = await this.resolveIdOrQuery(idOrQuery);
    const detail = await this.read.getSymbol(id);
    const references = await this.read.getReferences(id);

    const callers = this.buildCallers(references);
    const type_deps = this.collectTypeDeps(id);
    const siblings = await this.collectSiblings(detail);
    const tests = this.collectTests(detail);

    return { symbol: detail, callers, type_deps, siblings, tests };
  }

  async similarTo(id: SymbolId, k = 5): Promise<SimilarResult[]> {
    const project = this.project();
    const root = this.root();
    const target = resolveSymbolIdToNode(project, root, id);
    if (!target) {
      throw new NotImplementedError("similar_to", `symbol not found: ${id}`);
    }
    const targetInfo = symbolInfoFromNode(target, root);
    if (!targetInfo) {
      throw new NotImplementedError("similar_to", `unrenderable symbol: ${id}`);
    }
    const targetTypeRefs = collectTypeReferenceNames(target);
    const targetIdentifiers = extractSignatureIdentifiers(targetInfo.signature);

    const scored: Array<{ score: number; reasons: string[]; info: SymbolInfo }> = [];
    for (const sf of project.getSourceFiles()) {
      if (sf.isDeclarationFile()) continue;
      for (const decl of enumerateNamedDecls(sf)) {
        const info = symbolInfoFromNode(decl, root);
        if (!info) continue;
        if (info.id === targetInfo.id) continue;

        let score = 0;
        const reasons: string[] = [];
        if (info.kind === targetInfo.kind && info.module === targetInfo.module) {
          score += 3;
          reasons.push("same module + kind");
        } else if (info.kind === targetInfo.kind) {
          score += 2;
          reasons.push("same kind");
        }

        const candidateTypeRefs = collectTypeReferenceNames(decl);
        const sharedTypes = intersect(targetTypeRefs, candidateTypeRefs);
        if (sharedTypes.size > 0) {
          score += 2;
          reasons.push(`shared type refs: ${[...sharedTypes].slice(0, 3).join(", ")}`);
        }

        const candidateIdentifiers = extractSignatureIdentifiers(info.signature);
        const sharedIdents = intersect(targetIdentifiers, candidateIdentifiers);
        if (sharedIdents.size > 0) {
          score += sharedIdents.size;
        }

        if (score > 0) {
          scored.push({ score, reasons, info });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score || a.info.name.localeCompare(b.info.name));

    return scored.slice(0, k).map((s) => ({
      id: s.info.id,
      kind: s.info.kind,
      name: s.info.name,
      signature: s.info.signature,
      module: s.info.module,
      similarity_reason: s.reasons.length > 0 ? s.reasons.join("; ") : "signature overlap",
    }));
  }

  // ---- open_symbol helpers ----

  private async resolveIdOrQuery(idOrQuery: string): Promise<SymbolId> {
    if (idOrQuery.startsWith("sym:")) return idOrQuery as SymbolId;

    // Name-search fallback via NameSearchIndex — pick the top hit; refuse on
    // ambiguity (multiple top hits with identical score).
    const idx = new NameSearchIndex();
    idx.build(this.project(), this.root());
    const hits = idx.search(idOrQuery);
    if (hits.length === 0) {
      throw new RefusalError(
        "no_match",
        `open_symbol: no symbol found for query '${idOrQuery}'`
      );
    }
    const top = hits[0];
    const tied = hits.filter((h) => h.score === top.score);
    if (tied.length > 1) {
      const names = tied.slice(0, 5).map((t) => `${t.name} (${t.module})`).join(", ");
      throw new RefusalError(
        "ambiguous_query",
        `open_symbol: '${idOrQuery}' matches ${tied.length} symbols with equal top score: ${names}. Pass a sym: id instead.`
      );
    }
    return top.id;
  }

  private buildCallers(references: Array<{
    file: ModulePath;
    line: number;
    column: number;
    context_line: string;
    kind: string;
  }>): OpenCaller[] {
    const project = this.project();
    const root = this.root();
    const calls = references.filter((r) => r.kind === "call").slice(0, 10);
    const out: OpenCaller[] = [];
    for (const ref of calls) {
      const snippet = readThreeLineSnippet(project, root, ref.file, ref.line);
      const callerId = resolveCallerContainingId(project, root, ref.file, ref.line);
      out.push({
        id: callerId,
        file: ref.file,
        line: ref.line,
        context_line: ref.context_line,
        kind: "call",
        snippet_3_lines: snippet,
      });
    }
    return out;
  }

  private collectTypeDeps(id: SymbolId): OpenTypeDep[] {
    const project = this.project();
    const root = this.root();
    const node = resolveSymbolIdToNode(project, root, id);
    if (!node) return [];

    // Walk type references AND call expressions in the target's signature +
    // body. Deduplicate by resolved symbol id and cap at 20.
    const seen = new Set<SymbolId>();
    const out: OpenTypeDep[] = [];
    const cap = 20;

    const typeRefs = node.getDescendantsOfKind(SyntaxKind.TypeReference);
    for (const tr of typeRefs) {
      if (out.length >= cap) break;
      const nameNode = tr.getTypeName();
      const decl = resolveDeclarationFromNode(nameNode as unknown as Node);
      if (!decl) continue;
      const info = symbolInfoFromNode(decl, root);
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      out.push(info);
    }

    const callExprs = node.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const ce of callExprs) {
      if (out.length >= cap) break;
      // Resolve the callee: for property access (foo.bar()), pick the property
      // name node; otherwise use the expression itself.
      const expr = ce.getExpression();
      let target: Node = expr;
      if (Node.isPropertyAccessExpression(expr)) {
        target = expr.getNameNode();
      }
      const decl = resolveDeclarationFromNode(target);
      if (!decl) continue;
      const info = symbolInfoFromNode(decl, root);
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      out.push(info);
    }

    return out;
  }

  private async collectSiblings(detail: SymbolDetail): Promise<OpenSibling[]> {
    try {
      const desc = await this.read.describeModule(detail.module);
      return desc.exports
        .filter((e) => e.id !== detail.id)
        .map((e) => ({ id: e.id, kind: e.kind, name: e.name, signature: e.signature }));
    } catch {
      return [];
    }
  }

  private collectTests(detail: SymbolDetail): ModulePath[] {
    const project = this.project();
    const root = this.root();
    const found = new Set<ModulePath>();

    // Same-dir <basename>.{test,spec}.{ts,tsx} heuristic.
    const targetSf = project.getSourceFile(join(root, detail.module));
    if (targetSf) {
      const filePath = targetSf.getFilePath();
      const dir = dirname(filePath);
      const base = targetSf.getBaseName().replace(/\.(tsx?|jsx?)$/i, "");
      for (const suffix of [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"]) {
        const candidate = join(dir, `${base}${suffix}`);
        if (project.getSourceFile(candidate) || existsSync(candidate)) {
          found.add(toRelPath(root, candidate));
        }
      }
    }

    // Any file matching /test|__tests__/ in path that imports the target module.
    const targetAbs = join(root, detail.module);
    for (const sf of project.getSourceFiles()) {
      if (sf.isDeclarationFile()) continue;
      const fp = sf.getFilePath();
      const base = sf.getBaseName();
      const looksLikeTest =
        /\.(test|spec)\.(t|j)sx?$/.test(base) || fp.includes("/__tests__/") || fp.includes("/test/");
      if (!looksLikeTest) continue;
      if (fp === targetAbs) continue;
      try {
        const refs = sf.getReferencedSourceFiles();
        for (const r of refs) {
          if (r.getFilePath() === targetAbs) {
            found.add(toRelPath(root, fp));
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    return [...found].sort();
  }
}

// ------------ shared helpers ------------

interface SymbolInfo {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  module: ModulePath;
  signature: string;
}

function symbolInfoFromNode(node: Node, root: ProjectRoot): SymbolInfo | null {
  const kind = classifyKind(node);
  if (!kind) return null;
  const nameFn = (node as unknown as { getName?: () => string | undefined }).getName;
  const name = typeof nameFn === "function" ? nameFn.call(node) : undefined;
  if (!name) return null;
  const sf = node.getSourceFile();
  const module = toRelPath(root, sf.getFilePath());
  const qualified = qualifyName(node, name);
  const id = `sym:${module}#${qualified}` as SymbolId;
  const signature = extractSignatureLine(node, name);
  return { id, kind, name, module, signature };
}

function classifyKind(node: Node): SymbolKind | null {
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isFunctionDeclaration(node)) return "function";
  if (Node.isInterfaceDeclaration(node)) return "interface";
  if (Node.isTypeAliasDeclaration(node)) return "type";
  if (Node.isEnumDeclaration(node)) return "enum";
  if (Node.isMethodDeclaration(node)) return "method";
  if (Node.isPropertyDeclaration(node)) return "property";
  if (Node.isVariableDeclaration(node)) return "variable";
  if (Node.isModuleDeclaration(node)) return "namespace";
  return null;
}

function qualifyName(node: Node, name: string): string {
  if (Node.isMethodDeclaration(node) || Node.isPropertyDeclaration(node)) {
    const parent = node.getParent();
    if (parent && Node.isClassDeclaration(parent)) {
      const parentName = parent.getName();
      if (parentName) return `${parentName}.${name}`;
    }
  }
  return name;
}

function extractSignatureLine(node: Node, name: string): string {
  if (Node.isClassDeclaration(node)) {
    const heritage = node.getExtends()?.getText();
    return `class ${name}${heritage ? ` extends ${heritage}` : ""}`;
  }
  if (Node.isInterfaceDeclaration(node)) return `interface ${name}`;
  if (Node.isTypeAliasDeclaration(node)) {
    const t = node.getTypeNode()?.getText() ?? "";
    return `type ${name} = ${t}`.slice(0, 200);
  }
  if (Node.isEnumDeclaration(node)) return `enum ${name}`;
  if (Node.isFunctionDeclaration(node)) {
    const params = node.getParameters().map((p) => p.getText()).join(", ");
    const ret = node.getReturnTypeNode()?.getText();
    const async = node.isAsync() ? "async " : "";
    return `${async}function ${name}(${params})${ret ? `: ${ret}` : ""}`;
  }
  if (Node.isMethodDeclaration(node)) {
    const params = node.getParameters().map((p) => p.getText()).join(", ");
    const ret = node.getReturnTypeNode()?.getText();
    return `${name}(${params})${ret ? `: ${ret}` : ""}`;
  }
  return node.getText().split("\n")[0].trim().slice(0, 200);
}

function collectTypeReferenceNames(node: Node): Set<string> {
  const out = new Set<string>();
  const refs = node.getDescendantsOfKind(SyntaxKind.TypeReference);
  for (const tr of refs) {
    const name = tr.getTypeName().getText();
    if (name) out.add(name);
  }
  return out;
}

function extractSignatureIdentifiers(signature: string): Set<string> {
  // Extract identifier-shaped tokens; used to score shared vocabulary across
  // signatures (e.g. two functions both mentioning "User").
  const out = new Set<string>();
  const rx = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  let m: RegExpExecArray | null;
  const keywords = new Set([
    "class", "function", "interface", "type", "enum", "async", "await",
    "public", "private", "protected", "static", "readonly", "extends",
    "implements", "return", "void", "number", "string", "boolean", "never",
    "any", "unknown", "Promise",
  ]);
  while ((m = rx.exec(signature)) !== null) {
    const tok = m[0];
    if (keywords.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function enumerateNamedDecls(sf: SourceFile): Node[] {
  const out: Node[] = [];
  for (const cls of sf.getClasses()) {
    if (cls.getName()) out.push(cls);
  }
  for (const fn of sf.getFunctions()) {
    if (fn.getName()) out.push(fn);
  }
  for (const iface of sf.getInterfaces()) out.push(iface);
  for (const alias of sf.getTypeAliases()) out.push(alias);
  for (const en of sf.getEnums()) out.push(en);
  for (const v of sf.getVariableDeclarations()) {
    if (v.getName()) out.push(v);
  }
  return out;
}

function resolveDeclarationFromNode(node: Node | undefined): Node | null {
  if (!node) return null;
  // ts-morph exposes getSymbol() on named identifiers; the symbol's first
  // declaration is our best-effort resolution target.
  const anyNode = node as unknown as { getSymbol?: () => { getDeclarations?: () => Node[] } | undefined };
  const sym = anyNode.getSymbol?.();
  const decls = sym?.getDeclarations?.();
  if (!decls || decls.length === 0) return null;
  // Prefer a declaration that classifies to a known kind.
  for (const d of decls) {
    if (classifyKind(d)) return d;
  }
  return decls[0] ?? null;
}

function readThreeLineSnippet(
  project: Project,
  root: ProjectRoot,
  file: ModulePath,
  line: number
): string {
  const abs = join(root, file);
  const sf = project.getSourceFile(abs) ?? project.getSourceFile(file);
  if (!sf) return "";
  const lines = sf.getFullText().split(/\r?\n/);
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, line + 1);
  return lines.slice(start, end).join("\n");
}

function resolveCallerContainingId(
  project: Project,
  root: ProjectRoot,
  file: ModulePath,
  line: number
): SymbolId | null {
  const abs = join(root, file);
  const sf = project.getSourceFile(abs) ?? project.getSourceFile(file);
  if (!sf) return null;
  // Locate the token at line/col=1 (start of line is fine for containment).
  const posFromLine = getPosFromLine(sf, line);
  if (posFromLine < 0) return null;
  const node = sf.getDescendantAtPos(posFromLine);
  if (!node) return null;
  const container = findContainingNamedDecl(node);
  if (!container) return null;
  const info = symbolInfoFromNode(container, root);
  return info?.id ?? null;
}

function getPosFromLine(sf: SourceFile, line: number): number {
  const text = sf.getFullText();
  let cursor = 0;
  let cur = 1;
  while (cur < line) {
    const nl = text.indexOf("\n", cursor);
    if (nl < 0) return -1;
    cursor = nl + 1;
    cur += 1;
  }
  return cursor;
}

function findContainingNamedDecl(node: Node): Node | null {
  let cur: Node | undefined = node;
  while (cur) {
    if (
      Node.isMethodDeclaration(cur) ||
      Node.isFunctionDeclaration(cur) ||
      Node.isClassDeclaration(cur) ||
      Node.isInterfaceDeclaration(cur) ||
      Node.isTypeAliasDeclaration(cur) ||
      Node.isEnumDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.getParent();
  }
  return null;
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  return relative(root, absPath).split(/[\\/]/).join("/");
}
