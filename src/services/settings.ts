import type { KeyValueStore } from './storage';

export type ThemeSetting = 'dark' | 'light' | 'system';
export type AutoSaveSetting = 'off' | 'after-delay';
export type WorkingDirectorySetting = 'project' | 'file';

export interface Settings {
  theme: ThemeSetting;
  editorFontSize: number;
  consoleFontSize: number;
  tabWidth: 2 | 4 | 8;
  wordWrap: boolean;
  lineNumbers: boolean;
  autoSave: AutoSaveSetting;
  saveBeforeRun: boolean;
  autoScroll: boolean;
  autocomplete: boolean;
  defaultEntryPoint: string;
  workingDirectory: WorkingDirectorySetting;
  /** 0 = no limit. Scripts running longer receive a KeyboardInterrupt. */
  runTimeoutSeconds: number;
  showKeyBar: boolean;
  /** Keep unsaved buffers in local storage so they survive the app being closed. */
  keepDrafts: boolean;
  /** Record run metadata (never source code) in the local diagnostics log. */
  diagnosticsLog: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  editorFontSize: 14,
  consoleFontSize: 13,
  tabWidth: 4,
  wordWrap: false,
  lineNumbers: true,
  autoSave: 'after-delay',
  saveBeforeRun: true,
  autoScroll: true,
  autocomplete: true,
  defaultEntryPoint: 'main.py',
  workingDirectory: 'project',
  runTimeoutSeconds: 0,
  showKeyBar: true,
  keepDrafts: true,
  diagnosticsLog: true,
};

const LIMITS = {
  editorFontSize: [10, 28],
  consoleFontSize: [9, 24],
  runTimeoutSeconds: [0, 3600],
} as const;

/** Merges stored values over the defaults, dropping anything invalid. */
export function sanitizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  if (r.theme === 'dark' || r.theme === 'light' || r.theme === 'system') s.theme = r.theme;
  for (const key of ['editorFontSize', 'consoleFontSize', 'runTimeoutSeconds'] as const) {
    const v = r[key];
    const [min, max] = LIMITS[key];
    if (typeof v === 'number' && Number.isFinite(v)) s[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (r.tabWidth === 2 || r.tabWidth === 4 || r.tabWidth === 8) s.tabWidth = r.tabWidth;
  for (const key of ['wordWrap', 'lineNumbers', 'saveBeforeRun', 'autoScroll', 'autocomplete', 'showKeyBar', 'keepDrafts', 'diagnosticsLog'] as const) {
    if (typeof r[key] === 'boolean') s[key] = r[key] as boolean;
  }
  if (r.autoSave === 'off' || r.autoSave === 'after-delay') s.autoSave = r.autoSave;
  if (r.workingDirectory === 'project' || r.workingDirectory === 'file') s.workingDirectory = r.workingDirectory;
  if (typeof r.defaultEntryPoint === 'string' && /^[\w.-]+\.py$/.test(r.defaultEntryPoint)) s.defaultEntryPoint = r.defaultEntryPoint;
  return s;
}

const KEY = 'settings';

export class SettingsStore {
  private value: Settings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<(s: Settings, changed: (keyof Settings)[]) => void>();

  constructor(private store: KeyValueStore) {}

  get current(): Settings {
    return this.value;
  }

  async load(): Promise<Settings> {
    this.value = sanitizeSettings(await this.store.get(KEY));
    this.notify(Object.keys(this.value) as (keyof Settings)[]);
    return this.value;
  }

  async update(patch: Partial<Settings>): Promise<void> {
    const next = sanitizeSettings({ ...this.value, ...patch });
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => next[k] !== this.value[k]);
    if (changed.length === 0) return;
    this.value = next;
    await this.store.set(KEY, next);
    this.notify(changed);
  }

  async reset(): Promise<void> {
    this.value = { ...DEFAULT_SETTINGS };
    await this.store.set(KEY, this.value);
    this.notify(Object.keys(this.value) as (keyof Settings)[]);
  }

  subscribe(listener: (s: Settings, changed: (keyof Settings)[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(changed: (keyof Settings)[]): void {
    for (const listener of this.listeners) listener(this.value, changed);
  }
}
