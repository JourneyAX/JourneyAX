import type { JaxIqAuditLine } from './line';

/** Where audit lines go. A sink only appends: it has no way to change or remove a line. */
export interface AuditSink {
  write(line: JaxIqAuditLine): Promise<void>;
}

/** Keeps the lines in memory, for local runs and tests. It stores a copy of each line and hands out copies. */
export class MemoryAuditSink implements AuditSink {
  private readonly written: JaxIqAuditLine[] = [];

  async write(line: JaxIqAuditLine): Promise<void> {
    this.written.push(structuredClone(line));
  }

  /** Every line written so far, oldest first. */
  lines(): JaxIqAuditLine[] {
    return structuredClone(this.written);
  }
}
