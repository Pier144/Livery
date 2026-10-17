import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_COLOR,
  DEFAULT_CAMO_COLOR,
  DEFAULT_FONT,
  DEFAULT_OUTLINE_COLOR,
  DEFAULT_TEXT_COLOR,
  MAX_DECAL_SIZE,
  MAX_OUTLINE_WIDTH,
  MAX_SKEW,
  MAX_TEXT_CHARS,
  MIN_DECAL_SIZE,
  baseOf,
  checkPlacedLayer,
  decalLayers,
  decalRight,
  defaultDepth,
  isPictureLayer,
  maskOf,
  newBaseLayer,
  newImageLayer,
  newMaskLayer,
  newTextLayer,
  serializeLayers,
  checkLayers,
  partGroupOf,
  toDecal,
  validateLayers,
  normalizeWeights,
  CELL_SIZE_MAX,
  CELL_SIZE_MIN,
  MIN_CAMO_WEIGHT,
  STRIPE_ANGLE_MAX,
  STRIPE_ANGLE_MIN,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_SHAPE_STRIPE_ANGLE,
  DEFAULT_STRIPE_WIDTH,
  DEFAULT_REPEAT_GAP,
  HAZARD_DARK,
  MAX_CORNER,
  MAX_INNER_RATIO,
  MAX_PIECES,
  MAX_REPEAT,
  MAX_REPEAT_GAP,
  MAX_SHAPE_POINTS,
  MIN_INNER_RATIO,
  MIN_SHAPE_POINTS,
  SHAPE_KINDS,
  SHAPE_STRIPE_ANGLE_MAX,
  SHAPE_STRIPE_ANGLE_MIN,
  STRIPE_WIDTH_MAX,
  STRIPE_WIDTH_MIN,
  checkPiece,
  isPlacedLayer,
  newFolder,
  newHazardStripe,
  newShapeLayer,
  type BaseLayer,
  type FolderLayer,
  type ImageLayer,
  type Layer,
  type MaskLayer,
  type MergedLayer,
  type Piece,
  type ShapeLayer,
  type Stroke,
  type TextLayer,
  type UnsupportedPiece,
  type Vec3,
} from './project';

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  erase: false,
  radius: 0.1,
  hardness: 0.5,
  part: 'all',
  dir: [0, 0, -1],
  points: [[0, 0, 0]],
  ...over,
});

describe('layers', () => {
  it('new layers have their defaults and distinct ids', () => {
    const base = newBaseLayer();
    expect(base).toMatchObject({ kind: 'base', name: '', visible: true, mode: 'solid', colors: [DEFAULT_BASE_COLOR], scale: 1, seed: 1 });
    expect(newMaskLayer()).toMatchObject({ kind: 'mask', strokes: [] });
    expect(newBaseLayer().id).not.toBe(base.id);
  });

  it('an empty or missing list gets a Base', () => {
    for (const json of [[], undefined, null, 'x', {}]) {
      const layers = validateLayers(json);
      expect(layers).toHaveLength(1);
      expect(layers[0]?.kind).toBe('base');
    }
  });

  it('moves the Base to the bottom and the mask to the top, keeping the first of each', () => {
    const json = [
      { id: 'm1', kind: 'mask', name: '', visible: true, strokes: [] },
      { id: 'img', kind: 'sticker', name: 'Bust', visible: true, assetId: 'x' },
      { id: 'b1', kind: 'base', name: '', visible: true, mode: 'solid', colors: ['#112233'], scale: 1, seed: 1 },
      { id: 'b2', kind: 'base', name: '', visible: true, mode: 'solid', colors: ['#445566'], scale: 1, seed: 1 },
      { id: 'm2', kind: 'mask', name: '', visible: true, strokes: [] },
    ];
    const layers = validateLayers(json);
    expect(layers.map((l) => l.id)).toEqual(['b1', 'img', 'm1']);
    expect(layers[1]?.kind).toBe('unsupported');
  });

  it('keeps unsupported kinds exactly as they came when saved back', () => {
    const image = { id: 'img', kind: 'sticker', name: 'Bust', visible: false, assetId: 'a1', decal: { width: 1 } };
    const layers = validateLayers([image]);
    expect(serializeLayers(layers)[1]).toEqual(image);
  });

  it('repairs fields: bad colours, camo with one colour, scale, seed, strokes', () => {
    const [base, mask] = validateLayers([
      { id: 'b', kind: 'base', mode: 'camo', colors: ['#ABCDEF', 'red', 3], scale: -2, seed: 2.7 },
      {
        id: 'm',
        kind: 'mask',
        strokes: [
          stroke({ hardness: 4, part: 'wing' as never, dir: 'up' as never }),
          stroke({ radius: 0 }),
          stroke({ points: [] }),
          { points: [[0, 0, Number.NaN]], radius: 1 },
        ],
      },
    ]);
    expect(base).toMatchObject({ kind: 'base', name: '', visible: true, mode: 'camo', colors: ['#abcdef', DEFAULT_CAMO_COLOR], scale: 1, seed: 2 });
    expect((mask as MaskLayer).strokes).toEqual([stroke({ hardness: 1, part: 'wing', dir: [0, 0, -1] })]);
  });

  it('renews repeated ids and drops entries that are not layers', () => {
    const layers = validateLayers([
      { id: 'x', kind: 'base' },
      { id: 'x', kind: 'image' },
      42,
      { kind: '' },
      { name: 'no kind' },
    ]);
    expect(layers).toHaveLength(2);
    expect(new Set(layers.map((l) => l.id)).size).toBe(2);
    expect(layers[0]?.id).toBe('x');
  });

  it('baseOf and maskOf find them', () => {
    const layers = validateLayers([{ id: 'm', kind: 'mask', strokes: [] }]);
    expect(baseOf(layers)?.kind).toBe('base');
    expect(maskOf(layers)?.id).toBe('m');
    expect(maskOf(validateLayers([]))).toBeUndefined();
  });

  it('keeps unknown fields on known layers and strokes, and unknown parts as written', () => {
    const json = [
      { id: 'b', kind: 'base', name: 'Olive', visible: true, mode: 'camo', colors: ['#111111', '#222222'], scale: 2, seed: 3, finish: 'matte' },
      {
        id: 'm',
        kind: 'mask',
        name: '',
        visible: true,
        strokes: [{ erase: false, radius: 0.1, hardness: 0.5, part: 'wheels', dir: [0, 0, -1], points: [[0, 0, 0]], pressure: [0.4] }],
        feather: 2,
      },
    ];
    const { layers, repaired } = checkLayers(json);
    expect(repaired).toBe(false);
    expect(serializeLayers(layers)).toEqual(json);
    expect(partGroupOf('wheels')).toBeNull();
    expect(partGroupOf('all')).toBeNull();
    expect(partGroupOf('turret')).toBe('turret');
  });

  it('flags only structural repairs', () => {
    const base = { id: 'b', kind: 'base' };
    const mask = { id: 'm', kind: 'mask', strokes: [] };
    const image = { id: 'i', kind: 'image' };
    expect(checkLayers([]).repaired).toBe(true);
    expect(checkLayers([base, image, mask]).repaired).toBe(false);
    // Defaults for missing fields alone don't count.
    expect(checkLayers([{ id: 'b', kind: 'base', colors: 'x' }]).repaired).toBe(false);
    expect(checkLayers([image, base]).repaired).toBe(true);
    expect(checkLayers([base, mask, image]).repaired).toBe(true);
    expect(checkLayers([base, mask, { ...mask, id: 'm2' }]).repaired).toBe(true);
    expect(checkLayers([base, { ...base, id: 'b2' }]).repaired).toBe(true);
    expect(checkLayers([base, { ...image, id: 'b' }]).repaired).toBe(true);
  });

  it('round-trips through JSON unchanged once valid', () => {
    const layers = validateLayers([{ id: 'b', kind: 'base' }, { id: 'm', kind: 'mask', strokes: [stroke()] }]);
    const json = JSON.parse(JSON.stringify(serializeLayers(layers))) as unknown;
    expect(validateLayers(json)).toEqual(layers);
  });
});

const decal = (over: Record<string, unknown> = {}) => ({
  center: [0.5, 0.2, 0.1],
  normal: [1, 0, 0],
  up: [0, 1, 0],
  width: 0.4,
  height: 0.2,
  depth: 0.04,
  part: 'all',
  mirror: false,
  ...over,
});
const image = (over: Record<string, unknown> = {}) => ({
  id: 'i',
  kind: 'image',
  name: '',
  visible: true,
  assetId: 'img-1',
  decal: decal(),
  opacity: 1,
  flipX: false,
  ...over,
});
const text = (over: Record<string, unknown> = {}) => ({
  id: 't',
  kind: 'text',
  name: '',
  visible: true,
  text: 'EXPLOSION!',
  font: { family: 'Arial', style: 'Bold' },
  color: '#ffffff',
  outlineColor: '#000000',
  outlineWidth: 4,
  skew: 0.1,
  decal: decal(),
  opacity: 0.8,
  ...over,
});
const BASE = { id: 'b', kind: 'base', name: '', visible: true, mode: 'solid', colors: ['#56603f'], scale: 1, seed: 1 };
const MASK = { id: 'm', kind: 'mask', name: '', visible: true, strokes: [] };

describe('image and text layers', () => {
  it('keeps them between Base and mask in their order, valid ones clean and saved back as they came', () => {
    const json = [
      BASE,
      text({ id: 't1' }),
      image({ id: 'i1', sourceAssetId: 'img-0', sourceOffset: { x: 3, y: 4, w: 10, h: 20 } }),
      image({ id: 'i2' }),
      { id: 'u', kind: 'sticker', name: '', visible: true },
      MASK,
    ];
    const { layers, repaired } = checkLayers(json);
    expect(repaired).toBe(false);
    expect(layers.map((l) => `${l.kind}:${l.id}`)).toEqual(['base:b', 'text:t1', 'image:i1', 'image:i2', 'unsupported:u', 'mask:m']);
    expect(serializeLayers(layers)).toEqual(json);
    expect(decalLayers(layers).map((l) => l.id)).toEqual(['t1', 'i1', 'i2']);
    expect(isPictureLayer(layers[1])).toBe(true);
    expect(isPictureLayer(layers[4])).toBe(false);
  });

  it('moves misplaced ones between Base and mask (a structural repair)', () => {
    const { layers, repaired } = checkLayers([image({ id: 'i1' }), MASK, BASE, text({ id: 't1' })]);
    expect(layers.map((l) => l.id)).toEqual(['b', 'i1', 't1', 'm']);
    expect(repaired).toBe(true);
  });

  it('clamps numbers and repairs fields', () => {
    const [, img, txt] = validateLayers([
      BASE,
      image({ opacity: 3, flipX: 'yes', sourceAssetId: '', sourceOffset: { x: -1, y: 0, w: 1, h: 1 }, extra: 7 }),
      text({
        text: 'x'.repeat(250),
        font: 'Impact',
        color: 'red',
        outlineColor: '#ABCDEF',
        outlineWidth: 99,
        skew: -2,
        opacity: Number.NaN,
        decal: decal({ width: 1e6, height: -1, depth: 'deep', part: '', mirror: 1 }),
      }),
    ]);
    expect(img).toMatchObject({ kind: 'image', opacity: 1, flipX: false, extra: 7 });
    expect(img).not.toHaveProperty('sourceAssetId');
    expect(img).not.toHaveProperty('sourceOffset');
    expect(txt).toMatchObject({
      kind: 'text',
      font: { family: 'Impact', style: 'Regular' },
      color: DEFAULT_TEXT_COLOR,
      outlineColor: '#abcdef',
      outlineWidth: MAX_OUTLINE_WIDTH,
      skew: -MAX_SKEW,
      opacity: 1,
    });
    expect((txt as TextLayer).text).toHaveLength(MAX_TEXT_CHARS);
    expect((txt as TextLayer).decal).toMatchObject({
      width: MAX_DECAL_SIZE,
      height: MIN_DECAL_SIZE,
      depth: defaultDepth(MAX_DECAL_SIZE),
      part: 'all',
      mirror: false,
    });
  });

  it('text defaults: font, colours, empty text, no decal', () => {
    const [, txt] = validateLayers([BASE, { id: 't', kind: 'text' }]);
    expect(txt).toMatchObject({
      text: '',
      font: DEFAULT_FONT,
      color: DEFAULT_TEXT_COLOR,
      outlineColor: DEFAULT_OUTLINE_COLOR,
      outlineWidth: 0,
      skew: 0,
      opacity: 1,
      decal: null,
    });
  });

  it('keeps a layer whose decal does not check out, with the decal dropped (flagged)', () => {
    for (const bad of [
      decal({ center: [0, Number.NaN, 0] }),
      decal({ normal: [0, 0, 0] }),
      decal({ up: [2, 0, 0] }), // parallel to the normal
      decal({ up: [0, 0, 0] }),
      decal({ width: Number.POSITIVE_INFINITY }),
      decal({ height: undefined }),
      'here',
    ]) {
      const [, img] = validateLayers([BASE, image({ decal: bad })]);
      expect(img).toMatchObject({ kind: 'image', assetId: 'img-1', decal: null });
    }
  });

  it('makes the decal frame orthonormal, and keeps a valid one bit for bit', () => {
    const [, img] = validateLayers([BASE, image({ decal: decal({ normal: [2, 0, 0], up: [0.5, 3, 0] }) })]);
    const d = (img as ImageLayer).decal!;
    expect(d.normal).toEqual([1, 0, 0]);
    expect(d.up[0]).toBeCloseTo(0);
    expect(d.up[1]).toBeCloseTo(1);
    const n: Vec3 = [0.6, 0.8, 0];
    const u: Vec3 = [-0.8, 0.6, 0];
    const [, kept] = validateLayers([BASE, image({ decal: decal({ normal: n, up: u }) })]);
    expect((kept as ImageLayer).decal?.normal).toBe(n);
    expect((kept as ImageLayer).decal?.up).toBe(u);
    expect(decalRight({ normal: [0, 0, 1], up: [0, 1, 0] })).toEqual([1, 0, 0]);
  });

  it('an image without an asset is kept as unsupported, exactly as it came', () => {
    const raw = image({ assetId: 42 });
    const layers = validateLayers([BASE, raw]);
    expect(layers[1]?.kind).toBe('unsupported');
    expect(serializeLayers(layers)[1]).toEqual(raw);
  });

  it('checkPlacedLayer re-checks an edited layer', () => {
    const [, txt] = validateLayers([BASE, text()]);
    expect(checkPlacedLayer({ ...(txt as TextLayer), skew: 4 })).toMatchObject({ skew: MAX_SKEW });
    const [, img] = validateLayers([BASE, image()]);
    expect(checkPlacedLayer({ ...(img as ImageLayer), assetId: '' })).toBeNull();
  });

  it('wear: kept above 0 (at most 1) on the Base, images and text; 0, negative or not a number is no field', () => {
    const [b, img, txt] = validateLayers([{ ...BASE, wear: 0.4 }, { ...image(), wear: 7 }, { ...text(), wear: 0.25 }]);
    expect(b).toMatchObject({ wear: 0.4 });
    expect(img).toMatchObject({ wear: 1 });
    expect(txt).toMatchObject({ wear: 0.25 });
    for (const wear of [0, -1, 'x', null, Number.NaN]) {
      const [b2, img2, txt2] = validateLayers([{ ...BASE, wear }, { ...image(), wear }, { ...text(), wear }]);
      for (const layer of [b2, img2, txt2]) expect(layer).not.toHaveProperty('wear');
    }
    // A layer without wear is saved without the field (older projects stay as they were).
    const [plain] = validateLayers([BASE]);
    expect(serializeLayers([plain!])[0]).not.toHaveProperty('wear');
    expect(checkPlacedLayer({ ...(txt as TextLayer), wear: 0 })).not.toHaveProperty('wear');
  });

  it('new image and text layers have their defaults', () => {
    const d = toDecal(decal())!;
    expect(newImageLayer('img-1', d, 'Bust')).toMatchObject({
      kind: 'image',
      name: 'Bust',
      visible: true,
      assetId: 'img-1',
      decal: d,
      opacity: 1,
      flipX: false,
    });
    const t = newTextLayer('y'.repeat(300), d);
    expect(t).toMatchObject({ kind: 'text', font: DEFAULT_FONT, color: DEFAULT_TEXT_COLOR, outlineWidth: 0, skew: 0 });
    expect(t.text).toHaveLength(MAX_TEXT_CHARS);
    expect(defaultDepth(0.05)).toBe(0.02);
    expect(defaultDepth(1)).toBeCloseTo(0.1);
  });
});

describe('camo styles on the Base', () => {
  const CAMO = { ...BASE, mode: 'camo', colors: ['#56603f', '#8a7a55', '#2f3324'], scale: 1.5, seed: 9 };
  const base = (over: Record<string, unknown>) => validateLayers([{ ...CAMO, ...over }])[0] as BaseLayer;

  it('an older camo Base parses without any new field and round-trips', () => {
    const b = base({});
    for (const key of ['pattern', 'weights', 'cellSize', 'angle', 'softness']) expect(b).not.toHaveProperty(key);
    expect(validateLayers(JSON.parse(JSON.stringify(serializeLayers([b]))))[0]).toEqual(b);
  });

  it('pattern: kept as written unless organic or not a string', () => {
    expect(base({ pattern: 'hex' }).pattern).toBe('hex');
    expect(base({ pattern: 'sticker-camo' }).pattern).toBe('sticker-camo');
    for (const pattern of ['organic', '', 7, null]) expect(base({ pattern })).not.toHaveProperty('pattern');
  });

  it('weights: normalised with a 5 % floor, dropped when they do not match the colours', () => {
    expect(base({ weights: [1, 1, 2] }).weights).toEqual([0.25, 0.25, 0.5]);
    expect(base({ weights: [0.01, 0.01, 0.98] }).weights).toEqual([0.05, 0.05, 0.9]);
    expect(base({ colors: ['#000000', '#ffffff'], weights: [0.01, 0.99] }).weights).toEqual([0.05, 0.95]);
    for (const weights of [[1, 2], [1, 0, 1], [1, Number.NaN, 1], ['a', 1, 1], 'x', null]) expect(base({ weights })).not.toHaveProperty('weights');
    const once = base({ weights: [0.3, 0.3, 0.4] });
    expect(base({ weights: once.weights }).weights).toEqual(once.weights);
  });

  it('cell size, angle and softness are clamped; softness 0 is no field', () => {
    expect(base({ cellSize: 10 }).cellSize).toBe(CELL_SIZE_MAX);
    expect(base({ cellSize: 0.01 }).cellSize).toBe(CELL_SIZE_MIN);
    expect(base({ angle: 120 }).angle).toBe(STRIPE_ANGLE_MAX);
    expect(base({ angle: -120 }).angle).toBe(STRIPE_ANGLE_MIN);
    expect(base({ softness: 2 }).softness).toBe(1);
    expect(base({ softness: 0.3 }).softness).toBe(0.3);
    for (const v of [0, -1, 'x', null]) expect(base({ softness: v })).not.toHaveProperty('softness');
    for (const v of ['x', null, Number.NaN]) {
      expect(base({ cellSize: v })).not.toHaveProperty('cellSize');
      expect(base({ angle: v })).not.toHaveProperty('angle');
    }
  });
});

describe('normalizeWeights', () => {
  it('sums to 1, floors every share at MIN_CAMO_WEIGHT, keeps a pinned share exact', () => {
    for (const w of [[1, 1], [0.001, 5, 5, 5], [0.0001, 0.0001, 0.0001, 1], [3, 1, 1]]) {
      const n = normalizeWeights(w);
      expect(n.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      for (const v of n) expect(v).toBeGreaterThanOrEqual(MIN_CAMO_WEIGHT);
      expect(normalizeWeights(n)).toEqual(n);
    }
    expect(normalizeWeights([0.0001, 0.0001, 0.0001, 1])).toEqual([0.05, 0.05, 0.05, 0.85]);
    expect(normalizeWeights([1, 2])).toEqual([0.3333, 0.6667]);
  });
});

const shape = (over: Record<string, unknown> = {}) => ({
  id: 's',
  kind: 'shape',
  name: '',
  visible: true,
  shape: 'rect',
  fill: { kind: 'solid', color: '#e8b600' },
  outlineColor: '#000000',
  outlineWidth: 0,
  decal: decal(),
  opacity: 1,
  ...over,
});
const place = (over: Record<string, unknown> = {}) => ({ x: 0, y: 0, w: 0.5, h: 0.5, angle: 0, ...over });
/** `layer` as a piece of a merged object: no decal, a place in the merged frame. */
const piece = (layer: Record<string, unknown>, over: Record<string, unknown> = {}) => {
  const rest = { ...layer };
  delete rest.decal;
  return { ...rest, place: place(over) };
};
const merged = (children: unknown, over: Record<string, unknown> = {}) => ({
  id: 'g',
  kind: 'merged',
  name: '',
  visible: true,
  decal: decal(),
  opacity: 1,
  children,
  ...over,
});
const folder = (children: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'f',
  kind: 'folder',
  name: 'Markings',
  visible: true,
  collapsed: false,
  children,
  ...over,
});
/** The single middle layer of `[BASE, raw]`, validated. */
const one = <T extends Layer>(raw: unknown): T => validateLayers([BASE, raw])[1] as T;

describe('shape layers', () => {
  it('new shapes have their defaults and write no optional field', () => {
    const s = newShapeLayer('star');
    expect(s).toMatchObject({
      kind: 'shape',
      shape: 'star',
      name: '',
      visible: true,
      fill: { kind: 'solid', color: DEFAULT_SHAPE_COLOR },
      outlineColor: '#000000',
      outlineWidth: 0,
      decal: null,
      opacity: 1,
    });
    for (const key of ['corner', 'points', 'innerRatio', 'repeat', 'wear']) expect(s).not.toHaveProperty(key);
    const d = toDecal(decal())!;
    expect(newShapeLayer('ellipse', d, 'Dot')).toMatchObject({ shape: 'ellipse', decal: d, name: 'Dot' });
    expect(SHAPE_KINDS).toEqual(['rect', 'ellipse', 'star', 'polygon']);
  });

  it('the hazard stripe preset: a yellow and black striped rectangle', () => {
    const h = newHazardStripe('Hazard stripe');
    expect(h).toMatchObject({
      kind: 'shape',
      shape: 'rect',
      name: 'Hazard stripe',
      fill: { kind: 'stripes', colors: [DEFAULT_SHAPE_COLOR, HAZARD_DARK], angle: 45, stripeWidth: 0.08 },
      decal: null,
    });
    expect(DEFAULT_SHAPE_STRIPE_ANGLE).toBe(45);
    expect(DEFAULT_STRIPE_WIDTH).toBe(0.08);
  });

  it('a valid shape round-trips unchanged and clean', () => {
    const json = [BASE, shape({ corner: 0.2, points: 7, innerRatio: 0.5, wear: 0.3 }), MASK];
    const { layers, repaired } = checkLayers(json);
    expect(repaired).toBe(false);
    expect(serializeLayers(layers)).toEqual(json);
  });

  it('clamps corner, points, inner ratio, outline width and opacity', () => {
    expect(one<ShapeLayer>(shape({ corner: 3 })).corner).toBe(MAX_CORNER);
    expect(one<ShapeLayer>(shape({ corner: -1 })).corner).toBe(0);
    expect(one<ShapeLayer>(shape({ points: 40 })).points).toBe(MAX_SHAPE_POINTS);
    expect(one<ShapeLayer>(shape({ points: 1 })).points).toBe(MIN_SHAPE_POINTS);
    expect(one<ShapeLayer>(shape({ points: 5.6 })).points).toBe(6);
    expect(one<ShapeLayer>(shape({ innerRatio: 2 })).innerRatio).toBe(MAX_INNER_RATIO);
    expect(one<ShapeLayer>(shape({ innerRatio: 0 })).innerRatio).toBe(MIN_INNER_RATIO);
    expect(one<ShapeLayer>(shape({ outlineWidth: 99 })).outlineWidth).toBe(MAX_OUTLINE_WIDTH);
    expect(one<ShapeLayer>(shape({ outlineWidth: -3 })).outlineWidth).toBe(0);
    expect(one<ShapeLayer>(shape({ opacity: 4 })).opacity).toBe(1);
    expect(one<ShapeLayer>(shape({ outlineColor: 'black' })).outlineColor).toBe('#000000');
    for (const v of ['x', null, Number.NaN]) {
      const s = one<ShapeLayer>(shape({ corner: v, points: v, innerRatio: v }));
      for (const key of ['corner', 'points', 'innerRatio']) expect(s).not.toHaveProperty(key);
    }
  });

  it('a bad fill becomes the solid default; stripes are clamped and lower-cased', () => {
    for (const fill of [undefined, 'yellow', { kind: 'gradient' }, { kind: 'solid', color: 'red' }]) {
      expect(one<ShapeLayer>(shape({ fill })).fill).toEqual({ kind: 'solid', color: DEFAULT_SHAPE_COLOR });
    }
    expect(one<ShapeLayer>(shape({ fill: { kind: 'solid', color: '#ABCDEF' } })).fill).toEqual({ kind: 'solid', color: '#abcdef' });
    const s = one<ShapeLayer>(shape({ fill: { kind: 'stripes', colors: ['#AAAAAA', '#BBBBBB'], angle: 120, stripeWidth: 9 } }));
    expect(s.fill).toEqual({ kind: 'stripes', colors: ['#aaaaaa', '#bbbbbb'], angle: SHAPE_STRIPE_ANGLE_MAX, stripeWidth: STRIPE_WIDTH_MAX });
    const low = one<ShapeLayer>(shape({ fill: { kind: 'stripes', colors: ['#aaaaaa', '#bbbbbb'], angle: -120, stripeWidth: 0 } }));
    expect(low.fill).toMatchObject({ angle: SHAPE_STRIPE_ANGLE_MIN, stripeWidth: STRIPE_WIDTH_MIN });
    const bare = one<ShapeLayer>(shape({ fill: { kind: 'stripes', colors: 'x' } }));
    expect(bare.fill).toEqual({ kind: 'stripes', colors: [DEFAULT_SHAPE_COLOR, HAZARD_DARK], angle: 45, stripeWidth: 0.08 });
  });

  it('keeps an unknown shape kind, unknown fields, and checks the decal', () => {
    const s = one<ShapeLayer>(shape({ shape: 'heart', glow: 2, decal: decal({ width: 1e6 }) }));
    expect(s).toMatchObject({ shape: 'heart', glow: 2 });
    expect(s.decal?.width).toBe(MAX_DECAL_SIZE);
    expect(one<ShapeLayer>(shape({ shape: 7 })).shape).toBe('rect');
    expect(one<ShapeLayer>(shape({ decal: decal({ normal: [0, 0, 0] }) })).decal).toBeNull();
  });

  it('checkPlacedLayer re-checks an edited shape', () => {
    const s = one<ShapeLayer>(shape());
    expect(checkPlacedLayer({ ...s, outlineWidth: 50, points: 99 })).toMatchObject({ outlineWidth: MAX_OUTLINE_WIDTH, points: MAX_SHAPE_POINTS });
  });
});

describe('repeat', () => {
  const kinds = () => [image(), text(), shape(), merged([piece(shape({ id: 'p' }))])];

  it('absent stays absent, on every placed kind', () => {
    for (const raw of kinds()) expect(one(raw)).not.toHaveProperty('repeat');
  });

  it('is kept and checked on image, text, shape and merged layers', () => {
    for (const raw of kinds()) {
      const layer = one<ShapeLayer>({ ...raw, repeat: { count: 3, gap: 0.2, direction: 'column', alternate: '#FF0000' } });
      expect(layer.repeat).toEqual({ count: 3, gap: 0.2, direction: 'column', alternate: '#ff0000' });
    }
  });

  it('a count below 2 or not a number removes the field; the rest gets defaults or is clamped', () => {
    for (const count of [1, 0, -4, 1.5, 'x', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(one({ ...shape(), repeat: { count, gap: 1, direction: 'row' } })).not.toHaveProperty('repeat');
    }
    for (const repeat of ['x', 3, null]) expect(one({ ...shape(), repeat })).not.toHaveProperty('repeat');
    expect(one<ShapeLayer>({ ...shape(), repeat: { count: 500, gap: 99 } }).repeat).toEqual({ count: MAX_REPEAT, gap: MAX_REPEAT_GAP, direction: 'row' });
    expect(one<ShapeLayer>({ ...shape(), repeat: { count: 4, gap: -1, direction: 'diagonal', alternate: 'red' } }).repeat).toEqual({
      count: 4,
      gap: 0,
      direction: 'row',
    });
    expect(one<ShapeLayer>({ ...shape(), repeat: { count: 4, gap: 'wide' } }).repeat).toEqual({ count: 4, gap: DEFAULT_REPEAT_GAP, direction: 'row' });
  });
});

describe('folders', () => {
  it('keeps a folder with its children, saved back as it came', () => {
    const json = [BASE, folder([image({ id: 'i1' }), text({ id: 't1' }), { id: 'u', kind: 'sticker', name: '', visible: true }]), MASK];
    const { layers, repaired } = checkLayers(json);
    expect(repaired).toBe(false);
    const f = layers[1] as FolderLayer;
    expect(f.kind).toBe('folder');
    expect(f.children.map((c) => `${c.kind}:${c.id}`)).toEqual(['image:i1', 'text:t1', 'unsupported:u']);
    expect(serializeLayers(layers)).toEqual(json);
  });

  it('collapsed defaults to false; missing children make an empty folder', () => {
    const f = one<FolderLayer>({ id: 'f', kind: 'folder', collapsed: 'yes' });
    expect(f).toMatchObject({ kind: 'folder', collapsed: false, children: [], name: '', visible: true });
    expect(one<FolderLayer>(folder([], { collapsed: true })).collapsed).toBe(true);
    expect(newFolder('Numbers')).toMatchObject({ kind: 'folder', name: 'Numbers', visible: true, collapsed: false, children: [] });
  });

  it('a folder inside a folder is moved out, right above its parent', () => {
    const { layers, repaired } = checkLayers([
      BASE,
      image({ id: 'below' }),
      folder([image({ id: 'a' }), folder([text({ id: 'tb' })], { id: 'inner' }), image({ id: 'c' })], { id: 'outer' }),
      image({ id: 'above' }),
    ]);
    expect(repaired).toBe(true);
    expect(layers.map((l) => l.id)).toEqual(['b', 'below', 'outer', 'inner', 'above']);
    expect((layers[2] as FolderLayer).children.map((c) => c.id)).toEqual(['a', 'c']);
    expect((layers[3] as FolderLayer).children.map((c) => c.id)).toEqual(['tb']);
  });

  it('a Base or mask inside a folder goes to its pinned place when the top level lacks one, else is dropped', () => {
    const lifted = checkLayers([image({ id: 'i' }), folder([{ ...BASE, id: 'fb' }, image({ id: 'a' }), { ...MASK, id: 'fm' }])]);
    expect(lifted.repaired).toBe(true);
    expect(lifted.layers.map((l) => `${l.kind}:${l.id}`)).toEqual(['base:fb', 'image:i', 'folder:f', 'mask:fm']);
    expect((lifted.layers[2] as FolderLayer).children.map((c) => c.id)).toEqual(['a']);
    const dropped = checkLayers([BASE, folder([{ ...BASE, id: 'fb' }, { ...MASK, id: 'fm' }]), MASK]);
    expect(dropped.repaired).toBe(true);
    expect(dropped.layers.map((l) => l.id)).toEqual(['b', 'f', 'm']);
    expect((dropped.layers[1] as FolderLayer).children).toEqual([]);
  });

  it('may hold merged objects and shapes', () => {
    const f = one<FolderLayer>(folder([shape({ id: 's1' }), merged([piece(shape({ id: 'p' }))])]));
    expect(f.children.map((c) => c.kind)).toEqual(['shape', 'merged']);
  });
});

describe('merged objects', () => {
  it('keeps valid pieces and round-trips unchanged', () => {
    const json = [
      BASE,
      merged([
        piece(shape({ id: 'p1' }), { x: -0.25, angle: 0.3 }),
        piece(text({ id: 'p2' })),
        piece(image({ id: 'p3' })),
        { id: 'p4', kind: 'sticker', name: '', visible: true, place: place() },
      ]),
      MASK,
    ];
    const { layers, repaired } = checkLayers(json);
    expect(repaired).toBe(false);
    const m = layers[1] as MergedLayer;
    expect(m.children.map((c) => `${c.kind}:${c.id}`)).toEqual(['shape:p1', 'text:p2', 'image:p3', 'unsupported:p4']);
    expect(serializeLayers(layers)).toEqual(json);
  });

  it('drops a drawable piece whose place does not check out', () => {
    for (const bad of [{ w: 0 }, { h: -1 }, { x: Number.NaN }, { angle: 'up' }, { y: undefined }]) {
      const { layers, repaired } = checkLayers([BASE, merged([piece(shape({ id: 'ok' })), piece(shape({ id: 'bad' }), bad)])]);
      expect(repaired).toBe(true);
      expect((layers[1] as MergedLayer).children.map((c) => c.id)).toEqual(['ok']);
    }
    const noPlace = checkLayers([BASE, merged([piece(shape({ id: 'ok' })), { ...shape({ id: 'bad' }), place: 'here' }])]);
    expect((noPlace.layers[1] as MergedLayer).children.map((c) => c.id)).toEqual(['ok']);
  });

  it('keeps an unknown piece kind as an unsupported piece, with its place only when valid', () => {
    const m = one<MergedLayer>(
      merged([
        piece(shape({ id: 'ok' })),
        { id: 'u1', kind: 'sticker', place: place({ x: 0.1 }) },
        { id: 'u2', kind: 'sticker', place: { w: 0 } },
        piece(image({ id: 'noasset', assetId: '' })),
      ]),
    );
    const [, u1, u2, noAsset] = m.children as UnsupportedPiece[];
    expect(u1).toMatchObject({ kind: 'unsupported', place: place({ x: 0.1 }) });
    expect(u2?.kind).toBe('unsupported');
    expect(u2).not.toHaveProperty('place');
    expect(noAsset?.kind).toBe('unsupported');
    expect(serializeLayers([m])[0]).toMatchObject({ children: [{}, { id: 'u1' }, { id: 'u2', place: { w: 0 } }, { id: 'noasset' }] });
  });

  it('drops folder, Base, mask and merged pieces', () => {
    const { layers, repaired } = checkLayers([
      BASE,
      merged([
        piece(shape({ id: 'ok' })),
        { ...folder([]), place: place() },
        { ...BASE, id: 'pb', place: place() },
        { ...MASK, id: 'pm', place: place() },
        { ...merged([piece(shape({ id: 'q' }))], { id: 'pg' }), place: place() },
      ]),
    ]);
    expect(repaired).toBe(true);
    expect((layers[1] as MergedLayer).children.map((c) => c.id)).toEqual(['ok']);
  });

  it('a merged object without a drawable piece is dropped', () => {
    for (const children of [[], [{ id: 'u', kind: 'sticker', place: place() }], 'x', [piece(shape({ id: 'bad' }), { w: 0 })]]) {
      const { layers, repaired } = checkLayers([BASE, merged(children), MASK]);
      expect(repaired).toBe(true);
      expect(layers.map((l) => l.id)).toEqual(['b', 'm']);
    }
  });

  it('removes repeat and decal from pieces, and keeps at most MAX_PIECES', () => {
    const m = one<MergedLayer>(merged([{ ...piece(shape({ id: 'p' })), repeat: { count: 3, gap: 1, direction: 'row' }, decal: decal() }]));
    expect(m.children[0]).not.toHaveProperty('repeat');
    expect(m.children[0]).not.toHaveProperty('decal');
    const many = Array.from({ length: MAX_PIECES + 3 }, (_, i) => piece(shape({ id: `p${i}` })));
    const { layers, repaired } = checkLayers([BASE, merged(many)]);
    expect(repaired).toBe(true);
    expect((layers[1] as MergedLayer).children).toHaveLength(MAX_PIECES);
  });

  it('checks the merged frame, opacity and the pieces fields', () => {
    const m = one<MergedLayer>(merged([piece(shape({ id: 'p', outlineWidth: 99 }))], { opacity: -1, decal: 'x' }));
    expect(m).toMatchObject({ opacity: 0, decal: null });
    expect((m.children[0] as Piece & ShapeLayer).outlineWidth).toBe(MAX_OUTLINE_WIDTH);
  });

  it('checkPiece re-checks an edited piece; null when it no longer is one', () => {
    const m = one<MergedLayer>(merged([piece(shape({ id: 'p' })), piece(image({ id: 'i' }))]));
    const [s, img] = m.children as Piece[];
    expect(checkPiece({ ...s!, opacity: 3 } as Piece)).toMatchObject({ opacity: 1, place: place() });
    expect(checkPiece({ ...s!, place: { ...place(), w: 0 } } as Piece)).toBeNull();
    expect(checkPiece({ ...img!, assetId: '' } as Piece)).toBeNull();
    expect(checkPlacedLayer({ ...m, children: [] })).toBeNull();
  });
});

describe('ids across the tree', () => {
  it('renews a piece or folder child whose id is already used', () => {
    const { layers, repaired } = checkLayers([
      BASE,
      merged([piece(shape({ id: 'x' }))]),
      folder([image({ id: 'x' }), image({ id: 'f' })]),
      image({ id: 'x' }),
    ]);
    expect(repaired).toBe(true);
    expect(layers[3]?.id).toBe('x');
    const ids: string[] = [];
    for (const l of layers) {
      ids.push(l.id);
      if (l.kind === 'folder' || l.kind === 'merged') for (const c of l.children) ids.push(c.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isPlacedLayer and isPictureLayer', () => {
  it('tell placed and picture layers apart', () => {
    const layers = validateLayers([BASE, image(), text(), shape(), merged([piece(shape({ id: 'p' }))]), folder([]), { id: 'u', kind: 'sticker' }, MASK]);
    expect(layers.map((l) => isPlacedLayer(l))).toEqual([false, true, true, true, true, false, false, false]);
    expect(layers.map((l) => isPictureLayer(l))).toEqual([false, true, true, false, false, false, false, false]);
    expect(isPlacedLayer(undefined)).toBe(false);
  });
});

describe('older projects', () => {
  it('a project without the new kinds checks out exactly as before', () => {
    const json = [BASE, image({ id: 'i1' }), text({ id: 't1' }), { id: 'u', kind: 'sticker', name: '', visible: true }, MASK];
    const { layers, repaired } = checkLayers(json);
    expect(repaired).toBe(false);
    expect(serializeLayers(layers)).toEqual(json);
    expect(JSON.parse(JSON.stringify(serializeLayers(validateLayers(json))))).toEqual(json);
  });
});
