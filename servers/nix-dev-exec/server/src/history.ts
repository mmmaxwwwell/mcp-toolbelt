export interface RunRecord {
  id: number;
  name: string;
  args: Record<string, unknown>;
  expanded_command: string[];
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  timed_out: boolean;
  started_at: number;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
}

export class RingBuffer {
  private buf: RunRecord[] = [];
  private nextId = 1;
  constructor(private capacity: number) {}

  push(rec: Omit<RunRecord, "id">): RunRecord {
    const withId: RunRecord = { id: this.nextId++, ...rec };
    this.buf.push(withId);
    if (this.buf.length > this.capacity) this.buf.shift();
    return withId;
  }

  recent(n?: number): RunRecord[] {
    const count = n && n > 0 ? Math.min(n, this.buf.length) : this.buf.length;
    return this.buf.slice(-count).reverse();
  }
}
