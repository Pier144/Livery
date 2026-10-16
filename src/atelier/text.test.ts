import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_FAMILY,
  MAX_RASTER_SIDE,
  MIN_RASTER_HEIGHT,
  TEXT_DEBOUNCE_MS,
  cssFamilyOf,
  debounce,
  fontStatus,
  fontString,
  layoutText,
  loadFont,
  measureTextAspect,
  measureWith,
  rasterHeightFor,
  rasterise,
  resetTextFonts,
  textAspect,
  type TextMetricsPx,
} from './text';
import { newTextLayer } from './project';

const METRICS: TextMetricsPx = { left: 0, extent: 3, ascent: 0.8, descent: 0.2 };

describe('layout (pure)', () => {
  it('without outline or skew, the line box is the height and the ink extent the width', () => {
    const l = layoutText(METRICS, { outlineWidth: 0, skew: 0 }, 100);
    expect(l).toMatchObject({ fontPx: 100, width: 300, height: 100, outlinePx: 0, originX: 0, baselineY: 80 });
    expect(textAspect(METRICS, { outlineWidth: 0, skew: 0 })).toBeCloseTo(3);
  });

  it('the outline pads every side inside the same height', () => {
    // 10/100 em on both sides: the line box is 1.2 em = 120 px → 100 px font at 120 px.
    const l = layoutText(METRICS, { outlineWidth: 10, skew: 0 }, 120);
    expect(l.fontPx).toBeCloseTo(100);
    expect(l.outlinePx).toBeCloseTo(10);
    expect(l.width).toBeCloseTo(320);
    expect(l.originX).toBeCloseTo(10);
    expect(l.baselineY).toBeCloseTo(90);
  });

  it('skew adds the slant to the width and shifts the start so the leaning ink stays inside', () => {
    const right = layoutText(METRICS, { outlineWidth: 0, skew: 0.5 }, 100);
    expect(right.width).toBeCloseTo(350);
    // Positive skew: the descent (20 px) leans left by 10 px.
    expect(right.originX).toBeCloseTo(10);
    const left = layoutText(METRICS, { outlineWidth: 0, skew: -0.5 }, 100);
    expect(left.width).toBeCloseTo(350);
    // Negative: the ascent (80 px) leans left by 40 px.
    expect(left.originX).toBeCloseTo(40);
    // Ink left of the start point moves the start right.
    expect(layoutText({ ...METRICS, left: 0.1 }, { outlineWidth: 0, skew: 0 }, 100).originX).toBeCloseTo(10);
  });

  it('the aspect does not depend on the raster size', () => {
    const layer = { outlineWidth: 6, skew: 0.2 };
    const a = layoutText(METRICS, layer, 64);
    const b = layoutText(METRICS, layer, 1000);
    expect(a.width / a.height).toBeCloseTo(b.width / b.height);
    expect(textAspect(METRICS, layer)).toBeCloseTo(b.width / b.height);
  });

  it('raster height: 2× the texel density, clamped', () => {
    expect(rasterHeightFor(400, 0.5)).toBe(400);
    expect(rasterHeightFor(10, 0.5)).toBe(MIN_RASTER_HEIGHT);
    expect(rasterHeightFor(1e5, 1)).toBe(MAX_RASTER_SIDE);
    expect(rasterHeightFor(null, 1)).toBe(MIN_RASTER_HEIGHT);
  });

  it('fontString quotes the family and drops characters that would break it', () => {
    expect(fontString('Livery Text 1', 12)).toBe('12px "Livery Text 1"');
    expect(fontString('A"B\\C', 10)).toBe('10px "ABC"');
  });
});

/** A 2D context stub: measureText from a fixed advance per character; records the drawing calls. */
class StubContext {
  font = '';
  textBaseline = '';
  textAlign = '';
  lineJoin = '';
  miterLimit = 0;
  lineWidth = 0;
  strokeStyle = '';
  fillStyle = '';
  calls: string[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  measureText(text: string) {
    const px = Number(/^(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 0);
    return {
      width: text.length * 0.5 * px,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 0.5 * px,
      fontBoundingBoxAscent: 0.75 * px,
      fontBoundingBoxDescent: 0.25 * px,
    };
  }
  clearRect() {}
  setTransform(...m: number[]) {
    this.calls.push(`transform ${m.map((v) => +v.toFixed(3)).join(',')}`);
  }
  strokeText(text: string) {
    this.calls.push(`stroke ${text} ${this.strokeStyle} ${this.lineWidth.toFixed(2)}`);
  }
  fillText(text: string) {
    this.calls.push(`fill ${text} ${this.fillStyle} ${this.font}`);
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    data[3] = 255;
    return { data };
  }
}

const contexts: StubContext[] = [];

class StubOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext(kind: string, options: { colorSpace?: string }) {
    expect(kind).toBe('2d');
    expect(options.colorSpace).toBe('srgb');
    const ctx = new StubContext(this.width, this.height);
    contexts.push(ctx);
    return ctx;
  }
}

describe('measure and rasterise (stub canvas)', () => {
  beforeEach(() => {
    resetTextFonts();
    contexts.length = 0;
    vi.stubGlobal('OffscreenCanvas', StubOffscreenCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetTextFonts();
  });

  const layer = { ...newTextLayer('ABCD', null), color: '#ffcc00', outlineColor: '#101010' };

  it('measureWith reads per-pixel metrics', () => {
    const ctx = new StubContext(1, 1);
    expect(measureWith(ctx as never, 'AB', 'X')).toEqual({ left: 0, extent: 1, ascent: 0.75, descent: 0.25 });
    expect(ctx.font).toBe('100px "X"');
  });

  it('measures with the fallback until the font is loaded', () => {
    expect(measureTextAspect(layer)).toBeCloseTo(2);
    expect(contexts[0]?.font).toContain(FALLBACK_FAMILY);
    expect(measureTextAspect({ ...layer, text: 'AB', skew: 0.5 })).toBeCloseTo(1.5);
  });

  it('rasterises: outline under fill, skew transform, sizes from the layout', () => {
    const raster = rasterise({ ...layer, outlineWidth: 10, skew: 0.25 }, 120)!;
    // Font 100 px: ink 200, slant 0.25 × 100 = 25, outline 2 × 10 → 245 × 120.
    expect(raster).toMatchObject({ width: 245, height: 120 });
    expect(raster.rgba).toHaveLength(245 * 120 * 4);
    expect(raster.rgba[3]).toBe(255);
    const drawn = contexts.at(-1)!;
    expect(drawn.width).toBe(245);
    // originX = 10 (outline) + 0.25 × 25 (descent) = 16.25; baseline = 10 + 75.
    expect(drawn.calls).toEqual([
      'transform 1,0,-0.25,1,16.25,85',
      'stroke ABCD #101010 20.00',
      `fill ABCD #ffcc00 100px "${FALLBACK_FAMILY}"`,
    ]);
  });

  it('no outline: no stroke; too wide: scaled down to fit', () => {
    rasterise(layer, 100);
    expect(contexts.at(-1)!.calls.some((c) => c.startsWith('stroke'))).toBe(false);
    const wide = rasterise({ ...layer, text: 'W'.repeat(200) }, 1000)!;
    expect(wide.width).toBe(MAX_RASTER_SIDE);
    expect(wide.height).toBeLessThan(1000);
  });

  it('without a canvas (jsdom): null', () => {
    vi.unstubAllGlobals();
    resetTextFonts();
    expect(measureTextAspect(layer)).toBeNull();
    expect(rasterise(layer, 100)).toBeNull();
  });
});

describe('fonts', () => {
  const added: unknown[] = [];
  beforeEach(() => {
    resetTextFonts();
    added.length = 0;
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(
          readonly family: string,
          readonly source: ArrayBuffer,
        ) {}
        load() {
          return this.source.byteLength > 0 ? Promise.resolve(this) : Promise.reject(new Error('bad font'));
        }
      },
    );
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: (f: unknown) => added.push(f), load: () => Promise.resolve([]) },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetTextFonts();
  });

  it('loads a font once under its own family; the layer draws with it once loaded', async () => {
    const font = { family: 'Arial', style: 'Bold' };
    const load = vi.fn(async () => new ArrayBuffer(4));
    expect(cssFamilyOf(font)).toBe(FALLBACK_FAMILY);
    const pending = loadFont(font, load);
    expect(fontStatus(font)).toBe('loading');
    expect(cssFamilyOf(font)).toBe(FALLBACK_FAMILY);
    const loaded = await pending;
    expect(loaded.fallback).toBe(false);
    expect(loaded.cssFamily).toMatch(/^Livery Text \d+$/);
    expect(fontStatus(font)).toBe('loaded');
    expect(cssFamilyOf(font)).toBe(loaded.cssFamily);
    expect(added).toHaveLength(1);
    await loadFont(font, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a missing or unreadable font falls back to Geist with a warning', async () => {
    const missing = { family: 'Gone', style: 'Regular' };
    const failed = await loadFont(missing, async () => {
      throw { code: 'notFound', message: "This font isn't installed" };
    });
    expect(failed).toEqual({ cssFamily: FALLBACK_FAMILY, fallback: true });
    expect(fontStatus(missing)).toBe('missing');
    const broken = { family: 'Broken', style: 'Regular' };
    expect(await loadFont(broken, async () => new ArrayBuffer(0))).toEqual({ cssFamily: FALLBACK_FAMILY, fallback: true });
    expect(cssFamilyOf(broken)).toBe(FALLBACK_FAMILY);
    expect(added).toHaveLength(0);
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it(`calls once, ${TEXT_DEBOUNCE_MS} ms after the last call, with the last arguments`, () => {
    const fn = vi.fn();
    const d = debounce(fn);
    d('a');
    vi.advanceTimersByTime(100);
    d('ab');
    vi.advanceTimersByTime(TEXT_DEBOUNCE_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('cancel drops the pending call; flush runs it now', () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d(1);
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
    d(2);
    d.flush();
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
    d.flush();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
