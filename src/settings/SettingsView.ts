import { h, clear, formatDuration } from '../components/dom';
import { icon } from '../components/icons';
import { alertDialog, confirmDialog, toast } from '../components/overlays';
import { ZiniaPython } from '../plugins/zinia-python';
import type { DiagnosticsLog } from '../services/diagnostics';
import { toRuntimeError, type PythonService } from '../services/python';
import type { Settings, SettingsStore } from '../services/settings';
import type { SelfTestReport } from '../types/python';

export interface SettingsActions {
  clearCache(): Promise<void>;
  workspacePath(): string | null;
}

const LICENSES: [string, string][] = [
  ['CPython 3.14', 'Python Software Foundation License Version 2'],
  ['Python-Apple-support (BeeWare)', 'BSD 3-Clause; bundles OpenSSL (Apache 2.0), libFFI (MIT), XZ (0BSD), bzip2, mpdecimal, zstd (BSD)'],
  ['Capacitor and official plugins', 'MIT'],
  ['CodeMirror 6', 'MIT'],
  ['Lucide icons', 'ISC'],
  ['packaging (vendored)', 'Apache 2.0 or BSD 2-Clause'],
  ['ZiniaPython IDE', 'MIT'],
];

/**
 * Preferences, runtime information, the self-test, and maintenance actions.
 */
export class SettingsView {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private reportBox: HTMLElement;

  constructor(
    private settings: SettingsStore,
    private python: PythonService,
    private diagnostics: DiagnosticsLog,
    private actions: SettingsActions,
    onClose: () => void,
  ) {
    this.body = h('div', { class: 'page-body' });
    this.reportBox = h('div', { class: 'selftest-report' });
    this.el = h(
      'div',
      { class: 'page settings-page' },
      h('header', { class: 'page-header' },
        h('h1', null, 'Settings'),
        h('button', { class: 'icon-btn', title: 'Close settings', attrs: { 'aria-label': 'Close settings' }, onClick: () => onClose() }, icon('close', 20)),
      ),
      this.body,
    );
    settings.subscribe(() => this.render());
  }

  render(): void {
    const s = this.settings.current;
    const set = (patch: Partial<Settings>) => void this.settings.update(patch);
    clear(this.body);
    this.body.append(
      section('Appearance',
        row('Theme', segmented(['dark', 'light', 'system'], ['Dark', 'Light', 'System'], s.theme, (v) => set({ theme: v as Settings['theme'] }))),
        row('Editor text size', stepper(s.editorFontSize, 10, 28, (v) => set({ editorFontSize: v }), 'px')),
        row('Console text size', stepper(s.consoleFontSize, 9, 24, (v) => set({ consoleFontSize: v }), 'px')),
      ),
      section('Editor',
        row('Tab width', segmented(['2', '4', '8'], ['2', '4', '8'], String(s.tabWidth), (v) => set({ tabWidth: Number(v) as Settings['tabWidth'] }))),
        row('Wrap long lines', toggle(s.wordWrap, (v) => set({ wordWrap: v }))),
        row('Line numbers', toggle(s.lineNumbers, (v) => set({ lineNumbers: v }))),
        row('Suggestions while typing', toggle(s.autocomplete, (v) => set({ autocomplete: v })), 'Keywords, built-ins, standard-library modules and names from your files. Everything stays on the device.'),
        row('Coding keys above the keyboard', toggle(s.showKeyBar, (v) => set({ showKeyBar: v }))),
      ),
      section('Files',
        row('Auto-save', segmented(['after-delay', 'off'], ['After edits', 'Off'], s.autoSave, (v) => set({ autoSave: v as Settings['autoSave'] }))),
        row('Save before running', toggle(s.saveBeforeRun, (v) => set({ saveBeforeRun: v })), 'Saves every changed file in the project, so imports see your latest edits.'),
        row('Keep unsaved changes', toggle(s.keepDrafts, (v) => set({ keepDrafts: v })), 'Stores unsaved buffers on this device so they survive closing the app.'),
        row('Entry point for new projects', textField(s.defaultEntryPoint, (v) => set({ defaultEntryPoint: v }), /^[\w.-]+\.py$/)),
        row('Workspace', h('span', { class: 'value-text mono' }, this.actions.workspacePath() ?? 'App documents')),
      ),
      section('Running',
        row('Working directory', segmented(['project', 'file'], ['Project folder', 'File’s folder'], s.workingDirectory, (v) => set({ workingDirectory: v as Settings['workingDirectory'] })), 'Relative paths such as open("data.json") resolve against this folder.'),
        row('Stop scripts after', segmented(['0', '30', '120', '600'], ['Never', '30 s', '2 min', '10 min'], String(s.runTimeoutSeconds), (v) => set({ runTimeoutSeconds: Number(v) }))),
        row('Follow new output', toggle(s.autoScroll, (v) => set({ autoScroll: v }))),
      ),
      this.runtimeSection(),
      section('Privacy and storage',
        row('Local diagnostics log', toggle(s.diagnosticsLog, (v) => set({ diagnosticsLog: v })), 'Start-up results, run status and timings. Never your code or output. Never sent anywhere.'),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn', onClick: () => void alertDialog('Diagnostics log', h('pre', { class: 'log-view' }, this.diagnostics.format() || 'The log is empty.')) }, 'View log'),
          h('button', { class: 'btn', onClick: () => void this.copyLog() }, 'Copy log'),
          h('button', { class: 'btn', onClick: () => void this.clearCache() }, 'Clear cache'),
          h('button', { class: 'btn btn-danger-quiet', onClick: () => void this.resetPreferences() }, 'Reset preferences'),
        ),
      ),
      section('About',
        h('p', null, 'ZiniaPython IDE 1.0.0. Python runs in an embedded CPython interpreter inside this app, offline. It is not a security sandbox: a script can read and change any file this app can reach, including your projects.'),
        h('dl', { class: 'facts licenses' }, LICENSES.map(([name, license]) => [h('dt', null, name), h('dd', null, license)])),
        h('p', { class: 'muted small' }, 'Full license texts: LICENSES.md in the source repository.'),
      ),
    );
  }

  private runtimeSection(): HTMLElement {
    const info = this.python.info;
    const state = this.python.machine.current;
    const rows: HTMLElement[] = [];
    if (info) {
      rows.push(
        row('Python', h('span', { class: 'value-text' }, `${info.implementation} ${info.pythonVersion}${info.devBridge ? ' (desktop dev bridge)' : ''}`)),
        row('Platform', h('span', { class: 'value-text' }, [info.platform, info.ios ? `iOS ${info.ios.release}` : info.systemVersion ? `${info.systemName} ${info.systemVersion}` : '', info.machine].filter(Boolean).join(', '))),
        row('Start-up time', h('span', { class: 'value-text' }, info.startupMs ? formatDuration(info.startupMs) : 'n/a')),
        row('Standard library', h('span', { class: 'value-text mono' }, info.stdlib)),
        row('Installed packages', h('span', { class: 'value-text mono' }, info.sitePackages ?? 'n/a')),
      );
      if (info.availableMemoryBytes) {
        rows.push(row('Memory available to the app', h('span', { class: 'value-text' }, `${Math.round(info.availableMemoryBytes / 1024 / 1024)} MB`)));
      }
    } else {
      rows.push(h('p', { class: state.fatal ? 'error-text' : 'muted' }, this.python.startError?.message ?? 'The runtime has not started yet.'));
    }
    return section('Python runtime',
      ...rows,
      h('div', { class: 'button-row' },
        h('button', { class: 'btn btn-primary', disabled: !this.python.canRun, onClick: () => void this.runSelfTest() }, 'Run self-test'),
        h('button', { class: 'btn', disabled: !this.python.canRun, onClick: () => void this.resetInterpreter() }, 'Reset interpreter state'),
      ),
      h('p', { class: 'muted small' }, 'The self-test imports standard-library modules and executes test scripts in the embedded interpreter. Reset clears REPL variables and imported project modules; a full restart requires relaunching the app.'),
      this.reportBox,
    );
  }

  private async runSelfTest(): Promise<void> {
    clear(this.reportBox);
    this.reportBox.appendChild(h('p', { class: 'muted' }, icon('spinner', 14, 'spin'), ' Running self-test…'));
    try {
      const report = await this.python.runTask('Self-test', () => ZiniaPython.runSelfTest({ modules: true }));
      this.renderReport(report);
    } catch (error) {
      clear(this.reportBox);
      this.reportBox.appendChild(h('p', { class: 'error-text' }, toRuntimeError(error).message));
    }
  }

  private renderReport(report: SelfTestReport): void {
    clear(this.reportBox);
    const s = report.summary;
    this.reportBox.append(
      h('p', { class: `report-summary tone-${s.ok ? 'ok' : 'error'}` },
        icon(s.ok ? 'ok' : 'alert', 16),
        ` ${s.casesPassed}/${report.cases.length} checks passed, ${s.modulesAvailable}/${s.modulesChecked} modules importable (${s.seconds} s).`),
      h('ul', { class: 'report-list' },
        report.cases.map((c) => h('li', { class: c.passed ? 'pass' : c.skipped ? 'skip' : 'fail' }, icon(c.passed ? 'check' : c.skipped ? 'info' : 'close', 14), ` ${c.title}`))),
      h('details', null,
        h('summary', null, 'Module availability'),
        h('table', { class: 'module-table' },
          h('tbody', null, report.modules.map((m) =>
            h('tr', { class: m.available ? 'pass' : 'fail' },
              h('td', { class: 'mono' }, m.module),
              h('td', null, m.available ? (m.note ? `Available. ${m.note}` : 'Available') : `${m.help?.explanation ?? m.error ?? 'Unavailable'}`),
            ))),
        ),
      ),
    );
  }

  private async resetInterpreter(): Promise<void> {
    if (!(await confirmDialog('Reset interpreter state?', 'REPL variables are cleared and your project modules will be imported fresh. Files and editor tabs are not affected.', 'Reset'))) return;
    try {
      await this.python.resetInterpreter();
      toast('Interpreter state reset', 'success');
    } catch (error) {
      toast(toRuntimeError(error).message, 'error');
    }
  }

  private async copyLog(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.diagnostics.format());
      toast('Diagnostics log copied', 'success');
    } catch {
      toast('Copying is not allowed here', 'error');
    }
  }

  private async clearCache(): Promise<void> {
    if (!(await confirmDialog('Clear cache?', 'Removes recent-file history, saved drafts of unsaved changes, and the diagnostics log. Your files, projects, packages and preferences are kept.', 'Clear cache', true))) return;
    await this.actions.clearCache();
    toast('Cache cleared', 'success');
  }

  private async resetPreferences(): Promise<void> {
    if (!(await confirmDialog('Reset preferences?', 'Theme, editor and console settings return to their defaults. Files are not affected.', 'Reset', true))) return;
    await this.settings.reset();
    toast('Preferences reset', 'success');
  }
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h('section', { class: 'settings-section' }, h('h2', { class: 'section-title' }, title), ...children);
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('div', { class: 'settings-row' },
    h('div', { class: 'settings-label' }, h('span', null, label), hint ? h('small', null, hint) : null),
    h('div', { class: 'settings-control' }, control),
  );
}

function toggle(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: value, class: 'switch', attrs: { role: 'switch' } });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function segmented(values: string[], labels: string[], current: string, onChange: (v: string) => void): HTMLElement {
  return h('div', { class: 'segmented', attrs: { role: 'radiogroup' } },
    values.map((v, i) => h('button', {
      class: `seg${v === current ? ' active' : ''}`,
      attrs: { role: 'radio', 'aria-checked': String(v === current) },
      onClick: () => onChange(v),
    }, labels[i])));
}

function stepper(value: number, min: number, max: number, onChange: (v: number) => void, unit: string): HTMLElement {
  return h('div', { class: 'stepper' },
    h('button', { class: 'icon-btn', disabled: value <= min, attrs: { 'aria-label': 'Smaller' }, onClick: () => onChange(value - 1) }, '−'),
    h('span', { class: 'stepper-value' }, `${value} ${unit}`),
    h('button', { class: 'icon-btn', disabled: value >= max, attrs: { 'aria-label': 'Larger' }, onClick: () => onChange(value + 1) }, '+'),
  );
}

function textField(value: string, onChange: (v: string) => void, pattern: RegExp): HTMLElement {
  const input = h('input', { class: 'text-input small', value, attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' } });
  input.addEventListener('change', () => {
    if (pattern.test(input.value.trim())) onChange(input.value.trim());
    else {
      toast('Use a file name ending in .py', 'error');
      input.value = value;
    }
  });
  return input;
}
