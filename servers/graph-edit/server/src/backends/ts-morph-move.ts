import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type ImportDeclaration,
  type SourceFile,
} from "ts-morph";
import type {
  BreakingCaller,
  ModulePath,
  PendingMutation,
  ProjectRoot,
  SymbolId,
  Warning,
} from "../types.js";
import { resolveSymbolIdToNode } from "./ts-morph-read.js";

// Refusal is a first-class response shape — not a thrown exception.
// PendingMutation is nullable so the tool handler can wrap this directly
// into MutationResponse<PendingMutation | null>.
export interface MoveResult {
  mutation: PendingMutation | null;
  warnings: Warning[];
}

// -------- rename_symbol --------

export async function renameSymbol(
  project: Project,
  root: ProjectRoot,
  id: SymbolId,
  newName: string
): Promise<MoveResult> {
  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) {
    return refuse("refusal_not_found", `symbol not found: ${id}`);
  }

  const nameNode = getNameNode(decl);
  if (!nameNode) {
    return refuse("refusal_unrenameable", `symbol has no name node: ${id}`);
  }

  const currentName = getSymbolName(decl);
  if (currentName === newName) {
    return refuse("refusal_no_op", `symbol already named '${newName}'`);
  }

  const clashScope = checkNameClash(decl, newName);
  if (clashScope) {
    return refuse("name_clash", `'${newName}' already exists in ${clashScope}`, id);
  }

  const sourceFilesBefore = snapshotSources(project);

  const renameable = decl as unknown as {
    rename?: (n: string, opts?: { renameInComments?: boolean; renameInStrings?: boolean }) => void;
  };
  if (typeof renameable.rename !== "function") {
    return refuse("refusal_unrenameable", `node kind does not support rename: ${id}`);
  }
  renameable.rename(newName);

  const touched = diffTouchedFiles(project, root, sourceFilesBefore);
  const oldModule = toRel(root, decl.getSourceFile().getFilePath());

  const mutation: PendingMutation = {
    id: randomUUID(),
    kind: "rename_symbol",
    target: makeId(oldModule, replaceLastSegment(parseQualified(id), newName)),
    raw_ops: {
      action: "rename",
      old_id: id,
      new_name: newName,
      touched_files: touched,
    },
  };
  return { mutation, warnings: [] };
}

// -------- move_symbol --------

export async function moveSymbol(
  project: Project,
  root: ProjectRoot,
  id: SymbolId,
  target: ModulePath
): Promise<MoveResult> {
  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) {
    return refuse("refusal_not_found", `symbol not found: ${id}`);
  }

  const symbolName = getSymbolName(decl);
  if (!symbolName) {
    return refuse("refusal_unmoveable", `symbol has no resolvable name: ${id}`);
  }

  const sourceFile = decl.getSourceFile();
  const oldAbs = sourceFile.getFilePath();
  const oldModule = toRel(root, oldAbs);
  const targetAbs = isAbsolute(target) ? target : join(root, target);

  if (targetAbs === oldAbs) {
    return refuse("refusal_no_op", `target module equals source: ${target}`);
  }

  // The moveable node is the top-level statement (function/class/etc). For a
  // VariableDeclaration we hoist to the enclosing VariableStatement so the
  // whole `export const X = ...` moves as a unit.
  const moveable = topLevelForMove(decl);
  if (!moveable) {
    return refuse("refusal_unmoveable", `cannot move non-top-level declaration: ${id}`);
  }

  const existingTarget = project.getSourceFile(targetAbs);
  if (existingTarget) {
    const collision = findTopLevelName(existingTarget, symbolName);
    if (collision) {
      return refuse(
        "name_clash",
        `'${symbolName}' already exists in target module '${target}'`,
        id
      );
    }
  }

  const declText = moveable.getFullText().replace(/^\s+/, "");
  const targetFile =
    existingTarget ?? project.createSourceFile(targetAbs, "", { overwrite: false });

  const targetHadContent = targetFile.getFullText().trim().length > 0;
  const separator = targetHadContent ? "\n\n" : "";
  targetFile.addStatements(separator + declText);

  (moveable as unknown as { remove: () => void }).remove();

  const touched = new Set<ModulePath>();
  touched.add(toRel(root, targetFile.getFilePath()));
  touched.add(oldModule);

  // Rewrite importers: every file that imported symbolName from oldModule now
  // points at the new module (path computed relative to that importer). We
  // deliberately do NOT rewrite barrel re-exports here — barrel management is
  // Phase 3's job. If a barrel `export { symbolName } from './old'` exists,
  // it will surface at commit as a stale re-export the barrel regenerator
  // handles.
  for (const sf of project.getSourceFiles()) {
    if (sf === sourceFile || sf === targetFile) continue;
    let mutated = false;
    for (const imp of sf.getImportDeclarations()) {
      if (!importReferencesOldFile(imp, oldAbs, sf)) continue;
      if (!importIncludesName(imp, symbolName)) continue;
      const newSpec = computeRelativeSpecifier(sf.getFilePath(), targetAbs);
      imp.setModuleSpecifier(newSpec);
      mutated = true;
    }
    if (mutated) touched.add(toRel(root, sf.getFilePath()));
  }

  const sourceIsEmpty = isSourceFileEmpty(sourceFile);
  const filesToDelete: ModulePath[] = sourceIsEmpty ? [oldModule] : [];

  const newId = makeId(
    toRel(root, targetAbs),
    replaceLastSegment(parseQualified(id), symbolName)
  );

  const mutation: PendingMutation = {
    id: randomUUID(),
    kind: "move_symbol",
    target: newId,
    raw_ops: {
      action: "move",
      old_id: id,
      new_module: toRel(root, targetAbs),
      files_touched: Array.from(touched),
      ...(filesToDelete.length > 0 ? { files_to_delete: filesToDelete } : {}),
    },
  };
  return { mutation, warnings: [] };
}

// -------- delete_symbol --------

export async function deleteSymbol(
  project: Project,
  root: ProjectRoot,
  id: SymbolId,
  refactorCallers: "refuse" | "inline_last_use" | "leave_broken"
): Promise<MoveResult> {
  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) {
    return refuse("refusal_not_found", `symbol not found: ${id}`);
  }

  const moduleAbs = decl.getSourceFile().getFilePath();
  const module = toRel(root, moduleAbs);
  const refs = collectExternalReferences(project, decl);
  const callerCount = refs.length;

  if (callerCount === 0) {
    const moveable = topLevelForMove(decl) ?? decl;
    (moveable as unknown as { remove: () => void }).remove();
    return {
      mutation: {
        id: randomUUID(),
        kind: "delete_symbol",
        target: id,
        raw_ops: {
          action: "delete",
          old_id: id,
          mode: refactorCallers,
          files_touched: [module],
        },
      },
      warnings: [],
    };
  }

  if (refactorCallers === "refuse") {
    return refuse(
      "refusal_has_callers",
      `cannot delete: ${callerCount} callers exist; use refactor_callers: 'inline_last_use' or 'leave_broken'`,
      id
    );
  }

  if (refactorCallers === "inline_last_use") {
    if (callerCount !== 1) {
      return refuse(
        "refusal_not_trivial",
        `inline_last_use requires exactly 1 caller, found ${callerCount}`,
        id
      );
    }
    const site = refs[0];
    const inlineResult = tryInlineFunction(decl, site, root);
    if (!inlineResult.ok) {
      return refuse("refusal_not_trivial", inlineResult.reason, id);
    }

    const touched = new Set<ModulePath>([
      module,
      toRel(root, site.getSourceFile().getFilePath()),
    ]);

    inlineResult.apply();

    const moveable = topLevelForMove(decl) ?? decl;
    (moveable as unknown as { remove: () => void }).remove();

    return {
      mutation: {
        id: randomUUID(),
        kind: "delete_symbol",
        target: id,
        raw_ops: {
          action: "delete",
          old_id: id,
          mode: refactorCallers,
          inlined_at: inlineResult.siteDescriptor,
          files_touched: Array.from(touched),
        },
      },
      warnings: [],
    };
  }

  // leave_broken
  const breaking: BreakingCaller[] = refs.map((n) => referenceToBreakingCaller(root, n));
  const touched = new Set<ModulePath>([module]);
  for (const b of breaking) touched.add(b.file);

  const moveable = topLevelForMove(decl) ?? decl;
  (moveable as unknown as { remove: () => void }).remove();

  return {
    mutation: {
      id: randomUUID(),
      kind: "delete_symbol",
      target: id,
      breaking_callers: breaking,
      raw_ops: {
        action: "delete",
        old_id: id,
        mode: refactorCallers,
        files_touched: Array.from(touched),
      },
    },
    warnings: [],
  };
}

// -------- helpers --------

function refuse(kind: string, message: string, symbol_id?: SymbolId): MoveResult {
  return { mutation: null, warnings: [{ kind, message, ...(symbol_id ? { symbol_id } : {}) }] };
}

function getNameNode(decl: Node): Node | null {
  const anyDecl = decl as unknown as { getNameNode?: () => Node | undefined };
  return anyDecl.getNameNode?.() ?? null;
}

function getSymbolName(decl: Node): string {
  const anyDecl = decl as unknown as { getName?: () => string | undefined };
  return anyDecl.getName?.() ?? "";
}

function parseQualified(id: SymbolId): string {
  const hash = id.indexOf("#");
  return hash < 0 ? "" : id.slice(hash + 1);
}

function replaceLastSegment(qualified: string, newLast: string): string {
  if (!qualified.includes(".")) return newLast;
  const parts = qualified.split(".");
  parts[parts.length - 1] = newLast;
  return parts.join(".");
}

function makeId(module: ModulePath, qualified: string): SymbolId {
  return `sym:${module}#${qualified}`;
}

function toRel(root: ProjectRoot, abs: string): ModulePath {
  return relative(root, abs).split(/[\\/]/).join("/");
}

function snapshotSources(project: Project): Map<string, string> {
  const map = new Map<string, string>();
  for (const sf of project.getSourceFiles()) {
    map.set(sf.getFilePath(), sf.getFullText());
  }
  return map;
}

function diffTouchedFiles(
  project: Project,
  root: ProjectRoot,
  before: Map<string, string>
): ModulePath[] {
  const out: ModulePath[] = [];
  for (const sf of project.getSourceFiles()) {
    const now = sf.getFullText();
    const prev = before.get(sf.getFilePath());
    if (prev !== now) out.push(toRel(root, sf.getFilePath()));
  }
  return out;
}

// Returns the scope description when a name would clash, else null. Members
// (methods/properties) collide within their parent class/interface; top-level
// declarations collide within their SourceFile.
function checkNameClash(decl: Node, newName: string): string | null {
  if (Node.isMethodDeclaration(decl) || Node.isPropertyDeclaration(decl)) {
    const parentClass = decl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    if (parentClass) {
      const existing = parentClass.getMethod(newName) || parentClass.getProperty(newName);
      if (existing && existing !== decl) return `class '${parentClass.getName() ?? "<anon>"}'`;
    }
    return null;
  }
  if (Node.isMethodSignature(decl) || Node.isPropertySignature(decl)) {
    const parentIface = decl.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration);
    if (parentIface) {
      const existing = parentIface.getMethod(newName) || parentIface.getProperty(newName);
      if (existing && existing !== decl) return `interface '${parentIface.getName()}'`;
    }
    return null;
  }

  const sf = decl.getSourceFile();
  const existing = findTopLevelName(sf, newName);
  if (existing && existing !== decl) return `module '${sf.getBaseName()}'`;
  return null;
}

function findTopLevelName(sf: SourceFile, name: string): Node | null {
  return (
    sf.getClass(name) ??
    sf.getFunction(name) ??
    sf.getInterface(name) ??
    sf.getTypeAlias(name) ??
    sf.getEnum(name) ??
    sf.getModule(name) ??
    sf.getVariableDeclaration(name) ??
    null
  );
}

function topLevelForMove(decl: Node): Node | null {
  if (Node.isVariableDeclaration(decl)) {
    return decl.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? null;
  }
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isClassDeclaration(decl) ||
    Node.isInterfaceDeclaration(decl) ||
    Node.isTypeAliasDeclaration(decl) ||
    Node.isEnumDeclaration(decl) ||
    Node.isModuleDeclaration(decl)
  ) {
    return decl;
  }
  return null;
}

function importReferencesOldFile(
  imp: ImportDeclaration,
  oldAbs: string,
  importer: SourceFile
): boolean {
  const spec = imp.getModuleSpecifierValue();
  if (!spec || !spec.startsWith(".")) return false;
  const resolved = imp.getModuleSpecifierSourceFile()?.getFilePath();
  if (resolved && resolved === oldAbs) return true;
  // Fallback: resolver may fail mid-mutation. Compute the expected absolute
  // path from the importer's directory.
  const importerDir = importer.getDirectoryPath();
  const guess = normalizeSlashes(join(importerDir, spec));
  return guess === oldAbs || `${guess}.ts` === oldAbs || `${guess}.tsx` === oldAbs;
}

function normalizeSlashes(p: string): string {
  return p.split(/[\\/]/).join("/");
}

function importIncludesName(imp: ImportDeclaration, name: string): boolean {
  for (const n of imp.getNamedImports()) {
    if (n.getName() === name) return true;
    if (n.getAliasNode()?.getText() === name) return true;
  }
  return false;
}

function computeRelativeSpecifier(fromFile: string, toFile: string): string {
  const fromDir = fromFile.replace(/[\\/][^\\/]+$/, "");
  let rel = normalizeSlashes(relative(fromDir, toFile));
  rel = rel.replace(/\.(tsx?|jsx?)$/, "");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function isSourceFileEmpty(sf: SourceFile): boolean {
  const stmts = sf.getStatements();
  if (stmts.length === 0) return true;
  for (const s of stmts) {
    if (s.getText().trim().length > 0) return false;
  }
  return true;
}

function collectExternalReferences(project: Project, decl: Node): Node[] {
  const nameNode = getNameNode(decl);
  if (!nameNode) return [];
  const declStart = decl.getStart();
  const declFile = decl.getSourceFile().getFilePath();
  const out: Node[] = [];
  try {
    const refs = project.getLanguageService().findReferencesAsNodes(nameNode);
    for (const r of refs) {
      if (r.getStart() === declStart && r.getSourceFile().getFilePath() === declFile) continue;
      out.push(r);
    }
  } catch {
    // Conservative "no callers" answer if the resolver errored.
  }
  return out;
}

function referenceToBreakingCaller(root: ProjectRoot, node: Node): BreakingCaller {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndColumnAtPos(node.getStart());
  const file = toRel(root, sf.getFilePath());
  const callerId = describeCallerId(node, root);
  const raw = sf.getFullText().split(/\r?\n/)[line - 1] ?? "";
  const message = `reference to removed symbol at ${file}:${line}: ${raw.trim().slice(0, 120)}`;
  return {
    caller_id: callerId,
    file,
    line,
    kind_of_break: "removed_symbol",
    message,
  };
}

function describeCallerId(node: Node, root: ProjectRoot): SymbolId {
  const sf = node.getSourceFile();
  const file = toRel(root, sf.getFilePath());
  const fn = node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
  if (fn && fn.getName()) return makeId(file, fn.getName()!);
  const method = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
  if (method) {
    const cls = method.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const clsName = cls?.getName();
    const mName = method.getName();
    if (clsName && mName) return makeId(file, `${clsName}.${mName}`);
  }
  const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  if (cls?.getName()) return makeId(file, cls.getName()!);
  return makeId(file, "<module>");
}

interface InlineOk {
  ok: true;
  apply: () => void;
  siteDescriptor: { file: ModulePath; line: number };
}
interface InlineFail {
  ok: false;
  reason: string;
}

// "Trivial" inline: the caller must be a bare CallExpression whose whole
// parent is an ExpressionStatement — i.e. `foo();` as its own statement.
// NOT trivial (all refused): `x = foo()`, `foo() + 1`, `return foo()`,
// `obj.foo()`, `foo()(x)`, `[foo()]`. The callee must be a
// FunctionDeclaration whose body is a plain block; its statements are
// substituted verbatim.
function tryInlineFunction(decl: Node, siteNode: Node, root: ProjectRoot): InlineOk | InlineFail {
  if (!Node.isFunctionDeclaration(decl)) {
    return { ok: false, reason: "inline_last_use only supports plain function declarations" };
  }
  const body = decl.getBody();
  if (!body || !Node.isBlock(body)) {
    return { ok: false, reason: "function has no body block" };
  }

  const parent = siteNode.getParent();
  if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === siteNode) {
    return { ok: false, reason: "call site is a property access, not a trivial call" };
  }
  if (!parent || !Node.isCallExpression(parent) || parent.getExpression() !== siteNode) {
    return { ok: false, reason: "reference is not the callee of a call expression" };
  }
  const stmt = parent.getParent();
  if (!stmt || !Node.isExpressionStatement(stmt)) {
    return {
      ok: false,
      reason: "call is not at ExpressionStatement position (composed into a larger expression)",
    };
  }
  if (stmt.getExpression() !== parent) {
    return { ok: false, reason: "call is not the top-level expression of the statement" };
  }

  const stmts = body.getStatements();
  const inlinedText = stmts.map((s) => s.getText()).join("\n");
  const sf = stmt.getSourceFile();
  const { line } = sf.getLineAndColumnAtPos(stmt.getStart());
  const file = toRel(root, sf.getFilePath());

  return {
    ok: true,
    siteDescriptor: { file, line },
    apply: () => {
      const enclosing = stmt.getParent();
      if (!enclosing) return;
      const idx = (stmt as unknown as { getChildIndex?: () => number }).getChildIndex?.() ?? 0;
      const insertable = enclosing as unknown as {
        insertStatements?: (i: number, s: string) => void;
      };
      (stmt as unknown as { remove: () => void }).remove();
      if (inlinedText.length > 0 && typeof insertable.insertStatements === "function") {
        insertable.insertStatements(idx, inlinedText);
      }
    },
  };
}
