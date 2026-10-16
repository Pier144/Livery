import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/chrome/Toaster';
import { useAtelierUi } from '@/store/atelier';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { AtelierProject, AtelierProjectSummary, Settings } from '@/types';
import { Atelier } from '../Atelier';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  webgl: true,
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('./webgl', () => ({ hasWebGL2: () => backend.webgl }));

// ── Fake backend: projects in memory, newest save first ─────────────────────

const TIGER = 'germ_pzkpfw_VI_ausf_b_tiger_IIH';
const T34 = 'ussr_t_34_85';
const MODEL_NOT_FOUND = "This vehicle's 3D model isn't in the game's files";

function project(id: string, name: string, vehicle: string, updatedAt: string): AtelierProject {
  return {
    version: 1,
    id,
    name,
    vehicle,
    createdAt: updatedAt,
    updatedAt,
    slots: [{ texture: `${vehicle}_body_c`, enabled: true }],
    output: { highQuality: false },
    layers: [],
  };
}

let projects: AtelierProject[];
let trash: AtelierProject[];
let clock: number;
let failCreate: boolean;

const stamp = () => new Date(Date.UTC(2026, 9, 16, 10, clock++)).toISOString();
const summary = (p: AtelierProject): AtelierProjectSummary => ({ id: p.id, name: p.name, vehicle: p.vehicle, updatedAt: p.updatedAt, hasThumb: false });
const byId = (id: unknown) => projects.find((p) => p.id === id) ?? Promise.reject({ code: 'notFound', message: 'This Atelier project no longer exists' });

function answer(cmd: string, args: Record<string, unknown> = {}): unknown {
  switch (cmd) {
    case 'atelier_projects':
      return [...projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(summary);
    case 'atelier_project_get':
      return byId(args.id);
    case 'atelier_project_create': {
      if (failCreate) return Promise.reject({ code: 'notFound', message: MODEL_NOT_FOUND, detail: String(args.vehicle) });
      const created = project(`p${projects.length + trash.length + 1}`, String(args.name), String(args.vehicle), stamp());
      projects.push(created);
      return created;
    }
    case 'atelier_project_save': {
      const saved = { ...(args.project as AtelierProject), updatedAt: stamp() };
      projects = projects.map((p) => (p.id === saved.id ? saved : p));
      return saved;
    }
    case 'atelier_project_duplicate': {
      const source = projects.find((p) => p.id === args.id)!;
      const copy = { ...source, id: `${source.id}-copy`, name: `${source.name} (2)`, updatedAt: stamp() };
      projects.push(copy);
      return copy;
    }
    case 'atelier_project_delete':
      trash.push(...projects.filter((p) => p.id === args.id));
      projects = projects.filter((p) => p.id !== args.id);
      return null;
    case 'atelier_project_undo_delete':
      projects.push(...trash.filter((p) => p.id === args.id));
      trash = trash.filter((p) => p.id !== args.id);
      return null;
    case 'atelier_project_forget_deleted':
      return null;
    default:
      return Promise.reject({ code: 'noBackend', message: `unexpected ${cmd}` });
  }
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);
const card = (name: string) => screen.getByRole('group', { name });

function renderAtelier(list: AtelierProject[] = [], settings: Partial<Settings> = {}) {
  projects = [...list];
  return renderWithProviders(
    <>
      <Atelier />
      <Toaster />
    </>,
    { settings: { atelierEnabled: true, ...settings } },
  );
}

beforeEach(() => {
  resetStores();
  useUi.setState({ screen: 'atelier' });
  trash = [];
  clock = 30;
  failCreate = false;
  backend.webgl = true;
  backend.call.mockReset();
  backend.call.mockImplementation(async (cmd, args) => answer(cmd, args));
});

describe('Atelier home', () => {
  it('invites the first project when there is none', async () => {
    const user = userEvent.setup();
    renderAtelier();
    expect(await screen.findByRole('heading', { name: 'Start your first skin' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument();
  });

  it('lists the projects with their vehicle and last edit, newest first', async () => {
    renderAtelier([project('p1', 'Desert', TIGER, '2026-10-15T09:00:00Z'), project('p2', 'Winter', T34, '2026-10-16T09:00:00Z')]);
    const names = (await screen.findAllByRole('group')).map((el) => el.getAttribute('aria-label'));
    expect(names).toEqual(['Winter', 'Desert']);
    expect(screen.getByText('2 projects')).toBeInTheDocument();
    expect(within(card('Desert')).getByText('Tiger II (H)')).toBeInTheDocument();
    expect(within(card('Winter')).getByText('T-34-85')).toBeInTheDocument();
    expect(within(card('Desert')).getByText(/^Edited 15 Oct 2026/)).toBeInTheDocument();
  });

  it('opens a project from its card, and Back returns to the projects', async () => {
    const user = userEvent.setup();
    renderAtelier([project('p1', 'Desert', TIGER, '2026-10-15T09:00:00Z')]);
    await user.click(await screen.findByRole('button', { name: 'Desert' }));
    expect(useAtelierUi.getState().openProjectId).toBe('p1');
    await user.click(await screen.findByRole('button', { name: 'Back to projects' }));
    expect(await screen.findByRole('group', { name: 'Desert' })).toBeInTheDocument();
  });

  it('creates a project on a listed ground vehicle, named after it, and opens it', async () => {
    const user = userEvent.setup();
    renderAtelier();
    await screen.findByRole('heading', { name: 'Start your first skin' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    const vehicle = within(dialog).getByRole('combobox', { name: 'Vehicle' });
    expect(vehicle).toHaveFocus();
    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    // Air vehicles aren't offered.
    await user.type(vehicle, 'Phantom');
    expect(within(dialog).queryByRole('option')).not.toBeInTheDocument();
    await user.clear(vehicle);
    await user.type(vehicle, 'tiger');
    await user.click(within(dialog).getByRole('option', { name: /Tiger II \(H\)/ }));
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Tiger II (H)');

    await user.click(create);
    await waitFor(() => expect(calls('atelier_project_create')).toEqual([{ name: 'Tiger II (H)', vehicle: TIGER }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useAtelierUi.getState().openProjectId).toBe('p1');
    expect(await screen.findByRole('heading', { name: 'Tiger II (H)' })).toBeInTheDocument();
  });

  it('keeps a typed name, and shows why a model can’t be read without creating anything', async () => {
    const user = userEvent.setup();
    failCreate = true;
    renderAtelier();
    await screen.findByRole('heading', { name: 'Start your first skin' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Vehicle' }), 'T-34');
    await user.keyboard('{Enter}');
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Winter camo{Enter}');

    expect(await within(dialog).findByText(/3D model isn.t in the game/)).toBeInTheDocument();
    expect(calls('atelier_project_create')).toEqual([{ name: 'Winter camo', vehicle: T34 }]);
    expect(projects).toEqual([]);
    expect(useAtelierUi.getState().openProjectId).toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renames in place (F2), saves on Enter, and Undo puts the old name back', async () => {
    const user = userEvent.setup();
    renderAtelier([project('p1', 'Desert', TIGER, '2026-10-15T09:00:00Z')]);
    (await screen.findByRole('button', { name: 'Desert' })).focus();
    await user.keyboard('{F2}');
    const field = screen.getByRole('textbox', { name: 'New name for Desert' });
    await user.clear(field);
    await user.type(field, 'Sand{Enter}');

    await waitFor(() => expect(toastTexts()).toContain('Renamed to “Sand”'));
    expect((calls('atelier_project_save')[0]?.project as AtelierProject).name).toBe('Sand');
    expect(await screen.findByRole('group', { name: 'Sand' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('group', { name: 'Desert' })).toBeInTheDocument();
    expect((calls('atelier_project_save')[1]?.project as AtelierProject).name).toBe('Desert');
  });

  it('duplicates from the card menu', async () => {
    const user = userEvent.setup();
    renderAtelier([project('p1', 'Desert', TIGER, '2026-10-15T09:00:00Z')]);
    await user.click(within(await screen.findByRole('group', { name: 'Desert' })).getByRole('button', { name: 'Project actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(await screen.findByRole('group', { name: 'Desert (2)' })).toBeInTheDocument();
    expect(calls('atelier_project_duplicate')).toEqual([{ id: 'p1' }]);
  });

  it('deletes from the card menu with an undoable toast, and Undo brings the project back', async () => {
    const user = userEvent.setup();
    renderAtelier([project('p1', 'Desert', TIGER, '2026-10-15T09:00:00Z'), project('p2', 'Winter', T34, '2026-10-16T09:00:00Z')]);
    await user.click(within(await screen.findByRole('group', { name: 'Desert' })).getByRole('button', { name: 'Project actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('group', { name: 'Desert' })).not.toBeInTheDocument());
    expect(calls('atelier_project_delete')).toEqual([{ id: 'p1' }]);
    expect(toastTexts()).toContain('Deleted project “Desert”');

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('group', { name: 'Desert' })).toBeInTheDocument();
    expect(calls('atelier_project_undo_delete')).toEqual([{ id: 'p1' }]);
    expect(calls('atelier_project_forget_deleted')).toEqual([]);
  });

  it('Delete on a focused card deletes it and moves focus to the next card', async () => {
    const user = userEvent.setup();
    renderAtelier([project('p1', 'Desert', TIGER, '2026-10-15T09:00:00Z'), project('p2', 'Winter', T34, '2026-10-16T09:00:00Z')]);
    (await screen.findByRole('button', { name: 'Winter' })).focus();
    await user.keyboard('{Delete}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Desert' })).toHaveFocus());
    expect(calls('atelier_project_delete')).toEqual([{ id: 'p2' }]);
  });

  it('has no serious axe violations (grid, menu and dialog)', async () => {
    const user = userEvent.setup();
    const { container } = renderAtelier([project('p1', 'Desert', TIGER, '2026-10-15T09:00:00Z')]);
    await screen.findByRole('group', { name: 'Desert' });
    expect(await seriousViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Project actions' }));
    expect(await seriousViolations(container)).toEqual([]);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(await seriousViolations(document.body)).toEqual([]);
  });
});

describe('Atelier gates', () => {
  it('explains that it needs Read data from the game, and links to Settings → Game', async () => {
    const user = userEvent.setup();
    renderAtelier([], { readGameData: false });
    expect(screen.getByRole('heading', { name: 'Atelier needs the game’s files' })).toBeInTheDocument();
    expect(calls('atelier_projects')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Open Game settings' }));
    expect(useUi.getState().screen).toBe('settings');
  });

  it('explains that it needs WebGL 2', () => {
    backend.webgl = false;
    renderAtelier();
    expect(screen.getByRole('heading', { name: 'Atelier needs WebGL 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });
});
