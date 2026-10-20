import { h } from './dom';
import { icon, type IconName } from './icons';
import type { EditorManager } from '../editor/EditorManager';

interface Key {
  label?: string;
  icon?: IconName;
  title: string;
  run: (editor: EditorManager) => void;
}

const pair = (open: string, close: string) => (e: EditorManager) => {
  const selected = e.selectedText();
  e.insert(open + selected + close, selected ? open.length + selected.length + close.length : open.length);
};
const text = (t: string) => (e: EditorManager) => e.insert(t);

const KEYS: Key[] = [
  { icon: 'indent', title: 'Indent', run: (e) => e.indent() },
  { icon: 'dedent', title: 'Outdent', run: (e) => e.dedent() },
  { label: ':', title: 'Colon', run: text(':') },
  { label: '( )', title: 'Parentheses', run: pair('(', ')') },
  { label: '[ ]', title: 'Brackets', run: pair('[', ']') },
  { label: '{ }', title: 'Braces', run: pair('{', '}') },
  { label: '" "', title: 'Quotes', run: pair('"', '"') },
  { label: "' '", title: 'Single quotes', run: pair("'", "'") },
  { label: '=', title: 'Equals', run: text('=') },
  { label: '_', title: 'Underscore', run: text('_') },
  { label: '#', title: 'Comment', run: (e) => e.toggleComment() },
  { label: '.', title: 'Dot', run: text('.') },
  { label: ',', title: 'Comma', run: text(', ') },
  { label: '+', title: 'Plus', run: text('+') },
  { label: '-', title: 'Minus', run: text('-') },
  { label: '*', title: 'Times', run: text('*') },
  { label: '/', title: 'Slash', run: text('/') },
  { label: '<', title: 'Less than', run: text('<') },
  { label: '>', title: 'Greater than', run: text('>') },
  { icon: 'arrowLeft', title: 'Cursor left', run: (e) => e.moveCursor(-1) },
  { icon: 'arrowRight', title: 'Cursor right', run: (e) => e.moveCursor(1) },
  { icon: 'undo', title: 'Undo', run: (e) => e.undo() },
  { icon: 'redo', title: 'Redo', run: (e) => e.redo() },
];

/**
 * Coding keys shown above the iOS keyboard. Buttons act on pointerdown and
 * cancel the default so the editor keeps focus and the keyboard stays up.
 */
export function createKeyBar(editor: EditorManager, onHideKeyboard: () => void): HTMLElement {
  const make = (key: Key) => {
    const button = h('button', { class: 'key', title: key.title, attrs: { 'aria-label': key.title, tabindex: '-1' } }, key.icon ? icon(key.icon, 17) : key.label);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      key.run(editor);
    });
    button.addEventListener('click', (event) => event.preventDefault());
    return button;
  };
  const hide = h('button', { class: 'key key-hide', title: 'Hide keyboard', attrs: { 'aria-label': 'Hide keyboard', tabindex: '-1' } }, icon('keyboard', 17), icon('chevronDown', 12));
  hide.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    onHideKeyboard();
  });
  return h('div', { class: 'key-bar', attrs: { role: 'toolbar', 'aria-label': 'Coding keys' } },
    h('div', { class: 'key-scroll' }, KEYS.map(make)),
    hide,
  );
}
