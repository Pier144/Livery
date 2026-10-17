import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INNER_RATIO, DEFAULT_STAR_POINTS, newHazardStripe, newShapeLayer, type ShapeLayer } from './project';
import { polygonPoints, quantiseOctave16, rasteriseShape, shapeKey, starPoints, stripeBands } from './shapes';
import { MAX_RASTER_SIDE } from './text';

/** Ray casting: is `p` inside (or on the edge of) the polygon `poly`? */
function inside(p: [number, number], poly: [number, number][]): boolean {
  const eps = 1e-9;
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    // On the edge counts as inside.
    const cross = (xj - xi) * (p[1] - yi) - (yj - yi) * (p[0] - xi);
    if (Math.abs(cross) < eps && p[0] >= Math.min(xi, xj) - eps && p[0] <= Math.max(xi, xj) + eps && p[1] >= Math.min(yi, yj) - eps && p[1] <= Math.max(yi, yj) + eps) return true;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('starPoints / polygonPoints', () => {
  it('a star has 2·points vertices, the first at the top centre, alternating radii', () => {
    const pts = starPoints(5, 0.4, 200, 100);
    expect(pts).toHaveLength(10);
    expect(pts[0]![0]).toBeCloseTo(100);
    expect(pts[0]![1]).toBeCloseTo(0);
    // In a square frame the radii read directly: outer 50, inner 20.
    const sq = starPoints(6, 0.4, 100, 100);
    sq.forEach((p, i) => expect(dist(p, [50, 50])).toBeCloseTo(i % 2 === 0 ? 50 : 20));
  });

  it('a polygon has `sides` vertices on the frame ellipse, one up', () => {
    const pts = polygonPoints(6, 300, 100);
    expect(pts).toHaveLength(6);
    expect(pts[0]![0]).toBeCloseTo(150);
    expect(pts[0]![1]).toBeCloseTo(0);
    for (const [x, y] of pts) expect(((x - 150) / 150) ** 2 + ((y - 50) / 50) ** 2).toBeCloseTo(1);
    // Square: the opposite of the top vertex is at the bottom for an even count.
    expect(pts[3]![1]).toBeCloseTo(100);
  });
});

describe('stripeBands', () => {
  const corners = (w: number, h: number): [number, number][] => [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];

  it('a boundary passes through the centre and colours alternate', () => {
    for (const angle of [0, 30, 45, -60, 80]) {
      const bands = stripeBands(2, 0.25, angle, 0.08);
      expect(bands.length).toBeGreaterThan(1);
      // The centre lies on the edge between the band starting there (k = 0) and the one before.
      const centre: [number, number] = [1, 0.125];
      const touching = bands.filter((b) => inside(centre, b.quad));
      expect(touching.length).toBe(2);
      for (let i = 1; i < bands.length; i++) expect(bands[i]!.color).not.toBe(bands[i - 1]!.color);
    }
  });

  it('the band k = 0 (colour 0) starts on the centre', () => {
    const bands = stripeBands(1, 1, 0, 0.1);
    // Angle 0: the normal is +x, band k spans x ∈ [0.5 + 0.1k, 0.5 + 0.1(k+1)).
    const first = bands.find((b) => Math.abs(Math.min(...b.quad.map((q) => q[0])) - 0.5) < 1e-9)!;
    expect(first).toBeDefined();
    expect(first.color).toBe(0);
    expect(Math.max(...first.quad.map((q) => q[0]))).toBeCloseTo(0.6);
  });

  it('every frame corner is covered', () => {
    for (const [w, h, angle, sw] of [
      [2, 0.25, 45, 0.08],
      [0.3, 1.7, -30, 0.05],
      [1, 1, 80, 0.3],
      [1, 1, 0, 2],
    ] as const) {
      const bands = stripeBands(w, h, angle, sw);
      for (const c of corners(w, h)) expect(bands.some((b) => inside(c, b.quad))).toBe(true);
    }
  });

  it('angle 0 gives vertical boundaries, and only as many bands as the frame needs', () => {
    const bands = stripeBands(1, 0.5, 0, 0.1);
    for (const b of bands) {
      const xs = b.quad.map((q) => +q[0].toFixed(9));
      expect(new Set(xs).size).toBe(2);
    }
    // x from 0 to 1 at 0.1 per band, the boundary on 0.5: 10 bands.
    expect(bands).toHaveLength(10);
  });

  it('a positive angle leans the boundaries right (up the frame = further right)', () => {
    const [band] = stripeBands(1, 1, 30, 0.2);
    const quad = band!.quad;
    // Points of one boundary: the two with the same across coordinate. The one with the smaller y (higher up) is further right.
    const a = quad[0]!;
    const b = quad[1]!;
    const top = a[1] < b[1] ? a : b;
    const bottom = a[1] < b[1] ? b : a;
    expect(top[0]).toBeGreaterThan(bottom[0]);
    expect((top[0] - bottom[0]) / (bottom[1] - top[1])).toBeCloseTo(Math.tan(Math.PI / 6));
  });
});

describe('quantiseOctave16', () => {
  it('is idempotent and within 4.5 %', () => {
    for (const v of [0.01, 0.37, 1, 1.03, 2.5, 8, 13.7, 100]) {
      const q = quantiseOctave16(v);
      expect(quantiseOctave16(q)).toBe(q);
      expect(Math.abs(q / v - 1)).toBeLessThan(0.045);
    }
    expect(quantiseOctave16(1)).toBe(1);
    expect(quantiseOctave16(2)).toBe(2);
  });
});

describe('shapeKey', () => {
  const frame = { width: 1, height: 0.5 };
  const solid: ShapeLayer = { ...newShapeLayer('star'), repeat: { count: 3, gap: 0.5, direction: 'row', alternate: '#112233' } };

  it('starts with shp: and changes with fill, variant, px and full', () => {
    const base = shapeKey(solid, 'main', frame, 256, false);
    expect(base.startsWith('shp:')).toBe(true);
    expect(base.endsWith(':p')).toBe(true);
    expect(shapeKey({ ...solid, fill: { kind: 'solid', color: '#000001' } }, 'main', frame, 256, false)).not.toBe(base);
    expect(shapeKey(solid, 'alt', frame, 256, false)).not.toBe(base);
    expect(shapeKey(solid, 'alt', frame, 256, false)).toContain('#112233');
    expect(shapeKey(solid, 'main', frame, 512, false)).not.toBe(base);
    expect(shapeKey(solid, 'main', frame, 256, true)).not.toBe(base);
    expect(shapeKey({ ...solid, outlineWidth: 5 }, 'main', frame, 256, false)).not.toBe(base);
    expect(shapeKey({ ...solid, points: 7 }, 'main', frame, 256, false)).not.toBe(base);
  });

  it('ignores the frame size for solid fills (same aspect), includes it for stripes', () => {
    expect(shapeKey(solid, 'main', { width: 2, height: 1 }, 256, false)).toBe(shapeKey(solid, 'main', frame, 256, false));
    expect(shapeKey(solid, 'main', { width: 3, height: 1 }, 256, false)).not.toBe(shapeKey(solid, 'main', frame, 256, false));
    const hazard = newHazardStripe('Hazard');
    expect(shapeKey(hazard, 'main', { width: 2, height: 1 }, 256, false)).not.toBe(shapeKey(hazard, 'main', frame, 256, false));
    // The alternate colour doesn't apply to stripes.
    expect(shapeKey({ ...hazard, repeat: solid.repeat }, 'alt', frame, 256, false)).toBe(shapeKey(hazard, 'main', frame, 256, false));
  });
});

describe('rasteriseShape', () => {
  it('answers null without OffscreenCanvas (jsdom)', async () => {
    expect(typeof OffscreenCanvas).toBe('undefined');
    expect(await rasteriseShape(newShapeLayer('rect'), 'main', { width: 1, height: 1 }, 64)).toBeNull();
  });
});

// ── Stub canvas ─────────────────────────────────────────────────────────────

class StubPath {
  ops: string[] = [];
  moveTo(x: number, y: number) {
    this.ops.push(`M${+x.toFixed(2)},${+y.toFixed(2)}`);
  }
  lineTo(x: number, y: number) {
    this.ops.push(`L${+x.toFixed(2)},${+y.toFixed(2)}`);
  }
  arcTo(_x1: number, _y1: number, _x2: number, _y2: number, r: number) {
    this.ops.push(`A${+r.toFixed(2)}`);
  }
  ellipse(x: number, y: number, rx: number, ry: number) {
    this.ops.push(`E${x},${y},${rx},${ry}`);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.ops.push(`R${x},${y},${w},${h}`);
  }
  closePath() {
    this.ops.push('Z');
  }
}

class StubContext {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineJoin = '';
  miterLimit = 10;
  calls: string[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  clearRect() {}
  save() {
    this.calls.push('save');
  }
  restore() {
    this.calls.push('restore');
  }
  clip(path: StubPath) {
    this.calls.push(`clip ${path.ops[0]}`);
  }
  fill(path: StubPath) {
    this.calls.push(`fill ${this.fillStyle} ${path.ops[0]}`);
  }
  stroke(path: StubPath) {
    this.calls.push(`stroke ${this.strokeStyle} ${+this.lineWidth.toFixed(2)}`);
    void path;
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

describe('rasteriseShape (stub canvas)', () => {
  beforeEach(() => {
    contexts.length = 0;
    vi.stubGlobal('OffscreenCanvas', StubOffscreenCanvas);
    vi.stubGlobal('Path2D', StubPath);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sizes the raster from the quantised aspect and fills solid', async () => {
    const img = (await rasteriseShape(newShapeLayer('ellipse'), 'main', { width: 2, height: 1 }, 100))!;
    expect(img).toMatchObject({ w: 200, h: 100 });
    expect(img.rgba).toHaveLength(200 * 100 * 4);
    expect(img.rgba[3]).toBe(255);
    expect(contexts.at(-1)!.calls).toEqual(['fill #e8b600 E100,50,100,50']);
  });

  it('caps the long side at MAX_RASTER_SIDE', async () => {
    const img = (await rasteriseShape(newShapeLayer('rect'), 'main', { width: 8, height: 1 }, 1024))!;
    expect(img.w).toBe(MAX_RASTER_SIDE);
    expect(img.h).toBe(MAX_RASTER_SIDE / 8);
    const tall = (await rasteriseShape(newShapeLayer('rect'), 'main', { width: 1, height: 1000 }, 3000))!;
    expect(tall.h).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(tall.w).toBeGreaterThanOrEqual(1);
  });

  it('alt draws the solid fill in the alternate colour; the outline is clipped to the shape', async () => {
    const layer: ShapeLayer = { ...newShapeLayer('star'), outlineWidth: 10, outlineColor: '#000000', repeat: { count: 2, gap: 0, direction: 'row', alternate: '#00ff00' } };
    await rasteriseShape(layer, 'alt', { width: 1, height: 1 }, 100);
    const calls = contexts.at(-1)!.calls;
    // Star with defaults: 2 × 5 vertices, the first at the top centre.
    expect(calls[0]).toBe('fill #00ff00 M50,0');
    expect(calls.slice(1)).toEqual(['save', 'clip M50,0', 'stroke #000000 20', 'restore']);
    expect(DEFAULT_STAR_POINTS).toBe(5);
    expect(DEFAULT_INNER_RATIO).toBeGreaterThan(0);
  });

  it('stripes: clipped to the shape, both colours drawn', async () => {
    const hazard = newHazardStripe('Hazard');
    await rasteriseShape(hazard, 'main', { width: 0.8, height: 0.1 }, 64);
    const calls = contexts.at(-1)!.calls;
    expect(calls[0]).toBe('save');
    // Hazard frame 8:1 at 64 px: a sharp 512 × 64 rectangle.
    expect(calls[1]).toBe('clip R0,0,512,64');
    expect(calls.some((c) => c.startsWith('fill #e8b600'))).toBe(true);
    expect(calls.some((c) => c.startsWith('fill #141414'))).toBe(true);
    expect(calls.at(-1)).toBe('restore');
  });

  it('an unknown shape draws as a rectangle; corners round it', async () => {
    await rasteriseShape({ ...newShapeLayer('rect'), shape: 'hexagram' }, 'main', { width: 1, height: 1 }, 10);
    expect(contexts.at(-1)!.calls).toEqual(['fill #e8b600 R0,0,10,10']);
    await rasteriseShape({ ...newShapeLayer('rect'), corner: 0.25 }, 'main', { width: 2, height: 1 }, 10);
    expect(contexts.at(-1)!.calls[0]).toBe('fill #e8b600 M2.5,0');
  });
});
