import type { AssetRef, CropRect } from '@/types';
import {
  MAX_DECAL_SIZE,
  MIN_DECAL_SIZE,
  add,
  decalRight,
  scale,
  type BaseLayer,
  type Decal,
  type ImageLayer,
  type Layer,
  type Piece,
  type PlacedLayer,
  type Repeat,
  type ShapeLayer,
  type TextLayer,
  type UnsupportedPiece,
} from './project';
import { checkPiece, checkPlacedLayer, toDecal } from './projectCheck';
import { isPiece, mapLayers, type Found, type TreeItem } from './layerTree';
import { measureTextAspect } from './text';

/**
 * The editor's edits of one layer (the Base, a placed layer or a piece), as pure functions: each
 * answers the edited layer, checked, or null when the edit doesn't check out. Text layers and
 * pieces get their width from the measured text.
 */

/** What a Base edit may change. */
export type BasePatch = Partial<Pick<BaseLayer, 'mode' | 'colors' | 'scale' | 'seed' | 'wear' | 'pattern' | 'weights' | 'cellSize' | 'angle' | 'softness'>>;

/**
 * What `setLayerProps` may change on a placed layer or a piece (fields the layer's kind doesn't
 * have are dropped). `repeat: null` removes the repeat.
 */
export type LayerPropsPatch = Partial<
  Omit<ImageLayer, 'id' | 'kind' | 'decal' | 'repeat'> &
    Omit<TextLayer, 'id' | 'kind' | 'decal' | 'repeat'> &
    Omit<ShapeLayer, 'id' | 'kind' | 'decal' | 'repeat'>
> & { repeat?: Repeat | null };

/** The fields `setLayerProps` takes, per kind (everything else in a patch is dropped). */
const COMMON_PROPS = ['name', 'visible', 'opacity', 'wear', 'repeat'] as const;
const PROPS_OF: Record<PlacedLayer['kind'], readonly string[]> = {
  image: [...COMMON_PROPS, 'assetId', 'flipX', 'sourceAssetId', 'sourceOffset'],
  text: [...COMMON_PROPS, 'text', 'font', 'color', 'outlineColor', 'outlineWidth', 'skew'],
  shape: [...COMMON_PROPS, 'shape', 'corner', 'points', 'innerRatio', 'fill', 'outlineColor', 'outlineWidth'],
  merged: ['name', 'opacity', 'repeat'],
};

/** What a text measurer reads. */
type MeasuredText = Pick<TextLayer, 'text' | 'font' | 'outlineWidth' | 'skew'>;

/**
 * The width / height of a text layer or piece as drawn now (its font, or the stand-in while the
 * font loads), or null when it can't be measured. Defaults to `measureTextAspect` (text.ts); tests
 * set their own.
 */
export type TextMeasurer = (layer: MeasuredText) => number | null;

let textMeasurer: TextMeasurer | null = measureTextAspect;

/** Sets how text layers are measured (null: text widths are left as they are). */
export function setTextMeasurer(measurer: TextMeasurer | null): void {
  textMeasurer = measurer;
}

/** The measured aspect of a text, or null when there is none worth using. */
function measured(text: MeasuredText): number | null {
  if (!textMeasurer) return null;
  const aspect = textMeasurer(text);
  return aspect === null || !Number.isFinite(aspect) || aspect <= 0 ? null : aspect;
}

/** `layer` with a text decal's width set from the measured aspect (the same object when nothing changes). */
export function withTextWidth<T extends PlacedLayer>(layer: T): T {
  if (layer.kind !== 'text' || !layer.decal) return layer;
  const aspect = measured(layer);
  if (aspect === null) return layer;
  const width = Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, layer.decal.height * aspect));
  return width === layer.decal.width ? layer : { ...layer, decal: { ...layer.decal, width } };
}

/**
 * A text piece with its place's width set from the measured aspect, its centre and height kept
 * and the frame not refitted (the same object when nothing changes or it isn't a text piece).
 */
function withPieceTextWidth<T extends Piece | UnsupportedPiece>(piece: T, frame: Decal | null): T {
  if (piece.kind !== 'text' || !frame) return piece;
  const aspect = measured(piece);
  if (aspect === null) return piece;
  const metres = Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, piece.place.h * frame.height * aspect));
  const w = metres / frame.width;
  return w === piece.place.w ? piece : { ...piece, place: { ...piece.place, w } };
}

/**
 * `layers` with the text layer or piece `layerId` re-measured, or the same array when nothing
 * changes. A merge keeps the first copy's id, so the id is looked for among pieces too.
 */
export function remeasured(layers: Layer[], layerId: string): Layer[] {
  return mapLayers(layers, (item) => {
    if (item.id === layerId && item.kind === 'text' && 'decal' in item) return withTextWidth(item);
    if (item.kind !== 'merged' || !item.children.some((c) => c.id === layerId)) return item;
    const children = item.children.map((c) => (c.id === layerId ? withPieceTextWidth(c, item.decal) : c));
    return children.every((c, i) => c === item.children[i]) ? item : { ...item, children };
  });
}

/** The Base with `patch` applied; no wear, the defaults and shares that don't match the colours are no field. */
export function patchedBase(base: BaseLayer, patch: BasePatch): BaseLayer {
  const next: BaseLayer = { ...base, ...patch };
  // No wear is no field, as in a loaded project.
  if (!(next.wear !== undefined && next.wear > 0)) delete next.wear;
  else next.wear = Math.min(1, next.wear);
  // Defaults are no field either (organic, equal shares, sharp), and shares follow the colours.
  if (next.pattern === undefined || next.pattern === 'organic') delete next.pattern;
  if (next.weights === undefined || next.weights.length !== next.colors.length) delete next.weights;
  if (!(next.softness !== undefined && next.softness > 0)) delete next.softness;
  else next.softness = Math.min(1, next.softness);
  if (next.cellSize === undefined) delete next.cellSize;
  if (next.angle === undefined) delete next.angle;
  return next;
}

/**
 * The found placed layer or piece with `patch` applied (see `setLayerProps`), checked and
 * re-measured; null when it isn't one or the result doesn't check out.
 */
export function withProps(found: Found, patch: LayerPropsPatch): TreeItem | null {
  if (found.layer.kind === 'unsupported') return null;
  const kind = found.layer.kind;
  if (kind !== 'image' && kind !== 'text' && kind !== 'shape' && kind !== 'merged') return null;
  const own: Record<string, unknown> = {};
  for (const key of PROPS_OF[kind]) if (key in patch) own[key] = (patch as Record<string, unknown>)[key];
  if (isPiece(found)) {
    // A piece has no repeat (or frame) of its own: the merged object's apply.
    delete own.repeat;
    const piece = found.layer as Piece;
    const checked = checkPiece({ ...piece, ...own, id: piece.id, kind: piece.kind, place: piece.place } as Piece);
    if (!checked) return null;
    const frame = found.parent?.kind === 'merged' ? found.parent.decal : null;
    return withPieceTextWidth(checked, frame);
  }
  const layer = found.layer as PlacedLayer;
  // A placed layer checks out as one of the same kind (or not at all); `repeat: null` is read as no repeat.
  const next = checkPlacedLayer({ ...layer, ...own, id: layer.id, kind: layer.kind, decal: layer.decal } as PlacedLayer);
  return next ? withTextWidth(next) : null;
}

/**
 * The decal refitted after a cutout: the same model units per source pixel (per axis, so a
 * stretched picture stays stretched alike), sized to the crop and moved by the crop centre's
 * offset from the source centre (image y down; mirrored along u when the layer is flipped), so
 * the picture neither stretches nor moves on the model.
 */
export function refitDecal(decal: Decal, crop: CropRect, source: { width: number; height: number }, flipX: boolean): Decal {
  const sx = decal.width / source.width;
  const sy = decal.height / source.height;
  const du = (crop.x + crop.w / 2 - source.width / 2) * sx * (flipX ? -1 : 1);
  const dv = -(crop.y + crop.h / 2 - source.height / 2) * sy;
  const center = add(add(decal.center, scale(decalRight(decal), du)), scale(decal.up, dv));
  return { ...decal, center, width: crop.w * sx, height: crop.h * sy };
}

/** An image layer switched to its cut-out picture, kept where it was on the model (see `applyCutout`); null when stale or invalid. */
export function cutoutOf(layer: PlacedLayer | null, asset: AssetRef, crop: CropRect, sourceAsset: AssetRef): ImageLayer | null {
  if (layer?.kind !== 'image' || sourceAsset.width <= 0 || sourceAsset.height <= 0 || crop.w <= 0 || crop.h <= 0) return null;
  // A stale result (undo, another cutout or an edit since it started): the layer no longer shows its source.
  if (layer.assetId !== sourceAsset.id) return null;
  // A cutout of a cutout: the crop is inside the current picture, which lies at the earlier offset in the
  // original. Without a known offset, the current picture becomes the source.
  const composed = layer.sourceAssetId !== undefined && layer.sourceOffset !== undefined;
  const before = composed ? layer.sourceOffset : undefined;
  const sourceOffset: CropRect = { x: (before?.x ?? 0) + crop.x, y: (before?.y ?? 0) + crop.y, w: crop.w, h: crop.h };
  const refit = layer.decal ? toDecal(refitDecal(layer.decal, crop, sourceAsset, layer.flipX)) : null;
  return {
    ...layer,
    assetId: asset.id,
    sourceAssetId: composed ? layer.sourceAssetId : sourceAsset.id,
    sourceOffset,
    decal: refit ?? layer.decal,
  };
}
