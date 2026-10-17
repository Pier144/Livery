import type { DecalImage } from './gl/decalTextures';
import {
  DEFAULT_INNER_RATIO,
  DEFAULT_POLYGON_SIDES,
  DEFAULT_STAR_POINTS,
  DEFAULT_STRIPE_WIDTH,
  MAX_CORNER,
  MAX_INNER_RATIO,
  MAX_OUTLINE_WIDTH,
  MAX_SHAPE_POINTS,
  MIN_INNER_RATIO,
  MIN_SHAPE_POINTS,
  type ShapeFill,
  type ShapeLayer,
} from './project';
import { MAX_RASTER_SIDE } from './text';

/**
 * Shape layers drawn to pixels: the geometry (pure: star and polygon vertices, stripe bands), the
 * raster cache key, and the raster the bake projects through the layer's frame (straight alpha
 * RGBA, like text).
 *
 * A shape fills its frame: rectangles and ellipses touch its sides, stars and polygons are
 * inscribed in the frame's ellipse with one vertex up, so stretching the frame stretches them.
 * The raster's aspect is the frame's quantised to sixteenth octaves (at most 2.2 % off): the
 * picture is stretched onto the exact frame, so only corner, outline and stripe proportions shift a
 * little, and an edge drag re-rasterises a few times rather than on every frame. Stripes are laid
 * out in metres on the vehicle (stretching a band adds stripes): on a frame the quantised height
 * tall and `height × aspect` wide (both quantised, so the stripes stay square to the raster), and
 * that height joins the key of striped shapes. Stripes are drawn as the first colour over the
 * whole shape with the second colour's bands on top (no seams where bands meet); stripes thinner
 * than STRIPE_MIN_PX on the raster blend into one fill of the two colours' average. The outline is drawn inside the shape's edge (clipped stroke), so the
 * frame stays the shape's outer edge.
 *
 * Canvas work uses `OffscreenCanvas` and `Path2D` (WebView2 has both; jsdom doesn't, so the
 * raster answers null there and tests stub them).
 */

type Point = [number, number];
type Ctx = OffscreenCanvasRenderingContext2D;

/** Most bands `stripeBands` lists (kept around the frame's centre). */
export const MAX_STRIPE_BANDS = 4096;
/** Stripes narrower than this on the raster (px) are drawn as one fill of the colours' average. */
export const STRIPE_MIN_PX = 1.5;

/** `v` rounded and clamped to `min..max`, `fallback` when it isn't a finite number. */
function clampedInt(v: number | undefined, min: number, max: number, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

function clamped(v: number | undefined, min: number, max: number, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/**
 * `count` points around the ellipse inscribed in `w × h` (raster pixels, y down), the first
 * pointing up (−90°), at radius `radius(i)` of the ellipse's.
 */
function ringPoints(count: number, w: number, h: number, radius: (i: number) => number): Point[] {
  const rx = w / 2;
  const ry = h / 2;
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const r = radius(i);
    out.push([rx + r * rx * Math.cos(a), ry + r * ry * Math.sin(a)]);
  }
  return out;
}

/**
 * A star's outline in raster pixels (y down): `2 × points` vertices alternating the frame
 * ellipse's radius and `innerRatio` of it, the first at the top centre.
 */
export function starPoints(points: number, innerRatio: number, w: number, h: number): [number, number][] {
  return ringPoints(2 * points, w, h, (i) => (i % 2 === 0 ? 1 : innerRatio));
}

/** A regular polygon's outline in raster pixels (y down): `sides` vertices on the frame ellipse, the first at the top centre. */
export function polygonPoints(sides: number, w: number, h: number): [number, number][] {
  return ringPoints(sides, w, h, () => 1);
}

/**
 * The stripe bands for a frame `widthM × heightM` metres, `stripeWidth` metres wide, their
 * boundaries leaning right by `angleDeg` from the vertical. Each band is a quad in metres from the
 * frame's top-left (y down) with its colour index; band k covers `s ∈ [k·sw, (k+1)·sw)` of the
 * across coordinate `s` measured from the frame's centre, so a boundary passes through the centre
 * (band 0, colour 0, starts there). Quads reach past the frame's diagonal along the boundaries,
 * and only the bands that meet the frame are listed, across from negative to positive `s`, at
 * most MAX_STRIPE_BANDS of them (around the centre).
 */
export function stripeBands(widthM: number, heightM: number, angleDeg: number, stripeWidth: number): { color: 0 | 1; quad: [number, number][] }[] {
  const sw = stripeWidthOf(stripeWidth);
  const w = Math.abs(widthM);
  const h = Math.abs(heightM);
  const a = ((Number.isFinite(angleDeg) ? angleDeg : 0) * Math.PI) / 180;
  // In (right, up) metres from the centre: along the boundary and across it.
  const along: Point = [Math.sin(a), Math.cos(a)];
  const across: Point = [Math.cos(a), -Math.sin(a)];
  // The frame's corners reach this far across; the quads this far along.
  const reach = (w / 2) * Math.abs(across[0]) + (h / 2) * Math.abs(across[1]);
  const half = Math.hypot(w, h) / 2 + sw;
  const halfCap = MAX_STRIPE_BANDS / 2;
  const kMin = Math.max(-halfCap, Math.floor(-reach / sw));
  const kMax = Math.min(halfCap - 1, Math.max(kMin, Math.ceil(reach / sw) - 1));
  // (right, up) from the centre → metres from the top-left, y down.
  const out = (s: number, t: number): Point => [w / 2 + s * across[0] + t * along[0], h / 2 - (s * across[1] + t * along[1])];
  const bands: { color: 0 | 1; quad: [number, number][] }[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const s0 = k * sw;
    const s1 = (k + 1) * sw;
    bands.push({ color: (((k % 2) + 2) % 2) as 0 | 1, quad: [out(s0, -half), out(s0, half), out(s1, half), out(s1, -half)] });
  }
  return bands;
}

/** A usable stripe width in metres: DEFAULT_STRIPE_WIDTH for zero, negative or non-finite. */
function stripeWidthOf(stripeWidth: number): number {
  return Number.isFinite(stripeWidth) && stripeWidth > 0 ? stripeWidth : DEFAULT_STRIPE_WIDTH;
}

/** The colour halfway between two `#rrggbb` colours (per channel, rounded). */
function averageColor(a: string, b: string): string {
  const channel = (c: string, i: number) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16) || 0;
  let out = '#';
  for (let i = 0; i < 3; i++) out += Math.round((channel(a, i) + channel(b, i)) / 2).toString(16).padStart(2, '0');
  return out;
}

/** `v` rounded to sixteenth octaves (`2^(round(16·log2 v)/16)`), within about 2.2 %; non-positive values as they are. */
export function quantiseOctave16(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return v;
  return 2 ** (Math.round(Math.log2(v) * 16) / 16);
}

/** The fill `variant` draws: `'alt'` swaps a solid fill's colour for the repeat's alternate. */
function fillFor(layer: Pick<ShapeLayer, 'fill' | 'repeat'>, variant: 'main' | 'alt'): ShapeFill {
  const alternate = layer.repeat?.alternate;
  return variant === 'alt' && layer.fill.kind === 'solid' && alternate ? { kind: 'solid', color: alternate } : layer.fill;
}

/**
 * The frame's quantised aspect and, for stripes, its quantised height in metres (0 when the frame
 * has none): the stripes' frame is `h` tall and `h × aspect` wide.
 */
function quantisedFrame(frame: { width: number; height: number }): { aspect: number; h: number } {
  const h = quantiseOctave16(frame.height);
  return { aspect: quantiseOctave16(frame.width / frame.height), h: h > 0 && Number.isFinite(h) ? h : 0 };
}

/**
 * The picture cache key of a shape raster `px` tall: everything that changes its pixels (the fill
 * after `variant`, the outline, the quantised aspect, and for stripes the quantised frame height), and whether
 * it's the full-size (export) or preview copy.
 */
export function shapeKey(layer: ShapeLayer, variant: 'main' | 'alt', frame: { width: number; height: number }, px: number, full: boolean): string {
  const fill = fillFor(layer, variant);
  const q = quantisedFrame(frame);
  const shape = JSON.stringify([layer.shape, layer.corner ?? 0, layer.points ?? null, layer.innerRatio ?? null, fill, layer.outlineWidth > 0 ? layer.outlineColor : null, layer.outlineWidth]);
  return `shp:${shape}:${px}:${q.aspect}${fill.kind === 'stripes' ? `:${q.h}` : ''}:${full ? 'f' : 'p'}`;
}

/** The raster size for a quantised aspect, `pxHeight` tall, the long side at most MAX_RASTER_SIDE. */
function rasterSize(aspect: number, pxHeight: number): { w: number; h: number } {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  let h = Math.max(1, Math.round(Number.isFinite(pxHeight) ? pxHeight : 1));
  let w = Math.max(1, Math.round(h * safeAspect));
  const long = Math.max(w, h);
  if (long > MAX_RASTER_SIDE) {
    const f = MAX_RASTER_SIDE / long;
    w = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.round(w * f)));
    h = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.round(h * f)));
  }
  return { w, h };
}

/** A closed path through `points`. */
function polygonPath(points: Point[]): Path2D {
  const path = new Path2D();
  points.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  path.closePath();
  return path;
}

/** The shape's outline filling `w × h` px; an unknown kind is a rectangle. */
function shapePath(layer: ShapeLayer, w: number, h: number): Path2D {
  switch (layer.shape) {
    case 'ellipse': {
      const path = new Path2D();
      path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
      path.closePath();
      return path;
    }
    case 'star':
      return polygonPath(
        starPoints(
          clampedInt(layer.points, MIN_SHAPE_POINTS, MAX_SHAPE_POINTS, DEFAULT_STAR_POINTS),
          clamped(layer.innerRatio, MIN_INNER_RATIO, MAX_INNER_RATIO, DEFAULT_INNER_RATIO),
          w,
          h,
        ),
      );
    case 'polygon':
      return polygonPath(polygonPoints(clampedInt(layer.points, MIN_SHAPE_POINTS, MAX_SHAPE_POINTS, DEFAULT_POLYGON_SIDES), w, h));
    default: {
      const path = new Path2D();
      const r = clamped(layer.corner, 0, MAX_CORNER, 0) * Math.min(w, h);
      if (r <= 0) {
        path.rect(0, 0, w, h);
        return path;
      }
      // Rounded rectangle, clockwise from the top edge's start.
      path.moveTo(r, 0);
      path.arcTo(w, 0, w, h, r);
      path.arcTo(w, h, 0, h, r);
      path.arcTo(0, h, 0, 0, r);
      path.arcTo(0, 0, w, 0, r);
      path.closePath();
      return path;
    }
  }
}

/** A 2D context on a new OffscreenCanvas in sRGB, or null where there is none (jsdom). */
function context2d(width: number, height: number): Ctx | null {
  if (typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined') return null;
  try {
    return new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  } catch {
    return null;
  }
}

/**
 * The shape drawn `pxHeight` tall, its width from the frame's quantised aspect (both scaled down
 * so the long side is at most MAX_RASTER_SIDE): the fill (solid, the repeat's alternate for
 * `variant: 'alt'`, or stripes laid out on the frame's quantised size in metres and clipped to
 * the shape, blended to their average colour when too thin to show), then the outline inside the edge. The opacity is the decal pass's, not drawn here.
 * Read back straight (canvas `getImageData`). Null without a canvas.
 */
export async function rasteriseShape(layer: ShapeLayer, variant: 'main' | 'alt', frame: { width: number; height: number }, pxHeight: number): Promise<DecalImage | null> {
  const q = quantisedFrame(frame);
  const { w, h } = rasterSize(q.aspect, pxHeight);
  const ctx = context2d(w, h);
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  const path = shapePath(layer, w, h);
  const fill = fillFor(layer, variant);
  if (fill.kind === 'solid') {
    ctx.fillStyle = fill.color;
    ctx.fill(path);
  } else {
    // Stripe space in metres: the quantised height, and the width from the quantised aspect.
    const hS = q.h;
    const wS = hS * (q.aspect > 0 && Number.isFinite(q.aspect) ? q.aspect : w / h);
    const sx = hS > 0 ? w / wS : 0;
    const sy = hS > 0 ? h / hS : 0;
    const sw = stripeWidthOf(fill.stripeWidth);
    if (!(sw * Math.min(sx, sy) >= STRIPE_MIN_PX)) {
      ctx.fillStyle = averageColor(fill.colors[0], fill.colors[1]);
      ctx.fill(path);
    } else {
      // The first colour under everything, the second's bands over it: no antialiased seams between bands.
      ctx.save();
      ctx.clip(path);
      ctx.fillStyle = fill.colors[0];
      ctx.fill(path);
      ctx.fillStyle = fill.colors[1];
      for (const band of stripeBands(wS, hS, fill.angle, sw)) {
        if (band.color === 1) ctx.fill(polygonPath(band.quad.map(([x, y]): Point => [x * sx, y * sy])));
      }
      ctx.restore();
    }
  }
  const outline = clamped(layer.outlineWidth, 0, MAX_OUTLINE_WIDTH, 0);
  if (outline > 0) {
    // Twice the width, clipped to the shape: the inner half shows, the frame stays the outer edge.
    ctx.save();
    ctx.clip(path);
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 10;
    ctx.lineWidth = 2 * (outline / 100) * Math.min(w, h);
    ctx.strokeStyle = layer.outlineColor;
    ctx.stroke(path);
    ctx.restore();
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  return { rgba: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), w, h };
}
