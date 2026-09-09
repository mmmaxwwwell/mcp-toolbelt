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

// Verbs recognized by the usage-mode grammar. Kept narrow so find.ts's dispatch
// can be exhaustive; new phrasing maps to one of these buckets via VERB_PATTERNS.
export type UsageVerb =
  | "callers"
  | "constructors"
  | "implementations"
  | "type"
  | "overrides";

export interface ParsedUsageQuery {
  verb: UsageVerb;
  target: string;
}

// UsageHit.kind is typed as SymbolKind for compile-time compat with find.ts's
// FindHit type (find.ts is frozen at Phase 1). At runtime we serialize the
// richer entry-kind taxonomy documented in Phase 5B via `entry_kind`. Callers
// that need the richer taxonomy should look at `entry_kind`; find.ts passes
// both through untouched (spread semantics).
export type UsageEntryKind =
  | "call_site"
  | "constructor_site"
  | "implementor"
  | "type_info"
  | "override_site";

export interface UsageHit {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  signature: string;
  snippet: string;
  score: number;
  source_index: "usage";
  entry_kind?: UsageEntryKind;
}

export interface UsageSearchResult {
  hits: UsageHit[];
  message?: string;
}

// Ordered so more specific verbs (e.g. "references to") win over generic ones
// ("users of") that could otherwise match unintended phrasings.
const VERB_PATTERNS: Array<{ re: RegExp; verb: UsageVerb }> = [
  // callers / call sites
  { re: /^\s*callers?\s+of\s+(.+?)\s*$/i, verb: "callers" },
  { re: /^\s*call\s+sites?\s+of\s+(.+?)\s*$/i, verb: "callers" },
  { re: /^\s*who\s+calls\s+(.+?)\s*$/i, verb: "callers" },
  { re: /^\s*users?\s+of\s+(.+?)\s*$/i, verb: "callers" },
  { re: /^\s*references?\s+to\s+(.+?)\s*$/i, verb: "callers" },
  // constructors / instances
  { re: /^\s*constructors?\s+of\s+(.+?)\s*$/i, verb: "constructors" },
  { re: /^\s*constructions?\s+of\s+(.+?)\s*$/i, verb: "constructors" },
  { re: /^\s*instances?\s+of\s+(.+?)\s*$/i, verb: "constructors" },
  { re: /^\s*new\s+(.+?)\s*$/i, verb: "constructors" },
  // implementations / subclasses
  { re: /^\s*implementations?\s+of\s+(.+?)\s*$/i, verb: "implementations" },
  { re: /^\s*implementors?\s+of\s+(.+?)\s*$/i, verb: "implementations" },
  { re: /^\s*subclasses?\s+of\s+(.+?)\s*$/i, verb: "implementations" },
  { re: /^\s*extenders?\s+of\s+(.+?)\s*$/i, verb: "implementations" },
  // overrides
  { re: /^\s*overrides?\s+of\s+(.+?)\s*$/i, verb: "overrides" },
  { re: /^\s*overriders?\s+of\s+(.+?)\s*$/i, verb: "overrides" },
  // type-of
  { re: /^\s*type\s+of\s+(.+?)\s*$/i, verb: "type" },
  { re: /^\s*return\s+type\s+of\s+(.+?)\s*$/i, verb: "type" },
];

export function parseUsageQuery(query: string): ParsedUsageQuery | null {
  const q = query.replace(/\s+/g, " ");
  for (const { re, verb } of VERB_PATTERNS) {
    const m = re.exec(q);
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

interface ResolvedSymbol {
  id: SymbolId;
  decl: NamedDecl;
}

// Back-compat wrapper: find.ts calls runUsageSearch(...) and expects UsageHit[]
// directly. New callers should prefer runUsageSearchDetailed for the message
// field (e.g. "no symbol named 'X' found").
export function runUsageSearch(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  parsed: ParsedUsageQuery
): UsageHit[] {
  return runUsageSearchDetailed(project, root, index, parsed).hits;
}

export function runUsageSearchDetailed(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  parsed: ParsedUsageQuery
): UsageSearchResult {
  const targetName = parsed.target;

  // "type of" is the only verb that operates on any bindable identifier
  // (variables, properties, params). The others require a class/interface/
  // function-shaped declaration.
  switch (parsed.verb) {
    case "callers":
      return runCallers(project, root, index, targetName);
    case "constructors":
      return runConstructors(project, root, index, targetName);
    case "implementations":
      return runImplementations(project, root, index, targetName);
    case "overrides":
      return runOverrides(project, root, index, targetName);
    case "type":
      return runTypeOf(project, root, index, targetName);
  }
}

// ---- verb implementations ----

function runCallers(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  targetName: string
): UsageSearchResult {
  const resolved = resolveNameToSymbol(targetName, project, root, index);
  if (!resolved) return noSymbolResult(targetName);

  const nameNode = getNameNode(resolved.decl);
  if (!nameNode) {
    return { hits: [], message: `symbol '${targetName}' has no findable name node` };
  }

  let refs: Node[] = [];
  try {
    refs = nameNode.findReferencesAsNodes();
  } catch {
    return { hits: [], message: `could not walk references for '${targetName}'` };
  }

  const declStart = resolved.decl.getStart();
  const declFile = resolved.decl.getSourceFile().getFilePath();

  const out: UsageHit[] = [];
  const seen = new Set<string>();
  for (const refNode of refs) {
    // skip the declaration site itself
    if (
      refNode.getStart() === declStart &&
      refNode.getSourceFile().getFilePath() === declFile
    ) {
      continue;
    }
    // Only include Call/New/PropertyAccess-wrapping-call references. Bare
    // type-references and imports are noise for a "callers of" query.
    if (!isCallOrNewOrPropertyAccessRef(refNode)) continue;

    const callExpr = getEnclosingCallOrNew(refNode);
    const container = findContainingNamedDeclaration(refNode);
    const hit = buildCallSiteHit(root, refNode, callExpr, container);
    if (!hit) continue;
    const key = `${hit.id}::${hit.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return { hits: out };
}

function runConstructors(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  targetName: string
): UsageSearchResult {
  // Symbol resolution here is best-effort: we still walk every NewExpression
  // matching the bare name even if resolution fails, since the ts-morph AST
  // walk is the source of truth for construction sites.
  const resolved = resolveNameToSymbol(targetName, project, root, index);
  const bareName = targetName.split(".").pop() ?? targetName;
  const resolvedFile = resolved?.decl.getSourceFile().getFilePath();

  const out: UsageHit[] = [];
  const seen = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    for (const news of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const exprText = news.getExpression().getText();
      // Match either bare "new Foo(" or namespaced "new Ns.Foo(".
      if (exprText !== bareName && !exprText.endsWith(`.${bareName}`)) continue;

      const hit = buildConstructorSiteHit(root, news);
      if (!hit) continue;
      const key = `${hit.id}::${hit.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }

  if (out.length === 0 && !resolved) {
    return noSymbolResult(targetName);
  }
  if (out.length === 0 && resolvedFile) {
    return {
      hits: [],
      message: `no 'new ${bareName}(...)' construction sites found`,
    };
  }
  return { hits: out };
}

function runImplementations(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  targetName: string
): UsageSearchResult {
  const resolved = resolveNameToSymbol(targetName, project, root, index);
  if (!resolved) return noSymbolResult(targetName);
  if (
    !Node.isClassDeclaration(resolved.decl) &&
    !Node.isInterfaceDeclaration(resolved.decl)
  ) {
    return {
      hits: [],
      message: `'${targetName}' is not a class or interface — implementations only apply to those`,
    };
  }

  const bareName = targetName.split(".").pop() ?? targetName;
  const out: UsageHit[] = [];
  const seen = new Set<SymbolId>();

  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    for (const cls of sf.getClasses()) {
      if (heritageMatches(cls, bareName)) {
        const hit = buildImplementorHit(root, cls, "class");
        if (hit && !seen.has(hit.id)) {
          seen.add(hit.id);
          out.push(hit);
        }
      }
    }
    for (const iface of sf.getInterfaces()) {
      if (heritageMatches(iface, bareName)) {
        const hit = buildImplementorHit(root, iface, "interface");
        if (hit && !seen.has(hit.id)) {
          seen.add(hit.id);
          out.push(hit);
        }
      }
    }
  }

  return { hits: out };
}

function runOverrides(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  targetName: string
): UsageSearchResult {
  const resolved = resolveNameToSymbol(targetName, project, root, index);

  // For "overrides of greet" without a class qualifier, we still search: match
  // any method named `greet` in a class whose base chain has a method with the
  // same name. This is more useful than refusing.
  const memberName = targetName.includes(".")
    ? (targetName.split(".").pop() ?? targetName)
    : targetName;

  const out: UsageHit[] = [];
  const seen = new Set<SymbolId>();

  if (resolved && Node.isMethodDeclaration(resolved.decl)) {
    // qualified: "Base.greet" — find subclasses of Base with a method named greet
    const parentClass = resolved.decl.getParent();
    if (parentClass && Node.isClassDeclaration(parentClass)) {
      const parentName = parentClass.getName();
      if (parentName) {
        collectOverrideCandidates(project, root, parentName, memberName, out, seen);
      }
    }
  } else {
    // unqualified "overrides of greet": walk every class, if any method with
    // that name exists AND a superclass chain also has that method, treat as
    // an override.
    for (const sf of project.getSourceFiles()) {
      if (sf.isDeclarationFile()) continue;
      for (const cls of sf.getClasses()) {
        const method = cls.getMethod(memberName);
        if (!method) continue;
        if (!classChainHasMethod(cls, memberName, /* skipSelf */ true)) continue;
        const hit = buildOverrideSiteHit(root, cls, method);
        if (hit && !seen.has(hit.id)) {
          seen.add(hit.id);
          out.push(hit);
        }
      }
    }
  }

  if (out.length === 0 && !resolved) {
    // We at least walked the tree above; if truly nothing found, hint the user.
    return {
      hits: [],
      message: `no overrides of '${memberName}' found — try qualifying as 'Class.method'`,
    };
  }
  return { hits: out };
}

function runTypeOf(
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex,
  targetName: string
): UsageSearchResult {
  const resolved = resolveNameToSymbol(targetName, project, root, index);
  if (!resolved) return noSymbolResult(targetName);

  const typeString = extractTypeString(resolved.decl);
  const sf = resolved.decl.getSourceFile();
  const modulePath = toRelPath(root, sf.getFilePath());
  const { line } = sf.getLineAndColumnAtPos(resolved.decl.getStart());
  const snippet = extractLine(sf, line);
  const kind = classifyKind(resolved.decl) ?? "variable";

  const hit: UsageHit = {
    id: resolved.id,
    kind,
    name: bareName(targetName),
    signature: typeString,
    snippet,
    score: 1.0,
    source_index: "usage",
    entry_kind: "type_info",
  };
  return { hits: [hit] };
}

// ---- symbol resolution ----

/**
 * resolveNameToSymbol: exact-match → case-insensitive → fuzzy (via name index).
 * Handles Class.method / Namespace.member by resolving the parent then walking
 * to the member.
 */
export function resolveNameToSymbol(
  name: string,
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex
): ResolvedSymbol | null {
  const parts = name.split(".");
  if (parts.length === 2) {
    return resolveQualified(parts[0], parts[1], project, root, index);
  }
  return resolveSingle(name, project, root, index);
}

function resolveSingle(
  name: string,
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex
): ResolvedSymbol | null {
  // pass 1: exact name across the whole project
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const decl = findTopLevel(sf, name);
    if (decl) {
      const id = symbolIdFor(root, decl, undefined, name);
      return { id, decl };
    }
  }
  // pass 2: case-insensitive
  const lower = name.toLowerCase();
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const found = findTopLevelCaseInsensitive(sf, lower);
    if (found) {
      const id = symbolIdFor(root, found.decl, undefined, found.name);
      return { id, decl: found.decl };
    }
  }
  // pass 3: fuzzy via the name index (delegates scoring)
  const hits = index.search(name);
  for (const h of hits) {
    if (h.score < 0.3) break;
    const decl = symbolIdToDecl(project, root, h.id);
    if (decl) return { id: h.id, decl };
  }
  return null;
}

function resolveQualified(
  parent: string,
  member: string,
  project: Project,
  root: ProjectRoot,
  index: NameSearchIndex
): ResolvedSymbol | null {
  const parentResolved = resolveSingle(parent, project, root, index);
  if (!parentResolved) return null;
  const parentDecl = parentResolved.decl;

  if (Node.isClassDeclaration(parentDecl)) {
    const m = parentDecl.getMethod(member);
    if (m) return { id: symbolIdFor(root, m, parent, member), decl: m };
    const p = parentDecl.getProperty(member);
    if (p) return { id: symbolIdFor(root, p, parent, member), decl: p };
  }
  if (Node.isInterfaceDeclaration(parentDecl)) {
    const m = parentDecl.getMethod(member);
    if (m) return { id: symbolIdFor(root, m as unknown as MethodDeclaration, parent, member), decl: m as unknown as MethodDeclaration };
    const p = parentDecl.getProperty(member);
    if (p) return { id: symbolIdFor(root, p as unknown as PropertyDeclaration, parent, member), decl: p as unknown as PropertyDeclaration };
  }
  if (Node.isModuleDeclaration(parentDecl)) {
    // walk namespace body for a top-level declaration with that name
    const body = parentDecl.getBody();
    if (body && Node.isModuleBlock(body)) {
      for (const stmt of body.getStatements()) {
        const anyStmt = stmt as unknown as { getName?: () => string | undefined };
        const stmtName = anyStmt.getName?.();
        if (stmtName === member) {
          const decl = stmt as unknown as NamedDecl;
          return { id: symbolIdFor(root, decl, parent, member), decl };
        }
      }
    }
  }
  return null;
}

function findTopLevelCaseInsensitive(
  sf: SourceFile,
  lower: string
): { decl: NamedDecl; name: string } | null {
  const buckets: Array<{ name: string; decl: NamedDecl }> = [];
  for (const cls of sf.getClasses()) {
    const n = cls.getName();
    if (n) buckets.push({ name: n, decl: cls });
  }
  for (const fn of sf.getFunctions()) {
    const n = fn.getName();
    if (n) buckets.push({ name: n, decl: fn });
  }
  for (const iface of sf.getInterfaces()) {
    buckets.push({ name: iface.getName(), decl: iface });
  }
  for (const alias of sf.getTypeAliases()) {
    buckets.push({ name: alias.getName(), decl: alias });
  }
  for (const en of sf.getEnums()) {
    buckets.push({ name: en.getName(), decl: en });
  }
  for (const ns of sf.getModules()) {
    buckets.push({ name: ns.getName(), decl: ns });
  }
  for (const v of sf.getVariableDeclarations()) {
    buckets.push({ name: v.getName(), decl: v });
  }
  for (const b of buckets) {
    if (b.name.toLowerCase() === lower) return b;
  }
  return null;
}

// ---- override helpers ----

function collectOverrideCandidates(
  project: Project,
  root: ProjectRoot,
  parentClassName: string,
  methodName: string,
  out: UsageHit[],
  seen: Set<SymbolId>
): void {
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    for (const cls of sf.getClasses()) {
      const method = cls.getMethod(methodName);
      if (!method) continue;
      if (!classExtendsChainName(cls, parentClassName)) continue;
      const hit = buildOverrideSiteHit(root, cls, method);
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        out.push(hit);
      }
    }
  }
}

function classExtendsChainName(cls: ClassDeclaration, targetName: string): boolean {
  let cur: ClassDeclaration | undefined = cls.getBaseClass();
  const seen = new Set<string>();
  while (cur) {
    const n = cur.getName();
    if (!n) return false;
    if (seen.has(n)) return false;
    seen.add(n);
    if (n === targetName) return true;
    cur = cur.getBaseClass();
  }
  // fall back to lexical `extends X` even when getBaseClass fails to resolve
  const extendsClause = cls.getExtends();
  if (extendsClause) {
    const expr = extendsClause.getExpression().getText();
    if (expr === targetName || expr.endsWith(`.${targetName}`)) return true;
  }
  return false;
}

function classChainHasMethod(
  cls: ClassDeclaration,
  methodName: string,
  skipSelf: boolean
): boolean {
  let cur: ClassDeclaration | undefined = skipSelf ? cls.getBaseClass() : cls;
  const seen = new Set<string>();
  while (cur) {
    const n = cur.getName();
    if (n) {
      if (seen.has(n)) return false;
      seen.add(n);
    }
    if (cur.getMethod(methodName)) return true;
    cur = cur.getBaseClass();
  }
  return false;
}

// ---- heritage helpers ----

function heritageMatches(
  decl: ClassDeclaration | InterfaceDeclaration,
  targetName: string
): boolean {
  for (const clause of decl.getHeritageClauses()) {
    for (const t of clause.getTypeNodes()) {
      const exprText = t.getExpression().getText();
      if (exprText === targetName || exprText.endsWith(`.${targetName}`)) {
        return true;
      }
    }
  }
  return false;
}

// ---- call-classification helpers ----

function isCallOrNewOrPropertyAccessRef(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (Node.isCallExpression(parent) && parent.getExpression() === node) return true;
  if (Node.isNewExpression(parent) && parent.getExpression() === node) return true;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) {
    const gp = parent.getParent();
    if (
      gp &&
      (Node.isCallExpression(gp) || Node.isNewExpression(gp)) &&
      gp.getExpression() === parent
    ) {
      return true;
    }
  }
  return false;
}

function getEnclosingCallOrNew(node: Node): Node | null {
  const parent = node.getParent();
  if (!parent) return null;
  if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) return parent;
  if (Node.isPropertyAccessExpression(parent)) {
    const gp = parent.getParent();
    if (gp && (Node.isCallExpression(gp) || Node.isNewExpression(gp))) return gp;
  }
  return null;
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
  const anyDecl = decl as unknown as {
    getNameNode?: () => (Node & ReferenceFindableNode) | undefined;
  };
  const nameNode = anyDecl.getNameNode?.();
  return nameNode ?? null;
}

// ---- hit builders ----

function buildCallSiteHit(
  root: ProjectRoot,
  refNode: Node,
  callExpr: Node | null,
  container: Node | null
): UsageHit | null {
  const sf = refNode.getSourceFile();
  const { line } = sf.getLineAndColumnAtPos(refNode.getStart());
  const modulePath = toRelPath(root, sf.getFilePath());
  const snippet = extractLine(sf, line);
  const signature = callExpr ? firstLineCapped(callExpr.getText(), 160) : snippet;

  let callerName = "<call site>";
  let containerName = "";
  if (container) {
    const cName = (container as unknown as { getName?: () => string | undefined }).getName?.();
    if (cName) {
      callerName = cName;
      containerName = cName;
    }
  }
  // Kind here is the caller's kind (function/method/class), used by find.ts
  // filters. entry_kind carries the richer "call_site" taxonomy.
  const kind: SymbolKind = container ? (classifyKind(container) ?? "function") : "function";
  const idSuffix = containerName || `L${line}`;
  const id: SymbolId = `sym:${modulePath}#${idSuffix}`;
  return {
    id,
    kind,
    name: callerName,
    signature,
    snippet,
    score: 1.0,
    source_index: "usage",
    entry_kind: "call_site",
  };
}

function buildConstructorSiteHit(root: ProjectRoot, newExpr: Node): UsageHit | null {
  const sf = newExpr.getSourceFile();
  const { line } = sf.getLineAndColumnAtPos(newExpr.getStart());
  const modulePath = toRelPath(root, sf.getFilePath());
  const snippet = extractLine(sf, line);
  const signature = firstLineCapped(newExpr.getText(), 160);

  const container = findContainingNamedDeclaration(newExpr);
  let name = "<constructor site>";
  let containerName = "";
  if (container) {
    const cName = (container as unknown as { getName?: () => string | undefined }).getName?.();
    if (cName) {
      name = cName;
      containerName = cName;
    }
  }
  const kind: SymbolKind = container ? (classifyKind(container) ?? "function") : "function";
  const idSuffix = containerName ? `${containerName}@L${line}` : `L${line}`;
  const id: SymbolId = `sym:${modulePath}#${idSuffix}`;
  return {
    id,
    kind,
    name,
    signature,
    snippet,
    score: 1.0,
    source_index: "usage",
    entry_kind: "constructor_site",
  };
}

function buildImplementorHit(
  root: ProjectRoot,
  decl: ClassDeclaration | InterfaceDeclaration,
  kind: SymbolKind
): UsageHit | null {
  const name = decl.getName();
  if (!name) return null;
  const sf = decl.getSourceFile();
  const modulePath = toRelPath(root, sf.getFilePath());
  const id: SymbolId = `sym:${modulePath}#${name}`;
  const signature = extractDeclSignature(decl, name);
  const { line } = sf.getLineAndColumnAtPos(decl.getStart());
  const snippet = extractLine(sf, line);
  return {
    id,
    kind,
    name,
    signature,
    snippet,
    score: 1.0,
    source_index: "usage",
    entry_kind: "implementor",
  };
}

function buildOverrideSiteHit(
  root: ProjectRoot,
  cls: ClassDeclaration,
  method: MethodDeclaration
): UsageHit | null {
  const className = cls.getName();
  const methodName = method.getName();
  if (!className || !methodName) return null;
  const sf = cls.getSourceFile();
  const modulePath = toRelPath(root, sf.getFilePath());
  const id: SymbolId = `sym:${modulePath}#${className}.${methodName}`;
  const { line } = sf.getLineAndColumnAtPos(method.getStart());
  const snippet = extractLine(sf, line);
  const params = method.getParameters().map((p) => p.getText()).join(", ");
  const ret = method.getReturnTypeNode()?.getText();
  const signature = `${className}.${methodName}(${params})${ret ? `: ${ret}` : ""}`;
  return {
    id,
    kind: "method",
    name: `${className}.${methodName}`,
    signature,
    snippet,
    score: 1.0,
    source_index: "usage",
    entry_kind: "override_site",
  };
}

// ---- signature/type extraction ----

function extractTypeString(decl: NamedDecl): string {
  try {
    if (Node.isVariableDeclaration(decl)) {
      const t = decl.getTypeNode()?.getText();
      if (t) return t;
      // fall back to inferred type
      return decl.getType().getText(decl);
    }
    if (Node.isPropertyDeclaration(decl)) {
      const t = decl.getTypeNode()?.getText();
      if (t) return t;
      return decl.getType().getText(decl);
    }
    if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
      const ret = decl.getReturnTypeNode()?.getText();
      if (ret) return ret;
      return decl.getReturnType().getText(decl);
    }
    if (Node.isTypeAliasDeclaration(decl)) {
      return decl.getTypeNode()?.getText() ?? decl.getName();
    }
    if (Node.isClassDeclaration(decl)) {
      return `class ${decl.getName() ?? ""}`;
    }
    if (Node.isInterfaceDeclaration(decl)) {
      return `interface ${decl.getName()}`;
    }
    if (Node.isEnumDeclaration(decl)) {
      return `enum ${decl.getName()}`;
    }
  } catch {
    // fall through
  }
  return firstLineCapped(decl.getText(), 160);
}

function extractDeclSignature(
  decl: ClassDeclaration | InterfaceDeclaration,
  name: string
): string {
  if (Node.isClassDeclaration(decl)) {
    const base = decl.getExtends()?.getText();
    const impls = decl.getImplements().map((i) => i.getText()).join(", ");
    let sig = `class ${name}`;
    if (base) sig += ` extends ${base}`;
    if (impls) sig += ` implements ${impls}`;
    return sig;
  }
  const extendsClauses = decl.getExtends().map((e) => e.getText()).join(", ");
  return extendsClauses ? `interface ${name} extends ${extendsClauses}` : `interface ${name}`;
}

// ---- misc helpers ----

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

function symbolIdFor(
  root: ProjectRoot,
  decl: NamedDecl,
  parent: string | undefined,
  name: string
): SymbolId {
  const modulePath = toRelPath(root, decl.getSourceFile().getFilePath());
  const qualified = parent ? `${parent}.${name}` : name;
  return `sym:${modulePath}#${qualified}`;
}

function symbolIdToDecl(project: Project, root: ProjectRoot, id: SymbolId): NamedDecl | null {
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
  if (parts.length === 1) return findTopLevel(sf, parts[0]);
  if (parts.length === 2) {
    const parent = findTopLevel(sf, parts[0]);
    if (!parent) return null;
    if (Node.isClassDeclaration(parent)) {
      return parent.getMethod(parts[1]) ?? parent.getProperty(parts[1]) ?? null;
    }
    if (Node.isInterfaceDeclaration(parent)) {
      const m = parent.getMethod(parts[1]);
      if (m) return m as unknown as MethodDeclaration;
      const p = parent.getProperty(parts[1]);
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

function bareName(qualified: string): string {
  return qualified.split(".").pop() ?? qualified;
}

function noSymbolResult(target: string): UsageSearchResult {
  return { hits: [], message: `no symbol named '${target}' found` };
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
