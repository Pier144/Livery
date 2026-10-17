import type { CropRect } from '@/types';
import {
  CELL_SIZE_MAX,
  CELL_SIZE_MIN,
  DEFAULT_BASE_COLOR,
  DEFAULT_CAMO_COLOR,
  DEFAULT_DIR,
  DEFAULT_FONT,
  DEFAULT_OUTLINE_COLOR,
  DEFAULT_REPEAT_GAP,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_SHAPE_STRIPE_ANGLE,
  DEFAULT_STRIPE_WIDTH,
  DEFAULT_TEXT_COLOR,
  HAZARD_DARK,
  MAX_CAMO_COLORS,
  MAX_CORNER,
  MAX_DECAL_SIZE,
  MAX_INNER_RATIO,
  MAX_OUTLINE_WIDTH,
  MAX_PIECES,
  MAX_REPEAT,
  MAX_REPEAT_GAP,
  MAX_SHAPE_POINTS,
  MAX_SKEW,
  MAX_TEXT_CHARS,
  MIN_CAMO_COLORS,
  MIN_DECAL_SIZE,
  MIN_INNER_RATIO,
  MIN_SHAPE_POINTS,
  SHAPE_STRIPE_ANGLE_MAX,
  SHAPE_STRIPE_ANGLE_MIN,
  STRIPE_ANGLE_MAX,
  STRIPE_ANGLE_MIN,
  STRIPE_WIDTH_MAX,
  STRIPE_WIDTH_MIN,
  defaultDepth,
  newBaseLayer,
  newLayerId,
  normalizeWeights,
  orthoFrame,
  type BaseLayer,
  type BaseMode,
  type Decal,
  type FolderLayer,
  type FontRef,
  type ImageLayer,
  type Layer,
  type LayerCommon,
  type MaskLayer,
  type MergedLayer,
  type Piece,
  type PieceLayer,
  type Place,
  type PlacedLayer,
  type Repeat,
  type ShapeFill,
  type ShapeLayer,
  type Stroke,
  type TextLayer,
  type UnsupportedLayer,
  type UnsupportedPiece,
  type Vec3,
} from './project';

/**
 * Checking and saving the layer schema (`project.ts`): what a project file holds is read into
 * layers that check out (`checkLayers`), the store's edits are checked the same way
 * (`checkPlacedLayer`, `checkPiece`), and layers are written back as `project.json` stores them
 * (`serializeLayers`).
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
 * An unsupported layer or piece already checked (in memory, e.g. inside an edited merged object),
 * kept as it is so checking again never wraps its `original` a second time; null for anything else.
 */
function alreadyUnsupported(raw: Record<string, unknown>): UnsupportedLayer | null {
  if (raw.kind !== 'unsupported' || !isObject(raw.original)) return null;
  const original = raw.original;
  if (typeof original.kind !== 'string' || original.kind.length === 0) return null;
  return { ...common(raw), kind: 'unsupported', original: original as UnsupportedLayer['original'] };
}

/**
 * A piece that checks out, an unsupported piece (a kind this version doesn't know, or an image
 * without its asset, with its place when valid), or null: dropped (not a layer; a Base, mask,
 * folder or merged object; a drawable piece without a valid place).
 */
function toPiece(raw: unknown, repairs: Repairs): Piece | UnsupportedPiece | null {
  if (!isObject(raw) || typeof raw.kind !== 'string' || raw.kind.length === 0) return null;
  const kept = alreadyUnsupported(raw);
  if (kept) {
    const place = toPlace(raw.place);
    return place ? { ...kept, place } : kept;
  }
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

/**
 * A merged object that checks out; an unsupported layer exactly as it came when every piece left
 * is unsupported (a later Livery's pieces: kept and saved back, not drawn); null (dropped) when no
 * piece is left at all.
 */
function toMerged(raw: Record<string, unknown>, repairs: Repairs): MergedLayer | UnsupportedLayer | null {
  // The pieces' repairs only count once it is clear the object is checked rather than kept as it came.
  const own: Repairs = { repaired: false };
  const children = (Array.isArray(raw.children) ? raw.children : [])
    .map((c) => toPiece(c, own))
    .filter((c): c is Piece | UnsupportedPiece => c !== null);
  if (children.length === 0) {
    repairs.repaired = true;
    return null;
  }
  if (!children.some((c) => c.kind !== 'unsupported')) return unsupported(raw as UnsupportedLayer['original']);
  if (own.repaired) repairs.repaired = true;
  if (children.length > MAX_PIECES) {
    repairs.repaired = true;
    children.length = MAX_PIECES;
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
    case 'merged': {
      const merged = toMerged(raw, repairs);
      return merged?.kind === 'merged' ? merged : null;
    }
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
  const kept = alreadyUnsupported(raw);
  if (kept) return kept;
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
      // Safe: `toLayer` is only called by `checkLayers` (top level, and folder children via `toFolder`), which flattens every folder before returning.
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
