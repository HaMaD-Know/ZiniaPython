import { describe, expect, it, vi } from 'vitest';
import type { Mesh, MeshStandardMaterial } from 'three';
import { Canvas2DRenderer, fitCanvas, type Context2D } from '../../src/graphics/Canvas2DRenderer';
import { GraphicsController, type GraphicsHost } from '../../src/graphics/GraphicsController';
import { SceneModel } from '../../src/graphics/Scene3DRenderer';
import { GRAPHICS_EXAMPLES } from '../../src/graphics/examples';

/** A 2D context that records calls instead of drawing. */
function recorder() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => calls.push(`${prop}(${args.map((a) => (typeof a === 'number' ? Math.round(a * 100) / 100 : a)).join(',')})`);
    },
    set(target, prop: string, value) {
      target[prop] = value;
      if (prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'font') calls.push(`${prop}=${value}`);
      return true;
    },
  }) as unknown as Context2D;
  return { ctx, calls };
}

function renderer() {
  const canvas = document.createElement('canvas');
  const { ctx, calls } = recorder();
  const r = new Canvas2DRenderer(canvas, ctx);
  return { r, calls, canvas };
}

describe('fitCanvas', () => {
  it('keeps the aspect ratio and fits the narrower side', () => {
    const fit = fitCanvas(800, 600, 400, 1000, 2);
    expect(fit.cssWidth).toBe(400);
    expect(fit.cssHeight).toBe(300);
    expect(fit.backingWidth).toBe(800);
    expect(fit.scale).toBe(1);
  });

  it('limits the backing store for huge canvases', () => {
    const fit = fitCanvas(4096, 4096, 3000, 3000, 3);
    expect(fit.backingWidth * fit.backingHeight).toBeLessThanOrEqual(16_000_000);
  });
});

describe('Canvas2DRenderer', () => {
  it('draws commands in order', () => {
    const { r, calls } = renderer();
    r.layout(800, 600, 1);
    calls.length = 0;
    r.apply([
      ['circle', 10, 20, 5, '#00ffff', null, 1],
      ['rect', 0, 0, 10, 10, null, 'red', 2, 0],
      ['line', 0, 0, 5, 5, 'white', 3],
      ['text', 1, 2, 'hi', 'white', 16, 'left', 'top', true, 'monospace'],
    ]);
    const drawing = calls.filter((c) => /^(arc|rect|lineTo|fillText|fill|stroke)\(/.test(c) || c.startsWith('fillStyle') || c.startsWith('strokeStyle'));
    expect(drawing).toEqual([
      'arc(10,20,5,0,6.28)', 'fillStyle=#00ffff', 'fill()',
      'rect(0,0,10,10)', 'strokeStyle=red', 'stroke()',
      'lineTo(5,5)', 'strokeStyle=white', 'stroke()',
      'fillStyle=white', 'fillText(hi,1,2)',
    ]);
    expect(calls).toContain('font=600 16px ui-monospace, "SF Mono", Menlo, Consolas, monospace');
  });

  it('reports a new canvas size and replays after layout', () => {
    const { r, calls, canvas } = renderer();
    r.layout(400, 400, 2);
    const resized = r.apply([['canvas', 200, 100], ['bg', 'black'], ['circle', 1, 1, 1, 'red', null, 1]]);
    expect(resized).toBe(true);
    expect(r.size).toEqual({ width: 200, height: 100 });
    calls.length = 0;
    r.layout(400, 400, 2);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(400);
    // background, then the retained commands
    expect(calls.filter((c) => c.startsWith('fillStyle'))).toEqual(['fillStyle=#101525', 'fillStyle=black', 'fillStyle=red']);
  });

  it('set_background repaints and clear() drops what was drawn before', () => {
    const { r, calls } = renderer();
    r.layout(800, 600, 1);
    r.apply([['circle', 1, 1, 1, 'red', null, 1], ['clear'], ['circle', 2, 2, 2, 'blue', null, 1]]);
    calls.length = 0;
    r.layout(800, 600, 1);
    expect(calls.filter((c) => c.startsWith('arc'))).toEqual(['arc(2,2,2,0,6.28)']);
  });

  it('reports unknown commands instead of throwing', () => {
    const { r } = renderer();
    const onError = vi.fn();
    r.onError = onError;
    r.apply([['sparkle', 1]]);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('sparkle'));
  });

  it('maps pointer positions to canvas coordinates', () => {
    const { r, canvas } = renderer();
    r.apply([['canvas', 1000, 500]]);
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 500, height: 250, right: 510, bottom: 270, x: 10, y: 20, toJSON() {} });
    expect(r.toCanvas(260, 145)).toEqual({ x: 500, y: 250 });
  });
});

function host() {
  const log: string[] = [];
  const h: GraphicsHost = {
    activate: (s) => log.push(`activate ${s}`),
    draw2D: (c) => log.push(`2d ${c.length}`),
    draw3D: (c, rendered) => {
      log.push(`3d ${c.length}`);
      rendered();
    },
    reset: () => log.push('reset'),
  };
  return { h, log };
}

function payload(executionId: string, surface: '2d' | '3d', seq: number, commands: unknown[] = [['clear']]) {
  return JSON.stringify({ executionId, surface, seq, commands });
}

describe('GraphicsController', () => {
  it('draws only batches of the current run', () => {
    const { h, log } = host();
    const c = new GraphicsController(h, vi.fn().mockResolvedValue({}), () => {});
    c.beginRun('run-1');
    c.handlePayload(payload('run-1', '2d', 1));
    c.beginRun('run-2');
    c.handlePayload(payload('run-1', '2d', 2)); // late batch from the stopped run
    c.handlePayload(payload('run-2', '3d', 1));
    expect(log).toEqual(['reset', 'activate 2d', '2d 1', 'reset', 'activate 3d', '3d 1']);
    expect(c.dropped).toBe(1);
  });

  it('lets REPL statements draw on the current picture', () => {
    const { h, log } = host();
    const c = new GraphicsController(h, vi.fn().mockResolvedValue({}), () => {});
    c.beginRun('run-1');
    c.endRun('run-1');
    c.beginRepl('repl-1');
    c.handlePayload(payload('repl-1', '2d', 1));
    expect(log).toEqual(['reset', 'activate 2d', '2d 1']);
  });

  it('posts acknowledgements and coalesced events once per frame', () => {
    const { h } = host();
    const post = vi.fn().mockResolvedValue({});
    const frame = { run: () => {} };
    const c = new GraphicsController(h, post, (cb) => (frame.run = cb));
    c.beginRun('run-1');
    c.handlePayload(payload('run-1', '2d', 1));
    c.handlePayload(payload('run-1', '2d', 2));
    c.pushEvent({ type: 'move', x: 1, y: 1, id: 1, surface: '2d' });
    c.pushEvent({ type: 'move', x: 2, y: 2, id: 1, surface: '2d' });
    c.pushEvent({ type: 'down', x: 3, y: 3, id: 2, surface: '2d' });
    expect(post).not.toHaveBeenCalled();
    frame.run();
    expect(post).toHaveBeenCalledTimes(1);
    const [id, events] = post.mock.calls[0];
    expect(id).toBe('run-1');
    expect(JSON.parse(events)).toEqual([
      { type: 'ack', seq: 2, surface: '2d' },
      { type: 'move', x: 2, y: 2, id: 1, surface: '2d' },
      { type: 'down', x: 3, y: 3, id: 2, surface: '2d' },
    ]);
  });

  it('sends nothing after the run ended', () => {
    const { h } = host();
    const post = vi.fn().mockResolvedValue({});
    const frame = { run: () => {} };
    const c = new GraphicsController(h, post, (cb) => (frame.run = cb));
    c.beginRun('run-1');
    c.pushEvent({ type: 'down', x: 1, y: 1, id: 1, surface: '2d' });
    c.endRun('run-1');
    c.pushEvent({ type: 'down', x: 1, y: 1, id: 1, surface: '2d' });
    frame.run();
    expect(post).not.toHaveBeenCalled();
  });

  it('ignores malformed payloads', () => {
    const { h, log } = host();
    const c = new GraphicsController(h, vi.fn(), () => {});
    const onError = vi.fn();
    c.onError = onError;
    c.beginRun('r');
    c.handlePayload('{not json');
    c.handlePayload(JSON.stringify({ executionId: 'r', surface: '2d', seq: 1, commands: 'x' }));
    expect(log).toEqual(['reset']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('SceneModel (3D without WebGL)', () => {
  it('adds, updates, removes and disposes objects', () => {
    const model = new SceneModel();
    model.apply([
      { op: 'reset' },
      { op: 'background', color: '#ff0000' },
      { op: 'add', id: 1, kind: 'box', params: { width: 2, height: 2, depth: 2 }, position: [1, 2, 3], rotation: [0, 0.5, 0], scale: [1, 1, 1], material: { color: '#00ffff', opacity: 1 } },
      { op: 'add', id: 2, kind: 'sphere', params: { radius: 1, segments: 16 }, material: { color: 'white' } },
      { op: 'add', id: 3, kind: 'cylinder', params: { radiusTop: 0, radiusBottom: 1, height: 2, segments: 8 }, material: {} },
      { op: 'add', id: 4, kind: 'plane', params: { width: 5, height: 5 }, material: {} },
    ]);
    expect(model.objectCount).toBe(4);
    const box = model.objects.get(1) as Mesh;
    expect(box.position.toArray()).toEqual([1, 2, 3]);
    const dispose = vi.spyOn(box.geometry, 'dispose');
    model.apply([{ op: 'set', id: 1, position: [0, 0, 0], color: 'red', visible: false }]);
    expect(box.position.toArray()).toEqual([0, 0, 0]);
    expect((box.material as MeshStandardMaterial).color.getHexString()).toBe('ff0000');
    expect(box.visible).toBe(false);
    model.apply([{ op: 'remove', id: 1 }]);
    expect(dispose).toHaveBeenCalled();
    expect(model.objectCount).toBe(3);
    model.apply([{ op: 'set', id: 1, position: [9, 9, 9] }]); // removed: ignored
  });

  it('uses default lights until the program adds its own', () => {
    const model = new SceneModel();
    expect(model.scene.children).toContain(model.defaultLights);
    model.apply([{ op: 'light', id: 7, kind: 'directional', intensity: 1, color: 'white', position: [1, 2, 3] }]);
    expect(model.scene.children).not.toContain(model.defaultLights);
    model.apply([{ op: 'remove', id: 7 }]);
    expect(model.scene.children).toContain(model.defaultLights);
  });

  it('remembers the camera for Reset camera and frees everything on reset', () => {
    const model = new SceneModel();
    model.apply([
      { op: 'camera', position: [1, 2, 3], target: [0, 1, 0], fov: 40 },
      { op: 'add', id: 1, kind: 'box', params: { width: 1, height: 1, depth: 1 }, material: {} },
    ]);
    expect(model.home).toEqual({ position: [1, 2, 3], target: [0, 1, 0], fov: 40 });
    const mesh = model.objects.get(1) as Mesh;
    const disposeMaterial = vi.spyOn(mesh.material as MeshStandardMaterial, 'dispose');
    model.apply([{ op: 'reset' }]);
    expect(disposeMaterial).toHaveBeenCalled();
    expect(model.objects.size).toBe(0);
    expect(model.home.fov).toBe(50);
  });

  it('reports bad commands without stopping the batch', () => {
    const model = new SceneModel();
    const onError = vi.fn();
    model.onError = onError;
    model.apply([
      { op: 'add', id: 1, kind: 'torus', params: {}, material: {} },
      { op: 'add', id: 2, kind: 'box', params: { width: 1, height: 1, depth: 1 }, material: {} },
    ]);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('torus'));
    expect(model.objectCount).toBe(1);
  });
});

describe('bundled examples', () => {
  it('includes the twelve programs and the README', () => {
    const names = Object.keys(GRAPHICS_EXAMPLES);
    expect(names.filter((n) => n.endsWith('.py'))).toHaveLength(12);
    expect(names).toContain('README.md');
    expect(GRAPHICS_EXAMPLES['07_rotating_cube.py']).toContain('import zinia_3d');
  });
});
