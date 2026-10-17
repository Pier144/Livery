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
 * Livery) are kept on every layer, decal and stroke and saved back. Checking and saving live in
 * `projectCheck.ts`.
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

/** The Base (always first after `validateLayers`). */
export function baseOf(layers: readonly Layer[]): BaseLayer | undefined {
  return layers.find((l): l is BaseLayer => l.kind === 'base');
}

/** The Protected areas layer, if the project has one (always last). */
export function maskOf(layers: readonly Layer[]): MaskLayer | undefined {
  return layers.find((l): l is MaskLayer => l.kind === 'mask');
}
