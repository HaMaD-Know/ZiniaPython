import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, RuntimeMachine } from '../../src/services/runtimeMachine';

describe('RuntimeMachine (specification section 12)', () => {
  it('follows the normal lifecycle', () => {
    const m = new RuntimeMachine();
    expect(m.current.state).toBe('not-initialized');
    expect(m.canRun).toBe(false);
    m.transition('initializing');
    m.transition('ready');
    expect(m.canRun).toBe(true);
    m.transition('running', { executionId: 'run-1', label: 'main.py', startedAt: 1 });
    expect(m.isBusy).toBe(true);
    expect(m.canRun).toBe(false);
    m.transition('interrupt-requested');
    m.transition('completed');
    expect(m.canRun).toBe(true);
    m.transition('running', { executionId: 'run-2' });
    m.transition('failed', { fatal: false });
    expect(m.canRun).toBe(true);
  });

  it('prevents overlapping runs', () => {
    const m = new RuntimeMachine();
    m.transition('initializing');
    m.transition('ready');
    m.transition('running', { executionId: 'a' });
    expect(() => m.transition('running', { executionId: 'b' })).toThrow(InvalidTransitionError);
  });

  it('treats a failed start-up as fatal', () => {
    const m = new RuntimeMachine();
    m.transition('initializing');
    m.transition('failed', { fatal: true });
    expect(m.canRun).toBe(false);
    m.transition('initializing');
    m.transition('ready');
    expect(m.canRun).toBe(true);
    expect(m.current.fatal).toBe(false);
  });

  it('reports an unavailable runtime (web preview) without allowing runs', () => {
    const m = new RuntimeMachine();
    m.transition('unavailable', { fatal: true });
    expect(m.canRun).toBe(false);
    expect(() => m.transition('running')).toThrow();
  });

  it('notifies subscribers', () => {
    const m = new RuntimeMachine();
    const seen: string[] = [];
    m.subscribe((s) => seen.push(s.state));
    m.transition('initializing');
    m.transition('ready');
    expect(seen).toEqual(['not-initialized', 'initializing', 'ready']);
  });
});
