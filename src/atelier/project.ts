import type { CropRect, PartGroup } from '@/types';

/**
 * The layer schema of an Atelier project (`AtelierProject.layers`, stored by Rust as opaque
 * JSON). This version knows the Base, image and text layers (projected decals) and the Protected
 * areas (mask); any other kind a project holds (a later Livery's layers) is kept as it came and
 * listed as unsupported.
 *
 * Layers run bottom to top: exactly one Base, always first; at most one mask, always last; image,
 * text and unsupported layers in between, in the order saved. Colours are project data stored as
 * `#rrggbb` strings (not UI styling). Fields this version doesn't know (written by a later
 * Livery) are kept on every layer, decal and stroke and saved back.
 */

export type Vec3 = [number, number, number];

// ── Vectors (model space) ───────────────────────────────────────────────────

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
/** `a` scaled to length 1, or null when it is (nearly) zero. */
export function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  return l > 1e-9 && Number.isFinite(l) ? scale(a, 1 / l) : null;
}

/** Below this, a vector counts as unit length / two vectors as perpendicular (kept exactly as saved). */
const FRAME_EPSILON = 1e-9;

/**
 * The decal frame from a saved normal and up: the normal made unit length, `up` made
 * perpendicular to it and unit length. Vectors already fine are returned as they are (so a valid
 * project round-trips bit for bit). Null when either is zero or they are parallel.
 */
export function orthoFrame(normal: Vec3, up: Vec3): { normal: Vec3; up: Vec3 } | null {
  const n = Math.abs(length(normal) - 1) <= FRAME_EPSILON ? normal : normalize(normal);
  if (!n) return null;
  const along = dot(up, n);
  if (Math.abs(along) <= FRAME_EPSILON && Math.abs(length(up) - 1) <= FRAME_EPSILON) return { normal: n, up };
  const perp = sub(up, scale(n, along));
  // Parallel (or zero) up: no frame.
  if (length(perp) < 1e-6 * length(up)) return null;
  const u = normalize(perp);
  return u ? { normal: n, up: u } : null;
}

/** The decal's right (the picture's +u): `normalize(cross(up, normal))`, a right-handed frame. */
export function decalRight(decal: Pick<Decal, 'normal' | 'up'>): Vec3 {
  return normalize(cross(decal.up, decal.normal)) ?? [1, 0, 0];
}

/** "Only this part": every part, or one of the vehicle's three groups. */
export type PartFilter = 'all' | PartGroup;

export interface LayerCommon {
  id: string;
  /** The user's name for the layer; empty shows the kind's label (in the UI language). */
  name: string;
  visible: boolean;
}

export type BaseMode = 'solid' | 'camo';

export interface BaseLayer extends LayerCommon {
  kind: 'base';
  mode: BaseMode;
  /** `#rrggbb`: one for solid (the first is used), 2 to 4 for camo. */
  colors: string[];
  /** Camo pattern scale (model units per noise cell, relative). */
  scale: number;
  seed: number;
}

/**
 * One brush stroke of the Protected areas, in model space (resolution-independent). `part` is
 * kept as written: anything but `hull`, `turret` or `gun` means every part (`partGroupOf`).
 */
export interface Stroke {
  /** Erase gives the paint back where the stroke goes. */
  erase: boolean;
  radius: number;
  /** 0 (soft) to 1 (hard). */
  hardness: number;
  part: PartFilter | (string & {});
  /** Camera view direction when painted: only texels facing it are touched. */
  dir: Vec3;
  points: Vec3[];
}

export interface MaskLayer extends LayerCommon {
  kind: 'mask';
  strokes: Stroke[];
}

/**
 * Where an image or text layer is projected: an oriented box in model space. The picture's +u
 * runs along `decalRight(decal)` (= `cross(up, normal)`), its +v along `up`; the box spans
 * `width` × `height` on the surface and ±`depth/2` along the normal around `center`. `part` is
 * kept as written: anything but `hull`, `turret` or `gun` means every part (`partGroupOf`).
 */
export interface Decal {
  center: Vec3;
  /** Outward surface normal at the placement, unit length. */
  normal: Vec3;
  /** Unit length, perpendicular to `normal`. */
  up: Vec3;
  width: number;
  height: number;
  depth: number;
  part: PartFilter | (string & {});
  /** Mirror to the other side (a reflected copy across the model's mirror plane). */
  mirror: boolean;
}

/** A Windows font as layers store it (portable: never a file name). */
export interface FontRef {
  family: string;
  style: string;
}

export interface ImageLayer extends LayerCommon {
  kind: 'image';
  /** The picture in the project's assets (`atelier_asset`). */
  assetId: string;
  /**
   * Null when the saved placement didn't check out (non-finite or degenerate vectors, sizes): the
   * layer is kept and flagged, the bake skips it, the editor offers to place it again.
   */
  decal: Decal | null;
  /** 0 to 1. */
  opacity: number;
  flipX: boolean;
  /** The picture before Remove background (Refine edge restores from it). */
  sourceAssetId?: string;
  /** Where `assetId` lies inside `sourceAssetId` (the cutout's crop), in source pixels. */
  sourceOffset?: CropRect;
}

export interface TextLayer extends LayerCommon {
  kind: 'text';
  /** At most MAX_TEXT_CHARS characters. */
  text: string;
  font: FontRef;
  color: string;
  outlineColor: string;
  /** Outline width in hundredths of the font size (0 to MAX_OUTLINE_WIDTH). */
  outlineWidth: number;
  /** Horizontal shear, -MAX_SKEW to MAX_SKEW. */
  skew: number;
  /**
   * `height` is the text size; `width` = height × the measured aspect, written by the store with
   * every text, font, skew, outline or size edit. Null as for images.
   */
  decal: Decal | null;
  opacity: number;
}

/** A layer kind this version can't edit: shown as unsupported and saved back exactly as it came. */
export interface UnsupportedLayer extends LayerCommon {
  kind: 'unsupported';
  /** The layer's own kind, e.g. `sticker`. */
  original: Record<string, unknown> & { kind: string };
}

export type DecalLayer = ImageLayer | TextLayer;
export type Layer = BaseLayer | DecalLayer | MaskLayer | UnsupportedLayer;

export const DEFAULT_BASE_COLOR = '#56603f';
/** Second camo colour when a camo Base has only one. */
export const DEFAULT_CAMO_COLOR = '#8a7a55';
export const MIN_CAMO_COLORS = 2;
export const MAX_CAMO_COLORS = 4;
export const DEFAULT_DIR: Vec3 = [0, 0, -1];

export const MAX_TEXT_CHARS = 200;
export const MAX_OUTLINE_WIDTH = 20;
export const MAX_SKEW = 0.5;
/** Decal sides, in model units (metres). */
export const MIN_DECAL_SIZE = 0.001;
export const MAX_DECAL_SIZE = 100;
/** Box depth: 10% of the width, at least 2 cm. */
export const DEPTH_RATIO = 0.1;
export const MIN_DEPTH = 0.02;
export const DEFAULT_TEXT_COLOR = '#ffffff';
export const DEFAULT_OUTLINE_COLOR = '#000000';
/** Every Windows install has it; `atelier_fonts` names styles like `Regular`, `Bold`, `Bold Italic`. */
export const DEFAULT_FONT: FontRef = { family: 'Arial', style: 'Regular' };

/** The default depth of a decal `width` wide. */
export function defaultDepth(width: number): number {
  return Math.max(MIN_DEPTH, DEPTH_RATIO * width);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PART_GROUPS: readonly PartGroup[] = ['hull', 'turret', 'gun'];

/** The group a stroke or decal is limited to, or null for every part (`all` or a kind this version doesn't know). */
export function partGroupOf(part: string): PartGroup | null {
  return PART_GROUPS.includes(part as PartGroup) ? (part as PartGroup) : null;
}

let counter = 0;

/** A new layer id, unique within the session (and practically across them). */
export function newLayerId(): string {
  counter += 1;
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `l-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
}

export function newBaseLayer(): BaseLayer {
  return { id: newLayerId(), kind: 'base', name: '', visible: true, mode: 'solid', colors: [DEFAULT_BASE_COLOR], scale: 1, seed: 1 };
}

export function newMaskLayer(): MaskLayer {
  return { id: newLayerId(), kind: 'mask', name: '', visible: true, strokes: [] };
}

export function newImageLayer(assetId: string, decal: Decal | null, name = ''): ImageLayer {
  return { id: newLayerId(), kind: 'image', name, visible: true, assetId, decal, opacity: 1, flipX: false };
}

export function newTextLayer(text: string, decal: Decal | null, font: FontRef = DEFAULT_FONT): TextLayer {
  return {
    id: newLayerId(),
    kind: 'text',
    name: '',
    visible: true,
    text: [...text].slice(0, MAX_TEXT_CHARS).join(''),
    font: { ...font },
    color: DEFAULT_TEXT_COLOR,
    outlineColor: DEFAULT_OUTLINE_COLOR,
    outlineWidth: 0,
    skew: 0,
    decal,
    opacity: 1,
  };
}

export function isDecalLayer(layer: Layer | undefined | null): layer is DecalLayer {
  return layer?.kind === 'image' || layer?.kind === 'text';
}

/** The image and text layers, bottom to top. */
export function decalLayers(layers: readonly Layer[]): DecalLayer[] {
  return layers.filter(isDecalLayer);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);

function common(raw: Record<string, unknown>): LayerCommon {
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : newLayerId(),
    name: typeof raw.name === 'string' ? raw.name : '',
    visible: typeof raw.visible === 'boolean' ? raw.visible : true,
  };
}

function toBase(raw: Record<string, unknown>): BaseLayer {
  const mode: BaseMode = raw.mode === 'camo' ? 'camo' : 'solid';
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .filter((c): c is string => typeof c === 'string' && HEX_COLOR.test(c))
    .map((c) => c.toLowerCase())
    .slice(0, MAX_CAMO_COLORS);
  if (colors.length === 0) colors.push(DEFAULT_BASE_COLOR);
  if (mode === 'camo' && colors.length < MIN_CAMO_COLORS) colors.push(DEFAULT_CAMO_COLOR);
  return {
    ...raw,
    ...common(raw),
    kind: 'base',
    mode,
    colors,
    scale: isFiniteNumber(raw.scale) && raw.scale > 0 ? raw.scale : 1,
    seed: isFiniteNumber(raw.seed) ? Math.trunc(raw.seed) : 1,
  };
}

/** A stroke that checks out, or null (dropped). */
function toStroke(raw: unknown): Stroke | null {
  if (!isObject(raw) || !Array.isArray(raw.points) || !raw.points.every(isVec3) || raw.points.length === 0) return null;
  if (!isFiniteNumber(raw.radius) || raw.radius <= 0) return null;
  return {
    ...raw,
    erase: raw.erase === true,
    radius: raw.radius,
    hardness: isFiniteNumber(raw.hardness) ? Math.min(1, Math.max(0, raw.hardness)) : 0.5,
    part: typeof raw.part === 'string' && raw.part.length > 0 ? raw.part : 'all',
    dir: isVec3(raw.dir) ? raw.dir : DEFAULT_DIR,
    points: raw.points,
  };
}

function toMask(raw: Record<string, unknown>): MaskLayer {
  const strokes = (Array.isArray(raw.strokes) ? raw.strokes : []).map(toStroke).filter((s): s is Stroke => s !== null);
  return { ...raw, ...common(raw), kind: 'mask', strokes };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamped = (v: unknown, lo: number, hi: number, fallback: number) => (isFiniteNumber(v) ? clamp(v, lo, hi) : fallback);
const color = (v: unknown, fallback: string) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : fallback);

/**
 * A decal that checks out, or null: centre, normal and up finite (normal and up are made unit
 * length and perpendicular when they aren't), width and height finite (clamped to
 * MIN_DECAL_SIZE..MAX_DECAL_SIZE), depth clamped the same (its default when missing).
 */
export function toDecal(raw: unknown): Decal | null {
  if (!isObject(raw) || !isVec3(raw.center) || !isVec3(raw.normal) || !isVec3(raw.up)) return null;
  if (!isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) return null;
  const frame = orthoFrame(raw.normal, raw.up);
  if (!frame) return null;
  const width = clamp(raw.width, MIN_DECAL_SIZE, MAX_DECAL_SIZE);
  return {
    ...raw,
    center: raw.center,
    normal: frame.normal,
    up: frame.up,
    width,
    height: clamp(raw.height, MIN_DECAL_SIZE, MAX_DECAL_SIZE),
    depth: clamped(raw.depth, MIN_DECAL_SIZE, MAX_DECAL_SIZE, defaultDepth(width)),
    part: typeof raw.part === 'string' && raw.part.length > 0 ? raw.part : 'all',
    mirror: raw.mirror === true,
  };
}

const isRect = (v: unknown): v is CropRect =>
  isObject(v) &&
  [v.x, v.y, v.w, v.h].every((n) => isFiniteNumber(n) && n >= 0 && Number.isInteger(n)) &&
  (v.w as number) > 0 &&
  (v.h as number) > 0;

/** An image layer that checks out, or null when it has no asset (it is then kept as unsupported). */
function toImage(raw: Record<string, unknown>): ImageLayer | null {
  if (typeof raw.assetId !== 'string' || raw.assetId.length === 0) return null;
  const layer: ImageLayer = {
    ...raw,
    ...common(raw),
    kind: 'image',
    assetId: raw.assetId,
    decal: toDecal(raw.decal),
    opacity: clamped(raw.opacity, 0, 1, 1),
    flipX: raw.flipX === true,
  };
  if (typeof raw.sourceAssetId !== 'string' || raw.sourceAssetId.length === 0) delete layer.sourceAssetId;
  if (!isRect(raw.sourceOffset)) delete layer.sourceOffset;
  return layer;
}

function toFont(v: unknown): FontRef {
  // A plain family name (an early draft of the schema) is read as its regular style.
  if (typeof v === 'string' && v.length > 0) return { family: v, style: DEFAULT_FONT.style };
  if (!isObject(v) || typeof v.family !== 'string' || v.family.length === 0) return { ...DEFAULT_FONT };
  return { ...v, family: v.family, style: typeof v.style === 'string' && v.style.length > 0 ? v.style : DEFAULT_FONT.style };
}

function toText(raw: Record<string, unknown>): TextLayer {
  return {
    ...raw,
    ...common(raw),
    kind: 'text',
    text: typeof raw.text === 'string' ? [...raw.text].slice(0, MAX_TEXT_CHARS).join('') : '',
    font: toFont(raw.font),
    color: color(raw.color, DEFAULT_TEXT_COLOR),
    outlineColor: color(raw.outlineColor, DEFAULT_OUTLINE_COLOR),
    outlineWidth: clamped(raw.outlineWidth, 0, MAX_OUTLINE_WIDTH, 0),
    skew: clamped(raw.skew, -MAX_SKEW, MAX_SKEW, 0),
    decal: toDecal(raw.decal),
    opacity: clamped(raw.opacity, 0, 1, 1),
  };
}

/** An image or text layer (from the store's edits) checked like a loaded one; null when it no longer is one. */
export function checkDecalLayer(layer: DecalLayer): DecalLayer | null {
  const raw = layer as unknown as Record<string, unknown>;
  return layer.kind === 'image' ? toImage(raw) : layer.kind === 'text' ? toText(raw) : null;
}

function toLayer(raw: unknown): Layer | null {
  if (!isObject(raw) || typeof raw.kind !== 'string' || raw.kind.length === 0) return null;
  if (raw.kind === 'base') return toBase(raw);
  if (raw.kind === 'mask') return toMask(raw);
  if (raw.kind === 'text') return toText(raw);
  const image = raw.kind === 'image' ? toImage(raw) : null;
  if (image) return image;
  return { ...common(raw), kind: 'unsupported', original: raw as UnsupportedLayer['original'] };
}

/**
 * The layers of a project file, repaired: entries that aren't layers are dropped, fields that
 * don't check out get their defaults, a missing Base is added and the Base moved to the bottom,
 * only the first Base and mask are kept, the mask pinned at the top, and repeated ids are renewed.
 * `repaired` is true when one of those structural repairs changed what the project means (a
 * Base added, layers moved or dropped as extra Base/mask, ids renewed): the project then needs
 * saving. Field defaults and kept unknown fields alone don't count.
 */
export function checkLayers(json: unknown): { layers: Layer[]; repaired: boolean } {
  const parsed = (Array.isArray(json) ? json : []).map(toLayer).filter((l): l is Layer => l !== null);
  const bases = parsed.filter((l): l is BaseLayer => l.kind === 'base');
  const masks = parsed.filter((l): l is MaskLayer => l.kind === 'mask');
  const base = bases[0] ?? newBaseLayer();
  const mask = masks[0];
  const middle = parsed.filter((l) => l.kind !== 'base' && l.kind !== 'mask');
  const ordered: Layer[] = [base, ...middle, ...(mask ? [mask] : [])];
  let repaired = bases.length !== 1 || masks.length > 1 || parsed[0] !== base || (mask !== undefined && parsed[parsed.length - 1] !== mask);
  const seen = new Set<string>();
  const layers = ordered.map((l) => {
    if (!seen.has(l.id)) {
      seen.add(l.id);
      return l;
    }
    repaired = true;
    const renewed = { ...l, id: newLayerId() };
    seen.add(renewed.id);
    return renewed;
  });
  return { layers, repaired };
}

/** `checkLayers` without the repair flag. */
export function validateLayers(json: unknown): Layer[] {
  return checkLayers(json).layers;
}

/** The layers as `project.json` stores them (unsupported ones exactly as they came). */
export function serializeLayers(layers: readonly Layer[]): unknown[] {
  return layers.map((l) => (l.kind === 'unsupported' ? { ...l.original, id: l.id, name: l.name, visible: l.visible } : l));
}

/** The Base (always first after `validateLayers`). */
export function baseOf(layers: readonly Layer[]): BaseLayer | undefined {
  return layers.find((l): l is BaseLayer => l.kind === 'base');
}

/** The Protected areas layer, if the project has one (always last). */
export function maskOf(layers: readonly Layer[]): MaskLayer | undefined {
  return layers.find((l): l is MaskLayer => l.kind === 'mask');
}
