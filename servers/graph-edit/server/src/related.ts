import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Node, type Project, type SourceFile } from "ts-morph";
import { resolveSymbolIdToNode } from "./backends/ts-morph-read.js";
import type { ModulePath, ProjectRoot, RelatedItem, SymbolId, SymbolKind } from "./types.js";

export async function buildRelated(
  project: Project,
  root: ProjectRoot,
  sourceId: SymbolId,
  limit = 3
): Promise<RelatedItem[]> {
  const decl = resolveSymbolIdToNode(project, root, sourceId);
  if (!decl) return [];

  const out: RelatedItem[] = [];
  const seen = new Set<SymbolId>([sourceId]);

  const nameNode = (decl as unknown as { getNameNode?: () => Node | undefined }).getNameNode?.();
  if (nameNode) {
    try {
      const refs = project.getLanguageService().findReferencesAsNodes(nameNode);
      const declStart = decl.getStart();
      const declFile = decl.getSourceFile().getFilePath();
      const callerLimit = 2;
      let picked = 0;
      for (const refNode of refs) {
        if (picked >= callerLimit) break;
        if (refNode.getStart() === declStart && refNode.getSourceFile().getFilePath() === declFile) continue;
        const container = findContainingNamedDeclaration(refNode);
        if (!container) continue;
        const item = toRelatedItem(root, container, "called by target");
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
        picked += 1;
      }
    } catch {
      // findReferences can throw on synthetic/global nodes; skip gracefully.
    }
  }

  if (out.length < limit) {
    const sf = decl.getSourceFile();
    const siblings = getExportedTopLevelDeclarations(sf);
    for (const sib of siblings) {
      if (out.length >= limit) break;
      if (sib === decl) continue;
      const item = toRelatedItem(root, sib, "same module sibling");
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }

  if (out.length < limit) {
    const sf = decl.getSourceFile();
    const testItem = findSiblingTestFile(project, root, sf);
    if (testItem && !seen.has(testItem.id)) {
      seen.add(testItem.id);
      out.push(testItem);
    }
  }

  return out.slice(0, limit);
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

function getExportedTopLevelDeclarations(sf: SourceFile): Node[] {
  const out: Node[] = [];
  for (const cls of sf.getClasses()) if (cls.isExported()) out.push(cls);
  for (const fn of sf.getFunctions()) if (fn.isExported()) out.push(fn);
  for (const iface of sf.getInterfaces()) if (iface.isExported()) out.push(iface);
  for (const alias of sf.getTypeAliases()) if (alias.isExported()) out.push(alias);
  for (const en of sf.getEnums()) if (en.isExported()) out.push(en);
  for (const v of sf.getVariableDeclarations()) {
    const stmt = v.getVariableStatement();
    if (stmt && stmt.isExported()) out.push(v);
  }
  return out;
}

function toRelatedItem(
  root: ProjectRoot,
  node: Node,
  reason: string
): RelatedItem | null {
  const anyNode = node as unknown as { getName?: () => string | undefined };
  const name = anyNode.getName?.();
  if (!name) return null;
  const kind = classifyKind(node);
  if (!kind) return null;
  const sf = node.getSourceFile();
  const modulePath = toRelPath(root, sf.getFilePath());
  const qualified = qualifiedName(node, name);
  const id: SymbolId = `sym:${modulePath}#${qualified}`;
  return { id, kind, name, reason };
}

function qualifiedName(node: Node, name: string): string {
  if (Node.isMethodDeclaration(node) || Node.isPropertyDeclaration(node)) {
    const parent = node.getParent();
    if (parent && Node.isClassDeclaration(parent)) {
      const parentName = parent.getName();
      if (parentName) return `${parentName}.${name}`;
    }
  }
  return name;
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

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  return relative(root, absPath).split(/[\\/]/).join("/");
}

function findSiblingTestFile(
  project: Project,
  root: ProjectRoot,
  sf: SourceFile
): RelatedItem | null {
  const filePath = sf.getFilePath();
  const dir = dirname(filePath);
  const base = sf.getBaseName().replace(/\.(tsx?|jsx?)$/i, "");
  const candidates = [
    join(dir, `${base}.test.ts`),
    join(dir, `${base}.test.tsx`),
    join(dir, `${base}.spec.ts`),
    join(dir, `${base}.spec.tsx`),
  ];
  for (const candidate of candidates) {
    const tsf = project.getSourceFile(candidate);
    if (tsf || existsSync(candidate)) {
      const modulePath = toRelPath(root, candidate);
      const name = candidate.split(/[\\/]/).pop() ?? modulePath;
      return {
        id: `sym:${modulePath}#${base}`,
        kind: "function",
        name,
        reason: "sibling test",
      };
    }
  }
  return null;
}
