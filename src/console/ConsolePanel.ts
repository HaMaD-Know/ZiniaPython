import { h, clear, formatDuration } from '../components/dom';
import { icon } from '../components/icons';
import { toast } from '../components/overlays';
import type { OutputStreamName, PythonErrorInfo, PythonExecutionResult } from '../types/python';
import { describeOutcome, parseTraceback, summarizeError } from './traceback';

const MAX_DOM_CHARS_PER_RUN = 1_000_000;
const MAX_RUN_BLOCKS = 60;

export interface ConsoleCallbacks {
  canNavigate(filename: string): boolean;
  navigate(filename: string, lineno: number, colno?: number | null): void;
  submitInput(executionId: string, text: string | null): Promise<void>;
  submitRepl(source: string, mode: 'line' | 'block'): Promise<PythonExecutionResult | null>;
  resetRepl(): Promise<void>;
  onToggleExpand(): void;
}

/** Live view of one script run inside the Output tab. */
export class RunBlock {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private footer: HTMLElement;
  private inputRow: HTMLElement | null = null;
  private lastStream: OutputStreamName | 'stdin' | null = null;
  private lastSpan: HTMLElement | null = null;
  private chars = 0;
  private truncatedNotice = false;
  readonly started = performance.now();

  constructor(readonly executionId: string, title: string, private callbacks: ConsoleCallbacks, private onChange: () => void) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.body = h('pre', { class: 'run-output', attrs: { 'aria-live': 'polite' } });
    this.footer = h('div', { class: 'run-footer running' }, icon('spinner', 14, 'spin'), h('span', null, 'Running'));
    this.el = h(
      'section',
      { class: 'run-block', dataset: { execution: executionId } },
      h('header', { class: 'run-header' }, icon('play', 13), h('span', { class: 'run-title' }, title), h('time', null, time)),
      this.body,
      this.footer,
    );
  }

  append(stream: OutputStreamName, text: string): void {
    if (this.chars >= MAX_DOM_CHARS_PER_RUN) {
      if (!this.truncatedNotice) {
        this.truncatedNotice = true;
        this.write('system', '\n[Console] Display limit reached; further output of this run is not shown.\n');
      }
      return;
    }
    const room = MAX_DOM_CHARS_PER_RUN - this.chars;
    this.write(stream, text.length > room ? text.slice(0, room) : text);
    this.onChange();
  }

  private write(stream: OutputStreamName | 'stdin', text: string): void {
    this.chars += text.length;
    if (this.lastStream === stream && this.lastSpan) {
      this.lastSpan.appendChild(document.createTextNode(text));
      return;
    }
    this.lastSpan = h('span', { class: `out-${stream}` }, text);
    this.lastStream = stream;
    this.body.appendChild(this.lastSpan);
  }

  requestInput(): void {
    if (this.inputRow) return;
    const field = h('input', {
      class: 'console-input',
      attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Input for the running script' },
      placeholder: 'Type input and press Return',
    });
    const send = async (text: string | null) => {
      if (!this.inputRow) return;
      row.remove();
      this.inputRow = null;
      if (text !== null) this.write('stdin', text + '\n');
      else this.write('system', '[end of input]\n');
      this.onChange();
      await this.callbacks.submitInput(this.executionId, text);
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void send(field.value);
      }
    });
    const row = h(
      'div',
      { class: 'input-row' },
      h('span', { class: 'input-label' }, 'input'),
      field,
      h('button', { class: 'btn btn-small btn-primary', onClick: () => void send(field.value) }, 'Send'),
      h('button', { class: 'btn btn-small', title: 'Send end-of-file (input() raises EOFError)', onClick: () => void send(null) }, 'EOF'),
    );
    this.inputRow = row;
    this.el.insertBefore(row, this.footer);
    this.onChange();
    requestAnimationFrame(() => field.focus());
  }

  cancelInput(): void {
    this.inputRow?.remove();
    this.inputRow = null;
  }

  finish(result: PythonExecutionResult): void {
    this.cancelInput();
    if (result.error && result.status !== 'ok') this.el.insertBefore(renderError(result.error, this.callbacks), this.footer);
    const outcome = describeOutcome(result);
    const iconName = outcome.tone === 'ok' ? 'ok' : outcome.tone === 'warn' ? 'warning' : 'error';
    clear(this.footer);
    this.footer.className = `run-footer tone-${outcome.tone}`;
    this.footer.append(
      icon(iconName, 14),
      h('span', null, outcome.text),
      h('span', { class: 'run-duration', title: 'Time spent executing Python code' }, formatDuration(result.durationMs)),
    );
    if (result.truncated) this.footer.append(h('span', { class: 'run-note' }, 'output truncated'));
    this.el.classList.add('finished');
    this.onChange();
  }

  fail(message: string): void {
    this.cancelInput();
    clear(this.footer);
    this.footer.className = 'run-footer tone-error';
    this.footer.append(icon('error', 14), h('span', null, message));
    this.el.classList.add('finished');
    this.onChange();
  }

  text(): string {
    return this.el.innerText;
  }
}

function renderError(error: PythonErrorInfo, callbacks: ConsoleCallbacks): HTMLElement {
  const lines = parseTraceback(error.traceback);
  const tb = h('pre', { class: 'traceback' });
  for (const line of lines) {
    if (line.location && callbacks.canNavigate(line.location.filename)) {
      const { filename, lineno } = line.location;
      tb.append(
        h('button', { class: 'tb-link', title: `Open ${filename} at line ${lineno}`, onClick: () => callbacks.navigate(filename, lineno) }, line.text),
        '\n',
      );
    } else {
      tb.append(line.text + '\n');
    }
  }
  const help = error.moduleHelp
    ? h('p', { class: 'error-help' }, icon('info', 14), h('span', null, error.moduleHelp.explanation))
    : null;
  const loc = error.location;
  const jump =
    loc?.filename && loc.lineno && callbacks.canNavigate(loc.filename)
      ? h('button', { class: 'btn btn-small', onClick: () => callbacks.navigate(loc.filename, loc.lineno as number, loc.colno) }, `Go to line ${loc.lineno}`)
      : null;
  return h(
    'div',
    { class: `error-block category-${error.category}` },
    h('div', { class: 'error-summary' }, h('strong', null, summarizeError(error)), jump),
    help,
    tb,
  );
}

/**
 * The bottom panel: script output and the interactive REPL.
 */
export class ConsolePanel {
  readonly el: HTMLElement;
  readonly header: HTMLElement;
  private outputView: HTMLElement;
  private replView: HTMLElement;
  private replLog: HTMLElement;
  private replInput: HTMLInputElement;
  private replArea: HTMLTextAreaElement;
  private replPrompt: HTMLElement;
  private outputTab: HTMLButtonElement;
  private replTab: HTMLButtonElement;
  private autoScrollButton: HTMLButtonElement;
  private emptyState: HTMLElement;
  private blocks: RunBlock[] = [];
  private mode: 'output' | 'repl' = 'output';
  private replBuffer: string[] = [];
  private history: string[] = [];
  private historyIndex = -1;
  private replMultiline = false;
  private scrollPending = false;
  autoScroll = true;
  replBusy = false;

  constructor(private callbacks: ConsoleCallbacks) {
    this.outputTab = h('button', { class: 'seg active', attrs: { role: 'tab', 'aria-selected': 'true' }, onClick: () => this.show('output') }, 'Output');
    this.replTab = h('button', { class: 'seg', attrs: { role: 'tab', 'aria-selected': 'false' }, onClick: () => this.show('repl') }, 'REPL');
    this.autoScrollButton = h('button', {
      class: 'icon-btn toggled',
      title: 'Follow new output',
      attrs: { 'aria-pressed': 'true', 'aria-label': 'Follow new output' },
      onClick: () => this.setAutoScroll(!this.autoScroll),
    }, icon('arrowDown', 17));
    this.header = h(
      'div',
      { class: 'console-header' },
      h('div', { class: 'console-grip', attrs: { 'aria-hidden': 'true' } }),
      h('div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': 'Console views' } }, this.outputTab, this.replTab),
      h('div', { class: 'console-actions' },
        this.autoScrollButton,
        h('button', { class: 'icon-btn', title: 'Copy console text', attrs: { 'aria-label': 'Copy console text' }, onClick: () => void this.copy() }, icon('copy', 17)),
        h('button', { class: 'icon-btn', title: 'Clear console', attrs: { 'aria-label': 'Clear console' }, onClick: () => this.clearVisible() }, icon('clear', 17)),
        h('button', { class: 'icon-btn', title: 'Expand or collapse the console', attrs: { 'aria-label': 'Expand or collapse the console' }, onClick: () => callbacks.onToggleExpand() }, icon('expand', 17)),
      ),
    );

    this.emptyState = h('div', { class: 'console-empty' }, h('p', null, 'Output from your scripts appears here.'), h('p', { class: 'muted' }, 'Tap Run to execute the current file.'));
    this.outputView = h('div', { class: 'console-scroll', attrs: { role: 'log', 'aria-label': 'Script output' } }, this.emptyState);

    this.replLog = h('pre', { class: 'repl-log', attrs: { role: 'log', 'aria-label': 'REPL transcript' } });
    this.replPrompt = h('span', { class: 'repl-prompt' }, '>>>');
    this.replInput = h('input', {
      class: 'repl-input',
      attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Python statement' },
      placeholder: 'Python statement',
    });
    this.replArea = h('textarea', {
      class: 'repl-area hidden',
      rows: 4,
      attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Python code block' },
      placeholder: 'Multi-line block; the value of the last expression is shown',
    });
    this.replInput.addEventListener('keydown', (e) => this.onReplKey(e));
    const multiToggle = h('button', {
      class: 'icon-btn',
      title: 'Switch between one line and a multi-line block',
      attrs: { 'aria-label': 'Toggle multi-line input', 'aria-pressed': 'false' },
      onClick: () => {
        this.replMultiline = !this.replMultiline;
        multiToggle.setAttribute('aria-pressed', String(this.replMultiline));
        multiToggle.classList.toggle('toggled', this.replMultiline);
        this.replInput.classList.toggle('hidden', this.replMultiline);
        this.replArea.classList.toggle('hidden', !this.replMultiline);
        (this.replMultiline ? this.replArea : this.replInput).focus();
      },
    }, icon('wrap', 17));
    this.replView = h(
      'div',
      { class: 'repl-view hidden' },
      h('div', { class: 'console-scroll repl-scroll' }, h('p', { class: 'repl-banner muted' }, 'Interactive Python. Variables persist between entries until you reset the interpreter. Script runs use their own namespace.'), this.replLog),
      h('div', { class: 'repl-bar' },
        this.replPrompt,
        this.replInput,
        this.replArea,
        multiToggle,
        h('button', { class: 'btn btn-small btn-primary', onClick: () => void this.submitRepl() }, 'Run'),
        h('button', { class: 'icon-btn', title: 'Reset interpreter state', attrs: { 'aria-label': 'Reset interpreter state' }, onClick: () => void callbacks.resetRepl() }, icon('restart', 17)),
      ),
    );

    this.el = h('div', { class: 'console-panel' }, this.header, this.outputView, this.replView);
  }

  get currentMode(): 'output' | 'repl' {
    return this.mode;
  }

  show(mode: 'output' | 'repl'): void {
    this.mode = mode;
    this.outputTab.classList.toggle('active', mode === 'output');
    this.replTab.classList.toggle('active', mode === 'repl');
    this.outputTab.setAttribute('aria-selected', String(mode === 'output'));
    this.replTab.setAttribute('aria-selected', String(mode === 'repl'));
    this.outputView.classList.toggle('hidden', mode !== 'output');
    this.replView.classList.toggle('hidden', mode !== 'repl');
    if (mode === 'repl') requestAnimationFrame(() => (this.replMultiline ? this.replArea : this.replInput).focus());
  }

  setAutoScroll(on: boolean): void {
    this.autoScroll = on;
    this.autoScrollButton.classList.toggle('toggled', on);
    this.autoScrollButton.setAttribute('aria-pressed', String(on));
    if (on) this.scheduleScroll();
  }

  beginRun(executionId: string, title: string): RunBlock {
    this.emptyState.remove();
    const block = new RunBlock(executionId, title, this.callbacks, () => this.scheduleScroll());
    this.blocks.push(block);
    this.outputView.appendChild(block.el);
    while (this.blocks.length > MAX_RUN_BLOCKS) this.blocks.shift()?.el.remove();
    this.show('output');
    this.scheduleScroll(true);
    return block;
  }

  /** Output that belongs to no run (threads that outlive their script). */
  appendBackground(stream: OutputStreamName, text: string): void {
    const target = this.mode === 'repl' ? this.replLog : this.outputView;
    target.appendChild(h('span', { class: `out-${stream} out-background`, title: 'Written after its script finished' }, text));
    this.scheduleScroll();
  }

  appendNotice(text: string, tone: 'info' | 'error' = 'info'): void {
    this.emptyState.remove();
    this.outputView.appendChild(h('div', { class: `console-notice tone-${tone}` }, text));
    this.scheduleScroll(true);
  }

  private scheduleScroll(force = false): void {
    if (!this.autoScroll && !force) return;
    if (this.scrollPending) return;
    this.scrollPending = true;
    requestAnimationFrame(() => {
      this.scrollPending = false;
      for (const scroller of this.el.querySelectorAll<HTMLElement>('.console-scroll')) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
  }

  clearVisible(): void {
    if (this.mode === 'output') {
      for (const block of this.blocks) if (block.el.classList.contains('finished')) block.el.remove();
      this.blocks = this.blocks.filter((b) => !b.el.classList.contains('finished'));
      for (const notice of this.outputView.querySelectorAll('.console-notice, .out-background')) notice.remove();
      if (this.blocks.length === 0) this.outputView.appendChild(this.emptyState);
    } else {
      clear(this.replLog);
      toast('REPL transcript cleared. Variables are kept; use Reset to clear them.');
    }
  }

  async copy(): Promise<void> {
    const text = this.mode === 'output' ? this.blocks.map((b) => b.text()).join('\n\n') : this.replLog.innerText;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied console text', 'success');
    } catch {
      toast('Copying is not allowed here', 'error');
    }
  }

  setFontSize(px: number): void {
    this.el.style.setProperty('--console-font-size', `${px}px`);
  }

  // --- REPL -------------------------------------------------------------

  private onReplKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.submitRepl();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (this.history.length === 0) return;
      e.preventDefault();
      if (this.historyIndex === -1) this.historyIndex = this.history.length;
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (e.key === 'ArrowUp' ? -1 : 1)));
      this.replInput.value = this.history[this.historyIndex] ?? '';
    }
  }

  private echo(text: string, cls: string): void {
    this.replLog.appendChild(h('span', { class: cls }, text));
    this.scheduleScroll(true);
  }

  replOutput(stream: OutputStreamName, text: string): void {
    this.echo(text, `out-${stream}`);
  }

  async submitRepl(): Promise<void> {
    if (this.replBusy) {
      toast('The previous REPL entry is still running');
      return;
    }
    if (this.replMultiline) {
      const source = this.replArea.value;
      if (!source.trim()) return;
      this.echo(source.split('\n').map((l, i) => `${i === 0 ? '>>> ' : '... '}${l}`).join('\n') + '\n', 'repl-echo');
      this.pushHistory(source);
      this.replArea.value = '';
      await this.runRepl(source, 'block');
      return;
    }
    const line = this.replInput.value;
    this.replInput.value = '';
    this.historyIndex = -1;
    this.echo(`${this.replBuffer.length ? '... ' : '>>> '}${line}\n`, 'repl-echo');
    if (this.replBuffer.length && line.trim() === '') {
      const source = this.replBuffer.join('\n') + '\n';
      this.replBuffer = [];
      this.replPrompt.textContent = '>>>';
      await this.runRepl(source, 'line');
      return;
    }
    if (line.trim()) this.pushHistory(line);
    const source = [...this.replBuffer, line].join('\n');
    if (!source.trim()) return;
    const result = await this.runRepl(source, 'line');
    if (result?.status === 'incomplete') {
      this.replBuffer.push(line);
      this.replPrompt.textContent = '...';
    } else {
      this.replBuffer = [];
      this.replPrompt.textContent = '>>>';
    }
  }

  private pushHistory(entry: string): void {
    if (this.history[this.history.length - 1] !== entry) this.history.push(entry);
    if (this.history.length > 200) this.history.shift();
  }

  private async runRepl(source: string, mode: 'line' | 'block'): Promise<PythonExecutionResult | null> {
    this.replBusy = true;
    try {
      const result = await this.callbacks.submitRepl(source, mode);
      if (result && result.status !== 'incomplete' && result.error && result.status !== 'ok') {
        const err = result.error;
        this.echo(err.traceback.endsWith('\n') ? err.traceback : err.traceback + '\n', 'out-stderr');
        if (err.moduleHelp) this.echo(`# ${err.moduleHelp.explanation}\n`, 'out-system');
      }
      if (result?.status === 'exit') this.echo(`# SystemExit(${result.exitCode}) - the REPL keeps running.\n`, 'out-system');
      return result;
    } finally {
      this.replBusy = false;
    }
  }

  resetReplPrompt(): void {
    this.replBuffer = [];
    this.replPrompt.textContent = '>>>';
    this.echo('# Interpreter state reset.\n', 'out-system');
  }

  focusRepl(): void {
    this.show('repl');
  }
}
