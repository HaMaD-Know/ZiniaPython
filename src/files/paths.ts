/**
 * POSIX-style path helpers for root-relative paths ("MyProject/main.py").
 * Root-relative paths never start with "/" and never contain "..".
 */

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error(`Path escapes its root: ${path}`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

export function join(...segments: string[]): string {
  return normalize(segments.filter((s) => s !== '').join('/'));
}

export function dirname(path: string): string {
  const n = normalize(path);
  const i = n.lastIndexOf('/');
  return i === -1 ? '' : n.slice(0, i);
}

export function basename(path: string): string {
  const n = normalize(path);
  const i = n.lastIndexOf('/');
  return i === -1 ? n : n.slice(i + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function stem(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** True if `child` equals `parent` or lies inside it. */
export function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (p === '') return true;
  return c === p || c.startsWith(p + '/');
}

/** Path of `child` relative to `parent`, or null if it is not inside. */
export function relative(child: string, parent: string): string | null {
  const c = normalize(child);
  const p = normalize(parent);
  if (!isInside(c, p)) return null;
  return p === '' ? c : c.slice(p.length).replace(/^\//, '');
}

const INVALID_NAME = /[\\/:*?"<>|]/;
const hasControlCharacter = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** Validates a single file or folder name typed by the user. */
export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved.';
  if (INVALID_NAME.test(trimmed) || hasControlCharacter(trimmed)) return 'Names cannot contain / \\ : * ? " < > | or control characters.';
  if (trimmed.length > 200) return 'Use a name shorter than 200 characters.';
  return null;
}

/** "notes.txt" -> "notes copy.txt", "notes copy.txt" -> "notes copy 2.txt". */
export function copyName(name: string, existing: Set<string>): string {
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = `${base} copy${ext}`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${base} copy ${n}${ext}`;
    n += 1;
  }
  return candidate;
}

/** Joins an absolute directory with a root-relative path. */
export function toAbsolute(rootAbsolute: string, rel: string): string {
  const base = rootAbsolute.replace(/\/+$/, '');
  const r = normalize(rel);
  return r ? `${base}/${r}` : base;
}

/** Converts an absolute path back to a root-relative one, or null. */
export function fromAbsolute(rootAbsolute: string, absolute: string): string | null {
  // iOS reports the app container as both /var/... and /private/var/...; the
  // desktop development bridge on Windows reports backslash-separated paths.
  const strip = (p: string) => p.replace(/\\/g, '/').replace(/^\/private(?=\/var\/)/, '').replace(/\/+$/, '');
  const root = strip(rootAbsolute);
  const abs = strip(absolute);
  if (abs === root) return '';
  if (!abs.startsWith(root + '/')) return null;
  try {
    return normalize(abs.slice(root.length + 1));
  } catch {
    return null;
  }
}

export function isPythonFile(path: string): boolean {
  return extname(path) === '.py' || extname(path) === '.pyw';
}

const TEXT_EXTENSIONS = new Set([
  '.py', '.pyw', '.pyi', '.txt', '.md', '.json', '.csv', '.tsv', '.toml', '.cfg', '.ini', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.js', '.ts', '.sql', '.log', '.rst', '.sh', '.env', '.gitignore', '',
]);

export function isProbablyText(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
