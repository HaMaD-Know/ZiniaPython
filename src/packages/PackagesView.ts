import { h, clear } from '../components/dom';
import { icon } from '../components/icons';
import { confirmDialog, toast } from '../components/overlays';
import { ZiniaPython } from '../plugins/zinia-python';
import type { PythonService } from '../services/python';
import { toRuntimeError } from '../services/python';
import type { InstalledPackage, PackageAnalysis, PackageProgress, PackageVerdict } from '../types/python';

const VERDICT_TEXT: Record<PackageVerdict, { label: string; tone: 'ok' | 'warn' | 'error' }> = {
  installable: { label: 'Can be installed', tone: 'ok' },
  'native-ios-wheel': { label: 'Needs a build-time install', tone: 'warn' },
  'native-only': { label: 'Not installable on iOS', tone: 'error' },
  'sdist-only': { label: 'Not installable on iOS', tone: 'error' },
  'python-mismatch': { label: 'Python version mismatch', tone: 'error' },
  'no-files': { label: 'Nothing to install', tone: 'error' },
  'not-found': { label: 'Not found', tone: 'error' },
};

/**
 * Package manager. Analysis and installation run inside the embedded Python
 * (python/zinia/packages.py); this view only presents the results.
 */
export class PackagesView {
  readonly el: HTMLElement;
  private nameInput: HTMLInputElement;
  private versionInput: HTMLInputElement;
  private analysisBox: HTMLElement;
  private progressBox: HTMLElement;
  private installedBox: HTMLElement;
  private busy = false;

  constructor(private python: PythonService, onClose: () => void) {
    this.nameInput = h('input', {
      class: 'text-input',
      placeholder: 'Package name, for example rich',
      attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Package name' },
    });
    this.versionInput = h('input', {
      class: 'text-input version-input',
      placeholder: 'Version (optional)',
      attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Version' },
    });
    this.nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && void this.analyze());
    this.analysisBox = h('div', { class: 'pkg-analysis' });
    this.progressBox = h('div', { class: 'pkg-progress hidden', attrs: { 'aria-live': 'polite' } });
    this.installedBox = h('div', { class: 'pkg-installed' });

    this.el = h(
      'div',
      { class: 'page packages-page' },
      h('header', { class: 'page-header' },
        h('h1', null, 'Packages'),
        h('button', { class: 'icon-btn', title: 'Close packages', attrs: { 'aria-label': 'Close packages' }, onClick: () => onClose() }, icon('close', 20)),
      ),
      h('div', { class: 'page-body' },
        h('p', { class: 'lede' },
          'Pure-Python packages from PyPI can be installed on this device. Packages that contain compiled code cannot: iOS only runs native code that was signed into the app when it was built.'),
        h('p', { class: 'notice' }, icon('cloud', 15), h('span', null, 'Checking and installing contacts pypi.org. Editing and running code never needs the network.')),
        h('div', { class: 'pkg-search' },
          this.nameInput,
          this.versionInput,
          h('button', { class: 'btn btn-primary', onClick: () => void this.analyze() }, 'Check'),
        ),
        this.analysisBox,
        this.progressBox,
        h('h2', { class: 'section-title' }, 'Installed'),
        this.installedBox,
        h('details', { class: 'explainer' },
          h('summary', null, 'Why can’t numpy or pandas be installed here?'),
          h('p', null,
            'Packages such as numpy, pandas, Pillow or cryptography include machine code compiled for a specific platform. ' +
            'Running them on iOS requires an iOS build of the package, converted into a signed framework when the app itself is built. ' +
            'See docs/PACKAGES.md (“Native packages”) for how to add such a package to your own build.'),
        ),
      ),
    );
    void ZiniaPython.addListener('packageProgress', (p) => this.onProgress(p)).catch(() => undefined);
  }

  async refresh(): Promise<void> {
    clear(this.installedBox);
    if (!this.python.canRun && this.python.machine.current.fatal) {
      this.installedBox.appendChild(h('p', { class: 'muted' }, this.python.startError?.message ?? 'The Python runtime is not available.'));
      return;
    }
    try {
      const { packages, siteDir } = await this.python.runTask('Listing packages', () => ZiniaPython.listPackages());
      if (packages.length === 0) {
        this.installedBox.appendChild(h('p', { class: 'muted' }, 'No packages installed yet. The standard library is always available.'));
      }
      for (const pkg of packages) this.installedBox.appendChild(this.renderInstalled(pkg));
      if (siteDir) this.installedBox.appendChild(h('p', { class: 'path-note' }, `Location: ${siteDir}`));
    } catch (error) {
      this.installedBox.appendChild(h('p', { class: 'error-text' }, toRuntimeError(error).message));
    }
  }

  private renderInstalled(pkg: InstalledPackage): HTMLElement {
    return h(
      'div',
      { class: 'pkg-row' },
      h('div', { class: 'pkg-row-main' },
        h('span', { class: 'pkg-name' }, pkg.name),
        h('span', { class: 'pkg-version' }, pkg.version),
        pkg.source === 'bundled' ? h('span', { class: 'badge' }, 'built in') : null,
        !pkg.requested && pkg.source === 'user' ? h('span', { class: 'badge subtle' }, 'dependency') : null,
      ),
      pkg.summary ? h('p', { class: 'pkg-summary' }, pkg.summary) : null,
      pkg.source === 'user'
        ? h('button', { class: 'btn btn-small btn-danger-quiet', onClick: () => void this.uninstall(pkg.name) }, 'Uninstall')
        : null,
    );
  }

  private async analyze(): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!name || this.busy) return;
    const version = this.versionInput.value.trim() || undefined;
    this.busy = true;
    clear(this.analysisBox);
    this.analysisBox.appendChild(h('p', { class: 'muted' }, icon('spinner', 14, 'spin'), ` Checking ${name} on PyPI…`));
    try {
      const analysis = await this.python.runTask(`Checking ${name}`, () => ZiniaPython.analyzePackage({ name, version }));
      this.renderAnalysis(analysis);
    } catch (error) {
      const err = toRuntimeError(error);
      clear(this.analysisBox);
      this.analysisBox.appendChild(h('div', { class: 'pkg-card tone-error' }, h('strong', null, err.code === 'not-found' ? 'Not found' : 'Check failed'), h('p', null, err.message)));
    } finally {
      this.busy = false;
    }
  }

  private renderAnalysis(a: PackageAnalysis): void {
    clear(this.analysisBox);
    const verdict = VERDICT_TEXT[a.verdict] ?? { label: a.verdict, tone: 'warn' as const };
    const deps = a.dependencies.filter((d) => d.applies);
    const card = h(
      'div',
      { class: `pkg-card tone-${verdict.tone}` },
      h('div', { class: 'pkg-card-head' },
        h('span', { class: 'pkg-name' }, a.name),
        h('span', { class: 'pkg-version' }, a.version),
        h('span', { class: `verdict tone-${verdict.tone}` }, verdict.label),
      ),
      a.summary ? h('p', { class: 'pkg-summary' }, a.summary) : null,
      h('p', null, a.reason),
      h('dl', { class: 'facts' },
        a.requiresPython ? [h('dt', null, 'Requires Python'), h('dd', null, a.requiresPython)] : null,
        a.platformFamilies.length ? [h('dt', null, 'Compiled for'), h('dd', null, a.platformFamilies.join(', '))] : null,
        a.selectedWheel ? [h('dt', null, 'File'), h('dd', { class: 'mono' }, a.selectedWheel)] : null,
        deps.length ? [h('dt', null, 'Dependencies'), h('dd', null, deps.map((d) => d.requirement).join(', '))] : null,
        a.license ? [h('dt', null, 'License'), h('dd', null, a.license)] : null,
        a.installedVersion ? [h('dt', null, 'Installed'), h('dd', null, a.installedVersion)] : null,
      ),
    );
    if (a.verdict === 'installable') {
      const label = a.installedVersion === a.version ? 'Reinstall' : a.installedVersion ? `Update to ${a.version}` : `Install ${a.name} ${a.version}`;
      card.appendChild(h('button', { class: 'btn btn-primary', onClick: () => void this.install(a.name, this.versionInput.value.trim() || undefined) }, label));
      if (deps.length) card.appendChild(h('p', { class: 'muted small' }, 'Dependencies are installed too when they are pure Python.'));
    }
    this.analysisBox.appendChild(card);
  }

  private onProgress(p: PackageProgress): void {
    this.progressBox.classList.remove('hidden');
    this.progressBox.appendChild(h('div', { class: `progress-line stage-${p.stage}` }, p.message));
    while (this.progressBox.childElementCount > 12) this.progressBox.firstElementChild?.remove();
  }

  private async install(name: string, version?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    clear(this.progressBox);
    this.progressBox.classList.remove('hidden');
    try {
      const result = await this.python.runTask(`Installing ${name}`, () => ZiniaPython.installPackage({ name, version }));
      toast(`Installed ${result.installed.map((i) => `${i.name} ${i.version}`).join(', ')}`, 'success', 4000);
      this.analysisBox.querySelector('.pkg-card .btn-primary')?.remove();
    } catch (error) {
      const err = toRuntimeError(error);
      this.progressBox.appendChild(h('div', { class: 'progress-line error-text' }, `Not installed: ${err.message}`));
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private async uninstall(name: string): Promise<void> {
    if (!(await confirmDialog(`Uninstall ${name}?`, 'Its files are removed from this device. Scripts that import it will fail until it is installed again.', 'Uninstall', true))) return;
    try {
      await this.python.runTask(`Uninstalling ${name}`, () => ZiniaPython.uninstallPackage({ name }));
      toast(`Uninstalled ${name}`, 'success');
    } catch (error) {
      toast(toRuntimeError(error).message, 'error', 5000);
    }
    await this.refresh();
  }
}
