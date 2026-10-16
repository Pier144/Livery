import { fetchFontFile } from '@/queries/atelier';
import type { FontRef, TextLayer } from './project';

/**
 * Text layers drawn to pixels: fonts loaded from the backend's bytes as FontFaces, the layout
 * (pure: size, outline padding, skew), the aspect the store keeps the decal's width at, and the
 * raster the bake projects (straight alpha RGBA).
 *
 * Canvas work uses `OffscreenCanvas` (WebView2 has it; jsdom doesn't, so measuring answers null
 * there and tests stub it). Layout: the decal's height is the font's line box (font ascent +
 * descent) plus the outline on both sides; the width is the text's ink extent plus the skew's
 * slant plus the outline.
 */

/** Re-rasterise this long after the last keystroke. */
export const TEXT_DEBOUNCE_MS = 150;
/** Raster heights (px): 2 × texel density × decal height, clamped. */
export const MIN_RASTER_HEIGHT = 64;
export const MAX_RASTER_SIDE = 4096;
/** Font used while a layer's font loads, and for good when it isn't installed (self-hosted, always there). */
export const FALLBACK_FAMILY = 'Geist';
/** Size text is measured at (metrics scale linearly). */
const MEASURE_PX = 100;
/** Line box when the browser gives no font metrics, per 1 px of font size. */
const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = 0.2;

/** A text's metrics per 1 px of font size. */
export interface TextMetricsPx {
  /** Ink reaching left of the start point (≥ 0). */
  left: number;
  /** Horizontal extent: ink or advance, whichever is wider, from `-left`. */
  extent: number;
  /** The font's line box above and below the baseline. */
  ascent: number;
  descent: number;
}

export interface TextLayout {
  fontPx: number;
  /** Raster size in px (not rounded). */
  width: number;
  height: number;
  /** The outline's reach outside the glyphs (= the padding on every side), px. */
  outlinePx: number;
  /** Where the text starts and its baseline, px from the top-left. */
  originX: number;
  baselineY: number;
}

/** The layout of `layer`'s text, `pxHeight` tall (see the module comment). */
export function layoutText(m: TextMetricsPx, layer: Pick<TextLayer, 'outlineWidth' | 'skew'>, pxHeight: number): TextLayout {
  const outline = Math.max(0, layer.outlineWidth) / 100;
  const fontPx = pxHeight / (m.ascent + m.descent + 2 * outline);
  const outlinePx = outline * fontPx;
  const ascent = m.ascent * fontPx;
  const descent = m.descent * fontPx;
  const skew = layer.skew;
  // The shear moves ink above the baseline by skew·height: positive leans right (the descent goes left).
  const slantLeft = skew > 0 ? skew * descent : -skew * ascent;
  const slant = Math.abs(skew) * (ascent + descent);
  return {
    fontPx,
    width: m.extent * fontPx + slant + 2 * outlinePx,
    height: pxHeight,
    outlinePx,
    originX: outlinePx + slantLeft + m.left * fontPx,
    baselineY: outlinePx + ascent,
  };
}

/** Width / height of the layer's raster for these metrics (independent of the raster size). */
export function textAspect(m: TextMetricsPx, layer: Pick<TextLayer, 'outlineWidth' | 'skew'>): number {
  return layoutText(m, layer, 1).width;
}

/** The raster height for a decal `decalHeight` tall on a surface with `texelsPerUnit`: 2× the texel density, 64 to 4096 px. */
export function rasterHeightFor(texelsPerUnit: number | null, decalHeight: number): number {
  const px = texelsPerUnit && texelsPerUnit > 0 ? 2 * texelsPerUnit * decalHeight : MIN_RASTER_HEIGHT;
  return Math.round(Math.min(MAX_RASTER_SIDE, Math.max(MIN_RASTER_HEIGHT, px)));
}

/** The CSS font shorthand for a loaded family (each style is its own family, see `loadFont`). */
export function fontString(cssFamily: string, px: number): string {
  return `${px}px "${cssFamily.replace(/["\\]/g, '')}"`;
}

type Ctx = OffscreenCanvasRenderingContext2D;

/** Metrics of `text` in `cssFamily`, per 1 px of font size. */
export function measureWith(ctx: Pick<Ctx, 'font' | 'measureText'>, text: string, cssFamily: string): TextMetricsPx {
  ctx.font = fontString(cssFamily, MEASURE_PX);
  const m = ctx.measureText(text);
  const positive = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback);
  const left = Math.max(0, Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0);
  const right = Math.max(m.width, Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : 0);
  return {
    left: left / MEASURE_PX,
    extent: (left + right) / MEASURE_PX,
    ascent: positive(m.fontBoundingBoxAscent, DEFAULT_ASCENT * MEASURE_PX) / MEASURE_PX,
    descent: positive(m.fontBoundingBoxDescent, DEFAULT_DESCENT * MEASURE_PX) / MEASURE_PX,
  };
}

/** A 2D context on a new OffscreenCanvas in sRGB, or null where there is none (jsdom). */
function context2d(width: number, height: number): Ctx | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    return new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  } catch {
    return null;
  }
}

let measureCtx: Ctx | null | undefined;

// ── Fonts ───────────────────────────────────────────────────────────────────

export type FontStatus = 'loading' | 'loaded' | 'missing';

export interface LoadedFont {
  /** The CSS family to draw with: the font's own, or FALLBACK_FAMILY when it couldn't be loaded. */
  cssFamily: string;
  /** The font isn't installed (or can't be read): the layer shows a warning. */
  fallback: boolean;
}

interface FontEntry {
  status: FontStatus;
  cssFamily: string;
  promise: Promise<LoadedFont>;
}

const fonts = new Map<string, FontEntry>();
let familyCounter = 0;

const fontKey = (font: FontRef) => `${font.family}\u0000${font.style}`;

/**
 * Loads a layer's font once per session: its bytes (`atelier_font_file`) become a FontFace
 * under a family name of its own, added to `document.fonts`. When the font is missing, resolves
 * with the fallback (and `fallback: true`). Re-measure text layers (`refreshTextMetrics`) once it
 * resolves.
 */
export function loadFont(font: FontRef, load: (font: FontRef) => Promise<ArrayBuffer> = fetchFontFile): Promise<LoadedFont> {
  const key = fontKey(font);
  const known = fonts.get(key);
  if (known) return known.promise;
  familyCounter += 1;
  const entry: FontEntry = { status: 'loading', cssFamily: `Livery Text ${familyCounter}`, promise: Promise.resolve({ cssFamily: FALLBACK_FAMILY, fallback: true }) };
  entry.promise = (async () => {
    try {
      const face = new FontFace(entry.cssFamily, await load(font));
      await face.load();
      document.fonts.add(face);
      entry.status = 'loaded';
      return { cssFamily: entry.cssFamily, fallback: false };
    } catch {
      entry.status = 'missing';
      try {
        await document.fonts.load(fontString(FALLBACK_FAMILY, MEASURE_PX));
      } catch {
        // The fallback is self-hosted and declared in CSS; drawing still works if this fails.
      }
      return { cssFamily: FALLBACK_FAMILY, fallback: true };
    }
  })();
  fonts.set(key, entry);
  return entry.promise;
}

/** Where loading a font stands; undefined before `loadFont` was asked for it. */
export function fontStatus(font: FontRef): FontStatus | undefined {
  return fonts.get(fontKey(font))?.status;
}

/** The family to draw a font with now: its own once loaded, else the fallback. */
export function cssFamilyOf(font: FontRef): string {
  const entry = fonts.get(fontKey(font));
  return entry?.status === 'loaded' ? entry.cssFamily : FALLBACK_FAMILY;
}

/** Forgets loaded fonts (tests). */
export function resetTextFonts(): void {
  fonts.clear();
  measureCtx = undefined;
}

// ── Measure and rasterise ───────────────────────────────────────────────────

/**
 * The layer's aspect (width / height) with the font as loaded now (the fallback until it is):
 * the store's TextMeasurer. Null without a canvas.
 */
export function measureTextAspect(layer: Pick<TextLayer, 'text' | 'font' | 'outlineWidth' | 'skew'>): number | null {
  if (measureCtx === undefined) measureCtx = context2d(1, 1);
  if (!measureCtx) return null;
  return textAspect(measureWith(measureCtx, layer.text, cssFamilyOf(layer.font)), layer);
}

/** Straight-alpha RGBA rows top to bottom. */
export interface TextRaster {
  rgba: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

/**
 * The layer's text drawn `pxHeight` tall (scaled down when it would be wider than
 * MAX_RASTER_SIDE): fill colour over its outline (stroke under fill), sheared by the skew. The
 * opacity is the decal pass's, not drawn here. Read back straight (canvas `getImageData`): RGB
 * under alpha 0 doesn't matter, the decal pass multiplies by alpha. Null without a canvas.
 */
export function rasterise(layer: Pick<TextLayer, 'text' | 'font' | 'color' | 'outlineColor' | 'outlineWidth' | 'skew'>, pxHeight: number): TextRaster | null {
  const measure = context2d(1, 1);
  if (!measure) return null;
  const cssFamily = cssFamilyOf(layer.font);
  const metrics = measureWith(measure, layer.text, cssFamily);
  let layout = layoutText(metrics, layer, Math.max(1, pxHeight));
  if (layout.width > MAX_RASTER_SIDE) layout = layoutText(metrics, layer, (layout.height * MAX_RASTER_SIDE) / layout.width);
  const width = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.ceil(layout.width)));
  const height = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.ceil(layout.height)));
  const ctx = context2d(width, height);
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  ctx.font = fontString(cssFamily, layout.fontPx);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // x' = x − skew·y + originX: ink above the baseline (y < 0) leans right for a positive skew.
  ctx.setTransform(1, 0, -layer.skew, 1, layout.originX, layout.baselineY);
  if (layout.outlinePx > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = 2 * layout.outlinePx;
    ctx.strokeStyle = layer.outlineColor;
    ctx.strokeText(layer.text, 0, 0);
  }
  ctx.fillStyle = layer.color;
  ctx.fillText(layer.text, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { rgba: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), width, height };
}

// ── Debounce ────────────────────────────────────────────────────────────────

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drops a pending call. */
  cancel(): void;
  /** Runs a pending call now. */
  flush(): void;
}

/** `fn` called once, `ms` after the last call, with the last arguments (re-rasterising while typing). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms = TEXT_DEBOUNCE_MS): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const run = () => {
    timer = null;
    const args = last;
    last = null;
    if (args) fn(...args);
  };
  const debounced = (...args: A) => {
    last = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    last = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    run();
  };
  return debounced;
}
