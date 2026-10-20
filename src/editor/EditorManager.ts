import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, acceptCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, selectAll, toggleComment, undo } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import type { Settings } from '../services/settings';
import { pythonCompletionSource } from './completions';
import { ziniaTheme } from './theme';

const setErrorLine = StateEffect.define<number | null>();

/** Highlights the line a traceback points at, until the next edit. */
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorLine)) {
        if (effect.value === null || effect.value < 1 || effect.value > tr.state.doc.lines) return Decoration.none;
        const line = tr.state.doc.line(effect.value);
        return Decoration.set([Decoration.line({ class: 'cm-error-line' }).range(line.from)]);
      }
    }
    return tr.docChanged ? Decoration.none : value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface StoredView {
  state: EditorState;
  scrollTop: number;
}

/**
 * One CodeMirror view shared by all tabs. Each tab keeps its own
 * EditorState, so undo history, selection and scroll position survive
 * switching tabs.
 */
export class EditorManager {
  readonly view: EditorView;
  private stored = new Map<string, StoredView>();
  private currentTab: string | null = null;
  private suppress = false;
  private readonly lineNumbersC = new Compartment();
  private readonly wrapC = new Compartment();
  private readonly tabC = new Compartment();
  private readonly completeC = new Compartment();
  private readonly readOnlyC = new Compartment();

  onChange: ((tabId: string, text: string) => void) | null = null;
  onCursor: ((tabId: string, line: number, col: number) => void) | null = null;

  constructor(parent: HTMLElement, private settings: Settings, private projectModules: () => string[]) {
    this.view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: this.extensions(true) }) });
    this.view.contentDOM.setAttribute('autocapitalize', 'off');
    this.view.contentDOM.setAttribute('autocorrect', 'off');
    this.view.contentDOM.setAttribute('spellcheck', 'false');
    this.view.contentDOM.setAttribute('aria-label', 'Code editor');
  }

  private settingExtensions(): Extension[] {
    const s = this.settings;
    return [
      this.lineNumbersC.of(s.lineNumbers ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : []),
      this.wrapC.of(s.wordWrap ? EditorView.lineWrapping : []),
      this.tabC.of([EditorState.tabSize.of(s.tabWidth), indentUnit.of(' '.repeat(s.tabWidth))]),
      this.completeC.of(
        s.autocomplete
          ? autocompletion({ override: [pythonCompletionSource(this.projectModules)], activateOnTyping: true, maxRenderedOptions: 60 })
          : [],
      ),
    ];
  }

  private extensions(readOnly = false): Extension[] {
    return [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      python(),
      ziniaTheme,
      errorLineField,
      this.readOnlyC.of(EditorState.readOnly.of(readOnly)),
      ...this.settingExtensions(),
      keymap.of([
        { key: 'Tab', run: acceptCompletion },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (!this.currentTab || this.suppress) return;
        if (update.docChanged) this.onChange?.(this.currentTab, update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          this.onCursor?.(this.currentTab, line.number, head - line.from + 1);
        }
      }),
    ];
  }

  get activeTab(): string | null {
    return this.currentTab;
  }

  /** Shows a tab, creating its editor state from `text` the first time. */
  show(tabId: string, text: string, cursor = 0): void {
    this.saveCurrent();
    let stored = this.stored.get(tabId);
    if (!stored) {
      const state = EditorState.create({
        doc: text,
        selection: EditorSelection.cursor(Math.min(cursor, text.length)),
        extensions: this.extensions(false),
      });
      stored = { state, scrollTop: 0 };
      this.stored.set(tabId, stored);
    }
    this.suppress = true;
    this.view.setState(stored.state);
    this.suppress = false;
    this.currentTab = tabId;
    this.applySettings(this.settings);
    const scrollTop = stored.scrollTop;
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = scrollTop;
    });
  }

  /** Shows an empty, read-only editor (no tabs open). */
  showEmpty(): void {
    this.saveCurrent();
    this.currentTab = null;
    this.suppress = true;
    this.view.setState(EditorState.create({ doc: '', extensions: this.extensions(true) }));
    this.suppress = false;
  }

  private saveCurrent(): void {
    if (this.currentTab && this.stored.has(this.currentTab)) {
      this.stored.set(this.currentTab, { state: this.view.state, scrollTop: this.view.scrollDOM.scrollTop });
    }
  }

  getText(tabId: string): string | null {
    if (tabId === this.currentTab) return this.view.state.doc.toString();
    return this.stored.get(tabId)?.state.doc.toString() ?? null;
  }

  cursorOf(tabId: string): number {
    if (tabId === this.currentTab) return this.view.state.selection.main.head;
    return this.stored.get(tabId)?.state.selection.main.head ?? 0;
  }

  /** Replaces a tab's text (reload from disk) as an undoable change. */
  replaceText(tabId: string, text: string): void {
    if (tabId === this.currentTab) {
      this.suppress = true;
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
      this.suppress = false;
      return;
    }
    const stored = this.stored.get(tabId);
    if (stored) {
      stored.state = stored.state.update({ changes: { from: 0, to: stored.state.doc.length, insert: text } }).state;
    }
  }

  dispose(tabId: string): void {
    this.stored.delete(tabId);
    if (this.currentTab === tabId) this.currentTab = null;
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    if (!this.currentTab) return;
    this.view.dispatch({
      effects: [
        this.lineNumbersC.reconfigure(settings.lineNumbers ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : []),
        this.wrapC.reconfigure(settings.wordWrap ? EditorView.lineWrapping : []),
        this.tabC.reconfigure([EditorState.tabSize.of(settings.tabWidth), indentUnit.of(' '.repeat(settings.tabWidth))]),
        this.completeC.reconfigure(
          settings.autocomplete
            ? autocompletion({ override: [pythonCompletionSource(this.projectModules)], activateOnTyping: true, maxRenderedOptions: 60 })
            : [],
        ),
      ],
    });
  }

  // --- commands used by toolbars and the key bar --------------------------

  focus(): void { this.view.focus(); }
  undo(): void { undo(this.view); this.focus(); }
  redo(): void { redo(this.view); this.focus(); }
  selectAll(): void { selectAll(this.view); this.focus(); }
  indent(): void { indentMore(this.view); this.focus(); }
  dedent(): void { indentLess(this.view); this.focus(); }
  toggleComment(): void { toggleComment(this.view); this.focus(); }
  openSearch(): void { openSearchPanel(this.view); }

  selectedText(): string {
    const { state } = this.view;
    return state.selection.ranges.map((r) => state.sliceDoc(r.from, r.to)).join('\n');
  }

  insert(text: string, cursorOffset = text.length): void {
    const { state } = this.view;
    const range = state.selection.main;
    this.view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: EditorSelection.cursor(range.from + cursorOffset),
      scrollIntoView: true,
      userEvent: 'input.type',
    });
    this.focus();
  }

  moveCursor(delta: number): void {
    const head = this.view.state.selection.main.head;
    const pos = Math.max(0, Math.min(this.view.state.doc.length, head + delta));
    this.view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
    this.focus();
  }

  goTo(line: number, column = 1, highlightError = false): void {
    const doc = this.view.state.doc;
    const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(target.to, target.from + Math.max(0, column - 1));
    this.view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: [EditorView.scrollIntoView(pos, { y: 'center' }), setErrorLine.of(highlightError ? target.number : null)],
    });
    this.focus();
  }

  /** Highlights a line without moving the cursor (used after a failed run). */
  markError(line: number): void {
    if (this.currentTab) this.view.dispatch({ effects: setErrorLine.of(line) });
  }

  clearErrorMark(): void {
    if (this.currentTab) this.view.dispatch({ effects: setErrorLine.of(null) });
  }
}
