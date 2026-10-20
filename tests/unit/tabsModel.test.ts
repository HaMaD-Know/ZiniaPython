import { describe, expect, it } from 'vitest';
import { TabsModel } from '../../src/app/tabsModel';

const ref = (path: string) => ({ root: 'workspace', path });

describe('TabsModel (specification test 14: multiple tabs)', () => {
  it('opens, switches and tracks unsaved changes per tab', () => {
    const tabs = new TabsModel();
    const main = tabs.open(ref('P/main.py'), 'print(1)\n', 10);
    const helpers = tabs.open(ref('P/helpers.py'), 'x = 1\n', 11);
    expect(tabs.active?.id).toBe(helpers.id);

    tabs.updateText(main.id, 'print(2)\n');
    expect(tabs.isDirty(main)).toBe(true);
    expect(tabs.isDirty(helpers)).toBe(false);

    tabs.activate(main.id);
    expect(tabs.active?.id).toBe(main.id);
    expect(tabs.dirtyTabs.map((t) => t.ref.path)).toEqual(['P/main.py']);

    tabs.updateText(main.id, 'print(1)\n'); // edited back to the saved text
    expect(tabs.isDirty(main)).toBe(false);
  });

  it('does not open the same file twice', () => {
    const tabs = new TabsModel();
    const a = tabs.open(ref('a.py'), '', 1);
    tabs.open(ref('b.py'), '', 1);
    expect(tabs.open(ref('a.py'), 'ignored', 1).id).toBe(a.id);
    expect(tabs.all).toHaveLength(2);
    expect(tabs.active?.id).toBe(a.id);
  });

  it('activates a neighbour when the active tab closes', () => {
    const tabs = new TabsModel();
    const a = tabs.open(ref('a.py'), '', 1);
    const b = tabs.open(ref('b.py'), '', 1);
    const c = tabs.open(ref('c.py'), '', 1);
    tabs.activate(b.id);
    expect(tabs.close(b.id)).toBe(c.id);
    expect(tabs.close(c.id)).toBe(a.id);
    expect(tabs.close(a.id)).toBeNull();
  });

  it('marks saves and Save As', () => {
    const tabs = new TabsModel();
    const t = tabs.newUntitled('print("hi")\n');
    expect(t.untitled).toBe(true);
    expect(tabs.isDirty(t)).toBe(true);
    tabs.markSaved(t.id, 'print("hi")\n', 42, ref('P/hi.py'));
    expect(t.untitled).toBe(false);
    expect(t.ref.path).toBe('P/hi.py');
    expect(tabs.isDirty(t)).toBe(false);
  });

  it('handles external changes: clean tabs reload, dirty tabs conflict', () => {
    const tabs = new TabsModel();
    const clean = tabs.open(ref('clean.py'), 'old\n', 1);
    const dirty = tabs.open(ref('dirty.py'), 'old\n', 1);
    tabs.updateText(dirty.id, 'mine\n');
    expect(tabs.externalChange(clean.id, 'theirs\n', 2)).toBe('reloaded');
    expect(clean.text).toBe('theirs\n');
    expect(tabs.externalChange(dirty.id, 'theirs\n', 2)).toBe('conflict');
    expect(dirty.text).toBe('mine\n');
    expect(dirty.conflict).toBe(true);
  });

  it('follows renames of files and folders', () => {
    const tabs = new TabsModel();
    tabs.open(ref('Old/main.py'), '', 1);
    tabs.open(ref('Old/pkg/mod.py'), '', 1);
    tabs.open(ref('Other/main.py'), '', 1);
    tabs.renamePath('workspace', 'Old', 'New');
    expect(tabs.all.map((t) => t.ref.path)).toEqual(['New/main.py', 'New/pkg/mod.py', 'Other/main.py']);
    expect(tabs.under('workspace', 'New').length).toBe(2);
  });

  it('snapshots open tabs for restoring after a restart (test 10)', () => {
    const tabs = new TabsModel();
    tabs.open(ref('P/main.py'), '', 1);
    tabs.newUntitled('scratch');
    const b = tabs.open(ref('P/b.py'), '', 1);
    tabs.activate(b.id);
    const snap = tabs.snapshot();
    expect(snap.tabs.map((t) => t.ref.path)).toEqual(['P/main.py', 'P/b.py']);
    expect(snap.activeKey).toBe('workspace::P/b.py');
  });
});
