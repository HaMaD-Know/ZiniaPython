import type { PluginListenerHandle } from '@capacitor/core';
import { ZiniaPython } from '../plugins/zinia-python';
import type {
  ExecuteOptions,
  OutputStreamName,
  PluginErrorShape,
  PythonExecutionResult,
  PythonRuntimeInfo,
} from '../types/python';
import { RuntimeMachine } from './runtimeMachine';
import type { DiagnosticsLog } from './diagnostics';

export interface RunObserver {
  onOutput(stream: OutputStreamName, text: string): void;
  onInputRequest(): void;
}

export class RuntimeError extends Error {
  code: string;
  data?: Record<string, unknown>;
  constructor(shape: PluginErrorShape) {
    super(shape.message);
    this.code = shape.code ?? 'UNKNOWN';
    this.data = shape.data;
  }
}

export function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  const e = error as { message?: string; code?: string; data?: Record<string, unknown> };
  return new RuntimeError({ message: e?.message ?? String(error), code: e?.code, data: e?.data });
}

let idCounter = 0;
export function newExecutionId(prefix = 'run'): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Owns the connection to the native runtime: start-up, the lifecycle state
 * machine, one execution at a time, output/input routing, and timeouts.
 */
export class PythonService {
  readonly machine = new RuntimeMachine();
  info: PythonRuntimeInfo | null = null;
  startError: RuntimeError | null = null;
  /** Output that arrived for no active run (for example from a background thread). */
  onBackgroundOutput: ((stream: OutputStreamName, text: string) => void) | null = null;

  private observers = new Map<string, RunObserver>();
  private handles: PluginListenerHandle[] = [];
  private interruptible = false;

  constructor(private diagnostics: DiagnosticsLog, private timeoutSeconds: () => number) {}

  async start(): Promise<void> {
    if (this.handles.length === 0) await this.attachListeners();
    if (this.machine.current.state === 'initializing') return;
    this.machine.transition('initializing');
    const started = performance.now();
    try {
      this.info = await ZiniaPython.initialize();
      this.startError = null;
      this.machine.transition('ready');
      this.diagnostics.record('info', 'runtime.ready', {
        python: this.info.pythonVersion,
        ms: Math.round(performance.now() - started),
        devBridge: Boolean(this.info.devBridge),
      });
    } catch (error) {
      const err = toRuntimeError(error);
      this.startError = err;
      if (err.code === 'UNAVAILABLE') {
        this.machine.transition('unavailable', { fatal: true });
      } else {
        this.machine.transition('failed', { fatal: true });
      }
      this.diagnostics.record('error', 'runtime.start-failed', { code: err.code, message: err.message.slice(0, 300) });
    }
  }

  private async attachListeners(): Promise<void> {
    try {
      this.handles.push(
        await ZiniaPython.addListener('output', ({ chunks }) => {
          for (const chunk of chunks) {
            const observer = this.observers.get(chunk.executionId);
            if (observer) observer.onOutput(chunk.stream, chunk.text);
            else this.onBackgroundOutput?.(chunk.stream, chunk.text);
          }
        }),
      );
      this.handles.push(
        await ZiniaPython.addListener('inputRequest', ({ executionId }) => {
          this.observers.get(executionId)?.onInputRequest();
        }),
      );
    } catch {
      // The web build without a runtime has no events; start() reports why.
    }
  }

  get canRun(): boolean {
    return this.machine.canRun;
  }

  get canInterrupt(): boolean {
    return this.machine.current.state === 'running' && this.interruptible;
  }

  /** Runs a script. Resolves with the structured result, rejects for plugin errors. */
  async runScript(
    options: Omit<ExecuteOptions, 'executionId'>,
    observer: RunObserver,
    label: string,
    executionId: string = newExecutionId('run'),
  ): Promise<PythonExecutionResult> {
    return this.track(executionId, label, true, observer, () => ZiniaPython.execute({ ...options, executionId }), true);
  }

  async runRepl(source: string, mode: 'line' | 'block', cwd: string | undefined, projectRoot: string | undefined, observer: RunObserver): Promise<PythonExecutionResult> {
    const executionId = newExecutionId('repl');
    return this.track(executionId, 'REPL', true, observer, () =>
      ZiniaPython.replExecute({ executionId, source, mode, workingDirectory: cwd, projectRoot }), false);
  }

  /** Non-interruptible work on the interpreter thread (packages, self-test). */
  async runTask<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (!this.canRun) throw new RuntimeError({ message: this.busyMessage(), code: 'BUSY' });
    this.interruptible = false;
    this.machine.transition('running', { executionId: null, startedAt: Date.now(), label });
    try {
      const result = await task();
      this.machine.transition('completed');
      return result;
    } catch (error) {
      this.machine.transition('failed', { fatal: false });
      throw toRuntimeError(error);
    }
  }

  private busyMessage(): string {
    const s = this.machine.current;
    if (s.fatal) return this.startError?.message ?? 'The Python runtime is not available.';
    if (s.state === 'initializing' || s.state === 'not-initialized') return 'Python is still starting.';
    return `Python is busy (${s.label ?? 'running'}). Stop it or wait for it to finish.`;
  }

  private async track(
    executionId: string,
    label: string,
    interruptible: boolean,
    observer: RunObserver,
    call: () => Promise<PythonExecutionResult>,
    applyTimeout: boolean,
  ): Promise<PythonExecutionResult> {
    if (!this.canRun) throw new RuntimeError({ message: this.busyMessage(), code: 'BUSY' });
    this.interruptible = interruptible;
    this.observers.set(executionId, observer);
    this.machine.transition('running', { executionId, startedAt: Date.now(), label });
    const limit = applyTimeout ? this.timeoutSeconds() : 0;
    const timer = limit > 0 ? setTimeout(() => void this.interrupt('timeout'), limit * 1000) : null;
    try {
      const result = await call();
      this.machine.transition(result.status === 'error' ? 'failed' : 'completed', { fatal: false });
      if (label !== 'REPL') {
        this.diagnostics.record('info', 'run.finished', {
          status: result.status,
          ms: Math.round(result.durationMs),
          errorType: result.error?.type ?? null,
          outputChars: result.outputChars,
        });
      }
      return result;
    } catch (error) {
      const err = toRuntimeError(error);
      this.machine.transition('failed', { fatal: false });
      this.diagnostics.record('error', 'run.plugin-error', { code: err.code, message: err.message.slice(0, 300) });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      // Keep the observer briefly: the last output batch is delivered before
      // the promise resolves, but late background writes should not be lost.
      setTimeout(() => this.observers.delete(executionId), 2000);
    }
  }

  async interrupt(reason: 'user' | 'timeout' = 'user'): Promise<string> {
    const s = this.machine.current;
    if (s.state !== 'running' || !s.executionId || !this.interruptible) return 'none';
    this.machine.transition('interrupt-requested');
    this.diagnostics.record('info', 'run.interrupt', { reason });
    try {
      const result = await ZiniaPython.interrupt({ executionId: s.executionId });
      return result.mechanism;
    } catch (error) {
      this.diagnostics.record('warn', 'run.interrupt-failed', { message: toRuntimeError(error).message.slice(0, 200) });
      return 'failed';
    }
  }

  async provideInput(executionId: string, text: string | null): Promise<boolean> {
    const result = await ZiniaPython.provideInput(text === null ? { executionId, eof: true } : { executionId, text });
    return result.accepted;
  }

  async resetInterpreter(): Promise<string[]> {
    const result = await this.runTask('Resetting interpreter', () => ZiniaPython.resetInterpreter());
    this.diagnostics.record('info', 'runtime.reset', { modules: result.modulesForgotten.length });
    return result.modulesForgotten;
  }

  async refreshInfo(): Promise<void> {
    try {
      const fresh = await ZiniaPython.getRuntimeInfo();
      if (this.info) this.info = { ...this.info, ...fresh } as PythonRuntimeInfo;
    } catch {
      // keep the last known info
    }
  }
}
