import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  Node,
  Project,
  Scope,
  SyntaxKind,
  type ClassDeclaration,
  type SourceFile,
} from "ts-morph";
import { RefusalError } from "../errors.js";
import { layoutForNewSymbol } from "../layout.js";
import { resolveSymbolIdToNode } from "./ts-morph-read.js";
import type {
  ModulePath,
  PendingMutation,
  ProjectRoot,
  Warning,
} from "../types.js";

export interface CreateSymbolArgs {
  kind: string;
  name: string;
  module?: string;
  signature: string;
  body?: string;
  doc?: string;
}

export interface AddMethodArgs {
  class_id: string;
  name: string;
  signature: string;
  body: string;
  visibility?: "public" | "private" | "protected";
  static?: boolean;
}

export interface AddPropertyArgs {
  class_id: string;
  name: string;
  type: string;
  initializer?: string;
  visibility?: "public" | "private" | "protected";
  readonly?: boolean;
}

// The Session/handler layer reads `warnings` off the returned mutation and
// forwards them in MutationResponse. Attach them as a non-enumerable-ish
// extra field on PendingMutation via raw_ops; handlers pull them out.
export interface CreateRawOps {
  action: "create_symbol";
  target_file: ModulePath;
  symbol_name: string;
  kind: string;
  is_exported: boolean;
  file_created: boolean;
  imports_added: Array<{ module: string; names: string[] }>;
}

export interface AddMethodRawOps {
  action: "add_method";
  target_file: ModulePath;
  class_name: string;
  method_name: string;
  is_static: boolean;
  visibility?: "public" | "private" | "protected";
  imports_added: Array<{ module: string; names: string[] }>;
}

export interface AddPropertyRawOps {
  action: "add_property";
  target_file: ModulePath;
  class_name: string;
  property_name: string;
  visibility?: "public" | "private" | "protected";
  readonly: boolean;
}

// Attached to PendingMutation for the handler to promote into MutationResponse.warnings.
// Types.ts is locked — we tuck the warnings under raw_ops as a sidecar so
// handlers don't have to introspect ts-morph state to derive them.
export type PendingWithWarnings = PendingMutation & { __warnings?: Warning[] };

export async function createSymbol(
  project: Project,
  root: ProjectRoot,
  args: CreateSymbolArgs
): Promise<PendingMutation> {
  if (!args || typeof args.kind !== "string" || typeof args.name !== "string" || typeof args.signature !== "string") {
    throw new RefusalError("create_symbol: kind, name, and signature are required");
  }
  const kind = args.kind;
  const name = args.name;

  let modulePath: ModulePath;
  if (typeof args.module === "string" && args.module.length > 0) {
    modulePath = normalizeRelPath(args.module);
  } else {
    // Phase 3 fills this in; today it throws LayoutAmbiguousError which the
    // handler layer converts to a refusal-with-warning response.
    modulePath = layoutForNewSymbol(kind, name, { project, root });
  }

  const absPath = isAbsolute(modulePath) ? modulePath : join(root, modulePath);
  let sf = project.getSourceFile(absPath) ?? project.getSourceFile(modulePath);
  let fileCreated = false;
  if (!sf) {
    sf = project.createSourceFile(absPath, "", { overwrite: false });
    fileCreated = true;
  }

  const warnings: Warning[] = [];

  // Insert the declaration. We prefer the permissive "raw text" path for
  // function/class/interface so agent-supplied `signature` (which is prose
  // like `function foo(x: number): void`) doesn't need to be structurally
  // decomposed on our side. ts-morph re-parses.
  const isExported = /^\s*export\b/.test(args.signature);

  switch (kind) {
    case "function":
      insertFunctionRaw(sf, args.signature, args.body ?? "", args.doc);
      break;
    case "class":
      // Classes have no body until add_method/add_property; still accept a
      // `body` string that already contains members and splice it in.
      insertClassRaw(sf, args.signature, args.body ?? "", args.doc);
      break;
    case "interface":
      insertInterfaceRaw(sf, args.signature, args.body ?? "", args.doc);
      break;
    case "type":
      insertTypeAliasRaw(sf, args.signature, args.doc);
      break;
    case "enum":
      insertEnumRaw(sf, args.signature, args.body ?? "", args.doc);
      break;
    case "variable":
      insertVariableRaw(sf, args.signature, args.doc);
      break;
    default:
      throw new RefusalError(`create_symbol: unsupported kind '${kind}'`);
  }

  // Import inference: walk the newly inserted region's identifiers, resolve
  // against exported symbols across the project, add the imports we can
  // resolve unambiguously.
  const importsAdded = inferAndAddImports(
    project,
    root,
    sf,
    collectBodyText(args.signature, args.body),
    warnings
  );

  const targetFile = toRelPath(root, sf.getFilePath());
  const rawOps: CreateRawOps = {
    action: "create_symbol",
    target_file: targetFile,
    symbol_name: name,
    kind,
    is_exported: isExported,
    file_created: fileCreated,
    imports_added: importsAdded,
  };

  const mut: PendingWithWarnings = {
    id: randomUUID(),
    kind: "create_symbol",
    breaking_callers: [],
    raw_ops: rawOps,
  };
  if (warnings.length > 0) mut.__warnings = warnings;
  return mut;
}

export async function addMethod(
  project: Project,
  root: ProjectRoot,
  args: AddMethodArgs
): Promise<PendingMutation> {
  if (!args || typeof args.class_id !== "string" || typeof args.name !== "string" || typeof args.signature !== "string" || typeof args.body !== "string") {
    throw new RefusalError("add_method: class_id, name, signature, and body are required");
  }
  const decl = resolveSymbolIdToNode(project, root, args.class_id);
  if (!decl || !Node.isClassDeclaration(decl)) {
    throw new RefusalError(`add_method: class_id does not resolve to a class: ${args.class_id}`);
  }
  const cls = decl as ClassDeclaration;
  if (cls.getMethod(args.name)) {
    throw new RefusalError(`add_method: class '${cls.getName() ?? "?"}' already has a method named '${args.name}'`);
  }

  const warnings: Warning[] = [];
  const className = cls.getName() ?? "?";
  const sfPath = cls.getSourceFile().getFilePath();

  // Insert method via ts-morph's structured API. We first attempt raw insertion
  // (which preserves the agent's signature verbatim) by writing text before the
  // closing brace. Doing so forgets `cls` — so we re-resolve the source file
  // and class after the insertText call before continuing.
  const modifierBits: string[] = [];
  if (args.visibility) modifierBits.push(args.visibility);
  if (args.static) modifierBits.push("static");
  const prefix = modifierBits.length > 0 ? modifierBits.join(" ") + " " : "";
  const cleanSig = stripLeadingModifiers(args.signature);
  const indent = "  ";
  const methodText = `\n${indent}${prefix}${cleanSig} {\n${indentBody(args.body, indent + "  ")}\n${indent}}\n`;

  const closeBrace = cls.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
  const sfBefore = cls.getSourceFile();
  sfBefore.insertText(closeBrace.getStart(), methodText);

  // Re-resolve: insertText may forget ancestor nodes.
  const sf = project.getSourceFile(sfPath);
  if (!sf) {
    throw new RefusalError(`add_method: source file lost after insertion: ${sfPath}`);
  }
  const clsAfter = sf.getClass(className);
  if (!clsAfter) {
    throw new RefusalError(`add_method: class '${className}' lost after insertion`);
  }
  if (!clsAfter.getMethod(args.name)) {
    throw new RefusalError(`add_method: insertion did not produce a parseable method '${args.name}'`);
  }

  const importsAdded = inferAndAddImports(project, root, sf, args.body, warnings);

  const rawOps: AddMethodRawOps = {
    action: "add_method",
    target_file: toRelPath(root, sf.getFilePath()),
    class_name: className,
    method_name: args.name,
    is_static: Boolean(args.static),
    visibility: args.visibility,
    imports_added: importsAdded,
  };

  const mut: PendingWithWarnings = {
    id: randomUUID(),
    kind: "add_method",
    target: args.class_id,
    breaking_callers: [],
    raw_ops: rawOps,
  };
  if (warnings.length > 0) mut.__warnings = warnings;
  return mut;
}

export async function addProperty(
  project: Project,
  root: ProjectRoot,
  args: AddPropertyArgs
): Promise<PendingMutation> {
  if (!args || typeof args.class_id !== "string" || typeof args.name !== "string" || typeof args.type !== "string") {
    throw new RefusalError("add_property: class_id, name, and type are required");
  }
  const decl = resolveSymbolIdToNode(project, root, args.class_id);
  if (!decl || !Node.isClassDeclaration(decl)) {
    throw new RefusalError(`add_property: class_id does not resolve to a class: ${args.class_id}`);
  }
  const cls = decl as ClassDeclaration;
  if (cls.getProperty(args.name)) {
    throw new RefusalError(`add_property: class '${cls.getName() ?? "?"}' already has a property named '${args.name}'`);
  }

  cls.addProperty({
    name: args.name,
    type: args.type,
    initializer: args.initializer,
    scope: scopeOf(args.visibility),
    isReadonly: Boolean(args.readonly),
  });

  const sf = cls.getSourceFile();
  const rawOps: AddPropertyRawOps = {
    action: "add_property",
    target_file: toRelPath(root, sf.getFilePath()),
    class_name: cls.getName() ?? "?",
    property_name: args.name,
    visibility: args.visibility,
    readonly: Boolean(args.readonly),
  };

  return {
    id: randomUUID(),
    kind: "add_property",
    target: args.class_id,
    breaking_callers: [],
    raw_ops: rawOps,
  };
}

// ---- helpers ----

function scopeOf(v?: "public" | "private" | "protected"): Scope | undefined {
  if (v === "public") return Scope.Public;
  if (v === "private") return Scope.Private;
  if (v === "protected") return Scope.Protected;
  return undefined;
}

function normalizeRelPath(p: string): ModulePath {
  return p.split(/[\\/]/).join("/");
}

function toRelPath(root: ProjectRoot, abs: string): ModulePath {
  return relative(root, abs).split(/[\\/]/).join("/");
}

function ensureTrailingNewline(sf: SourceFile): void {
  const text = sf.getFullText();
  if (text.length > 0 && !text.endsWith("\n")) sf.insertText(text.length, "\n");
}

function insertFunctionRaw(sf: SourceFile, signature: string, body: string, doc?: string): void {
  ensureTrailingNewline(sf);
  const jsdoc = renderJsDoc(doc);
  const text = `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${signature.trim()} {\n${indentBody(body, "  ")}\n}\n`;
  sf.insertText(sf.getFullText().length, text);
}

function insertClassRaw(sf: SourceFile, signature: string, body: string, doc?: string): void {
  ensureTrailingNewline(sf);
  const jsdoc = renderJsDoc(doc);
  const bodyText = body.trim().length > 0 ? `\n${indentBody(body, "  ")}\n` : "";
  const text = `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${signature.trim()} {${bodyText}}\n`;
  sf.insertText(sf.getFullText().length, text);
}

function insertInterfaceRaw(sf: SourceFile, signature: string, body: string, doc?: string): void {
  ensureTrailingNewline(sf);
  const jsdoc = renderJsDoc(doc);
  const trimmedSig = signature.trim();
  // If the agent already gave us the full "interface Foo { ... }" body, keep as-is.
  const hasBrace = /\{[\s\S]*\}\s*$/.test(trimmedSig);
  const text = hasBrace
    ? `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${trimmedSig}\n`
    : `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${trimmedSig} {\n${indentBody(body, "  ")}\n}\n`;
  sf.insertText(sf.getFullText().length, text);
}

function insertTypeAliasRaw(sf: SourceFile, signature: string, doc?: string): void {
  ensureTrailingNewline(sf);
  const jsdoc = renderJsDoc(doc);
  const trimmedSig = signature.trim();
  const withSemi = trimmedSig.endsWith(";") ? trimmedSig : `${trimmedSig};`;
  const text = `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${withSemi}\n`;
  sf.insertText(sf.getFullText().length, text);
}

function insertEnumRaw(sf: SourceFile, signature: string, body: string, doc?: string): void {
  ensureTrailingNewline(sf);
  const jsdoc = renderJsDoc(doc);
  const trimmedSig = signature.trim();
  const hasBrace = /\{[\s\S]*\}\s*$/.test(trimmedSig);
  const text = hasBrace
    ? `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${trimmedSig}\n`
    : `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${trimmedSig} {\n${indentBody(body, "  ")}\n}\n`;
  sf.insertText(sf.getFullText().length, text);
}

function insertVariableRaw(sf: SourceFile, signature: string, doc?: string): void {
  ensureTrailingNewline(sf);
  const jsdoc = renderJsDoc(doc);
  const trimmedSig = signature.trim();
  const withSemi = trimmedSig.endsWith(";") || trimmedSig.endsWith("}") ? trimmedSig : `${trimmedSig};`;
  const text = `${sf.getFullText().length > 0 ? "\n" : ""}${jsdoc}${withSemi}\n`;
  sf.insertText(sf.getFullText().length, text);
}

function renderJsDoc(doc?: string): string {
  if (!doc || doc.trim().length === 0) return "";
  const trimmed = doc.trim();
  if (trimmed.startsWith("/**")) return `${trimmed}\n`;
  const lines = trimmed.split(/\r?\n/).map((l) => ` * ${l}`).join("\n");
  return `/**\n${lines}\n */\n`;
}

function indentBody(body: string, indent: string): string {
  if (!body) return "";
  return body
    .split(/\r?\n/)
    .map((l) => (l.length > 0 ? indent + l : l))
    .join("\n");
}

function stripLeadingModifiers(sig: string): string {
  // Remove "public"/"private"/"protected"/"static"/"async" prefixes so we
  // can prepend our own modifiers without duplication.
  return sig.replace(/^\s*((public|private|protected|static)\s+)+/g, "");
}

function collectBodyText(signature: string, body?: string): string {
  return [signature, body ?? ""].join("\n");
}

// Cheap identifier scan: pulls out likely identifier tokens so we can look
// them up in the project's export table. Filters out TS keywords, literals,
// and identifiers already in scope in the source file.
function inferAndAddImports(
  project: Project,
  root: ProjectRoot,
  targetFile: SourceFile,
  bodyText: string,
  warnings: Warning[]
): Array<{ module: string; names: string[] }> {
  const idents = extractIdentifiers(bodyText);
  if (idents.size === 0) return [];

  const alreadyInScope = collectInScopeNames(targetFile);
  const exports = collectProjectExports(project);

  const added = new Map<string, Set<string>>();
  const targetAbs = targetFile.getFilePath();
  const targetDir = dirname(targetAbs);

  for (const ident of idents) {
    if (alreadyInScope.has(ident)) {
      // Skip; would be a duplicate. Emit a soft signal for cross-file callers
      // that are trying to force an import that's redundant.
      continue;
    }
    const owner = exports.get(ident);
    if (!owner) continue;
    if (owner.filePath === targetAbs) continue; // same file

    const rel = toImportSpecifier(targetDir, owner.filePath, root);
    const bucket = added.get(rel) ?? new Set<string>();
    bucket.add(ident);
    added.set(rel, bucket);
  }

  const out: Array<{ module: string; names: string[] }> = [];
  for (const [mod, names] of added) {
    const nameList = [...names];
    const existing = targetFile.getImportDeclaration((d) => d.getModuleSpecifierValue() === mod);
    if (existing) {
      const already = new Set(existing.getNamedImports().map((n) => n.getName()));
      const toAdd = nameList.filter((n) => !already.has(n));
      if (toAdd.length === 0) {
        warnings.push({
          kind: "unused_import",
          message: `import from '${mod}' already covers ${nameList.join(", ")}`,
        });
        continue;
      }
      existing.addNamedImports(toAdd.map((name) => ({ name })));
      out.push({ module: mod, names: toAdd });
    } else {
      targetFile.addImportDeclaration({
        moduleSpecifier: mod,
        namedImports: nameList.map((name) => ({ name })),
      });
      out.push({ module: mod, names: nameList });
    }
  }
  return out;
}

const TS_KEYWORDS = new Set([
  "true", "false", "null", "undefined", "void", "this", "super", "new", "delete",
  "typeof", "instanceof", "in", "of", "return", "if", "else", "for", "while", "do",
  "switch", "case", "default", "break", "continue", "throw", "try", "catch", "finally",
  "class", "function", "const", "let", "var", "async", "await", "yield", "import",
  "export", "from", "as", "type", "interface", "enum", "namespace", "module",
  "public", "private", "protected", "static", "readonly", "abstract", "declare",
  "extends", "implements", "any", "unknown", "never", "string", "number", "boolean",
  "object", "bigint", "symbol", "Promise", "Array", "Record", "Partial", "Readonly",
  "Pick", "Omit", "Required", "Map", "Set", "Date", "RegExp", "Error", "Math", "JSON",
  "console", "process", "globalThis", "window", "document",
]);

function extractIdentifiers(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  // Strip strings and comments to avoid picking up identifiers inside them.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\`|[^`])*`/g, " ")
    .replace(/'(?:\\'|[^'])*'/g, " ")
    .replace(/"(?:\\"|[^"])*"/g, " ");
  const rx = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(stripped)) !== null) {
    const tok = m[1];
    if (TS_KEYWORDS.has(tok)) continue;
    if (/^\d/.test(tok)) continue;
    out.add(tok);
  }
  return out;
}

function collectInScopeNames(sf: SourceFile): Set<string> {
  const out = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    const def = imp.getDefaultImport();
    if (def) out.add(def.getText());
    const ns = imp.getNamespaceImport();
    if (ns) out.add(ns.getText());
    for (const n of imp.getNamedImports()) {
      const alias = n.getAliasNode()?.getText();
      out.add(alias ?? n.getName());
    }
  }
  // Top-level declarations already defined in the file.
  for (const c of sf.getClasses()) { const n = c.getName(); if (n) out.add(n); }
  for (const f of sf.getFunctions()) { const n = f.getName(); if (n) out.add(n); }
  for (const i of sf.getInterfaces()) out.add(i.getName());
  for (const t of sf.getTypeAliases()) out.add(t.getName());
  for (const e of sf.getEnums()) out.add(e.getName());
  for (const v of sf.getVariableDeclarations()) out.add(v.getName());
  return out;
}

interface ExportOwner {
  filePath: string;
}

// Walk every project source file once, collect named exports.
// Cheap enough for reasonable projects; no caching yet — Phase 3+ can
// memoize once session lifecycle owns invalidation.
function collectProjectExports(project: Project): Map<string, ExportOwner> {
  const out = new Map<string, ExportOwner>();
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (fp.includes("/node_modules/")) continue;
    for (const [name] of sf.getExportedDeclarations()) {
      if (name === "default") continue;
      if (out.has(name)) continue; // first wins on collision
      out.set(name, { filePath: fp });
    }
  }
  return out;
}

function toImportSpecifier(fromDir: string, toAbs: string, _root: ProjectRoot): string {
  const rel = relative(fromDir, toAbs).replace(/\\/g, "/");
  const noExt = rel.replace(/\.(tsx?|jsx?)$/i, "");
  if (noExt.startsWith(".")) return noExt;
  return `./${noExt}`;
}

