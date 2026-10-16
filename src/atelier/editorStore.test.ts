import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef, AtelierProject } from '@/types';
import {
  DUPLICATE_OFFSET,
  HISTORY_LIMIT,
  currentProject,
  refitDecal,
  resetAtelierEditor,
  setTextMeasurer,
  useAtelierEditor,
} from './editorStore';
import {
  baseOf,
  maskOf,
  newImageLayer,
  newTextLayer,
  type Decal,
  type DecalLayer,
  type ImageLayer,
  type Layer,
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
