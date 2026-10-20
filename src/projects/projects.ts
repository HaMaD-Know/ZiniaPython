import type { FileRef } from '../app/tabsModel';
import type { Workspace } from '../files/workspace';
import { dirname, join, normalize, validateName } from '../files/paths';

export interface ProjectRef {
  root: string;
  /** Root-relative folder of the project ("" when the root itself is the project). */
  path: string;
}

export interface LastRun {
  status: string;
  durationMs: number;
  at: number;
  errorType?: string;
}

export interface ProjectConfig {
  name: string;
  /** Entry point, relative to the project folder. */
  entry: string;
  /** "project": run in the project folder; "file": run in the folder of the file being run. */
  workingDirectory: 'project' | 'file';
  args: string[];
  lastRun?: LastRun;
}

export const CONFIG_PATH = '.zinia/project.json';

export function projectKey(p: ProjectRef): string {
  return `${p.root}::${p.path}`;
}

/** The project a file belongs to: its top-level workspace folder, or an opened folder's root. */
export function projectOf(ref: FileRef): ProjectRef | null {
  if (ref.root !== 'workspace') return { root: ref.root, path: '' };
  const first = normalize(ref.path).split('/')[0];
  if (!first || first === normalize(ref.path)) return null; // a loose file directly in the workspace
  return { root: ref.root, path: first };
}

export function defaultConfig(name: string, entry = 'main.py'): ProjectConfig {
  return { name, entry, workingDirectory: 'project', args: [] };
}

export function sanitizeConfig(raw: unknown, fallbackName: string, fallbackEntry: string): ProjectConfig {
  const config = defaultConfig(fallbackName, fallbackEntry);
  if (!raw || typeof raw !== 'object') return config;
  const r = raw as Record<string, unknown>;
  if (typeof r.name === 'string' && r.name.trim()) config.name = r.name.trim().slice(0, 100);
  if (typeof r.entry === 'string') {
    try {
      const entry = normalize(r.entry);
      if (entry.endsWith('.py')) config.entry = entry;
    } catch {
      // keep the default for paths that escape the project
    }
  }
  if (r.workingDirectory === 'file' || r.workingDirectory === 'project') config.workingDirectory = r.workingDirectory;
  if (Array.isArray(r.args)) config.args = r.args.filter((a): a is string => typeof a === 'string').slice(0, 64);
  if (r.lastRun && typeof r.lastRun === 'object') config.lastRun = r.lastRun as LastRun;
  return config;
}

export const STARTER_FILES: Record<string, string> = {
  'main.py': `"""Entry point of this project. Tap Run to execute it."""
import json
from pathlib import Path

from helpers import greet, summarize


def main() -> None:
    data = json.loads(Path("data/example.json").read_text(encoding="utf-8"))
    print(greet(data["name"]))
    print(summarize(data["languages"]))


if __name__ == "__main__":
    main()
`,
  'helpers.py': `"""A helper module imported by main.py."""


def greet(name: str) -> str:
    return f"Hello, {name}!"


def summarize(items: list[str]) -> str:
    return f"{len(items)} languages: " + ", ".join(sorted(items))
`,
  'README.md': `# {{name}}

Created with ZiniaPython.

- \`main.py\` is the entry point (Run executes it with this folder as the working directory).
- \`helpers.py\` shows how to import your own modules.
- \`data/example.json\` is read with a relative path.
`,
  'data/example.json': `{
  "name": "ZiniaPython",
  "languages": ["Python", "Swift", "TypeScript"]
}
`,
};

export class ProjectService {
  constructor(private workspace: Workspace, private defaultEntry: () => string) {}

  async listProjects(): Promise<ProjectRef[]> {
    const entries = await this.workspace.provider('workspace').list('');
    return entries.filter((e) => e.type === 'directory').map((e) => ({ root: 'workspace', path: e.path }));
  }

  async create(name: string, template: 'starter' | 'empty'): Promise<{ project: ProjectRef; entry: FileRef }> {
    const problem = validateName(name);
    if (problem) throw new Error(problem);
    const provider = this.workspace.provider('workspace');
    const folder = name.trim();
    if (await provider.stat(folder)) throw new Error(`A file or folder named "${folder}" already exists.`);
    await provider.mkdir(folder);
    const entryName = this.defaultEntry();
    const files: Record<string, string> =
      template === 'starter'
        ? Object.fromEntries(Object.entries(STARTER_FILES).map(([k, v]) => [k === 'main.py' ? entryName : k, v.replace('{{name}}', folder)]))
        : { [entryName]: 'print("Hello from ZiniaPython!")\n' };
    if (template === 'starter' && entryName !== 'main.py') {
      files['README.md'] = files['README.md'].replace('`main.py`', `\`${entryName}\``);
    }
    for (const [rel, text] of Object.entries(files)) {
      const path = join(folder, rel);
      const parent = dirname(path);
      if (parent !== folder) await provider.mkdir(parent);
      await provider.write(path, text, { overwrite: false });
    }
    const project = { root: 'workspace', path: folder };
    await this.saveConfig(project, defaultConfig(folder, entryName));
    return { project, entry: { root: 'workspace', path: join(folder, entryName) } };
  }

  async loadConfig(project: ProjectRef): Promise<ProjectConfig> {
    const provider = this.workspace.provider(project.root);
    const fallbackName = project.path || this.workspace.root(project.root).name;
    try {
      const { text } = await provider.read(join(project.path, CONFIG_PATH));
      return sanitizeConfig(JSON.parse(text), fallbackName, this.defaultEntry());
    } catch {
      return defaultConfig(fallbackName, this.defaultEntry());
    }
  }

  async saveConfig(project: ProjectRef, config: ProjectConfig): Promise<void> {
    const provider = this.workspace.provider(project.root);
    await provider.mkdir(join(project.path, '.zinia'));
    await provider.write(join(project.path, CONFIG_PATH), JSON.stringify(config, null, 2) + '\n');
  }

  async recordRun(project: ProjectRef, run: LastRun): Promise<void> {
    try {
      const config = await this.loadConfig(project);
      config.lastRun = run;
      await this.saveConfig(project, config);
    } catch {
      // read-only folders simply do not keep run history
    }
  }

  /** Absolute folder of the project, for Python's working directory and sys.path. */
  absoluteFolder(project: ProjectRef): string | null {
    return this.workspace.absolutePath({ root: project.root, path: project.path }) ?? null;
  }
}
