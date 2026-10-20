/**
 * Contract tests for PythonService against a MOCKED native plugin.
 *
 * These tests check how the web UI drives the plugin (lifecycle, one run at a
 * time, interrupts, output routing, start-up diagnostics). They do not run
 * Python: the real interpreter is covered by python/tests (desktop CPython)
 * and by the simulator self-test in CI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PythonExecutionResult } from '../../src/types/python';

type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener>();
const plugin = {
  initialize: vi.fn(),
  execute: vi.fn(),
  replExecute: vi.fn(),
  interrupt: vi.fn(),
  provideInput: vi.fn(),
  resetInterpreter: vi.fn(),
  getRuntimeInfo: vi.fn(),
  addListener: vi.fn(async (name: string, fn: Listener) => {
    listeners.set(name, fn);
    return { remove: async () => listeners.delete(name) };
  }),
};
vi.mock('../../src/plugins/zinia-python', () => ({ ZiniaPython: plugin }));

const { PythonService } = await import('../../src/services/python');
const { DiagnosticsLog } = await import('../../src/services/diagnostics');
const { MemoryStore } = await import('../../src/services/storage');

const okResult = (executionId: string): PythonExecutionResult => ({
  executionId, status: 'ok', exitCode: null, durationMs: 3, error: null, outputChars: 6, truncated: false,
});

function service(timeout = 0) {
  return new PythonService(new DiagnosticsLog(new MemoryStore()), () => timeout);
}

describe('PythonService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    plugin.initialize.mockResolvedValue({ pythonVersion: '3.14.8', implementation: 'CPython' });
  });

  it('starts the runtime and becomes ready', async () => {
    const py = service();
    await py.start();
    expect(py.machine.current.state).toBe('ready');
    expect(py.info?.pythonVersion).toBe('3.14.8');
  });

  it('reports a start-up failure as a fatal diagnostic (test 15)', async () => {
    plugin.initialize.mockRejectedValue({
      message: 'The Python standard library (python3.14) is missing from the app bundle.',
      code: 'STDLIB_MISSING',
      data: { missingPaths: ['/App.app/python/lib/python3.14/os.py'], retryable: true },
    });
    const py = service();
    await py.start();
    expect(py.machine.current.state).toBe('failed');
    expect(py.machine.current.fatal).toBe(true);
    expect(py.canRun).toBe(false);
    expect(py.startError?.code).toBe('STDLIB_MISSING');
    expect(py.startError?.data?.missingPaths).toEqual(['/App.app/python/lib/python3.14/os.py']);
    await expect(py.runScript({ code: 'print(1)' }, { onOutput() {}, onInputRequest() {} }, 'x')).rejects.toMatchObject({ code: 'BUSY' });
    expect(plugin.execute).not.toHaveBeenCalled();
  });

  it('never simulates execution when the plugin is unavailable', async () => {
    plugin.initialize.mockRejectedValue({ message: 'no runtime in a browser', code: 'UNAVAILABLE' });
    const py = service();
    await py.start();
    expect(py.machine.current.state).toBe('unavailable');
    await expect(py.runScript({ code: 'print(1)' }, { onOutput() {}, onInputRequest() {} }, 'x')).rejects.toBeTruthy();
    expect(plugin.execute).not.toHaveBeenCalled();
  });

  it('routes streamed output to the run that produced it', async () => {
    const py = service();
    await py.start();
    const seen: string[] = [];
    const background: string[] = [];
    py.onBackgroundOutput = (_s, text) => background.push(text);
    plugin.execute.mockImplementation(async ({ executionId }: { executionId: string }) => {
      listeners.get('output')?.({ chunks: [
        { executionId, stream: 'stdout', text: 'hello\n' },
        { executionId: '', stream: 'stderr', text: 'from a thread\n' },
      ] });
      return okResult(executionId);
    });
    const result = await py.runScript({ code: 'print("hello")' }, { onOutput: (_s, t) => seen.push(t), onInputRequest() {} }, 'main.py');
    expect(result.status).toBe('ok');
    expect(seen).toEqual(['hello\n']);
    expect(background).toEqual(['from a thread\n']);
    expect(py.machine.current.state).toBe('completed');
  });

  it('allows only one run at a time', async () => {
    const py = service();
    await py.start();
    let finish: (r: PythonExecutionResult) => void = () => {};
    plugin.execute.mockImplementation(({ executionId }: { executionId: string }) => new Promise((resolve) => {
      finish = () => resolve(okResult(executionId));
    }));
    const first = py.runScript({ code: 'while True: pass' }, { onOutput() {}, onInputRequest() {} }, 'loop.py');
    await expect(py.runScript({ code: 'print(2)' }, { onOutput() {}, onInputRequest() {} }, 'b.py')).rejects.toMatchObject({ code: 'BUSY' });
    finish(okResult('x'));
    await first;
    expect(plugin.execute).toHaveBeenCalledTimes(1);
  });

  it('interrupts the active run and reflects it in the lifecycle (test 11)', async () => {
    const py = service();
    await py.start();
    let finish: () => void = () => {};
    plugin.execute.mockImplementation(({ executionId }: { executionId: string }) => new Promise((resolve) => {
      finish = () => resolve({ ...okResult(executionId), status: 'interrupted' });
    }));
    plugin.interrupt.mockResolvedValue({ interrupted: true, mechanism: 'keyboard-interrupt+signal' });
    const run = py.runScript({ code: 'while True: pass' }, { onOutput() {}, onInputRequest() {} }, 'loop.py');
    expect(py.canInterrupt).toBe(true);
    const mechanism = await py.interrupt();
    expect(mechanism).toBe('keyboard-interrupt+signal');
    expect(py.machine.current.state).toBe('interrupt-requested');
    expect(plugin.interrupt.mock.calls[0][0].executionId).toMatch(/^run-/);
    finish();
    expect((await run).status).toBe('interrupted');
    expect(py.machine.current.state).toBe('completed');
  });

  it('applies the run timeout by interrupting', async () => {
    vi.useFakeTimers();
    try {
      const py = service(5);
      await py.start();
      let finish: () => void = () => {};
      plugin.execute.mockImplementation(({ executionId }: { executionId: string }) => new Promise((resolve) => {
        finish = () => resolve({ ...okResult(executionId), status: 'interrupted' });
      }));
      plugin.interrupt.mockResolvedValue({ interrupted: true, mechanism: 'keyboard-interrupt' });
      const run = py.runScript({ code: 'import time; time.sleep(60)' }, { onOutput() {}, onInputRequest() {} }, 'slow.py');
      await vi.advanceTimersByTimeAsync(5000);
      expect(plugin.interrupt).toHaveBeenCalledTimes(1);
      finish();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards input requests to the observer and input back to the plugin', async () => {
    const py = service();
    await py.start();
    plugin.provideInput.mockResolvedValue({ accepted: true });
    let requested = false;
    plugin.execute.mockImplementation(async ({ executionId }: { executionId: string }) => {
      listeners.get('inputRequest')?.({ executionId });
      expect(requested).toBe(true);
      expect(await py.provideInput(executionId, 'Ada')).toBe(true);
      return okResult(executionId);
    });
    await py.runScript({ code: 'input()' }, { onOutput() {}, onInputRequest: () => { requested = true; } }, 'ask.py');
    expect(plugin.provideInput.mock.calls[0][0]).toMatchObject({ text: 'Ada' });
  });

  it('turns plugin rejections into failed runs that can be retried', async () => {
    const py = service();
    await py.start();
    plugin.execute.mockRejectedValueOnce({ message: 'cwd outside workspace', code: 'PATH_NOT_ALLOWED' });
    await expect(py.runScript({ code: '1' }, { onOutput() {}, onInputRequest() {} }, 'x')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    expect(py.machine.current.state).toBe('failed');
    expect(py.canRun).toBe(true);
    plugin.execute.mockImplementation(async ({ executionId }: { executionId: string }) => okResult(executionId));
    expect((await py.runScript({ code: '1' }, { onOutput() {}, onInputRequest() {} }, 'x')).status).toBe('ok');
  });
});
