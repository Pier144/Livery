import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAtelierEditor } from '@/atelier/editorStore';
import { maskOf, type BaseLayer } from '@/atelier/project';
import { Toaster } from '@/components/chrome/Toaster';
import { encodeMockModel, mockTemplate, MOCK_TEXTURE_SIZE } from '@/dev/mockAtelier';
import { useAtelierUi } from '@/store/atelier';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { ApplyProgress, AtelierProject, HangarSkin } from '@/types';
import { Editor } from './Editor';
import { EngineContext, type Engine, type EngineFactory } from './engine';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  callRaw: vi.fn<(cmd: string, body: Uint8Array, headers: Record<string, string>) => Promise<unknown>>(),
  progress: [] as ((p: ApplyProgress) => void)[],
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
  callRaw: (cmd: string, body: Uint8Array, headers: Record<string, string>) => backend.callRaw(cmd, body, headers),
}));

vi.mock('@/lib/events', () => ({
  listenEvent: async (_name: string, handler: (p: ApplyProgress) => void) => {
    backend.progress.push(handler);
    return () => {
      backend.progress = backend.progress.filter((h) => h !== handler);
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

function answer(cmd: string, args: Record<string, unknown> = {}): unknown {
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
    expect(order()).toEqual(['atelier_apply_begin', 'atelier_apply_texture', 'atelier_apply_texture', 'atelier_apply_texture', 'atelier_apply_commit', 'atelier_project_thumb']);
    // Saved before the apply began.
    const save = backend.call.mock.invocationCallOrder[backend.call.mock.calls.findIndex(([c]) => c === 'atelier_project_save')]!;
    const beginAt = backend.call.mock.invocationCallOrder[backend.call.mock.calls.findIndex(([c]) => c === 'atelier_apply_begin')]!;
    expect(save).toBeLessThan(beginAt);
    expect(calls('atelier_apply_begin')).toEqual([{ projectId: 'p1', enabled: SLOTS }]);
    expect(backend.callRaw.mock.calls.filter(([c]) => c === 'atelier_apply_texture').map(([, , h]) => h)).toEqual(
      SLOTS.map((slot) => ({ 'x-apply-id': 'a1', 'x-slot': slot, 'x-width': '256', 'x-height': '256' })),
    );
    expect(engine.baker.bakeForExport.mock.calls).toEqual(SLOTS.map((s) => [s, false]));
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
