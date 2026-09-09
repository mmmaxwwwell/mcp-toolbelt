import type {
  ImportDeclaration,
  ImportDeclarationStructure,
  OptionalKind,
  SourceFile,
} from "ts-morph";
import type { PolicyConfig } from "./types.js";

// Rough set of Node builtins we bucket as "node". Anything with a `node:`
// scheme is trivially detected; this covers the un-prefixed legacy names too.
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

type Bucket = "node" | "external" | "absolute" | "relative";

function classify(specifier: string, absolutePrefix?: string): Bucket {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === ".") {
    return "relative";
  }
  if (specifier.startsWith("node:")) return "node";
  // Bare specifiers starting with a Node builtin name (no scoped prefix).
  if (!specifier.startsWith("@") && NODE_BUILTINS.has(specifier.split("/")[0])) {
    return "node";
  }
  if (absolutePrefix && absolutePrefix.length > 0 && specifier.startsWith(absolutePrefix)) {
    return "absolute";
  }
  return "external";
}

interface ImportSnapshot {
  moduleSpecifier: string;
  isTypeOnly: boolean;
  defaultImport?: string;
  namespaceImport?: string;
  namedImports: Array<{ name: string; alias?: string; isTypeOnly?: boolean }>;
}

function snapshot(imp: ImportDeclaration): ImportSnapshot {
  const namedImports = imp.getNamedImports().map((ni) => {
    const alias = ni.getAliasNode()?.getText();
    return {
      name: ni.getName(),
      alias: alias && alias !== ni.getName() ? alias : undefined,
      isTypeOnly: ni.isTypeOnly(),
    };
  });
  return {
    moduleSpecifier: imp.getModuleSpecifierValue(),
    isTypeOnly: imp.isTypeOnly(),
    defaultImport: imp.getDefaultImport()?.getText(),
    namespaceImport: imp.getNamespaceImport()?.getText(),
    namedImports,
  };
}

function toStructure(s: ImportSnapshot): OptionalKind<ImportDeclarationStructure> {
  return {
    moduleSpecifier: s.moduleSpecifier,
    isTypeOnly: s.isTypeOnly,
    ...(s.defaultImport ? { defaultImport: s.defaultImport } : {}),
    ...(s.namespaceImport ? { namespaceImport: s.namespaceImport } : {}),
    ...(s.namedImports.length > 0
      ? {
          namedImports: s.namedImports.map((n) => ({
            name: n.name,
            ...(n.alias ? { alias: n.alias } : {}),
            ...(n.isTypeOnly ? { isTypeOnly: n.isTypeOnly } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Merge duplicate import declarations for the same module specifier.
 * - Named imports from all duplicates union into one; duplicate names collapse.
 * - Default imports: first non-empty wins; a conflicting second default is
 *   left on its own declaration (we don't rewrite the code to rename).
 * - Namespace imports: same rule as default.
 * - `isTypeOnly` merges only when all duplicates are type-only.
 */
export function dedupImports(sourceFile: SourceFile): void {
  const decls = sourceFile.getImportDeclarations();
  const byModule = new Map<string, ImportDeclaration[]>();
  for (const d of decls) {
    const key = d.getModuleSpecifierValue();
    const arr = byModule.get(key);
    if (arr) arr.push(d);
    else byModule.set(key, [d]);
  }

  for (const [, dupes] of byModule) {
    if (dupes.length <= 1) continue;
    const primary = dupes[0];
    const nameMap = new Map<string, { name: string; alias?: string; isTypeOnly?: boolean }>();
    let anyValueImport = false;
    let defaultImport = primary.getDefaultImport()?.getText();
    let namespaceImport = primary.getNamespaceImport()?.getText();
    const keepAsSeparate: ImportDeclaration[] = [];

    for (const d of dupes) {
      if (!d.isTypeOnly()) anyValueImport = true;
      const def = d.getDefaultImport()?.getText();
      const ns = d.getNamespaceImport()?.getText();
      if (def && !defaultImport) defaultImport = def;
      else if (def && defaultImport && def !== defaultImport) {
        // Conflicting defaults — keep this one on a separate declaration.
        if (d !== primary) keepAsSeparate.push(d);
        continue;
      }
      if (ns && !namespaceImport) namespaceImport = ns;
      else if (ns && namespaceImport && ns !== namespaceImport) {
        if (d !== primary) keepAsSeparate.push(d);
        continue;
      }
      for (const ni of d.getNamedImports()) {
        const alias = ni.getAliasNode()?.getText();
        const key = `${ni.getName()}|${alias ?? ""}|${ni.isTypeOnly() ? "T" : "V"}`;
        if (!nameMap.has(key)) {
          nameMap.set(key, {
            name: ni.getName(),
            alias: alias && alias !== ni.getName() ? alias : undefined,
            isTypeOnly: ni.isTypeOnly() || undefined,
          });
        }
      }
    }

    // Build the merged snapshot on the primary.
    const merged: ImportSnapshot = {
      moduleSpecifier: primary.getModuleSpecifierValue(),
      isTypeOnly: !anyValueImport && primary.isTypeOnly(),
      defaultImport,
      namespaceImport,
      namedImports: Array.from(nameMap.values()),
    };

    // Remove all duplicates (including primary), except keep-as-separate ones.
    const separateStructures: ImportSnapshot[] = keepAsSeparate.map(snapshot);
    for (const d of dupes) d.remove();

    sourceFile.addImportDeclaration(toStructure(merged));
    for (const s of separateStructures) {
      sourceFile.addImportDeclaration(toStructure(s));
    }
  }
}

/**
 * Bucket imports per policy.imports.sort_order and sort lexicographically
 * within each bucket by module specifier. Preserves each import's default,
 * namespace, named imports (with aliases), and isTypeOnly flags.
 */
export function sortImportsInFile(sourceFile: SourceFile, policy: PolicyConfig): void {
  const decls = sourceFile.getImportDeclarations();
  if (decls.length === 0) return;

  const order = policy.imports.sort_order.filter((b): b is Bucket =>
    b === "node" || b === "external" || b === "absolute" || b === "relative"
  );
  const buckets: Record<Bucket, ImportSnapshot[]> = {
    node: [],
    external: [],
    absolute: [],
    relative: [],
  };
  const seenBuckets = new Set<Bucket>(order);
  // Any bucket not listed in policy still gets placed at the end in a fixed order.
  const fallbackOrder: Bucket[] = ["node", "external", "absolute", "relative"];

  for (const d of decls) {
    const snap = snapshot(d);
    const b = classify(snap.moduleSpecifier, policy.imports.absolute_prefix);
    buckets[b].push(snap);
  }

  const finalOrder: Bucket[] = [...order];
  for (const b of fallbackOrder) if (!seenBuckets.has(b)) finalOrder.push(b);

  const sorted: ImportSnapshot[] = [];
  for (const b of finalOrder) {
    const bucket = buckets[b];
    bucket.sort((a, z) => a.moduleSpecifier.localeCompare(z.moduleSpecifier));
    sorted.push(...bucket);
  }

  for (const d of decls) d.remove();
  for (const s of sorted) sourceFile.addImportDeclaration(toStructure(s));
}

/**
 * Remove unused imports. Prefers ts-morph's built-in fixUnusedIdentifiers()
 * (backed by the TS language service) since it also catches unused type-only
 * imports and unused named imports cleanly. Falls back to a manual reference
 * walk if the built-in isn't available.
 */
export function removeUnusedImports(sourceFile: SourceFile): void {
  const anySf = sourceFile as unknown as { fixUnusedIdentifiers?: () => unknown };
  if (typeof anySf.fixUnusedIdentifiers === "function") {
    try {
      anySf.fixUnusedIdentifiers();
      return;
    } catch {
      // fall through to manual path
    }
  }
  manualRemoveUnusedImports(sourceFile);
}

function manualRemoveUnusedImports(sourceFile: SourceFile): void {
  for (const decl of sourceFile.getImportDeclarations()) {
    // Named imports.
    for (const ni of [...decl.getNamedImports()]) {
      const alias = ni.getAliasNode();
      const nameNode = ni.getNameNode();
      // `import { "x" as y }` — the name is a StringLiteral and can't be
      // reference-walked usefully; use the alias if present, else skip.
      const idNode = alias ?? (nameNode.getKindName() === "Identifier" ? nameNode : undefined);
      if (!idNode) continue;
      const refs = (idNode as { findReferencesAsNodes: () => unknown[] })
        .findReferencesAsNodes()
        .filter((n) => n !== idNode);
      if (refs.length === 0) ni.remove();
    }
    // Default import.
    const def = decl.getDefaultImport();
    if (def) {
      const refs = def.findReferencesAsNodes().filter((n) => n !== def);
      if (refs.length === 0) decl.removeDefaultImport();
    }
    // Namespace import.
    const ns = decl.getNamespaceImport();
    if (ns) {
      const refs = ns.findReferencesAsNodes().filter((n) => n !== ns);
      if (refs.length === 0) decl.removeNamespaceImport();
    }
    // If nothing is left, drop the whole declaration.
    const stillHasSomething =
      decl.getNamedImports().length > 0 ||
      decl.getDefaultImport() !== undefined ||
      decl.getNamespaceImport() !== undefined;
    if (!stillHasSomething) decl.remove();
  }
}
