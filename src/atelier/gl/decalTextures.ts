import * as THREE from 'three';

/**
 * The pictures decals project (image assets and text rasters) as GPU textures, shared by key
 * and reference-counted: a texture lives while some layer needs it and is disposed with its last
 * reference. Uploads are **premultiplied on the CPU** before mipmapping, so the colour a cutout
 * keeps under alpha 0 never bleeds into the edges through filtering; sRGB numbers as stored
 * (`NoColorSpace`), mipmapped, clamped to the edge. Preview copies are capped at
 * PREVIEW_DECAL_MAX on the long side (a box filter in premultiplied space); full-size copies
 * are only made for export.
 */

/** Long side of a decal picture in the preview (export uses the full size). */
export const PREVIEW_DECAL_MAX = 2048;

/** Straight-alpha RGBA, rows top to bottom (row 0 is the picture's top). */
export interface DecalImage {
  rgba: Uint8Array;
  w: number;
  h: number;
}

/** `rgba` with its colour multiplied by alpha (rounded), a new array. */
export function premultiply(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    out[i] = Math.round((rgba[i]! * a) / 255);
    out[i + 1] = Math.round((rgba[i + 1]! * a) / 255);
    out[i + 2] = Math.round((rgba[i + 2]! * a) / 255);
    out[i + 3] = a;
  }
  return out;
}

/** The integer reduction that brings the long side to at most `max` (1 = none). */
export function reductionFor(w: number, h: number, max: number): number {
  return Math.max(1, Math.ceil(Math.max(w, h) / max));
}

/**
 * Box-filtered reduction by an integer `factor` (edge blocks average what they have). Meant for
 * premultiplied data, where averaging is correct.
 */
export function reduce(rgba: Uint8Array, w: number, h: number, factor: number): DecalImage {
  if (factor <= 1) return { rgba, w, h };
  const ow = Math.max(1, Math.ceil(w / factor));
  const oh = Math.max(1, Math.ceil(h / factor));
  const out = new Uint8Array(ow * oh * 4);
  const sum = new Float64Array(4);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      sum.fill(0);
      let n = 0;
      for (let y = oy * factor; y < Math.min(h, (oy + 1) * factor); y++) {
        for (let x = ox * factor; x < Math.min(w, (ox + 1) * factor); x++) {
          const p = (y * w + x) * 4;
          sum[0]! += rgba[p]!;
          sum[1]! += rgba[p + 1]!;
          sum[2]! += rgba[p + 2]!;
          sum[3]! += rgba[p + 3]!;
          n++;
        }
      }
      const q = (oy * ow + ox) * 4;
      for (let c = 0; c < 4; c++) out[q + c] = Math.round(sum[c]! / n);
    }
  }
  return { rgba: out, w: ow, h: oh };
}

/** A premultiplied picture, reduced to fit `maxSide` (none when `maxSide` is Infinity). */
export function prepareDecalImage(image: DecalImage, maxSide: number): DecalImage {
  const pre = premultiply(image.rgba);
  return reduce(pre, image.w, image.h, Number.isFinite(maxSide) ? reductionFor(image.w, image.h, maxSide) : 1);
}

/** The GPU texture of a prepared (premultiplied) picture; its CPU copy is dropped after upload. */
export function makeDecalTexture(image: DecalImage): THREE.DataTexture {
  const t = new THREE.DataTexture(image.rgba, image.w, image.h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.onUpdate = (texture: THREE.Texture) => {
    (texture.image as { data: unknown }).data = null;
  };
  t.needsUpdate = true;
  return t;
}

type EntryState = 'loading' | 'ready' | 'failed';

interface Entry {
  refs: number;
  state: EntryState;
  texture: THREE.Texture | null;
  /** Settles (never rejects) when the current load ends. */
  promise: Promise<void>;
  make: () => Promise<DecalImage | null>;
  maxSide: number;
  /** Bumped per load, so a load that ended after a reload or the last release is dropped. */
  generation: number;
}

export interface DecalTextureCacheOptions {
  /** A load ended (ready or failed) for a key that is still referenced. */
  onSettled?: (key: string) => void;
  /** Builds the GPU texture (tests swap it out). */
  createTexture?: (image: DecalImage) => THREE.Texture;
}

/** Decal textures by key (`img:<asset>:p|f`, `txt:<hash>:<px>`), reference-counted. */
export class DecalTextureCache {
  private readonly entries = new Map<string, Entry>();
  private readonly options: DecalTextureCacheOptions;
  private disposed = false;

  constructor(options: DecalTextureCacheOptions = {}) {
    this.options = options;
  }

  /**
   * One more reference to `key`; the first starts loading it with `make` (straight-alpha
   * picture, or null when there is nothing to draw), prepared to fit `maxSide`.
   */
  acquire(key: string, make: () => Promise<DecalImage | null>, maxSide = PREVIEW_DECAL_MAX): void {
    if (this.disposed) return;
    const known = this.entries.get(key);
    if (known) {
      known.refs++;
      return;
    }
    const entry: Entry = { refs: 1, state: 'loading', texture: null, promise: Promise.resolve(), make, maxSide, generation: 0 };
    this.entries.set(key, entry);
    this.load(key, entry);
  }

  /** One reference less; the last one disposes the texture (or drops the load in flight). */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    entry.generation++;
    entry.texture?.dispose();
    this.entries.delete(key);
  }

  /** The texture once loaded (null while loading, after a failure or when nothing is drawn). */
  get(key: string): THREE.Texture | null {
    return this.entries.get(key)?.texture ?? null;
  }

  /** Loaded, failed or unknown (anything that won't change any more). */
  settled(key: string): boolean {
    const entry = this.entries.get(key);
    return !entry || entry.state !== 'loading';
  }

  /** Resolves when the loads of `keys` have ended (immediately for settled ones). */
  async whenSettled(keys: Iterable<string>): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry && entry.state === 'loading') pending.push(entry.promise);
    }
    await Promise.all(pending);
  }

  /** Referenced keys (tests, diagnostics). */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  refs(key: string): number {
    return this.entries.get(key)?.refs ?? 0;
  }

  /** Every texture is gone (a lost WebGL context, or its CPU copy was dropped): load them again. */
  reloadAll(): void {
    for (const [key, entry] of this.entries) {
      entry.texture?.dispose();
      entry.texture = null;
      this.load(key, entry);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.generation++;
      entry.texture?.dispose();
    }
    this.entries.clear();
  }

  private load(key: string, entry: Entry): void {
    entry.generation++;
    const generation = entry.generation;
    entry.state = 'loading';
    entry.promise = (async () => {
      let texture: THREE.Texture | null = null;
      let failed = false;
      try {
        const image = await entry.make();
        if (image && image.w > 0 && image.h > 0) {
          const prepared = prepareDecalImage(image, entry.maxSide);
          texture = (this.options.createTexture ?? makeDecalTexture)(prepared);
        }
      } catch (e) {
        failed = true;
        console.warn(`Atelier: decal picture ${key} not loaded`, e);
      }
      if (entry.generation !== generation || this.entries.get(key) !== entry) {
        texture?.dispose();
        return;
      }
      entry.texture = texture;
      entry.state = failed ? 'failed' : 'ready';
      this.options.onSettled?.(key);
    })();
  }
}
