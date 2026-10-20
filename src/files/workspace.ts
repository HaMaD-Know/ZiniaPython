import type { FileRef } from '../app/tabsModel';
import type { KeyValueStore } from '../services/storage';
import { ZiniaFiles, type FolderInfo } from '../plugins/zinia-files';
import { CapacitorWorkspaceProvider, FileError, NativeFolderProvider, type Entry, type FileProvider } from './providers';
import { basename, extname, fromAbsolute, isProbablyText, join, toAbsolute } from './paths';

export interface RootInfo {
  id: string;
  name: string;
  kind: 'workspace' | 'folder';
  provider: FileProvider;
  absolute: string | null;
}

export interface SearchHit {
  ref: FileRef;
  name: string;
  line?: number;
  preview?: string;
}

const RECENT_KEY = 'recent-files';
const MAX_RECENT = 15;

/**
 * All places files can live: the app workspace (Documents) and folders the
 * user opened through the document picker.
 */
export class Workspace {
  private roots = new Map<string, RootInfo>();
  private listeners = new Set<() => void>();
  recent: FileRef[] = [];

  constructor(private store: KeyValueStore, private useNativeWorkspace: boolean) {}

  async init(): Promise<void> {
    const provider: FileProvider = this.useNativeWorkspace
      ? new NativeFolderProvider('workspace', null)
      : new CapacitorWorkspaceProvider();
    const absolute = await provider.absoluteRoot();
    this.roots.set('workspace', { id: 'workspace', name: 'On this device', kind: 'workspace', provider, absolute });
    const recent = await this.store.get<FileRef[]>(RECENT_KEY);
    this.recent = Array.isArray(recent) ? recent.filter((r) => typeof r?.root === 'string' && typeof r?.path === 'string') : [];
    this.emit();
  }

  get allRoots(): RootInfo[] {
    return [...this.roots.values()];
  }

  root(id: string): RootInfo {
    const root = this.roots.get(id);
    if (!root) throw new FileError('This folder is not open. Open it again from the Files panel.', 'ROOT_NOT_OPEN');
    return root;
  }

  hasRoot(id: string): boolean {
    return this.roots.has(id);
  }

  provider(id: string): FileProvider {
    return this.root(id).provider;
  }

  // --- external folders -------------------------------------------------

  async listSavedFolders(): Promise<FolderInfo[]> {
    try {
      return (await ZiniaFiles.listFolders()).folders;
    } catch {
      return [];
    }
  }

  async pickFolder(): Promise<RootInfo | null> {
    const picked = await ZiniaFiles.pickFolder();
    if (picked.cancelled || !picked.id) return null;
    return this.openFolder(picked.id);
  }

  async openFolder(id: string): Promise<RootInfo> {
    const opened = await ZiniaFiles.openFolder({ id });
    const rootId = `ext:${opened.id}`;
    const info: RootInfo = { id: rootId, name: opened.name, kind: 'folder', provider: new NativeFolderProvider(rootId, opened.path), absolute: opened.path };
    this.roots.set(rootId, info);
    this.emit();
    return info;
  }

  async closeFolder(rootId: string): Promise<void> {
    if (!rootId.startsWith('ext:')) return;
    await ZiniaFiles.closeFolder({ id: rootId.slice(4) }).catch(() => undefined);
    this.roots.delete(rootId);
    this.emit();
  }

  async forgetFolder(folderId: string): Promise<void> {
    await ZiniaFiles.forgetFolder({ id: folderId });
    this.roots.delete(`ext:${folderId}`);
    this.emit();
  }

  // --- path mapping -----------------------------------------------------

  absolutePath(ref: FileRef): string | null {
    const root = this.roots.get(ref.root);
    return root?.absolute ? toAbsolute(root.absolute, ref.path) : null;
  }

  /** Maps an absolute path (for example from a traceback) to a file reference. */
  refFromAbsolute(absolute: string): FileRef | null {
    for (const root of this.roots.values()) {
      if (!root.absolute) continue;
      const rel = fromAbsolute(root.absolute, absolute);
      if (rel !== null && rel !== '') return { root: root.id, path: rel };
    }
    return null;
  }

  displayName(ref: FileRef): string {
    const root = this.roots.get(ref.root);
    return root && root.kind === 'folder' ? `${root.name}/${ref.path}` : ref.path;
  }

  // --- recent files ------------------------------------------------------

  async touchRecent(ref: FileRef): Promise<void> {
    this.recent = [ref, ...this.recent.filter((r) => r.root !== ref.root || r.path !== ref.path)].slice(0, MAX_RECENT);
    await this.store.set(RECENT_KEY, this.recent);
    this.emit();
  }

  async forgetRecent(predicate: (ref: FileRef) => boolean): Promise<void> {
    const next = this.recent.filter((r) => !predicate(r));
    if (next.length === this.recent.length) return;
    this.recent = next;
    await this.store.set(RECENT_KEY, this.recent);
    this.emit();
  }

  // --- search -----------------------------------------------------------

  /**
   * Finds files whose name contains `query`, and lines of text files that
   * contain it. Walks at most `maxFiles` files under `folder`.
   */
  async search(rootId: string, folder: string, query: string, options: { maxFiles?: number; maxHits?: number; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const provider = this.provider(rootId);
    const hits: SearchHit[] = [];
    const maxFiles = options.maxFiles ?? 2000;
    const maxHits = options.maxHits ?? 300;
    let visited = 0;
    const queue: string[] = [folder];
    while (queue.length && hits.length < maxHits && visited < maxFiles) {
      if (options.signal?.aborted) break;
      const dir = queue.shift() as string;
      let entries: Entry[];
      try {
        entries = await provider.list(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.type === 'directory') {
          queue.push(entry.path);
          continue;
        }
        visited += 1;
        const ref = { root: rootId, path: entry.path };
        if (entry.name.toLowerCase().includes(needle)) hits.push({ ref, name: entry.name });
        if (!isProbablyText(entry.path) || entry.size > 2 * 1024 * 1024 || extname(entry.path) === '.csv') continue;
        try {
          const { text } = await provider.read(entry.path);
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              hits.push({ ref, name: entry.name, line: i + 1, preview: lines[i].trim().slice(0, 160) });
            }
          }
        } catch {
          // unreadable files are skipped
        }
      }
    }
    return hits;
  }

  /** Every Python file below `folder` (for the module-name autocomplete). */
  async pythonModules(rootId: string, folder: string): Promise<string[]> {
    try {
      const entries = await this.provider(rootId).list(folder);
      return entries
        .filter((e) => (e.type === 'file' && e.name.endsWith('.py')) || e.type === 'directory')
        .map((e) => (e.type === 'file' ? e.name.slice(0, -3) : e.name))
        .filter((n) => /^[A-Za-z_]\w*$/.test(n));
    } catch {
      return [];
    }
  }

  async uniqueChildName(rootId: string, folder: string, desired: string): Promise<string> {
    const names = new Set((await this.provider(rootId).list(folder).catch(() => [])).map((e) => e.name));
    if (!names.has(desired)) return desired;
    const dot = desired.lastIndexOf('.');
    const stemPart = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : '';
    for (let i = 2; ; i++) {
      const candidate = `${stemPart} ${i}${ext}`;
      if (!names.has(candidate)) return candidate;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const l of this.listeners) l();
  }
}

export { basename, join };
