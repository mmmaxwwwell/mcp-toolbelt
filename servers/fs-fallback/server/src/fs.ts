import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  lstatSync,
  readdirSync,
  existsSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import micromatch from "micromatch";
import {
  Policy,
  decideRead,
  decideWrite,
} from "./policy.js";
import { AuditLog, diffLineCounts } from "./audit.js";
import { moveToTrash } from "./trash.js";

// -------- Path handling --------

export class PolicyError extends Error {
  constructor(message: string, public payload: Record<string, unknown>) {
    super(message);
  }
}

export class OutsideRootError extends Error {}

/**
 * Resolve `requestedPath` against `projectRoot` and ensure it does not escape
 * the root — via `..`, absolute paths, or symlinks that point outside.
 * We compare realpaths because a well-formed relative path can still resolve
 * to a symlink whose target sits outside the project; a plain `startsWith`
 * check on the pre-realpath resolved path would miss that class of escape.
 */
export function resolveInsideRoot(
  projectRoot: string,
  requestedPath: string
): { absPath: string; relPath: string; realAbs: string | null } {
  // For read/stat we accept both existing and non-existing paths. For writes
  // the caller separately checks parent-dir realpath.
  const projectRootReal = realpathSync(projectRoot);
  const absPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(projectRootReal, requestedPath);

  // Structural check first — reject obvious `..` escapes even before realpath.
  const relStructural = relative(projectRootReal, absPath);
  if (relStructural.startsWith("..") || isAbsolute(relStructural)) {
    throw new OutsideRootError(
      `Path '${requestedPath}' resolves outside project root '${projectRootReal}'.`
    );
  }

  // Realpath check for symlink escapes. Walk up to the nearest existing
  // ancestor if the target itself doesn't exist yet (write case).
  let realAbs: string | null = null;
  try {
    realAbs = realpathSync(absPath);
  } catch {
    // Path doesn't exist — walk to the nearest existing parent.
    let probe = dirname(absPath);
    while (probe !== dirname(probe)) {
      try {
        const p = realpathSync(probe);
        // Compose the tail of the requested path onto the resolved parent.
        const tail = relative(probe, absPath);
        realAbs = resolve(p, tail);
        break;
      } catch {
        probe = dirname(probe);
      }
    }
  }
  if (realAbs !== null) {
    const relReal = relative(projectRootReal, realAbs);
    if (relReal.startsWith("..") || isAbsolute(relReal)) {
      throw new OutsideRootError(
        `Path '${requestedPath}' resolves (via symlink) outside project root '${projectRootReal}'.`
      );
    }
  }

  return {
    absPath,
    relPath: relStructural === "" ? "." : relStructural,
    realAbs,
  };
}

// -------- Binary detection --------

const BINARY_SNIFF_BYTES = 8192;

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// -------- Read tools --------

export interface ReadFileResult {
  path: string;
  size: number;
  content: string;
  encoding: "utf-8" | "binary";
  warning?: string;
}

export function readFileTool(
  projectRoot: string,
  policy: Policy,
  requestedPath: string
): ReadFileResult {
  const { absPath, relPath } = resolveInsideRoot(projectRoot, requestedPath);
  const rd = decideRead(policy, relPath);
  if (rd.decision !== "allow") {
    throw new PolicyError(rd.reason, {
      decision: rd.decision,
      matched_rule: rd.matched_rule,
      path: requestedPath,
    });
  }
  const buf = readFileSync(absPath);
  const size = buf.length;
  if (isBinary(buf)) {
    return {
      path: requestedPath,
      size,
      encoding: "binary",
      content: buf.toString("base64"),
      warning:
        "File contains NUL bytes — returned as base64. write_file does not currently accept binary writes.",
    };
  }
  return {
    path: requestedPath,
    size,
    encoding: "utf-8",
    content: buf.toString("utf8"),
  };
}

export interface ReadRangeResult {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
}

export function readFileRangeTool(
  projectRoot: string,
  policy: Policy,
  requestedPath: string,
  startLine: number,
  endLine: number
): ReadRangeResult {
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new Error("start_line must be a positive 1-indexed integer");
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new Error("end_line must be an integer >= start_line");
  }
  const { absPath, relPath } = resolveInsideRoot(projectRoot, requestedPath);
  const rd = decideRead(policy, relPath);
  if (rd.decision !== "allow") {
    throw new PolicyError(rd.reason, {
      decision: rd.decision,
      matched_rule: rd.matched_rule,
      path: requestedPath,
    });
  }
  const text = readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  // 1-indexed inclusive slice.
  const slice = lines.slice(startLine - 1, endLine).join("\n");
  return {
    path: requestedPath,
    start_line: startLine,
    end_line: Math.min(endLine, lines.length),
    content: slice,
  };
}

export interface StatResult {
  path: string;
  exists: boolean;
  size?: number;
  mtime?: string;
  is_dir?: boolean;
  is_symlink?: boolean;
  target?: string;
  denied?: boolean;
  reason?: string;
}

export function statFileTool(
  projectRoot: string,
  policy: Policy,
  requestedPath: string
): StatResult {
  const { absPath, relPath } = resolveInsideRoot(projectRoot, requestedPath);
  const rd = decideRead(policy, relPath);
  if (rd.decision !== "allow") {
    return {
      path: requestedPath,
      exists: false,
      denied: true,
      reason: rd.reason,
    };
  }
  if (!existsSync(absPath)) {
    return { path: requestedPath, exists: false };
  }
  const lst = lstatSync(absPath);
  const isSymlink = lst.isSymbolicLink();
  const st = isSymlink ? statSync(absPath) : lst;
  const result: StatResult = {
    path: requestedPath,
    exists: true,
    size: st.size,
    mtime: st.mtime.toISOString(),
    is_dir: st.isDirectory(),
    is_symlink: isSymlink,
  };
  if (isSymlink) {
    try {
      result.target = realpathSync(absPath);
    } catch {
      // dangling symlink
    }
  }
  return result;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: string;
}

export function listDirTool(
  projectRoot: string,
  policy: Policy,
  requestedPath: string
): DirEntry[] {
  const { absPath, relPath } = resolveInsideRoot(projectRoot, requestedPath);
  const rd = decideRead(policy, relPath);
  if (rd.decision !== "allow") {
    throw new PolicyError(rd.reason, {
      decision: rd.decision,
      matched_rule: rd.matched_rule,
      path: requestedPath,
    });
  }
  const raw = readdirSync(absPath, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const dirent of raw) {
    const entryAbs = join(absPath, dirent.name);
    const entryRel = relative(projectRoot, entryAbs);
    const entryDecision = decideRead(policy, entryRel);
    if (entryDecision.decision !== "allow") continue;
    try {
      const st = statSync(entryAbs);
      out.push({
        name: dirent.name,
        is_dir: st.isDirectory(),
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

export function globTool(
  projectRoot: string,
  policy: Policy,
  pattern: string,
  base?: string
): string[] {
  const baseAbs = base
    ? resolveInsideRoot(projectRoot, base).absPath
    : projectRoot;
  // Walk baseAbs collecting relative paths, apply micromatch, then filter by read policy.
  const results: string[] = [];
  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(projectRoot, abs);
      if (e.isDirectory()) {
        // Skip trash and audit dirs by default.
        if (e.name === ".fs-fallback-trash" || e.name === ".fs-fallback") continue;
        // Skip .git etc. only if not explicitly matched at the top pattern.
        walk(abs);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (micromatch.isMatch(rel, pattern, { dot: true })) {
          if (decideRead(policy, rel).decision === "allow") {
            results.push(rel);
          }
        }
      }
    }
  }
  walk(baseAbs);
  return results.sort();
}

// -------- Write tools --------

export interface WriteResult {
  path: string;
  bytes_written: number;
  size_before: number;
  size_after: number;
  diff_lines_added: number;
  diff_lines_removed: number;
  matched_rule: string;
  soft_deny_bypassed?: string;
}

function assertNotSymlink(absPath: string): void {
  // For v0.1 we refuse to write THROUGH an existing symlink.
  try {
    const lst = lstatSync(absPath);
    if (lst.isSymbolicLink()) {
      throw new Error(
        `Refusing to write through symlink at '${absPath}'. Resolve the target manually or delete the link.`
      );
    }
  } catch (err) {
    // Missing file is fine — nothing to check.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function ensureParentDir(absPath: string): void {
  const parent = dirname(absPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function readBefore(absPath: string): { text: string | null; size: number } {
  if (!existsSync(absPath)) return { text: null, size: 0 };
  try {
    const buf = readFileSync(absPath);
    if (isBinary(buf)) return { text: null, size: buf.length };
    return { text: buf.toString("utf8"), size: buf.length };
  } catch {
    return { text: null, size: 0 };
  }
}

function applyWriteDecision(
  policy: Policy,
  relPath: string,
  confirm: boolean
): { matched_rule: string; soft_deny_bypassed?: string } {
  const wd = decideWrite(policy, relPath);
  switch (wd.decision) {
    case "edit_surface_refuse":
      throw new PolicyError(wd.reason, {
        decision: wd.decision,
        matched_rule: wd.matched_rule,
        path: relPath,
      });
    case "deny":
      throw new PolicyError(wd.reason, {
        decision: wd.decision,
        matched_rule: wd.matched_rule,
        path: relPath,
      });
    case "soft_deny":
      if (!confirm) {
        throw new PolicyError(wd.hint, {
          decision: "soft_deny",
          matched_rule: wd.matched_rule,
          path: relPath,
          hint: wd.hint,
          required: "call again with confirm: true to proceed",
        });
      }
      return {
        matched_rule: wd.matched_rule,
        soft_deny_bypassed: wd.hint,
      };
    case "allow":
      return { matched_rule: wd.matched_rule };
  }
}

export function writeFileTool(
  projectRoot: string,
  policy: Policy,
  audit: AuditLog,
  requestedPath: string,
  content: string,
  confirm = false
): WriteResult {
  const { absPath, relPath } = resolveInsideRoot(projectRoot, requestedPath);
  const decision = applyWriteDecision(policy, relPath, confirm);
  assertNotSymlink(absPath);
  ensureParentDir(absPath);
  const before = readBefore(absPath);
  writeFileSync(absPath, content, "utf8");
  const size_after = Buffer.byteLength(content, "utf8");
  const { added, removed } = diffLineCounts(relPath, before.text, content);
  audit.record({
    ts: new Date().toISOString(),
    tool: "write_file",
    path: relPath,
    size_before: before.size,
    size_after,
    diff_lines_added: added,
    diff_lines_removed: removed,
    confirm: confirm || undefined,
    soft_deny_bypassed: decision.soft_deny_bypassed,
  });
  return {
    path: requestedPath,
    bytes_written: size_after,
    size_before: before.size,
    size_after,
    diff_lines_added: added,
    diff_lines_removed: removed,
    matched_rule: decision.matched_rule,
    soft_deny_bypassed: decision.soft_deny_bypassed,
  };
}

export function appendFileTool(
  projectRoot: string,
  policy: Policy,
  audit: AuditLog,
  requestedPath: string,
  content: string,
  confirm = false
): WriteResult {
  const { absPath, relPath } = resolveInsideRoot(projectRoot, requestedPath);
  const decision = applyWriteDecision(policy, relPath, confirm);
  assertNotSymlink(absPath);
  ensureParentDir(absPath);
  const before = readBefore(absPath);
  appendFileSync(absPath, content, "utf8");
  const afterText = (before.text ?? "") + content;
  const size_after = before.size + Buffer.byteLength(content, "utf8");
  const { added, removed } = diffLineCounts(relPath, before.text, afterText);
  audit.record({
    ts: new Date().toISOString(),
    tool: "append_file",
    path: relPath,
    size_before: before.size,
    size_after,
    diff_lines_added: added,
    diff_lines_removed: removed,
    confirm: confirm || undefined,
    soft_deny_bypassed: decision.soft_deny_bypassed,
  });
  return {
    path: requestedPath,
    bytes_written: Buffer.byteLength(content, "utf8"),
    size_before: before.size,
    size_after,
    diff_lines_added: added,
    diff_lines_removed: removed,
    matched_rule: decision.matched_rule,
    soft_deny_bypassed: decision.soft_deny_bypassed,
  };
}

export interface DeleteResult {
  path: string;
  trashed_to: string;
  size_before: number;
  matched_rule: string;
  soft_deny_bypassed?: string;
}

export function deleteFileTool(
  projectRoot: string,
  policy: Policy,
  audit: AuditLog,
  requestedPath: string,
  confirm = false
): DeleteResult {
  const { absPath, relPath } = resolveInsideRoot(projectRoot, requestedPath);
  const decision = applyWriteDecision(policy, relPath, confirm);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${requestedPath}`);
  }
  assertNotSymlink(absPath);
  const before = readBefore(absPath);
  const trashPath = moveToTrash(projectRoot, absPath, relPath);
  audit.record({
    ts: new Date().toISOString(),
    tool: "delete_file",
    path: relPath,
    size_before: before.size,
    size_after: 0,
    diff_lines_added: 0,
    diff_lines_removed: before.text ? before.text.split("\n").length : 0,
    confirm: confirm || undefined,
    soft_deny_bypassed: decision.soft_deny_bypassed,
  });
  return {
    path: requestedPath,
    trashed_to: relative(projectRoot, trashPath),
    size_before: before.size,
    matched_rule: decision.matched_rule,
    soft_deny_bypassed: decision.soft_deny_bypassed,
  };
}
