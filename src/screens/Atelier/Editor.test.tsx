import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAtelierEditor } from '@/atelier/editorStore';
import {
  maskOf,
  newBaseLayer,
  newFolder,
  newShapeLayer,
  newTextLayer,
  type BaseLayer,
  type Decal,
  type DecalLayer,
  type ImageLayer,
  type Layer,
  type MergedLayer,
  type Piece,
  type ShapeLayer,
  type TextLayer,
} from '@/atelier/project';
import { ConfirmDialog } from '@/components/chrome/ConfirmDialog';
import { Toaster } from '@/components/chrome/Toaster';
import { encodeAsset, encodeMockModel, mockPicture, mockTemplate, MOCK_TEXTURE_SIZE } from '@/dev/mockAtelier';
import { useAtelierUi } from '@/store/atelier';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { ApplyProgress, AtelierProject, CutoutStatus, HangarSkin } from '@/types';
import { resetDecalUi, setCutoutBusy } from './decalUi';
import { Editor } from './Editor';
import { EngineContext, type Engine, type EngineFactory } from './engine';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  callRaw: vi.fn<(cmd: string, body: Uint8Array, headers: Record<string, string>) => Promise<unknown>>(),
  progress: [] as ((p: ApplyProgress) => void)[],
  /** Every listener with its event name (decal tests emit download and cutout progress). */
  events: [] as { name: string; handler: (p: unknown) => void }[],
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => 'C:\\Pictures\\logo.png') }));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
  callRaw: (cmd: string, body: Uint8Array, headers: Record<string, string>) => backend.callRaw(cmd, body, headers),
}));

vi.mock('@/lib/events', () => ({
  listenEvent: async (name: string, handler: (p: ApplyProgress) => void) => {
    backend.progress.push(handler);
    const entry = { name, handler: handler as (p: unknown) => void };
    backend.events.push(entry);
    return () => {
      backend.progress = backend.progress.filter((h) => h !== handler);
      backend.events = backend.events.filter((e) => e !== entry);
    };
  },
}));

const TIGER = 'germ_pzkpfw_VI_ausf_b_tiger_IIH';
const SLOTS = ['body', 'turret', 'gun'].map((s) => `${TIGER}_${s}_c`);

function project(extra: Partial<AtelierProject> = {}): AtelierProject {
  return {
    version: 1,
    id: 'p1',
    name: 'Desert',
    vehicle: TIGER,
    createdAt: '2026-10-16T09:00:00Z',
    updatedAt: '2026-10-16T09:00:00Z',
    slots: SLOTS.map((texture) => ({ texture, enabled: true })),
    output: { highQuality: false },
    layers: [],
    ...extra,
  };
}

const SKIN = { id: 'h_new', name: 'Desert', folder: `${TIGER}_Desert` } as HangarSkin;

let stored: AtelierProject;
let commit: () => Promise<unknown>;
let begin: () => Promise<unknown>;
let texture: () => Promise<unknown>;

/** Answers a test adds for one command (checked before the defaults). */
let extra: Record<string, (args: Record<string, unknown>) => unknown> = {};

function answer(cmd: string, args: Record<string, unknown> = {}): unknown {
  const own = extra[cmd];
  if (own) return own(args);
  switch (cmd) {
    case 'atelier_project_get':
      return stored;
    case 'atelier_project_save':
      stored = { ...(args.project as AtelierProject), updatedAt: '2026-10-16T10:00:00Z' };
      return stored;
    case 'atelier_model':
      return encodeMockModel(String(args.vehicle));
    case 'atelier_template_texture': {
      const rgba = mockTemplate(SLOTS.indexOf(String(args.slot)));
      return rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
    }
    case 'atelier_projects':
      return [];
    case 'atelier_apply_begin':
      return begin();
    case 'atelier_apply_commit':
      return commit();
    case 'atelier_apply_cancel':
    case 'undo_replace':
    case 'atelier_project_open':
      return null;
    default:
      return Promise.reject({ code: 'noBackend', message: `unexpected ${cmd}` });
  }
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const order = () =>
  [...backend.call.mock.invocationCallOrder.map((n, i) => [n, backend.call.mock.calls[i]![0]] as const), ...backend.callRaw.mock.invocationCallOrder.map((n, i) => [n, backend.callRaw.mock.calls[i]![0]] as const)]
    .sort((a, b) => a[0] - b[0])
    .map(([, cmd]) => cmd)
    .filter((cmd) => cmd.startsWith('atelier_apply') || cmd === 'atelier_project_thumb');
const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);

/** A WebGL-free engine: a scene whose raycasts hit the cube's front, and a Baker that records its calls. */
function stubEngine() {
  const engine = {
    scene: {
      boundingRadius: 1,
      requestRender: vi.fn(),
      quickView: vi.fn(),
      orbitBy: vi.fn(),
      panBy: vi.fn(),
      zoomBy: vi.fn(),
      viewDirection: vi.fn(() => [-1, 0, 0] as [number, number, number]),
      pixelRadius: vi.fn(() => 12),
      raycast: vi.fn((x: number, y: number) => ({
        point: [0.5, y / 100, x / 100] as [number, number, number],
        normal: [1, 0, 0] as [number, number, number],
        node: '@root',
        group: 'hull' as const,
        distance: 3,
      })),
      thumbnailPng: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      view: vi.fn(() => ({ target: [0, 0, 0] as [number, number, number], radius: 4, theta: 0.5, phi: 1 })),
      setView: vi.fn(),
      contextLost: vi.fn(() => false),
      onRender: vi.fn(() => () => {}),
      viewSize: vi.fn(() => ({ width: 200, height: 100 })),
      cameraMatrixWorld: vi.fn(() => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      // Consistent with `raycast`: a model point (0.5, y, z) is at (z·100, y·100) on the view.
      // A method that needs its scene, like `Scene.project` (it reads `this`): passed around
      // unbound it throws, as the real one does.
      project: vi.fn(function (this: { viewSize: () => unknown } | undefined, p: [number, number, number]) {
        if (!this?.viewSize) throw new TypeError("Cannot read properties of undefined (reading 'scratch')");
        return { x: p[2] * 100, y: p[1] * 100, behind: false };
      }),
    },
    baker: {
      setLayers: vi.fn(),
      setShowTemplate: vi.fn(),
      stampStroke: vi.fn(),
      bakeForExport: vi.fn((slot: string) => ({
        rgba: new Uint8Array(MOCK_TEXTURE_SIZE * MOCK_TEXTURE_SIZE * 4),
        w: MOCK_TEXTURE_SIZE,
        h: MOCK_TEXTURE_SIZE,
        downscaled: slot.endsWith('_gun_c') && downscaleGun,
      })),
      upgrade: vi.fn(),
      whenReady: vi.fn(async () => {}),
      prepareExport: vi.fn(async () => {}),
      endExport: vi.fn(),
      decalTouchesSharedTexels: vi.fn(async () => false),
      truncated: false,
    },
    dispose: vi.fn(),
  };
  return engine;
}

let engine: ReturnType<typeof stubEngine>;
let downscaleGun: boolean;
const factory: EngineFactory = () => engine as unknown as Engine;

function renderEditor(p: AtelierProject = project()) {
  stored = p;
  useAtelierUi.getState().open(p.id);
  return renderWithProviders(
    <EngineContext.Provider value={factory}>
      <Editor id={p.id} />
      <Toaster />
      <ConfirmDialog />
    </EngineContext.Provider>,
    { settings: { atelierEnabled: true, readGameData: true } },
  );
}

/** The editor once the model, templates and engine are in. */
async function ready() {
  await screen.findByRole('application', { name: /3D view of/ });
  await waitFor(() => expect(engine.baker.setLayers).toHaveBeenCalled());
}

beforeEach(() => {
  resetStores();
  useUi.setState({ screen: 'atelier' });
  engine = stubEngine();
  downscaleGun = false;
  begin = async () => ({ applyId: 'a1' });
  commit = async () => ({ skin: SKIN });
  texture = async () => null;
  backend.progress = [];
  backend.events = [];
  extra = {};
  backend.call.mockReset();
  backend.call.mockImplementation(async (cmd, args) => answer(cmd, args));
  backend.callRaw.mockReset();
  backend.callRaw.mockImplementation(async (cmd) => (cmd === 'atelier_apply_texture' ? texture() : null));
});

describe('Atelier editor', () => {
  it('shows the layers, parts, 3D view and the Base properties of the project', async () => {
    const { container } = renderEditor();
    await ready();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('Desert');
    expect(screen.getByText('Tiger II (H)')).toBeInTheDocument();
    const layers = screen.getByRole('region', { name: 'Layers' });
    expect(within(layers).getByRole('button', { name: 'Protected areas', pressed: false })).toBeInTheDocument();
    expect(within(layers).getByRole('button', { name: 'Base', pressed: true })).toBeInTheDocument();
    const parts = screen.getByRole('region', { name: 'Parts' });
    expect(within(parts).getAllByRole('switch')).toHaveLength(4);
    expect(within(parts).getByRole('switch', { name: 'Paint Body' })).toBeChecked();
    expect(within(parts).getByText('High quality body (4096)')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Fill' })).toBeInTheDocument();
    // The Baker got the new project's Base and every enabled slot.
    const [layersArg, enabled] = engine.baker.setLayers.mock.calls.at(-1)!;
    expect((layersArg as BaseLayer[])[0]!.kind).toBe('base');
    expect(enabled).toEqual(SLOTS);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('autosaves Base edits; undo and redo (buttons and keys) walk the history', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    const base = () => useAtelierEditor.getState().layers[0] as BaseLayer;
    expect(base().mode).toBe('camo');
    expect(base().colors).toHaveLength(2);
    await waitFor(() => expect((stored.layers[0] as BaseLayer).mode).toBe('camo'), { timeout: 3000 });
    expect(await screen.findByText('Saved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(base().mode).toBe('solid');
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(base().mode).toBe('camo');
    await user.click(screen.getByRole('button', { name: 'Shuffle' }));
    const seed = base().seed;
    expect(seed).not.toBe(1);
    await user.keyboard('{Control>}z{/Control}');
    expect(base().seed).toBe(1);
    await user.keyboard('{Control>}y{/Control}');
    expect(base().seed).toBe(seed);
  });

  it('switches the Template comparison and the parts the bake paints', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Template' }));
    expect(engine.baker.setShowTemplate).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('switch', { name: 'Paint Gun' }));
    expect(engine.baker.setLayers.mock.calls.at(-1)![1]).toEqual(SLOTS.slice(0, 2));
    expect(useAtelierEditor.getState().project?.slots[2]).toEqual({ texture: SLOTS[2], enabled: false });
  });

  it('paints a protected area with the brush, one undo step per stroke', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Protected areas' }));
    expect(screen.getByRole('radiogroup', { name: 'Tool' })).toBeInTheDocument();
    const view = screen.getByRole('application', { name: /3D view of/ });
    fireEvent.pointerDown(view, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(view, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    const mask = maskOf(useAtelierEditor.getState().layers)!;
    expect(mask.strokes).toHaveLength(1);
    expect(mask.strokes[0]!).toMatchObject({ erase: false, part: 'all', dir: [-1, 0, 0], points: [[0.5, 0.1, 0.1]] });
    expect(engine.baker.stampStroke).toHaveBeenCalledWith('all', mask.strokes[0], 0);
    // The Protected areas row stays selected (the first stroke created the layer).
    expect(screen.getByRole('button', { name: 'Protected areas', pressed: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(maskOf(useAtelierEditor.getState().layers)).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Protected areas', pressed: true })).toBeInTheDocument();
  });

  it('turns the brush off while the protected areas are hidden', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Protected areas' }));
    const view = screen.getByRole('application', { name: /3D view of/ });
    fireEvent.pointerDown(view, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(view, { button: 0, pointerId: 1 });
    await user.click(screen.getByRole('button', { name: 'Hide Protected areas' }));
    expect(screen.getByText('Protected areas are hidden, so the brush is off.')).toBeInTheDocument();
    fireEvent.pointerDown(view, { button: 0, clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(view, { button: 0, pointerId: 1 });
    expect(maskOf(useAtelierEditor.getState().layers)!.strokes).toHaveLength(1);
    expect(engine.scene.orbitBy).not.toHaveBeenCalled();
  });

  it('applies: saves, bakes each slot, sends it, commits, records the skin and thumbnail, toasts', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(toastTexts()).toContain('Skin installed in the game. Select it again in the hangar to see the changes.'), { timeout: 3000 });
    // The thumbnail goes before the commit: Rust copies it into the skin as preview.png.
    expect(order()).toEqual(['atelier_apply_begin', 'atelier_apply_texture', 'atelier_apply_texture', 'atelier_apply_texture', 'atelier_project_thumb', 'atelier_apply_commit']);
    // Saved before the apply began.
    const save = backend.call.mock.invocationCallOrder[backend.call.mock.calls.findIndex(([c]) => c === 'atelier_project_save')]!;
    const beginAt = backend.call.mock.invocationCallOrder[backend.call.mock.calls.findIndex(([c]) => c === 'atelier_apply_begin')]!;
    expect(save).toBeLessThan(beginAt);
    expect(calls('atelier_apply_begin')).toEqual([{ projectId: 'p1', enabled: SLOTS }]);
    expect(backend.callRaw.mock.calls.filter(([c]) => c === 'atelier_apply_texture').map(([, , h]) => h)).toEqual(
      SLOTS.map((slot) => ({ 'x-apply-id': 'a1', 'x-slot': slot, 'x-width': '256', 'x-height': '256' })),
    );
    expect(engine.baker.bakeForExport.mock.calls).toEqual(SLOTS.map((s) => [s, false]));
    // Full-size decal pictures around the bakes.
    expect(engine.baker.prepareExport).toHaveBeenCalledTimes(1);
    expect(engine.baker.prepareExport.mock.invocationCallOrder[0]!).toBeLessThan(engine.baker.bakeForExport.mock.invocationCallOrder[0]!);
    expect(engine.baker.endExport).toHaveBeenCalledTimes(1);
    expect(useAtelierEditor.getState().project?.installedSkinId).toBe('h_new');
    expect(engine.baker.upgrade).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Apply to game' })).toBeEnabled();
  });

  it('shows the steps while applying, with Rust’s progress in the second half', async () => {
    const user = userEvent.setup();
    let release!: (v: unknown) => void;
    commit = () => new Promise((r) => (release = r));
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(calls('atelier_apply_commit')).toHaveLength(1), { timeout: 3000 });
    act(() => backend.progress.forEach((h) => h({ applyId: 'a1', step: 'install', pct: 90 })));
    const bar = screen.getByRole('progressbar', { name: 'Applying to the game' });
    expect(bar).toHaveAttribute('aria-valuenow', '95');
    expect(bar).toHaveAttribute('aria-valuetext', 'Installing');
    // The same button, doing nothing while the apply runs (focus stays on it).
    const button = screen.getByRole('button', { name: /Installing/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // The editor is locked: panels and view inert, undo ignored.
    expect(screen.getByRole('application', { name: /3D view of/ }).closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveAttribute('readonly');
    await act(async () => release({ skin: SKIN }));
    expect(await screen.findByRole('button', { name: 'Apply to game' })).toBe(button);
    expect(button.closest('[inert]')).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('a replace offers Undo, which restores the previous version; a downscaled bake says so', async () => {
    const user = userEvent.setup();
    downscaleGun = true;
    commit = async () => ({ skin: { ...SKIN, id: 'h_old' }, backupId: 'b7' });
    renderEditor(project({ installedSkinId: 'h_old' }));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(toastTexts()).toContain('Skin updated in the game. Select it again in the hangar to see the changes.'), { timeout: 3000 });
    expect(toastTexts()).toContain('Your graphics card can’t paint this size: the texture was saved at 2048.');
    // The toast's Undo (the top bar has one for the editor's history too; the toasts come after it).
    await user.click(screen.getAllByRole('button', { name: 'Undo' }).at(-1)!);
    await waitFor(() => expect(calls('undo_replace')).toEqual([{ skinId: 'h_old', backupId: 'b7' }]));
  });

  it('an error cancels the apply and says what went wrong', async () => {
    const user = userEvent.setup();
    texture = () => Promise.reject({ code: 'invalidInput', message: 'A painted texture has the wrong size' });
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(calls('atelier_apply_cancel')).toEqual([{ applyId: 'a1' }]), { timeout: 3000 });
    expect(calls('atelier_apply_commit')).toEqual([]);
    await waitFor(() => expect(toastTexts()).toHaveLength(1));
    expect(useAtelierEditor.getState().project?.installedSkinId).toBeUndefined();
  });

  it('leaving the editor during an apply cancels it', async () => {
    const user = userEvent.setup();
    let release!: (v: unknown) => void;
    texture = () => new Promise((r) => (release = r));
    const { unmount } = renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(backend.callRaw).toHaveBeenCalledWith('atelier_apply_texture', expect.anything(), expect.anything()), { timeout: 3000 });
    act(() => useAtelierUi.getState().close());
    unmount();
    expect(calls('atelier_apply_cancel')).toEqual([{ applyId: 'a1' }]);
    expect(toastTexts()).toContain('Apply cancelled: the skin in the game is unchanged.');
    await act(async () => release(null));
    expect(calls('atelier_apply_commit')).toEqual([]);
    // Closing the project empties the editor.
    expect(useAtelierEditor.getState().project).toBeNull();
  });

  it('renames the project from the top bar', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    const name = screen.getByRole('textbox', { name: 'Project name' });
    await user.clear(name);
    await user.type(name, 'Winter{Enter}');
    expect(useAtelierEditor.getState().project?.name).toBe('Winter');
    await user.clear(name);
    await user.type(name, '   {Enter}');
    expect(name).toHaveValue('Winter');
  });
  it('does nothing when the project can’t be saved first', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    backend.call.mockImplementation(async (cmd, args) =>
      cmd === 'atelier_project_save' ? Promise.reject({ code: 'io', message: 'Could not save the Atelier project' }) : answer(cmd, args),
    );
    // Something to save (the Base change), so the flush tries and fails.
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(toastTexts()).toContain('The project couldn’t be saved, so nothing was applied.'), { timeout: 3000 });
    expect(calls('atelier_apply_begin')).toEqual([]);
    expect(engine.baker.bakeForExport).not.toHaveBeenCalled();
  });

  it('a failed begin toasts the reason and has nothing to cancel', async () => {
    const user = userEvent.setup();
    begin = () => Promise.reject({ code: 'invalidInput', message: 'Turn on at least one part to apply' });
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(toastTexts()).toHaveLength(1), { timeout: 3000 });
    expect(calls('atelier_apply_cancel')).toEqual([]);
    expect(engine.baker.bakeForExport).not.toHaveBeenCalled();
  });

  it('a bake that fails mid-way (the view lost) cancels the apply and says the view stopped', async () => {
    const user = userEvent.setup();
    engine.baker.bakeForExport.mockImplementation((slot: string) => {
      if (slot.endsWith('_turret_c')) throw new Error('Baker: the WebGL context is lost');
      return { rgba: new Uint8Array(MOCK_TEXTURE_SIZE * MOCK_TEXTURE_SIZE * 4), w: MOCK_TEXTURE_SIZE, h: MOCK_TEXTURE_SIZE, downscaled: false };
    });
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(calls('atelier_apply_cancel')).toEqual([{ applyId: 'a1' }]), { timeout: 3000 });
    expect(backend.callRaw.mock.calls.filter(([c]) => c === 'atelier_apply_texture')).toHaveLength(1);
    expect(calls('atelier_apply_commit')).toEqual([]);
    expect(toastTexts()).toContain('The 3D view stopped working (the graphics driver may have restarted). Nothing was applied: try again.');
  });

  it('a failed commit toasts the reason without cancelling (the backend already ended the apply)', async () => {
    const user = userEvent.setup();
    commit = () => Promise.reject({ code: 'io', message: "The skin couldn't be applied to the game" });
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(calls('atelier_apply_commit')).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(toastTexts()).toHaveLength(1));
    expect(calls('atelier_apply_cancel')).toEqual([]);
    expect(useAtelierEditor.getState().project?.installedSkinId).toBeUndefined();
    expect(await screen.findByRole('button', { name: 'Apply to game' })).toBeEnabled();
  });

  it('a double click applies once', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.dblClick(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(calls('atelier_apply_commit')).toHaveLength(1), { timeout: 3000 });
    expect(calls('atelier_apply_begin')).toHaveLength(1);
  });

  it('bakes the saved layers, with the Baker given them again before each slot', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(calls('atelier_apply_commit')).toHaveLength(1), { timeout: 3000 });
    const saved = stored.layers[0] as BaseLayer;
    expect(saved.mode).toBe('camo');
    const bakes = engine.baker.bakeForExport.mock.invocationCallOrder;
    const sets = engine.baker.setLayers.mock.invocationCallOrder;
    for (const at of bakes) {
      const before = engine.baker.setLayers.mock.calls[sets.filter((n) => n < at).length - 1]!;
      expect((before[0] as BaseLayer[])[0]).toMatchObject({ mode: 'camo', colors: saved.colors });
    }
  });

  it('Ctrl+Z goes to the toast Undo when the editor has nothing to undo', async () => {
    renderEditor(project({ layers: [{ id: 'b', kind: 'base', name: '', visible: true, mode: 'solid', colors: ['#56603f'], scale: 1, seed: 1 }] }));
    await ready();
    const undone = vi.fn();
    act(() => {
      useToasts.getState().push({ message: 'Deleted 1 skin', onUndo: undone });
    });
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl+Z on a slider still undoes the editor (sliders, colour wells and checkboxes aren’t text)', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    const slider = screen.getByRole('slider', { name: 'Pattern size' });
    slider.focus();
    await user.keyboard('{Control>}z{/Control}');
    expect((useAtelierEditor.getState().layers[0] as BaseLayer).mode).toBe('solid');
  });

  it('Wear on the Base and on a decal: a slider each, one undo step per drag, 0 leaves no field', async () => {
    const user = userEvent.setup();
    decalAnswers();
    renderEditor();
    await ready();
    const wear = screen.getByRole('slider', { name: 'Wear' });
    expect(wear).toHaveAttribute('aria-valuetext', '0%');
    expect(screen.getByText('Paint chips off along the edges first, showing bare metal. More wear reaches the flat surfaces too.')).toBeInTheDocument();
    fireEvent.change(wear, { target: { value: '0.4' } });
    fireEvent.change(wear, { target: { value: '0.6' } });
    fireEvent.pointerUp(wear);
    expect((useAtelierEditor.getState().layers[0] as BaseLayer).wear).toBe(0.6);
    expect(useAtelierEditor.getState().past).toHaveLength(1);
    fireEvent.change(wear, { target: { value: '0' } });
    expect(useAtelierEditor.getState().layers[0]).not.toHaveProperty('wear');

    const id = await placeImage(user);
    const decalWear = screen.getByRole('slider', { name: 'Wear' });
    expect(screen.getByText('Chips off along the edges first, showing the paint underneath.')).toBeInTheDocument();
    fireEvent.change(decalWear, { target: { value: '0.35' } });
    expect(decalLayer(id).wear).toBe(0.35);
  });

  it('lists the vehicle’s own parts first and the shared ones under their heading, with friendly names', async () => {
    const model = encodeMockModel(TIGER);
    stored = project();
    backend.call.mockImplementation(async (cmd, args) => {
      if (cmd === 'atelier_model') return withSharedSlots(model);
      if (cmd === 'atelier_template_texture') return Promise.reject({ code: 'notFound', message: "A texture of this vehicle isn't in the game's files" });
      return answer(cmd, args);
    });
    renderEditor(
      project({
        slots: [
          { texture: 'mg_m2hb_c', enabled: false },
          { texture: SLOTS[2]!, enabled: true },
          { texture: 'track_t48_c', enabled: false },
          { texture: SLOTS[0]!, enabled: true },
          { texture: SLOTS[1]!, enabled: true },
        ],
      }),
    );
    await screen.findByRole('application', { name: /3D view of/ });
    const parts = screen.getByRole('region', { name: 'Parts' });
    expect(within(parts).getAllByRole('switch').map((s) => s.getAttribute('aria-label') ?? '')).toEqual([
      'Paint Body',
      'Paint Turret',
      'Paint Gun',
      'Paint Machine gun m2hb',
      'Paint Track t48',
      '',
    ]);
    expect(within(parts).getByRole('heading', { name: 'Shared parts' })).toBeInTheDocument();
  });

  it('turns High quality off (with the reason) while the body isn’t painted', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    const hq = screen.getByRole('switch', { name: 'High quality body (4096)' });
    expect(hq).toBeEnabled();
    await user.click(screen.getByRole('switch', { name: 'Paint Body' }));
    expect(hq).toBeDisabled();
    expect(screen.getByText('Turn on the body to use high quality.')).toBeInTheDocument();
  });

  it('adds a camo colour clearly different from the others', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    await user.click(screen.getByRole('button', { name: 'Add a colour' }));
    const colors = (useAtelierEditor.getState().layers[0] as BaseLayer).colors;
    expect(colors).toHaveLength(3);
    expect(new Set(colors).size).toBe(3);
  });

  it('camo styles: tiles as a radio group, the sliders of each style, one undo step per style', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await ready();
    expect(screen.queryByRole('radiogroup', { name: 'Style' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    const styles = screen.getByRole('radiogroup', { name: 'Style' });
    const tiles = within(styles).getAllByRole('radio');
    expect(tiles.map((t) => t.textContent)).toEqual(['Organic', 'Digital', 'Hexagons', 'Splinter', 'Triangles', 'Stripes']);
    expect(within(styles).getByRole('radio', { name: 'Organic' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('slider', { name: 'Cell size' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Stripe angle' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Softness' })).toBeInTheDocument();

    const steps = S().past.length;
    await user.click(within(styles).getByRole('radio', { name: 'Hexagons' }));
    expect((S().layers[0] as BaseLayer).pattern).toBe('hex');
    expect(S().past).toHaveLength(steps + 1);
    expect(screen.getByRole('slider', { name: 'Cell size' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Stripe angle' })).not.toBeInTheDocument();
    // Arrow keys move and select: Hexagons → Splinter, End → Stripes.
    await user.keyboard('{ArrowRight}');
    expect((S().layers[0] as BaseLayer).pattern).toBe('splinter');
    expect(within(styles).getByRole('radio', { name: 'Splinter' })).toHaveFocus();
    await user.keyboard('{End}');
    expect((S().layers[0] as BaseLayer).pattern).toBe('stripes');
    expect(screen.getByRole('slider', { name: 'Stripe angle' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Cell size' })).not.toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(S().layers[0]).not.toHaveProperty('pattern');

    const softness = screen.getByRole('slider', { name: 'Softness' });
    fireEvent.change(softness, { target: { value: '0.3' } });
    fireEvent.change(softness, { target: { value: '0.5' } });
    fireEvent.pointerUp(softness);
    expect((S().layers[0] as BaseLayer).softness).toBe(0.5);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('camo shares: a divider per colour pair, keys move it 1 %, Equal and new colours keep them consistent', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    const dividers = () => screen.getAllByRole('slider', { name: /^Between colour/ });
    expect(dividers()).toHaveLength(1);
    expect(dividers()[0]).toHaveAttribute('aria-valuetext', 'Colour 1: 50%, colour 2: 50%');
    expect(screen.queryByRole('button', { name: 'Make shares equal' })).not.toBeInTheDocument();
    const steps = S().past.length;
    dividers()[0]!.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect((S().layers[0] as BaseLayer).weights).toEqual([0.53, 0.47]);
    // keyup ends each press: three presses, three steps.
    expect(S().past.length).toBe(steps + 3);
    await user.keyboard('{PageDown}{PageDown}{PageDown}{PageDown}{PageDown}{PageDown}');
    expect((S().layers[0] as BaseLayer).weights).toEqual([0.05, 0.95]);

    await user.click(screen.getByRole('button', { name: 'Add a colour' }));
    const w = (S().layers[0] as BaseLayer).weights!;
    expect(w).toHaveLength(3);
    for (const v of w) expect(v).toBeGreaterThanOrEqual(0.05);
    expect(dividers()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove colour 3' }));
    expect((S().layers[0] as BaseLayer).weights).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Make shares equal' }));
    expect(S().layers[0]).not.toHaveProperty('weights');
  });

  it('remembers the camera of each project for the session', async () => {
    // A project no other test opened (the cameras are kept for the session).
    const first = renderEditor(project({ id: 'p-camera' }));
    await ready();
    expect(engine.scene.setView).not.toHaveBeenCalled();
    act(() => useAtelierUi.getState().close());
    first.unmount();
    engine = stubEngine();
    renderEditor(project({ id: 'p-camera' }));
    await ready();
    expect(engine.scene.setView).toHaveBeenCalledWith({ target: [0, 0, 0], radius: 4, theta: 0.5, phi: 1 });
  });

  it('a thumbnail shows the paint even in Template mode, and none is taken with the context lost', async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Template' }));
    engine.baker.setShowTemplate.mockClear();
    await user.click(screen.getByRole('button', { name: 'Apply to game' }));
    await waitFor(() => expect(engine.scene.thumbnailPng).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(engine.baker.setShowTemplate.mock.calls).toEqual([[false], [true]]);
    expect(engine.baker.setShowTemplate.mock.invocationCallOrder[0]!).toBeLessThan(engine.scene.thumbnailPng.mock.invocationCallOrder[0]!);
    // Leaving with a change and a lost context: no thumbnail.
    await user.click(screen.getByRole('radio', { name: 'Paint' }));
    await user.click(screen.getByRole('radio', { name: 'Camo' }));
    engine.scene.contextLost.mockReturnValue(true);
    act(() => useAtelierUi.getState().close());
    first.unmount();
    expect(engine.scene.thumbnailPng).toHaveBeenCalledTimes(1);
  });
});

// ── Images, text, mirror, background removal ───────────────────────────────

const IMPORTED = { id: 'img-1', width: 400, height: 200 };
const FONTS = [
  { family: 'Arial', style: 'Regular', file: 'arial.ttf' },
  { family: 'Arial', style: 'Bold', file: 'arialbd.ttf' },
  { family: 'Verdana', style: 'Regular', file: 'verdana.ttf' },
];
const NOT_READY: CutoutStatus = { runtime: false, model: false, bytes: 0, downloadBytes: 236_069_933, pendingRemoval: false };
const READY: CutoutStatus = { runtime: true, model: true, bytes: 236_069_933, downloadBytes: 0, pendingRemoval: false };

const S = () => useAtelierEditor.getState();
const decalLayer = (id: string) => S().layers.find((l) => l.id === id) as DecalLayer;
const view = () => screen.getByRole('application', { name: /3D view of/ });
const emit = (name: string, payload: unknown) => act(() => backend.events.filter((e) => e.name === name).forEach((e) => e.handler(payload)));

function decalAnswers() {
  extra = {
    atelier_import_image: () => IMPORTED,
    atelier_fonts: () => FONTS,
    atelier_font_file: () => Promise.reject({ code: 'notFound', message: 'no font' }),
    atelier_asset: () => encodeAsset(mockPicture(400, 200)),
  };
}

/** Add image → the picture waits → a click on the view places it; returns the new layer's id. */
async function placeImage(user: ReturnType<typeof userEvent.setup>, at = { x: 50, y: 20 }): Promise<string> {
  await user.click(screen.getByRole('button', { name: 'Add image' }));
  await waitFor(() => expect(S().pending).not.toBeNull());
  fireEvent.pointerDown(view(), { button: 0, clientX: at.x, clientY: at.y, pointerId: 1 });
  fireEvent.pointerUp(view(), { button: 0, clientX: at.x, clientY: at.y, pointerId: 1 });
  await waitFor(() => expect(S().pending).toBeNull());
  return S().selectedId!;
}

describe('Atelier editor · images and text', () => {
  beforeEach(() => {
    resetDecalUi();
    // A cutout left running by an earlier test keeps the busy flag (it outlives projects).
    setCutoutBusy(false);
    decalAnswers();
  });

  it('opens a project after earlier saves, cleaning unused pictures before reading it fresh', async () => {
    renderEditor();
    await ready();
    const open = backend.call.mock.calls.findIndex(([c]) => c === 'atelier_project_open');
    const get = backend.call.mock.calls.findIndex(([c]) => c === 'atelier_project_get');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(backend.call.mock.invocationCallOrder[open]!).toBeLessThan(backend.call.mock.invocationCallOrder[get]!);
    expect(calls('atelier_project_open')).toEqual([{ projectId: 'p1' }]);
  });

  it('adds a picture: it waits for its click (announced), lands on the model, one undo step; Escape cancels', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add image' }));
    expect(calls('atelier_import_image')).toEqual([{ projectId: 'p1', path: 'C:\\Pictures\\logo.png' }]);
    await waitFor(() => expect(S().pending).toMatchObject({ kind: 'image', assetId: 'img-1', aspect: 2, name: 'logo' }));
    expect(screen.getByText(/Click on the vehicle to place the new layer/)).toBeInTheDocument();
    expect(view()).toHaveFocus();
    const past = S().past.length;
    // A drag turns the view; it doesn't place.
    fireEvent.pointerDown(view(), { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(view(), { button: 0, clientX: 80, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(view(), { button: 0, clientX: 80, clientY: 20, pointerId: 1 });
    expect(S().pending).not.toBeNull();
    expect(engine.scene.orbitBy).toHaveBeenCalled();
    fireEvent.pointerDown(view(), { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(view(), { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    const layer = S().layers.find((l) => l.kind === 'image') as ImageLayer;
    expect(layer).toMatchObject({ assetId: 'img-1', name: 'logo' });
    expect(layer.decal!.center).toEqual([0.5, 0.2, 0.5]);
    expect(layer.decal!.normal).toEqual([1, 0, 0]);
    expect(layer.decal!.width / layer.decal!.height).toBeCloseTo(2);
    expect(S().past).toHaveLength(past + 1);
    expect(S().selectedId).toBe(layer.id);
    expect(screen.getByText('Placed. Drag it or use the arrow keys to adjust it.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Layers' })).getByRole('button', { name: 'logo', pressed: true })).toBeInTheDocument();
    expect(engine.baker.decalTouchesSharedTexels).toHaveBeenCalled();
    expect(await seriousViolations(container)).toEqual([]);

    // Enter places at the middle of the view (200 × 100 → the point under (100, 50)).
    await user.click(screen.getByRole('button', { name: 'Add image' }));
    await waitFor(() => expect(S().pending).not.toBeNull());
    await user.keyboard('{Enter}');
    expect(decalLayer(S().selectedId!).decal!.center).toEqual([0.5, 0.5, 1]);

    // Escape drops a waiting layer, nothing to undo.
    await user.click(screen.getByRole('button', { name: 'Add image' }));
    await waitFor(() => expect(S().pending).not.toBeNull());
    const before = S().past.length;
    await user.keyboard('{Escape}');
    expect(S().pending).toBeNull();
    expect(S().past).toHaveLength(before);
    await user.keyboard('{Control>}z{/Control}');
    expect(S().layers.filter((l) => l.kind === 'image')).toHaveLength(1);
  });

  it('moves, turns and scales the selected decal from the keyboard, one undo step each; Alt+arrows turn the view', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    const id = await placeImage(user);
    const start = decalLayer(id).decal!;
    view().focus();
    await user.keyboard('{ArrowRight}');
    expect(decalLayer(id).decal!.center[2]).toBeGreaterThan(start.center[2]);
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(decalLayer(id).decal!.up[2]).toBeCloseTo(Math.sin((5 * Math.PI) / 180));
    await user.keyboard('+');
    expect(decalLayer(id).decal!.width).toBeCloseTo(start.width * 1.05);
    expect(engine.scene.orbitBy).not.toHaveBeenCalled();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(engine.scene.orbitBy).toHaveBeenCalledWith(-24, 0);
    await user.keyboard('{Control>}z{/Control}');
    expect(decalLayer(id).decal!.width).toBeCloseTo(start.width);
    expect(decalLayer(id).decal!.up[2]).toBeCloseTo(Math.sin((5 * Math.PI) / 180));
    await user.keyboard('{Control>}z{/Control}');
    expect(decalLayer(id).decal!.up).toEqual(start.up);
    await user.keyboard('{Control>}z{/Control}');
    expect(decalLayer(id).decal!.center).toEqual(start.center);
  });

  it('drags the decal along the surface with its gizmo, one undo step per drag', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await ready();
    const id = await placeImage(user);
    const past = S().past.length;
    const body = container.querySelector('[data-gizmo="body"]')!;
    fireEvent.pointerDown(body, { button: 0, clientX: 50, clientY: 20, pointerId: 2 });
    fireEvent.pointerMove(body, { clientX: 60, clientY: 30, pointerId: 2 });
    fireEvent.pointerMove(body, { clientX: 70, clientY: 30, pointerId: 2 });
    fireEvent.pointerUp(body, { clientX: 70, clientY: 30, pointerId: 2 });
    expect(decalLayer(id).decal!.center).toEqual([0.5, 0.3, 0.7]);
    expect(S().past).toHaveLength(past + 1);
    const rotate = container.querySelector('[data-gizmo="rotate"]');
    expect(rotate).not.toBeNull();
    expect(container.querySelectorAll('[data-gizmo^="corner"]')).toHaveLength(4);
  });

  it('snaps a dragged decal onto the centre line with a guide; Ctrl or the magnet button frees it', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await ready();
    const id = await placeImage(user);
    const body = () => container.querySelector('[data-gizmo="body"]')!;
    // 1 px is 1 cm on the stub's view: 5 px from the centre line (z = 0) is within reach.
    fireEvent.pointerDown(body(), { button: 0, clientX: 50, clientY: 20, pointerId: 2 });
    fireEvent.pointerMove(body(), { clientX: 5, clientY: 30, pointerId: 2 });
    expect(decalLayer(id).decal!.center).toEqual([0.5, 0.3, 0]);
    expect(container.querySelector('[data-snap-guide="centre"]')).not.toBeNull();
    fireEvent.pointerMove(body(), { clientX: 5, clientY: 30, pointerId: 2, ctrlKey: true });
    expect(decalLayer(id).decal!.center).toEqual([0.5, 0.3, 0.05]);
    expect(container.querySelector('[data-snap-guide]')).toBeNull();
    fireEvent.pointerUp(body(), { clientX: 5, clientY: 30, pointerId: 2 });

    const magnet = screen.getByRole('button', { name: 'Snap' });
    expect(magnet).toHaveAttribute('aria-pressed', 'true');
    await user.click(magnet);
    expect(magnet).toHaveAttribute('aria-pressed', 'false');
    fireEvent.pointerDown(body(), { button: 0, clientX: 5, clientY: 30, pointerId: 3 });
    fireEvent.pointerMove(body(), { clientX: 4, clientY: 30, pointerId: 3 });
    expect(decalLayer(id).decal!.center[2]).toBeCloseTo(0.04);
    fireEvent.pointerUp(body(), { clientX: 4, clientY: 30, pointerId: 3 });
    expect(container.querySelector('[data-snap-guide]')).toBeNull();
  });

  it('offers Mirror off where both sides share the texture, and turns it on elsewhere', async () => {
    const user = userEvent.setup();
    engine.baker.decalTouchesSharedTexels.mockResolvedValue(true);
    renderEditor();
    await ready();
    const id = await placeImage(user);
    const mirror = await screen.findByRole('switch', { name: 'Mirror to the other side' });
    await waitFor(() => expect(mirror).toBeDisabled());
    expect(screen.getByText(/share the same texture/)).toBeInTheDocument();
    engine.baker.decalTouchesSharedTexels.mockResolvedValue(false);
    // A move ends with a new check: here nothing is shared.
    view().focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(mirror).toBeEnabled());
    await user.click(mirror);
    await waitFor(() => expect(decalLayer(id).decal!.mirror).toBe(true));
    expect(mirror).toHaveAttribute('aria-checked', 'true');
  });

  it('duplicates, deletes (toast Undo) and reorders layers, each undoable', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    const a = await placeImage(user);
    const layers = within(screen.getByRole('region', { name: 'Layers' }));
    await user.click(layers.getByRole('button', { name: 'logo actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    const copy = S().selectedId!;
    expect(copy).not.toBe(a);
    expect(S().layers.map((l) => l.id).slice(1)).toEqual([a, copy]);
    // Alt+↓ on the copy's row moves it under the original.
    layers.getAllByRole('button', { name: 'logo' })[0]!.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(S().layers.map((l) => l.id).slice(1)).toEqual([copy, a]);
    await user.keyboard('{Control>}z{/Control}');
    expect(S().layers.map((l) => l.id).slice(1)).toEqual([a, copy]);
    // Delete: a toast offers Undo.
    await user.click(layers.getAllByRole('button', { name: 'logo actions' })[0]!);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(S().layers.map((l) => l.id)).not.toContain(copy);
    expect(toastTexts()).toContain('Deleted layer “logo”');
    const toasts = screen.getByRole('region', { name: /notifications/i });
    await user.click(within(toasts).getByRole('button', { name: 'Undo' }));
    expect(S().layers.map((l) => l.id).slice(1)).toEqual([a, copy]);
  });

  it('adds text: placed with Enter; typing reaches the layer (and the bake) after a short pause', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add text' }));
    expect(S().pending).toMatchObject({ kind: 'text', text: 'Text', font: { family: 'Arial', style: 'Regular' } });
    await user.keyboard('{Enter}');
    const id = S().selectedId!;
    expect(decalLayer(id).kind).toBe('text');
    const field = await screen.findByRole('textbox', { name: 'Text' });
    await user.type(field, ' A');
    // Not yet: the text reaches the layer 150 ms after the last key.
    expect((decalLayer(id) as TextLayer).text).toBe('Text');
    await waitFor(() => expect((decalLayer(id) as TextLayer).text).toBe('Text A'));
    const baked = engine.baker.setLayers.mock.calls.at(-1)![0] as Layer[];
    expect(baked.find((l) => l.id === id)).toMatchObject({ text: 'Text A' });
    // The font pickers list the installed fonts.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Font' }), 'Verdana');
    expect((decalLayer(id) as TextLayer).font).toEqual({ family: 'Verdana', style: 'Regular' });
  });

  it('places instead of painting while a layer waits, even with Protected areas selected', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Protected areas' }));
    await user.click(screen.getByRole('button', { name: 'Add image' }));
    await waitFor(() => expect(S().pending).not.toBeNull());
    fireEvent.pointerDown(view(), { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(view(), { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    expect(maskOf(S().layers)).toBeUndefined();
    expect(S().layers.some((l) => l.kind === 'image')).toBe(true);
  });

  it('a held-key gesture ends only when its own key goes up', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await placeImage(user);
    view().focus();
    await user.keyboard('{Shift>}{ArrowRight>}');
    expect(S().mergeKey).not.toBeNull();
    // Shift goes up first: the turn goes on.
    await user.keyboard('{/Shift}');
    expect(S().mergeKey).not.toBeNull();
    await user.keyboard('{/ArrowRight}');
    expect(S().mergeKey).toBeNull();
  });

  it('slides only on its own part group, and the outline dims when the decal faces away', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await ready();
    const id = await placeImage(user);
    act(() => S().setDecal(id, { part: 'turret' }));
    const body = container.querySelector('[data-gizmo="body"]')!;
    fireEvent.pointerDown(body, { button: 0, clientX: 50, clientY: 20, pointerId: 2 });
    fireEvent.pointerMove(body, { clientX: 60, clientY: 20, pointerId: 2 });
    fireEvent.pointerUp(body, { clientX: 60, clientY: 20, pointerId: 2 });
    expect(engine.scene.raycast).toHaveBeenLastCalledWith(60, 20, 'turret');
    expect(container.querySelector('svg[data-facing]')).toHaveAttribute('data-facing', 'toward');
    engine.scene.viewDirection.mockReturnValue([1, 0, 0]);
    act(() => S().setDecal(id, { depth: 0.05 }));
    expect(container.querySelector('svg[data-facing]')).toHaveAttribute('data-facing', 'away');
  });

  it('keeps the text on one line, counted like the layer stores it', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add text' }));
    await user.keyboard('{Enter}');
    const field = await screen.findByRole('textbox', { name: 'Text' });
    await user.type(field, '{Enter}B');
    expect(field).toHaveValue('TextB');
    expect(screen.getByText('5/200')).toBeInTheDocument();
  });

  it('the deleted-layer toast does nothing once another project is open', async () => {
    const user = userEvent.setup();
    renderEditor();
    await ready();
    await placeImage(user);
    const layers = within(screen.getByRole('region', { name: 'Layers' }));
    await user.click(layers.getByRole('button', { name: 'logo actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    act(() => S().load(project({ id: 'p2', name: 'Other' })));
    const before = S().layers;
    const toasts = screen.getByRole('region', { name: /notifications/i });
    await user.click(within(toasts).getByRole('button', { name: 'Undo' }));
    expect(S().layers).toBe(before);
    expect(S().project?.id).toBe('p2');
  });

  it('shows the cutout steps: a moving stripe until the first one, then a quarter per step', async () => {
    const user = userEvent.setup();
    extra.atelier_cutout_status = () => READY;
    extra.atelier_cutout = () => new Promise(() => {});
    renderEditor();
    await ready();
    await placeImage(user);
    await user.click(screen.getByRole('button', { name: 'Remove background' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove background' });
    await waitFor(() => expect(calls('atelier_cutout')).toHaveLength(1));
    const bar = within(dialog).getByRole('progressbar', { name: 'Removing the background' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    emit('atelier://cutout-progress', { step: 'load' });
    expect(within(dialog).getByRole('progressbar', { name: 'Removing the background' })).toHaveAttribute('aria-valuenow', '25');
    expect(within(dialog).getByText('Loading the model…')).toBeInTheDocument();
  });

  it('a failed status read retries the read (never the download)', async () => {
    const user = userEvent.setup();
    let fail = true;
    extra.atelier_cutout_status = () => (fail ? Promise.reject({ code: 'io', message: 'File system error' }) : NOT_READY);
    renderEditor();
    await ready();
    await placeImage(user);
    await user.click(screen.getByRole('button', { name: 'Remove background' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove background' });
    fail = false;
    await user.click(await within(dialog).findByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('button', { name: /^Download/ })).toBeInTheDocument();
    expect(calls('atelier_cutout_download')).toHaveLength(0);
    expect(calls('atelier_cutout_status')).toHaveLength(2);
  });

  it('files gone at cutout time ask for them again; a download refused for a restart says so', async () => {
    const user = userEvent.setup();
    let status: CutoutStatus = READY;
    extra.atelier_cutout_status = () => status;
    extra.atelier_cutout = () => {
      status = NOT_READY;
      return Promise.reject({ code: 'notFound', message: 'Download the background-removal files first' });
    };
    extra.atelier_cutout_download = () => Promise.reject({ code: 'conflict', message: 'Restart Livery to finish removing the background-removal files' });
    renderEditor();
    await ready();
    await placeImage(user);
    await user.click(screen.getByRole('button', { name: 'Remove background' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove background' });
    await user.click(await within(dialog).findByRole('button', { name: /^Download/ }));
    expect(await within(dialog).findByText(/Restart Livery first/)).toBeInTheDocument();
  });

  it('removes a background: asks to download, shows progress, cuts out, refits the layer in one undo step', async () => {
    const user = userEvent.setup();
    let finishDownload!: (s: CutoutStatus) => void;
    let finishCutout!: (r: unknown) => void;
    extra.atelier_cutout_status = () => NOT_READY;
    extra.atelier_cutout_download = () => new Promise((r) => (finishDownload = r));
    extra.atelier_cutout = () => new Promise((r) => (finishCutout = r));
    renderEditor();
    await ready();
    const id = await placeImage(user);
    const before = decalLayer(id) as ImageLayer;
    await user.click(screen.getByRole('button', { name: 'Remove background' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove background' });
    expect(within(dialog).getByText(/two files that Livery downloads once/)).toBeInTheDocument();
    expect(await seriousViolations(dialog)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Download (225 MB)' }));
    expect(calls('atelier_cutout_download')).toHaveLength(1);
    emit('atelier://download-progress', { item: 'model', received: 88_000_000, total: 176_069_933 });
    expect(within(dialog).getByRole('progressbar', { name: 'isnet-anime model (rembg project)' })).toHaveAttribute('aria-valuenow', '50');
    await act(async () => finishDownload(READY));
    await waitFor(() => expect(calls('atelier_cutout')).toEqual([{ projectId: 'p1', assetId: 'img-1' }]));
    emit('atelier://cutout-progress', { step: 'run' });
    expect(within(dialog).getByText('Finding the subject…')).toBeInTheDocument();
    const past = S().past.length;
    await act(async () => finishCutout({ asset: { id: 'img-cut', width: 200, height: 100 }, crop: { x: 100, y: 50, w: 200, h: 100 } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const after = decalLayer(id) as ImageLayer;
    expect(after).toMatchObject({ assetId: 'img-cut', sourceAssetId: 'img-1', sourceOffset: { x: 100, y: 50, w: 200, h: 100 } });
    // The crop is centred: same place, half the size.
    expect(after.decal!.center).toEqual(before.decal!.center);
    expect(after.decal!.width).toBeCloseTo(before.decal!.width / 2);
    expect(S().past).toHaveLength(past + 1);
    expect(toastTexts()).toContain('Background removed. Ctrl+Z brings it back.');
  });

  it('a cancelled download ends quietly; a removal waiting for a restart says so', async () => {
    const user = userEvent.setup();
    let failDownload!: (e: unknown) => void;
    extra.atelier_cutout_status = () => NOT_READY;
    extra.atelier_cutout_download = () => new Promise((_, reject) => (failDownload = reject));
    extra.atelier_cutout_cancel = () => null;
    renderEditor();
    await ready();
    await placeImage(user);
    await user.click(screen.getByRole('button', { name: 'Remove background' }));
    await user.click(await screen.findByRole('button', { name: /^Download/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls('atelier_cutout_cancel')).toHaveLength(1);
    await act(async () => failDownload({ code: 'network', message: 'Download cancelled' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toastTexts()).toEqual([]);

    extra.atelier_cutout_status = () => ({ ...NOT_READY, pendingRemoval: true });
    await user.click(screen.getByRole('button', { name: 'Remove background' }));
    expect(await screen.findByText(/Restart Livery first/)).toBeInTheDocument();
    expect(calls('atelier_cutout_download')).toHaveLength(1);
  });

  it('refine edge asks before dropping brush strokes; a click outside does nothing then', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    renderEditor();
    await ready();
    await placeImage(user);
    await user.click(screen.getByRole('button', { name: 'Refine edge' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refine edge' });
    const canvas = await within(dialog).findByLabelText('The picture to refine');
    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 10, pointerId: 3 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerId: 3 });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByRole('dialog', { name: 'Refine edge' })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    const ask = await screen.findByRole('alertdialog', { name: 'Discard your changes to the edge?' });
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Refine edge' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Refine edge' }), { key: 'Escape' });
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Refine edge' })).toBeNull());
    expect(backend.callRaw.mock.calls.filter(([c]) => c === 'atelier_asset_put')).toHaveLength(0);
  });

  it('refine edge saves the brushed picture as a new asset, keeping where it came from (one undo step)', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    backend.callRaw.mockImplementation(async (cmd) => (cmd === 'atelier_asset_put' ? { id: 'img-refined', width: 400, height: 200 } : null));
    renderEditor();
    await ready();
    const id = await placeImage(user);
    await user.click(screen.getByRole('button', { name: 'Refine edge' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refine edge' });
    const canvas = await within(dialog).findByLabelText('The picture to refine');
    expect(await seriousViolations(dialog)).toEqual([]);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 240, clientY: 150, pointerId: 3 });
    fireEvent.pointerMove(canvas, { clientX: 250, clientY: 150, pointerId: 3 });
    fireEvent.pointerUp(canvas, { clientX: 250, clientY: 150, pointerId: 3 });
    const past = S().past.length;
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const put = backend.callRaw.mock.calls.find(([c]) => c === 'atelier_asset_put')!;
    expect(put[2]).toEqual({ 'x-project-id': 'p1', 'x-width': '400', 'x-height': '200' });
    // The brush erased alpha around (240, 150); RGB stays.
    const body = put[1];
    const at = (150 * 400 + 240) * 4;
    expect(body[at + 3]).toBeLessThan(255);
    expect(decalLayer(id)).toMatchObject({ assetId: 'img-refined', sourceAssetId: 'img-1', sourceOffset: { x: 0, y: 0, w: 400, h: 200 } });
    expect(S().past).toHaveLength(past + 1);
  });
});

/** The mock model with two shared slots (a machine gun and a track) added to its header, not painted by default. */
function withSharedSlots(buf: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buf);
  const len = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len)).trimEnd()) as { slots: unknown[] };
  header.slots.push(
    { texture: 'mg_m2hb_c', width: 64, height: 64, hq: true, paintableByDefault: false },
    { texture: 'track_t48_c', width: 64, height: 64, hq: true, paintableByDefault: false },
  );
  const json = new TextEncoder().encode(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const out = new Uint8Array(8 + padded + (buf.byteLength - 8 - len));
  out.set(new Uint8Array(buf, 0, 4), 0);
  new DataView(out.buffer).setUint32(4, padded, true);
  out.fill(0x20, 8, 8 + padded);
  out.set(json, 8);
  out.set(new Uint8Array(buf, 8 + len), 8 + padded);
  return out.buffer;
}

// ── Shapes, folders, merged objects, multi-select ──────────────────────────

describe('Atelier editor · shapes, folders and merged objects', () => {
  /** On the stub's view: centre (50, 30), 40 × 20 px (right is −z, so the right side is at x = 30). */
  const at = (y: number, z: number): Decal => ({ center: [0.5, y, z], normal: [1, 0, 0], up: [0, 1, 0], width: 0.4, height: 0.2, depth: 0.04, part: 'all', mirror: false });
  const piece = (id: string): Piece => {
    const { decal: _d, repeat: _r, ...rest } = newShapeLayer('rect', at(0, 0));
    return { ...rest, id, place: { x: 0, y: 0, w: 0.5, h: 1, angle: 0 } };
  };
  const shape: ShapeLayer = { ...newShapeLayer('star', at(0.3, 0.5)), id: 's' };
  const child: TextLayer = { ...newTextLayer('ACE', at(0.6, 0.2)), id: 'c' };
  const folder = { ...newFolder('Folder 1', [child]), id: 'f' };
  const merged: MergedLayer = { id: 'm', kind: 'merged', name: '', visible: true, decal: at(0.3, 0.9), opacity: 1, children: [piece('p'), piece('q')] };
  const layers = (): Layer[] => [{ ...newBaseLayer(), id: 'b' }, shape, folder, merged];

  beforeEach(() => {
    resetDecalUi();
    setCutoutBusy(false);
    decalAnswers();
  });

  it('opens a project with a shape, a folder and a merged object; a shape gets edge handles that stretch one axis', async () => {
    const { container } = renderEditor(project({ layers: layers() }));
    await ready();
    expect(engine.baker.setLayers).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'f' }), expect.objectContaining({ id: 'm' })]), expect.anything());
    act(() => S().select('s'));
    expect(container.querySelector('[data-gizmo="body"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-gizmo^="corner"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-gizmo^="edge"]')).toHaveLength(4);
    // The right side, dragged twice as far from the centre: twice as wide, as high as before, one undo step.
    const past = S().past.length;
    const edge = container.querySelector('[data-gizmo="edge-1"]')!;
    fireEvent.pointerDown(edge, { button: 0, clientX: 30, clientY: 30, pointerId: 2 });
    fireEvent.pointerMove(edge, { clientX: 20, clientY: 33, pointerId: 2 });
    fireEvent.pointerMove(edge, { clientX: 10, clientY: 30, pointerId: 2 });
    fireEvent.pointerUp(edge, { clientX: 10, clientY: 30, pointerId: 2 });
    const stretched = S().layers.find((l) => l.id === 's') as ShapeLayer;
    expect(stretched.decal!.width).toBeCloseTo(0.8);
    expect(stretched.decal!.height).toBeCloseTo(0.2);
    expect(S().past).toHaveLength(past + 1);
  });

  it('a folder child gets the gizmo; a merged object only corners; Repeat outlines the whole row', async () => {
    const { container } = renderEditor(project({ layers: layers() }));
    await ready();
    act(() => S().select('c'));
    expect(container.querySelector('[data-gizmo="body"]')).not.toBeNull();
    expect(container.querySelector('[data-gizmo^="edge"]')).toBeNull();
    act(() => S().select('m'));
    expect(container.querySelectorAll('[data-gizmo^="corner"]')).toHaveLength(4);
    expect(container.querySelector('[data-gizmo^="edge"]')).toBeNull();
    expect(container.querySelector('[data-gizmo="repeat"]')).toBeNull();
    act(() => S().setLayerProps('m', { repeat: { count: 3, gap: 0.5, direction: 'row' } }));
    expect(container.querySelector('[data-gizmo="repeat"]')).not.toBeNull();
    // A piece is edited from the properties panel only: no gizmo.
    act(() => S().select('p'));
    expect(container.querySelector('[data-gizmo="body"]')).toBeNull();
  });

  it('with two layers selected, outlines each frame and shows no gizmo', async () => {
    const { container } = renderEditor(project({ layers: layers() }));
    await ready();
    act(() => {
      S().select('s');
      S().toggleSelect('m');
    });
    expect(S().selectedIds).toHaveLength(2);
    expect(container.querySelector('[data-gizmo]')).toBeNull();
    expect(container.querySelectorAll('[data-selection-outline]')).toHaveLength(2);
    expect(container.querySelector('[data-selection-outline="s"]')).not.toBeNull();
    act(() => S().select('s'));
    expect(container.querySelector('[data-selection-outline]')).toBeNull();
    expect(container.querySelector('[data-gizmo="body"]')).not.toBeNull();
  });
});
