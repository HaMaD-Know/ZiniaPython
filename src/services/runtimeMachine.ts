import type { RuntimeLifecycle } from '../types/python';

/**
 * The runtime lifecycle from the specification, as an explicit state machine.
 *
 *   not-initialized -> initializing -> ready | failed | unavailable
 *   ready -> running -> interrupt-requested -> completed | failed
 *   completed | failed(run) -> ready
 *
 * "failed" covers two situations that the UI treats differently: a failed
 * start-up (`fatal`, a diagnostic panel is shown) and a failed run (the user
 * can edit and run again immediately).
 */
const TRANSITIONS: Record<RuntimeLifecycle, RuntimeLifecycle[]> = {
  'not-initialized': ['initializing', 'unavailable'],
  initializing: ['ready', 'failed', 'unavailable'],
  ready: ['running', 'initializing'],
  running: ['interrupt-requested', 'completed', 'failed'],
  'interrupt-requested': ['completed', 'failed'],
  completed: ['ready', 'running'],
  failed: ['ready', 'initializing', 'running'],
  unavailable: ['initializing'],
};

export class InvalidTransitionError extends Error {
  constructor(from: RuntimeLifecycle, to: RuntimeLifecycle) {
    super(`Invalid runtime transition: ${from} -> ${to}`);
  }
}

export interface RuntimeSnapshot {
  state: RuntimeLifecycle;
  /** True when start-up failed; the runtime cannot run code until fixed. */
  fatal: boolean;
  executionId: string | null;
  startedAt: number | null;
  label: string | null;
}

export class RuntimeMachine {
  private snapshot: RuntimeSnapshot = { state: 'not-initialized', fatal: false, executionId: null, startedAt: null, label: null };
  private listeners = new Set<(s: RuntimeSnapshot) => void>();

  get current(): RuntimeSnapshot {
    return this.snapshot;
  }

  canTransition(to: RuntimeLifecycle): boolean {
    return TRANSITIONS[this.snapshot.state].includes(to);
  }

  /** True when a new run may start (no run in progress, runtime started). */
  get canRun(): boolean {
    const s = this.snapshot;
    return !s.fatal && (s.state === 'ready' || s.state === 'completed' || (s.state === 'failed' && !s.fatal));
  }

  get isBusy(): boolean {
    return this.snapshot.state === 'running' || this.snapshot.state === 'interrupt-requested';
  }

  transition(to: RuntimeLifecycle, patch: Partial<Omit<RuntimeSnapshot, 'state'>> = {}): RuntimeSnapshot {
    if (!this.canTransition(to)) throw new InvalidTransitionError(this.snapshot.state, to);
    const next: RuntimeSnapshot = { ...this.snapshot, ...patch, state: to };
    if (to === 'ready' || to === 'initializing') {
      next.executionId = null;
      next.startedAt = null;
      next.label = null;
    }
    if (to === 'ready') next.fatal = false;
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  subscribe(listener: (s: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
}
