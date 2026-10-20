import { h, clear, debounce } from '../components/dom';
import { icon, type IconName } from '../components/icons';
import { showMenu, type MenuItem } from '../components/overlays';
import type { FileRef } from '../app/tabsModel';
import type { Entry } from './providers';
import type { RootInfo, SearchHit, Workspace } from './workspace';
import { basename, extname, formatSize, isPythonFile } from './paths';

export interface ExplorerActions {
  openFile(ref: FileRef, line?: number): void;
  runFile(ref: FileRef): void;
  newFile(root: string, folder: string): void;
  newFolder(root: string, folder: string): void;
  newProject(): void;
  rename(root: string, entry: Entry): void;
  duplicate(root: string, entry: Entry): void;
  move(root: string, entry: Entry): void;
  remove(root: string, entry: Entry): void;
  exportFile(root: string, entry: Entry): void;
  importFiles(root: string, folder: string): void;
  openExternalFolder(): void;
  closeExternalFolder(root: string): void;
  setEntryPoint(ref: FileRef): void;
  isDirty(ref: FileRef): boolean;
  activeRef(): FileRef | null;
}

function iconFor(entry: Entry): IconName {
  if (entry.type === 'directory') return 'folder';
  const ext = extname(entry.name);
  if (ext === '.py' || ext === '.pyw') return 'fileCode';
  if (ext === '.json' || ext === '.toml' || ext === '.yaml' || ext === '.yml') return 'braces';
  if (ext === '.md' || ext === '.txt' || ext === '.csv') return 'fileText';
  return 'file';
}

/**
 * Tree of the workspace and opened folders. Folders load lazily when
 * expanded; the expanded set survives refreshes.
 */
export class FileExplorer {
  readonly el: HTMLElement;
  private tree: HTMLElement;
  private results: HTMLElement;
  private searchInput: HTMLInputElement;
  private expanded = new Set<string>();
  private searchAbort: AbortController | null = null;

  constructor(private workspace: Workspace, private actions: ExplorerActions) {
    this.searchInput = h('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Search file names and text',
      attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Search files' },
    });
    const runSearch = debounce(() => void this.search(this.searchInput.value), 250);
    this.searchInput.addEventListener('input', runSearch);
    this.tree = h('div', { class: 'tree', attrs: { role: 'tree', 'aria-label': 'Files' } });
    this.results = h('div', { class: 'search-results hidden', attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'div',
      { class: 'explorer' },
      h('div', { class: 'pane-header' },
        h('h2', { class: 'pane-title' }, 'Files'),
        h('div', { class: 'pane-actions' },
          h('button', { class: 'icon-btn', title: 'New project', attrs: { 'aria-label': 'New project' }, onClick: () => actions.newProject() }, icon('newFolder', 18)),
          h('button', { class: 'icon-btn', title: 'New file', attrs: { 'aria-label': 'New file' }, onClick: () => actions.newFile('workspace', this.defaultFolder()) }, icon('newFile', 18)),
          h('button', {
            class: 'icon-btn',
            title: 'More file actions',
            attrs: { 'aria-label': 'More file actions' },
            onClick: (e: Event) =>
              showMenu(e.currentTarget as HTMLElement, [
                { label: 'Import files…', icon: 'fileImport', action: () => actions.importFiles('workspace', this.defaultFolder()) },
                { label: 'Open a folder from Files…', icon: 'folderImport', action: () => actions.openExternalFolder() },
                { label: 'Refresh', icon: 'restart', action: () => this.refresh() },
              ]),
          }, icon('more', 18)),
        ),
      ),
      h('div', { class: 'search-box' }, icon('search', 16), this.searchInput),
      this.results,
      this.tree,
    );
    workspace.subscribe(() => void this.refresh());
  }

  /** Folder that "New file" targets: the active file's project, else the workspace root. */
  private defaultFolder(): string {
    const active = this.actions.activeRef();
    if (!active || active.root !== 'workspace') return '';
    const first = active.path.split('/')[0];
    return active.path.includes('/') ? first : '';
  }

  async refresh(): Promise<void> {
    const fragment = document.createDocumentFragment();
    for (const root of this.workspace.allRoots) fragment.appendChild(await this.renderRoot(root));
    const recent = this.renderRecent();
    if (recent) fragment.appendChild(recent);
    clear(this.tree);
    this.tree.appendChild(fragment);
    this.highlightActive();
  }

  highlightActive(): void {
    const active = this.actions.activeRef();
    for (const row of this.tree.querySelectorAll<HTMLElement>('.tree-row[data-root]')) {
      const isActive = !!active && row.dataset.root === active.root && row.dataset.path === active.path;
      row.classList.toggle('active', isActive);
      row.classList.toggle('dirty', !!row.dataset.path && this.actions.isDirty({ root: row.dataset.root as string, path: row.dataset.path }));
    }
  }

  private async renderRoot(root: RootInfo): Promise<HTMLElement> {
    const key = `${root.id}::`;
    const isOpen = !this.expanded.has(`collapsed:${key}`);
    const children = h('div', { class: 'tree-children', attrs: { role: 'group' } });
    const header = h(
      'div',
      { class: 'tree-root' },
      h('button', {
        class: 'tree-root-toggle',
        attrs: { 'aria-expanded': String(isOpen) },
        onClick: () => {
          if (this.expanded.has(`collapsed:${key}`)) this.expanded.delete(`collapsed:${key}`);
          else this.expanded.add(`collapsed:${key}`);
          void this.refresh();
        },
      }, icon(isOpen ? 'chevronDown' : 'chevronRight', 15), icon(root.kind === 'workspace' ? 'device' : 'cloud', 15), h('span', null, root.name)),
      h('button', {
        class: 'icon-btn small',
        title: `Actions for ${root.name}`,
        attrs: { 'aria-label': `Actions for ${root.name}` },
        onClick: (e: Event) => {
          const items: MenuItem[] = [
            { label: 'New file', icon: 'newFile', action: () => this.actions.newFile(root.id, '') },
            { label: 'New folder', icon: 'newFolder', action: () => this.actions.newFolder(root.id, '') },
          ];
          if (root.kind === 'workspace') {
            items.unshift({ label: 'New project', icon: 'plus', action: () => this.actions.newProject() });
            items.push({ label: 'Import files…', icon: 'fileImport', action: () => this.actions.importFiles(root.id, '') });
          } else {
            items.push({ label: 'Close folder', icon: 'close', action: () => this.actions.closeExternalFolder(root.id) });
          }
          showMenu(e.currentTarget as HTMLElement, items, root.name);
        },
      }, icon('more', 16)),
    );
    if (isOpen) await this.renderChildren(root.id, '', children, 0);
    return h('div', { class: 'tree-section' }, header, children);
  }

  private async renderChildren(rootId: string, folder: string, container: HTMLElement, depth: number): Promise<void> {
    let entries: Entry[];
    try {
      entries = await this.workspace.provider(rootId).list(folder);
    } catch (error) {
      container.appendChild(h('p', { class: 'tree-error' }, (error as Error).message));
      return;
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'directory' ? -1 : 1));
    if (entries.length === 0 && depth === 0) {
      container.appendChild(
        h('div', { class: 'tree-empty' },
          h('p', null, rootId === 'workspace' ? 'No projects yet.' : 'This folder is empty.'),
          rootId === 'workspace' ? h('button', { class: 'btn btn-primary btn-small', onClick: () => this.actions.newProject() }, 'Create a project') : null,
        ),
      );
    }
    for (const entry of entries) {
      const key = `${rootId}::${entry.path}`;
      const isDir = entry.type === 'directory';
      const isOpen = isDir && this.expanded.has(key);
      const row = h(
        'div',
        {
          class: `tree-row${isDir ? ' folder' : ''}`,
          dataset: { root: rootId, path: entry.path },
          style: { paddingLeft: `${10 + depth * 16}px` },
          attrs: { role: 'treeitem', tabindex: '0', 'aria-expanded': isDir ? String(isOpen) : null },
        },
        isDir ? icon(isOpen ? 'chevronDown' : 'chevronRight', 14, 'chevron') : h('span', { class: 'chevron-spacer' }),
        icon(iconFor(entry), 16, isPythonFile(entry.name) ? 'icon-python' : ''),
        h('span', { class: 'tree-name' }, entry.name),
        !isDir && entry.downloaded === false ? icon('cloud', 13, 'muted') : null,
        !isDir ? h('span', { class: 'tree-meta' }, formatSize(entry.size)) : null,
        h('button', {
          class: 'icon-btn small row-menu',
          title: `Actions for ${entry.name}`,
          attrs: { 'aria-label': `Actions for ${entry.name}`, tabindex: '-1' },
          onClick: (e: Event) => {
            e.stopPropagation();
            this.showEntryMenu(rootId, entry, e.currentTarget as HTMLElement);
          },
        }, icon('more', 16)),
      );
      const activate = () => {
        if (isDir) {
          if (this.expanded.has(key)) this.expanded.delete(key);
          else this.expanded.add(key);
          void this.refresh();
        } else {
          this.actions.openFile({ root: rootId, path: entry.path });
        }
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showEntryMenu(rootId, entry, row);
      });
      container.appendChild(row);
      if (isOpen) {
        const sub = h('div', { class: 'tree-children', attrs: { role: 'group' } });
        container.appendChild(sub);
        await this.renderChildren(rootId, entry.path, sub, depth + 1);
      }
    }
  }

  private showEntryMenu(rootId: string, entry: Entry, anchor: HTMLElement): void {
    const ref = { root: rootId, path: entry.path };
    const items: (MenuItem | 'separator')[] = [];
    if (entry.type === 'file') {
      items.push({ label: 'Open', icon: 'fileCode', action: () => this.actions.openFile(ref) });
      if (isPythonFile(entry.name)) {
        items.push({ label: 'Run', icon: 'play', action: () => this.actions.runFile(ref) });
        items.push({ label: 'Set as entry point', icon: 'check', action: () => this.actions.setEntryPoint(ref) });
      }
    } else {
      items.push({ label: 'New file here', icon: 'newFile', action: () => this.actions.newFile(rootId, entry.path) });
      items.push({ label: 'New folder here', icon: 'newFolder', action: () => this.actions.newFolder(rootId, entry.path) });
      if (rootId === 'workspace') items.push({ label: 'Import files here…', icon: 'fileImport', action: () => this.actions.importFiles(rootId, entry.path) });
    }
    items.push('separator');
    items.push({ label: 'Rename', icon: 'rename', action: () => this.actions.rename(rootId, entry) });
    items.push({ label: 'Duplicate', icon: 'duplicate', action: () => this.actions.duplicate(rootId, entry) });
    items.push({ label: 'Move to…', icon: 'folderOpen', action: () => this.actions.move(rootId, entry) });
    if (entry.type === 'file') items.push({ label: 'Export…', icon: 'share', action: () => this.actions.exportFile(rootId, entry) });
    items.push('separator');
    items.push({ label: 'Delete', icon: 'trash', danger: true, action: () => this.actions.remove(rootId, entry) });
    showMenu(anchor, items, basename(entry.path));
  }

  private renderRecent(): HTMLElement | null {
    const recent = this.workspace.recent.filter((r) => this.workspace.hasRoot(r.root)).slice(0, 8);
    if (recent.length === 0) return null;
    return h(
      'div',
      { class: 'tree-section recent' },
      h('div', { class: 'tree-root static' }, icon('history', 15), h('span', null, 'Recent')),
      recent.map((ref) =>
        h('div', {
          class: 'tree-row recent-row',
          attrs: { role: 'treeitem', tabindex: '0' },
          onClick: () => this.actions.openFile(ref),
          onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && this.actions.openFile(ref),
        },
        icon(isPythonFile(ref.path) ? 'fileCode' : 'file', 16),
        h('span', { class: 'tree-name' }, basename(ref.path)),
        h('span', { class: 'tree-meta' }, this.workspace.displayName(ref).split('/').slice(0, -1).join('/'))),
      ),
    );
  }

  private async search(query: string): Promise<void> {
    this.searchAbort?.abort();
    const trimmed = query.trim();
    if (!trimmed) {
      this.results.classList.add('hidden');
      this.tree.classList.remove('hidden');
      return;
    }
    const controller = new AbortController();
    this.searchAbort = controller;
    this.results.classList.remove('hidden');
    this.tree.classList.add('hidden');
    clear(this.results);
    this.results.appendChild(h('p', { class: 'muted search-status' }, 'Searching…'));
    const hits: SearchHit[] = [];
    for (const root of this.workspace.allRoots) {
      hits.push(...(await this.workspace.search(root.id, '', trimmed, { signal: controller.signal })));
      if (controller.signal.aborted) return;
    }
    clear(this.results);
    if (hits.length === 0) {
      this.results.appendChild(h('p', { class: 'muted search-status' }, `No matches for “${trimmed}”.`));
      return;
    }
    this.results.appendChild(h('p', { class: 'muted search-status' }, `${hits.length} match${hits.length === 1 ? '' : 'es'}`));
    for (const hit of hits) {
      this.results.appendChild(
        h('button', {
          class: 'search-hit',
          onClick: () => this.actions.openFile(hit.ref, hit.line),
        },
        h('span', { class: 'hit-file' }, icon(isPythonFile(hit.name) ? 'fileCode' : 'file', 14), this.workspace.displayName(hit.ref), hit.line ? h('span', { class: 'hit-line' }, `:${hit.line}`) : null),
        hit.preview ? h('code', { class: 'hit-preview' }, hit.preview) : null),
      );
    }
  }
}
