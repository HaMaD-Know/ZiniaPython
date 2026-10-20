/**
 * File handling through the real @capacitor/filesystem plugin (its web
 * implementation, backed by IndexedDB) - specification test 9 for the
 * provider and project logic. The iOS implementation of the same plugin is
 * exercised on a device; see docs/VERIFICATION-REPORT.md.
 */
import { describe, expect, it } from 'vitest';
import { CapacitorWorkspaceProvider } from '../../src/files/providers';
import { Workspace } from '../../src/files/workspace';
import { CONFIG_PATH, ProjectService, projectOf } from '../../src/projects/projects';
import { MemoryStore } from '../../src/services/storage';

describe('workspace files (test 9)', () => {
  it('creates, saves, reopens, renames, duplicates and deletes files', async () => {
    const fs = new CapacitorWorkspaceProvider();
    const dir = `t9-${Date.now()}`;
    await fs.mkdir(dir);
    const { mtime } = await fs.write(`${dir}/notes.py`, 'print("héllo ✓")\n', { overwrite: false });
    expect(mtime).toBeGreaterThan(0);

    const reopened = await fs.read(`${dir}/notes.py`);
    expect(reopened.text).toBe('print("héllo ✓")\n');

    await expect(fs.write(`${dir}/notes.py`, 'x', { overwrite: false })).rejects.toMatchObject({ code: 'EXISTS' });

    await fs.rename(`${dir}/notes.py`, `${dir}/renamed.py`);
    expect(await fs.stat(`${dir}/notes.py`)).toBeNull();
    expect((await fs.read(`${dir}/renamed.py`)).text).toContain('héllo');

    await fs.copy(`${dir}/renamed.py`, `${dir}/copy.py`);
    const names = (await fs.list(dir)).map((e) => e.name).sort();
    expect(names).toEqual(['copy.py', 'renamed.py']);

    await fs.remove(`${dir}/renamed.py`);
    await fs.remove(dir);
    expect(await fs.stat(dir)).toBeNull();
  });

  it('does not leave temporary files behind after saving', async () => {
    const fs = new CapacitorWorkspaceProvider();
    const dir = `atomic-${Date.now()}`;
    await fs.mkdir(dir);
    await fs.write(`${dir}/a.py`, 'one\n');
    await fs.write(`${dir}/a.py`, 'two\n');
    expect((await fs.read(`${dir}/a.py`)).text).toBe('two\n');
    expect((await fs.list(dir)).map((e) => e.name)).toEqual(['a.py']);
  });

  it('detects writes that would overwrite a newer version', async () => {
    const fs = new CapacitorWorkspaceProvider();
    const path = `conflict-${Date.now()}.py`;
    const first = await fs.write(path, 'v1\n');
    await new Promise((r) => setTimeout(r, 5));
    await fs.write(path, 'changed elsewhere\n');
    await expect(fs.write(path, 'mine\n', { expectedMtime: first.mtime - 1000 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await fs.remove(path);
  });

  it('creates a starter project whose files and config are readable', async () => {
    const workspace = new Workspace(new MemoryStore(), false);
    await workspace.init();
    const projects = new ProjectService(workspace, () => 'main.py');
    const name = `Proj${Date.now()}`;
    const { project, entry } = await projects.create(name, 'starter');
    expect(entry.path).toBe(`${name}/main.py`);
    const files = (await workspace.provider('workspace').list(name)).map((e) => e.name).sort();
    expect(files).toEqual(['README.md', 'data', 'helpers.py', 'main.py']); // .zinia is hidden
    const config = await projects.loadConfig(project);
    expect(config).toMatchObject({ name, entry: 'main.py', workingDirectory: 'project' });
    expect((await workspace.provider('workspace').read(`${name}/${CONFIG_PATH}`)).text).toContain('"entry": "main.py"');
    expect(projectOf(entry)).toEqual({ root: 'workspace', path: name });
    await expect(projects.create(name, 'empty')).rejects.toThrow(/already exists/);
  });

  it('searches file names and contents', async () => {
    const workspace = new Workspace(new MemoryStore(), false);
    await workspace.init();
    const fs = workspace.provider('workspace');
    const dir = `search-${Date.now()}`;
    await fs.mkdir(`${dir}/pkg`);
    await fs.write(`${dir}/pkg/tool.py`, 'def needle_function():\n    return 1\n');
    await fs.write(`${dir}/other.txt`, 'nothing here\n');
    const hits = await workspace.search('workspace', dir, 'NEEDLE');
    expect(hits).toEqual([{ ref: { root: 'workspace', path: `${dir}/pkg/tool.py` }, name: 'tool.py', line: 1, preview: 'def needle_function():' }]);
  });

  it('keeps a bounded recent-files list that persists (test 10)', async () => {
    const store = new MemoryStore();
    const a = new Workspace(store, false);
    await a.init();
    for (let i = 0; i < 20; i++) await a.touchRecent({ root: 'workspace', path: `f${i}.py` });
    await a.touchRecent({ root: 'workspace', path: 'f3.py' });
    const b = new Workspace(store, false);
    await b.init();
    expect(b.recent).toHaveLength(15);
    expect(b.recent[0].path).toBe('f3.py');
  });
});
