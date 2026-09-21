import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";

export interface AuditRecord {
  ts: string;
  tool: string;
  path: string;
  size_before: number;
  size_after: number;
  diff_lines_added: number;
  diff_lines_removed: number;
  confirm?: boolean;
  soft_deny_bypassed?: string;
}

export class AuditLog {
  private buf: AuditRecord[] = [];
  private capacity: number;
  private logPath: string | null;
  private enabled: boolean;

  constructor(projectRoot: string, logRelPath: string, enabled: boolean, capacity = 200) {
    this.capacity = capacity;
    this.enabled = enabled;
    this.logPath = enabled ? resolve(projectRoot, logRelPath) : null;
  }

  record(rec: AuditRecord): void {
    this.buf.push(rec);
    if (this.buf.length > this.capacity) this.buf.shift();
    if (this.enabled && this.logPath) {
      try {
        const dir = dirname(this.logPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(this.logPath, JSON.stringify(rec) + "\n", "utf8");
      } catch {
        // Never let audit failures break the tool call.
      }
    }
  }

  recent(n = 20): AuditRecord[] {
    const count = n > 0 ? Math.min(n, this.buf.length) : this.buf.length;
    return this.buf.slice(-count).reverse();
  }
}

/**
 * Count added/removed lines in a unified diff between two text blobs.
 * Returns zeros for binary/before-missing writes.
 */
export function diffLineCounts(
  path: string,
  before: string | null,
  after: string
): { added: number; removed: number } {
  const beforeText = before ?? "";
  const patch = createTwoFilesPatch(path, path, beforeText, after);
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
