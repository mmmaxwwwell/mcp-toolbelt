import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import micromatch from "micromatch";
import {
  Node,
  Project,
  SyntaxKind,
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  type ModuleDeclaration,
  type PropertyDeclaration,
  type PropertySignature,
  type SourceFile,
  type TypeAliasDeclaration,
  type VariableDeclaration,
  type VariableStatement,
} from "ts-morph";
import { NotImplementedError } from "../errors.js";
import type {
  ModulePath,
  PolicyConfig,
  ProjectRoot,
  Reference,
  SymbolDetail,
  SymbolId,
  SymbolKind,
  SymbolRecord,
} from "../types.js";

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

export class TsMorphReadBackend {
  private project: Project | null = null;
  private root: ProjectRoot | null = null;

  async load(root: ProjectRoot, policy: PolicyConfig): Promise<void> {
    const tsconfigPath = join(root, policy.project.tsconfig);
    const useTsconfig = existsSync(tsconfigPath);
    this.project = new Project({
      ...(useTsconfig
        ? { tsConfigFilePath: tsconfigPath }
        : {
            compilerOptions: {
              target: 99,
              module: 99,
              moduleResolution: 100,
              strict: true,
              allowJs: true,
            },
          }),
      skipAddingFilesFromTsConfig: false,
    });
    if (!useTsconfig) {
      const patterns = [
        join(root, "**/*.ts"),
        join(root, "**/*.tsx"),
        "!**/node_modules/**",
        "!**/dist/**",
      ];
      this.project.addSourceFilesAtPaths(patterns);
    }
    this.root = root;
  }

  async reload(): Promise<void> {
    if (!this.project || !this.root) throw new NotImplementedError("reload", "not loaded");
    for (const sf of this.project.getSourceFiles()) sf.refreshFromFileSystemSync();
  }

  getProject(): Project {
    if (!this.project) throw new NotImplementedError("session", "project not loaded");
    return this.project;
  }

  getRoot(): ProjectRoot {
    if (!this.root) throw new NotImplementedError("session", "root not loaded");
    return this.root;
  }

  resolveSymbolIdToNode(id: SymbolId): NamedDecl | null {
    return resolveSymbolIdToNode(this.getProject(), this.getRoot(), id);
  }

  async listSymbols(
    query?: string,
    kinds?: SymbolKind[],
    scope?: string
  ): Promise<SymbolRecord[]> {
    const project = this.getProject();
    const root = this.getRoot();
    const kindSet = kinds && kinds.length > 0 ? new Set(kinds) : null;
    const rx = query ? tryRegex(query) : null;

    const out: SymbolRecord[] = [];
    for (const sf of project.getSourceFiles()) {
      const modulePath = toRelPath(root, sf.getFilePath());
      if (scope && !micromatch.isMatch(modulePath, scope)) continue;
      for (const rec of enumerateSymbols(sf, modulePath)) {
        if (kindSet && !kindSet.has(rec.kind)) continue;
        if (query && !nameMatches(rec.name, query, rx)) continue;
        out.push(rec);
      }
    }
    return out;
  }

  async getSymbol(id: SymbolId): Promise<SymbolDetail> {
    const project = this.getProject();
    const root = this.getRoot();
    const parsed = parseSymbolId(id);
    if (!parsed) throw new NotImplementedError("get_symbol", `invalid id: ${id}`);
    const decl = resolveSymbolIdToNode(project, root, id);
    if (!decl) throw new NotImplementedError("get_symbol", `symbol not found: ${id}`);

    const module = parsed.module;
    const qualified = parsed.qualifiedName;
    const displayName = qualified === "default"
      ? "default"
      : qualified.includes(".")
        ? qualified.split(".").pop()!
        : qualified;

    const rec = nodeToRecord(decl, displayName, module, qualified);
    if (!rec) throw new NotImplementedError("get_symbol", `unrenderable: ${id}`);

    let refCount = 0;
    try {
      const nameNode = getNameNodeOf(decl);
      if (nameNode) refCount = project.getLanguageService().findReferencesAsNodes(nameNode).length;
    } catch {
      refCount = 0;
    }

    const members = collectMembers(decl, module, qualified);
    const body = extractBody(decl);
    const definedIn = toRelPath(root, decl.getSourceFile().getFilePath());

    return {
      ...rec,
      source_render: decl.getText(),
      body,
      references_count: refCount,
      defined_in: definedIn,
      members,
    };
  }

  async getReferences(id: SymbolId): Promise<Reference[]> {
    const project = this.getProject();
    const root = this.getRoot();
    const decl = resolveSymbolIdToNode(project, root, id);
    if (!decl) throw new NotImplementedError("get_references", `symbol not found: ${id}`);

    const nameNode = getNameNode(decl);
    if (!nameNode) return [];

    const declStart = decl.getStart();
    const declFile = decl.getSourceFile().getFilePath();

    const refs = project.getLanguageService().findReferencesAsNodes(nameNode);
    const out: Reference[] = [];
    for (const node of refs) {
      const nodeStart = node.getStart();
      const nodeFile = node.getSourceFile().getFilePath();
      if (nodeStart === declStart && nodeFile === declFile) continue;

      const sf = node.getSourceFile();
      const { line, column } = sf.getLineAndColumnAtPos(nodeStart);
      const file = toRelPath(root, sf.getFilePath());
      const contextLine = extractContextLine(sf, line);
      out.push({
        file,
        line,
        column,
        context_line: contextLine,
        kind: classifyReferenceKind(node),
      });
    }
    return out;
  }

  async listModules(
    pattern?: string
  ): Promise<Array<{ path: ModulePath; exports: string[]; imports_count: number }>> {
    const project = this.getProject();
    const root = this.getRoot();
    const out: Array<{ path: ModulePath; exports: string[]; imports_count: number }> = [];
    for (const sf of project.getSourceFiles()) {
      const modulePath = toRelPath(root, sf.getFilePath());
      if (pattern && !micromatch.isMatch(modulePath, pattern)) continue;
      const exportNames: string[] = [];
      for (const [name] of sf.getExportedDeclarations()) exportNames.push(name);
      out.push({
        path: modulePath,
        exports: exportNames,
        imports_count: sf.getImportDeclarations().length,
      });
    }
    return out;
  }

  async describeModule(
    path: ModulePath
  ): Promise<{
    exports: SymbolRecord[];
    imports: Array<{ module: ModulePath; symbols: string[] }>;
  }> {
    const project = this.getProject();
    const root = this.getRoot();
    const absPath = isAbsolute(path) ? path : join(root, path);
    const sf = project.getSourceFile(absPath) ?? project.getSourceFile(path);
    if (!sf) throw new NotImplementedError("describe_module", `module not found: ${path}`);

    const modulePath = toRelPath(root, sf.getFilePath());
    const exports: SymbolRecord[] = [];
    const seen = new Set<string>();
    for (const [name, decls] of sf.getExportedDeclarations()) {
      if (decls.length === 0) continue;
      const decl = decls[0];
      const displayName = name;
      const qualified = name;
      const rec = nodeToRecord(decl as Node, displayName, modulePath, qualified);
      if (!rec) continue;
      rec.is_exported = true;
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      exports.push(rec);
    }

    const imports = sf.getImportDeclarations().map((imp) => {
      const named = imp.getNamedImports().map((n) => {
        const alias = n.getAliasNode()?.getText();
        return alias ? `${n.getName()} as ${alias}` : n.getName();
      });
      const def = imp.getDefaultImport()?.getText();
      const ns = imp.getNamespaceImport()?.getText();
      const symbols = [
        ...(def ? [def] : []),
        ...(ns ? [`* as ${ns}`] : []),
        ...named,
      ];
      return { module: imp.getModuleSpecifierValue(), symbols };
    });

    return { exports, imports };
  }
}

function parseSymbolId(id: SymbolId): { module: ModulePath; qualifiedName: string } | null {
  if (!id.startsWith("sym:")) return null;
  const rest = id.slice(4);
  const hash = rest.indexOf("#");
  if (hash < 0) return null;
  return { module: rest.slice(0, hash), qualifiedName: rest.slice(hash + 1) };
}

function tryRegex(q: string): RegExp | null {
  if (!/[.*+?^${}()|[\]\\]/.test(q)) return null;
  try {
    return new RegExp(q, "i");
  } catch {
    return null;
  }
}

function nameMatches(name: string, query: string, rx: RegExp | null): boolean {
  if (rx) return rx.test(name);
  return name.toLowerCase().includes(query.toLowerCase());
}

function makeId(module: ModulePath, qualified: string): SymbolId {
  return `sym:${module}#${qualified}`;
}

function* enumerateSymbols(sf: SourceFile, module: ModulePath): Generator<SymbolRecord> {
  for (const c of sf.getClasses()) {
    const name = c.getName();
    if (!name) continue;
    const r = nodeToRecord(c, name, module, name);
    if (r) yield r;
  }
  for (const i of sf.getInterfaces()) {
    const r = nodeToRecord(i, i.getName(), module, i.getName());
    if (r) yield r;
  }
  for (const t of sf.getTypeAliases()) {
    const r = nodeToRecord(t, t.getName(), module, t.getName());
    if (r) yield r;
  }
  for (const e of sf.getEnums()) {
    const r = nodeToRecord(e, e.getName(), module, e.getName());
    if (r) yield r;
  }
  for (const fnGroup of collapseFunctionOverloads(sf)) {
    const r = nodeToRecord(fnGroup.node, fnGroup.name, module, fnGroup.name);
    if (r) yield r;
  }
  for (const vs of sf.getVariableStatements()) {
    for (const d of vs.getDeclarations()) {
      const r = nodeToRecord(d, d.getName(), module, d.getName());
      if (r) yield r;
    }
  }
  for (const m of sf.getModules()) {
    const nsName = m.getName();
    const r = nodeToRecord(m, nsName, module, nsName);
    if (r) yield r;
    yield* enumerateNamespaceMembers(m, module, nsName);
  }
  const exported = sf.getExportedDeclarations();
  if (exported.has("default")) {
    const decl = exported.get("default")?.[0];
    if (decl) {
      const r = nodeToRecord(decl as Node, "default", module, "default");
      if (r) {
        r.is_exported = true;
        yield r;
      }
    }
  }
}

function* enumerateNamespaceMembers(
  ns: ModuleDeclaration,
  module: ModulePath,
  prefix: string
): Generator<SymbolRecord> {
  const body = ns.getBody();
  if (!body) return;
  const getStmts = (body as unknown as { getStatements?: () => Node[] }).getStatements;
  if (typeof getStmts !== "function") return;
  const stmts = getStmts.call(body) as Node[];
  for (const s of stmts) {
    if (Node.isClassDeclaration(s) && s.getName()) {
      const q = `${prefix}.${s.getName()}`;
      const r = nodeToRecord(s, s.getName()!, module, q);
      if (r) yield r;
    } else if (Node.isFunctionDeclaration(s) && s.getName()) {
      const q = `${prefix}.${s.getName()}`;
      const r = nodeToRecord(s, s.getName()!, module, q);
      if (r) yield r;
    } else if (Node.isInterfaceDeclaration(s)) {
      const q = `${prefix}.${s.getName()}`;
      const r = nodeToRecord(s, s.getName(), module, q);
      if (r) yield r;
    } else if (Node.isTypeAliasDeclaration(s)) {
      const q = `${prefix}.${s.getName()}`;
      const r = nodeToRecord(s, s.getName(), module, q);
      if (r) yield r;
    } else if (Node.isEnumDeclaration(s)) {
      const q = `${prefix}.${s.getName()}`;
      const r = nodeToRecord(s, s.getName(), module, q);
      if (r) yield r;
    } else if (Node.isModuleDeclaration(s)) {
      const q = `${prefix}.${s.getName()}`;
      const r = nodeToRecord(s, s.getName(), module, q);
      if (r) yield r;
      yield* enumerateNamespaceMembers(s, module, q);
    } else if (Node.isVariableStatement(s)) {
      for (const d of s.getDeclarations()) {
        const q = `${prefix}.${d.getName()}`;
        const r = nodeToRecord(d, d.getName(), module, q);
        if (r) yield r;
      }
    }
  }
}

interface FuncGroup {
  node: FunctionDeclaration;
  name: string;
}

function collapseFunctionOverloads(sf: SourceFile): FuncGroup[] {
  const buckets = new Map<string, FunctionDeclaration[]>();
  for (const f of sf.getFunctions()) {
    const n = f.getName();
    if (!n) continue;
    const arr = buckets.get(n) ?? [];
    arr.push(f);
    buckets.set(n, arr);
  }
  const out: FuncGroup[] = [];
  for (const [name, group] of buckets) {
    const impl = group.find((g) => g.hasBody());
    out.push({ node: impl ?? group[group.length - 1], name });
  }
  return out;
}

function collectMembers(
  node: Node,
  module: ModulePath,
  ownerQualified: string
): SymbolRecord[] | undefined {
  if (Node.isClassDeclaration(node)) {
    const out: SymbolRecord[] = [];
    for (const m of node.getMethods()) {
      const q = `${ownerQualified}.${m.getName()}`;
      const r = nodeToRecord(m, m.getName(), module, q);
      if (r) out.push(r);
    }
    for (const p of node.getProperties()) {
      const q = `${ownerQualified}.${p.getName()}`;
      const r = nodeToRecord(p, p.getName(), module, q);
      if (r) out.push(r);
    }
    return out;
  }
  if (Node.isInterfaceDeclaration(node)) {
    const out: SymbolRecord[] = [];
    for (const m of node.getMethods()) {
      const q = `${ownerQualified}.${m.getName()}`;
      const r = nodeToRecord(m as unknown as Node, m.getName(), module, q);
      if (r) out.push(r);
    }
    for (const p of node.getProperties()) {
      const q = `${ownerQualified}.${p.getName()}`;
      const r = nodeToRecord(p as unknown as Node, p.getName(), module, q);
      if (r) out.push(r);
    }
    return out;
  }
  if (Node.isEnumDeclaration(node)) {
    return node.getMembers().map((m) => ({
      id: makeId(module, `${ownerQualified}.${m.getName()}`),
      kind: "property" as SymbolKind,
      name: m.getName(),
      module,
      signature: m.getText().split("\n")[0].trim(),
      is_exported: false,
    }));
  }
  return undefined;
}

function extractBody(node: Node): string | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getBody()?.getText();
  }
  return undefined;
}

function getNameNodeOf(node: Node): Node | null {
  const anyNode = node as unknown as { getNameNode?: () => Node | undefined };
  return anyNode.getNameNode?.() ?? null;
}

function nodeToRecord(
  node: Node,
  name: string,
  module: ModulePath,
  qualified: string
): SymbolRecord | null {
  const kind = kindOf(node);
  if (!kind) return null;
  const rec: SymbolRecord = {
    id: makeId(module, qualified),
    kind,
    name,
    module,
    signature: extractSignature(node, name),
    is_exported: isExportedNode(node),
  };
  const doc = extractJsDoc(node);
  if (doc) rec.doc = doc;
  const vis = visibilityOf(node);
  if (vis) rec.visibility = vis;
  return rec;
}

function kindOf(node: Node): SymbolKind | null {
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isFunctionDeclaration(node)) return "function";
  if (Node.isInterfaceDeclaration(node)) return "interface";
  if (Node.isTypeAliasDeclaration(node)) return "type";
  if (Node.isEnumDeclaration(node)) return "enum";
  if (Node.isVariableDeclaration(node) || Node.isVariableStatement(node)) return "variable";
  if (Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) return "method";
  if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) return "property";
  if (Node.isModuleDeclaration(node)) return "namespace";
  return null;
}

function isExportedNode(node: Node): boolean {
  if (Node.isVariableDeclaration(node)) {
    const vs = node.getFirstAncestorByKind(SyntaxKind.VariableStatement) as
      | VariableStatement
      | undefined;
    if (vs) {
      try {
        return vs.isExported();
      } catch {
        return false;
      }
    }
    return false;
  }
  const anyNode = node as unknown as { isExported?: () => boolean; hasExportKeyword?: () => boolean };
  try {
    if (typeof anyNode.isExported === "function") return anyNode.isExported();
    if (typeof anyNode.hasExportKeyword === "function") return anyNode.hasExportKeyword();
  } catch {
    return false;
  }
  return false;
}

function visibilityOf(node: Node): "public" | "private" | "protected" | undefined {
  const anyNode = node as unknown as { getScope?: () => string | undefined };
  if (typeof anyNode.getScope === "function") {
    try {
      const v = anyNode.getScope();
      if (v === "public" || v === "private" || v === "protected") return v;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractJsDoc(node: Node): string | undefined {
  const anyNode = node as unknown as { getJsDocs?: () => Array<{ getInnerText: () => string }> };
  if (typeof anyNode.getJsDocs !== "function") return undefined;
  try {
    const docs = anyNode.getJsDocs();
    if (!docs || docs.length === 0) return undefined;
    const text = docs[docs.length - 1].getInnerText().trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function extractSignature(node: Node, name: string): string {
  if (Node.isFunctionDeclaration(node)) {
    const asyncKw = node.isAsync() ? "async " : "";
    const params = node.getParameters().map((p) => p.getText()).join(", ");
    const ret = node.getReturnTypeNode()?.getText();
    return `${asyncKw}function ${name}(${params})${ret ? `: ${ret}` : ""}`;
  }
  if (Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) {
    const params = (node as MethodDeclaration | MethodSignature)
      .getParameters()
      .map((p) => p.getText())
      .join(", ");
    const ret = (node as MethodDeclaration | MethodSignature).getReturnTypeNode()?.getText();
    return `${name}(${params})${ret ? `: ${ret}` : ""}`;
  }
  if (Node.isClassDeclaration(node)) {
    const heritage = (node as ClassDeclaration).getExtends()?.getText();
    return `class ${name}${heritage ? ` extends ${heritage}` : ""}`;
  }
  if (Node.isInterfaceDeclaration(node)) {
    return `interface ${(node as InterfaceDeclaration).getName()}`;
  }
  if (Node.isTypeAliasDeclaration(node)) {
    const t = (node as TypeAliasDeclaration).getTypeNode()?.getText() ?? "";
    return `type ${name} = ${t}`;
  }
  if (Node.isEnumDeclaration(node)) {
    return `enum ${(node as EnumDeclaration).getName()}`;
  }
  if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) {
    const t = (node as PropertyDeclaration | PropertySignature).getTypeNode()?.getText();
    return `${name}${t ? `: ${t}` : ""}`;
  }
  if (Node.isVariableDeclaration(node)) {
    const t = (node as VariableDeclaration).getTypeNode()?.getText();
    const init = (node as VariableDeclaration).getInitializer()?.getText();
    return `${name}${t ? `: ${t}` : ""}${init ? ` = ${init}` : ""}`.slice(0, 200);
  }
  if (Node.isVariableStatement(node)) {
    const kw = node.getDeclarationKind();
    const first = node.getDeclarations()[0];
    if (first) {
      const t = first.getTypeNode()?.getText();
      const init = first.getInitializer()?.getText();
      return `${kw} ${first.getName()}${t ? `: ${t}` : ""}${init ? ` = ${init}` : ""}`.slice(0, 200);
    }
    return `${kw} ${name}`;
  }
  if (Node.isModuleDeclaration(node)) {
    return `namespace ${name}`;
  }
  return node.getText().split("\n")[0].trim().slice(0, 200);
}

export function resolveSymbolIdToNode(
  project: Project,
  root: ProjectRoot,
  id: SymbolId
): NamedDecl | null {
  if (!id.startsWith("sym:")) return null;
  const body = id.slice(4);
  const hashIdx = body.indexOf("#");
  if (hashIdx < 0) return null;
  const modulePath = body.slice(0, hashIdx);
  const qualified = body.slice(hashIdx + 1);
  const absPath = isAbsolute(modulePath) ? modulePath : join(root, modulePath);
  const sf = project.getSourceFile(absPath) ?? project.getSourceFile(modulePath);
  if (!sf) return null;

  const parts = qualified.split(".");
  if (parts.length === 1) {
    return findTopLevelDeclaration(sf, parts[0]);
  }
  if (parts.length === 2) {
    const [parentName, memberName] = parts;
    const parent = findTopLevelDeclaration(sf, parentName);
    if (!parent) return null;
    return findMember(parent, memberName);
  }
  return null;
}

function findTopLevelDeclaration(sf: SourceFile, name: string): NamedDecl | null {
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

function findMember(parent: NamedDecl, name: string): NamedDecl | null {
  if (Node.isClassDeclaration(parent)) {
    const m = parent.getMethod(name);
    if (m) return m;
    const p = parent.getProperty(name);
    if (p) return p;
  }
  if (Node.isInterfaceDeclaration(parent)) {
    const m = parent.getMethod(name);
    if (m) return m as unknown as MethodDeclaration;
    const p = parent.getProperty(name);
    if (p) return p as unknown as PropertyDeclaration;
  }
  return null;
}

function getNameNode(decl: NamedDecl): Node | null {
  const anyDecl = decl as unknown as { getNameNode?: () => Node | undefined };
  const nameNode = anyDecl.getNameNode?.();
  return nameNode ?? null;
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  const rel = relative(root, absPath);
  return rel.split(/[\\/]/).join("/");
}

function extractContextLine(sf: SourceFile, line: number): string {
  const text = sf.getFullText();
  const lines = text.split(/\r?\n/);
  const raw = lines[line - 1] ?? "";
  const trimmed = raw.trim();
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 119) + "…";
}

function classifyReferenceKind(node: Node): Reference["kind"] {
  if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) return "import";
  if (node.getFirstAncestorByKind(SyntaxKind.ImportEqualsDeclaration)) return "import";
  if (node.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)) return "reexport";

  const heritage = node.getFirstAncestorByKind(SyntaxKind.HeritageClause);
  if (heritage) {
    const token = (heritage as unknown as { getToken?: () => number }).getToken?.();
    if (token === SyntaxKind.ExtendsKeyword) return "extends";
    if (token === SyntaxKind.ImplementsKeyword) return "implements";
    return "extends";
  }

  if (node.getFirstAncestorByKind(SyntaxKind.TypeReference)) return "type_ref";
  if (node.getFirstAncestorByKind(SyntaxKind.TypeQuery)) return "type_ref";

  const parent = node.getParent();
  if (parent) {
    if (Node.isCallExpression(parent) && parent.getExpression() === node) return "call";
    if (Node.isNewExpression(parent) && parent.getExpression() === node) return "call";
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === node
    ) {
      const gp = parent.getParent();
      if (gp && (Node.isCallExpression(gp) || Node.isNewExpression(gp)) && gp.getExpression() === parent) {
        return "call";
      }
    }
  }

  return "type_ref";
}
