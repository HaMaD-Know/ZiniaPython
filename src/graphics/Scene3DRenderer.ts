/**
 * Renders zinia_3d commands with Three.js (WebGL).
 *
 * One renderer and one <canvas> live for the whole app session; a new run or
 * create_scene() disposes the previous scene's geometries and materials
 * instead of creating another WebGL context. Frames are rendered on demand:
 * only when commands arrive, the camera moves, or the panel resizes.
 */
import {
  AmbientLight,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  type Light,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type SceneCommand = Record<string, unknown> & { op: string };

type Vec3 = [number, number, number];
const DEFAULT_BACKGROUND = '#101525';
const DEFAULT_CAMERA = { position: [6, 5, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 50 };

export class WebGLUnavailableError extends Error {}

function vec(value: unknown, fallback: Vec3): Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((v) => Number.isFinite(Number(v)))
    ? [Number(value[0]), Number(value[1]), Number(value[2])]
    : fallback;
}

/** Applies scene commands to a Three.js scene (no rendering; testable without WebGL). */
export class SceneModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(DEFAULT_CAMERA.fov, 1, 0.1, 2000);
  readonly objects = new Map<number, Object3D>();
  readonly defaultLights = new Group();
  home = { ...DEFAULT_CAMERA };
  orbit = true;
  userLights = 0;
  onError: ((message: string) => void) | null = null;
  onCamera: (() => void) | null = null;

  constructor() {
    this.defaultLights.add(new AmbientLight(0xffffff, 0.6));
    const sun = new DirectionalLight(0xffffff, 1.0);
    sun.position.set(5, 10, 7);
    this.defaultLights.add(sun);
    this.reset();
  }

  get objectCount(): number {
    let meshes = 0;
    for (const obj of this.objects.values()) if (obj instanceof Mesh) meshes += 1;
    return meshes;
  }

  /** Remove every object and free its GPU resources. */
  reset(): void {
    for (const obj of this.objects.values()) this.disposeObject(obj);
    this.objects.clear();
    this.scene.clear();
    this.userLights = 0;
    this.scene.add(this.defaultLights);
    this.scene.background = new Color(DEFAULT_BACKGROUND);
    this.orbit = true;
    this.home = { ...DEFAULT_CAMERA, position: [...DEFAULT_CAMERA.position], target: [...DEFAULT_CAMERA.target] };
    this.camera.fov = this.home.fov;
    this.camera.position.set(...this.home.position);
    this.camera.lookAt(...this.home.target);
    this.camera.updateProjectionMatrix();
  }

  private disposeObject(obj: Object3D): void {
    obj.removeFromParent();
    if (obj instanceof Mesh) {
      obj.geometry.dispose();
      const material = obj.material;
      (Array.isArray(material) ? material : [material]).forEach((m) => m.dispose());
    }
    if ('dispose' in obj && typeof (obj as Light).dispose === 'function') (obj as Light).dispose();
  }

  apply(commands: SceneCommand[]): void {
    for (const command of commands) {
      try {
        this.applyOne(command);
      } catch (error) {
        this.onError?.(`3D command "${command.op}" failed: ${(error as Error).message}`);
      }
    }
  }

  private applyOne(c: SceneCommand): void {
    switch (c.op) {
      case 'reset':
        this.reset();
        this.onCamera?.();
        break;
      case 'background':
        this.scene.background = new Color(String(c.color));
        break;
      case 'add': {
        const params = (c.params ?? {}) as Record<string, number>;
        const m = (c.material ?? {}) as Record<string, unknown>;
        const opacity = Number(m.opacity ?? 1);
        const material = new MeshStandardMaterial({
          color: new Color(String(m.color ?? '#cccccc')),
          wireframe: Boolean(m.wireframe),
          metalness: Number(m.metalness ?? 0.1),
          roughness: Number(m.roughness ?? 0.6),
          transparent: opacity < 1,
          opacity,
        });
        let geometry;
        switch (c.kind) {
          case 'box':
            geometry = new BoxGeometry(params.width, params.height, params.depth);
            break;
          case 'sphere':
            geometry = new SphereGeometry(params.radius, params.segments, Math.max(2, Math.round(params.segments / 2)));
            break;
          case 'plane':
            geometry = new PlaneGeometry(params.width, params.height);
            material.side = DoubleSide;
            break;
          case 'cylinder':
            geometry = new CylinderGeometry(params.radiusTop, params.radiusBottom, params.height, params.segments);
            break;
          default:
            material.dispose();
            throw new Error(`unknown shape ${String(c.kind)}`);
        }
        const mesh = new Mesh(geometry, material);
        mesh.position.set(...vec(c.position, [0, 0, 0]));
        mesh.rotation.set(...vec(c.rotation, [0, 0, 0]));
        mesh.scale.set(...vec(c.scale, [1, 1, 1]));
        mesh.userData.ziniaId = Number(c.id);
        this.replace(Number(c.id), mesh);
        break;
      }
      case 'light': {
        let light: Light;
        const color = new Color(String(c.color ?? '#ffffff'));
        const intensity = Number(c.intensity ?? 1);
        if (c.kind === 'ambient') light = new AmbientLight(color, intensity);
        else if (c.kind === 'directional') light = new DirectionalLight(color, intensity);
        else light = new PointLight(color, intensity, 0, 0);
        if (c.kind !== 'ambient') light.position.set(...vec(c.position, [5, 10, 7]));
        this.replace(Number(c.id), light);
        this.userLights += 1;
        this.defaultLights.removeFromParent();
        break;
      }
      case 'set': {
        const obj = this.objects.get(Number(c.id));
        if (!obj) break; // removed in the meantime
        if (c.position) obj.position.set(...vec(c.position, [0, 0, 0]));
        if (c.rotation) obj.rotation.set(...vec(c.rotation, [0, 0, 0]));
        if (c.scale) obj.scale.set(...vec(c.scale, [1, 1, 1]));
        if (c.visible !== undefined) obj.visible = Boolean(c.visible);
        if (c.color !== undefined) {
          if (obj instanceof Mesh) (obj.material as MeshStandardMaterial).color.set(String(c.color));
          else if ('color' in obj) (obj as Light).color.set(String(c.color));
        }
        if (c.intensity !== undefined && 'intensity' in obj) (obj as Light).intensity = Number(c.intensity);
        break;
      }
      case 'remove': {
        const obj = this.objects.get(Number(c.id));
        if (obj) {
          if ((obj as Light).isLight) {
            this.userLights = Math.max(0, this.userLights - 1);
            if (this.userLights === 0) this.scene.add(this.defaultLights);
          }
          this.disposeObject(obj);
          this.objects.delete(Number(c.id));
        }
        break;
      }
      case 'camera':
        this.home = { position: vec(c.position, DEFAULT_CAMERA.position), target: vec(c.target, DEFAULT_CAMERA.target), fov: Number(c.fov ?? 50) };
        this.camera.fov = this.home.fov;
        this.camera.position.set(...this.home.position);
        this.camera.lookAt(...this.home.target);
        this.camera.updateProjectionMatrix();
        this.onCamera?.();
        break;
      case 'controls':
        this.orbit = Boolean(c.orbit);
        this.onCamera?.();
        break;
      default:
        throw new Error('unknown command');
    }
  }

  private replace(id: number, obj: Object3D): void {
    const old = this.objects.get(id);
    if (old) this.disposeObject(old);
    this.objects.set(id, obj);
    this.scene.add(obj);
  }
}

/** The WebGL view: renderer, touch camera controls, picking. */
export class Scene3DRenderer {
  readonly model = new SceneModel();
  private renderer: WebGLRenderer;
  private controls: OrbitControls;
  private raycaster = new Raycaster();
  private dirty = true;
  private frame = 0;
  private visible = false;
  private afterRender: (() => void)[] = [];
  onError: ((message: string) => void) | null = null;

  constructor(private host: HTMLElement) {
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, powerPreference: 'default' });
    } catch (error) {
      throw new WebGLUnavailableError((error as Error).message || 'WebGL is not available');
    }
    this.renderer = renderer;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.domElement.className = 'gfx-webgl';
    host.appendChild(renderer.domElement);
    this.controls = new OrbitControls(this.model.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());
    this.model.onError = (m) => this.onError?.(m);
    this.model.onCamera = () => this.syncControls();
    this.syncControls();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  apply(commands: SceneCommand[]): void {
    this.model.apply(commands);
    this.invalidate();
  }

  reset(): void {
    this.model.reset();
    this.syncControls();
    this.invalidate();
  }

  /** Called after the next rendered frame (used for frame acknowledgements). */
  whenRendered(callback: () => void): void {
    if (!this.visible) {
      callback(); // nothing is drawn while hidden; do not hold the program back
      return;
    }
    this.afterRender.push(callback);
    this.invalidate();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.resize();
      this.invalidate();
    } else {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      for (const cb of this.afterRender.splice(0)) cb();
    }
  }

  resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.model.camera.aspect = width / height;
    this.model.camera.updateProjectionMatrix();
    this.invalidate();
  }

  resetCamera(): void {
    const { position, target, fov } = this.model.home;
    this.model.camera.fov = fov;
    this.model.camera.position.set(...position);
    this.controls.target.set(...target);
    this.model.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  zoom(factor: number): void {
    const offset = new Vector3().subVectors(this.model.camera.position, this.controls.target);
    offset.multiplyScalar(factor);
    this.model.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.invalidate();
  }

  /** Normalised device coordinates (-1..1, y up) for a client position. */
  toNdc(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.round((((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1) * 1000) / 1000,
      y: Math.round((-((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1) * 1000) / 1000,
    };
  }

  pick(clientX: number, clientY: number): { object: number | null; point: Vec3 | null } {
    const ndc = this.toNdc(clientX, clientY);
    this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), this.model.camera);
    const meshes = [...this.model.objects.values()].filter((o) => o instanceof Mesh && o.visible);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return { object: null, point: null };
    const p = hit.point;
    return { object: Number(hit.object.userData.ziniaId), point: [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000) as Vec3 };
  }

  get orbitEnabled(): boolean {
    return this.model.orbit;
  }

  private syncControls(): void {
    this.controls.enabled = this.model.orbit;
    this.controls.target.set(...this.model.home.target);
    this.controls.update();
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
    if (this.visible && !this.frame) this.frame = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    this.frame = 0;
    if (!this.visible) return;
    const moving = this.controls.update(); // true while damping is still settling
    if (this.dirty || moving) {
      this.dirty = false;
      this.renderer.render(this.model.scene, this.model.camera);
    }
    const callbacks = this.afterRender.splice(0);
    for (const cb of callbacks) cb();
    if (moving || this.dirty) this.frame = requestAnimationFrame(() => this.tick());
  }

  dispose(): void {
    this.setVisible(false);
    this.model.reset();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
