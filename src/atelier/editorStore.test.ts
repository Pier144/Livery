import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef, AtelierProject } from '@/types';
import {
  DUPLICATE_OFFSET,
  HISTORY_LIMIT,
  currentProject,
  insertTarget,
  refitDecal,
  resetAtelierEditor,
  setTextMeasurer,
  useAtelierEditor,
} from './editorStore';
import { allLayers, findLayer, type TreeItem } from './layerTree';
import {
  HAZARD_ASPECT,
  baseOf,
  maskOf,
  newBaseLayer,
  newFolder,
  newImageLayer,
  newMaskLayer,
  newShapeLayer,
  newTextLayer,
  type Decal,
  type DecalLayer,
  type FolderLayer,
  type ImageLayer,
  type Layer,
  type MergedLayer,
  type Piece,
  type ShapeLayer,
  type Stroke,
  type TextLayer,
} from './project';
import { measureTextAspect } from './text';

const PROJECT: AtelierProject = {
  version: 1,
  id: 'p-1',
  name: 'Desert',
  vehicle: 'germ_leopard_2a6',
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  slots: [
    { texture: 'v_body_c', enabled: true },
    { texture: 'v_gun_c', enabled: true },
  ],
  output: { highQuality: false },
  layers: [],
};

const S = () => useAtelierEditor.getState();
const base = () => baseOf(S().layers);
const strokes = () => maskOf(S().layers)?.strokes ?? [];
const brush: Omit<Stroke, 'points'> = { erase: false, radius: 0.1, hardness: 0.5, part: 'all', dir: [0, 0, -1] };

beforeEach(() => {
  resetAtelierEditor();
  S().load(PROJECT);
});

describe('editor store', () => {
  it('loads a new project with a Base, selected, and dirty so the Base gets saved', () => {
    expect(S().layers).toHaveLength(1);
    expect(S().selectedId).toBe(base()?.id);
    expect(S().dirty).toBe(true);
    expect(S().past).toEqual([]);
  });

  it('loads a valid project clean', () => {
    const layers = currentProject(S())?.layers;
    resetAtelierEditor();
    S().load({ ...PROJECT, layers: layers ?? [] });
    expect(S().dirty).toBe(false);
  });

  it('undo and redo walk the history; a new change clears redo', () => {
    S().setBase({ colors: ['#111111'] });
    S().setBase({ colors: ['#222222'] });
    expect(base()?.colors).toEqual(['#222222']);
    S().undo();
    expect(base()?.colors).toEqual(['#111111']);
    S().undo();
    expect(base()?.colors).toEqual(['#56603f']);
    S().undo();
    expect(base()?.colors).toEqual(['#56603f']);
    S().redo();
    expect(base()?.colors).toEqual(['#111111']);
    S().setBase({ mode: 'camo', colors: ['#111111', '#333333'] });
    expect(S().future).toEqual([]);
    S().redo();
    expect(base()?.mode).toBe('camo');
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps`, () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) S().setBase({ seed: i + 2 });
    expect(S().past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) S().undo();
    // The oldest 20 steps are gone: undo stops at seed 21.
    expect(base()?.seed).toBe(21);
  });

  it('one slider drag (same merge key) is one undo step', () => {
    S().setBase({ scale: 1.1 }, 'scale');
    S().setBase({ scale: 1.2 }, 'scale');
    S().setBase({ scale: 1.3 }, 'scale');
    expect(S().past).toHaveLength(1);
    S().setBase({ scale: 1.4 }, 'seed');
    expect(S().past).toHaveLength(2);
    S().undo();
    S().undo();
    expect(base()?.scale).toBe(1);
  });

  it('Base wear: set, clamped to 1, and back to 0 drops the field', () => {
    S().setBase({ wear: 0.3 }, 'wear');
    expect(base()?.wear).toBe(0.3);
    S().setBase({ wear: 2 }, 'wear');
    expect(base()?.wear).toBe(1);
    S().setBase({ wear: 0 }, 'wear');
    expect(base()).not.toHaveProperty('wear');
    expect(S().past).toHaveLength(1);
  });

  it('camo style fields: one step each, defaults leave no field behind', () => {
    S().setBase({ mode: 'camo', colors: ['#111111', '#333333', '#555555'] });
    S().setBase({ pattern: 'hex' });
    expect(base()?.pattern).toBe('hex');
    S().setBase({ pattern: 'organic' });
    expect(base()).not.toHaveProperty('pattern');
    S().setBase({ weights: [0.5, 0.3, 0.2] }, 'shares');
    S().setBase({ weights: [0.4, 0.4, 0.2] }, 'shares');
    expect(base()?.weights).toEqual([0.4, 0.4, 0.2]);
    S().endGesture();
    S().setBase({ weights: undefined });
    expect(base()).not.toHaveProperty('weights');
    S().setBase({ softness: 0.4 }, 'softness');
    expect(base()?.softness).toBe(0.4);
    S().setBase({ softness: 0 }, 'softness');
    expect(base()).not.toHaveProperty('softness');
    S().setBase({ cellSize: 2, angle: -20 });
    expect(base()).toMatchObject({ cellSize: 2, angle: -20 });
    // pattern hex, organic, one shares drag, weights off, one softness drag, cell size + angle.
    expect(S().past).toHaveLength(7);
  });

  it('shares that no longer match the colours are dropped', () => {
    S().setBase({ mode: 'camo', colors: ['#111111', '#333333', '#555555'], weights: [0.5, 0.3, 0.2] });
    S().setBase({ colors: ['#111111', '#333333'] });
    expect(base()).not.toHaveProperty('weights');
  });

  it('endGesture ends a merge: two drags with the same key are two undo steps', () => {
    S().setBase({ scale: 1.1 }, 'scale');
    S().setBase({ scale: 1.2 }, 'scale');
    S().endGesture();
    S().setBase({ scale: 1.5 }, 'scale');
    S().setBase({ scale: 1.6 }, 'scale');
    expect(S().past).toHaveLength(2);
    S().undo();
    expect(base()?.scale).toBe(1.2);
    S().undo();
    expect(base()?.scale).toBe(1);
  });

  it('a stroke being drawn is one undo step, and creates the mask pinned on top', () => {
    S().beginStroke(brush);
    S().extendStroke([0, 0, 0]);
    S().extendStroke([0.1, 0, 0]);
    S().extendStroke([0.2, 0, 0]);
    S().endStroke();
    expect(S().layers.map((l) => l.kind)).toEqual(['base', 'mask']);
    expect(strokes()).toHaveLength(1);
    expect(strokes()[0]?.points).toHaveLength(3);
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(maskOf(S().layers)).toBeUndefined();
  });

  it('a stroke that painted nothing leaves no trace: no undo step, redo kept, not dirty', () => {
    S().addStroke({ ...brush, points: [[0, 0, 0]] });
    S().setBase({ seed: 4 });
    S().undo();
    S().markSaved(currentProject(S())!, S().revision);
    const before = { future: S().future, revision: S().revision };
    expect(S().dirty).toBe(false);
    expect(before.future).toHaveLength(1);
    const past = S().past.length;
    S().beginStroke(brush);
    S().endStroke();
    expect(strokes()).toHaveLength(1);
    expect(S().past).toHaveLength(past);
    expect(S().future).toBe(before.future);
    expect(S().dirty).toBe(false);
    expect(S().revision).toBe(before.revision);
    S().redo();
    expect(base()?.seed).toBe(4);
    S().extendStroke([1, 1, 1]);
    expect(strokes()[0]?.points).toHaveLength(1);
  });

  it('removeLastStroke and clearMask are undoable', () => {
    S().addStroke({ ...brush, points: [[0, 0, 0]] });
    S().addStroke({ ...brush, erase: true, points: [[1, 0, 0]] });
    S().removeLastStroke();
    expect(strokes()).toHaveLength(1);
    S().clearMask();
    expect(strokes()).toHaveLength(0);
    expect(maskOf(S().layers)).toBeDefined();
    S().undo();
    expect(strokes()).toHaveLength(1);
    S().undo();
    expect(strokes()).toHaveLength(2);
  });

  it('hides and renames layers as undo steps; selection is not one', () => {
    const id = base()!.id;
    S().toggleLayerVisible(id);
    S().renameLayer(id, 'Olive');
    S().select(null);
    expect(base()).toMatchObject({ visible: false, name: 'Olive' });
    expect(S().past).toHaveLength(2);
    S().undo();
    S().undo();
    expect(base()).toMatchObject({ visible: true, name: '' });
    // Undo brings the selection back to an existing layer.
    expect(S().selectedId).toBe(id);
  });

  it('slot switches, High quality and the name are saved but never undone', () => {
    S().setBase({ seed: 5 });
    S().setSlotEnabled('v_gun_c', false);
    S().setHighQuality(true);
    S().setName('Winter');
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(S().project?.slots).toEqual([
      { texture: 'v_body_c', enabled: true },
      { texture: 'v_gun_c', enabled: false },
    ]);
    expect(S().project?.output.highQuality).toBe(true);
    expect(S().project?.name).toBe('Winter');
  });

  it('markSaved clears dirty only when nothing changed since the save began', () => {
    const { revision } = S();
    const saved = { ...currentProject(S())!, updatedAt: '2026-10-16T11:00:00Z', installedSkinId: 's-9' };
    S().setBase({ seed: 9 });
    S().markSaved(saved, revision);
    expect(S().dirty).toBe(true);
    expect(S().project?.updatedAt).toBe('2026-10-16T11:00:00Z');
    expect(S().project?.installedSkinId).toBe('s-9');
    S().markSaved(saved, S().revision);
    expect(S().dirty).toBe(false);
  });

  it('loading a project whose layers carry unknown fields is clean, and saves them back', () => {
    const layers = [
      { id: 'b', kind: 'base', name: '', visible: true, mode: 'solid', colors: ['#56603f'], scale: 1, seed: 1, gloss: 0.4 },
      { id: 'm', kind: 'mask', name: '', visible: true, strokes: [{ ...brush, part: 'wheels', points: [[0, 0, 0]], pressure: [1] }], tag: 'x' },
    ];
    resetAtelierEditor();
    S().load({ ...PROJECT, layers });
    expect(S().dirty).toBe(false);
    expect(currentProject(S())?.layers).toEqual(layers);
  });

  it('currentProject serialises the layers into the project', () => {
    S().setBase({ colors: ['#123456'] });
    const project = currentProject(S());
    expect(project?.layers).toEqual(S().layers);
    expect(project?.id).toBe('p-1');
  });
});

const DECAL: Decal = {
  center: [0.5, 0, 0],
  normal: [1, 0, 0],
  up: [0, 1, 0],
  width: 0.4,
  height: 0.2,
  depth: 0.04,
  part: 'all',
  mirror: false,
};
const kinds = () => S().layers.map((l) => l.kind);
const ids = () => S().layers.map((l) => l.id);
const layer = <T extends Layer = DecalLayer>(id: string) => S().layers.find((l) => l.id === id) as T;
const image = (id: string, over: Partial<ImageLayer> = {}): ImageLayer => ({ ...newImageLayer(`img-${id}`, DECAL), id, ...over });

describe('editor store · image and text layers', () => {
  afterEach(() => setTextMeasurer(measureTextAspect));

  it('measures text with text.ts by default (nothing to measure with in jsdom: the width stays)', () => {
    S().addDecalLayer({ ...newTextLayer('ABCD', DECAL), id: 't' });
    expect(layer<TextLayer>('t').decal!.width).toBe(DECAL.width);
  });

  it('adds a decal layer just under the mask, or above the selected image/text layer, and selects it', () => {
    S().addStroke({ ...brush, points: [[0, 0, 0]] });
    S().select(base()!.id);
    S().addDecalLayer(image('a'));
    expect(kinds()).toEqual(['base', 'image', 'mask']);
    expect(S().selectedId).toBe('a');
    S().addDecalLayer(image('b'));
    S().select('a');
    S().addDecalLayer(image('c'));
    expect(ids().slice(1, 4)).toEqual(['a', 'c', 'b']);
    // With the mask selected: just under it.
    S().select(maskOf(S().layers)!.id);
    S().addDecalLayer(image('d'));
    expect(ids().slice(1, 5)).toEqual(['a', 'c', 'b', 'd']);
    expect(S().past).toHaveLength(5);
    S().undo();
    expect(ids()).not.toContain('d');
  });

  it('deletes any layer but the Base, selecting the one below; undo brings it back', () => {
    S().addDecalLayer(image('a'));
    S().addDecalLayer(image('b'));
    S().deleteLayer(base()!.id);
    expect(kinds()).toEqual(['base', 'image', 'image']);
    S().deleteLayer('b');
    expect(ids()).toEqual([base()!.id, 'a']);
    expect(S().selectedId).toBe('a');
    S().undo();
    expect(ids()).toEqual([base()!.id, 'a', 'b']);
    S().addStroke({ ...brush, points: [[0, 0, 0]] });
    S().deleteLayer(maskOf(S().layers)!.id);
    expect(maskOf(S().layers)).toBeUndefined();
  });

  it('duplicates an image or text layer right above it, moved down-right along the surface', () => {
    S().addDecalLayer(image('a', { opacity: 0.5 }));
    S().addDecalLayer(image('b'));
    S().duplicateLayer('a');
    const copyId = S().selectedId!;
    expect(ids().slice(1)).toEqual(['a', copyId, 'b']);
    const copy = layer<ImageLayer>(copyId);
    expect(copy).toMatchObject({ kind: 'image', assetId: 'img-a', opacity: 0.5 });
    const step = (DUPLICATE_OFFSET * DECAL.height) / Math.SQRT2;
    // right = cross(up, normal) = (0,0,-1) here; down = (0,-1,0).
    expect(copy.decal!.center[0]).toBeCloseTo(0.5);
    expect(copy.decal!.center[1]).toBeCloseTo(-step);
    expect(copy.decal!.center[2]).toBeCloseTo(-step);
    // The original is untouched (a deep copy).
    expect(layer<ImageLayer>('a').decal).toEqual(DECAL);
    S().duplicateLayer(base()!.id);
    expect(S().layers).toHaveLength(4);
    S().undo();
    expect(ids().slice(1)).toEqual(['a', 'b']);
  });

  it('restores a deleted layer at its place between the Base and the mask, as one undo step', () => {
    S().addStroke({ ...brush, points: [[0, 0, 0]] });
    for (const id of ['a', 'b', 'c']) S().addDecalLayer(image(id));
    const b = layer('b');
    S().deleteLayer('b');
    S().setLayerProps('a', { opacity: 0.5 });
    const past = S().past.length;
    S().restoreLayer(b, 2);
    expect(ids().slice(1, 4)).toEqual(['a', 'b', 'c']);
    expect(S().selectedId).toBe('b');
    expect(S().past).toHaveLength(past + 1);
    // Already there, the Base or the mask, or out of range: ignored or clamped.
    S().restoreLayer(b, 1);
    expect(S().past).toHaveLength(past + 1);
    S().restoreLayer(base()!, 1);
    expect(kinds().filter((k) => k === 'base')).toHaveLength(1);
    S().deleteLayer('c');
    S().restoreLayer({ ...image('c') }, 99);
    expect(kinds().at(-1)).toBe('mask');
    expect(ids().at(-2)).toBe('c');
    S().undo();
    expect(ids()).not.toContain('c');
  });

  it('moves layers between the Base and the mask only', () => {
    S().addStroke({ ...brush, points: [[0, 0, 0]] });
    for (const id of ['a', 'b', 'c']) S().addDecalLayer(image(id));
    expect(ids().slice(1, 4)).toEqual(['a', 'b', 'c']);
    S().moveLayer('c', 0);
    expect(ids().slice(1, 4)).toEqual(['c', 'a', 'b']);
    S().moveLayer('c', 99);
    expect(ids().slice(1, 4)).toEqual(['a', 'b', 'c']);
    expect(kinds()[0]).toBe('base');
    expect(kinds()[4]).toBe('mask');
    const past = S().past.length;
    S().moveLayer(base()!.id, 2);
    S().moveLayer(maskOf(S().layers)!.id, 1);
    S().moveLayer('c', 3);
    expect(S().past).toHaveLength(past);
    S().undo();
    expect(ids().slice(1, 4)).toEqual(['c', 'a', 'b']);
  });

  it('setDecal: a drag is one undo step per layer; bad results are ignored', () => {
    S().addDecalLayer(image('a'));
    S().addDecalLayer(image('b'));
    const past = S().past.length;
    S().setDecal('a', { center: [0.5, 0.1, 0] }, 'move');
    S().setDecal('a', { center: [0.5, 0.2, 0] }, 'move');
    S().setDecal('b', { center: [0.5, 0.3, 0] }, 'move');
    expect(S().past).toHaveLength(past + 2);
    S().setDecal('a', { normal: [0, 0, 0] }, 'move');
    S().setDecal('a', { width: Number.NaN });
    expect(layer<ImageLayer>('a').decal!.center).toEqual([0.5, 0.2, 0]);
    expect(S().past).toHaveLength(past + 2);
    S().undo();
    S().undo();
    expect(layer<ImageLayer>('a').decal!.center).toEqual([0.5, 0, 0]);
  });

  it('setDecal on a layer without a decal needs a whole decal', () => {
    S().addDecalLayer(image('a', { decal: null }));
    S().setDecal('a', { width: 1 });
    expect(layer<ImageLayer>('a').decal).toBeNull();
    S().setDecal('a', DECAL);
    expect(layer<ImageLayer>('a').decal).toEqual(DECAL);
  });

  it('setLayerProps clamps, ignores what does not check out, and merges a gesture', () => {
    S().addDecalLayer(image('a'));
    const past = S().past.length;
    S().setLayerProps('a', { opacity: 0.4 }, 'opacity');
    S().setLayerProps('a', { opacity: 7 }, 'opacity');
    expect(layer<ImageLayer>('a').opacity).toBe(1);
    expect(S().past).toHaveLength(past + 1);
    S().setLayerProps('a', { assetId: '' });
    expect(layer<ImageLayer>('a').assetId).toBe('img-a');
    S().setLayerProps('a', { flipX: true, kind: 'text' } as never);
    expect(layer<ImageLayer>('a')).toMatchObject({ kind: 'image', flipX: true });
  });

  it('text layers: width = height × measured aspect, in the same step as the edit', () => {
    setTextMeasurer((l) => [...l.text].length * 0.5 + l.skew);
    const text = { ...newTextLayer('ABCD', DECAL), id: 't' };
    S().addDecalLayer(text);
    expect(layer<TextLayer>('t').decal!.width).toBeCloseTo(DECAL.height * 2);
    const past = S().past.length;
    S().setLayerProps('t', { text: 'ABCDEFGH' }, 'text');
    expect(layer<TextLayer>('t').decal!.width).toBeCloseTo(DECAL.height * 4);
    S().setDecal('t', { height: 0.5 }, 'size');
    expect(layer<TextLayer>('t').decal!.width).toBeCloseTo(0.5 * 4);
    expect(S().past).toHaveLength(past + 2);
    S().undo();
    expect(layer<TextLayer>('t').decal).toMatchObject({ height: DECAL.height });
    expect(layer<TextLayer>('t').decal!.width).toBeCloseTo(DECAL.height * 4);
  });

  it('refreshTextMetrics updates the width without an undo step, history included', () => {
    let wide = 1;
    setTextMeasurer(() => wide);
    S().addDecalLayer({ ...newTextLayer('A', DECAL), id: 't' });
    S().setLayerProps('t', { color: '#ff0000' });
    S().undo();
    S().markSaved(currentProject(S())!, S().revision);
    const { past, future } = S();
    wide = 3;
    S().refreshTextMetrics('t');
    expect(layer<TextLayer>('t').decal!.width).toBeCloseTo(DECAL.height * 3);
    expect(S().past).toHaveLength(past.length);
    expect(S().future).toHaveLength(future.length);
    expect(S().dirty).toBe(true);
    S().redo();
    expect(layer<TextLayer>('t')).toMatchObject({ color: '#ff0000' });
    expect(layer<TextLayer>('t').decal!.width).toBeCloseTo(DECAL.height * 3);
    // Nothing to change: nothing happens.
    const revision = S().revision;
    S().refreshTextMetrics('t');
    expect(S().revision).toBe(revision);
  });

  it('applyCutout switches the asset and refits the decal in one undo step', () => {
    // 400×200 px on a 0.4×0.2 decal: 0.001 units per pixel.
    S().addDecalLayer(image('a'));
    const past = S().past.length;
    const source: AssetRef = { id: 'img-a', width: 400, height: 200 };
    const cut: AssetRef = { id: 'img-cut', width: 100, height: 50 };
    S().applyCutout('a', cut, { x: 250, y: 20, w: 100, h: 50 }, source);
    const a = layer<ImageLayer>('a');
    expect(a).toMatchObject({ assetId: 'img-cut', sourceAssetId: 'img-a', sourceOffset: { x: 250, y: 20, w: 100, h: 50 } });
    expect(a.decal!.width).toBeCloseTo(0.1);
    expect(a.decal!.height).toBeCloseTo(0.05);
    // Crop centre (300, 45) vs source centre (200, 100): +100 px along right (0,0,-1), +55 px up.
    expect(a.decal!.center[0]).toBeCloseTo(0.5);
    expect(a.decal!.center[1]).toBeCloseTo(0.055);
    expect(a.decal!.center[2]).toBeCloseTo(-0.1);
    expect(S().past).toHaveLength(past + 1);
    // A second cutout keeps the original source and composes the offset.
    S().applyCutout('a', { id: 'img-cut2', width: 50, height: 50 }, { x: 10, y: 0, w: 50, h: 50 }, cut);
    expect(layer<ImageLayer>('a')).toMatchObject({ sourceAssetId: 'img-a', sourceOffset: { x: 260, y: 20, w: 50, h: 50 } });
    S().undo();
    S().undo();
    expect(layer<ImageLayer>('a')).toMatchObject({ assetId: 'img-a', decal: DECAL });
    expect(layer<ImageLayer>('a')).not.toHaveProperty('sourceAssetId');
  });

  it('applyCutout ignores a stale result: the layer no longer shows the picture that was cut', () => {
    S().addDecalLayer(image('a'));
    S().setLayerProps('a', { assetId: 'img-other' });
    const past = S().past.length;
    const revision = S().revision;
    S().applyCutout('a', { id: 'img-cut', width: 10, height: 10 }, { x: 0, y: 0, w: 10, h: 10 }, { id: 'img-a', width: 400, height: 200 });
    expect(layer<ImageLayer>('a')).toMatchObject({ assetId: 'img-other', decal: DECAL });
    expect(layer<ImageLayer>('a')).not.toHaveProperty('sourceAssetId');
    expect(S().past).toHaveLength(past);
    expect(S().revision).toBe(revision);
  });

  it('applyCutout with a source but no offset makes the current picture the new source', () => {
    S().addDecalLayer(image('a', { assetId: 'img-refined', sourceAssetId: 'img-orig' }));
    S().applyCutout(
      'a',
      { id: 'img-cut', width: 100, height: 50 },
      { x: 250, y: 20, w: 100, h: 50 },
      { id: 'img-refined', width: 400, height: 200 },
    );
    expect(layer<ImageLayer>('a')).toMatchObject({
      assetId: 'img-cut',
      sourceAssetId: 'img-refined',
      sourceOffset: { x: 250, y: 20, w: 100, h: 50 },
    });
  });

  it('setLayerProps drops fields of the other kind', () => {
    S().addDecalLayer({ ...newTextLayer('HI', DECAL), id: 't' });
    S().setLayerProps('t', { flipX: true, assetId: 'img-x', sourceAssetId: 'img-y', color: '#00ff00' });
    const t = layer<TextLayer>('t');
    expect(t.color).toBe('#00ff00');
    for (const key of ['flipX', 'assetId', 'sourceAssetId']) expect(t).not.toHaveProperty(key);
    S().addDecalLayer(image('a'));
    S().setLayerProps('a', { text: 'NO', font: { family: 'Arial', style: 'Bold' }, skew: 0.3, opacity: 0.5 });
    const a = layer<ImageLayer>('a');
    expect(a.opacity).toBe(0.5);
    for (const key of ['text', 'font', 'skew']) expect(a).not.toHaveProperty(key);
  });

  it('refitDecal mirrors the horizontal move of a flipped picture', () => {
    const moved = refitDecal(DECAL, { x: 250, y: 75, w: 100, h: 50 }, { width: 400, height: 200 }, true);
    // +100 px along u, flipped: along -right = (0,0,+1).
    expect(moved.center[2]).toBeCloseTo(0.1);
    expect(moved.center[1]).toBeCloseTo(0);
  });

  it('pending placement: no history until placed, Escape drops it, the click is one undo step', () => {
    setTextMeasurer(() => 2);
    const past = S().past.length;
    const { revision, dirty } = S();
    S().beginPlacement({ kind: 'image', assetId: 'img-1', aspect: 2, name: 'Bust' });
    expect(S().pending).toMatchObject({ kind: 'image' });
    expect(S().layers).toHaveLength(1);
    expect(currentProject(S())?.layers).toHaveLength(1);
    expect(S().past).toHaveLength(past);
    expect(S().revision).toBe(revision);
    S().cancelPlacement();
    expect(S().pending).toBeNull();
    expect(S().past).toHaveLength(past);
    expect(S().dirty).toBe(dirty);
    // Escape with nothing pending: nothing happens.
    S().cancelPlacement();
    expect(S().revision).toBe(revision);

    expect(S().placePending(DECAL)).toBeNull();
    S().beginPlacement({ kind: 'text', text: 'HELLO', font: { family: 'Geist', style: 'Regular' }, aspect: 2 });
    expect(S().placePending({ ...DECAL, up: [1, 0, 0] })).toBeNull();
    expect(S().pending).not.toBeNull();
    const id = S().placePending(DECAL);
    expect(id).not.toBeNull();
    expect(S().pending).toBeNull();
    expect(S().selectedId).toBe(id);
    expect(layer<TextLayer>(id!)).toMatchObject({ kind: 'text', text: 'HELLO', font: { family: 'Geist', style: 'Regular' } });
    expect(layer<TextLayer>(id!).decal!.width).toBeCloseTo(DECAL.height * 2);
    expect(S().past).toHaveLength(past + 1);
    S().undo();
    expect(S().layers).toHaveLength(1);
    expect(S().pending).toBeNull();
  });

  it('a placed image keeps its name; loading a project drops a pending placement', () => {
    S().beginPlacement({ kind: 'image', assetId: 'img-1', aspect: 2, name: 'Bust' });
    const id = S().placePending(DECAL)!;
    expect(layer<ImageLayer>(id)).toMatchObject({ kind: 'image', name: 'Bust', assetId: 'img-1', decal: DECAL });
    S().beginPlacement({ kind: 'image', assetId: 'img-2', aspect: 1 });
    S().load(PROJECT);
    expect(S().pending).toBeNull();
  });

  it('image and text layers are saved and load back clean', () => {
    S().addDecalLayer(image('a'));
    S().addDecalLayer({ ...newTextLayer('HI', DECAL), id: 't' });
    const saved = currentProject(S())!;
    resetAtelierEditor();
    S().load(JSON.parse(JSON.stringify(saved)) as AtelierProject);
    expect(S().dirty).toBe(false);
    expect(ids().slice(1)).toEqual(['a', 't']);
  });
});

// ── Shapes, repeats, folders, multi-select, merge and separate ────────────────

const RIGHT_OF_A: Decal = { ...DECAL, center: [0.5, 0, -0.6] };
const find = (id: string) => findLayer(S().layers, id);
const item = <T extends TreeItem = TreeItem>(id: string) => find(id)?.layer as T;
const shape = (id: string, over: Partial<ShapeLayer> = {}): ShapeLayer => ({ ...newShapeLayer('rect', DECAL), id, ...over });
const folderOf = (id: string, children: FolderLayer['children'], over: Partial<FolderLayer> = {}): FolderLayer => ({
  ...newFolder(id, children),
  id,
  ...over,
});
const childIds = (id: string) => item<FolderLayer | MergedLayer>(id).children.map((c) => c.id);

/** Opens a project holding these layers (after a Base with id `B`), clean, with an empty history. */
function loadLayers(...layers: Layer[]): void {
  resetAtelierEditor();
  const all = [{ ...newBaseLayer(), id: 'B' }, ...layers];
  S().load({ ...PROJECT, layers: JSON.parse(JSON.stringify(all)) as unknown[] });
}

describe('editor store · shapes and repeats', () => {
  it('places a shape and a hazard stripe from a pending placement', () => {
    S().beginPlacement({ kind: 'shape', shape: 'ellipse', aspect: 1, name: 'Dot' });
    const dot = S().placePending(DECAL)!;
    expect(item<ShapeLayer>(dot)).toMatchObject({ kind: 'shape', shape: 'ellipse', name: 'Dot', decal: DECAL, fill: { kind: 'solid' } });
    S().beginPlacement({ kind: 'shape', shape: 'rect', hazard: true, name: 'Hazard stripe', aspect: HAZARD_ASPECT });
    expect(S().pending).toMatchObject({ aspect: 8 });
    const stripe = S().placePending(DECAL)!;
    expect(item<ShapeLayer>(stripe)).toMatchObject({ kind: 'shape', shape: 'rect', name: 'Hazard stripe', fill: { kind: 'stripes' } });
    expect(S().selectedId).toBe(stripe);
    // Placed above the selected shape.
    expect(ids().slice(1)).toEqual([dot, stripe]);
    S().beginPlacement({ kind: 'shape', shape: 'star', aspect: 1 });
    expect(item<ShapeLayer>(S().placePending(DECAL)!).name).toBe('');
  });

  it('setting and clearing a repeat are one undo step each', () => {
    S().addDecalLayer(shape('s'));
    const past = S().past.length;
    S().setLayerProps('s', { repeat: { count: 3, gap: 0.5, direction: 'row' } });
    expect(item<ShapeLayer>('s').repeat).toEqual({ count: 3, gap: 0.5, direction: 'row' });
    S().setLayerProps('s', { repeat: null });
    expect(item<ShapeLayer>('s')).not.toHaveProperty('repeat');
    expect(S().past).toHaveLength(past + 2);
    S().undo();
    expect(item<ShapeLayer>('s').repeat).toMatchObject({ count: 3 });
  });

  it('setLayerProps on a shape takes shape fields and drops image and text ones', () => {
    S().addDecalLayer(shape('s'));
    S().setLayerProps('s', { shape: 'star', points: 7, innerRatio: 5, outlineWidth: 3, text: 'NO', flipX: true });
    const s = item<ShapeLayer>('s');
    expect(s).toMatchObject({ shape: 'star', points: 7, innerRatio: 0.9, outlineWidth: 3 });
    for (const key of ['text', 'flipX']) expect(s).not.toHaveProperty(key);
  });
});

describe('editor store · folders', () => {
  beforeEach(() => loadLayers(image('x'), folderOf('F', [image('a'), image('b')]), image('y')));

  it('edits a layer inside a folder: rename, hide, setDecal, setLayerProps', () => {
    S().renameLayer('a', 'Badge');
    S().toggleLayerVisible('a');
    S().setDecal('a', { center: [0.5, 0.3, 0] });
    S().setLayerProps('a', { opacity: 0.25 });
    expect(item<ImageLayer>('a')).toMatchObject({ name: 'Badge', visible: false, opacity: 0.25 });
    expect(item<ImageLayer>('a').decal!.center).toEqual([0.5, 0.3, 0]);
    expect(find('a')?.parentId).toBe('F');
    expect(S().past).toHaveLength(4);
    // Folders hide and rename too.
    S().toggleLayerVisible('F');
    S().renameLayer('F', 'Markings');
    expect(item<FolderLayer>('F')).toMatchObject({ visible: false, name: 'Markings' });
  });

  it('deletes a layer inside a folder, selecting the one below, else the folder', () => {
    S().select('b');
    S().deleteLayer('b');
    expect(childIds('F')).toEqual(['a']);
    expect(S().selectedId).toBe('a');
    S().deleteLayer('a');
    expect(childIds('F')).toEqual([]);
    expect(S().selectedId).toBe('F');
    S().undo();
    S().undo();
    expect(childIds('F')).toEqual(['a', 'b']);
  });

  it('duplicates a layer in its folder, and a folder with new ids and offset children', () => {
    S().duplicateLayer('a');
    const copy = S().selectedId!;
    expect(childIds('F')).toEqual(['a', copy, 'b']);
    S().duplicateLayer('F');
    const folderCopy = item<FolderLayer>(S().selectedId!);
    expect(ids()).toEqual(['B', 'x', 'F', folderCopy.id, 'y']);
    const inner = folderCopy.children as ImageLayer[];
    expect(inner).toHaveLength(3);
    for (const child of inner) expect(['a', 'b', copy]).not.toContain(child.id);
    expect(inner[0]!.decal!.center).not.toEqual(DECAL.center);
    expect(item<ImageLayer>('a').decal).toEqual(DECAL);
    expect(new Set(allLayers(S().layers).map((l) => l.id)).size).toBe(allLayers(S().layers).length);
  });

  it('undo keeps a folder child selected', () => {
    S().select('a');
    S().setLayerProps('a', { opacity: 0.5 });
    S().undo();
    expect(S().selectedId).toBe('a');
    S().redo();
    expect(S().selectedId).toBe('a');
  });

  it("createFolder from a multi-selection puts the layers in at the topmost one's place", () => {
    S().select('x');
    S().toggleSelect('y');
    expect(S().selectedIds).toEqual(['x', 'y']);
    const id = S().createFolder('Group', S().selectedIds)!;
    expect(ids()).toEqual(['B', 'F', id]);
    expect(item<FolderLayer>(id)).toMatchObject({ kind: 'folder', name: 'Group', collapsed: false });
    expect(childIds(id)).toEqual(['x', 'y']);
    expect(S().selectedId).toBe(id);
    expect(S().selectedIds).toEqual([]);
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(ids()).toEqual(['B', 'x', 'F', 'y']);
    // Only top-level placed layers.
    expect(S().createFolder('No', ['a', 'x'])).toBeNull();
    expect(S().createFolder('No', ['F', 'x'])).toBeNull();
    expect(S().past).toHaveLength(0);
  });

  it('createFolder without ids goes above the selection, but never inside a folder', () => {
    S().select('x');
    const above = S().createFolder('One')!;
    expect(ids()).toEqual(['B', 'x', above, 'F', 'y']);
    S().select('a');
    const outside = S().createFolder('Two')!;
    expect(ids()).toEqual(['B', 'x', above, 'F', outside, 'y']);
    S().select('F');
    const overFolder = S().createFolder('Three')!;
    expect(ids().indexOf(overFolder)).toBe(ids().indexOf('F') + 1);
  });

  it('dissolves a folder: its children take its place', () => {
    S().select('F');
    S().dissolveFolder('F');
    expect(ids()).toEqual(['B', 'x', 'a', 'b', 'y']);
    expect(S().selectedId).toBe('b');
    S().undo();
    expect(ids()).toEqual(['B', 'x', 'F', 'y']);
  });

  it('moveInto drags layers into and out of a folder; folders never go into folders', () => {
    S().moveInto('x', 'F', 0);
    expect(ids()).toEqual(['B', 'F', 'y']);
    expect(childIds('F')).toEqual(['x', 'a', 'b']);
    S().moveInto('b', null, 1);
    expect(ids()).toEqual(['B', 'b', 'F', 'y']);
    expect(S().past).toHaveLength(2);
    const g = S().createFolder('G', ['y'])!;
    const past = S().past.length;
    S().moveInto(g, 'F', 0);
    S().moveInto('a', 'x', 0);
    expect(S().past).toHaveLength(past);
    expect(find(g)?.parentId).toBeNull();
    S().undo();
    expect(ids()).toEqual(['B', 'b', 'F', 'y']);
    S().undo();
    expect(ids()).toEqual(['B', 'F', 'y']);
  });

  it('moveLayer moves within the folder', () => {
    S().moveLayer('a', 5);
    expect(childIds('F')).toEqual(['b', 'a']);
    expect(find('a')?.parentId).toBe('F');
  });

  it('restoreLayer puts a layer back into its folder, or the top level when the folder is gone', () => {
    const a = item<ImageLayer>('a');
    S().deleteLayer('a');
    S().restoreLayer(a, 0, 'F');
    expect(childIds('F')).toEqual(['a', 'b']);
    S().deleteLayer('a');
    S().deleteLayer('F');
    S().restoreLayer(a, 0, 'F');
    expect(ids()).toEqual(['B', 'x', 'y', 'a']);
  });

  it('collapsing is saved but not an undo step, and undo never flips it', () => {
    S().setLayerProps('x', { opacity: 0.5 });
    const past = S().past.length;
    const revision = S().revision;
    S().toggleCollapsed('F');
    expect(item<FolderLayer>('F').collapsed).toBe(true);
    expect(S().past).toHaveLength(past);
    expect(S().revision).toBe(revision + 1);
    expect(S().dirty).toBe(true);
    expect(S().past.every((snapshot) => (findLayer(snapshot, 'F')?.layer as FolderLayer).collapsed)).toBe(true);
    S().undo();
    expect(item<FolderLayer>('F').collapsed).toBe(true);
    S().redo();
    expect(item<FolderLayer>('F').collapsed).toBe(true);
    S().toggleCollapsed('F');
    expect(item<FolderLayer>('F').collapsed).toBe(false);
    // Not a folder: nothing happens.
    S().toggleCollapsed('x');
    expect(item<ImageLayer>('x')).not.toHaveProperty('collapsed');
  });
});

describe('editor store · multi-select', () => {
  beforeEach(() => loadLayers(image('x'), image('y'), image('z'), folderOf('F', [image('a'), image('b')])));

  it('Ctrl toggles placed layers and folders of one container', () => {
    S().select('x');
    S().toggleSelect('z');
    S().toggleSelect('F');
    expect(S().selectedIds).toEqual(['x', 'z', 'F']);
    expect(S().selectedId).toBe('F');
    S().toggleSelect('F');
    expect(S().selectedIds).toEqual(['x', 'z']);
    expect(S().selectedId).toBe('z');
    S().toggleSelect('x');
    expect(S().selectedIds).toEqual([]);
    expect(S().selectedId).toBe('z');
  });

  it('Ctrl on the Base, or across containers, falls back to a single selection', () => {
    S().select('x');
    S().toggleSelect('B');
    expect(S().selectedIds).toEqual([]);
    expect(S().selectedId).toBe('B');
    S().toggleSelect('x');
    expect(S().selectedId).toBe('x');
    expect(S().selectedIds).toEqual([]);
    S().toggleSelect('a');
    expect(S().selectedIds).toEqual([]);
    expect(S().selectedId).toBe('a');
    S().toggleSelect('b');
    expect(S().selectedIds).toEqual(['a', 'b']);
  });

  it('Shift selects the range in the container, the active row staying the anchor', () => {
    S().select('y');
    S().selectRange('F');
    expect(S().selectedIds).toEqual(['y', 'z', 'F']);
    expect(S().selectedId).toBe('y');
    S().selectRange('x');
    expect(S().selectedIds).toEqual(['x', 'y']);
    S().selectRange('a');
    expect(S().selectedIds).toEqual([]);
    expect(S().selectedId).toBe('a');
  });

  it('plain selection, undo and structural actions go back to a single selection', () => {
    S().select('x');
    S().toggleSelect('y');
    S().select('z');
    expect(S().selectedIds).toEqual([]);
    S().toggleSelect('y');
    S().setLayerProps('z', { opacity: 0.5 });
    S().toggleSelect('x');
    expect(S().selectedIds).toEqual(['z', 'y', 'x']);
    S().undo();
    expect(S().selectedIds).toEqual([]);
    S().toggleSelect('y');
    S().moveLayer('x', 3);
    expect(S().selectedIds).toEqual([]);
  });

  it('deleteLayers is one step; restoreLayers puts each back in its container, even after other edits', () => {
    const entries = S().deleteLayers(['y', 'a', 'z']);
    expect(entries.map((e) => [e.layer.id, e.parentId, e.index])).toEqual([
      ['a', 'F', 0],
      ['z', null, 3],
      ['y', null, 2],
    ]);
    expect(ids()).toEqual(['B', 'x', 'F']);
    expect(childIds('F')).toEqual(['b']);
    expect(S().past).toHaveLength(1);
    S().setLayerProps('x', { opacity: 0.5 });
    S().restoreLayers(entries);
    expect(ids()).toEqual(['B', 'x', 'y', 'z', 'F']);
    expect(childIds('F')).toEqual(['a', 'b']);
    expect(S().past).toHaveLength(3);
    // Already there: skipped.
    S().restoreLayers(entries);
    expect(S().past).toHaveLength(3);
    S().undo();
    expect(ids()).toEqual(['B', 'x', 'F']);
  });

  it('deleteLayers skips the Base and children of a deleted folder; a gone folder restores to the top level', () => {
    const entries = S().deleteLayers(['B', 'F', 'a']);
    expect(entries.map((e) => e.layer.id)).toEqual(['F']);
    S().undo();
    const first = S().deleteLayers(['b']);
    S().deleteLayers(['F']);
    S().addStroke({ ...brush, points: [[0, 0, 0]] });
    S().restoreLayers(first);
    expect(ids()).toEqual(['B', 'x', 'y', 'z', 'b', maskOf(S().layers)!.id]);
  });
});

describe('editor store · merge and separate', () => {
  afterEach(() => setTextMeasurer(measureTextAspect));

  beforeEach(() => loadLayers(image('a'), shape('c', { decal: { ...DECAL, center: [0.5, 1, 0] } }), image('b', { decal: RIGHT_OF_A })));

  it("merges into one frame at the topmost layer's place, selected, as one undo step", () => {
    const result = S().mergeLayers(['b', 'a']);
    expect(result).toMatchObject({ ok: true, reset: { part: false, mirror: false } });
    if (!result.ok) return;
    expect(ids()).toEqual(['B', 'c', result.id]);
    const merged = item<MergedLayer>(result.id);
    expect(merged).toMatchObject({ kind: 'merged', name: '', visible: true, opacity: 1 });
    expect(childIds(result.id)).toEqual(['a', 'b']);
    // A spans right -0.2..0.2, B 0.4..0.8 (right = -z): a 1 × 0.2 frame centred at right 0.3.
    expect(merged.decal!.width).toBeCloseTo(1);
    expect(merged.decal!.height).toBeCloseTo(0.2);
    expect(merged.decal!.center[2]).toBeCloseTo(-0.3);
    expect(merged.decal!.depth).toBeCloseTo(DECAL.depth);
    const [pa, pb] = merged.children as Piece[];
    expect(pa!.place.x).toBeCloseTo(-0.3);
    expect(pb!.place.x).toBeCloseTo(0.3);
    expect(pa!.place.w).toBeCloseTo(0.4);
    expect(pa).not.toHaveProperty('decal');
    expect(S().selectedId).toBe(result.id);
    expect(S().selectedIds).toEqual([]);
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(ids()).toEqual(['B', 'a', 'c', 'b']);
    expect(item<ImageLayer>('b').decal).toEqual(RIGHT_OF_A);
  });

  it('refuses one id, mixed containers, folders, unplaced layers, faces too far apart and too many pieces', () => {
    loadLayers(
      image('a'),
      image('b', { decal: RIGHT_OF_A }),
      image('u', { decal: null }),
      image('t', { decal: { ...DECAL, normal: [0, 0, 1] } }),
      image('r', { repeat: { count: 50, gap: 0, direction: 'row' } }),
      folderOf('F', [image('f')]),
    );
    expect(S().mergeLayers(['a'])).toEqual({ ok: false, reason: 'count' });
    expect(S().mergeLayers(['a', 'a'])).toEqual({ ok: false, reason: 'count' });
    expect(S().mergeLayers(['a', 'f'])).toEqual({ ok: false, reason: 'container' });
    expect(S().mergeLayers(['a', 'F'])).toEqual({ ok: false, reason: 'container' });
    expect(S().mergeLayers(['a', 'u'])).toEqual({ ok: false, reason: 'unplaced' });
    expect(S().mergeLayers(['a', 'B'])).toEqual({ ok: false, reason: 'unplaced' });
    expect(S().mergeLayers(['a', 't'])).toEqual({ ok: false, reason: 'angle' });
    expect(S().mergeLayers(['a', 'r'])).toEqual({ ok: false, reason: 'pieces' });
    expect(S().past).toHaveLength(0);
  });

  it('merges inside a folder', () => {
    loadLayers(folderOf('F', [image('a'), image('b', { decal: RIGHT_OF_A })]));
    const result = S().mergeLayers(['a', 'b']);
    if (!result.ok) throw new Error('refused');
    expect(find(result.id)?.parentId).toBe('F');
    expect(childIds('F')).toEqual([result.id]);
  });

  it('a repeated layer gives one piece per copy, the first keeping its id', () => {
    S().setLayerProps('a', { repeat: { count: 3, gap: 0, direction: 'column' } });
    const result = S().mergeLayers(['a', 'b']);
    if (!result.ok) throw new Error('refused');
    const merged = item<MergedLayer>(result.id);
    const children = merged.children as Piece[];
    expect(children).toHaveLength(4);
    expect(children[0]!.id).toBe('a');
    expect(children[3]!.id).toBe('b');
    expect(new Set(children.map((c) => c.id)).size).toBe(4);
    for (const c of children) expect(c).not.toHaveProperty('repeat');
    // Column copies go downwards, one height apart.
    expect(children[1]!.place.y - children[0]!.place.y).toBeCloseTo(-DECAL.height / merged.decal!.height);
  });

  it('a merged object in the selection is flattened', () => {
    const first = S().mergeLayers(['a', 'b']);
    if (!first.ok) throw new Error('refused');
    S().setLayerProps(first.id, { opacity: 0.5 });
    const second = S().mergeLayers([first.id, 'c']);
    if (!second.ok) throw new Error('refused');
    const children = item<MergedLayer>(second.id).children as Piece[];
    expect(children.map((c) => c.id)).toEqual(['c', 'a', 'b']);
    expect(children.map((c) => c.opacity)).toEqual([1, 0.5, 0.5]);
    expect(ids()).toEqual(['B', second.id]);
  });

  it('part kept when all agree, Mirror only when all are on; reset flags say what changed', () => {
    S().setDecal('a', { part: 'turret', mirror: true });
    S().setDecal('b', { part: 'turret', mirror: true });
    let result = S().mergeLayers(['a', 'b']);
    if (!result.ok) throw new Error('refused');
    expect(result.reset).toEqual({ part: false, mirror: false });
    expect(item<MergedLayer>(result.id).decal).toMatchObject({ part: 'turret', mirror: true });
    S().undo();
    S().setDecal('b', { part: 'hull', mirror: false });
    result = S().mergeLayers(['a', 'b']);
    if (!result.ok) throw new Error('refused');
    expect(result.reset).toEqual({ part: true, mirror: true });
    expect(item<MergedLayer>(result.id).decal).toMatchObject({ part: 'all', mirror: false });
  });

  it("separate gives the layers back at the merged object's place, selected; undo brings it back", () => {
    const merged = S().mergeLayers(['a', 'b']);
    if (!merged.ok) throw new Error('refused');
    const result = S().separate(merged.id);
    expect(result).toEqual({ ok: true, ids: ['a', 'b'], droppedRepeat: false });
    expect(ids()).toEqual(['B', 'c', 'a', 'b']);
    expect(S().selectedIds).toEqual(['a', 'b']);
    expect(S().selectedId).toBe('b');
    const b = item<ImageLayer>('b').decal!;
    for (let k = 0; k < 3; k += 1) expect(b.center[k]).toBeCloseTo(RIGHT_OF_A.center[k]!, 6);
    expect(b.width).toBeCloseTo(RIGHT_OF_A.width, 6);
    S().undo();
    expect(item<MergedLayer>(merged.id).kind).toBe('merged');
    S().setLayerProps(merged.id, { repeat: { count: 2, gap: 0, direction: 'row' }, flipX: true });
    expect(item<MergedLayer>(merged.id)).not.toHaveProperty('flipX');
    expect(S().separate(merged.id)).toMatchObject({ ok: true, droppedRepeat: true });
    expect(S().separate('c')).toEqual({ ok: false });
  });

  it('a text piece gets its new width from the measurer: centre and height kept, frame not refitted', () => {
    let perChar = 0.5;
    setTextMeasurer((l) => [...l.text].length * perChar);
    loadLayers(image('a'), { ...newTextLayer('AB', RIGHT_OF_A), id: 't' });
    const result = S().mergeLayers(['a', 't']);
    if (!result.ok) throw new Error('refused');
    const frame = item<MergedLayer>(result.id).decal!;
    const before = item<Piece>('t').place;
    S().setLayerProps('t', { text: 'ABCDEFGH', repeat: { count: 3, gap: 0, direction: 'row' } });
    const after = item<Piece>('t');
    expect(after).toMatchObject({ kind: 'text', text: 'ABCDEFGH' });
    expect(after).not.toHaveProperty('repeat');
    expect(after.place.w).toBeCloseTo((before.h * frame.height * 4) / frame.width);
    expect(after.place).toMatchObject({ x: before.x, y: before.y, h: before.h });
    expect(item<MergedLayer>(result.id).decal).toEqual(frame);
    // A font that finished loading: refitted without an undo step, history included.
    perChar = 1;
    const past = S().past.length;
    S().refreshTextMetrics('t');
    expect(item<Piece>('t').place.w).toBeCloseTo((before.h * frame.height * 8) / frame.width);
    expect(S().past).toHaveLength(past);
    S().undo();
    expect(item<Piece>('t').place.w).toBeCloseTo((before.h * frame.height * 2) / frame.width);
  });

  it('applyCutout and setDecal ignore pieces', () => {
    const result = S().mergeLayers(['a', 'b']);
    if (!result.ok) throw new Error('refused');
    const { past, revision } = S();
    S().applyCutout('a', { id: 'img-cut', width: 10, height: 10 }, { x: 0, y: 0, w: 10, h: 10 }, { id: 'img-a', width: 400, height: 200 });
    S().setDecal('a', DECAL);
    expect(S().past).toBe(past);
    expect(S().revision).toBe(revision);
    expect(item<Piece>('a')).toMatchObject({ assetId: 'img-a' });
    expect(item<Piece>('a')).not.toHaveProperty('decal');
  });

  it('deleting the last drawable piece deletes the merged object', () => {
    const result = S().mergeLayers(['a', 'b']);
    if (!result.ok) throw new Error('refused');
    S().select('a');
    S().deleteLayer('a');
    expect(childIds(result.id)).toEqual(['b']);
    expect(S().selectedId).toBe(result.id);
    S().deleteLayer('b');
    expect(find(result.id)).toBeNull();
    expect(ids()).toEqual(['B', 'c']);
    S().undo();
    expect(childIds(result.id)).toEqual(['b']);
  });

  it('duplicating a merged object renews every id; pieces are not duplicated on their own', () => {
    const result = S().mergeLayers(['a', 'b']);
    if (!result.ok) throw new Error('refused');
    S().duplicateLayer(result.id);
    const copy = item<MergedLayer>(S().selectedId!);
    expect(copy.kind).toBe('merged');
    expect(copy.id).not.toBe(result.id);
    expect(copy.children.map((c) => c.id)).not.toContain('a');
    expect(new Set(allLayers(S().layers).map((l) => l.id)).size).toBe(allLayers(S().layers).length);
    const count = allLayers(S().layers).length;
    S().duplicateLayer('a');
    expect(allLayers(S().layers)).toHaveLength(count);
  });
});

describe('insertTarget', () => {
  const { decal: _d, ...pictureOfP } = image('p');
  const merged: MergedLayer = {
    id: 'M',
    kind: 'merged',
    name: '',
    visible: true,
    decal: DECAL,
    opacity: 1,
    children: [{ ...pictureOfP, place: { x: 0, y: 0, w: 1, h: 1, angle: 0 } }],
  };
  const layers: Layer[] = [{ ...newBaseLayer(), id: 'B' }, image('x'), folderOf('F', [image('a'), image('b')]), merged, { ...newMaskLayer(), id: 'K' }];

  it('goes above the selected layer in its container, or at the top of a selected folder', () => {
    expect(insertTarget(layers, 'x')).toEqual({ parentId: null, index: 2 });
    expect(insertTarget(layers, 'a')).toEqual({ parentId: 'F', index: 1 });
    expect(insertTarget(layers, 'F')).toEqual({ parentId: 'F', index: 2 });
    expect(insertTarget(layers, 'M')).toEqual({ parentId: null, index: 4 });
  });

  it('goes above the merged object of a selected piece', () => {
    expect(insertTarget(layers, 'p')).toEqual({ parentId: null, index: 4 });
    const inFolder: Layer[] = [layers[0]!, folderOf('G', [image('y'), merged])];
    expect(insertTarget(inFolder, 'p')).toEqual({ parentId: 'G', index: 2 });
  });

  it('goes just under the mask with the Base, the mask or nothing selected', () => {
    for (const id of ['B', 'K', null, 'gone']) expect(insertTarget(layers, id)).toEqual({ parentId: null, index: 4 });
    expect(insertTarget(layers.slice(0, 4), null)).toEqual({ parentId: null, index: 4 });
  });

  it('a layer added with a folder child selected lands in the folder', () => {
    loadLayers(folderOf('F', [image('a')]));
    S().select('a');
    S().addDecalLayer(image('n'));
    expect(childIds('F')).toEqual(['a', 'n']);
    S().select('F');
    S().addDecalLayer(image('m'));
    expect(childIds('F')).toEqual(['a', 'n', 'm']);
  });
});
