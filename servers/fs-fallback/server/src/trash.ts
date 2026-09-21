import {
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

export const TRASH_DIRNAME = ".fs-fallback-trash";

function todayStamp(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Encode a path relative to project root into a single filename by replacing
 * separators with `__`. Preserves the original path for later inspection.
 */
function flattenRelPath(rel: string): string {
  return rel.split(sep).join("__");
}

/**
 * Soft-delete: MOVE `absPath` (must be inside projectRoot) into
 * `<projectRoot>/.fs-fallback-trash/<YYYY-MM-DD>/<flattened>`.
 * Returns the trash path used.
 */
export function moveToTrash(
  projectRoot: string,
  absPath: string,
  relPath: string
): string {
  const stamp = todayStamp();
  const trashDir = join(projectRoot, TRASH_DIRNAME, stamp);
  if (!existsSync(trashDir)) {
    mkdirSync(trashDir, { recursive: true });
  }
  const base = flattenRelPath(relPath);
  let dest = join(trashDir, base);
  // Avoid collisions if the same path is soft-deleted twice on the same day.
  let counter = 1;
  while (existsSync(dest)) {
    dest = join(trashDir, `${base}.${counter++}`);
  }
  renameSync(absPath, dest);
  return dest;
}

/**
 * Purge trash directories older than `retentionDays`. Called once at server
 * startup. Silent on failure — trash cleanup is best-effort.
 */
export function purgeExpiredTrash(projectRoot: string, retentionDays: number): number {
  const root = resolve(projectRoot, TRASH_DIRNAME);
  if (!existsSync(root)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    try {
      const s = statSync(full);
      if (!s.isDirectory()) continue;
      // Prefer directory mtime as age indicator. Directory name is a UTC date
      // stamp; if parseable, use that for precision.
      let ageMs = s.mtimeMs;
      const parsed = Date.parse(entry + "T00:00:00Z");
      if (!Number.isNaN(parsed)) ageMs = parsed;
      if (ageMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // ignore individual failures
    }
  }
  return removed;
}

export function ensureTrashDir(projectRoot: string): void {
  const root = join(projectRoot, TRASH_DIRNAME);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}
