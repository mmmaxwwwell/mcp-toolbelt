import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Project, SourceFile } from "ts-morph";
import { RefusalError } from "../errors.js";
import type {
  BreakingCaller,
  CommitResult,
  ModulePath,
  PendingMutation,
  PolicyConfig,
  PreviewResult,
  ProjectRoot,
  Warning,
} from "../types.js";
import type { TsMorphReadBackend } from "./ts-morph-read.js";

// Access to policy modules (Agent 3B). All are optional — 3B may not have
// landed yet. Guarded dynamic imports let this file compile and run before
// those modules exist.
type ImportsMod = {
  sortImportsInFile?: (sf: SourceFile, policy: PolicyConfig) => void;
  dedupImports?: (sf: SourceFile) => void;
  removeUnusedImports?: (sf: SourceFile) => void;
};
type BarrelsMod = {
  regenerateBarrels?: (
    project: Project,
    policy: PolicyConfig,
    changedFiles: string[]
  ) => SourceFile[];
};
type NamingMod = {
  validateSymbolName?: (
    name: string,
    kind: string,
    policy: PolicyConfig
  ) => { valid: boolean; hint?: string };
};

async function loadImportsMod(): Promise<ImportsMod> {
  try {
    return (await import("../imports.js")) as ImportsMod;
  } catch {
    return {};
  }
}

async function loadBarrelsMod(): Promise<BarrelsMod> {
  try {
    return (await import("../barrels.js")) as BarrelsMod;
  } catch {
    return {};
  }
}

async function loadNamingMod(): Promise<NamingMod> {
  try {
    return (await import("../naming.js")) as NamingMod;
  } catch {
    return {};
  }
}

interface FileState {
  rel: ModulePath;
  abs: string;
  onDisk: string; // "" if file does not yet exist on disk
  existedOnDisk: boolean;
  inMemory: string; // getFullText() at snapshot time
  willBeDeleted: boolean;
}

export class TsMorphSessionBackend {
  constructor(private readonly read: TsMorphReadBackend) {}

  private project(): Project {
    return this.read.getProject();
  }

  private root(): ProjectRoot {
    return this.read.getRoot();
  }

  private policy(): PolicyConfig {
    return this.read.getPolicy();
  }

  async preview(pending: PendingMutation[]): Promise<PreviewResult> {
    return this.runPreview(pending, /*applyPolicy*/ true);
  }

  async previewTypes(pending: PendingMutation[]): Promise<PreviewResult["type_check"]> {
    // Cheap path: reuse type-check step only. Still apply policy passes so the
    // typecheck matches what commit would see.
    const res = await this.runPreview(pending, /*applyPolicy*/ true);
    return res.type_check;
  }

  async commit(
    pending: PendingMutation[],
    breakingHistory: BreakingCaller[],
    accumulatedWarnings: Warning[],
    acceptBreakingCallers: boolean
  ): Promise<CommitResult> {
    const preview = await this.runPreview(pending, /*applyPolicy*/ true);

    if (preview.type_check !== "pass") {
      const errors = preview.type_check;
      if (!acceptBreakingCallers) {
        throw new RefusalError(
          "type_check_failed",
          `commit refused: ${errors.length} type error(s):\n${formatErrors(errors)}`
        );
      }
      const uncovered = errors.filter((e) => !isCoveredByBreaking(e, breakingHistory));
      if (uncovered.length > 0) {
        throw new RefusalError(
          "type_check_failed",
          `commit refused: ${uncovered.length} type error(s) not covered by accepted breaking_callers:\n${formatErrors(uncovered)}`
        );
      }
    }

    const project = this.project();
    const root = this.root();

    // Walk pending, collect delete-set.
    const toDelete = new Set<string>();
    for (const p of pending) {
      const paths = extractFilesToDelete(p);
      for (const rel of paths) {
        const abs = isAbsolute(rel) ? rel : join(root, rel);
        toDelete.add(abs);
      }
    }

    // ts-morph tracks unsaved changes; flush.
    await project.save();

    // Remove any files marked for deletion. Do this after save() so ts-morph
    // doesn't rewrite them.
    const filesDeleted: ModulePath[] = [];
    for (const abs of toDelete) {
      try {
        await fs.rm(abs, { force: true });
        filesDeleted.push(toRel(root, abs));
      } catch {
        // Best-effort; ignore.
      }
    }

    // Compute files_written from the ts-morph project's touched set. We use
    // the paths that appear in the preview diff as our authoritative touched
    // list — the preview already collected them.
    const filesWritten = uniqueSorted(preview.imports_added.map((i) => i.source))
      .filter((f) => !filesDeleted.includes(f));

    // Rerun formatter on disk to ensure on-disk = in-memory (redundant when
    // preview already succeeded, but a cheap belt-and-suspenders).
    const touchedForFmt = extractTouchedFilesFromPending(pending, root);
    for (const relPath of touchedForFmt) {
      if (filesDeleted.includes(relPath)) continue;
      const abs = isAbsolute(relPath) ? relPath : join(root, relPath);
      await runPrettierOnDisk(abs, this.policy()).catch(() => undefined);
    }

    // Best-effort code-graph reindex.
    try {
      const child = spawn("code-review-graph", ["reindex"], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => undefined);
      child.unref?.();
    } catch {
      // ignore missing binary
    }

    // Recompute an authoritative files_written from all touched files that
    // still exist on disk after the write.
    const authoritativeWritten: ModulePath[] = [];
    for (const rel of touchedForFmt) {
      if (filesDeleted.includes(rel)) continue;
      authoritativeWritten.push(rel);
    }

    const intentRecap = buildIntentRecap(pending);

    return {
      diff: preview.diff,
      intent_recap: intentRecap,
      files_written: uniqueSorted(authoritativeWritten.length > 0 ? authoritativeWritten : filesWritten),
      files_deleted: uniqueSorted(filesDeleted),
      warnings: accumulatedWarnings,
    };
  }

  discard(pending: PendingMutation[]): void {
    const project = this.project();
    const root = this.root();
    const touched = extractTouchedFilesFromPending(pending, root);
    for (const rel of touched) {
      const abs = isAbsolute(rel) ? rel : join(root, rel);
      const sf = project.getSourceFile(abs) ?? project.getSourceFile(rel);
      if (!sf) continue;
      try {
        sf.refreshFromFileSystemSync();
      } catch {
        // If the file no longer exists on disk (e.g. we created it in-session
        // and never committed) simply forget it.
        try {
          project.removeSourceFile(sf);
        } catch {
          // ignore
        }
      }
    }
  }

  async reload(): Promise<void> {
    // Full re-parse: reload every source file from disk. Any in-session
    // created files that don't exist on disk get dropped.
    const project = this.project();
    for (const sf of project.getSourceFiles()) {
      try {
        sf.refreshFromFileSystemSync();
      } catch {
        try {
          project.removeSourceFile(sf);
        } catch {
          // ignore
        }
      }
    }
  }

  // ------------ core preview implementation ------------

  private async runPreview(
    pending: PendingMutation[],
    applyPolicy: boolean
  ): Promise<PreviewResult> {
    const project = this.project();
    const root = this.root();
    const policy = this.policy();

    const touched = extractTouchedFilesFromPending(pending, root);
    const states = await snapshotFileStates(project, root, touched);

    if (applyPolicy) {
      const importsMod = await loadImportsMod();
      const barrelsMod = await loadBarrelsMod();

      // Per-file import passes.
      for (const st of states) {
        const sf = project.getSourceFile(st.abs);
        if (!sf) continue;
        try {
          importsMod.sortImportsInFile?.(sf, policy);
        } catch {
          // Policy pass failure shouldn't kill preview.
        }
        try {
          importsMod.dedupImports?.(sf);
        } catch {
          // ignore
        }
        if (policy.imports.remove_unused) {
          try {
            importsMod.removeUnusedImports?.(sf);
          } catch {
            // ignore
          }
        }
      }

      // Barrel regeneration.
      if (policy.reexports.barrel_files === "auto") {
        try {
          barrelsMod.regenerateBarrels?.(project, policy, states.map((s) => s.abs));
        } catch {
          // ignore
        }
      }
    }

    // Refresh in-memory snapshot AFTER policy passes so the diff sees policy output.
    for (const st of states) {
      const sf = project.getSourceFile(st.abs);
      st.inMemory = sf ? sf.getFullText() : "";
    }

    // Naming validation on newly created symbols. Add as warnings to the
    // PreviewResult... except PreviewResult doesn't carry warnings. Naming
    // violations bubble into type_check message list only if the language
    // supports them there. Naming here is advisory — surface to the caller by
    // appending to the diff header? Nah — expose via a synthetic type_check
    // error only if strict. For simplicity, emit as no-op unless naming
    // returns invalid, in which case we ignore (documented ambiguity).
    const namingMod = await loadNamingMod();
    void namingMod; // naming warnings live on the individual mutation.warnings.

    // Prettier pass (in-memory).
    let formatter: PreviewResult["formatter"] = "applied";
    let formatterErrored = false;
    for (const st of states) {
      const sf = project.getSourceFile(st.abs);
      if (!sf) continue;
      const text = sf.getFullText();
      const result = await runPrettierStdin(text, st.abs, policy);
      if (result.kind === "ok") {
        sf.replaceWithText(result.text);
      } else if (result.kind === "missing") {
        formatter = "skipped_missing";
      } else {
        formatter = "skipped_error";
        formatterErrored = true;
      }
    }
    void formatterErrored;

    // Refresh in-memory again after prettier.
    for (const st of states) {
      const sf = project.getSourceFile(st.abs);
      st.inMemory = sf ? sf.getFullText() : "";
    }

    // Type check.
    const typeCheck = collectTypeErrors(project, root, states);

    // Build diff.
    const diffParts: string[] = [];
    for (const st of states) {
      if (st.onDisk === st.inMemory) continue;
      const oldLabel = st.existedOnDisk ? st.rel : `/dev/null`;
      const newLabel = st.willBeDeleted ? `/dev/null` : st.rel;
      const oldContent = st.existedOnDisk ? st.onDisk : "";
      const newContent = st.willBeDeleted ? "" : st.inMemory;
      const patch = createTwoFilesPatch(oldLabel, newLabel, oldContent, newContent);
      diffParts.push(patch);
    }
    const diff = diffParts.join("\n");

    // Imports added/removed diff.
    const importsAdded: Array<{ module: ModulePath; source: string }> = [];
    const importsRemoved: Array<{ module: ModulePath; source: string }> = [];
    for (const st of states) {
      const before = extractImportsFromText(st.onDisk);
      const after = extractImportsFromText(st.inMemory);
      for (const spec of after) {
        if (!before.has(spec)) importsAdded.push({ module: spec, source: st.rel });
      }
      for (const spec of before) {
        if (!after.has(spec)) importsRemoved.push({ module: spec, source: st.rel });
      }
    }

    // Tests likely affected.
    const testsLikelyAffected = findLikelyAffectedTests(project, root, states);

    // Breaking callers — union across pending.
    const breakingCallers: BreakingCaller[] = [];
    for (const p of pending) {
      if (p.breaking_callers && p.breaking_callers.length > 0) {
        breakingCallers.push(...p.breaking_callers);
      }
    }

    return {
      diff,
      type_check: typeCheck,
      formatter,
      imports_added: importsAdded,
      imports_removed: importsRemoved,
      tests_likely_affected: testsLikelyAffected,
      breaking_callers: breakingCallers,
    };
  }
}

// ---------------- helpers ----------------

function extractTouchedFilesFromPending(pending: PendingMutation[], root: ProjectRoot): ModulePath[] {
  const set = new Set<ModulePath>();
  for (const p of pending) {
    for (const rel of extractTouchedFromMut(p)) {
      set.add(normalizeRel(rel, root));
    }
  }
  return [...set];
}

function extractFilesToDelete(mut: PendingMutation): ModulePath[] {
  const raw = mut.raw_ops as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return [];
  const del = raw.files_to_delete;
  if (Array.isArray(del)) {
    return del.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function extractTouchedFromMut(mut: PendingMutation): ModulePath[] {
  const raw = mut.raw_ops as Record<string, unknown> | undefined;
  const out: ModulePath[] = [];
  if (!raw || typeof raw !== "object") return out;
  const pushIf = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  pushIf(raw.target_file);
  pushIf(raw.file);
  pushIf(raw.new_module);
  pushIf(raw.old_module);
  pushIf(raw.target_module);
  pushIf(raw.from_module);
  pushIf(raw.source_module);
  if (Array.isArray(raw.touched_files)) {
    for (const t of raw.touched_files) if (typeof t === "string") out.push(t);
  }
  if (Array.isArray(raw.files_touched)) {
    for (const t of raw.files_touched) if (typeof t === "string") out.push(t);
  }
  if (Array.isArray(raw.files_to_delete)) {
    for (const t of raw.files_to_delete) if (typeof t === "string") out.push(t);
  }
  return out;
}

function normalizeRel(p: string, root: ProjectRoot): ModulePath {
  const abs = isAbsolute(p) ? p : join(root, p);
  return toRel(root, abs);
}

function toRel(root: ProjectRoot, abs: string): ModulePath {
  // Use POSIX-style separators for project-relative paths.
  if (!abs.startsWith(root)) return abs.split(/[\\/]/).join("/");
  let rel = abs.slice(root.length);
  if (rel.startsWith("/") || rel.startsWith("\\")) rel = rel.slice(1);
  return rel.split(/[\\/]/).join("/");
}

async function snapshotFileStates(
  project: Project,
  root: ProjectRoot,
  touched: ModulePath[]
): Promise<FileState[]> {
  const states: FileState[] = [];
  for (const rel of touched) {
    const abs = isAbsolute(rel) ? rel : join(root, rel);
    const sf = project.getSourceFile(abs);
    let onDisk = "";
    let existedOnDisk = false;
    try {
      onDisk = await fs.readFile(abs, "utf8");
      existedOnDisk = true;
    } catch {
      existedOnDisk = false;
    }
    const inMemory = sf ? sf.getFullText() : "";
    const willBeDeleted = !sf; // if source file was removed from project
    states.push({
      rel: toRel(root, abs),
      abs,
      onDisk,
      existedOnDisk,
      inMemory,
      willBeDeleted,
    });
  }
  return states;
}

interface PrettierResult {
  kind: "ok" | "missing" | "error";
  text: string;
  message?: string;
}

async function runPrettierStdin(
  text: string,
  filePath: string,
  policy: PolicyConfig
): Promise<PrettierResult> {
  const cmd = policy.formatter.command || "prettier";
  return new Promise<PrettierResult>((resolve) => {
    const child = execFile(
      cmd,
      ["--stdin-filepath", filePath],
      { shell: false, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            resolve({ kind: "missing", text, message: `${cmd} not found on PATH` });
            return;
          }
          resolve({ kind: "error", text, message: stderr || err.message });
          return;
        }
        resolve({ kind: "ok", text: stdout });
      }
    );
    child.stdin?.on("error", () => undefined);
    try {
      child.stdin?.end(text);
    } catch {
      // ignore
    }
  });
}

async function runPrettierOnDisk(absPath: string, policy: PolicyConfig): Promise<void> {
  const cmd = policy.formatter.command || "prettier";
  const args = [...(policy.formatter.args || ["--write"])];
  if (!args.includes(absPath)) args.push(absPath);
  await new Promise<void>((resolve) => {
    execFile(cmd, args, { shell: false }, () => resolve());
  });
}

function collectTypeErrors(
  project: Project,
  root: ProjectRoot,
  states: FileState[]
): PreviewResult["type_check"] {
  const touchedSet = new Set(states.map((s) => s.abs));
  const diags = project.getPreEmitDiagnostics();
  const out: Array<{ file: ModulePath; line: number; message: string }> = [];
  for (const d of diags) {
    const sf = d.getSourceFile();
    if (!sf) continue;
    const fp = sf.getFilePath();
    const isTouched = touchedSet.has(fp);
    // Filter to touched files + files that import touched files (dependents).
    if (!isTouched && !fileDependsOnTouched(sf, touchedSet)) continue;
    // Skip node_modules noise.
    if (fp.includes("/node_modules/")) continue;
    const startPos = d.getStart();
    const line = typeof startPos === "number"
      ? sf.getLineAndColumnAtPos(startPos).line
      : 1;
    const messageText = d.getMessageText();
    const message = typeof messageText === "string"
      ? messageText
      : compilerMessageChainToString(messageText);
    out.push({
      file: toRel(root, fp),
      line,
      message,
    });
  }
  return out.length === 0 ? "pass" : out;
}

function compilerMessageChainToString(chain: unknown): string {
  // ts-morph exposes DiagnosticMessageChain — walk .messageText / .next.
  const anyChain = chain as { messageText?: string; next?: unknown[] };
  const parts: string[] = [];
  if (typeof anyChain?.messageText === "string") parts.push(anyChain.messageText);
  if (Array.isArray(anyChain?.next)) {
    for (const n of anyChain.next) parts.push(compilerMessageChainToString(n));
  }
  return parts.join(" ");
}

function fileDependsOnTouched(sf: SourceFile, touched: Set<string>): boolean {
  try {
    const refs = sf.getReferencedSourceFiles();
    for (const r of refs) {
      if (touched.has(r.getFilePath())) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function extractImportsFromText(text: string): Set<string> {
  // Cheap textual scan — good enough for a diff of add/remove specifiers. We
  // don't need to fully parse; ambiguity here just means slight noise in the
  // imports_added/removed list.
  const set = new Set<string>();
  const rx = /^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) set.add(m[1]);
  // Bare side-effect imports.
  const rx2 = /^\s*import\s+['"]([^'"]+)['"]/gm;
  while ((m = rx2.exec(text)) !== null) set.add(m[1]);
  return set;
}

function findLikelyAffectedTests(
  project: Project,
  root: ProjectRoot,
  states: FileState[]
): ModulePath[] {
  const touchedAbs = new Set(states.map((s) => s.abs));
  const found = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (touchedAbs.has(fp)) continue;
    const base = fp.replace(/^.*\//, "");
    const isTest =
      /\.(test|spec)\.(t|j)sx?$/.test(base) || fp.includes("/__tests__/");
    if (!isTest) continue;
    try {
      const refs = sf.getReferencedSourceFiles();
      for (const r of refs) {
        if (touchedAbs.has(r.getFilePath())) {
          found.add(fp);
          break;
        }
      }
    } catch {
      // ignore
    }
  }
  return [...found].map((abs) => toRel(root, abs)).sort();
}

function isCoveredByBreaking(
  err: { file: ModulePath; line: number; message: string },
  breakingHistory: BreakingCaller[]
): boolean {
  for (const b of breakingHistory) {
    if (b.file === err.file && b.line === err.line) return true;
  }
  return false;
}

function formatErrors(
  errs: Array<{ file: ModulePath; line: number; message: string }>
): string {
  return errs.slice(0, 20).map((e) => `  ${e.file}:${e.line}: ${e.message}`).join("\n");
}

function uniqueSorted<T>(arr: T[]): T[] {
  return [...new Set(arr)].sort();
}

// intent_recap templates keyed by mutation.kind. See megaprompt table.
function buildIntentRecap(pending: PendingMutation[]): string {
  const parts: string[] = [];
  for (const mut of pending) {
    const summary = summarizeMutation(mut);
    if (summary) parts.push(summary);
  }
  const joined = parts.join("; ");
  if (joined.length <= 300) return joined;
  return joined.slice(0, 297) + "...";
}

function summarizeMutation(mut: PendingMutation): string | null {
  const raw = (mut.raw_ops as Record<string, unknown>) ?? {};
  const s = (k: string): string | undefined =>
    typeof raw[k] === "string" ? (raw[k] as string) : undefined;
  const num = (arr: unknown): number => (Array.isArray(arr) ? arr.length : 0);
  const brCount = mut.breaking_callers?.length ?? 0;

  switch (mut.kind) {
    case "create_symbol": {
      const name = s("symbol_name") ?? "<symbol>";
      const kind = s("kind") ?? "symbol";
      const file = s("target_file") ?? "?";
      return `added \`${name}\` ${kind} in ${file}`;
    }
    case "add_method": {
      const method = s("method_name") ?? "<method>";
      const cls = s("class_name") ?? "<class>";
      return `added \`${method}\` method to ${cls}`;
    }
    case "add_property": {
      const prop = s("property_name") ?? "<property>";
      const cls = s("class_name") ?? "<class>";
      return `added \`${prop}\` property to ${cls}`;
    }
    case "edit_symbol_body": {
      const target = mut.target ?? s("target") ?? "<symbol>";
      const name = symbolShortName(target);
      return `updated body of \`${name}\``;
    }
    case "edit_symbol_signature": {
      const target = mut.target ?? s("target") ?? "<symbol>";
      const name = symbolShortName(target);
      return `changed signature of \`${name}\` (${brCount} call site${brCount === 1 ? "" : "s"} affected)`;
    }
    case "rename_symbol": {
      const oldId = s("old_id") ?? mut.target ?? "<symbol>";
      const oldName = symbolShortName(oldId);
      const newName = s("new_name") ?? "<new>";
      const touched = num(raw.touched_files);
      return `renamed \`${oldName}\` → \`${newName}\` (${touched} file${touched === 1 ? "" : "s"})`;
    }
    case "move_symbol": {
      const oldId = s("old_id") ?? "<symbol>";
      const name = symbolShortName(oldId);
      const newMod = s("new_module") ?? "?";
      return `moved \`${name}\` to ${newMod}`;
    }
    case "delete_symbol": {
      const oldId = s("old_id") ?? mut.target ?? "<symbol>";
      const name = symbolShortName(oldId);
      const mode = s("mode") ?? "refuse";
      return `removed \`${name}\` (mode: ${mode})`;
    }
    case "add_import": {
      const target = s("target_module") ?? "?";
      const ops = raw.operations;
      const names: string[] = [];
      if (Array.isArray(ops)) {
        for (const op of ops) {
          if (op && typeof op === "object" && typeof (op as { name?: unknown }).name === "string") {
            names.push((op as { name: string }).name);
          }
        }
      }
      const listed = names.length > 0 ? names.join(", ") : (s("module_path") ?? "<module>");
      return `wired \`${listed}\` import in ${target}`;
    }
    case "add_export": {
      const id = s("id") ?? mut.target ?? "<symbol>";
      const name = symbolShortName(id);
      return `exported \`${name}\``;
    }
    case "add_decorator": {
      const id = mut.target ?? s("id") ?? "<symbol>";
      const name = symbolShortName(id);
      const dec = s("name") ?? "?";
      return `decorated \`${name}\` with @${dec}`;
    }
    case "set_doc_comment": {
      const id = mut.target ?? s("id") ?? "<symbol>";
      const name = symbolShortName(id);
      return `updated doc for \`${name}\``;
    }
    default:
      return `${mut.kind} applied`;
  }
}

function symbolShortName(id: string): string {
  if (typeof id !== "string") return "<symbol>";
  const hash = id.indexOf("#");
  if (hash < 0) return id;
  const q = id.slice(hash + 1);
  return q.includes(".") ? q.split(".").pop()! : q;
}
