import { h } from './dom';
import { icon, type IconName } from './icons';

/**
 * Dialogs, action sheets and toasts. WKWebView's native alert/prompt are
 * avoided so every dialog matches the app and is keyboard accessible.
 */

let layer: HTMLElement | null = null;
function overlayLayer(): HTMLElement {
  if (!layer) {
    layer = h('div', { class: 'overlay-layer' });
    document.body.appendChild(layer);
  }
  return layer;
}

interface DialogButton<T> {
  label: string;
  value: T;
  kind?: 'primary' | 'danger' | 'plain';
}

function showDialog<T>(options: {
  title: string;
  message?: string | Node;
  buttons: DialogButton<T>[];
  cancelValue: T;
  input?: { value: string; placeholder?: string; validate?: (v: string) => string | null; select?: 'stem' | 'all' };
}): Promise<{ value: T; text: string }> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const error = h('p', { class: 'dialog-error', attrs: { role: 'alert' } });
    const input = options.input
      ? h('input', {
          class: 'text-input',
          value: options.input.value,
          placeholder: options.input.placeholder ?? '',
          attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': options.title },
        })
      : null;
    const close = (value: T) => {
      if (input && value !== options.cancelValue && options.input?.validate) {
        const problem = options.input.validate(input.value);
        if (problem) {
          error.textContent = problem;
          input.focus();
          return;
        }
      }
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      previousFocus?.focus?.();
      resolve({ value, text: input?.value ?? '' });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(options.cancelValue);
      } else if (e.key === 'Enter' && input && document.activeElement === input) {
        e.preventDefault();
        const primary = options.buttons.find((b) => b.kind === 'primary' || b.kind === 'danger');
        if (primary) close(primary.value);
      }
    };
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const dialog = h(
      'div',
      { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      h('h2', { id: titleId, class: 'dialog-title' }, options.title),
      options.message ? h('div', { class: 'dialog-message' }, options.message) : null,
      input,
      error,
      h(
        'div',
        { class: 'dialog-buttons' },
        options.buttons.map((b) => h('button', { class: `btn btn-${b.kind ?? 'plain'}`, onClick: () => close(b.value) }, b.label)),
      ),
    );
    const backdrop = h('div', { class: 'backdrop', onClick: (e: Event) => e.target === backdrop && close(options.cancelValue) }, dialog);
    overlayLayer().appendChild(backdrop);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => {
      if (input) {
        input.focus();
        const value = input.value;
        const dot = value.lastIndexOf('.');
        if (options.input?.select === 'stem' && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      } else {
        (dialog.querySelector('.btn-primary, .btn-danger, .btn') as HTMLElement | null)?.focus();
      }
    });
  });
}

export async function confirmDialog(title: string, message: string | Node, confirmLabel: string, danger = false): Promise<boolean> {
  const result = await showDialog({
    title,
    message,
    cancelValue: false,
    buttons: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return result.value;
}

export async function choiceDialog<T extends string>(title: string, message: string, buttons: DialogButton<T>[], cancelValue: T): Promise<T> {
  return (await showDialog({ title, message, buttons, cancelValue })).value;
}

export async function promptDialog(
  title: string,
  options: { value?: string; placeholder?: string; confirmLabel?: string; message?: string; validate?: (v: string) => string | null; select?: 'stem' | 'all' } = {},
): Promise<string | null> {
  const result = await showDialog({
    title,
    message: options.message,
    cancelValue: 'cancel' as const,
    buttons: [
      { label: 'Cancel', value: 'cancel' as const },
      { label: options.confirmLabel ?? 'OK', value: 'ok' as const, kind: 'primary' },
    ],
    input: { value: options.value ?? '', placeholder: options.placeholder, validate: options.validate, select: options.select },
  });
  return result.value === 'ok' ? result.text.trim() : null;
}

export async function alertDialog(title: string, message: string | Node): Promise<void> {
  await showDialog({ title, message, cancelValue: true, buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  action: () => void | Promise<void>;
}

/** Action sheet anchored to an element (iPad) or the bottom of the screen (iPhone). */
export function showMenu(anchor: HTMLElement | null, items: (MenuItem | 'separator')[], title?: string): void {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const menu = h(
    'div',
    { class: 'menu', attrs: { role: 'menu' } },
    title ? h('div', { class: 'menu-title' }, title) : null,
    items.map((item) =>
      item === 'separator'
        ? h('div', { class: 'menu-separator', attrs: { role: 'separator' } })
        : h(
            'button',
            {
              class: `menu-item${item.danger ? ' danger' : ''}`,
              disabled: item.disabled ?? false,
              attrs: { role: 'menuitem' },
              onClick: () => {
                close();
                void item.action();
              },
            },
            item.icon ? icon(item.icon, 17) : h('span', { class: 'icon-spacer' }),
            h('span', null, item.label),
          ),
    ),
  );
  const backdrop = h('div', { class: 'backdrop backdrop-clear', onClick: (e: Event) => e.target === backdrop && close() }, menu);
  overlayLayer().appendChild(backdrop);
  document.addEventListener('keydown', onKey, true);
  const compact = window.matchMedia('(max-width: 700px)').matches;
  if (anchor && !compact) {
    const rect = anchor.getBoundingClientRect();
    menu.classList.add('menu-anchored');
    const width = 250;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    menu.style.left = `${left}px`;
    if (below + 320 > window.innerHeight) menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    else menu.style.top = `${below}px`;
  } else {
    menu.classList.add('menu-sheet');
  }
  requestAnimationFrame(() => (menu.querySelector('.menu-item:not([disabled])') as HTMLElement | null)?.focus());
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info', ms = 2600): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', attrs: { 'aria-live': 'polite' } });
    document.body.appendChild(toastHost);
  }
  const iconName: IconName = kind === 'success' ? 'ok' : kind === 'error' ? 'alert' : 'info';
  const el = h('div', { class: `toast toast-${kind}` }, icon(iconName, 16), h('span', null, message));
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}
