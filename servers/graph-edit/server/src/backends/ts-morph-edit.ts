import { randomUUID } from "node:crypto";
import { relative, isAbsolute } from "node:path";
import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type NewExpression,
  type ParameterDeclarationStructure,
  type Project,
  type SourceFile,
} from "ts-morph";
import { RefusalError } from "../errors.js";
import type {
  BreakingCaller,
  ModulePath,
  PendingMutation,
  ProjectRoot,
  SymbolId,
  Warning,
} from "../types.js";
import { resolveSymbolIdToNode } from "./ts-morph-read.js";

export interface EditSymbolBodyResult {
  mutation: PendingMutation;
  warnings: Warning[];
}

export interface EditSymbolSignatureResult {
  mutation: PendingMutation;
  warnings: Warning[];
}

type FunctionLike =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;

function isFunctionLike(node: Node): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  );
}

// Some symbol ids point at a VariableDeclaration whose initializer is
// an arrow/function expression (e.g. `const foo = () => ...`). Unwrap.
function unwrapToFunctionLike(node: Node): FunctionLike | null {
  if (isFunctionLike(node)) return node;
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init && isFunctionLike(init)) return init;
  }
  return null;
}

export async function editSymbolBody(
  project: Project,
  root: ProjectRoot,
  id: SymbolId,
  body: string
): Promise<PendingMutation> {
  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) throw new RefusalError(`edit_symbol_body: symbol not found: ${id}`);

  const fn = unwrapToFunctionLike(decl);
  if (!fn) {
    throw new RefusalError(
      `edit_symbol_body: target is not a function-like symbol (${decl.getKindName()})`
    );
  }

  const previousBody = extractBodyText(fn);
  fn.setBodyText(body);

  const mutation: PendingMutation = {
    id: randomUUID(),
    kind: "edit_symbol_body",
    target: id,
    raw_ops: {
      op: "edit_symbol_body",
      target: id,
      file: toRelPath(root, fn.getSourceFile().getFilePath()),
      previous_body: previousBody,
      new_body: body,
    },
  };
  return mutation;
}

export async function editSymbolSignature(
  project: Project,
  root: ProjectRoot,
  id: SymbolId,
  signature: string
): Promise<PendingMutation> {
  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) throw new RefusalError(`edit_symbol_signature: symbol not found: ${id}`);

  const fn = unwrapToFunctionLike(decl);
  if (!fn) {
    throw new RefusalError(
      `edit_symbol_signature: target is not a function-like symbol (${decl.getKindName()})`
    );
  }

  const oldSnapshot = snapshotSignature(fn);
  const parsed = parseSignatureViaScratch(project, signature);
  if (!parsed) {
    throw new RefusalError(
      `edit_symbol_signature: could not parse signature: ${JSON.stringify(signature)}`
    );
  }

  // Locate the nameNode BEFORE mutating so references-lookup uses stable text.
  const nameNode = getNameNode(fn);

  // Apply parsed structure to the ts-morph node.
  applyParsedSignature(fn, parsed);

  // Compute breaking callers using the pre-existing name node (still valid
  // after signature-only mutation since we didn't rename).
  const requiredArity = countRequiredParams(parsed.parameters);
  const returnTypeChanged = normalizeType(oldSnapshot.returnType) !== normalizeType(parsed.returnType);

  const breaking = collectBreakingCallers({
    project,
    root,
    nameNode,
    requiredArity,
    returnTypeChanged,
    targetDeclFile: fn.getSourceFile().getFilePath(),
    targetDeclStart: fn.getStart(),
  });

  const mutation: PendingMutation = {
    id: randomUUID(),
    kind: "edit_symbol_signature",
    target: id,
    breaking_callers: breaking,
    raw_ops: {
      op: "edit_symbol_signature",
      target: id,
      file: toRelPath(root, fn.getSourceFile().getFilePath()),
      previous: oldSnapshot,
      new: {
        isAsync: parsed.isAsync,
        returnType: parsed.returnType,
        parameters: parsed.parameters,
      },
    },
  };
  return mutation;
}

// ---- Signature snapshot / parse helpers ----

interface SignatureSnapshot {
  isAsync: boolean;
  returnType: string | undefined;
  parameters: ParsedParam[];
}

interface ParsedParam {
  name: string;
  type?: string;
  hasQuestionToken?: boolean;
  initializer?: string;
  isRest?: boolean;
}

interface ParsedSignature {
  isAsync: boolean;
  returnType: string | undefined;
  parameters: ParsedParam[];
}

function snapshotSignature(fn: FunctionLike): SignatureSnapshot {
  const isAsync = typeof (fn as { isAsync?: () => boolean }).isAsync === "function"
    ? (fn as { isAsync: () => boolean }).isAsync()
    : false;
  const ret = fn.getReturnTypeNode()?.getText();
  const params: ParsedParam[] = fn.getParameters().map((p) => {
    const rec: ParsedParam = { name: p.getName() };
    const t = p.getTypeNode()?.getText();
    if (t) rec.type = t;
    if (p.hasQuestionToken()) rec.hasQuestionToken = true;
    const init = p.getInitializer()?.getText();
    if (init) rec.initializer = init;
    if (p.isRestParameter()) rec.isRest = true;
    return rec;
  });
  return { isAsync, returnType: ret, parameters: params };
}

// Parse an incoming signature string by injecting it into a scratch source
// file and reading back its ts-morph structure. Robust against nested
// generics / commas / defaults without hand-writing a parser.
function parseSignatureViaScratch(project: Project, signature: string): ParsedSignature | null {
  const trimmed = signature.trim();
  // Two accepted shapes: with or without leading `function` / `async`.
  // Wrap into a function declaration inside a scratch file.
  const wrapped = buildScratchSource(trimmed);
  if (!wrapped) return null;

  const scratchPath = `/__graph_edit_scratch_${randomUUID()}.ts`;
  let scratch: SourceFile | null = null;
  try {
    scratch = project.createSourceFile(scratchPath, wrapped, { overwrite: true });
    const funcs = scratch.getFunctions();
    if (funcs.length === 0) return null;
    const fn = funcs[0];
    const isAsync = fn.isAsync();
    const ret = fn.getReturnTypeNode()?.getText();
    const parameters: ParsedParam[] = fn.getParameters().map((p) => {
      const rec: ParsedParam = { name: p.getName() };
      const t = p.getTypeNode()?.getText();
      if (t) rec.type = t;
      if (p.hasQuestionToken()) rec.hasQuestionToken = true;
      const init = p.getInitializer()?.getText();
      if (init) rec.initializer = init;
      if (p.isRestParameter()) rec.isRest = true;
      return rec;
    });
    return { isAsync, returnType: ret, parameters };
  } finally {
    if (scratch) {
      // Remove from in-memory project so we don't leak scratch files into
      // subsequent operations / diagnostics.
      project.removeSourceFile(scratch);
    }
  }
}

function buildScratchSource(sig: string): string | null {
  // Accepted incoming forms:
  //   "function foo(x: number): Promise<T>"
  //   "async function foo(x: number): Promise<T>"
  //   "async foo(x: number): Promise<T>"      (method-like, no `function` kw)
  //   "foo(x: number): Promise<T>"            (bare)
  // Normalize to a top-level function declaration so ts-morph can parse it.
  let s = sig.trim();
  const hasFunctionKw = /^(async\s+)?function\b/.test(s);
  if (hasFunctionKw) {
    return `${s} { throw new Error(); }`;
  }
  // Preserve leading `async` if present, insert `function` keyword.
  const asyncMatch = s.match(/^async\s+/);
  if (asyncMatch) {
    s = s.slice(asyncMatch[0].length);
    return `async function ${s} { throw new Error(); }`;
  }
  return `function ${s} { throw new Error(); }`;
}

function applyParsedSignature(fn: FunctionLike, parsed: ParsedSignature): void {
  // Async modifier — Node.isFunctionDeclaration/MethodDeclaration/etc. all
  // expose setIsAsync via AsyncableNode mixin. Arrow/FunctionExpression too.
  const asyncCapable = fn as unknown as { setIsAsync?: (b: boolean) => void };
  if (typeof asyncCapable.setIsAsync === "function") {
    asyncCapable.setIsAsync(parsed.isAsync);
  }

  // Return type: pass empty string to strip.
  if (parsed.returnType === undefined) {
    fn.removeReturnType();
  } else {
    fn.setReturnType(parsed.returnType);
  }

  // Replace parameter list. Removing all first is the safest — insertParameters
  // preserves order and ts-morph handles formatting.
  const existing = fn.getParameters();
  for (const p of [...existing]) p.remove();

  const paramStructures: ParameterDeclarationStructure[] = parsed.parameters.map(
    (p) =>
      ({
        name: p.name,
        type: p.type,
        hasQuestionToken: p.hasQuestionToken ?? false,
        initializer: p.initializer,
        isRestParameter: p.isRest ?? false,
      } as ParameterDeclarationStructure)
  );
  if (paramStructures.length > 0) {
    fn.insertParameters(0, paramStructures);
  }
}

function countRequiredParams(params: ParsedParam[]): number {
  let n = 0;
  for (const p of params) {
    if (p.hasQuestionToken || p.initializer !== undefined || p.isRest) break;
    n += 1;
  }
  return n;
}

function normalizeType(t: string | undefined): string {
  if (!t) return "";
  return t.replace(/\s+/g, " ").trim();
}

// ---- Breaking-caller computation ----

interface BreakingContext {
  project: Project;
  root: ProjectRoot;
  nameNode: Node | null;
  requiredArity: number;
  returnTypeChanged: boolean;
  targetDeclFile: string;
  targetDeclStart: number;
}

type CallOrNew = CallExpression | NewExpression;

function collectBreakingCallers(ctx: BreakingContext): BreakingCaller[] {
  if (!ctx.nameNode) return [];
  let refNodes: Node[];
  try {
    refNodes = ctx.project.getLanguageService().findReferencesAsNodes(ctx.nameNode);
  } catch {
    return [];
  }

  const out: BreakingCaller[] = [];
  for (const node of refNodes) {
    // Skip the definition site itself.
    if (
      node.getSourceFile().getFilePath() === ctx.targetDeclFile &&
      node.getStart() === ctx.targetDeclStart
    ) {
      continue;
    }

    const callInfo = findEnclosingCall(node);
    if (!callInfo) continue;
    const { call, isNew } = callInfo;

    const sf = call.getSourceFile();
    const { line } = sf.getLineAndColumnAtPos(call.getStart());
    const file = toRelPath(ctx.root, sf.getFilePath());
    const callerId = enclosingCallerId(call, ctx.root, line);

    const args = call.getArguments();

    if (args.length < ctx.requiredArity) {
      out.push({
        caller_id: callerId,
        file,
        line,
        kind_of_break: "signature_arity",
        message: `${isNew ? "new " : ""}call passes ${args.length} arg(s); signature now requires ${ctx.requiredArity}`,
      });
      // Arity break dominates — don't also emit return_type for the same site.
      continue;
    }

    if (ctx.returnTypeChanged && isCallResultUsed(call)) {
      out.push({
        caller_id: callerId,
        file,
        line,
        kind_of_break: "return_type",
        message: `call result is consumed; return type changed`,
      });
    }
  }
  return out;
}

function findEnclosingCall(node: Node): { call: CallOrNew; isNew: boolean } | null {
  // Direct call: identifier is the expression of a CallExpression.
  const parent = node.getParent();
  if (parent) {
    if (Node.isCallExpression(parent) && parent.getExpression() === node) {
      return { call: parent, isNew: false };
    }
    if (Node.isNewExpression(parent) && parent.getExpression() === node) {
      return { call: parent, isNew: true };
    }
    // Method call: obj.method() — identifier is the name of a PropertyAccessExpression.
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) {
      const gp = parent.getParent();
      if (gp) {
        if (Node.isCallExpression(gp) && gp.getExpression() === parent) {
          return { call: gp, isNew: false };
        }
        if (Node.isNewExpression(gp) && gp.getExpression() === parent) {
          return { call: gp, isNew: true };
        }
      }
    }
  }
  return null;
}

function isCallResultUsed(call: CallOrNew): boolean {
  const parent = call.getParent();
  if (!parent) return false;
  // Bare expression statement — result unused.
  if (Node.isExpressionStatement(parent)) return false;
  return true;
}

function enclosingCallerId(callNode: Node, root: ProjectRoot, line: number): SymbolId {
  const file = toRelPath(root, callNode.getSourceFile().getFilePath());
  let cur: Node | undefined = callNode.getParent();
  const trail: string[] = [];
  while (cur) {
    const namedName = namedContainerName(cur);
    if (namedName) trail.unshift(namedName);
    if (
      Node.isSourceFile(cur) ||
      Node.isClassDeclaration(cur) ||
      Node.isFunctionDeclaration(cur) ||
      Node.isInterfaceDeclaration(cur) ||
      Node.isTypeAliasDeclaration(cur) ||
      Node.isEnumDeclaration(cur) ||
      Node.isModuleDeclaration(cur)
    ) {
      // Stop at first named container.
      if (trail.length > 0) return `sym:${file}#${trail.join(".")}`;
    }
    cur = cur.getParent();
  }
  return `sym:${file}#L${line}`;
}

function namedContainerName(node: Node): string | null {
  if (
    Node.isClassDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node)
  ) {
    const n = (node as unknown as { getName?: () => string | undefined }).getName?.();
    return n ?? null;
  }
  if (Node.isMethodDeclaration(node)) {
    const owner = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const ownerName = owner?.getName();
    const methodName = node.getName();
    if (ownerName) return `${ownerName}.${methodName}`;
    return methodName;
  }
  return null;
}

// ---- Utility ----

function extractBodyText(fn: FunctionLike): string | undefined {
  const body = (fn as unknown as { getBody?: () => Node | undefined }).getBody?.();
  return body?.getText();
}

function getNameNode(fn: FunctionLike): Node | null {
  const anyFn = fn as unknown as { getNameNode?: () => Node | undefined };
  return anyFn.getNameNode?.() ?? null;
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  const rel = isAbsolute(absPath) ? relative(root, absPath) : absPath;
  return rel.split(/[\\/]/).join("/");
}
