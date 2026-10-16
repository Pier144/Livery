import { beforeEach, describe, expect, it } from 'vitest';
import type { AtelierProject } from '@/types';
import { HISTORY_LIMIT, currentProject, resetAtelierEditor, useAtelierEditor } from './editorStore';
import { baseOf, maskOf, type Stroke } from './project';

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
