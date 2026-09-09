import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, dirname } from "node:path";
import {
  Node,
  Project,
  type ImportDeclaration,
  type SourceFile,
} from "ts-morph";
import { RefusalError } from "../errors.js";
import type {
  MutationResponse,
  PendingMutation,
  ProjectRoot,
  SymbolId,
  Warning,
} from "../types.js";
import { resolveSymbolIdToNode } from "./ts-morph-read.js";

export interface AddImportArgs {
  target_module?: string;
  module_path: string;
  imports: Array<{ name: string; alias?: string }>;
}

export interface AddExportArgs {
  id: SymbolId;
  from_module?: string;
}

// Ambiguous / policy-violation results return a null-data MutationResponse
// through a thrown Refusal that the caller translates. However the megaprompt
// specifies refusals should be a first-class `{ data: null, warnings: [...] }`
// return. We surface both shapes via WriteResult and let the session/tool
// wrapper translate. For the backend layer, throw RefusalError so the tool
// handler can build the MCP envelope.

function pendingMutation(
  kind: string,
  raw_ops: unknown,
  target?: SymbolId
): PendingMutation {
  return {
    id: randomUUID(),
    kind,
    ...(target !== undefined ? { target } : {}),
    breaking_callers: [],
    raw_ops,
  };
}

function refusal(kind: string, message: string, symbol_id?: SymbolId): never {
  throw new RefusalError(kind, message + (symbol_id ? ` (${symbol_id})` : ""));
}

function toRelPath(root: ProjectRoot, absPath: string): string {
  return relative(root, absPath).split(/[\\/]/).join("/");
}

function resolveSourceFile(
  project: Project,
  root: ProjectRoot,
  modulePath: string
): SourceFile | undefined {
  const absPath = isAbsolute(modulePath) ? modulePath : join(root, modulePath);
  return project.getSourceFile(absPath) ?? project.getSourceFile(modulePath);
}

function parseSymIdModule(id: SymbolId): { module: string; qualified: string } | null {
  if (!id.startsWith("sym:")) return null;
  const rest = id.slice(4);
  const hash = rest.indexOf("#");
  if (hash < 0) return null;
  return { module: rest.slice(0, hash), qualified: rest.slice(hash + 1) };
}

function computeRelativeSpecifier(
  root: ProjectRoot,
  fromModule: string,
  toModule: string
): string {
  const fromAbs = isAbsolute(fromModule) ? fromModule : join(root, fromModule);
  const toAbs = isAbsolute(toModule) ? toModule : join(root, toModule);
  let rel = relative(dirname(fromAbs), toAbs).split(/[\\/]/).join("/");
  rel = rel.replace(/\.(ts|tsx|js|jsx|mts|cts)$/i, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

export async function addImport(
  project: Project,
  root: ProjectRoot,
  args: AddImportArgs
): Promise<PendingMutation> {
  const { target_module, module_path, imports } = args;
  if (!target_module) {
    refusal("refusal_ambiguous_target", "target_module is required (no ambiguity guessing)");
  }
  if (!module_path || typeof module_path !== "string") {
    refusal("refusal_missing_arg", "module_path is required");
  }
  if (!Array.isArray(imports) || imports.length === 0) {
    refusal("refusal_missing_arg", "imports array is required and non-empty");
  }

  const sf = resolveSourceFile(project, root, target_module!);
  if (!sf) refusal("refusal_missing_module", `target_module not found: ${target_module}`);

  const warnings: Warning[] = [];
  const existing = sf!.getImportDeclaration(
    (d: ImportDeclaration) => d.getModuleSpecifierValue() === module_path
  );

  let added = 0;
  const ops: Array<{ action: string; name: string; alias?: string }> = [];

  if (existing) {
    // Merge into existing declaration; dedupe by (name, alias) exact match.
    const existingSpecs = existing.getNamedImports().map((n) => ({
      name: n.getName(),
      alias: n.getAliasNode()?.getText(),
    }));
    const key = (n: string, a?: string) => `${n}\0${a ?? ""}`;
    const seen = new Set(existingSpecs.map((s) => key(s.name, s.alias)));

    const toAdd: Array<{ name: string; alias?: string }> = [];
    for (const imp of imports) {
      if (!imp || typeof imp.name !== "string" || imp.name.length === 0) continue;
      const k = key(imp.name, imp.alias);
      if (seen.has(k)) continue;
      seen.add(k);
      toAdd.push({ name: imp.name, ...(imp.alias ? { alias: imp.alias } : {}) });
    }

    if (toAdd.length === 0) {
      warnings.push({
        kind: "unused_import",
        message: "all imports already present in existing declaration",
      });
    } else {
      existing.addNamedImports(toAdd);
      added = toAdd.length;
      for (const t of toAdd) ops.push({ action: "merge", name: t.name, alias: t.alias });
    }
  } else {
    // New declaration; still dedupe input against itself.
    const key = (n: string, a?: string) => `${n}\0${a ?? ""}`;
    const seen = new Set<string>();
    const named: Array<{ name: string; alias?: string }> = [];
    for (const imp of imports) {
      if (!imp || typeof imp.name !== "string" || imp.name.length === 0) continue;
      const k = key(imp.name, imp.alias);
      if (seen.has(k)) continue;
      seen.add(k);
      named.push({ name: imp.name, ...(imp.alias ? { alias: imp.alias } : {}) });
    }
    if (named.length === 0) {
      refusal("refusal_missing_arg", "no valid import specifiers provided");
    }
    sf!.addImportDeclaration({
      moduleSpecifier: module_path,
      namedImports: named,
    });
    added = named.length;
    for (const t of named) ops.push({ action: "new", name: t.name, alias: t.alias });
  }

  const mut = pendingMutation(
    "add_import",
    {
      target_module: toRelPath(root, sf!.getFilePath()),
      module_path,
      added,
      operations: ops,
    }
  );
  // Attach warnings via a side channel: caller reads via a warnings map keyed by mutation id.
  attachWarnings(mut.id, warnings);
  return mut;
}

export async function addExport(
  project: Project,
  root: ProjectRoot,
  args: AddExportArgs
): Promise<PendingMutation> {
  const { id, from_module } = args;
  if (!id) refusal("refusal_missing_arg", "id is required");

  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) refusal("refusal_missing_symbol", `symbol not found: ${id}`);

  const parsed = parseSymIdModule(id);
  if (!parsed) refusal("refusal_bad_id", `invalid symbol id: ${id}`);
  const sourceModule = parsed!.module;
  const symbolName = parsed!.qualified.includes(".")
    ? parsed!.qualified.split(".").pop()!
    : parsed!.qualified;

  const warnings: Warning[] = [];
  const ops: Record<string, unknown> = { id, source_module: sourceModule };

  if (!from_module) {
    // Add `export` marker to the symbol's own declaration.
    const anyDecl = decl! as unknown as {
      isExported?: () => boolean;
      hasExportKeyword?: () => boolean;
      setIsExported?: (v: boolean) => unknown;
    };
    let alreadyExported = false;
    try {
      if (typeof anyDecl.isExported === "function") alreadyExported = anyDecl.isExported();
      else if (typeof anyDecl.hasExportKeyword === "function")
        alreadyExported = anyDecl.hasExportKeyword();
    } catch {
      alreadyExported = false;
    }

    if (alreadyExported) {
      warnings.push({
        kind: "already_exported",
        message: "symbol already exported",
        symbol_id: id,
      });
      ops.action = "noop_already_exported";
    } else {
      if (typeof anyDecl.setIsExported !== "function") {
        refusal(
          "refusal_not_exportable",
          `declaration for ${id} cannot be marked exported directly`
        );
      }
      anyDecl.setIsExported!(true);
      ops.action = "mark_exported";
    }
  } else {
    // Add an ExportDeclaration to `from_module`: `export { name } from '<rel>'`.
    let targetSf = resolveSourceFile(project, root, from_module);
    if (!targetSf) {
      const absPath = isAbsolute(from_module) ? from_module : join(root, from_module);
      targetSf = project.createSourceFile(absPath, "", { overwrite: false });
    }
    const targetRel = toRelPath(root, targetSf.getFilePath());
    const specifier = computeRelativeSpecifier(root, targetRel, sourceModule);

    // Check for existing ExportDeclaration with same module specifier.
    const existing = targetSf
      .getExportDeclarations()
      .find((e) => e.getModuleSpecifierValue() === specifier);
    if (existing) {
      const alreadyNamed = existing
        .getNamedExports()
        .some((n) => n.getName() === symbolName);
      if (alreadyNamed) {
        warnings.push({
          kind: "already_exported",
          message: `symbol ${symbolName} already re-exported from ${targetRel}`,
          symbol_id: id,
        });
        ops.action = "noop_already_reexported";
      } else {
        existing.addNamedExport({ name: symbolName });
        ops.action = "merge_named_export";
      }
    } else {
      targetSf.addExportDeclaration({
        moduleSpecifier: specifier,
        namedExports: [{ name: symbolName }],
      });
      ops.action = "new_export_declaration";
    }
    ops.from_module = targetRel;
    ops.specifier = specifier;
    ops.symbol_name = symbolName;
  }

  const mut = pendingMutation("add_export", ops, id);
  attachWarnings(mut.id, warnings);
  return mut;
}

const DECORATABLE_KINDS = new Set([
  "ClassDeclaration",
  "MethodDeclaration",
  "PropertyDeclaration",
  "GetAccessorDeclaration",
  "SetAccessorDeclaration",
  "ParameterDeclaration",
]);

function isDecoratableNode(node: Node): boolean {
  // ts-morph exposes Node.isDecoratable in newer versions; fall back to kind check.
  const staticIsDec = (Node as unknown as {
    isDecoratable?: (n: Node) => boolean;
  }).isDecoratable;
  if (typeof staticIsDec === "function") {
    try {
      return staticIsDec(node);
    } catch {
      // fall through to kind check
    }
  }
  return DECORATABLE_KINDS.has(node.getKindName());
}

export async function addDecorator(
  project: Project,
  root: ProjectRoot,
  id: SymbolId,
  source: string
): Promise<PendingMutation> {
  if (!id) refusal("refusal_missing_arg", "id is required");
  if (!source || typeof source !== "string") {
    refusal("refusal_missing_arg", "decorator_source is required");
  }

  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) refusal("refusal_missing_symbol", `symbol not found: ${id}`);
  if (!isDecoratableNode(decl as unknown as Node)) {
    refusal(
      "refusal_not_decoratable",
      `cannot decorate ${(decl as unknown as Node).getKindName()} nodes`,
      id
    );
  }

  // Parse the decorator via a scratch source file. The user gives us the raw
  // source (e.g. "@Injectable()"). We attach it to a dummy class to leverage
  // ts-morph's structure extraction.
  const scratchPath = `__graph_edit_decorator_scratch__${randomUUID()}.ts`;
  const scratch = project.createSourceFile(
    scratchPath,
    `${source.trim()}\nclass __X {}\n`,
    { overwrite: true }
  );
  try {
    const scratchClass = scratch.getClass("__X");
    const decorators = scratchClass?.getDecorators() ?? [];
    if (decorators.length !== 1) {
      refusal(
        "refusal_invalid_decorator",
        `decorator_source did not parse to exactly one decorator: ${source}`,
        id
      );
    }
    const scratchDec = decorators[0];
    const decName = scratchDec.getName();
    const isFactory = scratchDec.isDecoratorFactory();
    const argTexts = isFactory
      ? scratchDec.getArguments().map((a) => a.getText())
      : undefined;
    const typeArgTexts = scratchDec.getTypeArguments().map((a) => a.getText());

    const decoratable = decl as unknown as {
      addDecorator: (s: {
        name: string;
        arguments?: string[];
        typeArguments?: string[];
      }) => unknown;
    };
    decoratable.addDecorator({
      name: decName,
      ...(isFactory ? { arguments: argTexts ?? [] } : {}),
      ...(typeArgTexts.length > 0 ? { typeArguments: typeArgTexts } : {}),
    });

    const mut = pendingMutation(
      "add_decorator",
      {
        id,
        decorator_source: source,
        name: decName,
        is_factory: isFactory,
        arguments: argTexts,
      },
      id
    );
    return mut;
  } finally {
    // Scratch is in-memory only; still remove to keep the project clean.
    try {
      scratch.deleteImmediatelySync();
    } catch {
      // no-op
    }
  }
}

export async function setDocComment(
  project: Project,
  root: ProjectRoot,
  id: SymbolId,
  source: string
): Promise<PendingMutation> {
  if (!id) refusal("refusal_missing_arg", "id is required");
  if (typeof source !== "string") {
    refusal("refusal_missing_arg", "jsdoc_source is required");
  }

  const decl = resolveSymbolIdToNode(project, root, id);
  if (!decl) refusal("refusal_missing_symbol", `symbol not found: ${id}`);

  const jsdocable = decl as unknown as {
    getJsDocs?: () => Array<{ remove: () => void }>;
    addJsDoc?: (
      s: string | { description?: string; tags?: unknown[] }
    ) => unknown;
  };

  if (typeof jsdocable.getJsDocs !== "function" || typeof jsdocable.addJsDoc !== "function") {
    refusal(
      "refusal_not_jsdocable",
      `cannot attach JSDoc to ${(decl as unknown as Node).getKindName()} nodes`,
      id
    );
  }

  const removedCount = jsdocable.getJsDocs!().length;
  for (const d of jsdocable.getJsDocs!()) d.remove();

  // Accept both raw block ("/** foo */") and description-only ("foo").
  const trimmed = source.trim();
  const isBlock = trimmed.startsWith("/**");
  let description: string;
  if (isBlock) {
    // Strip leading /** and trailing */, then strip leading " * " on each line.
    let inner = trimmed.replace(/^\/\*\*/, "").replace(/\*\/\s*$/, "");
    inner = inner
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, ""))
      .join("\n")
      .trim();
    description = inner;
  } else {
    description = trimmed;
  }

  jsdocable.addJsDoc!({ description });

  const mut = pendingMutation(
    "set_doc_comment",
    {
      id,
      jsdoc_source: source,
      description,
      replaced_existing: removedCount,
    },
    id
  );
  return mut;
}

// -------- Warnings side-channel --------
// PendingMutation type doesn't carry warnings; the tool wrapper collects
// them by mutation id and merges into the MCP envelope.
const WARNINGS_BY_MUTATION = new Map<string, Warning[]>();

function attachWarnings(mutationId: string, warnings: Warning[]): void {
  if (warnings.length > 0) WARNINGS_BY_MUTATION.set(mutationId, warnings);
}

export function drainWarnings(mutationId: string): Warning[] {
  const w = WARNINGS_BY_MUTATION.get(mutationId) ?? [];
  WARNINGS_BY_MUTATION.delete(mutationId);
  return w;
}

// Convenience wrapper used by tool handlers to build MutationResponse.
export function toMutationResponse(mut: PendingMutation): MutationResponse<PendingMutation> {
  return { data: mut, warnings: drainWarnings(mut.id) };
}
