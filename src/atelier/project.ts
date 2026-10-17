import type { CropRect, PartGroup } from '@/types';

/**
 * The layer schema of an Atelier project (`AtelierProject.layers`, stored by Rust as opaque
 * JSON). This version knows the Base, image, text and shape layers (projected decals), merged
 * objects (several pieces sharing one frame), folders and the Protected areas (mask); any other
 * kind a project holds (a later Livery's layers) is kept as it came and listed as unsupported.
 *
 * Layers run bottom to top: exactly one Base, always first; at most one mask, always last; placed,
 * folder and unsupported layers in between, in the order saved. Folders sit only at the top level
 * and hold placed and unsupported layers; merged objects hold pieces. Colours are project data stored as
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

/** The camo styles (`BaseLayer.pattern`); absent means organic. */
export type CamoPattern = 'organic' | 'digital' | 'hex' | 'splinter' | 'triangles' | 'stripes';
export const CAMO_PATTERNS: readonly CamoPattern[] = ['organic', 'digital', 'hex', 'splinter', 'triangles', 'stripes'];

export interface BaseLayer extends LayerCommon {
  kind: 'base';
  mode: BaseMode;
  /** `#rrggbb`: one for solid (the first is used), 2 to 4 for camo. */
  colors: string[];
  /** Camo pattern scale (model units per noise cell, relative). */
  scale: number;
  seed: number;
  /**
   * Wear, 0 to 1: chipped paint along the model's sharp edges, spreading to flat surfaces as it
   * grows (`wear.ts`). Left out when 0, so older projects and files without it read as unworn.
   */
  wear?: number;
  /**
   * The camo style; absent = organic (and organic is never written). A style this version doesn't
   * know is kept as written and drawn as organic. Like the fields below, absent in older projects,
   * which therefore render as they always did.
   */
  pattern?: CamoPattern | (string & {});
  /** Share of each camo colour (same length as `colors`, each ≥ MIN_CAMO_WEIGHT, sum 1); absent = equal. */
  weights?: number[];
  /** Cell size multiplier of the digital, hex and triangle styles (CELL_SIZE_MIN..MAX); absent = 1. */
  cellSize?: number;
  /** Stripe angle in degrees (STRIPE_ANGLE_MIN..MAX, 0 = vertical bands on the sides); absent = DEFAULT_STRIPE_ANGLE. */
  angle?: number;
  /** Softness of the colour edges, 0 to 1; absent (never written as 0) = sharp. */
  softness?: number;
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
  /**
   * Wear, 0 to 1: chipped paint along the model's sharp edges, spreading to flat surfaces as it
   * grows (`wear.ts`). Left out when 0, so older projects and files without it read as unworn.
   */
  wear?: number;
  /** Copies in a row or column; absent = one copy. */
  repeat?: Repeat;
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
  /**
   * Wear, 0 to 1: chipped paint along the model's sharp edges, spreading to flat surfaces as it
   * grows (`wear.ts`). Left out when 0, so older projects and files without it read as unworn.
   */
  wear?: number;
  /** Copies in a row or column; absent = one copy. */
  repeat?: Repeat;
}

/** A layer kind this version can't edit: shown as unsupported and saved back exactly as it came. */
export interface UnsupportedLayer extends LayerCommon {
  kind: 'unsupported';
  /** The layer's own kind, e.g. `sticker`. */
  original: Record<string, unknown> & { kind: string };
}

/** The stock shapes (`ShapeLayer.shape`). */
export type ShapeKind = 'rect' | 'ellipse' | 'star' | 'polygon';
export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'star', 'polygon'];

/**
 * How a shape is filled. Stripes alternate `colors[0]` and `colors[1]` at equal widths:
 * `stripeWidth` in metres on the vehicle (stretching a band adds stripes instead of widening
 * them), `angle` in degrees from the frame's vertical, positive leaning right.
 */
export type ShapeFill =
  | { kind: 'solid'; color: string }
  | { kind: 'stripes'; colors: [string, string]; angle: number; stripeWidth: number };

/**
 * Copies of a placed layer in a row (along the frame's right) or a column (downwards). The layer's
 * `decal` is the first copy; copy i sits `i × (1 + gap)` copy widths (row) or heights (column)
 * away, on the same plane.
 */
export interface Repeat {
  /** 2 to MAX_REPEAT. */
  count: number;
  /** Space between copies, as a fraction of the copy's width (row) or height (column), 0 to MAX_REPEAT_GAP. */
  gap: number;
  direction: 'row' | 'column';
  /** `#rrggbb` of every second copy (shapes with a solid fill only; kept but ignored elsewhere). */
  alternate?: string;
}

/** A stock shape filling its frame (stars and polygons inscribed in the frame's ellipse, one vertex up). */
export interface ShapeLayer extends LayerCommon {
  kind: 'shape';
  /** A kind this version doesn't know is kept as written and drawn as a rectangle. */
  shape: ShapeKind | (string & {});
  /** Rect only: corner radius, 0 to MAX_CORNER of the short side; absent = sharp. */
  corner?: number;
  /** Star points / polygon sides, MIN_SHAPE_POINTS to MAX_SHAPE_POINTS; absent = DEFAULT_STAR_POINTS / DEFAULT_POLYGON_SIDES. */
  points?: number;
  /** Star only: inner radius over outer, MIN_INNER_RATIO to MAX_INNER_RATIO; absent = DEFAULT_INNER_RATIO. */
  innerRatio?: number;
  fill: ShapeFill;
  outlineColor: string;
  /** Outline width in hundredths of the short side (0 to MAX_OUTLINE_WIDTH). */
  outlineWidth: number;
  /** Null as for images. */
  decal: Decal | null;
  opacity: number;
  /** Wear as on images; left out when 0. */
  wear?: number;
  repeat?: Repeat;
}

/**
 * Where a piece sits in its merged object's frame: centre `x, y` in fractions of the frame's
 * width/height (-0.5..0.5 inside, may exceed slightly), size `w, h` in fractions, `angle` in
 * radians counter-clockwise from the frame's up.
 */
export interface Place {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}

/** What a merged object holds. */
export type PieceLayer = ImageLayer | TextLayer | ShapeLayer;
/** A piece of a merged object: the layer without its own frame, repeat, part or mirror. */
export type Piece = (Omit<ImageLayer, 'decal' | 'repeat'> | Omit<TextLayer, 'decal' | 'repeat'> | Omit<ShapeLayer, 'decal' | 'repeat'>) & {
  place: Place;
};
/** A piece of a kind this version doesn't know: saved back as it came, not drawn. */
export type UnsupportedPiece = UnsupportedLayer & { place?: Place };

/** Several pieces sharing one frame and projection ("Merged object"). */
export interface MergedLayer extends LayerCommon {
  kind: 'merged';
  decal: Decal | null;
  opacity: number;
  repeat?: Repeat;
  /** Bottom to top, 1 to MAX_PIECES, at least one of them drawable. */
  children: (Piece | UnsupportedPiece)[];
}

/** A named group in the Layers panel (one level: never inside another folder). */
export interface FolderLayer extends LayerCommon {
  kind: 'folder';
  collapsed: boolean;
  /** Bottom to top. */
  children: (PlacedLayer | UnsupportedLayer)[];
}

/** Pictures and text: what code that measures text or cuts out pictures handles. */
export type DecalLayer = ImageLayer | TextLayer;
/** Everything that has a frame on the vehicle (`decal`). */
export type PlacedLayer = ImageLayer | TextLayer | ShapeLayer | MergedLayer;
export type Layer = BaseLayer | PlacedLayer | FolderLayer | MaskLayer | UnsupportedLayer;

export const DEFAULT_BASE_COLOR = '#56603f';
/** Second camo colour when a camo Base has only one. */
export const DEFAULT_CAMO_COLOR = '#8a7a55';
export const MIN_CAMO_COLORS = 2;
export const MAX_CAMO_COLORS = 4;
/** Smallest share of a camo colour. */
export const MIN_CAMO_WEIGHT = 0.05;
export const CELL_SIZE_MIN = 0.25;
export const CELL_SIZE_MAX = 4;
export const STRIPE_ANGLE_MIN = -80;
export const STRIPE_ANGLE_MAX = 80;
export const DEFAULT_STRIPE_ANGLE = 30;
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

export const MAX_REPEAT = 50;
export const MAX_REPEAT_GAP = 5;
export const DEFAULT_REPEAT_GAP = 0.5;
/** A copy's projection depth grows by this much per metre of distance from the first copy. */
export const REPEAT_DEPTH_GROWTH = 0.35;
export const MAX_PIECES = 50;
/** Copies and pieces the bake draws at most. */
export const MAX_DRAW_ITEMS = 400;
/** Merging is refused when pieces face more than this many degrees apart. */
export const MERGE_MAX_ANGLE_DEG = 35;
export const MAX_SHAPE_POINTS = 12;
export const MIN_SHAPE_POINTS = 3;
export const DEFAULT_STAR_POINTS = 5;
export const DEFAULT_POLYGON_SIDES = 6;
export const MIN_INNER_RATIO = 0.15;
export const MAX_INNER_RATIO = 0.9;
export const DEFAULT_INNER_RATIO = 0.45;
export const MAX_CORNER = 0.5;
/** Stripe width of a striped shape, in metres on the vehicle. */
export const STRIPE_WIDTH_MIN = 0.01;
export const STRIPE_WIDTH_MAX = 1;
export const DEFAULT_STRIPE_WIDTH = 0.08;
export const SHAPE_STRIPE_ANGLE_MIN = -80;
export const SHAPE_STRIPE_ANGLE_MAX = 80;
export const DEFAULT_SHAPE_STRIPE_ANGLE = 45;
/** A usable yellow, also the light colour of the hazard stripe. */
export const DEFAULT_SHAPE_COLOR = '#e8b600';
export const HAZARD_DARK = '#141414';
/** The hazard stripe preset's frame, width over height. */
export const HAZARD_ASPECT = 8;

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

/** A new shape with the defaults (no corner, points or inner ratio written: absent means default). */
export function newShapeLayer(shape: ShapeKind, decal: Decal | null = null, name = ''): ShapeLayer {
  return {
    id: newLayerId(),
    kind: 'shape',
    name,
    visible: true,
    shape,
    fill: { kind: 'solid', color: DEFAULT_SHAPE_COLOR },
    outlineColor: DEFAULT_OUTLINE_COLOR,
    outlineWidth: 0,
    decal,
    opacity: 1,
  };
}

/** The hazard stripe preset: a rectangle striped yellow and black at 45°, meant for a HAZARD_ASPECT frame. */
export function newHazardStripe(name: string, decal: Decal | null = null): ShapeLayer {
  return {
    ...newShapeLayer('rect', decal, name),
    fill: { kind: 'stripes', colors: [DEFAULT_SHAPE_COLOR, HAZARD_DARK], angle: DEFAULT_SHAPE_STRIPE_ANGLE, stripeWidth: DEFAULT_STRIPE_WIDTH },
  };
}

export function newFolder(name: string, children: (PlacedLayer | UnsupportedLayer)[] = []): FolderLayer {
  return { id: newLayerId(), kind: 'folder', name, visible: true, collapsed: false, children };
}

/** Image, text, shape and merged layers: everything with a frame on the vehicle. */
export function isPlacedLayer(layer: Layer | undefined | null): layer is PlacedLayer {
  const kind = layer?.kind;
  return kind === 'image' || kind === 'text' || kind === 'shape' || kind === 'merged';
}

/** Image and text layers only. */
export function isPictureLayer(layer: Layer | undefined | null): layer is DecalLayer {
  return layer?.kind === 'image' || layer?.kind === 'text';
}

/** The top-level image and text layers, bottom to top. */
export function decalLayers(layers: readonly Layer[]): DecalLayer[] {
  return layers.filter(isPictureLayer);
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
  const base: BaseLayer = {
    ...raw,
    ...common(raw),
    kind: 'base',
    mode,
    colors,
    scale: isFiniteNumber(raw.scale) && raw.scale > 0 ? raw.scale : 1,
    seed: isFiniteNumber(raw.seed) ? Math.trunc(raw.seed) : 1,
  };
  delete base.pattern;
  delete base.weights;
  delete base.cellSize;
  delete base.angle;
  delete base.softness;
  if (typeof raw.pattern === 'string' && raw.pattern.length > 0 && raw.pattern !== 'organic') base.pattern = raw.pattern;
  const weights = raw.weights;
  if (Array.isArray(weights) && weights.length === colors.length && weights.every((w) => isFiniteNumber(w) && w > 0)) {
    base.weights = normalizeWeights(weights as number[]);
  }
  if (isFiniteNumber(raw.cellSize)) base.cellSize = clamp(raw.cellSize, CELL_SIZE_MIN, CELL_SIZE_MAX);
  if (isFiniteNumber(raw.angle)) base.angle = clamp(raw.angle, STRIPE_ANGLE_MIN, STRIPE_ANGLE_MAX);
  if (isFiniteNumber(raw.softness) && raw.softness > 0) base.softness = Math.min(1, raw.softness);
  return withWear(base, raw.wear);
}

/**
 * Camo shares that check out: scaled to sum 1, every share below MIN_CAMO_WEIGHT pinned to it and
 * the others scaled to fill the rest (repeated until none is below), rounded to 4 decimals with
 * the largest share taking the rounding rest. Idempotent. Expects finite positive numbers.
 */
export function normalizeWeights(weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  let w = weights.map((v) => v / total);
  const pinned = new Set<number>();
  for (let round = 0; round <= w.length; round++) {
    const low = w.findIndex((v, i) => !pinned.has(i) && v < MIN_CAMO_WEIGHT);
    if (low < 0) break;
    w.forEach((v, i) => {
      if (!pinned.has(i) && v < MIN_CAMO_WEIGHT) pinned.add(i);
    });
    const free = w.reduce((a, v, i) => (pinned.has(i) ? a : a + v), 0);
    const room = 1 - pinned.size * MIN_CAMO_WEIGHT;
    w = w.map((v, i) => (pinned.has(i) ? MIN_CAMO_WEIGHT : (v / free) * room));
  }
  const rounded = w.map((v) => Math.round(v * 10000) / 10000);
  let largest = 0;
  rounded.forEach((v, i) => {
    if (v > rounded[largest]!) largest = i;
  });
  const rest = rounded.reduce((a, v, i) => (i === largest ? a : a + v), 0);
  rounded[largest] = Math.round((1 - rest) * 10000) / 10000;
  return rounded;
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

/** `layer` with its `wear` read from `raw`: kept only above 0 (at most 1), otherwise left out. */
function withWear<T extends { wear?: number }>(layer: T, raw: unknown): T {
  if (isFiniteNumber(raw) && raw > 0) layer.wear = Math.min(1, raw);
  else delete layer.wear;
  return layer;
}
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
  return withRepeat(withWear(layer, raw.wear), raw.repeat);
}

function toFont(v: unknown): FontRef {
  // A plain family name (an early draft of the schema) is read as its regular style.
  if (typeof v === 'string' && v.length > 0) return { family: v, style: DEFAULT_FONT.style };
  if (!isObject(v) || typeof v.family !== 'string' || v.family.length === 0) return { ...DEFAULT_FONT };
  return { ...v, family: v.family, style: typeof v.style === 'string' && v.style.length > 0 ? v.style : DEFAULT_FONT.style };
}

function toText(raw: Record<string, unknown>): TextLayer {
  const layer: TextLayer = {
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
  return withRepeat(withWear(layer, raw.wear), raw.repeat);
}

/** A repeat that checks out, or null (no repeat): a count below 2 or not a number means one copy. */
function toRepeat(raw: unknown): Repeat | null {
  if (!isObject(raw) || !isFiniteNumber(raw.count)) return null;
  const count = Math.trunc(raw.count);
  if (count < 2) return null;
  const repeat: Repeat = {
    ...raw,
    count: Math.min(MAX_REPEAT, count),
    gap: clamped(raw.gap, 0, MAX_REPEAT_GAP, DEFAULT_REPEAT_GAP),
    direction: raw.direction === 'column' ? 'column' : 'row',
  };
  if (typeof raw.alternate === 'string' && HEX_COLOR.test(raw.alternate)) repeat.alternate = raw.alternate.toLowerCase();
  else delete repeat.alternate;
  return repeat;
}

/** `layer` with its `repeat` read from `raw`, left out when it doesn't check out. */
function withRepeat<T extends { repeat?: Repeat }>(layer: T, raw: unknown): T {
  const repeat = toRepeat(raw);
  if (repeat) layer.repeat = repeat;
  else delete layer.repeat;
  return layer;
}

const DEFAULT_FILL: ShapeFill = { kind: 'solid', color: DEFAULT_SHAPE_COLOR };

function toFill(raw: unknown): ShapeFill {
  if (!isObject(raw)) return { ...DEFAULT_FILL };
  if (raw.kind === 'stripes') {
    const colors = Array.isArray(raw.colors) ? raw.colors : [];
    return {
      ...raw,
      kind: 'stripes',
      colors: [color(colors[0], DEFAULT_SHAPE_COLOR), color(colors[1], HAZARD_DARK)],
      angle: clamped(raw.angle, SHAPE_STRIPE_ANGLE_MIN, SHAPE_STRIPE_ANGLE_MAX, DEFAULT_SHAPE_STRIPE_ANGLE),
      stripeWidth: clamped(raw.stripeWidth, STRIPE_WIDTH_MIN, STRIPE_WIDTH_MAX, DEFAULT_STRIPE_WIDTH),
    };
  }
  // A solid fill needs its colour; anything else (a fill kind this version doesn't know) is the default.
  if (raw.kind === 'solid' && typeof raw.color === 'string' && HEX_COLOR.test(raw.color)) return { ...raw, kind: 'solid', color: raw.color.toLowerCase() };
  return { ...DEFAULT_FILL };
}

function toShape(raw: Record<string, unknown>): ShapeLayer {
  const layer: ShapeLayer = {
    ...raw,
    ...common(raw),
    kind: 'shape',
    shape: typeof raw.shape === 'string' && raw.shape.length > 0 ? raw.shape : 'rect',
    fill: toFill(raw.fill),
    outlineColor: color(raw.outlineColor, DEFAULT_OUTLINE_COLOR),
    outlineWidth: clamped(raw.outlineWidth, 0, MAX_OUTLINE_WIDTH, 0),
    decal: toDecal(raw.decal),
    opacity: clamped(raw.opacity, 0, 1, 1),
  };
  // Kept whatever the shape, so switching kinds back and forth keeps the user's settings.
  delete layer.corner;
  delete layer.points;
  delete layer.innerRatio;
  if (isFiniteNumber(raw.corner)) layer.corner = clamp(raw.corner, 0, MAX_CORNER);
  if (isFiniteNumber(raw.points)) layer.points = clamp(Math.round(raw.points), MIN_SHAPE_POINTS, MAX_SHAPE_POINTS);
  if (isFiniteNumber(raw.innerRatio)) layer.innerRatio = clamp(raw.innerRatio, MIN_INNER_RATIO, MAX_INNER_RATIO);
  return withRepeat(withWear(layer, raw.wear), raw.repeat);
}

/** A place that checks out (finite numbers, positive size), or null. */
function toPlace(raw: unknown): Place | null {
  if (!isObject(raw)) return null;
  const { x, y, w, h, angle } = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h) || !isFiniteNumber(angle)) return null;
  if (w <= 0 || h <= 0) return null;
  return { ...raw, x, y, w, h, angle };
}

/** Tracks the structural repairs of one `checkLayers` run. */
interface Repairs {
  repaired: boolean;
}

const unsupported = (raw: Record<string, unknown> & { kind: string }): UnsupportedLayer => ({ ...common(raw), kind: 'unsupported', original: raw });

/**
 * A piece that checks out, an unsupported piece (a kind this version doesn't know, or an image
 * without its asset, with its place when valid), or null: dropped (not a layer; a Base, mask,
 * folder or merged object; a drawable piece without a valid place).
 */
function toPiece(raw: unknown, repairs: Repairs): Piece | UnsupportedPiece | null {
  if (!isObject(raw) || typeof raw.kind !== 'string' || raw.kind.length === 0) return null;
  const kind = raw.kind;
  if (kind === 'base' || kind === 'mask' || kind === 'folder' || kind === 'merged') {
    repairs.repaired = true;
    return null;
  }
  const place = toPlace(raw.place);
  const layer: PieceLayer | null = kind === 'image' ? toImage(raw) : kind === 'text' ? toText(raw) : kind === 'shape' ? toShape(raw) : null;
  if (!layer) {
    const piece: UnsupportedPiece = unsupported(raw as UnsupportedLayer['original']);
    if (place) piece.place = place;
    return piece;
  }
  if (!place) {
    repairs.repaired = true;
    return null;
  }
  // The merged object's frame, repeat, part and mirror apply: the piece has none of its own.
  const piece = { ...layer, place } as Partial<PieceLayer> & { place: Place };
  delete piece.decal;
  delete piece.repeat;
  return piece as Piece;
}

/** A merged object that checks out, or null (dropped) when no drawable piece is left. */
function toMerged(raw: Record<string, unknown>, repairs: Repairs): MergedLayer | null {
  const children = (Array.isArray(raw.children) ? raw.children : [])
    .map((c) => toPiece(c, repairs))
    .filter((c): c is Piece | UnsupportedPiece => c !== null);
  if (children.length > MAX_PIECES) {
    repairs.repaired = true;
    children.length = MAX_PIECES;
  }
  if (!children.some((c) => c.kind !== 'unsupported')) {
    repairs.repaired = true;
    return null;
  }
  const layer: MergedLayer = {
    ...raw,
    ...common(raw),
    kind: 'merged',
    decal: toDecal(raw.decal),
    opacity: clamped(raw.opacity, 0, 1, 1),
    children,
  };
  return withRepeat(layer, raw.repeat);
}

/**
 * A folder with its children checked. Children that don't belong in a folder (folders, a Base, a
 * mask) are still in `children` here: `checkLayers` moves them out.
 */
function toFolder(raw: Record<string, unknown>, repairs: Repairs): Omit<FolderLayer, 'children'> & { children: Layer[] } {
  const children = (Array.isArray(raw.children) ? raw.children : []).map((c) => toLayer(c, repairs)).filter((l): l is Layer => l !== null);
  return { ...raw, ...common(raw), kind: 'folder', collapsed: raw.collapsed === true, children };
}

/** A placed layer (from the store's edits) checked like a loaded one; null when it no longer is one. */
export function checkPlacedLayer(layer: PlacedLayer): PlacedLayer | null {
  const raw = layer as unknown as Record<string, unknown>;
  const repairs: Repairs = { repaired: false };
  switch (layer.kind) {
    case 'image':
      return toImage(raw);
    case 'text':
      return toText(raw);
    case 'shape':
      return toShape(raw);
    case 'merged':
      return toMerged(raw, repairs);
    default:
      return null;
  }
}

/** A piece (from the store's edits) checked like a loaded one; null when it no longer is a drawable piece. */
export function checkPiece(piece: Piece): Piece | null {
  const checked = toPiece(piece, { repaired: false });
  return checked && checked.kind !== 'unsupported' ? checked : null;
}

function toLayer(raw: unknown, repairs: Repairs): Layer | null {
  if (!isObject(raw) || typeof raw.kind !== 'string' || raw.kind.length === 0) return null;
  switch (raw.kind) {
    case 'base':
      return toBase(raw);
    case 'mask':
      return toMask(raw);
    case 'text':
      return toText(raw);
    case 'shape':
      return toShape(raw);
    case 'merged':
      return toMerged(raw, repairs);
    case 'folder':
      // Nested content is sorted out by `checkLayers`.
      return toFolder(raw, repairs) as unknown as FolderLayer;
  }
  const image = raw.kind === 'image' ? toImage(raw) : null;
  if (image) return image;
  return unsupported(raw as UnsupportedLayer['original']);
}

/**
 * A top-level folder made to hold only placed and unsupported layers: its own layers first, then
 * what was nested and is moved out (folders right above it, each flattened the same way; a Base
 * or mask set aside in `pinned`).
 */
function flattenFolder(folder: FolderLayer, pinned: Layer[], repairs: Repairs): Layer[] {
  const kept: (PlacedLayer | UnsupportedLayer)[] = [];
  const lifted: Layer[] = [];
  for (const child of folder.children as Layer[]) {
    if (child.kind === 'folder') lifted.push(...flattenFolder(child, pinned, repairs));
    else if (child.kind === 'base' || child.kind === 'mask') pinned.push(child);
    else {
      kept.push(child);
      continue;
    }
    repairs.repaired = true;
  }
  return [{ ...folder, children: kept }, ...lifted];
}

/**
 * The layers of a project file, repaired: entries that aren't layers are dropped, fields that
 * don't check out get their defaults, a missing Base is added and the Base moved to the bottom,
 * only the first Base and mask are kept, the mask pinned at the top, and repeated ids are renewed
 * (across the whole tree: folder children and merged pieces included, top-level layers keeping
 * theirs). Folders inside a folder are moved out right above it; a Base or mask inside a folder
 * goes to its pinned place when the top level has none, otherwise it is dropped. Merged objects
 * lose pieces that can't be pieces, and are dropped when no drawable piece is left.
 * `repaired` is true when one of those structural repairs changed what the project means (a
 * Base added, layers moved or dropped, ids renewed): the project then needs saving. Field
 * defaults and kept unknown fields alone don't count.
 */
export function checkLayers(json: unknown): { layers: Layer[]; repaired: boolean } {
  const repairs: Repairs = { repaired: false };
  const parsed = (Array.isArray(json) ? json : []).map((raw) => toLayer(raw, repairs)).filter((l): l is Layer => l !== null);
  // Base and mask layers found in folders queue up behind the top-level ones.
  const pinned: Layer[] = [];
  const flat = parsed.flatMap((l) => (l.kind === 'folder' ? flattenFolder(l, pinned, repairs) : [l]));
  const all = [...flat, ...pinned];
  const bases = all.filter((l): l is BaseLayer => l.kind === 'base');
  const masks = all.filter((l): l is MaskLayer => l.kind === 'mask');
  const base = bases[0] ?? newBaseLayer();
  const mask = masks[0];
  const middle = flat.filter((l) => l.kind !== 'base' && l.kind !== 'mask');
  const ordered: Layer[] = [base, ...middle, ...(mask ? [mask] : [])];
  let repaired =
    repairs.repaired ||
    bases.length !== 1 ||
    masks.length > 1 ||
    parsed[0] !== base ||
    (mask !== undefined && parsed[parsed.length - 1] !== mask);
  const seen = new Set<string>();
  const unique = <T extends LayerCommon>(l: T): T => {
    if (!seen.has(l.id)) {
      seen.add(l.id);
      return l;
    }
    repaired = true;
    const renewed = { ...l, id: newLayerId() };
    seen.add(renewed.id);
    return renewed;
  };
  const uniquePieces = (l: MergedLayer): MergedLayer => ({ ...l, children: l.children.map(unique) });
  // Top-level ids first, so a nested layer repeating one is the one renewed.
  const layers = ordered.map(unique).map((l) => {
    if (l.kind === 'merged') return uniquePieces(l);
    if (l.kind !== 'folder') return l;
    const children = l.children.map(unique);
    return { ...l, children: children.map((c) => (c.kind === 'merged' ? uniquePieces(c) : c)) };
  });
  return { layers, repaired };
}

/** `checkLayers` without the repair flag. */
export function validateLayers(json: unknown): Layer[] {
  return checkLayers(json).layers;
}

function serializePiece(p: Piece | UnsupportedPiece): unknown {
  if (p.kind !== 'unsupported') return p;
  return { ...p.original, id: p.id, name: p.name, visible: p.visible, ...(p.place ? { place: p.place } : {}) };
}

function serializeLayer(l: Layer): unknown {
  if (l.kind === 'unsupported') return { ...l.original, id: l.id, name: l.name, visible: l.visible };
  if (l.kind === 'folder') return { ...l, children: l.children.map(serializeLayer) };
  if (l.kind === 'merged') return { ...l, children: l.children.map(serializePiece) };
  return l;
}

/** The layers as `project.json` stores them (unsupported layers and pieces exactly as they came). */
export function serializeLayers(layers: readonly Layer[]): unknown[] {
  return layers.map(serializeLayer);
}

/** The Base (always first after `validateLayers`). */
export function baseOf(layers: readonly Layer[]): BaseLayer | undefined {
  return layers.find((l): l is BaseLayer => l.kind === 'base');
}

/** The Protected areas layer, if the project has one (always last). */
export function maskOf(layers: readonly Layer[]): MaskLayer | undefined {
  return layers.find((l): l is MaskLayer => l.kind === 'mask');
}
