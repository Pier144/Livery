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
  checkDecalLayer,
  decalLayers,
  decalRight,
  defaultDepth,
  isDecalLayer,
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
  type ImageLayer,
  type MaskLayer,
  type Stroke,
  type TextLayer,
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
    expect(isDecalLayer(layers[1])).toBe(true);
    expect(isDecalLayer(layers[4])).toBe(false);
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

  it('checkDecalLayer re-checks an edited layer', () => {
    const [, txt] = validateLayers([BASE, text()]);
    expect(checkDecalLayer({ ...(txt as TextLayer), skew: 4 })).toMatchObject({ skew: MAX_SKEW });
    const [, img] = validateLayers([BASE, image()]);
    expect(checkDecalLayer({ ...(img as ImageLayer), assetId: '' })).toBeNull();
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
    expect(checkDecalLayer({ ...(txt as TextLayer), wear: 0 })).not.toHaveProperty('wear');
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
