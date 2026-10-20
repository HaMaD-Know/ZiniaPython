/**
 * Small key-value store on IndexedDB for preferences, session state, recovery
 * drafts of unsaved buffers, recent files and package metadata. Everything
 * stays on the device. Falls back to memory if IndexedDB is unavailable.
 */

const DB_NAME = 'ziniapython';
const STORE = 'kv';
const VERSION = 1;

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
}

class MemoryStore implements KeyValueStore {
  private map = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.map.get(key)) as T | undefined; }
  async set<T>(key: string, value: T) { this.map.set(key, structuredClone(value)); }
  async delete(key: string) { this.map.delete(key); }
  async keys(prefix = '') { return [...this.map.keys()].filter((k) => k.startsWith(prefix)); }
  async clear(prefix = '') { for (const k of await this.keys(prefix)) this.map.delete(k); }
}

class IndexedDbStore implements KeyValueStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor(factory: IDBFactory) {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
  }

  private async run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.dbPromise;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = body(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  get<T>(key: string) { return this.run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>); }
  async set<T>(key: string, value: T) { await this.run('readwrite', (s) => s.put(value, key)); }
  async delete(key: string) { await this.run('readwrite', (s) => s.delete(key)); }
  async keys(prefix = '') {
    const all = (await this.run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) as string[];
    return all.filter((k) => typeof k === 'string' && k.startsWith(prefix));
  }
  async clear(prefix = '') {
    for (const key of await this.keys(prefix)) await this.delete(key);
  }
}

function createStore(): KeyValueStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbStore(indexedDB);
  } catch {
    // fall through
  }
  return new MemoryStore();
}

export const storage: KeyValueStore = createStore();
export { MemoryStore };
