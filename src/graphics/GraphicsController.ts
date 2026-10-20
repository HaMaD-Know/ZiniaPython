/**
 * Connects zinia_draw / zinia_3d in the Python runtime to the preview.
 *
 * Python -> preview: the native plugin emits a "graphics" event per batch:
 *   {"executionId", "surface": "2d" | "3d", "seq", "commands": [...]}
 * Batches are applied in arrival order (the plugin delivers them on the main
 * queue in the order Python flushed them). Batches from any execution other
 * than the current script run (or a REPL statement since it started) are
 * dropped, so a late batch from a stopped program never draws over a new one.
 *
 * Preview -> Python: pointer/key/tap events and "frame drawn" acknowledgements
 * are queued and posted once per animation frame with postGraphicsEvents.
 * The animation loop in Python waits for each acknowledgement, which keeps it
 * at the speed the preview can actually draw.
 */

export type Surface = '2d' | '3d';

export interface GraphicsPayload {
  executionId: string;
  surface: Surface;
  seq: number;
  commands: unknown[];
}

export interface GraphicsHost {
  /** A run started drawing on a surface: show the preview in that mode. */
  activate(surface: Surface): void;
  /** Apply 2D commands. */
  draw2D(commands: unknown[]): void;
  /** Apply 3D commands; call `rendered` once they are on screen. */
  draw3D(commands: unknown[], rendered: () => void): void;
  /** A new script run started: clear both surfaces. */
  reset(): void;
}

export type EventPoster = (executionId: string, events: string) => Promise<unknown>;

export type UIEvent = Record<string, unknown> & { type: string; surface: Surface };

const MAX_QUEUED = 500;

export class GraphicsController {
  /** Executions whose batches are drawn (the current run plus later REPL statements). */
  private accepted = new Set<string>();
  /** The execution currently running (events are posted only to it). */
  private live: string | null = null;
  private queue: UIEvent[] = [];
  private scheduled = false;
  private surfaceOfRun: Surface | null = null;
  dropped = 0;
  onError: ((message: string) => void) | null = null;

  constructor(
    private host: GraphicsHost,
    private post: EventPoster,
    private schedule: (cb: () => void) => void = (cb) => requestAnimationFrame(() => cb()),
  ) {}

  /** A script run is starting. */
  beginRun(executionId: string): void {
    this.accepted = new Set([executionId]);
    this.live = executionId;
    this.queue = [];
    this.surfaceOfRun = null;
    this.host.reset();
  }

  /** A REPL statement is starting: it may draw on the current picture. */
  beginRepl(executionId: string): void {
    this.accepted.add(executionId);
    if (this.accepted.size > 200) this.accepted.delete(this.accepted.values().next().value as string);
    this.live = executionId;
    this.queue = [];
    this.surfaceOfRun = null;
  }

  endRun(executionId: string): void {
    if (this.live === executionId) {
      this.live = null;
      this.queue = [];
    }
  }

  get liveExecution(): string | null {
    return this.live;
  }

  /** Handle one "graphics" event from the plugin. */
  handlePayload(json: string): void {
    let payload: GraphicsPayload;
    try {
      payload = JSON.parse(json) as GraphicsPayload;
    } catch {
      this.onError?.('A drawing batch could not be read.');
      return;
    }
    if (!payload || !this.accepted.has(payload.executionId) || !Array.isArray(payload.commands)) {
      this.dropped += 1;
      return;
    }
    const surface: Surface = payload.surface === '3d' ? '3d' : '2d';
    if (this.surfaceOfRun !== surface) {
      this.surfaceOfRun = surface;
      this.host.activate(surface);
    }
    const ack = () => this.push({ type: 'ack', seq: payload.seq, surface }, payload.executionId);
    if (surface === '2d') {
      this.host.draw2D(payload.commands);
      ack();
    } else {
      this.host.draw3D(payload.commands, ack);
    }
  }

  /** Queue an input event for the running program. */
  pushEvent(event: UIEvent): void {
    if (this.live) this.push(event, this.live);
  }

  private push(event: UIEvent, executionId: string): void {
    if (executionId !== this.live) return;
    if (event.type === 'move') {
      // Only the latest position of each pointer matters within one frame.
      const index = this.queue.findIndex((e) => e.type === 'move' && e.id === event.id && e.surface === event.surface);
      if (index >= 0) this.queue.splice(index, 1);
    }
    if (event.type === 'ack') {
      this.queue = this.queue.filter((e) => !(e.type === 'ack' && e.surface === event.surface));
    }
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    if (!this.live || this.queue.length === 0) {
      this.queue = [];
      return;
    }
    const events = JSON.stringify(this.queue);
    this.queue = [];
    this.post(this.live, events).catch(() => {
      // The run ended in the meantime; nothing is waiting for these events.
    });
  }
}
