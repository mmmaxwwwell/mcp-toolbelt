import { relative } from "node:path";
import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type ModuleDeclaration,
  type Project,
  type PropertyDeclaration,
  type ReferenceFindableNode,
  type SourceFile,
  type TypeAliasDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import type {
  ModulePath,
  ProjectRoot,
  SymbolId,
  SymbolKind,
} from "../types.js";
import type { NameSearchIndex } from "./name-search.js";

export type UsageVerb = "callers" | "constructors" | "implementations" | "type";

export interface ParsedUsageQuery {
  verb: UsageVerb;
  target: string;
}

export interface UsageHit {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  signature: string;
  snippet: string;
  score: number;
  source_index: "usage";
}

const VERB_PATTERNS: Array<{ re: RegExp; verb: UsageVerb }> = [
  { re: /^\s*callers\s+of\s+(.+?)\s*$/i, verb: "callers" },
  { re: /^\s*users?\s+of\s+(.+?)\s*$/i, verb: "callers" },
  { re: /^\s*references?\s+to\s+(.+?)\s*$/i, verb: "callers" },
  { re: /^\s*constructors?\s+of\s+(.+?)\s*$/i, verb: "constructors" },
  { re: /^\s*constructions?\s+of\s+(.+?)\s*$/i, verb: "constructors" },
  { re: /^\s*instances?\s+of\s+(.+?)\s*$/i, verb: "constructors" },
  { re: /^\s*new\s+(.+?)\s*$/i, verb: "constructors" },
  { re: /^\s*implementations?\s+of\s+(.+?)\s*$/i, verb: "implementations" },
  { re: /^\s*implementors?\s+of\s+(.+?)\s*$/i, verb: "implementations" },
  { re: /^\s*subclasses?\s+of\s+(.+?)\s*$/i, verb: "implementations" },
  { re: /^\s*type\s+of\s+(.+?)\s*$/i, verb: "type" },
];

export function parseUsageQuery(query: string): ParsedUsageQuery | null {
  for (const { re, verb } of VERB_PATTERNS) {
    const m = re.exec(query);
    if (m) return { verb, target: m[1].trim() };
  }
  return null;
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

export function runUsageSearch(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  parsed: ParsedUsageQuery
): UsageHit[] {
  const target = parsed.target;
  const resolved = resolveTargetName(index, target);
  if (resolved.length === 0) return [];

  switch (parsed.verb) {
    case "callers":
      return findCallers(project, root, resolved);
    case "constructors":
      return findConstructors(project, root, target);
    case "implementations":
      return findImplementations(project, root, target);
    case "type":
      return describeType(resolved);
  }
}

function resolveTargetName(
  index: NameSearchIndex,
  target: string
): Array<{ id: SymbolId; name: string; kind: SymbolKind; signature: string; snippet: string }> {
  const dotIdx = target.indexOf(".");
  if (dotIdx > 0) {
    const parent = target.slice(0, dotIdx);
    const member = target.slice(dotIdx + 1);
    const memberHits = index.search(member).filter((h) => {
      if (h.score < 0.8) return false;
      return h.id.endsWith(`#${parent}.${member}`);
    });
    if (memberHits.length > 0) return memberHits;
  }
  const exact = index.search(target).filter((h) => h.score >= 0.8);
  if (exact.length > 0) return exact;
  return index.search(target).slice(0, 5);
}

function findCallers(
  project: Project,
  root: ProjectRoot,
  targets: Array<{ id: SymbolId; name: string; kind: SymbolKind }>
): UsageHit[] {
  const out: UsageHit[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    const decl = resolveSymbolIdInProject(project, root, t.id);
    if (!decl) continue;
    const nameNode = getNameNode(decl);
    if (!nameNode) continue;
    let refs: Node[] = [];
    try {
      refs = nameNode.findReferencesAsNodes();
    } catch {
      continue;
    }
    const declStart = decl.getStart();
    const declFile = decl.getSourceFile().getFilePath();
    for (const refNode of refs) {
      if (refNode.getStart() === declStart && refNode.getSourceFile().getFilePath() === declFile) continue;
      const isCall = classifyIsCall(refNode);
      if (!isCall) continue;
      const container = findContainingNamedDeclaration(refNode);
      const hit = buildUsageHitForRef(root, refNode, container, "usage-caller");
      if (!hit) continue;
      const key = `${hit.id}@${hit.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

function findConstructors(
  project: Project,
  root: ProjectRoot,
  targetName: string
): UsageHit[] {
  const bareName = targetName.split(".").pop() ?? targetName;
  const out: UsageHit[] = [];
  const seen = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const news = sf.getDescendantsOfKind(SyntaxKind.NewExpression);
    for (const n of news) {
      const exprText = n.getExpression().getText();
      if (exprText !== bareName && !exprText.endsWith(`.${bareName}`)) continue;
      const container = findContainingNamedDeclaration(n);
      const hit = buildUsageHitForRef(root, n, container, "usage-constructor");
      if (!hit) continue;
      const key = `${hit.id}@${hit.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

function findImplementations(
  project: Project,
  root: ProjectRoot,
  targetName: string
): UsageHit[] {
  const bareName = targetName.split(".").pop() ?? targetName;
  const out: UsageHit[] = [];
  const seen = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    for (const cls of sf.getClasses()) {
      collectFromHeritage(cls, bareName, root, out, seen, cls, "class");
    }
    for (const iface of sf.getInterfaces()) {
      collectFromHeritage(iface, bareName, root, out, seen, iface, "interface");
    }
  }
  return out;
}

function collectFromHeritage(
  decl: ClassDeclaration | InterfaceDeclaration,
  targetName: string,
  root: ProjectRoot,
  out: UsageHit[],
  seen: Set<string>,
  namedDecl: NamedDecl,
  kind: SymbolKind
): void {
  const heritages = decl.getHeritageClauses();
  for (const h of heritages) {
    const types = h.getTypeNodes();
    for (const t of types) {
      const exprText = t.getExpression().getText();
      if (exprText !== targetName && !exprText.endsWith(`.${targetName}`)) continue;
      const hit = buildUsageHitForDecl(root, namedDecl, kind);
      if (!hit) continue;
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      out.push(hit);
    }
  }
}

function describeType(
  targets: Array<{ id: SymbolId; name: string; kind: SymbolKind; signature: string; snippet: string }>
): UsageHit[] {
  return targets.map((t) => ({
    id: t.id,
    kind: t.kind,
    name: t.name,
    signature: t.signature,
    snippet: t.snippet,
    score: 1.0,
    source_index: "usage" as const,
  }));
}

function buildUsageHitForRef(
  root: ProjectRoot,
  refNode: Node,
  container: Node | null,
  _reason: string
): UsageHit | null {
  const sf = refNode.getSourceFile();
  const { line } = sf.getLineAndColumnAtPos(refNode.getStart());
  const modulePath = toRelPath(root, sf.getFilePath());
  const snippet = extractLine(sf, line);
  let name = "<call site>";
  let kind: SymbolKind = "function";
  let containerName = "";
  if (container) {
    const cName = (container as unknown as { getName?: () => string | undefined }).getName?.();
    if (cName) {
      name = cName;
      containerName = cName;
    }
    const cKind = classifyKind(container);
    if (cKind) kind = cKind;
  }
  const idSuffix = containerName || `L${line}`;
  const id: SymbolId = `sym:${modulePath}#${idSuffix}`;
  return {
    id,
    kind,
    name,
    signature: snippet,
    snippet,
    score: 1.0,
    source_index: "usage",
  };
}

function buildUsageHitForDecl(
  root: ProjectRoot,
  decl: NamedDecl,
  kind: SymbolKind
): UsageHit | null {
  const name = (decl as unknown as { getName?: () => string | undefined }).getName?.();
  if (!name) return null;
  const sf = decl.getSourceFile();
  const modulePath = toRelPath(root, sf.getFilePath());
  const id: SymbolId = `sym:${modulePath}#${name}`;
  const text = decl.getText();
  const snippet = firstLineCapped(text, 120);
  return {
    id,
    kind,
    name,
    signature: snippet,
    snippet,
    score: 1.0,
    source_index: "usage",
  };
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

function classifyIsCall(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (Node.isCallExpression(parent) && parent.getExpression() === node) return true;
  if (Node.isNewExpression(parent) && parent.getExpression() === node) return true;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) {
    const gp = parent.getParent();
    if (gp && (Node.isCallExpression(gp) || Node.isNewExpression(gp)) && gp.getExpression() === parent) {
      return true;
    }
  }
  return false;
}

function findContainingNamedDeclaration(node: Node): Node | null {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (
      Node.isClassDeclaration(cur) ||
      Node.isFunctionDeclaration(cur) ||
      Node.isInterfaceDeclaration(cur) ||
      Node.isTypeAliasDeclaration(cur) ||
      Node.isEnumDeclaration(cur) ||
      Node.isMethodDeclaration(cur) ||
      Node.isVariableDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.getParent();
  }
  return null;
}

function getNameNode(decl: NamedDecl): (Node & ReferenceFindableNode) | null {
  const anyDecl = decl as unknown as { getNameNode?: () => (Node & ReferenceFindableNode) | undefined };
  const nameNode = anyDecl.getNameNode?.();
  return nameNode ?? null;
}

function resolveSymbolIdInProject(project: Project, root: ProjectRoot, id: SymbolId): NamedDecl | null {
  if (!id.startsWith("sym:")) return null;
  const body = id.slice(4);
  const hashIdx = body.indexOf("#");
  if (hashIdx < 0) return null;
  const modulePath = body.slice(0, hashIdx);
  const qualified = body.slice(hashIdx + 1);
  const abs = modulePath.startsWith("/") ? modulePath : `${root}/${modulePath}`;
  const sf = project.getSourceFile(abs) ?? project.getSourceFile(modulePath);
  if (!sf) return null;

  const parts = qualified.split(".");
  if (parts.length === 1) {
    return findTopLevel(sf, parts[0]);
  }
  if (parts.length === 2) {
    const [parentName, memberName] = parts;
    const parent = findTopLevel(sf, parentName);
    if (!parent) return null;
    if (Node.isClassDeclaration(parent)) {
      const m = parent.getMethod(memberName);
      if (m) return m;
      const p = parent.getProperty(memberName);
      if (p) return p;
    }
    if (Node.isInterfaceDeclaration(parent)) {
      const m = parent.getMethod(memberName);
      if (m) return m as unknown as MethodDeclaration;
      const p = parent.getProperty(memberName);
      if (p) return p as unknown as PropertyDeclaration;
    }
  }
  return null;
}

function findTopLevel(sf: SourceFile, name: string): NamedDecl | null {
  const cls = sf.getClass(name);
  if (cls) return cls;
  const fn = sf.getFunction(name);
  if (fn) return fn;
  const iface = sf.getInterface(name);
  if (iface) return iface;
  const alias = sf.getTypeAlias(name);
  if (alias) return alias;
  const en = sf.getEnum(name);
  if (en) return en;
  const ns = sf.getModule(name);
  if (ns) return ns;
  const v = sf.getVariableDeclaration(name);
  if (v) return v;
  return null;
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  return relative(root, absPath).split(/[\\/]/).join("/");
}

function extractLine(sf: SourceFile, line: number): string {
  const text = sf.getFullText();
  const lines = text.split(/\r?\n/);
  const raw = lines[line - 1] ?? "";
  return firstLineCapped(raw.trim(), 120);
}

function firstLineCapped(s: string, cap: number): string {
  const i = s.indexOf("\n");
  const line = (i >= 0 ? s.slice(0, i) : s).trim();
  if (line.length <= cap) return line;
  return line.slice(0, cap - 1) + "…";
}
