import type { KeyValueStore } from './storage';

/**
 * Local diagnostics log. It records what happened (start-up, run status,
 * durations, error types, plugin failures) and never the user's source code,
 * console output or file contents. Nothing is ever sent anywhere.
 */

export interface DiagnosticEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail?: Record<string, string | number | boolean | null>;
}

const KEY = 'diagnostics';
const MAX_ENTRIES = 300;

export class DiagnosticsLog {
  private entries: DiagnosticEntry[] = [];
  private loaded = false;
  enabled = true;

  constructor(private store: KeyValueStore) {}

  async load(): Promise<void> {
    const saved = await this.store.get<DiagnosticEntry[]>(KEY);
    this.entries = Array.isArray(saved) ? saved.slice(-MAX_ENTRIES) : [];
    this.loaded = true;
  }

  record(level: DiagnosticEntry['level'], event: string, detail?: DiagnosticEntry['detail']): void {
    if (!this.enabled && level === 'info') return;
    this.entries.push({ time: Date.now(), level, event, detail });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (this.loaded) void this.store.set(KEY, this.entries);
  }

  all(): readonly DiagnosticEntry[] {
    return this.entries;
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.store.delete(KEY);
  }

  format(): string {
    return this.entries
      .map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} ${e.event}${e.detail ? ' ' + JSON.stringify(e.detail) : ''}`)
      .join('\n');
  }
}
