/**
 * Open editor tabs, independent of the DOM and of CodeMirror so it can be
 * unit-tested. Content lives in the editor; the model tracks identity,
 * order, the active tab, and whether each buffer differs from disk.
 */

export interface FileRef {
  /** "workspace" or "ext:<folder id>" */
  root: string;
  /** Root-relative POSIX path; untitled buffers use "untitled-N" with untitled=true. */
  path: string;
}

export interface TabState {
  id: string;
  ref: FileRef;
  untitled: boolean;
  /** Text as last loaded from or saved to disk. */
  savedText: string;
  /** Current buffer text (kept in sync by the editor). */
  text: string;
  /** Modification time of the file on disk when last loaded/saved (ms). */
  mtime: number | null;
  /** Set when the file changed on disk while the tab had unsaved edits. */
  conflict: boolean;
  cursor: number;
  scrollTop: number;
}

export interface TabsSnapshot {
  tabs: { ref: FileRef; untitled: boolean; cursor: number; scrollTop: number }[];
  activeKey: string | null;
}

export function refKey(ref: FileRef): string {
  return `${ref.root}::${ref.path}`;
}

let counter = 0;

export class TabsModel {
  private tabs: TabState[] = [];
  private activeId: string | null = null;
  private listeners = new Set<() => void>();
  private untitledCounter = 1;

  get all(): readonly TabState[] {
    return this.tabs;
  }

  get active(): TabState | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  isDirty(tab: TabState): boolean {
    return tab.untitled ? tab.text.length > 0 : tab.text !== tab.savedText;
  }

  get dirtyTabs(): TabState[] {
    return this.tabs.filter((t) => this.isDirty(t));
  }

  find(ref: FileRef): TabState | undefined {
    const key = refKey(ref);
    return this.tabs.find((t) => refKey(t.ref) === key);
  }

  byId(id: string): TabState | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  open(ref: FileRef, text: string, mtime: number | null, options: { activate?: boolean; untitled?: boolean } = {}): TabState {
    const existing = this.find(ref);
    if (existing) {
      if (options.activate !== false) this.activate(existing.id);
      return existing;
    }
    const tab: TabState = {
      id: `tab-${++counter}`,
      ref: { ...ref },
      untitled: options.untitled ?? false,
      savedText: options.untitled ? '' : text,
      text,
      mtime,
      conflict: false,
      cursor: 0,
      scrollTop: 0,
    };
    const activeIndex = this.tabs.findIndex((t) => t.id === this.activeId);
    this.tabs.splice(activeIndex === -1 ? this.tabs.length : activeIndex + 1, 0, tab);
    if (options.activate !== false) this.activeId = tab.id;
    this.emit();
    return tab;
  }

  newUntitled(text = ''): TabState {
    const name = `untitled-${this.untitledCounter++}.py`;
    return this.open({ root: 'workspace', path: name }, text, null, { untitled: true });
  }

  activate(id: string): void {
    if (this.activeId === id || !this.byId(id)) return;
    this.activeId = id;
    this.emit();
  }

  /** Removes a tab and returns the id of the tab that becomes active. */
  close(id: string): string | null {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index === -1) return this.activeId;
    this.tabs.splice(index, 1);
    if (this.activeId === id) {
      const neighbour = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeId = neighbour?.id ?? null;
    }
    this.emit();
    return this.activeId;
  }

  move(id: string, toIndex: number): void {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from === -1) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.emit();
  }

  updateText(id: string, text: string): void {
    const tab = this.byId(id);
    if (!tab || tab.text === text) return;
    const wasDirty = this.isDirty(tab);
    tab.text = text;
    if (wasDirty !== this.isDirty(tab)) this.emit();
  }

  markSaved(id: string, savedText: string, mtime: number | null, newRef?: FileRef): void {
    const tab = this.byId(id);
    if (!tab) return;
    tab.savedText = savedText;
    tab.mtime = mtime;
    tab.conflict = false;
    if (newRef) {
      tab.ref = { ...newRef };
      tab.untitled = false;
    }
    this.emit();
  }

  /** The file on disk changed. Clean tabs adopt it; dirty tabs are flagged. */
  externalChange(id: string, diskText: string, mtime: number): 'reloaded' | 'conflict' | 'unchanged' {
    const tab = this.byId(id);
    if (!tab) return 'unchanged';
    if (diskText === tab.savedText) {
      tab.mtime = mtime;
      return 'unchanged';
    }
    if (!this.isDirty(tab)) {
      tab.savedText = diskText;
      tab.text = diskText;
      tab.mtime = mtime;
      this.emit();
      return 'reloaded';
    }
    tab.conflict = true;
    this.emit();
    return 'conflict';
  }

  /** Re-point tabs after a file or folder was renamed or moved. */
  renamePath(root: string, fromPath: string, toPath: string): void {
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.ref.root !== root || tab.untitled) continue;
      if (tab.ref.path === fromPath) {
        tab.ref.path = toPath;
        changed = true;
      } else if (tab.ref.path.startsWith(fromPath + '/')) {
        tab.ref.path = toPath + tab.ref.path.slice(fromPath.length);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Tabs whose file lies at or below `path` (used before deleting it). */
  under(root: string, path: string): TabState[] {
    return this.tabs.filter((t) => !t.untitled && t.ref.root === root && (t.ref.path === path || t.ref.path.startsWith(path + '/')));
  }

  snapshot(): TabsSnapshot {
    const active = this.active;
    return {
      tabs: this.tabs.filter((t) => !t.untitled).map((t) => ({ ref: { ...t.ref }, untitled: false, cursor: t.cursor, scrollTop: t.scrollTop })),
      activeKey: active && !active.untitled ? refKey(active.ref) : null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
