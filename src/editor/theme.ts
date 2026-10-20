import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * Editor colours read CSS custom properties defined in styles/tokens.css, so
 * one theme definition serves both the dark and the light palette.
 */
export const ziniaEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--code-text)',
    backgroundColor: 'var(--editor-bg)',
    height: '100%',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: '1.55',
    overscrollBehavior: 'contain',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '10px 0 40vh',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--gutter-text)',
    border: 'none',
    paddingLeft: '4px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px', minWidth: '30px' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-2)', border: 'none', color: 'var(--muted)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--bracket-match)',
    outline: '1px solid var(--accent-soft)',
  },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--danger-soft)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)', outline: '1px solid var(--search-match-border)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-active)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    border: '1px solid var(--line)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-pop)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-code)', maxHeight: '14em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '0.8em' },
  '.cm-completionIcon': { opacity: '0.7' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '8px 10px', fontFamily: 'var(--font-ui)', fontSize: '14px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '14px' },
  '.cm-panel.cm-search label': { fontSize: '13px', color: 'var(--muted)' },
  '.cm-error-line': { backgroundColor: 'var(--danger-line)' },
  '.cm-error-gutter-marker': { color: 'var(--danger)' },
});

export const ziniaHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.self, t.bool, t.null, t.atom], color: 'var(--syn-constant)' },
  { tag: [t.number], color: 'var(--syn-number)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.escape, t.regexp], color: 'var(--syn-escape)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: 'var(--syn-function)' },
  { tag: [t.definition(t.className), t.className, t.typeName], color: 'var(--syn-class)' },
  { tag: [t.standard(t.variableName)], color: 'var(--syn-builtin)' },
  { tag: [t.propertyName], color: 'var(--syn-property)' },
  { tag: [t.meta, t.annotation], color: 'var(--syn-decorator)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--syn-punct)' },
  { tag: [t.variableName], color: 'var(--code-text)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

export const ziniaTheme: Extension = [ziniaEditorTheme, syntaxHighlighting(ziniaHighlight)];
