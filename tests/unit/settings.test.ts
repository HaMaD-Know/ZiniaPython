import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../../src/services/settings';
import { MemoryStore } from '../../src/services/storage';

describe('settings', () => {
  it('fills defaults and rejects invalid values', () => {
    const s = sanitizeSettings({ theme: 'neon', editorFontSize: 400, tabWidth: 3, wordWrap: 'yes', defaultEntryPoint: '../evil.py' });
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.editorFontSize).toBe(28);
    expect(s.tabWidth).toBe(DEFAULT_SETTINGS.tabWidth);
    expect(s.wordWrap).toBe(DEFAULT_SETTINGS.wordWrap);
    expect(s.defaultEntryPoint).toBe('main.py');
  });

  it('persists updates and resets (test 10: preferences persist)', async () => {
    const store = new MemoryStore();
    const a = new SettingsStore(store);
    await a.load();
    const changes: string[][] = [];
    a.subscribe((_s, changed) => changes.push(changed));
    await a.update({ theme: 'light', editorFontSize: 18 });
    expect(changes[0].sort()).toEqual(['editorFontSize', 'theme']);

    const b = new SettingsStore(store); // a fresh app start
    await b.load();
    expect(b.current.theme).toBe('light');
    expect(b.current.editorFontSize).toBe(18);

    await b.reset();
    expect(b.current).toEqual(DEFAULT_SETTINGS);
  });
});
