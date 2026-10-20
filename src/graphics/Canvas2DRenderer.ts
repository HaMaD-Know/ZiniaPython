/**
 * Renders zinia_draw commands onto an HTML canvas.
 *
 * Commands are compact arrays produced by python/zinia_draw.py, applied in the
 * order received. The commands since the last clear() are kept so the canvas
 * can be redrawn exactly after the panel is resized or the iPad rotates (a
 * resized canvas loses its pixels). The logical canvas (create_canvas size)
 * is scaled to fit the panel, keeping its aspect ratio, at the device pixel
 * ratio so lines and text stay sharp on Retina screens.
 */

export type DrawCommand = unknown[];

/** The subset of CanvasRenderingContext2D used here (lets tests pass a recorder). */
export type Context2D = Pick<
  CanvasRenderingContext2D,
  | 'setTransform' | 'fillRect' | 'clearRect' | 'beginPath' | 'arc' | 'ellipse' | 'rect' | 'moveTo' | 'lineTo'
  | 'closePath' | 'fill' | 'stroke' | 'fillText' | 'save' | 'restore'
> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  roundRect?: CanvasRenderingContext2D['roundRect'];
};

const FONTS: Record<string, string> = {
  'sans-serif': '-apple-system, system-ui, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  monospace: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

const MAX_RETAINED = 200_000;
const MAX_BACKING_PIXELS = 16_000_000;

export interface Fit {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  scale: number; // backing pixels per logical unit
}

/** Fit a logical canvas into an available area, keeping its aspect ratio. */
export function fitCanvas(logicalW: number, logicalH: number, availW: number, availH: number, dpr: number): Fit {
  const aspect = logicalW / logicalH;
  let cssWidth = Math.max(1, availW);
  let cssHeight = cssWidth / aspect;
  if (cssHeight > availH) {
    cssHeight = Math.max(1, availH);
    cssWidth = cssHeight * aspect;
  }
  let ratio = Math.max(1, Math.min(dpr || 1, 3));
  while (cssWidth * cssHeight * ratio * ratio > MAX_BACKING_PIXELS && ratio > 1) ratio -= 0.25;
  const backingWidth = Math.max(1, Math.round(cssWidth * ratio));
  const backingHeight = Math.max(1, Math.round(cssHeight * ratio));
  return { cssWidth, cssHeight, backingWidth, backingHeight, scale: backingWidth / logicalW };
}

export class Canvas2DRenderer {
  logicalWidth = 800;
  logicalHeight = 600;
  background = '#101525';
  private retained: DrawCommand[] = [];
  private retainedOverflow = false;
  private fit: Fit | null = null;
  onError: ((message: string) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private ctx: Context2D,
  ) {}

  /** Remove everything (new run or Clear button). */
  reset(): void {
    this.logicalWidth = 800;
    this.logicalHeight = 600;
    this.background = '#101525';
    this.retained = [];
    this.retainedOverflow = false;
    this.paintBackground();
  }

  /** Size the canvas for an available area (CSS pixels) and redraw. */
  layout(availWidth: number, availHeight: number, dpr: number): void {
    if (availWidth <= 0 || availHeight <= 0) return;
    const fit = fitCanvas(this.logicalWidth, this.logicalHeight, availWidth, availHeight, dpr);
    this.fit = fit;
    this.canvas.style.width = `${fit.cssWidth}px`;
    this.canvas.style.height = `${fit.cssHeight}px`;
    if (this.canvas.width !== fit.backingWidth || this.canvas.height !== fit.backingHeight) {
      this.canvas.width = fit.backingWidth;
      this.canvas.height = fit.backingHeight;
    }
    this.replay();
  }

  get size(): { width: number; height: number } {
    return { width: this.logicalWidth, height: this.logicalHeight };
  }

  /** Apply a batch; returns true when the logical canvas size changed (caller re-lays out). */
  apply(commands: DrawCommand[]): boolean {
    let resized = false;
    for (const command of commands) {
      if (!Array.isArray(command)) continue;
      const op = command[0];
      if (op === 'canvas') {
        this.logicalWidth = Number(command[1]) || 800;
        this.logicalHeight = Number(command[2]) || 600;
        this.retained = [];
        this.retainedOverflow = false;
        resized = true;
        continue;
      }
      if (op === 'clear' || op === 'bg') {
        // Both repaint the whole canvas, so nothing before them needs replaying.
        this.retained = [command];
        this.retainedOverflow = false;
      } else if (this.retained.length < MAX_RETAINED) {
        this.retained.push(command);
      } else {
        this.retainedOverflow = true;
      }
      if (!resized) this.draw(command);
    }
    if (resized && this.fit) {
      // The caller lays out again (new aspect ratio), which replays everything.
      return true;
    }
    return resized;
  }

  /** Map a pointer position (client pixels) to canvas coordinates. */
  toCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / Math.max(1, rect.width)) * this.logicalWidth;
    const y = ((clientY - rect.top) / Math.max(1, rect.height)) * this.logicalHeight;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  }

  get canReplayExactly(): boolean {
    return !this.retainedOverflow;
  }

  private transform(): void {
    const scale = this.fit ? this.canvas.width / this.logicalWidth : 1;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  private paintBackground(): void {
    this.transform();
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
  }

  private replay(): void {
    this.paintBackground();
    for (const command of this.retained) this.draw(command);
  }

  private paint(fill: unknown, stroke: unknown, width: unknown): void {
    const ctx = this.ctx;
    if (typeof fill === 'string') {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (typeof stroke === 'string' && Number(width) > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Number(width);
      ctx.stroke();
    }
  }

  private draw(command: DrawCommand): void {
    const ctx = this.ctx;
    const n = (i: number) => Number(command[i]);
    try {
      this.transform();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      switch (command[0]) {
        case 'bg':
          this.background = String(command[1]);
          this.paintBackground();
          break;
        case 'clear':
          this.paintBackground();
          break;
        case 'circle':
          ctx.beginPath();
          ctx.arc(n(1), n(2), Math.max(0, n(3)), 0, Math.PI * 2);
          this.paint(command[4], command[5], command[6]);
          break;
        case 'ellipse':
          ctx.beginPath();
          ctx.ellipse(n(1), n(2), Math.max(0, n(3)), Math.max(0, n(4)), n(5), 0, Math.PI * 2);
          this.paint(command[6], command[7], command[8]);
          break;
        case 'rect': {
          ctx.beginPath();
          const radius = n(8);
          if (radius > 0 && ctx.roundRect) ctx.roundRect(n(1), n(2), n(3), n(4), radius);
          else ctx.rect(n(1), n(2), n(3), n(4));
          this.paint(command[5], command[6], command[7]);
          break;
        }
        case 'line':
          ctx.beginPath();
          ctx.moveTo(n(1), n(2));
          ctx.lineTo(n(3), n(4));
          this.paint(null, command[5], command[6]);
          break;
        case 'poly': {
          const pts = command[1] as number[];
          if (!Array.isArray(pts) || pts.length < 4) break;
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
          if (command[2]) ctx.closePath();
          this.paint(command[3], command[4], command[5]);
          break;
        }
        case 'text':
          ctx.font = `${command[8] ? '600 ' : ''}${n(5)}px ${FONTS[String(command[9])] ?? FONTS['sans-serif']}`;
          ctx.textAlign = String(command[6]) as CanvasTextAlign;
          ctx.textBaseline = String(command[7]) as CanvasTextBaseline;
          ctx.fillStyle = String(command[4]);
          ctx.fillText(String(command[3]), n(1), n(2));
          break;
        default:
          this.onError?.(`Unknown drawing command "${String(command[0])}"`);
      }
    } catch (error) {
      this.onError?.(`Drawing failed: ${(error as Error).message}`);
    }
  }
}
