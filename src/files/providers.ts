import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { ZiniaFiles } from '../plugins/zinia-files';
import { basename, dirname, join } from './paths';

export interface Entry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  downloaded?: boolean;
}

export class FileError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

/** File operations on one root. All paths are root-relative. */
export interface FileProvider {
  readonly rootId: string;
  /** Absolute path of the root inside the app sandbox (for Python's cwd), if known. */
  absoluteRoot(): Promise<string | null>;
  list(path: string): Promise<Entry[]>;
  stat(path: string): Promise<Entry | null>;
  read(path: string): Promise<{ text: string; mtime: number }>;
  /** Writes text, failing with code CONFLICT if the file changed since `expectedMtime`. */
  write(path: string, text: string, options?: { expectedMtime?: number | null; overwrite?: boolean }): Promise<{ mtime: number }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
}

// "Inbox" is created by iOS for files opened with the app; "__pycache__" by Python.
const HIDDEN = new Set(['Inbox', '__pycache__']);

/** Entries never shown in the file explorer (dot-files include .zinia metadata). */
export function isHiddenEntry(name: string): boolean {
  return HIDDEN.has(name) || name.startsWith('.');
}

function codeOf(error: unknown): string {
  const e = error as { code?: string; message?: string };
  if (e?.code && /^[A-Z_]+$/.test(e.code)) return e.code;
  const message = (e?.message ?? '').toLowerCase();
  if (message.includes('does not exist') || message.includes('no such file')) return 'NOT_FOUND';
  if (message.includes('exists')) return 'EXISTS';
  return 'IO_ERROR';
}

/**
 * The app workspace (Documents) through the official @capacitor/filesystem
 * plugin. Saves are written to a temporary file and renamed over the target,
 * so a crash mid-write cannot leave a half-written file.
 */
export class CapacitorWorkspaceProvider implements FileProvider {
  readonly rootId = 'workspace';
  private root: string | null | undefined;

  async absoluteRoot(): Promise<string | null> {
    if (this.root !== undefined) return this.root;
    try {
      const { uri } = await Filesystem.getUri({ directory: Directory.Documents, path: '' });
      this.root = uri.startsWith('file://') ? decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/+$/, '') : null;
    } catch {
      this.root = null;
    }
    return this.root;
  }

  async list(path: string): Promise<Entry[]> {
    try {
      const { files } = await Filesystem.readdir({ directory: Directory.Documents, path });
      return files
        .filter((f) => !isHiddenEntry(f.name))
        .map((f) => ({
          name: f.name,
          path: join(path, f.name),
          type: f.type === 'directory' ? 'directory' : 'file',
          size: f.size ?? 0,
          mtime: f.mtime ?? 0,
        }));
    } catch (error) {
      throw new FileError(`Cannot list "${path || 'workspace'}": ${(error as Error).message}`, codeOf(error));
    }
  }

  async stat(path: string): Promise<Entry | null> {
    try {
      const s = await Filesystem.stat({ directory: Directory.Documents, path });
      return { name: basename(path), path, type: s.type === 'directory' ? 'directory' : 'file', size: s.size ?? 0, mtime: s.mtime ?? 0 };
    } catch {
      return null;
    }
  }

  async read(path: string): Promise<{ text: string; mtime: number }> {
    try {
      const [{ data }, info] = await Promise.all([
        Filesystem.readFile({ directory: Directory.Documents, path, encoding: Encoding.UTF8 }),
        this.stat(path),
      ]);
      return { text: typeof data === 'string' ? data : await (data as Blob).text(), mtime: info?.mtime ?? 0 };
    } catch (error) {
      throw new FileError(`Cannot open "${path}": ${(error as Error).message}`, codeOf(error));
    }
  }

  async write(path: string, text: string, options: { expectedMtime?: number | null; overwrite?: boolean } = {}): Promise<{ mtime: number }> {
    const existing = await this.stat(path);
    if (existing && options.overwrite === false) throw new FileError(`"${basename(path)}" already exists.`, 'EXISTS');
    if (existing && options.expectedMtime != null && Math.abs(existing.mtime - options.expectedMtime) > 1) {
      throw new FileError(`"${basename(path)}" was changed by another app since it was opened.`, 'CONFLICT');
    }
    const temp = join(dirname(path), `.${basename(path)}.zinia-save`);
    try {
      await Filesystem.writeFile({ directory: Directory.Documents, path: temp, data: text, encoding: Encoding.UTF8, recursive: true });
      try {
        await Filesystem.rename({ directory: Directory.Documents, from: temp, to: path, toDirectory: Directory.Documents });
      } catch {
        // Some implementations refuse to rename over an existing file.
        await Filesystem.writeFile({ directory: Directory.Documents, path, data: text, encoding: Encoding.UTF8, recursive: true });
        await Filesystem.deleteFile({ directory: Directory.Documents, path: temp }).catch(() => undefined);
      }
    } catch (error) {
      throw new FileError(`Cannot save "${path}": ${(error as Error).message}`, codeOf(error));
    }
    return { mtime: (await this.stat(path))?.mtime ?? Date.now() };
  }

  async mkdir(path: string): Promise<void> {
    try {
      await Filesystem.mkdir({ directory: Directory.Documents, path, recursive: true });
    } catch (error) {
      throw new FileError(`Cannot create folder "${path}": ${(error as Error).message}`, codeOf(error));
    }
  }

  async remove(path: string): Promise<void> {
    if (!path) throw new FileError('Refusing to delete the workspace itself.', 'INVALID_PATH');
    const info = await this.stat(path);
    if (!info) return;
    try {
      if (info.type === 'directory') await Filesystem.rmdir({ directory: Directory.Documents, path, recursive: true });
      else await Filesystem.deleteFile({ directory: Directory.Documents, path });
    } catch (error) {
      throw new FileError(`Cannot delete "${path}": ${(error as Error).message}`, codeOf(error));
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (await this.stat(to)) throw new FileError(`"${basename(to)}" already exists.`, 'EXISTS');
    try {
      await Filesystem.rename({ directory: Directory.Documents, from, to, toDirectory: Directory.Documents });
    } catch (error) {
      throw new FileError(`Cannot rename "${from}": ${(error as Error).message}`, codeOf(error));
    }
  }

  async copy(from: string, to: string): Promise<void> {
    if (await this.stat(to)) throw new FileError(`"${basename(to)}" already exists.`, 'EXISTS');
    try {
      await Filesystem.copy({ directory: Directory.Documents, from, to, toDirectory: Directory.Documents });
    } catch (error) {
      throw new FileError(`Cannot copy "${from}": ${(error as Error).message}`, codeOf(error));
    }
  }
}

/**
 * A folder handled by the native ZiniaFiles plugin: user-selected folders
 * (security-scoped, possibly iCloud Drive or another provider). In the
 * desktop development bridge this provider also serves the workspace.
 */
export class NativeFolderProvider implements FileProvider {
  constructor(readonly rootId: string, private rootPath: string | null) {}

  async absoluteRoot(): Promise<string | null> {
    if (this.rootPath == null && this.rootId === 'workspace') {
      this.rootPath = (await ZiniaFiles.getWorkspace()).path;
    }
    return this.rootPath;
  }

  private async wrap<T>(what: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw new FileError(`${what}: ${(error as Error).message}`, codeOf(error));
    }
  }

  async list(path: string): Promise<Entry[]> {
    const { entries } = await this.wrap(`Cannot list "${path || '/'}"`, () => ZiniaFiles.list({ root: this.rootId, path }));
    return entries.filter((e) => !isHiddenEntry(e.name)).map((e) => ({ ...e, path: join(path, e.name) }));
  }

  async stat(path: string): Promise<Entry | null> {
    try {
      const s = await ZiniaFiles.stat({ root: this.rootId, path });
      return { name: basename(path), path, type: s.type, size: s.size, mtime: s.mtime };
    } catch {
      return null;
    }
  }

  async read(path: string) {
    const r = await this.wrap(`Cannot open "${path}"`, () => ZiniaFiles.readText({ root: this.rootId, path }));
    return { text: r.data, mtime: r.mtime };
  }

  async write(path: string, text: string, options: { expectedMtime?: number | null; overwrite?: boolean } = {}) {
    return this.wrap(`Cannot save "${path}"`, () =>
      ZiniaFiles.writeText({
        root: this.rootId,
        path,
        data: text,
        expectedMtime: options.expectedMtime ?? undefined,
        overwrite: options.overwrite ?? true,
      }),
    );
  }

  mkdir(path: string) { return this.wrap(`Cannot create "${path}"`, () => ZiniaFiles.mkdir({ root: this.rootId, path, recursive: true })); }
  remove(path: string) {
    if (!path) return Promise.reject(new FileError('Refusing to delete the folder root.', 'INVALID_PATH'));
    return this.wrap(`Cannot delete "${path}"`, () => ZiniaFiles.remove({ root: this.rootId, path }));
  }
  rename(from: string, to: string) { return this.wrap(`Cannot rename "${from}"`, () => ZiniaFiles.rename({ root: this.rootId, from, to })); }
  copy(from: string, to: string) { return this.wrap(`Cannot copy "${from}"`, () => ZiniaFiles.copy({ root: this.rootId, from, to })); }
}
