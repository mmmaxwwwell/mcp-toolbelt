import { basename, dirname, relative } from "node:path";
import type { JSDocableNode, Project, SourceFile } from "ts-morph";
import type { ModulePath, PolicyConfig } from "./types.js";

const BARREL_FILENAME = "index.ts";
const MANUAL_MARKERS = new Set(["// manual", "// @not-managed"]);
const MANUAL_START = "// @manual-start";
const MANUAL_END = "// @manual-end";
const AUTO_HEADER = "// @graph-edit auto-managed — do not edit by hand";

interface Export {
  name: string;
}

interface FileExports {
  relPath: string; // "./foo" — the specifier used in `export ... from`
  exports: Export[];
}

function normalizePosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

function isBarrelPath(filePath: string): boolean {
  return basename(filePath) === BARREL_FILENAME;
}

function firstNonEmptyLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return null;
}

function isManualBarrel(sf: SourceFile): boolean {
  const first = firstNonEmptyLine(sf.getFullText());
  if (!first) return false;
  return MANUAL_MARKERS.has(first);
}

// Extract "// @manual-start ... // @manual-end" blocks verbatim so we can
// splice them back into a regenerated barrel.
function extractManualBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!inBlock && t === MANUAL_START) {
      inBlock = true;
      buf = [line];
      continue;
    }
    if (inBlock) {
      buf.push(line);
      if (t === MANUAL_END) {
        blocks.push(buf.join("\n"));
        inBlock = false;
        buf = [];
      }
    }
  }
  return blocks;
}

function hasPublicMarker(node: JSDocableNode, marker: string): boolean {
  const tagName = marker.startsWith("@") ? marker.slice(1) : marker;
  for (const j of node.getJsDocs()) {
    for (const tag of j.getTags()) {
      if (tag.getTagName() === tagName) return true;
    }
    // Also check raw text — some contributors write @public inline without a formal tag.
    if (j.getInnerText().includes(marker)) return true;
  }
  return false;
}

function collectPublicExports(sf: SourceFile, policy: PolicyConfig): Export[] {
  const marker = policy.reexports.public_marker;
  // If public_marker is empty, treat all named exports as public.
  const requireMarker = typeof marker === "string" && marker.length > 0;
  const out: Export[] = [];
  const seen = new Set<string>();

  const push = (name: string | undefined) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name });
  };

  for (const decl of sf.getClasses()) {
    if (!decl.isExported() || decl.isDefaultExport()) continue;
    if (requireMarker && !hasPublicMarker(decl, marker)) continue;
    push(decl.getName());
  }
  for (const decl of sf.getFunctions()) {
    if (!decl.isExported() || decl.isDefaultExport()) continue;
    if (requireMarker && !hasPublicMarker(decl, marker)) continue;
    push(decl.getName());
  }
  for (const decl of sf.getInterfaces()) {
    if (!decl.isExported() || decl.isDefaultExport()) continue;
    if (requireMarker && !hasPublicMarker(decl, marker)) continue;
    push(decl.getName());
  }
  for (const decl of sf.getTypeAliases()) {
    if (!decl.isExported() || decl.isDefaultExport()) continue;
    if (requireMarker && !hasPublicMarker(decl, marker)) continue;
    push(decl.getName());
  }
  for (const decl of sf.getEnums()) {
    if (!decl.isExported() || decl.isDefaultExport()) continue;
    if (requireMarker && !hasPublicMarker(decl, marker)) continue;
    push(decl.getName());
  }
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    if (requireMarker && !hasPublicMarker(vs, marker)) continue;
    for (const d of vs.getDeclarations()) push(d.getName());
  }

  return out;
}

function sourceSpecifierFor(barrelPath: string, siblingPath: string): string {
  // Both paths are absolute. Produce a `./foo` specifier (no extension).
  const rel = relative(dirname(barrelPath), siblingPath);
  const posix = normalizePosix(rel);
  const noExt = posix.replace(/\.(tsx|ts|jsx|js)$/, "");
  return noExt.startsWith(".") ? noExt : `./${noExt}`;
}

function renderBarrel(fileExports: FileExports[], manualBlocks: string[]): string {
  const lines: string[] = [AUTO_HEADER, ""];
  for (const fe of fileExports) {
    if (fe.exports.length === 0) continue;
    const names = fe.exports.map((e) => e.name).join(", ");
    lines.push(`export { ${names} } from "${fe.relPath}";`);
  }
  if (manualBlocks.length > 0) {
    lines.push("");
    for (const b of manualBlocks) {
      lines.push(b);
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}

function collectDirs(project: Project, changedFiles: ModulePath[]): Set<string> {
  const dirs = new Set<string>();
  for (const cf of changedFiles) {
    let sf = project.getSourceFile(cf);
    if (!sf) {
      // Try absolute lookup via any file with matching relative suffix.
      for (const candidate of project.getSourceFiles()) {
        const p = candidate.getFilePath();
        if (p.endsWith("/" + cf) || p === cf) {
          sf = candidate;
          break;
        }
      }
    }
    if (!sf) continue;
    let dir = dirname(sf.getFilePath());
    // Only include the immediate directory of the changed file — barrels for
    // grandparent dirs would require chained re-export tracking that we don't
    // do in v1. Callers can invoke us again after committing if they want to
    // propagate up.
    dirs.add(dir);
  }
  return dirs;
}

/**
 * Regenerate `index.ts` barrels in directories that contain changed files.
 * Preserves manual barrels (first non-empty line is `// manual` or
 * `// @not-managed`) and manual blocks bracketed by
 * `// @manual-start` / `// @manual-end`.
 * Returns the source files that were modified (or newly created).
 */
export function regenerateBarrels(
  project: Project,
  policy: PolicyConfig,
  changedFiles: ModulePath[]
): SourceFile[] {
  if (policy.reexports.barrel_files !== "auto") return [];
  const modified: SourceFile[] = [];
  const dirs = collectDirs(project, changedFiles);

  for (const dir of dirs) {
    const barrelPath = `${dir}/${BARREL_FILENAME}`;
    let barrel = project.getSourceFile(barrelPath);
    // If an index.ts exists but is marked manual, skip it.
    if (barrel && isManualBarrel(barrel)) continue;

    // Collect exports from every sibling source file in the dir (excluding the barrel itself).
    const perFile: FileExports[] = [];
    for (const sf of project.getSourceFiles()) {
      const p = sf.getFilePath();
      if (dirname(p) !== dir) continue;
      if (isBarrelPath(p)) continue;
      const exports = collectPublicExports(sf, policy);
      if (exports.length === 0) continue;
      perFile.push({
        relPath: sourceSpecifierFor(barrelPath, p),
        exports,
      });
    }
    // Sort for stable output.
    perFile.sort((a, b) => a.relPath.localeCompare(b.relPath));

    const manualBlocks = barrel ? extractManualBlocks(barrel.getFullText()) : [];
    const rendered = renderBarrel(perFile, manualBlocks);

    if (!barrel) {
      // Skip creating an empty barrel — nothing to re-export from this dir.
      if (perFile.length === 0 && manualBlocks.length === 0) continue;
      barrel = project.createSourceFile(barrelPath, rendered, { overwrite: false });
      modified.push(barrel);
      continue;
    }

    const current = barrel.getFullText();
    if (current !== rendered) {
      barrel.replaceWithText(rendered);
      modified.push(barrel);
    }
  }

  return modified;
}
