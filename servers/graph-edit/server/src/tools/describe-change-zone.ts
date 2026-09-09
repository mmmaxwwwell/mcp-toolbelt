import { relative } from "node:path";
import {
  Node,
  SyntaxKind,
  type ExportDeclaration,
  type Project,
  type SourceFile,
} from "ts-morph";
import { buildRelated } from "../related.js";
import { TsMorphBackend } from "../backends/ts-morph.js";
import { resolveSymbolIdToNode } from "../backends/ts-morph-read.js";
import type { Session } from "../session.js";
import type {
  DescribeChangeZoneResult,
  ModulePath,
  NextCall,
  ProjectRoot,
  ReadResponse,
  SymbolId,
} from "../types.js";

// Mock/spy patterns matched inside test files. Kept small on purpose —
// noise from generic `.mock(` in non-test code is filtered by requiring
// the file itself to be a test file.
const MOCK_PATTERNS: RegExp[] = [
  /\bjest\.spyOn\s*\(/,
  /\bjest\.mock\s*\(/,
  /\bvi\.mock\s*\(/,
  /\bvi\.spyOn\s*\(/,
  /\bsinon\.spy\s*\(/,
  /\bsinon\.stub\s*\(/,
  /\bspyOn\s*\(/,
  /\bmock\s*\(/,
];

export async function handleDescribeChangeZone(
  session: Session,
  id: SymbolId
): Promise<ReadResponse<DescribeChangeZoneResult>> {
  await session.ensureLoaded();
  const backend = session.backend;
  if (!(backend instanceof TsMorphBackend)) {
    throw new Error("describe_change_zone: only ts-morph backend supported in v1");
  }
  const project = backend.read.getProject();
  const root = backend.read.getRoot();

  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) throw new Error(`describe_change_zone: symbol not found: ${id}`);

  const targetName = getDeclName(decl);
  if (!targetName) throw new Error(`describe_change_zone: unnamed declaration for ${id}`);

  const detail = await backend.read.getSymbol(id);
  const target: DescribeChangeZoneResult["target"] = {
    id: detail.id,
    kind: detail.kind,
    name: detail.name,
    module: detail.module,
    signature: detail.signature,
  };

  const references = await backend.getReferences(id);
  const callers: DescribeChangeZoneResult["callers"] = [];
  const declFile = decl.getSourceFile().getFilePath();
  const declStart = decl.getStart();

  const nameNode = getNameNode(decl);
  const refNodes = nameNode
    ? project.getLanguageService().findReferencesAsNodes(nameNode)
    : [];

  // Build a quick lookup from (file, line) to the reference node so we can
  // classify call vs. type_ref for kind_of_break_if_signature_changes.
  const refNodeByLoc = new Map<string, Node>();
  for (const rn of refNodes) {
    const nf = rn.getSourceFile().getFilePath();
    if (nf === declFile && rn.getStart() === declStart) continue;
    const { line } = rn.getSourceFile().getLineAndColumnAtPos(rn.getStart());
    refNodeByLoc.set(`${nf}::${line}`, rn);
  }

  for (const ref of references) {
    if (ref.kind !== "call") continue;
    const absFile = project.getSourceFile(ref.file)?.getFilePath() ??
      // Fall back to resolving against root — ref.file is project-relative.
      `${root}/${ref.file}`;
    const lookup = refNodeByLoc.get(`${absFile}::${ref.line}`);
    const kindOfBreak = classifyBreak(lookup);
    const callerId = lookup ? containerSymbolId(root, lookup) : null;
    callers.push({
      caller_id: callerId,
      file: ref.file,
      line: ref.line,
      context_line: ref.context_line,
      kind_of_break_if_signature_changes: kindOfBreak,
    });
  }

  const type_alias_refs = collectTypeAliasRefs(project, root, targetName, id);
  const mocking_tests = collectMockingTests(project, root, targetName);
  const reexports = collectReexports(project, root, decl.getSourceFile(), targetName);

  const isPublicApiInfo = evaluatePublicApi({
    project,
    root,
    targetModule: detail.module,
    reexports,
    declSourceFile: decl.getSourceFile(),
    isExportedDecl: detail.is_exported,
    references,
  });

  const data: DescribeChangeZoneResult = {
    target,
    callers,
    type_alias_refs,
    mocking_tests,
    reexports,
    is_public_api: isPublicApiInfo.is_public_api,
    is_public_api_reasoning: isPublicApiInfo.reasoning,
  };

  const related = await safeBuildRelated(project, root, id);
  const next_calls = suggestNextCalls(id, callers.length, reexports, isPublicApiInfo.is_public_api);

  return { data, related, next_calls };
}

async function safeBuildRelated(project: Project, root: ProjectRoot, id: SymbolId) {
  try {
    return await buildRelated(project, root, id, 3);
  } catch {
    return [];
  }
}

function classifyBreak(
  refNode: Node | undefined
): "signature_arity" | "return_type" | "unknown" {
  if (!refNode) return "unknown";
  const parent = refNode.getParent();
  if (!parent) return "unknown";

  // Direct call: identifier is the CallExpression's expression.
  let callNode: Node | null = null;
  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === refNode) {
    callNode = parent;
  } else if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === refNode) {
    const gp = parent.getParent();
    if (gp && (Node.isCallExpression(gp) || Node.isNewExpression(gp)) && gp.getExpression() === parent) {
      callNode = gp;
    }
  }

  if (!callNode) return "unknown";

  // If the call's result flows anywhere but an ExpressionStatement, treat as
  // return_type break. Otherwise the arity is the more useful hint.
  const callParent = callNode.getParent();
  if (callParent && !Node.isExpressionStatement(callParent)) {
    return "return_type";
  }
  return "signature_arity";
}

function containerSymbolId(root: ProjectRoot, node: Node): SymbolId | null {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (Node.isFunctionDeclaration(cur) && cur.getName()) {
      return `sym:${toRelPath(root, cur.getSourceFile().getFilePath())}#${cur.getName()}`;
    }
    if (Node.isMethodDeclaration(cur)) {
      const parent = cur.getParent();
      if (parent && Node.isClassDeclaration(parent) && parent.getName()) {
        return `sym:${toRelPath(root, cur.getSourceFile().getFilePath())}#${parent.getName()}.${cur.getName()}`;
      }
    }
    if (Node.isClassDeclaration(cur) && cur.getName()) {
      return `sym:${toRelPath(root, cur.getSourceFile().getFilePath())}#${cur.getName()}`;
    }
    if (Node.isVariableDeclaration(cur)) {
      return `sym:${toRelPath(root, cur.getSourceFile().getFilePath())}#${cur.getName()}`;
    }
    cur = cur.getParent();
  }
  return null;
}

function collectTypeAliasRefs(
  project: Project,
  root: ProjectRoot,
  targetName: string,
  targetId: SymbolId
): DescribeChangeZoneResult["type_alias_refs"] {
  const out: DescribeChangeZoneResult["type_alias_refs"] = [];
  const seen = new Set<SymbolId>();
  for (const sf of project.getSourceFiles()) {
    const modulePath = toRelPath(root, sf.getFilePath());
    const typeRefs = sf.getDescendantsOfKind(SyntaxKind.TypeReference);
    if (typeRefs.length === 0) continue;
    // Fast textual pre-filter before per-ref walk.
    const matches = typeRefs.filter((tr) => tr.getText().includes(targetName));
    if (matches.length === 0) continue;

    for (const tr of matches) {
      // Walk up to nearest type alias / interface owner.
      const owner = findTypeAliasOrInterfaceAncestor(tr);
      if (!owner) continue;
      const ownerName = owner.getName();
      if (!ownerName) continue;
      const id: SymbolId = `sym:${modulePath}#${ownerName}`;
      if (id === targetId || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: Node.isInterfaceDeclaration(owner) ? "interface" : "type",
        name: ownerName,
        module: modulePath,
      });
    }
  }
  return out;
}

function findTypeAliasOrInterfaceAncestor(node: Node): Node & { getName: () => string } | null {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (Node.isTypeAliasDeclaration(cur) || Node.isInterfaceDeclaration(cur)) {
      return cur as unknown as Node & { getName: () => string };
    }
    cur = cur.getParent();
  }
  return null;
}

function collectMockingTests(
  project: Project,
  root: ProjectRoot,
  targetName: string
): DescribeChangeZoneResult["mocking_tests"] {
  const out: DescribeChangeZoneResult["mocking_tests"] = [];
  for (const sf of project.getSourceFiles()) {
    const path = sf.getFilePath();
    if (!isTestFile(path)) continue;
    const text = sf.getFullText();
    if (!text.includes(targetName)) continue;
    const lines = text.split(/\r?\n/);
    let hitLine = -1;
    let hitSnippet = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (MOCK_PATTERNS.some((rx) => rx.test(line))) {
        hitLine = i + 1;
        hitSnippet = line.trim().slice(0, 200);
        break;
      }
    }
    if (hitLine < 0) continue;
    out.push({
      file: toRelPath(root, path),
      line: hitLine,
      snippet: hitSnippet,
    });
  }
  return out;
}

function isTestFile(absPath: string): boolean {
  const p = absPath.replace(/\\/g, "/");
  if (/\.(test|spec)\.[tj]sx?$/.test(p)) return true;
  if (/\/__tests__\//.test(p)) return true;
  return false;
}

function collectReexports(
  project: Project,
  root: ProjectRoot,
  targetSourceFile: SourceFile,
  targetName: string
): DescribeChangeZoneResult["reexports"] {
  const out: DescribeChangeZoneResult["reexports"] = [];
  const targetPath = targetSourceFile.getFilePath();
  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath() === targetPath) continue;
    const fromModule = toRelPath(root, sf.getFilePath());
    for (const decl of sf.getExportDeclarations()) {
      const resolved = safeResolveExportSourceFile(decl);
      if (!resolved || resolved.getFilePath() !== targetPath) continue;

      if (decl.isNamespaceExport()) {
        // export * from '...': always re-exports the target.
        out.push({
          from_module: fromModule,
          statement: decl.getText().trim(),
        });
        continue;
      }

      const named = decl.getNamedExports();
      if (named.length === 0) continue;
      const includesTarget = named.some((n) => n.getName() === targetName);
      if (!includesTarget) continue;
      out.push({
        from_module: fromModule,
        statement: decl.getText().trim(),
      });
    }
  }
  return out;
}

function safeResolveExportSourceFile(decl: ExportDeclaration): SourceFile | undefined {
  try {
    return decl.getModuleSpecifierSourceFile();
  } catch {
    return undefined;
  }
}

interface PublicApiInput {
  project: Project;
  root: ProjectRoot;
  targetModule: ModulePath;
  reexports: DescribeChangeZoneResult["reexports"];
  declSourceFile: SourceFile;
  isExportedDecl: boolean;
  references: Array<{ file: ModulePath }>;
}

function evaluatePublicApi(
  input: PublicApiInput
): { is_public_api: boolean; reasoning: string } {
  // Rules evaluated in order:
  //   1. target module is itself a barrel (basename == "index.ts")
  //   2. target is re-exported from any barrel (index.ts)
  //   3. exported AND used across >1 top-level directory
  const baseName = input.targetModule.split("/").pop() ?? "";
  if (baseName === "index.ts" || baseName === "index.tsx") {
    return {
      is_public_api: true,
      reasoning: "target lives in a barrel file (index.ts)",
    };
  }
  const barrelReexport = input.reexports.find((r) => {
    const b = r.from_module.split("/").pop() ?? "";
    return b === "index.ts" || b === "index.tsx";
  });
  if (barrelReexport) {
    return {
      is_public_api: true,
      reasoning: `re-exported from barrel ${barrelReexport.from_module}`,
    };
  }
  if (input.isExportedDecl) {
    const topDirs = new Set<string>();
    for (const ref of input.references) {
      const seg = ref.file.split("/")[0];
      if (seg) topDirs.add(seg);
    }
    // Also include the target's own top-level dir as one "consumer" bucket.
    const ownSeg = input.targetModule.split("/")[0];
    if (ownSeg) topDirs.add(ownSeg);
    if (topDirs.size > 1) {
      return {
        is_public_api: true,
        reasoning: `exported symbol used from ${topDirs.size} top-level directories`,
      };
    }
  }
  return {
    is_public_api: false,
    reasoning: "no barrel re-export and no cross-directory usage detected",
  };
}

function suggestNextCalls(
  id: SymbolId,
  callerCount: number,
  reexports: DescribeChangeZoneResult["reexports"],
  isPublicApi: boolean
): NextCall[] {
  const out: NextCall[] = [];
  if (callerCount > 0) {
    out.push({
      tool: "edit_symbol_signature",
      args: { id, signature: "<new signature here>" },
      rationale: `${callerCount} caller(s) exist — signature edits will produce breaking_callers; pass accept_breaking_callers: true to commit.`,
    });
    out.push({
      tool: "rename_symbol",
      args: { id, new_name: "<new_name>" },
      rationale: "rename atomically across the project; commit needs accept_breaking_callers if callers aren't updated.",
    });
  } else if (!isPublicApi) {
    out.push({
      tool: "delete_symbol",
      args: { id, refactor_callers: "refuse" },
      rationale: "no callers and not part of the public API — safe to delete under 'refuse' policy.",
    });
  }
  if (reexports.length > 0) {
    out.push({
      tool: "open_symbol",
      args: { id_or_query: reexports[0].from_module },
      rationale: `symbol is re-exported from ${reexports[0].from_module}; inspect the barrel before mutating.`,
    });
  }
  return out;
}

function getDeclName(node: Node): string | undefined {
  const anyNode = node as unknown as { getName?: () => string | undefined };
  return anyNode.getName?.();
}

function getNameNode(node: Node): Node | null {
  const anyNode = node as unknown as { getNameNode?: () => Node | undefined };
  return anyNode.getNameNode?.() ?? null;
}

function toRelPath(root: ProjectRoot, absPath: string): ModulePath {
  return relative(root, absPath).split(/[\\/]/).join("/");
}
