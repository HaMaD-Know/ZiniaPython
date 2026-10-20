import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';
import { ConsolePanel, type RunBlock } from '../console/ConsolePanel';
import { createKeyBar } from '../components/KeyBar';
import { debounce, formatDuration, h, clear } from '../components/dom';
import { icon, type IconName } from '../components/icons';
import { alertDialog, choiceDialog, confirmDialog, promptDialog, showMenu, toast } from '../components/overlays';
import { EditorManager } from '../editor/EditorManager';
import { FileExplorer } from '../files/FileExplorer';
import { basename, copyName, dirname, isInside, isPythonFile, isProbablyText, join, normalize, validateName } from '../files/paths';
import type { Entry } from '../files/providers';
import { Workspace } from '../files/workspace';
import { GRAPHICS_EXAMPLES, GRAPHICS_EXAMPLES_ENTRY, GRAPHICS_EXAMPLES_PROJECT } from '../graphics/examples';
import { GraphicsController } from '../graphics/GraphicsController';
import { GraphicsPanel } from '../graphics/GraphicsPanel';
import { PackagesView } from '../packages/PackagesView';
import { DEV_BRIDGE } from '../plugins/dev-bridge-flag';
import { ZiniaFiles } from '../plugins/zinia-files';
import { projectKey, projectOf, ProjectService, type ProjectRef } from '../projects/projects';
import { DiagnosticsLog } from '../services/diagnostics';
import { newExecutionId, PythonService, toRuntimeError } from '../services/python';
import type { RuntimeSnapshot } from '../services/runtimeMachine';
import { SettingsStore, type Settings } from '../services/settings';
import { storage } from '../services/storage';
import { SettingsView } from '../settings/SettingsView';
import type { PythonExecutionResult } from '../types/python';
import { refKey, TabsModel, type FileRef, type TabsSnapshot, type TabState } from './tabsModel';

interface Session {
  tabs: TabsSnapshot;
  consoleHeight: number;
  consoleState: 'collapsed' | 'normal' | 'expanded';
  sidebarOpen: boolean;
  openFolders: string[];
}

interface Draft {
  text: string;
  untitled: boolean;
  at: number;
}

const SESSION_KEY = 'session';
const DRAFT_PREFIX = 'draft:';
const WIDE_QUERY = '(min-width: 900px)';

export class ZiniaApp {
  private readonly isNative = Capacitor.isNativePlatform();
  private readonly devBridge = DEV_BRIDGE;
  private readonly settings = new SettingsStore(storage);
  private readonly diagnostics = new DiagnosticsLog(storage);
  private readonly workspace = new Workspace(storage, this.devBridge);
  private readonly projects = new ProjectService(this.workspace, () => this.settings.current.defaultEntryPoint);
  private readonly python = new PythonService(this.diagnostics, () => this.settings.current.runTimeoutSeconds);
  private readonly tabs = new TabsModel();
  private editor!: EditorManager;
  private consolePanel!: ConsolePanel;
  private explorer!: FileExplorer;
  private packagesView!: PackagesView;
  private settingsView!: SettingsView;
  private graphics!: GraphicsPanel;
  private graphicsController!: GraphicsController;
  private graphicsButton!: HTMLButtonElement;

  // DOM
  private shell!: HTMLElement;
  private projectLabel!: HTMLElement;
  private fileLabel!: HTMLElement;
  private saveState!: HTMLElement;
  private runButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private statusRail!: HTMLElement;
  private statusText!: HTMLElement;
  private tabBar!: HTMLElement;
  private editorHost!: HTMLElement;
  private banner!: HTMLElement;
  private consoleHost!: HTMLElement;
  private sidebar!: HTMLElement;
  private pageHost!: HTMLElement;
  private keyBar!: HTMLElement;
  private emptyEditor!: HTMLElement;

  private session: Session = {
    tabs: { tabs: [], activeKey: null },
    consoleHeight: 0.38,
    consoleState: 'normal',
    sidebarOpen: true,
    openFolders: [],
  };
  private wide = window.matchMedia(WIDE_QUERY).matches;
  private drawerOpen = false;
  private page: 'none' | 'settings' | 'packages' = 'none';
  private keyboardOpen = false;
  private projectModuleCache = new Map<string, string[]>();
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private lastOutcome: { tone: 'ok' | 'warn' | 'error'; text: string } | null = null;
  private activeRun: { executionId: string; block: RunBlock } | null = null;
  private saving = new Set<string>();

  private readonly saveSession = debounce(() => void storage.set(SESSION_KEY, this.collectSession()), 400);
  private readonly autoSaveQueue = new Set<string>();
  private readonly draftQueue = new Set<string>();
  private readonly autoSave = debounce(() => {
    for (const id of this.autoSaveQueue) void this.autoSaveTab(id);
    this.autoSaveQueue.clear();
  }, 1500);
  private readonly persistDraft = debounce(() => {
    for (const id of this.draftQueue) void this.writeDraft(id);
    this.draftQueue.clear();
  }, 700);

  async start(root: HTMLElement): Promise<void> {
    await Promise.all([this.settings.load(), this.diagnostics.load()]);
    this.diagnostics.enabled = this.settings.current.diagnosticsLog;
    this.applyAppearance(this.settings.current);
    this.buildLayout(root);
    this.settings.subscribe((s, changed) => this.onSettingsChanged(s, changed));

    try {
      await this.workspace.init();
    } catch (error) {
      this.consolePanel.appendNotice(`The workspace could not be opened: ${(error as Error).message}`, 'error');
    }
    const saved = await storage.get<Session>(SESSION_KEY);
    if (saved && typeof saved === 'object') this.session = { ...this.session, ...saved };
    this.applyConsoleLayout();
    await this.reopenFolders();
    await this.restoreTabs();
    await this.explorer.refresh();
    this.attachPlatformListeners();
    this.diagnostics.record('info', 'app.start', { native: this.isNative, devBridge: this.devBridge });
    void this.startRuntime();
  }

  // ---------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------

  private buildLayout(root: HTMLElement): void {
    const s = this.settings.current;
    this.editorHost = h('div', { class: 'editor-host' });
    this.editor = new EditorManager(this.editorHost, s, () => this.currentProjectModules());
    this.editor.onChange = (tabId, text) => this.onEditorChange(tabId, text);

    this.consolePanel = new ConsolePanel({
      canNavigate: (filename) => this.canNavigate(filename),
      navigate: (filename, lineno, colno) => void this.navigateTo(filename, lineno, colno ?? 1),
      submitInput: async (executionId, text) => {
        try {
          await this.python.provideInput(executionId, text);
        } catch (error) {
          toast(toRuntimeError(error).message, 'error');
        }
      },
      submitRepl: (source, mode) => this.runRepl(source, mode),
      resetRepl: () => this.resetInterpreter(),
      onToggleExpand: () => this.cycleConsole(),
    });
    this.consolePanel.setFontSize(s.consoleFontSize);
    this.consolePanel.setAutoScroll(s.autoScroll);
    this.python.onBackgroundOutput = (stream, text) => this.consolePanel.appendBackground(stream, text);

    this.graphics = new GraphicsPanel({
      run: () => void this.runActive(),
      stop: () => void this.stop(),
      openExamples: () => void this.openGraphicsExamples(),
      changed: () => this.onGraphicsPanelChanged(),
    });
    this.graphicsController = new GraphicsController(this.graphics, (executionId, events) =>
      this.python.postGraphicsEvents(executionId, events));
    this.graphics.connect(this.graphicsController);
    this.python.onGraphics = (payload) => this.graphicsController.handlePayload(payload);

    this.explorer = new FileExplorer(this.workspace, {
      openFile: (ref, line) => void this.openFile(ref, line),
      runFile: (ref) => void this.openFile(ref).then(() => this.runActive()),
      newFile: (rootId, folder) => void this.newFile(rootId, folder),
      newFolder: (rootId, folder) => void this.newFolder(rootId, folder),
      newProject: () => void this.newProject(),
      rename: (rootId, entry) => void this.renameEntry(rootId, entry),
      duplicate: (rootId, entry) => void this.duplicateEntry(rootId, entry),
      move: (rootId, entry) => void this.moveEntry(rootId, entry),
      remove: (rootId, entry) => void this.deleteEntry(rootId, entry),
      exportFile: (rootId, entry) => void this.exportEntry(rootId, entry),
      importFiles: (rootId, folder) => void this.importFiles(rootId, folder),
      openExternalFolder: () => void this.openExternalFolder(),
      closeExternalFolder: (rootId) => void this.closeExternalFolder(rootId),
      setEntryPoint: (ref) => void this.setEntryPoint(ref),
      isDirty: (ref) => {
        const tab = this.tabs.find(ref);
        return tab ? this.tabs.isDirty(tab) : false;
      },
      activeRef: () => this.tabs.active?.ref ?? null,
    });

    this.packagesView = new PackagesView(this.python, () => this.showPage('none'));
    this.settingsView = new SettingsView(this.settings, this.python, this.diagnostics, {
      clearCache: () => this.clearCache(),
      workspacePath: () => this.workspace.allRoots[0]?.absolute ?? null,
    }, () => this.showPage('none'));

    // Top bar
    this.projectLabel = h('span', { class: 'project-label' });
    this.fileLabel = h('span', { class: 'file-label' });
    this.saveState = h('span', { class: 'save-state', attrs: { 'aria-live': 'polite' } });
    this.runButton = h('button', { class: 'run-btn', title: 'Run current file (⌘R)', attrs: { 'aria-label': 'Run current file' }, onClick: () => void this.runActive() }, icon('play', 17), h('span', null, 'Run'));
    this.stopButton = h('button', { class: 'stop-btn', title: 'Stop the running script', disabled: true, attrs: { 'aria-label': 'Stop' }, onClick: () => void this.stop() }, icon('stop', 15), h('span', null, 'Stop'));
    this.statusText = h('span', { class: 'status-text' });
    this.statusRail = h('div', { class: 'status-rail', attrs: { 'aria-hidden': 'true' } });
    this.graphicsButton = h('button', {
      class: 'icon-btn',
      title: 'Graphics preview',
      attrs: { 'aria-label': 'Graphics preview', 'aria-pressed': 'false' },
      onClick: () => this.graphics.toggle(),
    }, icon('shapes', 20));

    const topBar = h(
      'header',
      { class: 'top-bar' },
      h('button', { class: 'icon-btn sidebar-toggle', title: 'Files', attrs: { 'aria-label': 'Show files' }, onClick: () => this.toggleSidebar() }, icon('sidebar', 20)),
      h('div', { class: 'title-block' },
        h('div', { class: 'title-line' }, this.fileLabel, this.saveState),
        h('div', { class: 'subtitle-line' }, this.projectLabel, this.statusText),
      ),
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn', title: 'More actions', attrs: { 'aria-label': 'More actions' }, onClick: (e: Event) => this.showMainMenu(e.currentTarget as HTMLElement) }, icon('more', 20)),
        this.graphicsButton,
        this.stopButton,
        this.runButton,
      ),
    );

    this.tabBar = h('div', { class: 'tab-bar', attrs: { role: 'tablist', 'aria-label': 'Open files' } });
    this.banner = h('div', { class: 'editor-banner hidden', attrs: { role: 'status' } });
    this.emptyEditor = h('div', { class: 'editor-empty' },
      h('div', { class: 'empty-inner' },
        h('h2', null, 'Nothing open'),
        h('p', null, 'Open a file from Files, or start something new.'),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn btn-primary', onClick: () => void this.newProject() }, 'New project'),
          h('button', { class: 'btn', onClick: () => this.newScratch() }, 'Scratch file'),
          h('button', { class: 'btn', onClick: () => this.openDrawer() }, 'Browse files'),
        ),
      ),
    );

    this.consoleHost = h('div', { class: 'console-host' });
    this.consoleHost.appendChild(this.consolePanel.el);
    this.makeConsoleResizable();

    this.sidebar = h('aside', { class: 'sidebar', attrs: { 'aria-label': 'Files' } }, this.explorer.el);
    this.pageHost = h('div', { class: 'page-host hidden' });
    this.keyBar = createKeyBar(this.editor, () => this.hideKeyboard());

    const rail = h('nav', { class: 'activity-rail', attrs: { 'aria-label': 'Sections' } },
      this.railButton('folder', 'Files', () => this.toggleSidebar()),
      this.railButton('search', 'Search', () => this.focusSearch()),
      this.railButton('terminal', 'Console', () => this.cycleConsole()),
      this.railButton('package', 'Packages', () => this.showPage('packages')),
      h('div', { class: 'rail-spacer' }),
      this.railButton('settings', 'Settings', () => this.showPage('settings')),
    );

    const bottomNav = h('nav', { class: 'bottom-nav', attrs: { 'aria-label': 'Sections' } },
      this.navButton('folder', 'Files', () => this.openDrawer()),
      this.navButton('search', 'Find', () => this.editor.openSearch()),
      this.navButton('terminal', 'Console', () => this.cycleConsole()),
      this.navButton('package', 'Packages', () => this.showPage('packages')),
      this.navButton('settings', 'Settings', () => this.showPage('settings')),
    );

    const main = h('main', { class: 'main' },
      topBar,
      this.statusRail,
      this.tabBar,
      h('div', { class: 'editor-area' },
        h('div', { class: 'editor-column' }, this.banner, this.editorHost, this.emptyEditor),
        this.graphics.el,
      ),
      this.consoleHost,
      this.pageHost,
    );

    this.shell = h('div', { class: 'shell' },
      rail,
      this.sidebar,
      h('div', { class: 'drawer-backdrop', onClick: () => this.closeDrawer() }),
      main,
      bottomNav,
      this.keyBar,
    );
    clear(root);
    root.classList.remove('boot');
    root.appendChild(this.shell);

    this.tabs.subscribe(() => this.onTabsChanged());
    this.python.machine.subscribe((snapshot) => this.onRuntimeState(snapshot));
    window.matchMedia(WIDE_QUERY).addEventListener('change', (e) => {
      this.wide = e.matches;
      this.applyShellClasses();
    });
    document.addEventListener('keydown', (e) => this.onGlobalKey(e));
    this.applyShellClasses();
    this.onTabsChanged();
  }

  private railButton(name: IconName, label: string, action: () => void): HTMLElement {
    return h('button', { class: 'rail-btn', title: label, attrs: { 'aria-label': label }, onClick: action }, icon(name, 21));
  }

  private navButton(name: IconName, label: string, action: () => void): HTMLElement {
    return h('button', { class: 'nav-btn', onClick: action }, icon(name, 21), h('span', null, label));
  }

  private applyShellClasses(): void {
    const cls = this.shell.classList;
    cls.toggle('wide', this.wide);
    cls.toggle('compact', !this.wide);
    cls.toggle('sidebar-open', this.wide ? this.session.sidebarOpen : this.drawerOpen);
    cls.toggle('keyboard-open', this.keyboardOpen);
    cls.toggle('show-keybar', this.keyboardOpen && this.settings.current.showKeyBar && this.editor.view.hasFocus);
    cls.toggle('page-open', this.page !== 'none');
  }

  private toggleSidebar(): void {
    if (this.wide) {
      this.session.sidebarOpen = !this.session.sidebarOpen;
      this.saveSession();
      this.applyShellClasses();
    } else if (this.drawerOpen) {
      this.closeDrawer();
    } else {
      this.openDrawer();
    }
  }

  private openDrawer(): void {
    if (this.wide) {
      this.session.sidebarOpen = true;
    } else {
      this.drawerOpen = true;
    }
    this.applyShellClasses();
  }

  private closeDrawer(): void {
    this.drawerOpen = false;
    this.applyShellClasses();
  }

  private focusSearch(): void {
    this.openDrawer();
    requestAnimationFrame(() => (this.explorer.el.querySelector('.search-input') as HTMLInputElement | null)?.focus());
  }

  private showPage(page: 'none' | 'settings' | 'packages'): void {
    this.page = page;
    clear(this.pageHost);
    this.pageHost.classList.toggle('hidden', page === 'none');
    if (page === 'settings') {
      this.settingsView.render();
      this.pageHost.appendChild(this.settingsView.el);
    } else if (page === 'packages') {
      this.pageHost.appendChild(this.packagesView.el);
      void this.packagesView.refresh();
    }
    this.closeDrawer();
    this.applyShellClasses();
  }

  // --- console sizing -----------------------------------------------------

  private applyConsoleLayout(): void {
    const main = this.shell.querySelector('.main') as HTMLElement;
    main.dataset.console = this.session.consoleState;
    main.style.setProperty('--console-share', String(Math.min(0.85, Math.max(0.15, this.session.consoleHeight))));
  }

  private cycleConsole(): void {
    const order: Session['consoleState'][] = ['collapsed', 'normal', 'expanded'];
    const next = order[(order.indexOf(this.session.consoleState) + 1) % order.length];
    this.setConsoleState(next);
  }

  private setConsoleState(state: Session['consoleState']): void {
    this.session.consoleState = state;
    this.applyConsoleLayout();
    this.saveSession();
  }

  private ensureConsoleVisible(): void {
    if (this.session.consoleState === 'collapsed') this.setConsoleState('normal');
  }

  private makeConsoleResizable(): void {
    const header = this.consolePanel.header;
    let startY = 0;
    let startShare = 0;
    let dragging = false;
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      dragging = true;
      startY = e.clientY;
      startShare = this.session.consoleHeight;
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const main = this.shell.querySelector('.main') as HTMLElement;
      const delta = (startY - e.clientY) / Math.max(1, main.clientHeight);
      if (Math.abs(startY - e.clientY) > 6 && this.session.consoleState !== 'normal') {
        this.session.consoleState = 'normal';
      }
      this.session.consoleHeight = Math.min(0.85, Math.max(0.15, startShare + delta));
      this.applyConsoleLayout();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (Math.abs(startY - e.clientY) < 6) this.cycleConsole();
      this.saveSession();
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------------
  // Appearance and settings
  // ---------------------------------------------------------------------

  private applyAppearance(s: Settings): void {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = s.theme === 'system' ? (prefersDark ? 'dark' : 'light') : s.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--editor-font-size', `${s.editorFontSize}px`);
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', theme === 'dark' ? '#0e1220' : '#f4f5fa');
    if (this.isNative) {
      void StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light }).catch(() => undefined);
    }
  }

  private onSettingsChanged(s: Settings, changed: (keyof Settings)[]): void {
    this.applyAppearance(s);
    this.diagnostics.enabled = s.diagnosticsLog;
    this.editor.applySettings(s);
    this.consolePanel.setFontSize(s.consoleFontSize);
    if (changed.includes('autoScroll')) this.consolePanel.setAutoScroll(s.autoScroll);
    if (changed.includes('keepDrafts') && !s.keepDrafts) void storage.clear(DRAFT_PREFIX);
    this.applyShellClasses();
  }

  // ---------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------

  private async startRuntime(): Promise<void> {
    await this.python.start();
    if (this.python.machine.current.fatal) this.showRuntimeDiagnostic();
    else if (this.python.info?.devBridge) {
      this.consolePanel.appendNotice(
        `Desktop development bridge: code runs in ${this.python.info.implementation} ${this.python.info.pythonVersion} on this computer, not in the iOS runtime.`,
      );
    }
  }

  private showRuntimeDiagnostic(): void {
    const err = this.python.startError;
    if (!err) return;
    const data = err.data ?? {};
    const lines: string[] = [];
    if (err.code === 'UNAVAILABLE') {
      lines.push('You are using the web preview. Python only runs inside the iOS app, where CPython is embedded.');
    } else {
      lines.push(`Python could not start (${err.code}).`);
      lines.push(err.message);
      if (Array.isArray(data.missingPaths)) lines.push(`Missing: ${(data.missingPaths as string[]).join(', ')}`);
      if (typeof data.pythonTraceback === 'string') lines.push(data.pythonTraceback);
      lines.push('See docs/TROUBLESHOOTING.md, "Runtime does not start".');
    }
    const panel = h('div', { class: 'diagnostic-panel' },
      h('h3', null, err.code === 'UNAVAILABLE' ? 'No Python runtime in the web preview' : 'Python runtime did not start'),
      h('pre', { class: 'diagnostic-text' }, lines.join('\n\n')),
      data.retryable === true
        ? h('button', { class: 'btn btn-primary btn-small', onClick: () => { panel.remove(); void this.startRuntime(); } }, 'Try again')
        : null,
    );
    this.ensureConsoleVisible();
    this.consolePanel.show('output');
    (this.consolePanel.el.querySelector('.console-scroll') as HTMLElement).appendChild(panel);
  }

  private onRuntimeState(snapshot: RuntimeSnapshot): void {
    const rail = this.statusRail;
    rail.dataset.state = snapshot.state;
    const running = snapshot.state === 'running' || snapshot.state === 'interrupt-requested';
    this.runButton.disabled = running || snapshot.fatal || snapshot.state === 'initializing' || snapshot.state === 'not-initialized';
    this.stopButton.disabled = !this.python.canInterrupt;
    this.graphics?.setRunning(running, !this.runButton.disabled);
    this.shell.classList.toggle('is-running', running);
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    const setStatus = (text: string, tone = '') => {
      this.statusText.textContent = text;
      this.statusText.dataset.tone = tone;
    };
    switch (snapshot.state) {
      case 'not-initialized':
      case 'initializing':
        setStatus('Starting Python…');
        break;
      case 'ready':
        setStatus(this.python.info ? `Python ${this.python.info.pythonVersion}` : 'Ready', 'ok');
        break;
      case 'running': {
        const update = () => {
          const elapsed = snapshot.startedAt ? Date.now() - snapshot.startedAt : 0;
          setStatus(`${snapshot.label ?? 'Running'} ${elapsed > 900 ? formatDuration(elapsed) : ''}`.trim(), 'running');
        };
        update();
        this.elapsedTimer = setInterval(update, 500);
        break;
      }
      case 'interrupt-requested':
        setStatus('Stopping…', 'running');
        break;
      case 'completed':
      case 'failed':
        if (snapshot.fatal) setStatus(snapshot.state === 'failed' ? 'Python unavailable' : '', 'error');
        else setStatus(this.lastOutcome?.text ?? `Python ${this.python.info?.pythonVersion ?? ''}`, this.lastOutcome?.tone ?? 'ok');
        break;
      case 'unavailable':
        setStatus('Web preview: no Python', 'error');
        break;
    }
  }

  private runLabel(tab: TabState): string {
    return basename(tab.ref.path);
  }

  /** Runs the active tab. Unsaved edits run as they are in the editor. */
  async runActive(): Promise<void> {
    const tab = this.tabs.active;
    if (!tab) {
      toast('Open a Python file to run it');
      return;
    }
    if (!isPythonFile(tab.ref.path)) {
      toast('Only .py files can be run');
      return;
    }
    await this.runTab(tab);
  }

  private async runProjectEntry(): Promise<void> {
    const active = this.tabs.active;
    const project = active ? projectOf(active.ref) : null;
    if (!project) {
      toast('The current file is not inside a project');
      return;
    }
    const config = await this.projects.loadConfig(project);
    const ref = { root: project.root, path: join(project.path, config.entry) };
    await this.openFile(ref);
    const tab = this.tabs.find(ref);
    if (tab) await this.runTab(tab);
  }

  private async runTab(tab: TabState): Promise<void> {
    if (!this.python.canRun) {
      const s = this.python.machine.current;
      if (s.fatal) {
        this.showRuntimeDiagnostic();
        toast(this.python.startError?.message ?? 'Python is not available', 'error', 4000);
      } else {
        toast(s.state === 'initializing' ? 'Python is still starting' : 'A script is already running', 'info');
      }
      return;
    }
    const project = tab.untitled ? null : projectOf(tab.ref);
    if (this.settings.current.saveBeforeRun && !tab.untitled) {
      const ok = await this.saveProjectFiles(tab, project);
      if (!ok) return;
    }
    const config = project ? await this.projects.loadConfig(project) : null;
    const fileAbs = tab.untitled ? null : this.workspace.absolutePath(tab.ref);
    const projectAbs = project ? this.projects.absoluteFolder(project) : null;
    const fileDirAbs = fileAbs ? fileAbs.slice(0, fileAbs.lastIndexOf('/')) : null;
    const mode = config?.workingDirectory === 'file' || this.settings.current.workingDirectory === 'file' ? 'file' : 'project';
    const workspaceAbs = this.workspace.allRoots[0]?.absolute ?? null;
    const cwd = (mode === 'project' ? projectAbs ?? fileDirAbs : fileDirAbs ?? projectAbs) ?? workspaceAbs ?? undefined;
    const filename = fileAbs ?? `<${basename(tab.ref.path)}>`;
    const code = this.editor.getText(tab.id) ?? tab.text;

    this.editor.clearErrorMark();
    this.ensureConsoleVisible();
    const executionId = newExecutionId('run');
    const block = this.consolePanel.beginRun(executionId, this.workspace.displayName(tab.ref));
    this.activeRun = { executionId, block };
    this.graphicsController.beginRun(executionId);
    let result: PythonExecutionResult;
    try {
      result = await this.python.runScript(
        { code, filename, workingDirectory: cwd, projectRoot: projectAbs ?? undefined, args: config?.args ?? [] },
        {
          onOutput: (stream, text) => block.append(stream, text),
          onInputRequest: () => {
            this.ensureConsoleVisible();
            block.requestInput();
          },
        },
        this.runLabel(tab),
        executionId,
      );
    } catch (error) {
      const err = toRuntimeError(error);
      block.fail(`${err.message}${err.code ? ` (${err.code})` : ''}`);
      this.lastOutcome = { tone: 'error', text: 'Run failed' };
      if (err.code === 'NOT_READY' || err.code === 'UNAVAILABLE') this.showRuntimeDiagnostic();
      this.activeRun = null;
      this.graphicsController.endRun(executionId);
      this.onRuntimeState(this.python.machine.current);
      return;
    }
    this.activeRun = null;
    this.graphicsController.endRun(executionId);
    block.finish(result);
    const outcome =
      result.status === 'ok'
        ? { tone: 'ok' as const, text: `Finished in ${formatDuration(result.durationMs)}` }
        : result.status === 'interrupted'
          ? { tone: 'warn' as const, text: 'Stopped' }
          : result.status === 'exit'
            ? { tone: 'warn' as const, text: `Exit code ${result.exitCode}` }
            : { tone: 'error' as const, text: result.error?.type ?? 'Error' };
    this.lastOutcome = outcome;
    this.onRuntimeState(this.python.machine.current);
    const loc = result.error?.location;
    if (loc?.lineno && this.tabs.active && this.refMatchesFilename(this.tabs.active, loc.filename)) {
      this.editor.markError(loc.lineno);
    }
    if (project) {
      void this.projects.recordRun(project, { status: result.status, durationMs: result.durationMs, at: Date.now(), errorType: result.error?.type });
    }
  }

  private async stop(): Promise<void> {
    const mechanism = await this.python.interrupt('user');
    if (mechanism === 'none') return;
    this.activeRun?.block.cancelInput();
  }

  private async runRepl(source: string, mode: 'line' | 'block'): Promise<PythonExecutionResult | null> {
    if (!this.python.canRun) {
      const s = this.python.machine.current;
      toast(s.fatal ? (this.python.startError?.message ?? 'Python is not available') : 'Wait for the running script to finish', s.fatal ? 'error' : 'info', 4000);
      return null;
    }
    const active = this.tabs.active;
    const project = active && !active.untitled ? projectOf(active.ref) : null;
    const projectAbs = project ? this.projects.absoluteFolder(project) ?? undefined : undefined;
    const executionId = newExecutionId('repl');
    this.graphicsController.beginRepl(executionId);
    try {
      return await this.python.runRepl(source, mode, projectAbs ?? this.workspace.allRoots[0]?.absolute ?? undefined, projectAbs, {
        onOutput: (stream, text) => this.consolePanel.replOutput(stream, text),
        onInputRequest: () => {
          toast('input() is not supported in the REPL; it receives end-of-file', 'info', 4000);
          void this.python.provideInput(this.python.machine.current.executionId ?? '', null);
        },
      }, executionId);
    } catch (error) {
      toast(toRuntimeError(error).message, 'error', 4000);
      return null;
    } finally {
      this.graphicsController.endRun(executionId);
      this.onRuntimeState(this.python.machine.current);
    }
  }

  private async resetInterpreter(): Promise<void> {
    if (!(await confirmDialog('Reset interpreter state?', 'REPL variables are cleared and project modules will be imported fresh. Files and editor tabs are not affected.', 'Reset'))) return;
    try {
      await this.python.resetInterpreter();
      this.consolePanel.resetReplPrompt();
    } catch (error) {
      toast(toRuntimeError(error).message, 'error');
    }
  }

  // ---------------------------------------------------------------------
  // Tabs and editor
  // ---------------------------------------------------------------------

  private onTabsChanged(): void {
    this.renderTabBar();
    const active = this.tabs.active;
    if (active && this.editor.activeTab !== active.id) {
      this.editor.show(active.id, active.text, active.cursor);
    } else if (!active && this.editor.activeTab !== null) {
      this.editor.showEmpty();
    }
    this.editorHost.classList.toggle('hidden', !active);
    this.emptyEditor.classList.toggle('hidden', !!active);
    this.updateTitle();
    this.renderBanner();
    this.explorer?.highlightActive();
    this.saveSession();
  }

  private renderTabBar(): void {
    clear(this.tabBar);
    const active = this.tabs.active;
    for (const tab of this.tabs.all) {
      const dirty = this.tabs.isDirty(tab);
      const name = basename(tab.ref.path);
      const el = h('div', {
        class: `tab${tab === active ? ' active' : ''}${dirty ? ' dirty' : ''}`,
        attrs: { role: 'tab', 'aria-selected': String(tab === active), tabindex: '0', title: this.workspace.displayName(tab.ref) },
      },
      icon(isPythonFile(name) ? 'fileCode' : 'file', 14),
      h('span', { class: 'tab-name' }, name),
      h('button', {
        class: 'tab-close',
        title: dirty ? 'Unsaved changes. Close' : 'Close',
        attrs: { 'aria-label': `Close ${name}` },
        onClick: (e: Event) => {
          e.stopPropagation();
          void this.closeTab(tab.id);
        },
      }, h('span', { class: 'dirty-dot', attrs: { 'aria-hidden': 'true' } }), icon('close', 14)),
      );
      el.addEventListener('click', () => this.activateTab(tab.id));
      el.addEventListener('keydown', (e) => e.key === 'Enter' && this.activateTab(tab.id));
      this.tabBar.appendChild(el);
    }
    this.tabBar.appendChild(h('button', { class: 'tab-new', title: 'New scratch file', attrs: { 'aria-label': 'New scratch file' }, onClick: () => this.newScratch() }, icon('plus', 16)));
    const activeEl = this.tabBar.querySelector('.tab.active') as HTMLElement | null;
    activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private activateTab(id: string): void {
    const current = this.tabs.active;
    if (current) current.cursor = this.editor.cursorOf(current.id);
    this.tabs.activate(id);
    void this.checkExternalChange(this.tabs.byId(id));
  }

  private updateTitle(): void {
    const tab = this.tabs.active;
    if (!tab) {
      this.fileLabel.textContent = 'ZiniaPython';
      this.projectLabel.textContent = '';
      this.saveState.textContent = '';
      return;
    }
    this.fileLabel.textContent = basename(tab.ref.path);
    const project = tab.untitled ? null : projectOf(tab.ref);
    const rootName = this.workspace.hasRoot(tab.ref.root) ? this.workspace.root(tab.ref.root).name : '';
    this.projectLabel.textContent = tab.untitled ? 'Scratch' : project ? (project.path || rootName) : rootName;
    let state: string;
    let tone = '';
    if (this.saving.has(tab.id)) state = 'Saving…';
    else if (tab.conflict) {
      state = 'Changed elsewhere';
      tone = 'warn';
    } else if (tab.untitled) state = this.tabs.isDirty(tab) ? 'Not saved' : '';
    else if (this.tabs.isDirty(tab)) {
      state = 'Edited';
      tone = 'dirty';
    } else state = 'Saved';
    this.saveState.textContent = state;
    this.saveState.dataset.tone = tone;
    document.title = `${basename(tab.ref.path)} - ZiniaPython`;
  }

  private renderBanner(): void {
    const tab = this.tabs.active;
    clear(this.banner);
    if (!tab?.conflict) {
      this.banner.classList.add('hidden');
      return;
    }
    this.banner.classList.remove('hidden');
    this.banner.append(
      icon('warning', 16),
      h('span', null, `${basename(tab.ref.path)} was changed outside ZiniaPython while you had unsaved edits.`),
      h('button', { class: 'btn btn-small', onClick: () => void this.reloadFromDisk(tab) }, 'Use the file on disk'),
      h('button', { class: 'btn btn-small btn-primary', onClick: () => void this.keepMine(tab) }, 'Keep my version'),
    );
  }

  private onEditorChange(tabId: string, text: string): void {
    this.tabs.updateText(tabId, text);
    this.updateTitle();
    this.explorer.highlightActive();
    const tab = this.tabs.byId(tabId);
    if (!tab) return;
    if (this.settings.current.keepDrafts) {
      this.draftQueue.add(tabId);
      this.persistDraft();
    }
    if (this.settings.current.autoSave === 'after-delay' && !tab.untitled && !tab.conflict) {
      this.autoSaveQueue.add(tabId);
      this.autoSave();
    }
    this.projectModuleCache.clear();
  }

  private currentProjectModules(): string[] {
    const tab = this.tabs.active;
    if (!tab || tab.untitled) return [];
    const project = projectOf(tab.ref);
    const folder = project ? project.path : dirname(tab.ref.path);
    const key = `${tab.ref.root}::${folder}`;
    const cached = this.projectModuleCache.get(key);
    if (cached) return cached;
    this.projectModuleCache.set(key, []);
    void this.workspace.pythonModules(tab.ref.root, folder).then((mods) => this.projectModuleCache.set(key, mods));
    return [];
  }

  async openFile(ref: FileRef, line?: number): Promise<void> {
    const existing = this.tabs.find(ref);
    if (existing) {
      this.activateTab(existing.id);
    } else {
      let provider;
      try {
        provider = this.workspace.provider(ref.root);
      } catch (error) {
        toast((error as Error).message, 'error');
        return;
      }
      const info = await provider.stat(ref.path);
      if (!info) {
        toast(`${basename(ref.path)} no longer exists`, 'error');
        await this.workspace.forgetRecent((r) => r.root === ref.root && r.path === ref.path);
        return;
      }
      if (info.type === 'directory') return;
      if (!isProbablyText(ref.path) && !(await confirmDialog('Open as text?', `${basename(ref.path)} may not be a text file. Opening it in the editor could show unreadable characters.`, 'Open'))) return;
      if (info.size > 5 * 1024 * 1024 && !(await confirmDialog('Open a large file?', `${basename(ref.path)} is ${(info.size / 1024 / 1024).toFixed(1)} MB. Editing very large files can be slow.`, 'Open'))) return;
      try {
        const { text, mtime } = await provider.read(ref.path);
        const current = this.tabs.active;
        if (current) current.cursor = this.editor.cursorOf(current.id);
        this.tabs.open(ref, text, mtime);
      } catch (error) {
        toast((error as Error).message, 'error', 4000);
        return;
      }
    }
    void this.workspace.touchRecent(ref);
    if (!this.wide) this.closeDrawer();
    if (this.page !== 'none') this.showPage('none');
    if (line) requestAnimationFrame(() => this.editor.goTo(line, 1, false));
  }

  private newScratch(): void {
    this.tabs.newUntitled('');
    requestAnimationFrame(() => this.editor.focus());
  }

  private async closeTab(id: string): Promise<boolean> {
    const tab = this.tabs.byId(id);
    if (!tab) return true;
    if (this.tabs.isDirty(tab)) {
      const choice = await choiceDialog(
        `Save changes to ${basename(tab.ref.path)}?`,
        'Your changes are lost if you close without saving.',
        [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Don’t save', value: 'discard', kind: 'danger' },
          { label: 'Save', value: 'save', kind: 'primary' },
        ],
        'cancel',
      );
      if (choice === 'cancel') return false;
      if (choice === 'save' && !(await this.saveTab(tab))) return false;
    }
    await this.deleteDraft(tab);
    this.editor.dispose(tab.id);
    this.tabs.close(tab.id);
    return true;
  }

  // ---------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------

  private async autoSaveTab(tabId: string): Promise<void> {
    const tab = this.tabs.byId(tabId);
    if (!tab || tab.untitled || tab.conflict || !this.tabs.isDirty(tab)) return;
    await this.saveTab(tab, { quiet: true });
  }

  /** Saves every dirty tab of the project the run belongs to. */
  private async saveProjectFiles(tab: TabState, project: ProjectRef | null): Promise<boolean> {
    this.autoSave.cancel();
    this.autoSaveQueue.clear();
    const targets = this.tabs.dirtyTabs.filter((t) => {
      if (t.untitled) return false;
      if (t.id === tab.id) return true;
      const p = projectOf(t.ref);
      return !!project && !!p && projectKey(p) === projectKey(project);
    });
    for (const t of targets) {
      if (!(await this.saveTab(t, { quiet: true }))) return false;
    }
    return true;
  }

  async saveTab(tab: TabState, options: { saveAs?: boolean; quiet?: boolean } = {}): Promise<boolean> {
    if (tab.untitled || options.saveAs) return this.saveAs(tab);
    const text = this.editor.getText(tab.id) ?? tab.text;
    this.saving.add(tab.id);
    this.updateTitle();
    try {
      const provider = this.workspace.provider(tab.ref.root);
      let result;
      try {
        result = await provider.write(tab.ref.path, text, { expectedMtime: tab.mtime });
      } catch (error) {
        if ((error as { code?: string }).code !== 'CONFLICT') throw error;
        tab.conflict = true;
        this.renderBanner();
        const overwrite = await confirmDialog(
          `${basename(tab.ref.path)} changed elsewhere`,
          'Another app changed this file since you opened it. Saving replaces their version with yours.',
          'Replace with mine',
          true,
        );
        if (!overwrite) return false;
        result = await provider.write(tab.ref.path, text);
      }
      this.tabs.markSaved(tab.id, text, result.mtime);
      await this.deleteDraft(tab);
      if (!options.quiet) toast(`Saved ${basename(tab.ref.path)}`, 'success', 1500);
      return true;
    } catch (error) {
      toast((error as Error).message, 'error', 5000);
      this.diagnostics.record('warn', 'file.save-failed', { code: (error as { code?: string }).code ?? 'IO_ERROR' });
      return false;
    } finally {
      this.saving.delete(tab.id);
      this.updateTitle();
      this.renderBanner();
    }
  }

  private async saveAs(tab: TabState): Promise<boolean> {
    const active = this.tabs.active;
    const project = active && !active.untitled ? projectOf(active.ref) : null;
    const suggestedFolder = tab.untitled ? (project?.root === 'workspace' ? project.path : '') : dirname(tab.ref.path);
    const suggested = join(suggestedFolder, tab.untitled ? basename(tab.ref.path).replace(/^untitled-/, 'script-') : basename(tab.ref.path));
    const rootId = tab.untitled ? 'workspace' : tab.ref.root;
    const answer = await promptDialog('Save as', {
      value: suggested,
      message: rootId === 'workspace' ? 'Path inside the workspace, for example MyProject/tool.py' : `Path inside ${this.workspace.root(rootId).name}`,
      confirmLabel: 'Save',
      select: 'stem',
      validate: (v) => {
        try {
          const p = normalize(v);
          if (!p) return 'Enter a file name.';
          return validateName(basename(p));
        } catch {
          return 'The path cannot leave the folder.';
        }
      },
    });
    if (!answer) return false;
    const path = normalize(answer);
    const provider = this.workspace.provider(rootId);
    const text = this.editor.getText(tab.id) ?? tab.text;
    try {
      if (await provider.stat(path)) {
        if (!(await confirmDialog('Replace file?', `${path} already exists. Replace it?`, 'Replace', true))) return false;
      }
      const parent = dirname(path);
      if (parent && !(await provider.stat(parent))) await provider.mkdir(parent);
      const { mtime } = await provider.write(path, text);
      await this.deleteDraft(tab);
      const newRef = { root: rootId, path };
      const duplicate = this.tabs.find(newRef);
      if (duplicate && duplicate.id !== tab.id) {
        this.editor.dispose(duplicate.id);
        this.tabs.close(duplicate.id);
      }
      this.tabs.markSaved(tab.id, text, mtime, newRef);
      void this.workspace.touchRecent(newRef);
      await this.explorer.refresh();
      toast(`Saved ${path}`, 'success', 1500);
      return true;
    } catch (error) {
      toast((error as Error).message, 'error', 5000);
      return false;
    }
  }

  private async saveAll(): Promise<void> {
    for (const tab of this.tabs.dirtyTabs) {
      if (!(await this.saveTab(tab, { quiet: true }))) return;
    }
    toast('All files saved', 'success', 1500);
  }

  // --- drafts and external changes ------------------------------------

  private draftKey(tab: TabState): string {
    return DRAFT_PREFIX + (tab.untitled ? `untitled::${tab.ref.path}` : refKey(tab.ref));
  }

  private async writeDraft(tabId: string): Promise<void> {
    const tab = this.tabs.byId(tabId);
    if (!tab) return;
    if (!this.tabs.isDirty(tab)) {
      await this.deleteDraft(tab);
      return;
    }
    const draft: Draft = { text: this.editor.getText(tab.id) ?? tab.text, untitled: tab.untitled, at: Date.now() };
    await storage.set(this.draftKey(tab), draft);
  }

  private async deleteDraft(tab: TabState): Promise<void> {
    this.draftQueue.delete(tab.id);
    await storage.delete(this.draftKey(tab));
  }

  private async checkExternalChange(tab: TabState | undefined): Promise<void> {
    if (!tab || tab.untitled || !this.workspace.hasRoot(tab.ref.root)) return;
    const provider = this.workspace.provider(tab.ref.root);
    const info = await provider.stat(tab.ref.path);
    if (!info || tab.mtime === null || Math.abs(info.mtime - tab.mtime) <= 1) return;
    try {
      const { text, mtime } = await provider.read(tab.ref.path);
      const outcome = this.tabs.externalChange(tab.id, text, mtime);
      if (outcome === 'reloaded') {
        this.editor.replaceText(tab.id, text);
        this.tabs.markSaved(tab.id, text, mtime);
        toast(`Reloaded ${basename(tab.ref.path)}; it changed outside ZiniaPython`);
      }
      this.renderBanner();
      this.updateTitle();
    } catch {
      // unreadable now; leave the tab as it is
    }
  }

  private async reloadFromDisk(tab: TabState): Promise<void> {
    try {
      const { text, mtime } = await this.workspace.provider(tab.ref.root).read(tab.ref.path);
      this.editor.replaceText(tab.id, text);
      this.tabs.updateText(tab.id, text);
      this.tabs.markSaved(tab.id, text, mtime);
      await this.deleteDraft(tab);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  private async keepMine(tab: TabState): Promise<void> {
    const info = await this.workspace.provider(tab.ref.root).stat(tab.ref.path);
    tab.conflict = false;
    tab.mtime = info?.mtime ?? tab.mtime;
    await this.saveTab(tab);
  }

  // --- session --------------------------------------------------------

  private collectSession(): Session {
    const active = this.tabs.active;
    if (active) active.cursor = this.editor.cursorOf(active.id);
    return {
      ...this.session,
      tabs: this.tabs.snapshot(),
      openFolders: this.workspace.allRoots.filter((r) => r.kind === 'folder').map((r) => r.id.slice(4)),
    };
  }

  private async reopenFolders(): Promise<void> {
    for (const id of this.session.openFolders ?? []) {
      try {
        await this.workspace.openFolder(id);
      } catch (error) {
        this.consolePanel.appendNotice(`A folder you opened before could not be reopened: ${(error as Error).message}`, 'error');
      }
    }
  }

  private async restoreTabs(): Promise<void> {
    const snapshot = this.session.tabs;
    let restoredDrafts = 0;
    let activeId: string | null = null;
    for (const entry of snapshot.tabs ?? []) {
      if (!this.workspace.hasRoot(entry.ref.root)) continue;
      const provider = this.workspace.provider(entry.ref.root);
      try {
        const { text, mtime } = await provider.read(entry.ref.path);
        const tab = this.tabs.open(entry.ref, text, mtime, { activate: false });
        tab.cursor = entry.cursor;
        const draft = await storage.get<Draft>(DRAFT_PREFIX + refKey(entry.ref));
        if (draft && draft.text !== text) {
          tab.text = draft.text;
          restoredDrafts += 1;
        }
        if (refKey(entry.ref) === snapshot.activeKey) activeId = tab.id;
      } catch {
        // The file was deleted or moved outside the app; its draft remains recoverable below.
      }
    }
    for (const key of await storage.keys(DRAFT_PREFIX + 'untitled::')) {
      const draft = await storage.get<Draft>(key);
      if (draft?.text) {
        const tab = this.tabs.newUntitled(draft.text);
        restoredDrafts += 1;
        await storage.delete(key);
        if (!activeId) activeId = tab.id;
      }
    }
    if (activeId) this.tabs.activate(activeId);
    else if (this.tabs.all.length) this.tabs.activate(this.tabs.all[0].id);
    if (restoredDrafts) toast(`Restored unsaved changes in ${restoredDrafts} file${restoredDrafts === 1 ? '' : 's'}`, 'info', 4000);
  }

  private async clearCache(): Promise<void> {
    await storage.clear(DRAFT_PREFIX);
    await this.workspace.forgetRecent(() => true);
    await this.diagnostics.clear();
    this.projectModuleCache.clear();
  }

  // ---------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------

  private async newFile(rootId: string, folder: string): Promise<void> {
    const suggested = await this.workspace.uniqueChildName(rootId, folder, 'untitled.py');
    const name = await promptDialog('New file', { value: suggested, confirmLabel: 'Create', validate: validateName, select: 'stem', message: folder ? `In ${folder}` : undefined });
    if (!name) return;
    const path = join(folder, name);
    const provider = this.workspace.provider(rootId);
    try {
      if (await provider.stat(path)) {
        toast(`${name} already exists`, 'error');
        return;
      }
      await provider.write(path, isPythonFile(name) ? '' : '', { overwrite: false });
      await this.explorer.refresh();
      await this.openFile({ root: rootId, path });
      requestAnimationFrame(() => this.editor.focus());
    } catch (error) {
      toast((error as Error).message, 'error', 4000);
    }
  }

  private async newFolder(rootId: string, folder: string): Promise<void> {
    const name = await promptDialog('New folder', { value: '', placeholder: 'Folder name', confirmLabel: 'Create', validate: validateName });
    if (!name) return;
    const provider = this.workspace.provider(rootId);
    const path = join(folder, name);
    if (await provider.stat(path)) {
      toast(`${name} already exists`, 'error');
      return;
    }
    try {
      await provider.mkdir(path);
      await this.explorer.refresh();
    } catch (error) {
      toast((error as Error).message, 'error', 4000);
    }
  }

  private async newProject(): Promise<void> {
    const name = await promptDialog('New project', {
      value: await this.workspace.uniqueChildName('workspace', '', 'MyProject'),
      confirmLabel: 'Next',
      validate: validateName,
      message: 'Projects are folders in the workspace. Runs use the project folder as the working directory.',
    });
    if (!name) return;
    const template = await choiceDialog(
      'Start with',
      'The starter includes main.py, a helper module and a data file, so imports and relative paths work from the start.',
      [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Empty', value: 'empty' },
        { label: 'Starter files', value: 'starter', kind: 'primary' },
      ],
      'cancel',
    );
    if (template === 'cancel') return;
    try {
      const { entry } = await this.projects.create(name, template);
      await this.explorer.refresh();
      await this.openFile(entry);
      toast(`Created ${name}`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error', 4000);
    }
  }

  // ---------------------------------------------------------------------
  // Graphics preview
  // ---------------------------------------------------------------------

  private onGraphicsPanelChanged(): void {
    const open = this.graphics.opened;
    this.graphicsButton.classList.toggle('toggled', open);
    this.graphicsButton.setAttribute('aria-pressed', String(open));
    this.shell.classList.toggle('graphics-open', open);
    this.shell.classList.toggle('graphics-fullscreen', this.graphics.fullscreen);
  }

  /** Copy the bundled graphics examples into the workspace and open the first one. */
  private async openGraphicsExamples(): Promise<void> {
    try {
      const { project, added } = await this.projects.installBundled(GRAPHICS_EXAMPLES_PROJECT, GRAPHICS_EXAMPLES, GRAPHICS_EXAMPLES_ENTRY);
      await this.explorer.refresh();
      await this.openFile({ root: project.root, path: join(project.path, GRAPHICS_EXAMPLES_ENTRY) });
      this.openDrawer();
      const count = Object.keys(GRAPHICS_EXAMPLES).filter((name) => name.endsWith('.py')).length;
      toast(
        added > 0
          ? `${count} graphics examples are in "${GRAPHICS_EXAMPLES_PROJECT}". Open one and press Run.`
          : `The examples are in "${GRAPHICS_EXAMPLES_PROJECT}" (your edits were kept).`,
        'success',
        4000,
      );
    } catch (error) {
      toast((error as Error).message, 'error', 4000);
    }
  }

  private async renameEntry(rootId: string, entry: Entry): Promise<void> {
    const name = await promptDialog(`Rename ${entry.name}`, { value: entry.name, confirmLabel: 'Rename', validate: validateName, select: 'stem' });
    if (!name || name === entry.name) return;
    const target = join(dirname(entry.path), name);
    await this.relocate(rootId, entry, target);
  }

  private async moveEntry(rootId: string, entry: Entry): Promise<void> {
    const destination = await promptDialog(`Move ${entry.name}`, {
      value: dirname(entry.path),
      message: 'Destination folder (empty for the top level).',
      confirmLabel: 'Move',
      validate: (v) => {
        try {
          const folder = normalize(v);
          if (entry.type === 'directory' && isInside(folder, entry.path)) return 'A folder cannot be moved into itself.';
          return null;
        } catch {
          return 'The path cannot leave the folder.';
        }
      },
    });
    if (destination === null) return;
    const folder = normalize(destination);
    if (folder && (await this.workspace.provider(rootId).stat(folder))?.type !== 'directory') {
      toast(`Folder ${folder} does not exist`, 'error');
      return;
    }
    const target = join(folder, entry.name);
    if (target === entry.path) return;
    await this.relocate(rootId, entry, target);
  }

  private async relocate(rootId: string, entry: Entry, target: string): Promise<void> {
    const provider = this.workspace.provider(rootId);
    if (await provider.stat(target)) {
      toast(`${basename(target)} already exists there`, 'error');
      return;
    }
    // Save open edits first so nothing is written back to the old location later.
    for (const tab of this.tabs.under(rootId, entry.path)) {
      if (this.tabs.isDirty(tab) && !(await this.saveTab(tab, { quiet: true }))) return;
    }
    try {
      await provider.rename(entry.path, target);
    } catch (error) {
      toast((error as Error).message, 'error', 4000);
      return;
    }
    this.tabs.renamePath(rootId, entry.path, target);
    await this.workspace.forgetRecent((r) => r.root === rootId && isInside(r.path, entry.path));
    await this.explorer.refresh();
    this.updateTitle();
  }

  private async duplicateEntry(rootId: string, entry: Entry): Promise<void> {
    const provider = this.workspace.provider(rootId);
    const siblings = new Set((await provider.list(dirname(entry.path))).map((e) => e.name));
    const target = join(dirname(entry.path), copyName(entry.name, siblings));
    try {
      await provider.copy(entry.path, target);
      await this.explorer.refresh();
      toast(`Created ${basename(target)}`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error', 4000);
    }
  }

  private async deleteEntry(rootId: string, entry: Entry): Promise<void> {
    const affected = this.tabs.under(rootId, entry.path);
    const dirty = affected.filter((t) => this.tabs.isDirty(t)).length;
    const what = entry.type === 'directory' ? `the folder ${entry.name} and everything in it` : entry.name;
    const extra = dirty ? ` ${dirty} open file${dirty === 1 ? ' has' : 's have'} unsaved changes that will be lost.` : '';
    const where = rootId === 'workspace' ? 'This cannot be undone.' : 'Depending on the storage provider it may go to Recently Deleted, or be removed permanently.';
    if (!(await confirmDialog(`Delete ${entry.name}?`, `This deletes ${what}. ${where}${extra}`, 'Delete', true))) return;
    try {
      await this.workspace.provider(rootId).remove(entry.path);
    } catch (error) {
      toast((error as Error).message, 'error', 4000);
      return;
    }
    for (const tab of affected) {
      await this.deleteDraft(tab);
      this.editor.dispose(tab.id);
      this.tabs.close(tab.id);
    }
    await this.workspace.forgetRecent((r) => r.root === rootId && isInside(r.path, entry.path));
    await this.explorer.refresh();
    toast(`Deleted ${entry.name}`, 'success');
  }

  private async exportEntry(rootId: string, entry: Entry): Promise<void> {
    const tab = this.tabs.find({ root: rootId, path: entry.path });
    if (tab && this.tabs.isDirty(tab)) {
      const save = await confirmDialog('Save before exporting?', `${entry.name} has unsaved changes. Export exports the saved file.`, 'Save and export');
      if (!save || !(await this.saveTab(tab, { quiet: true }))) return;
    }
    if (this.isNative) {
      try {
        const result = await ZiniaFiles.exportFile({ root: rootId, path: entry.path });
        if (result.exported) toast(`Exported ${entry.name}`, 'success');
      } catch (error) {
        toast((error as Error).message, 'error', 4000);
      }
      return;
    }
    const { text } = await this.workspace.provider(rootId).read(entry.path);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = h('a', { href: url, download: entry.name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async importFiles(rootId: string, folder: string): Promise<void> {
    if (this.isNative && rootId === 'workspace') {
      try {
        const result = await ZiniaFiles.importFiles({ destination: folder });
        if (result.cancelled) return;
        await this.explorer.refresh();
        const failed = result.failed?.length ? `, ${result.failed.length} failed` : '';
        toast(`Imported ${result.imported.length} file${result.imported.length === 1 ? '' : 's'}${failed}`, result.failed?.length ? 'error' : 'success');
        if (result.imported.length === 1) await this.openFile({ root: 'workspace', path: result.imported[0].path });
      } catch (error) {
        toast((error as Error).message, 'error', 4000);
      }
      return;
    }
    const input = h('input', { type: 'file', multiple: true });
    input.addEventListener('change', async () => {
      const provider = this.workspace.provider(rootId);
      let count = 0;
      for (const file of Array.from(input.files ?? [])) {
        const name = await this.workspace.uniqueChildName(rootId, folder, file.name);
        await provider.write(join(folder, name), await file.text(), { overwrite: false });
        count += 1;
      }
      await this.explorer.refresh();
      toast(`Imported ${count} file${count === 1 ? '' : 's'}`, 'success');
    });
    input.click();
  }

  private async openExternalFolder(): Promise<void> {
    if (!this.isNative) {
      await alertDialog('Open a folder', 'Opening folders from iCloud Drive or other locations uses Apple’s document picker and is available in the iOS app.');
      return;
    }
    try {
      const root = await this.workspace.pickFolder();
      if (root) {
        this.saveSession();
        toast(`Opened ${root.name}`, 'success');
      }
    } catch (error) {
      toast((error as Error).message, 'error', 5000);
    }
  }

  private async closeExternalFolder(rootId: string): Promise<void> {
    for (const tab of [...this.tabs.all].filter((t) => t.ref.root === rootId)) {
      if (!(await this.closeTab(tab.id))) return;
    }
    await this.workspace.closeFolder(rootId);
    this.saveSession();
  }

  private async setEntryPoint(ref: FileRef): Promise<void> {
    const project = projectOf(ref);
    if (!project) {
      toast('Only files inside a project can be its entry point');
      return;
    }
    const config = await this.projects.loadConfig(project);
    config.entry = project.path ? ref.path.slice(project.path.length + 1) : ref.path;
    try {
      await this.projects.saveConfig(project, config);
      toast(`${basename(ref.path)} is now the entry point of ${config.name}`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  // ---------------------------------------------------------------------
  // Traceback navigation
  // ---------------------------------------------------------------------

  private refMatchesFilename(tab: TabState, filename: string): boolean {
    if (tab.untitled) return filename === `<${basename(tab.ref.path)}>`;
    const ref = this.workspace.refFromAbsolute(filename);
    return !!ref && ref.root === tab.ref.root && ref.path === tab.ref.path;
  }

  private canNavigate(filename: string): boolean {
    if (filename.startsWith('<')) return this.tabs.all.some((t) => t.untitled && filename === `<${basename(t.ref.path)}>`);
    return this.workspace.refFromAbsolute(filename) !== null;
  }

  private async navigateTo(filename: string, line: number, column: number): Promise<void> {
    if (filename.startsWith('<')) {
      const tab = this.tabs.all.find((t) => t.untitled && filename === `<${basename(t.ref.path)}>`);
      if (tab) {
        this.activateTab(tab.id);
        requestAnimationFrame(() => this.editor.goTo(line, column, true));
      }
      return;
    }
    const ref = this.workspace.refFromAbsolute(filename);
    if (!ref) return;
    await this.openFile(ref);
    if (!this.wide && this.session.consoleState === 'expanded') this.setConsoleState('normal');
    requestAnimationFrame(() => this.editor.goTo(line, column, true));
  }

  // ---------------------------------------------------------------------
  // Menus, keyboard and platform events
  // ---------------------------------------------------------------------

  private showMainMenu(anchor: HTMLElement): void {
    const tab = this.tabs.active;
    const project = tab && !tab.untitled ? projectOf(tab.ref) : null;
    showMenu(anchor, [
      { label: 'Save', icon: 'save', disabled: !tab, action: () => void (tab && this.saveTab(tab)) },
      { label: 'Save as…', icon: 'save', disabled: !tab, action: () => void (tab && this.saveTab(tab, { saveAs: true })) },
      { label: 'Save all', icon: 'save', disabled: this.tabs.dirtyTabs.length === 0, action: () => void this.saveAll() },
      'separator',
      { label: 'Run project entry point', icon: 'play', disabled: !project, action: () => void this.runProjectEntry() },
      { label: 'Find and replace', icon: 'replace', disabled: !tab, action: () => this.editor.openSearch() },
      { label: 'Undo', icon: 'undo', disabled: !tab, action: () => this.editor.undo() },
      { label: 'Redo', icon: 'redo', disabled: !tab, action: () => this.editor.redo() },
      { label: 'Select all', icon: 'tree', disabled: !tab, action: () => this.editor.selectAll() },
      { label: 'Copy selection', icon: 'copy', disabled: !tab, action: () => void this.copySelection() },
      { label: 'Paste', icon: 'paste', disabled: !tab, action: () => void this.paste() },
      'separator',
      { label: 'Open REPL', icon: 'terminal', action: () => { this.ensureConsoleVisible(); this.consolePanel.focusRepl(); } },
      { label: 'New scratch file', icon: 'newFile', action: () => this.newScratch() },
      { label: this.graphics.opened ? 'Hide graphics preview' : 'Show graphics preview', icon: 'shapes', action: () => this.graphics.toggle() },
      { label: 'Graphics examples', icon: 'cube', action: () => void this.openGraphicsExamples() },
      { label: 'Close file', icon: 'close', disabled: !tab, action: () => void (tab && this.closeTab(tab.id)) },
    ]);
  }

  private async copySelection(): Promise<void> {
    const text = this.editor.selectedText();
    if (!text) {
      toast('Select some text first');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success', 1200);
    } catch {
      toast('Copying is not allowed here', 'error');
    }
  }

  private async paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.editor.insert(text);
    } catch {
      toast('Paste was not allowed. Use the system paste menu instead.', 'error', 3500);
    }
  }

  private onGlobalKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      const tab = this.tabs.active;
      if (tab) void this.saveTab(tab, { saveAs: e.shiftKey });
    } else if (key === 'r' || (key === 'enter' && !e.shiftKey)) {
      e.preventDefault();
      void this.runActive();
    } else if (key === '.') {
      e.preventDefault();
      void this.stop();
    } else if (key === 'w' && this.tabs.active) {
      e.preventDefault();
      void this.closeTab(this.tabs.active.id);
    } else if (key === 'n' && e.altKey) {
      e.preventDefault();
      this.newScratch();
    } else if (key === 'j') {
      e.preventDefault();
      this.cycleConsole();
    }
  }

  private hideKeyboard(): void {
    if (this.isNative) void Keyboard.hide().catch(() => undefined);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  private setKeyboardOpen(open: boolean): void {
    if (this.keyboardOpen === open) return;
    this.keyboardOpen = open;
    this.applyShellClasses();
  }

  private attachPlatformListeners(): void {
    this.editor.view.contentDOM.addEventListener('focus', () => this.applyShellClasses());
    this.editor.view.contentDOM.addEventListener('blur', () => setTimeout(() => this.applyShellClasses(), 50));
    if (this.isNative) {
      void Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);
      void Keyboard.addListener('keyboardWillShow', () => this.setKeyboardOpen(true));
      void Keyboard.addListener('keyboardWillHide', () => this.setKeyboardOpen(false));
      void CapApp.addListener('pause', () => this.flushPending());
      void CapApp.addListener('resume', () => {
        void this.explorer.refresh();
        for (const tab of this.tabs.all) void this.checkExternalChange(tab);
        void this.python.refreshInfo();
      });
    } else if (window.visualViewport) {
      const viewport = window.visualViewport;
      viewport.addEventListener('resize', () => this.setKeyboardOpen(window.innerHeight - viewport.height > 150));
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.flushPending();
        else for (const tab of this.tabs.all) void this.checkExternalChange(tab);
      });
    }
    window.addEventListener('beforeunload', (e) => {
      this.flushPending();
      if (!this.isNative && this.tabs.dirtyTabs.length && !this.settings.current.keepDrafts) e.preventDefault();
    });
  }

  private flushPending(): void {
    this.autoSave.flush();
    this.persistDraft.flush();
    this.saveSession.flush();
  }
}
