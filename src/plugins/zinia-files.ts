import { registerPlugin, WebPlugin } from '@capacitor/core';
import { DEV_BRIDGE } from './dev-bridge-flag';

export interface FolderInfo {
  id: string;
  name: string;
  path: string;
  available: boolean;
  stale: boolean;
  open: boolean;
  addedAt: number;
}

export interface NativeEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  downloaded?: boolean;
}

/** Root identifiers: "workspace" or "ext:<folder id>". */
export interface ZiniaFilesPlugin {
  getWorkspace(): Promise<{ path: string; uri: string; sitePackages: string; temporary: string }>;
  pickFolder(): Promise<{ cancelled: boolean; id?: string; name?: string; path?: string }>;
  listFolders(): Promise<{ folders: FolderInfo[] }>;
  openFolder(options: { id: string }): Promise<{ id: string; name: string; path: string; stale: boolean }>;
  closeFolder(options: { id: string }): Promise<void>;
  forgetFolder(options: { id: string }): Promise<void>;
  importFiles(options: { destination: string }): Promise<{ cancelled: boolean; imported: { name: string; path: string }[]; failed?: { name: string; error: string }[] }>;
  exportFile(options: { root: string; path: string }): Promise<{ cancelled: boolean; exported: boolean }>;
  list(options: { root: string; path: string }): Promise<{ entries: NativeEntry[] }>;
  stat(options: { root: string; path: string }): Promise<{ type: 'file' | 'directory'; size: number; mtime: number; path: string }>;
  readText(options: { root: string; path: string }): Promise<{ data: string; mtime: number }>;
  writeText(options: { root: string; path: string; data: string; expectedMtime?: number; overwrite?: boolean }): Promise<{ mtime: number }>;
  mkdir(options: { root: string; path: string; recursive?: boolean }): Promise<void>;
  remove(options: { root: string; path: string }): Promise<void>;
  rename(options: { root: string; from: string; to: string }): Promise<void>;
  copy(options: { root: string; from: string; to: string }): Promise<void>;
}

const PICKER_ONLY_ON_IOS = 'Apple\'s document picker is only available in the iOS app.';

class ZiniaFilesWeb extends WebPlugin {
  private async forward<T>(method: string, options: unknown): Promise<T> {
    if (import.meta.env.DEV && DEV_BRIDGE) {
      const { devPost } = await import('./dev-bridge-client');
      return devPost<T>(`files/${method}`, options);
    }
    throw this.unavailable(PICKER_ONLY_ON_IOS);
  }
  getWorkspace() { return this.forward('getWorkspace', {}); }
  async pickFolder(): Promise<never> { throw this.unavailable(PICKER_ONLY_ON_IOS); }
  async listFolders() { return { folders: [] }; }
  async openFolder(): Promise<never> { throw this.unavailable(PICKER_ONLY_ON_IOS); }
  async closeFolder() { /* nothing is open in a browser */ }
  async forgetFolder() { /* nothing is stored in a browser */ }
  async importFiles(): Promise<never> { throw this.unavailable(PICKER_ONLY_ON_IOS); }
  async exportFile(): Promise<never> { throw this.unavailable(PICKER_ONLY_ON_IOS); }
  list(o: unknown) { return this.forward('list', o); }
  stat(o: unknown) { return this.forward('stat', o); }
  readText(o: unknown) { return this.forward('readText', o); }
  writeText(o: unknown) { return this.forward('writeText', o); }
  mkdir(o: unknown) { return this.forward('mkdir', o); }
  remove(o: unknown) { return this.forward('remove', o); }
  rename(o: unknown) { return this.forward('rename', o); }
  copy(o: unknown) { return this.forward('copy', o); }
}

export const ZiniaFiles = registerPlugin<ZiniaFilesPlugin>('ZiniaFiles', {
  web: () => new ZiniaFilesWeb() as unknown as ZiniaFilesPlugin,
});
