import { envelopeOf, mirrorAsOne, pieceDecal, repeatDecals } from './merge';
import { MAX_DRAW_ITEMS, type Decal, type Layer, type MergedLayer, type Piece, type PieceLayer, type Place } from './project';

/**
 * What the bake projects (spec "drawItems"), flattened from the layer tree (pure: no three.js, no
 * DOM, no store). A draw group is one picture (an image, a text or a shape) and every box it is
 * projected through: a layer's repeat copies, a merged piece's place in each copy of its frame,
 * and their Mirror copies. Mirror is applied here on the envelope (`mirrorAsOne`), so every box
 * comes out with `mirror: false` and nothing mirrors it again.
 *
 * Groups are memoised per layer object (top-level layer or folder child) and mirror axis: an
 * unchanged layer gives the same `DrawGroup` objects and boxes on every call, so the Baker's
 * identity checks and its density cache (keyed by `rasterDecal`) keep working, and renaming or
 * collapsing a folder re-bakes nothing.
 */

/** One picture and the boxes it is drawn through. */
export interface DrawGroup {
  /** Binding id, stable: layer id; `${mergedId}/${pieceId}` for pieces; `:alt` suffix for the alternate colour. */
  id: string;
  /** What the picture is drawn from. A piece comes as the layer it would be: its first box as `decal`, no place, no repeat. */
  source: PieceLayer;
  /** `alt`: the shape filled with its repeat's `alternate` colour (every second copy). */
  variant: 'main' | 'alt';
  /** Final boxes: repeat copies (of this variant) then their mirror copies, all `mirror: false`. */
  boxes: Decal[];
  /** The first copy's box (raster size, texel density); for `alt`, the first alternate copy's. */
  rasterDecal: Decal;
  /** Layer opacity; piece × merged object for pieces. */
  opacity: number;
  wear: number | undefined;
  /** True only for image sources with `flipX`. */
  flipX: boolean;
}

/** The groups to draw, bottom to top, and the boxes they hold (at most the budget). */
export interface DrawPlan {
  groups: DrawGroup[];
  boxes: number;
  /** Some layers (the topmost) aren't drawn: drawing them would pass the budget. */
  truncated: boolean;
}

const memo = new WeakMap<Layer, Map<number, DrawGroup[]>>();

const mirrorOff = (box: Decal): Decal => (box.mirror ? { ...box, mirror: false } : box);

function group(id: string, source: PieceLayer, variant: DrawGroup['variant'], boxes: Decal[], rasterDecal: Decal, opacity: number): DrawGroup {
  return {
    id,
    source,
    variant,
    boxes,
    rasterDecal,
    opacity,
    wear: source.wear,
    flipX: source.kind === 'image' && source.flipX,
  };
}

/** An image, text or shape layer: its repeat copies (split by alternate colour) and their mirror copies. */
function plainGroups(layer: PieceLayer, axis: number): DrawGroup[] {
  const decal = layer.decal;
  if (!layer.visible || !decal || !(layer.opacity > 0)) return [];
  const copies = repeatDecals(decal, layer.repeat);
  const mirrored = decal.mirror ? mirrorAsOne(copies, envelopeOf(decal, layer.repeat), axis) : null;
  const alternate = layer.kind === 'shape' && layer.fill.kind === 'solid' ? layer.repeat?.alternate : undefined;
  const split = alternate !== undefined && copies.length > 1;
  const main: Decal[] = [];
  const mainMirrored: Decal[] = [];
  const alt: Decal[] = [];
  const altMirrored: Decal[] = [];
  copies.forEach((copy, i) => {
    const isAlt = split && i % 2 === 1;
    (isAlt ? alt : main).push(mirrorOff(copy));
    const m = mirrored?.[i];
    if (m) (isAlt ? altMirrored : mainMirrored).push(m);
  });
  const groups = [group(layer.id, layer, 'main', [...main, ...mainMirrored], main[0]!, layer.opacity)];
  if (alternate !== undefined && alt.length > 0 && layer.kind === 'shape') {
    const source = { ...layer, fill: { kind: 'solid' as const, color: alternate } };
    groups.push(group(`${layer.id}:alt`, source, 'alt', [...alt, ...altMirrored], alt[0]!, layer.opacity));
  }
  return groups;
}

/** A merged object: each drawable piece through every copy of the frame, mirrored as one picture. */
function mergedGroups(merged: MergedLayer, axis: number): DrawGroup[] {
  const frame = merged.decal;
  if (!merged.visible || !frame || !(merged.opacity > 0)) return [];
  const frames = repeatDecals(frame, merged.repeat);
  const drawn: { piece: Piece; opacity: number; boxes: Decal[] }[] = [];
  for (const child of merged.children) {
    if (child.kind === 'unsupported') continue;
    const opacity = child.opacity * merged.opacity;
    if (!child.visible || !(opacity > 0)) continue;
    drawn.push({ piece: child, opacity, boxes: frames.map((f) => pieceDecal(f, child.place)) });
  }
  const mirrored = frame.mirror
    ? mirrorAsOne(
        drawn.flatMap((d) => d.boxes),
        envelopeOf(frame, merged.repeat),
        axis,
      )
    : null;
  return drawn.map(({ piece, opacity, boxes }, k) => {
    const own = mirrored ? mirrored.slice(k * frames.length, (k + 1) * frames.length) : [];
    const source = { ...piece, decal: boxes[0]! } as PieceLayer & { place?: Place };
    delete source.place;
    delete source.repeat;
    return group(`${merged.id}/${piece.id}`, source, 'main', [...boxes, ...own], boxes[0]!, opacity);
  });
}

/** The groups of one layer that isn't a folder (memoised per layer object and axis). */
function layerGroups(layer: Layer, axis: number): DrawGroup[] {
  let byAxis = memo.get(layer);
  const hit = byAxis?.get(axis);
  if (hit) return hit;
  let groups: DrawGroup[];
  switch (layer.kind) {
    case 'image':
    case 'text':
    case 'shape':
      groups = plainGroups(layer, axis);
      break;
    case 'merged':
      groups = mergedGroups(layer, axis);
      break;
    default:
      groups = [];
  }
  if (!byAxis) {
    byAxis = new Map();
    memo.set(layer, byAxis);
  }
  byAxis.set(axis, groups);
  return groups;
}

/**
 * The draw groups of `layers`, bottom to top: folders (unless hidden) contribute their children in
 * order; hidden, unplaced or fully transparent layers, the Base, the mask and unsupported layers or
 * pieces contribute nothing. At most `budget` boxes in all (mirror copies counted): at the first
 * layer whose boxes would pass it, that layer and everything above are left out (`truncated`).
 */
export function drawGroups(layers: readonly Layer[], mirrorAxis: number, budget = MAX_DRAW_ITEMS): DrawPlan {
  const groups: DrawGroup[] = [];
  let boxes = 0;
  const flat = layers.flatMap((l) => (l.kind === 'folder' ? (l.visible ? l.children : []) : [l]));
  for (const layer of flat) {
    const own = layerGroups(layer, mirrorAxis);
    const count = own.reduce((n, g) => n + g.boxes.length, 0);
    if (boxes + count > budget) return { groups, boxes, truncated: true };
    groups.push(...own);
    boxes += count;
  }
  return { groups, boxes, truncated: false };
}
