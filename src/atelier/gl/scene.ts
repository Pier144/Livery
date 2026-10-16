import * as THREE from 'three';
import type { PartGroup } from '@/types';
import type { VehicleModelData } from '../modelBuffer';
import type { Vec3 } from '../project';

/**
 * The editor's 3D view (plan Task 21): a three.js renderer drawing the vehicle with the Baker's
 * preview materials, a small orbit camera (turn, move, zoom; quick views), raycasts for the brush
 * and a square thumbnail. It renders on demand (`requestRender`: after a bake, a camera move or a
 * resize), never in a constant loop.
 *
 * Model space is right-handed with Y up and the vehicle's nose on +X (Dagor's X forward, z already
 * negated by the backend), so +Z is the vehicle's right side.
 *
 * The camera maths are pure helpers below (Vitest covers them without WebGL).
 */

export type QuickView = 'front' | 'side' | 'rear' | 'top';
export const QUICK_VIEWS: readonly QuickView[] = ['front', 'side', 'rear', 'top'];

/** Camera position around `target`: `radius`, azimuth `theta` (from +X towards +Z), polar `phi` (from +Y). */
export interface OrbitState {
  target: Vec3;
  radius: number;
  theta: number;
  phi: number;
}

/** What the brush hits. */
export interface SceneHit {
  point: Vec3;
  /** Unit face normal, model space. */
  normal: Vec3;
  /** The part's node name and its group ("Only this part"). */
  node: string;
  group: PartGroup;
  /** Camera to the hit, model units. */
  distance: number;
}

/** Vertical field of view, degrees. */
export const FOV = 35;
/** Polar angle kept away from the poles (the camera never flips over the top). */
export const PHI_MIN = 0.01;
export const PHI_MAX = Math.PI - 0.01;
/** Radians per dragged pixel. */
export const ORBIT_SPEED = 0.008;
/** Zoom limits, in multiples of the framing distance. */
export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 6;
/** Polar angle of the front, side and rear quick views (a little from above). */
const VIEW_PHI = (78 * Math.PI) / 180;
/** The view a model opens in: front-left three-quarters, from above. */
const DEFAULT_THETA = -Math.PI / 4;
const DEFAULT_PHI = (64 * Math.PI) / 180;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Distance at which a sphere of `radius` fits the view (vertical FOV `fovDeg`, width / height
 * `aspect`: a view narrower than tall is limited by its horizontal FOV), with a margin.
 */
export function framingDistance(radius: number, fovDeg = FOV, aspect = 1): number {
  const r = radius > 0 ? radius : 1;
  const half = (fovDeg * Math.PI) / 360;
  const horizontal = Math.atan(Math.tan(half) * (aspect > 0 ? aspect : 1));
  return (r / Math.sin(Math.min(half, horizontal))) * 1.08;
}

/** Camera position of an orbit. */
export function orbitPosition(o: OrbitState): Vec3 {
  const s = Math.sin(o.phi);
  return [o.target[0] + o.radius * s * Math.cos(o.theta), o.target[1] + o.radius * Math.cos(o.phi), o.target[2] + o.radius * s * Math.sin(o.theta)];
}

/** The orbit turned by a drag of (`dx`, `dy`) pixels: right turns the vehicle right, down looks from higher. */
export function orbitDrag(o: OrbitState, dx: number, dy: number): OrbitState {
  return { ...o, theta: o.theta + dx * ORBIT_SPEED, phi: clamp(o.phi - dy * ORBIT_SPEED, PHI_MIN, PHI_MAX) };
}

/** The orbit zoomed by a wheel delta (positive: away), kept within `framing · [ZOOM_MIN, ZOOM_MAX]`. */
export function orbitZoom(o: OrbitState, deltaY: number, framing: number): OrbitState {
  return { ...o, radius: clamp(o.radius * Math.exp(deltaY * 0.0015), framing * ZOOM_MIN, framing * ZOOM_MAX) };
}

/** A quick view of the model centred at `center`, at the framing distance. */
export function quickViewOrbit(view: QuickView, center: Vec3, framing: number): OrbitState {
  switch (view) {
    case 'front':
      return { target: center, radius: framing, theta: 0, phi: VIEW_PHI };
    case 'rear':
      return { target: center, radius: framing, theta: Math.PI, phi: VIEW_PHI };
    case 'side':
      // The left side (+Z is the right): the camera on −Z sees the nose on the right.
      return { target: center, radius: framing, theta: -Math.PI / 2, phi: VIEW_PHI };
    case 'top':
      // From just behind the zenith, so the nose points up the screen.
      return { target: center, radius: framing, theta: Math.PI, phi: PHI_MIN };
  }
}

/** The orbit a model opens in. */
export function defaultOrbit(center: Vec3, framing: number): OrbitState {
  return { target: center, radius: framing, theta: DEFAULT_THETA, phi: DEFAULT_PHI };
}

/**
 * Screen radius in CSS pixels of a sphere of `radius` at `distance` from a perspective camera
 * (vertical FOV `fovDeg`) drawn `viewHeight` CSS pixels tall.
 */
export function projectedRadius(radius: number, distance: number, viewHeight: number, fovDeg = FOV): number {
  if (distance <= 0) return 0;
  return (radius / (distance * Math.tan((fovDeg * Math.PI) / 360))) * (viewHeight / 2);
}

/** Rows bottom-to-top (WebGL read-back) to top-to-bottom, and premultiplied alpha to straight. */
export function toStraightTopDown(gl: Uint8Array, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * row;
    const dst = y * row;
    for (let x = 0; x < row; x += 4) {
      const a = gl[src + x + 3]!;
      if (a === 0) continue;
      const k = 255 / a;
      out[dst + x] = gl[src + x]! * k;
      out[dst + x + 1] = gl[src + x + 1]! * k;
      out[dst + x + 2] = gl[src + x + 2]! * k;
      out[dst + x + 3] = a;
    }
  }
  return out;
}

/** RGBA (top-to-bottom, straight alpha) to PNG bytes, through a 2D canvas. */
export async function encodePng(rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('thumbnail: no 2D context');
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('thumbnail: encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

interface PartMesh {
  mesh: THREE.Mesh;
  node: string;
  group: PartGroup;
}

/**
 * The 3D view. Construct with the renderer the Baker uses (its render targets must live in the
 * same WebGL context), then `setModel`. The canvas's parent element is observed for its size.
 */
export class EditorScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.6);
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly scratch = new THREE.Vector3();
  private readonly resize: ResizeObserver | null;
  private parts: PartMesh[] = [];
  private geometry: THREE.BufferGeometry | null = null;
  private center: Vec3 = [0, 0, 0];
  private framing = framingDistance(1);
  private orbit: OrbitState = defaultOrbit([0, 0, 0], framingDistance(1));
  private frame: number | null = null;
  private readonly renderListeners = new Set<() => void>();
  private width = 1;
  private height = 1;
  private disposed = false;
  /** Bounding-sphere radius of the model (brush sizes are relative to it). */
  boundingRadius = 1;

  constructor(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.canvas = canvas;
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Soft sky/ground fill plus a light that follows the camera, so whatever the brush faces is lit.
    this.scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x3a3833, 1.1));
    this.camera.add(this.headlight);
    this.headlight.position.set(0.4, 0.6, 1);
    this.scene.add(this.camera);
    const parent = canvas.parentElement;
    if (parent && typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.fitToParent());
      this.resize.observe(parent);
    } else {
      this.resize = null;
    }
    this.fitToParent();
  }

  /** Draws `model`: one mesh per part (shared vertex arrays, its own index range), with `material(slotIndex)`. */
  setModel(model: VehicleModelData, material: (slot: number) => THREE.Material): void {
    this.clearModel();
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(model.positions, 3);
    const normal = new THREE.BufferAttribute(model.normals, 3);
    const uv = new THREE.BufferAttribute(model.uvs, 2);
    geometry.setAttribute('position', position);
    this.geometry = geometry;
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
    this.center = [sphere.center.x, sphere.center.y, sphere.center.z];
    this.boundingRadius = sphere.radius > 0 ? sphere.radius : 1;

    for (const part of model.header.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', position);
      g.setAttribute('normal', normal);
      g.setAttribute('uv', uv);
      g.setIndex(new THREE.BufferAttribute(model.indices.subarray(part.indexOffset, part.indexOffset + part.indexCount), 1));
      // Bounds of the part's own vertices (the shared arrays hold the whole model), for fast raycast rejects.
      const box = new THREE.Box3();
      const p = model.positions;
      const end = Math.min(part.vertexOffset + part.vertexCount, p.length / 3);
      for (let i = part.vertexOffset; i < end; i++) box.expandByPoint(this.scratch.set(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!));
      g.boundingBox = box;
      g.boundingSphere = box.isEmpty() ? new THREE.Sphere() : box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, material(part.slot));
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.parts.push({ mesh, node: part.node, group: part.group });
    }

    const radius = this.boundingRadius;
    this.camera.near = radius * 0.01;
    this.camera.far = radius * 60;
    this.framing = framingDistance(radius, FOV, this.width / this.height);
    this.setOrbit(defaultOrbit(this.center, this.framing));
  }

  /** Renders a frame at the next animation frame (several requests in one frame draw once). */
  requestRender = (): void => {
    if (this.disposed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  };

  /** Draws now. */
  render(): void {
    if (this.disposed) return;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
    for (const listener of this.renderListeners) listener();
  }

  /** Calls `listener` after every frame drawn (overlays that follow the camera); returns the unsubscribe. */
  onRender(listener: () => void): () => void {
    this.renderListeners.add(listener);
    return () => this.renderListeners.delete(listener);
  }

  /** The view's size in CSS pixels. */
  viewSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** The camera's world matrix, column-major (`Matrix4.elements`): `frameFromHit` takes its screen-up. */
  cameraMatrixWorld(): number[] {
    return [...this.camera.matrixWorld.elements];
  }

  /**
   * A model-space point on the canvas, in CSS pixels from its top-left; `behind` when it lies
   * behind the camera (its x, y are then meaningless).
   */
  project(p: Vec3): { x: number; y: number; behind: boolean } {
    const v = this.scratch.set(p[0], p[1], p[2]).applyMatrix4(this.camera.matrixWorldInverse);
    const behind = v.z >= 0;
    v.applyMatrix4(this.camera.projectionMatrix);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height, behind };
  }

  quickView(view: QuickView): void {
    this.setOrbit(quickViewOrbit(view, this.center, this.framing));
  }

  orbitBy(dx: number, dy: number): void {
    this.setOrbit(orbitDrag(this.orbit, dx, dy));
  }

  /** Moves the view by a drag of (`dx`, `dy`) CSS pixels: what is under the pointer stays under it. */
  panBy(dx: number, dy: number): void {
    const perPixel = (2 * this.orbit.radius * Math.tan((FOV * Math.PI) / 360)) / this.height;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0).multiplyScalar(-dx * perPixel);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1).multiplyScalar(dy * perPixel);
    const t = this.orbit.target;
    // The target stays within reach of the model.
    const limit = this.boundingRadius * 2;
    const next: Vec3 = [
      clamp(t[0] + right.x + up.x, this.center[0] - limit, this.center[0] + limit),
      clamp(t[1] + right.y + up.y, this.center[1] - limit, this.center[1] + limit),
      clamp(t[2] + right.z + up.z, this.center[2] - limit, this.center[2] + limit),
    ];
    this.setOrbit({ ...this.orbit, target: next });
  }

  zoomBy(deltaY: number): void {
    this.setOrbit(orbitZoom(this.orbit, deltaY, this.framing));
  }

  /** Unit direction the camera looks along (model space). */
  viewDirection(): Vec3 {
    const d = this.camera.getWorldDirection(this.scratch);
    return [d.x, d.y, d.z];
  }

  /** CSS-pixel radius of a model-space sphere of `radius` at `distance` from the camera. */
  pixelRadius(radius: number, distance: number): number {
    return projectedRadius(radius, distance, this.height);
  }

  /**
   * The nearest part under the canvas point (`x`, `y`) in CSS pixels, or null; with `group`, only
   * that part group's meshes are hit (a decal limited to the turret slides on the turret).
   */
  raycast(x: number, y: number, group: PartGroup | null = null): SceneHit | null {
    const parts = group === null ? this.parts : this.parts.filter((p) => p.group === group);
    if (parts.length === 0) return null;
    this.ndc.set((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      parts.map((p) => p.mesh),
      false,
    );
    const hit = hits[0];
    if (!hit) return null;
    const part = this.parts.find((p) => p.mesh === hit.object);
    if (!part) return null;
    const n = hit.face?.normal ?? new THREE.Vector3(0, 1, 0);
    return {
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [n.x, n.y, n.z],
      node: part.node,
      group: part.group,
      distance: hit.distance,
    };
  }

  /** The camera as it is now (to restore it later with `setView`). */
  view(): OrbitState {
    return { ...this.orbit, target: [...this.orbit.target] as Vec3 };
  }

  /** Puts the camera back where `view()` found it (zoom kept within this model's limits). */
  setView(o: OrbitState): void {
    this.setOrbit({ ...o, target: [...o.target] as Vec3, radius: clamp(o.radius, this.framing * ZOOM_MIN, this.framing * ZOOM_MAX) });
  }

  /** The WebGL context is lost (nothing renders until the browser restores it). */
  contextLost(): boolean {
    return this.renderer.getContext().isContextLost();
  }

  /**
   * The model from the opening three-quarter view (front-left, a little from above, framed to the
   * model), rendered off-screen square at `size` px with a transparent background, as PNG bytes.
   * The camera the user moved isn't used. The picture is read back synchronously; only the PNG
   * encoding is asynchronous, so the scene may be disposed right after the call.
   */
  thumbnailPng(size = 512): Promise<Uint8Array> {
    const target = new THREE.WebGLRenderTarget(size, size, {
      samples: 4,
      colorSpace: THREE.SRGBColorSpace,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
    });
    const pixels = new Uint8Array(size * size * 4);
    const previous = this.renderer.getRenderTarget();
    const view = this.orbit;
    // The scene's own camera (its headlight follows it), moved for the shot and put back.
    this.placeCamera(defaultOrbit(this.center, framingDistance(this.boundingRadius, FOV, 1)));
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    } finally {
      this.renderer.setRenderTarget(previous);
      target.dispose();
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.placeCamera(view);
    }
    return encodePng(toStraightTopDown(pixels, size, size), size, size);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.resize?.disconnect();
    this.renderListeners.clear();
    this.clearModel();
    this.headlight.dispose();
  }

  // ---------------------------------------------------------------- internals

  private clearModel(): void {
    for (const p of this.parts) {
      this.scene.remove(p.mesh);
      // The part geometries share the model's vertex attributes; disposing each releases its index.
      p.mesh.geometry.dispose();
    }
    this.parts = [];
    this.geometry?.dispose();
    this.geometry = null;
  }

  private setOrbit(o: OrbitState): void {
    this.orbit = o;
    this.placeCamera(o);
    this.requestRender();
  }

  private placeCamera(o: OrbitState): void {
    const [x, y, z] = orbitPosition(o);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(o.target[0], o.target[1], o.target[2]);
    this.camera.updateMatrixWorld();
  }

  private fitToParent(): void {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, Math.round(parent?.clientWidth ?? this.canvas.clientWidth ?? 1));
    const h = Math.max(1, Math.round(parent?.clientHeight ?? this.canvas.clientHeight ?? 1));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Quick views and zoom limits follow the new shape (the current view stays as it is).
    this.framing = framingDistance(this.boundingRadius, FOV, w / h);
    // Rendered right away: a resized canvas is cleared, waiting a frame would flash it empty.
    this.render();
  }
}
