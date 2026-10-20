/**
 * Vite plugin: the desktop development bridge (development only).
 *
 * Enabled by `npm run dev:bridge` (Vite mode "bridge"). It starts
 * scripts/dev-bridge-worker.py with the computer's own Python and serves:
 *
 *   POST /__zinia_dev/python/<method>  ZiniaPython plugin calls
 *   POST /__zinia_dev/files/<method>   ZiniaFiles calls for the dev workspace
 *   GET  /__zinia_dev/events           server-sent events (output, input requests)
 *
 * Requests must carry the header "X-Zinia-Dev: 1", which browsers only send
 * from this origin, so other websites cannot use the bridge to run code.
 * Nothing here is included in `vite build` output or the iOS app.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

interface Pending {
  resolve: (value: unknown) => void;
}

export function ziniaDevBridge(repoRoot: string): Plugin {
  const workspace = path.join(repoRoot, '.dev-workspace');
  const sitePackages = path.join(repoRoot, '.dev-runtime', 'site-packages');
  let worker: ChildProcessWithoutNullStreams | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const clients = new Set<ServerResponse>();
  let busy = false;
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sitePackages, { recursive: true });

  const broadcast = (name: string, data: unknown) => {
    const payload = `data: ${JSON.stringify({ name, data })}\n\n`;
    for (const client of clients) client.write(payload);
  };

  const startWorker = () => {
    if (worker) return worker;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sitePackages, { recursive: true });
    const python = process.env.ZINIA_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    worker = spawn(python, ['-u', path.join(repoRoot, 'scripts', 'dev-bridge-worker.py'), repoRoot, workspace, sitePackages], {
      cwd: workspace,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    createInterface({ input: worker.stdout }).on('line', (line) => {
      let msg: { type: string; id?: number; name?: string; data?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[dev-bridge] ignored non-protocol output: ${line.slice(0, 200)}
`);
        return;
      }
      if (msg.type === 'event' && msg.name) broadcast(msg.name, msg.data);
      else if (msg.type === 'response' && msg.id !== undefined) {
        pending.get(msg.id)?.resolve(msg);
        pending.delete(msg.id);
      }
    });
    worker.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[dev-bridge] ${chunk}`));
    worker.on('exit', (code) => {
      process.stderr.write(`[dev-bridge] worker exited with code ${code}\n`);
      worker = null;
      busy = false;
      for (const p of pending.values()) p.resolve({ ok: false, error: { message: 'Python worker exited', code: 'INTERNAL' } });
      pending.clear();
    });
    return worker;
  };

  const send = (message: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      startWorker().stdin.write(JSON.stringify({ ...message, id }) + '\n');
    });

  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const json = (res: ServerResponse, body: unknown) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const resolveInWorkspace = (rel: unknown) => {
    const relative = typeof rel === 'string' ? rel : '';
    const target = path.resolve(workspace, relative);
    if (target !== workspace && !target.startsWith(workspace + path.sep)) throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
    return target;
  };

  const fileOps: Record<string, (o: Record<string, unknown>) => Promise<unknown>> = {
    getWorkspace: async () => ({ path: workspace.split(path.sep).join('/'), uri: '', sitePackages, temporary: '' }),
    list: async (o) => {
      const dir = resolveInWorkspace(o.path);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return {
        entries: await Promise.all(
          entries.map(async (e) => {
            const s = await fs.stat(path.join(dir, e.name));
            return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs };
          }),
        ),
      };
    },
    stat: async (o) => {
      const s = await fs.stat(resolveInWorkspace(o.path));
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs, path: String(o.path) };
    },
    readText: async (o) => {
      const p = resolveInWorkspace(o.path);
      return { data: await fs.readFile(p, 'utf8'), mtime: (await fs.stat(p)).mtimeMs };
    },
    writeText: async (o) => {
      const p = resolveInWorkspace(o.path);
      if (existsSync(p)) {
        if (o.overwrite === false) throw Object.assign(new Error('A file with that name already exists.'), { code: 'EXISTS' });
        const current = (await fs.stat(p)).mtimeMs;
        if (typeof o.expectedMtime === 'number' && Math.abs(current - o.expectedMtime) > 1) {
          throw Object.assign(new Error('The file was changed by another app since it was opened.'), { code: 'CONFLICT' });
        }
      }
      const temp = `${p}.zinia-tmp`;
      await fs.writeFile(temp, String(o.data ?? ''), 'utf8');
      await fs.rename(temp, p);
      return { mtime: (await fs.stat(p)).mtimeMs };
    },
    mkdir: async (o) => {
      await fs.mkdir(resolveInWorkspace(o.path), { recursive: true });
      return {};
    },
    remove: async (o) => {
      const p = resolveInWorkspace(o.path);
      if (p === workspace) throw Object.assign(new Error('Refusing to delete the workspace'), { code: 'INVALID_PATH' });
      await fs.rm(p, { recursive: true, force: true });
      return {};
    },
    rename: async (o) => {
      const to = resolveInWorkspace(o.to);
      if (existsSync(to)) throw Object.assign(new Error('Already exists'), { code: 'EXISTS' });
      await fs.rename(resolveInWorkspace(o.from), to);
      return {};
    },
    copy: async (o) => {
      const to = resolveInWorkspace(o.to);
      if (existsSync(to)) throw Object.assign(new Error('Already exists'), { code: 'EXISTS' });
      await fs.cp(resolveInWorkspace(o.from), to, { recursive: true });
      return {};
    },
  };

  const OUT_OF_BAND = new Set(['interrupt', 'provideInput', 'getRuntimeInfo', 'ping']);

  return {
    name: 'zinia-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.on('close', () => worker?.kill());
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/__zinia_dev/')) return next();
        if (url === '/__zinia_dev/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(': connected\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        if (req.method !== 'POST' || req.headers['x-zinia-dev'] !== '1') {
          res.statusCode = 403;
          return json(res, { ok: false, error: { message: 'Forbidden', code: 'FORBIDDEN' } });
        }
        const body = await readBody(req);
        const [, , kind, method] = url.split('?')[0].split('/');
        if (kind === 'files') {
          const op = fileOps[method];
          if (!op || (body.root !== undefined && body.root !== 'workspace')) {
            return json(res, { ok: false, error: { message: 'Only the workspace is available in the dev bridge', code: 'UNAVAILABLE' } });
          }
          try {
            return json(res, { ok: true, result: await op(body) });
          } catch (error) {
            const e = error as { message: string; code?: string };
            return json(res, { ok: false, error: { message: e.message, code: e.code === 'ENOENT' ? 'NOT_FOUND' : (e.code ?? 'IO_ERROR') } });
          }
        }
        if (kind !== 'python') return next();
        if (method === 'interrupt') return json(res, await send({ type: 'interrupt', executionId: body.executionId }));
        if (method === 'provideInput') {
          return json(res, await send({ type: 'input', executionId: body.executionId, text: body.eof ? null : (body.text ?? '') }));
        }
        if (!OUT_OF_BAND.has(method) && method !== 'initialize') {
          if (busy) return json(res, { ok: false, error: { message: 'Python is busy. Wait for it to finish or stop it first.', code: 'BUSY' } });
          busy = true;
        }
        try {
          return json(res, await send({ type: 'request', method, options: body }));
        } finally {
          if (!OUT_OF_BAND.has(method) && method !== 'initialize') busy = false;
        }
      });
    },
  };
}
