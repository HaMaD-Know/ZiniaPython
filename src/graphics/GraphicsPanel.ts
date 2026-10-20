/**
 * The Graphics Preview panel: a 2D canvas and a 3D (WebGL) view that show
 * what zinia_draw / zinia_3d programs draw, with Run/Stop/Clear, camera
 * controls and fullscreen. Touches and keys on the preview are forwarded to
 * the running program through the GraphicsController.
 *
 * Three.js is loaded only when a program first uses 3D (it is bundled with
 * the app, never fetched from the network).
 */
import { h } from '../components/dom';
import { icon } from '../components/icons';
import { Canvas2DRenderer, type Context2D } from './Canvas2DRenderer';
import type { GraphicsController, GraphicsHost, Surface, UIEvent } from './GraphicsController';
import type { Scene3DRenderer, SceneCommand } from './Scene3DRenderer';

export interface GraphicsPanelActions {
  run(): void;
  stop(): void;
  openExamples(): void;
  /** The panel was opened, closed or entered/left fullscreen. */
  changed(): void;
}

const TAP_MAX_MOVE = 8;
const TAP_MAX_MS = 500;

export class GraphicsPanel implements GraphicsHost {
  readonly el: HTMLElement;
  private mode: Surface = '2d';
  private isOpen = false;
  private isFullscreen = false;
  private running = false;
  private controller: GraphicsController | null = null;

  private stage2d: HTMLElement;
  private stage3d: HTMLElement;
  private canvas2d: HTMLCanvasElement;
  private renderer2d: Canvas2DRenderer | null = null;
  private renderer3d: Scene3DRenderer | null = null;
  private loading3d: Promise<Scene3DRenderer | null> | null = null;
  private pending3d: { commands: unknown[]; rendered: () => void }[] = [];
  private webglError: string | null = null;
  private drawn: Record<Surface, boolean> = { '2d': false, '3d': false };

  private empty: HTMLElement;
  private message: HTMLElement;
  private status: HTMLElement;
  private modeButtons: Record<Surface, HTMLButtonElement>;
  private runBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private cameraButtons: HTMLElement;
  private fullscreenBtn: HTMLButtonElement;

  private frames = 0;
  private fpsWindowStart = performance.now();
  private fps = 0;
  private pointers = new Map<number, { x: number; y: number; t: number; moved: boolean }>();

  constructor(private actions: GraphicsPanelActions) {
    this.canvas2d = h('canvas', { class: 'gfx-canvas', attrs: { 'aria-label': '2D graphics output' } });
    const ctx = this.canvas2d.getContext('2d');
    if (ctx) {
      this.renderer2d = new Canvas2DRenderer(this.canvas2d, ctx as unknown as Context2D);
      this.renderer2d.onError = (m) => this.showMessage(m, 'error');
    }
    this.stage2d = h('div', { class: 'gfx-stage gfx-stage-2d', attrs: { tabindex: '0' } }, this.canvas2d);
    this.stage3d = h('div', { class: 'gfx-stage gfx-stage-3d hidden', attrs: { tabindex: '0', 'aria-label': '3D graphics output' } });
    this.empty = h('div', { class: 'gfx-empty' },
      h('div', { class: 'empty-inner' },
        h('h2', null, 'Graphics preview'),
        h('p', null, 'Run a program that imports zinia_draw (2D) or zinia_3d (3D) and its drawing appears here.'),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn btn-primary', onClick: () => this.actions.openExamples() }, 'Open graphics examples'),
        ),
      ),
    );
    this.message = h('div', { class: 'gfx-message hidden', attrs: { role: 'status' } });
    this.status = h('div', { class: 'gfx-status', attrs: { 'aria-live': 'off' } });

    const modeButton = (surface: Surface, label: string) =>
      h('button', {
        class: 'seg',
        attrs: { role: 'tab', 'aria-label': `${label} preview` },
        onClick: () => this.setMode(surface),
      }, label) as HTMLButtonElement;
    this.modeButtons = { '2d': modeButton('2d', '2D'), '3d': modeButton('3d', '3D') };

    this.runBtn = h('button', { class: 'icon-btn small gfx-run', title: 'Run current file', attrs: { 'aria-label': 'Run' }, onClick: () => this.actions.run() }, icon('play', 16));
    this.stopBtn = h('button', { class: 'icon-btn small', title: 'Stop', disabled: true, attrs: { 'aria-label': 'Stop' }, onClick: () => this.actions.stop() }, icon('stop', 14));
    this.cameraButtons = h('div', { class: 'gfx-camera' },
      h('button', { class: 'icon-btn small', title: 'Zoom out', attrs: { 'aria-label': 'Zoom out' }, onClick: () => this.renderer3d?.zoom(1.25) }, icon('zoomOut', 16)),
      h('button', { class: 'icon-btn small', title: 'Zoom in', attrs: { 'aria-label': 'Zoom in' }, onClick: () => this.renderer3d?.zoom(0.8) }, icon('zoomIn', 16)),
      h('button', { class: 'icon-btn small', title: 'Reset camera', attrs: { 'aria-label': 'Reset camera' }, onClick: () => this.renderer3d?.resetCamera() }, icon('recenter', 16)),
    );
    this.fullscreenBtn = h('button', { class: 'icon-btn small', title: 'Fullscreen', attrs: { 'aria-label': 'Fullscreen' }, onClick: () => this.setFullscreen(!this.isFullscreen) }, icon('expand', 16));

    const header = h('div', { class: 'gfx-header' },
      h('div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': 'Preview mode' } }, this.modeButtons['2d'], this.modeButtons['3d']),
      h('div', { class: 'gfx-tools' },
        this.runBtn,
        this.stopBtn,
        h('button', { class: 'icon-btn small', title: 'Clear preview', attrs: { 'aria-label': 'Clear preview' }, onClick: () => this.clearCurrent() }, icon('clear', 16)),
        this.cameraButtons,
        this.fullscreenBtn,
        h('button', { class: 'icon-btn small', title: 'Back to the editor', attrs: { 'aria-label': 'Close preview' }, onClick: () => this.close() }, icon('close', 16)),
      ),
    );

    this.el = h('section', { class: 'gfx-panel hidden', attrs: { 'aria-label': 'Graphics preview' } },
      header,
      h('div', { class: 'gfx-body' }, this.stage2d, this.stage3d, this.empty, this.message),
      this.status,
    );

    this.attach2DInput();
    this.attachKeys(this.stage2d, '2d');
    this.attachKeys(this.stage3d, '3d');
    new ResizeObserver(() => this.layout()).observe(this.el);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isFullscreen) this.setFullscreen(false);
    });
    this.renderer2d?.reset();
    this.applyMode();
  }

  connect(controller: GraphicsController): void {
    this.controller = controller;
  }

  get opened(): boolean {
    return this.isOpen;
  }

  get fullscreen(): boolean {
    return this.isFullscreen;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.el.classList.remove('hidden');
    this.applyMode();
    this.actions.changed();
    requestAnimationFrame(() => this.layout());
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.isFullscreen = false;
    this.el.classList.add('hidden');
    this.el.classList.remove('fullscreen');
    this.renderer3d?.setVisible(false);
    this.actions.changed();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  setFullscreen(on: boolean): void {
    this.isFullscreen = on && this.isOpen;
    this.el.classList.toggle('fullscreen', this.isFullscreen);
    this.fullscreenBtn.replaceChildren(icon(this.isFullscreen ? 'collapse' : 'expand', 16));
    this.fullscreenBtn.title = this.isFullscreen ? 'Exit fullscreen' : 'Fullscreen';
    this.actions.changed();
    requestAnimationFrame(() => this.layout());
  }

  setRunning(running: boolean, canRun: boolean): void {
    this.running = running;
    this.stopBtn.disabled = !running;
    this.runBtn.disabled = running || !canRun;
    if (!running) this.updateStatus();
  }

  setMode(surface: Surface): void {
    if (this.mode === surface) return;
    this.mode = surface;
    this.applyMode();
  }

  // ------------------------------------------------------------ GraphicsHost

  activate(surface: Surface): void {
    this.setMode(surface);
    this.open();
  }

  reset(): void {
    this.drawn = { '2d': false, '3d': false };
    this.pending3d.forEach((p) => p.rendered());
    this.pending3d = [];
    this.renderer2d?.reset();
    this.layout2D();
    this.renderer3d?.reset();
    this.hideMessage();
    this.frames = 0;
    this.fps = 0;
    this.fpsWindowStart = performance.now();
    this.applyMode();
  }

  draw2D(commands: unknown[]): void {
    if (!this.renderer2d) {
      this.showMessage('This device cannot draw 2D graphics (no canvas context).', 'error');
      return;
    }
    this.drawn['2d'] = true;
    if (this.renderer2d.apply(commands as unknown[][])) this.layout2D();
    this.countFrame();
    this.syncEmpty();
  }

  draw3D(commands: unknown[], rendered: () => void): void {
    this.drawn['3d'] = true;
    this.syncEmpty();
    this.countFrame();
    if (this.renderer3d) {
      this.renderer3d.apply(commands as SceneCommand[]);
      this.renderer3d.whenRendered(rendered);
      return;
    }
    if (this.webglError) {
      rendered();
      return;
    }
    this.pending3d.push({ commands, rendered });
    void this.ensure3D();
  }

  // ------------------------------------------------------------------ 3D view

  private ensure3D(): Promise<Scene3DRenderer | null> {
    if (this.renderer3d) return Promise.resolve(this.renderer3d);
    if (!this.loading3d) {
      this.status.textContent = 'Loading the 3D engine…';
      this.loading3d = import('./Scene3DRenderer')
        .then(({ Scene3DRenderer, WebGLUnavailableError }) => {
          try {
            const renderer = new Scene3DRenderer(this.stage3d);
            renderer.onError = (m) => this.showMessage(m, 'error');
            this.renderer3d = renderer;
            this.attach3DInput(renderer);
            renderer.setVisible(this.isOpen && this.mode === '3d');
            renderer.resize();
            for (const p of this.pending3d.splice(0)) {
              renderer.apply(p.commands as SceneCommand[]);
              renderer.whenRendered(p.rendered);
            }
            this.updateStatus();
            return renderer;
          } catch (error) {
            this.webglError = error instanceof WebGLUnavailableError
              ? 'WebGL is not available, so 3D graphics cannot be shown on this device. 2D graphics (zinia_draw) still work.'
              : `The 3D view could not start: ${(error as Error).message}`;
            throw error;
          }
        })
        .catch((error: unknown) => {
          this.webglError ??= `The 3D engine could not be loaded: ${(error as Error).message}`;
          this.pending3d.splice(0).forEach((p) => p.rendered());
          this.applyMode();
          return null;
        });
    }
    return this.loading3d;
  }

  // ------------------------------------------------------------------- layout

  private applyMode(): void {
    const is3d = this.mode === '3d';
    this.modeButtons['2d'].classList.toggle('active', !is3d);
    this.modeButtons['3d'].classList.toggle('active', is3d);
    this.modeButtons['2d'].setAttribute('aria-selected', String(!is3d));
    this.modeButtons['3d'].setAttribute('aria-selected', String(is3d));
    this.stage2d.classList.toggle('hidden', is3d);
    this.stage3d.classList.toggle('hidden', !is3d);
    this.cameraButtons.classList.toggle('hidden', !is3d);
    this.renderer3d?.setVisible(this.isOpen && is3d);
    if (is3d && this.webglError) this.showMessage(this.webglError, 'error');
    else if (this.message.dataset.kind === 'webgl') this.hideMessage();
    this.syncEmpty();
    this.updateStatus();
    if (this.isOpen) requestAnimationFrame(() => this.layout());
  }

  private syncEmpty(): void {
    this.empty.classList.toggle('hidden', this.drawn[this.mode] || (this.mode === '3d' && !!this.webglError));
  }

  private layout(): void {
    if (!this.isOpen) return;
    if (this.mode === '2d') this.layout2D();
    else this.renderer3d?.resize();
  }

  private layout2D(): void {
    if (!this.renderer2d || this.mode !== '2d' || !this.isOpen) return;
    const rect = this.stage2d.getBoundingClientRect();
    this.renderer2d.layout(rect.width - 16, rect.height - 16, window.devicePixelRatio || 1);
  }

  private clearCurrent(): void {
    if (this.mode === '2d') {
      this.renderer2d?.reset();
      this.layout2D();
    } else {
      this.renderer3d?.reset();
    }
    this.drawn[this.mode] = false;
    this.hideMessage();
    this.syncEmpty();
  }

  // ------------------------------------------------------------------- status

  private countFrame(): void {
    this.frames += 1;
    const now = performance.now();
    const elapsed = now - this.fpsWindowStart;
    if (elapsed >= 1000) {
      this.fps = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.fpsWindowStart = now;
      this.updateStatus();
    }
  }

  private updateStatus(): void {
    const parts: string[] = [];
    if (this.mode === '2d' && this.renderer2d) {
      const { width, height } = this.renderer2d.size;
      parts.push(`2D canvas ${width}×${height}`);
    } else if (this.mode === '3d') {
      parts.push(this.renderer3d ? `3D scene, ${this.renderer3d.model.objectCount} objects` : this.webglError ? '3D unavailable' : '3D scene');
      if (this.renderer3d?.orbitEnabled) parts.push('drag to orbit, pinch to zoom');
    }
    if (this.running && this.fps > 0) parts.push(`${this.fps.toFixed(0)} frames/s measured`);
    this.status.textContent = parts.join(' · ');
  }

  private showMessage(text: string, tone: 'error' | 'info'): void {
    this.message.textContent = text;
    this.message.dataset.tone = tone;
    this.message.dataset.kind = text === this.webglError ? 'webgl' : 'error';
    this.message.classList.remove('hidden');
  }

  private hideMessage(): void {
    this.message.classList.add('hidden');
    this.message.textContent = '';
    delete this.message.dataset.kind;
  }

  // -------------------------------------------------------------------- input

  private send(event: Omit<UIEvent, 'surface'>, surface: Surface): void {
    this.controller?.pushEvent({ ...event, surface } as UIEvent);
  }

  private attach2DInput(): void {
    const canvas = this.canvas2d;
    canvas.style.touchAction = 'none';
    const handler = (type: 'down' | 'move' | 'up') => (e: PointerEvent) => {
      if (!this.renderer2d) return;
      if (type === 'down') {
        canvas.setPointerCapture?.(e.pointerId);
        this.stage2d.focus({ preventScroll: true });
      }
      if (type === 'move' && e.pointerType !== 'mouse' && e.buttons === 0) return;
      const p = this.renderer2d.toCanvas(e.clientX, e.clientY);
      this.send({ type, x: p.x, y: p.y, id: e.pointerId, buttons: e.buttons }, '2d');
      if (type !== 'move') e.preventDefault();
    };
    canvas.addEventListener('pointerdown', handler('down'));
    canvas.addEventListener('pointermove', handler('move'));
    canvas.addEventListener('pointerup', handler('up'));
    canvas.addEventListener('pointercancel', handler('up'));
  }

  private attach3DInput(renderer: Scene3DRenderer): void {
    const canvas = renderer.canvas;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      this.stage3d.focus({ preventScroll: true });
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: false });
      const p = renderer.toNdc(e.clientX, e.clientY);
      this.send({ type: 'down', x: p.x, y: p.y, id: e.pointerId, buttons: e.buttons }, '3d');
    });
    canvas.addEventListener('pointermove', (e) => {
      const start = this.pointers.get(e.pointerId);
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_MAX_MOVE) start.moved = true;
      if (e.pointerType !== 'mouse' && !start) return;
      const p = renderer.toNdc(e.clientX, e.clientY);
      this.send({ type: 'move', x: p.x, y: p.y, id: e.pointerId, buttons: e.buttons }, '3d');
    });
    const end = (e: PointerEvent) => {
      const start = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      const p = renderer.toNdc(e.clientX, e.clientY);
      this.send({ type: 'up', x: p.x, y: p.y, id: e.pointerId, buttons: e.buttons }, '3d');
      if (e.type === 'pointerup' && start && !start.moved && performance.now() - start.t < TAP_MAX_MS) {
        const hit = renderer.pick(e.clientX, e.clientY);
        this.send({ type: 'tap', x: p.x, y: p.y, object: hit.object, point: hit.point }, '3d');
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  private attachKeys(stage: HTMLElement, surface: Surface): void {
    const handler = (type: 'keydown' | 'keyup') => (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') return;
      if (type === 'keydown' && e.repeat) return;
      this.send({ type, key: e.key }, surface);
      if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault();
    };
    stage.addEventListener('keydown', handler('keydown'));
    stage.addEventListener('keyup', handler('keyup'));
  }
}
