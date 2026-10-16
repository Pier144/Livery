import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_COLOR,
  DEFAULT_CAMO_COLOR,
  baseOf,
  maskOf,
  newBaseLayer,
  newMaskLayer,
  serializeLayers,
  checkLayers,
  partGroupOf,
  validateLayers,
  type MaskLayer,
  type Stroke,
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
      { id: 'img', kind: 'image', name: 'Bust', visible: true, assetId: 'x' },
      { id: 'b1', kind: 'base', name: '', visible: true, mode: 'solid', colors: ['#112233'], scale: 1, seed: 1 },
      { id: 'b2', kind: 'base', name: '', visible: true, mode: 'solid', colors: ['#445566'], scale: 1, seed: 1 },
      { id: 'm2', kind: 'mask', name: '', visible: true, strokes: [] },
    ];
    const layers = validateLayers(json);
    expect(layers.map((l) => l.id)).toEqual(['b1', 'img', 'm1']);
    expect(layers[1]?.kind).toBe('unsupported');
  });

  it('keeps unsupported kinds exactly as they came when saved back', () => {
    const image = { id: 'img', kind: 'image', name: 'Bust', visible: false, assetId: 'a1', decal: { width: 1 } };
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
