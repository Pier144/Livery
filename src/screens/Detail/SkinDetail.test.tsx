import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { createQueryClient } from '@/queries/client';
import { useDetail } from '@/store/detail';
import { useExplore } from '@/store/explore';
import { useInstalls, useWtLiveInstallEvents } from '@/store/installs';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import {
  EVENTS,
  type AppError,
  type Collection,
  type FollowEntry,
  type HangarSkin,
  type InstallProgress,
  type SearchParams,
  type TextureInfo,
  type Vehicle,
  type WtLiveSkin,
} from '@/types';
import { SkinDetail } from './SkinDetail';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@/lib/events', () => ({
  listenEvent: (name: string, handler: (payload: unknown) => void) => {
    backend.listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
}));

const MB = 1024 * 1024;
const TIGER: Vehicle = { code: 'germ_tiger_IIH', name: 'Tiger II (H)', nation: 'GER', type: 'ground', class: 'Heavy tank' };
const KESSLER = { id: 'a-kessler', name: 'Kessler_Wolf', url: 'https://live.warthunder.com/user/kessler/' };

const post = (id: string, name: string, extra: Partial<WtLiveSkin> = {}): WtLiveSkin => ({
  id,
  name,
  vehicle: TIGER,
  author: KESSLER,
  category: 'Historical',
  downloads: 24120,
  likes: 1932,
  postedAt: '2026-06-12T12:00:00Z',
  sizeBytes: 48 * MB,
  images: [],
  postUrl: `https://live.warthunder.com/post/${id}/en/`,
  downloadUrl: `https://live.warthunder.com/dl/${id}/`,
  ...extra,
});

const S1 = post('s1', 'Schwarzwald Ambush', {
  files: [
    { path: 'hull_c.dds', sizeBytes: 21 * MB },
    { path: 'germ_tiger_IIH.blk', sizeBytes: 2048 },
    { path: 'preview.jpg', sizeBytes: 412 * 1024 },
  ],
});
const S13 = post('s13', 'Kursk Dust', { author: { id: 'a-panzer', name: 'Panzerlack', url: '' } });
const S20 = post('s20', 'Winter Tiger', { author: { id: 'a-erla', name: 'Erla_Works', url: '' } });
const OTHER = post('s9', 'Russian Knights', { vehicle: { ...TIGER, code: 'su_27', name: 'Su-27' } });

const TEXTURES: TextureInfo[] = [
  // The backend sends the blk first here: the table still lists it last.
  { file: 'germ_tiger_IIH.blk', format: 'BLK', sizeBytes: 2048 },
  { file: 'hull_c.dds', width: 8192, height: 8192, format: 'BC7', sizeBytes: 85.3 * MB, warningKind: 'heavy', warning: 'BACKEND ENGLISH' },
  { file: 'turret_c.dds', width: 4096, height: 4096, format: 'BC7', sizeBytes: 21.3 * MB },
  { file: 'turret_n.dds', missing: true, warningKind: 'missing', warning: 'BACKEND ENGLISH' },
];

const hangarSkin = (extra: Partial<HangarSkin> = {}): HangarSkin => ({
  id: 'h-s1',
  folder: 'germ_tiger_IIH_Kessler_Wolf',
  name: 'Schwarzwald Ambush',
  vehicle: TIGER,
  origin: 'wtlive',
  author: KESSLER,
  sizeBytes: 48 * MB,
  active: true,
  installedAt: '2026-09-19T10:00:00Z',
  sourceId: 's1',
  ...extra,
});

const collection = (id: string, name: string, skinIds: string[] = []): Collection => ({ id, name, skinIds, createdAt: '2026-09-01T10:00:00Z' });

interface Db {
  posts: WtLiveSkin[];
  hangar: HangarSkin[];
  following: FollowEntry[];
  collections: Collection[];
  textures: TextureInfo[];
  /** Commands that reject, by name. */
  fail: Record<string, AppError>;
  /** Commands that never answer (loading states). */
  hang: Set<string>;
}

let db: Db;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fakeBackend(overrides: Partial<Db> = {}) {
  db = {
    posts: [S1, S13, S20, OTHER],
    hangar: [],
    following: [],
    collections: [collection('c1', 'Historical only'), collection('c2', 'Screenshots', ['h-s1'])],
    textures: TEXTURES,
    fail: {},
    hang: new Set(),
    ...overrides,
  };
  const handlers: Record<string, (args: Args) => unknown> = {
    wtlive_post: ({ id }) => db.posts.find((p) => p.id === id) ?? Promise.reject({ code: 'notFound', message: 'No such post' }),
    wtlive_search: ({ params }) => {
      const items = db.posts.filter((p) => p.vehicle.code === (params as SearchParams).vehicle).map((p) => ({ ...p, files: undefined }));
      return { items, total: items.length, tookMs: 12 };
    },
    get_hangar: () => db.hangar,
    read_textures: () => db.textures,
    install_from_wtlive: () => ({ installId: 'inst-1' }),
    finalize_try: ({ skinId, keep }) => {
      const tried = db.hangar.find((h) => h.sourceId === skinId && h.temporary);
      if (!tried) return Promise.reject({ code: 'notFound', message: 'Not being tried' });
      if (keep) {
        db.hangar = db.hangar.map((h) => (h === tried ? { ...h, temporary: undefined } : h));
        return db.hangar.find((h) => h.id === tried.id);
      }
      db.hangar = db.hangar.filter((h) => h !== tried);
      return null;
    },
    following_list: () => db.following,
    following_set: ({ kind, id, name, follow, lastSeenAt }) => {
      db.following = db.following.filter((f) => !(f.kind === kind && f.id === id));
      const seen = (lastSeenAt as string | undefined) ?? '2026-09-19T10:00:00Z';
      if (follow) db.following.push({ kind: kind as FollowEntry['kind'], id: id as string, name: name as string, lastSeenAt: seen });
      return db.following;
    },
    collections_list: () => ({ collections: db.collections }),
    collections_set_skins: ({ id, add }) => {
      const c = db.collections.find((x) => x.id === id)!;
      c.skinIds.push(...(add as string[]));
      return c;
    },
  };
  backend.call.mockImplementation(async (cmd: string, args?: Args) => {
    if (db.hang.has(cmd)) return new Promise(() => {});
    const failure = db.fail[cmd];
    if (failure) throw failure;
    const handler = handlers[cmd];
    if (!handler) throw { code: 'internal', message: `unexpected ${cmd}` } satisfies AppError;
    return clone(await handler(args ?? {}));
  });
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const toasts = () => useToasts.getState().toasts.map((t) => t.message);
const progress = (step: InstallProgress['step'], pct: number) =>
  act(() => backend.listeners.get(EVENTS.installProgress)?.({ installId: 'inst-1', step, pct }));

/** App mounts the WT Live install listener; the screen relies on it. */
function Harness() {
  useWtLiveInstallEvents();
  return <SkinDetail />;
}

function renderDetail(id = 's1') {
  useUi.getState().openSkin(id);
  const client = createQueryClient();
  const user = userEvent.setup();
  const view = renderWithProviders(<Harness />, { client, settings: {} });
  return { ...view, user };
}

/** Rendered and loaded (the name heading is there). */
async function renderLoaded(id = 's1') {
  const view = renderDetail(id);
  await screen.findByRole('heading', { level: 1 });
  return view;
}

beforeEach(() => {
  resetStores();
  backend.listeners.clear();
  backend.call.mockReset();
  fakeBackend();
});

describe('Skin detail · loading and offline', () => {
  it('shows skeletons while the post loads, with a working back button', async () => {
    fakeBackend({ hang: new Set(['wtlive_post']) });
    const { user } = renderDetail();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the skin');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to Explore' }));
    expect(useUi.getState().screen).toBe('explore');
  });

  it('shows the offline state when WT Live can’t be reached', async () => {
    fakeBackend({ fail: { wtlive_post: { code: 'network', message: 'WT Live can’t be reached' } } });
    const { user, container } = renderDetail();
    expect(await screen.findByRole('heading', { name: 'WT Live can’t be reached' })).toBeInTheDocument();
    expect(screen.getByText(/Your library works as usual/)).toBeInTheDocument();
    expect(useUi.getState().online).toBe(false);
    expect(await seriousViolations(container)).toEqual([]);

    // Back online: Retry loads the post.
    db.fail = {};
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Schwarzwald Ambush' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to Explore' }));
    expect(useUi.getState().screen).toBe('explore');
  });

  it('opens My Hangar from the offline state (the build without HTTP answers unsupported)', async () => {
    fakeBackend({ fail: { wtlive_post: { code: 'unsupported', message: 'Not in this build' } } });
    const { user } = renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Open My Hangar' }));
    expect(useUi.getState().screen).toBe('hangar');
  });
});

describe('Skin detail · top bar and tabs', () => {
  it('shows the name and code, and moves between tabs with the arrow keys', async () => {
    const { user } = await renderLoaded();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Schwarzwald Ambush');
    expect(screen.getByText('germ_tiger_IIH', { selector: 'span' })).toBeInTheDocument();

    const gallery = screen.getByRole('tab', { name: 'Gallery' });
    expect(gallery).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Gallery');

    gallery.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Textures' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Textures' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Try in game' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Gallery' })).toHaveFocus();
  });
});

describe('Skin detail · gallery', () => {
  it('moves between thumbnails with the arrow keys (roving tabindex)', async () => {
    const { user } = await renderLoaded();
    const views = screen.getByRole('radiogroup', { name: 'Views' });
    const radios = within(views).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Front', 'Side', 'Rear', 'Detail']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(screen.getByText('1 / 4')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Schwarzwald Ambush, Front' })).toHaveTextContent('screenshot · Tiger II (H) · Front view');

    radios[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Side' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Side' })).toBeChecked();
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Detail' })).toBeChecked();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Front' })).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: 'Rear' }));
    expect(screen.getByText('3 / 4')).toBeInTheDocument();
    expect(useDetail.getState().galleryIndex).toBe(2);
  });

  it('toggles zoom, and Escape leaves zoom first', async () => {
    const { user } = await renderLoaded();
    const stage = screen.getByTestId('gallery-stage');
    expect(stage).toHaveClass('scale-100');

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(stage).toHaveClass('scale-[1.6]');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(stage).toHaveClass('scale-100');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    // Nothing left to close: Escape does nothing special.
    await user.keyboard('{Escape}');
    expect(useUi.getState().screen).toBe('detail');
  });

  it('compares with other skins of the same vehicle and switches pane B', async () => {
    const { user, container } = await renderLoaded();
    await user.click(await screen.findByRole('button', { name: 'Compare' }));
    expect(calls('wtlive_search')[0]).toEqual({ params: { vehicle: 'germ_tiger_IIH', sort: 'downloads', page: 0 } });

    expect(screen.getByText('A · Schwarzwald Ambush')).toBeInTheDocument();
    expect(screen.getByText('B · Kursk Dust · by Panzerlack')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'COMPARE WITH · same vehicle' });
    // Same vehicle only, not the skin itself.
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Kursk Dust', 'Winter Tiger']);
    // Focus lands on the pane-B choice (the Compare button went away).
    expect(within(group).getByRole('button', { name: 'Kursk Dust' })).toHaveFocus();
    expect(within(group).getByRole('button', { name: 'Kursk Dust' })).toHaveAttribute('aria-pressed', 'true');
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(within(group).getByRole('button', { name: 'Winter Tiger' }));
    expect(screen.getByText('B · Winter Tiger · by Erla_Works')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Winter Tiger' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Kursk Dust' })).toHaveAttribute('aria-pressed', 'false');

    // Escape exits compare and hands focus back to Compare.
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/^A · /)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveFocus();

    // Exit compare (button) works too; pane B is remembered.
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByText('B · Winter Tiger · by Erla_Works')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Exit compare' }));
    expect(screen.getByRole('radiogroup', { name: 'Views' })).toBeInTheDocument();
  });

  it('leaves compare mode when the other skins of the vehicle go away', async () => {
    const { user, client } = await renderLoaded();
    await user.click(await screen.findByRole('button', { name: 'Compare' }));
    expect(screen.getByText('A · Schwarzwald Ambush')).toBeInTheDocument();

    // A refetch comes back without the other Tiger II skins.
    db.posts = [S1, OTHER];
    await act(() => client.refetchQueries({ queryKey: ['wtlive', 'search'] }));
    await waitFor(() => expect(useDetail.getState().compare).toBe(false));
    expect(screen.queryByText(/^A · /)).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Views' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument();
    // Focus stays on the gallery (Zoom), not on the page body.
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveFocus();
    // No invisible layer left: the first Escape isn't swallowed by compare.
    expect(useDetail.getState().escape()).toBe(false);
  });

  it('has no Compare without other skins of the vehicle', async () => {
    fakeBackend({ posts: [S1, OTHER] });
    await renderLoaded();
    await waitFor(() => expect(calls('wtlive_search')).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = await renderLoaded();
    await screen.findByRole('button', { name: 'Compare' });
    expect(await seriousViolations(container)).toEqual([]);
  });
});

describe('Skin detail · textures', () => {
  it('lists the archive with localized warnings, missing rows and the blk last', async () => {
    const { user, container } = await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Textures' }));

    expect(await screen.findByRole('heading', { name: 'Textures in the archive' })).toBeInTheDocument();
    expect(calls('read_textures')).toEqual([{ wtliveId: 's1' }]);
    expect(screen.getByText('4 files · 106.6 MB')).toBeInTheDocument();
    expect(
      screen.getByText('2 files need attention. The skin still installs; the game may skip the affected part.'),
    ).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['File', 'Resolution', 'Format', 'Size']);
    const cells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(cells).toEqual([
      ['hull_c.dds', '8192×8192', 'BC7', '85.3 MB'],
      ['Very heavy texture (8192²). Load times may suffer.'],
      ['turret_c.dds', '4096×4096', 'BC7', '21.3 MB'],
      ['turret_n.dds', '—', '—', 'missing'],
      ['Referenced in skin.blk but not in the archive.'],
      ['germ_tiger_IIH.blk', '—', 'BLK', '2 KB'],
    ]);
    // Localized by kind: the backend's English text isn't shown.
    expect(screen.queryByText('BACKEND ENGLISH')).not.toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: /hull_c\.dds/ })).toHaveAccessibleDescription(
      'Very heavy texture (8192²). Load times may suffer.',
    );
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('reads the installed copy once the skin is in the hangar', async () => {
    fakeBackend({ hangar: [hangarSkin()] });
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Textures' }));
    await screen.findByRole('table');
    expect(calls('read_textures')).toEqual([{ skinId: 'h-s1' }]);
  });

  it('shows the warnings in Italian', async () => {
    await i18n.changeLanguage('it');
    try {
      const { user } = await renderLoaded();
      await user.click(screen.getByRole('tab', { name: 'Texture' }));
      expect(await screen.findByText('Texture molto pesante (8192²). I caricamenti potrebbero rallentare.')).toBeInTheDocument();
      expect(screen.getByText('mancante')).toBeInTheDocument();
      expect(screen.getByText(/^2 file richiedono attenzione/)).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('shows the offline state inside the tab when the archive can’t be read from WT Live', async () => {
    fakeBackend({ fail: { read_textures: { code: 'unsupported', message: 'Not in this build' } } });
    const { user, container } = await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Textures' }));
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByRole('heading', { name: 'WT Live can’t be reached' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The rest of the page is still there.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });
});

describe('Skin detail · try in game', () => {
  it('goes idle → installing → active, then Keep finalizes and toasts', async () => {
    const { user, container } = await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Try in game' }));
    expect(screen.getByRole('heading', { name: 'Try it before you keep it' })).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'How it works' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '01Livery copies the files into UserSkins',
      '02In War Thunder, open the vehicle’s Customisation and press the refresh button',
      '03Come back and choose Keep or Discard',
    ]);
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Try in game · 48 MB' }));
    expect(calls('install_from_wtlive')).toEqual([{ skinId: 's1', mode: 'temporary' }]);
    const installing = screen.getByRole('heading', { name: 'Installing temporarily…' });
    expect(installing).toHaveFocus();
    expect(screen.getByRole('progressbar', { name: 'Installing temporarily' })).toBeInTheDocument();

    await waitFor(() => expect(useInstalls.getState().byInstallId['inst-1']).toBe('s1'));
    progress('extract', 60);
    expect(screen.getByRole('heading', { name: 'Installing temporarily…' })).toBeInTheDocument();

    db.hangar = [hangarSkin({ temporary: true })];
    progress('done', 100);
    expect(await screen.findByRole('heading', { name: 'Skin is in the game' })).toBeInTheDocument();
    expect(screen.getByText('UserSkins/germ_tiger_IIH_Kessler_Wolf/')).toBeInTheDocument();
    expect(screen.getByText(/then select “Schwarzwald Ambush”/)).toBeInTheDocument();
    // A try is not an install: no "Installed" toast, and it isn't in the collections menu yet.
    expect(toasts()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add to collection' })).toHaveAttribute('aria-disabled', 'true');
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(toasts()).toEqual(['Kept “Schwarzwald Ambush” — it’s in My Hangar']));
    expect(calls('finalize_try')).toEqual([{ skinId: 's1', keep: true }]);
    expect(await screen.findByRole('heading', { name: 'It’s in My Hangar' })).toBeInTheDocument();
    expect(screen.getByText('Installed')).toBeInTheDocument();
  });

  it('opens on Try in game for a skin being tried, and Discard restores the game files', async () => {
    fakeBackend({ hangar: [hangarSkin({ temporary: true })] });
    const { user } = await renderLoaded();
    expect(await screen.findByRole('heading', { name: 'Skin is in the game' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Try in game' })).toHaveAttribute('aria-selected', 'true');
    // The side panel says it's being tried, not installed.
    expect(screen.getByText('Trying in game')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(toasts()).toEqual(['Discarded “Schwarzwald Ambush”. Game files restored.']));
    expect(calls('finalize_try')).toEqual([{ skinId: 's1', keep: false }]);
    // Discard is the undo of the try: no Undo on its toast.
    expect(useToasts.getState().toasts[0]?.onUndo).toBeUndefined();
    expect(await screen.findByRole('heading', { name: 'Try it before you keep it' })).toBeInTheDocument();
  });

  it('says why a try failed and lets it be tried again', async () => {
    fakeBackend({ fail: { install_from_wtlive: { code: 'unsupported', message: 'Downloads need a later build' } } });
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Try in game' }));
    await user.click(screen.getByRole('button', { name: 'Try in game · 48 MB' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('WT Live can’t be reached. Try again when you’re back online.');
    // The side panel still offers a normal install.
    expect(screen.getByRole('button', { name: /^Install/ })).toBeInTheDocument();
  });
});

describe('Skin detail · side panel', () => {
  it('shows the author, vehicle, stats and files', async () => {
    const { container } = await renderLoaded();
    const side = screen.getByRole('region', { name: 'About this skin' });
    expect(within(side).getByText('Kessler_Wolf')).toBeInTheDocument();
    expect(within(side).getByText('on WT Live')).toBeInTheDocument();
    expect(within(side).getByText('germ_tiger_IIH · Germany · Heavy tank')).toBeInTheDocument();
    const stats = within(side).getAllByRole('definition').map((d) => d.textContent);
    expect(stats).toEqual(['24,120', '1,932', 'Historical', '12 Jun 2026']);
    expect(within(side).getByText('3 · 48 MB')).toBeInTheDocument();
    expect(within(side).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'hull_c.dds',
      'germ_tiger_IIH.blk',
      'preview.jpg',
    ]);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('follows and unfollows the author, with Undo', async () => {
    const { user } = await renderLoaded();
    const follow = await screen.findByRole('button', { name: 'Follow Kessler_Wolf' });
    // The name carries the state: no aria-pressed on a toggle whose name changes (APG).
    expect(follow).not.toHaveAttribute('aria-pressed');

    await user.click(follow);
    const following = await screen.findByRole('button', { name: 'Following Kessler_Wolf' });
    expect(following).toHaveTextContent('Following');
    expect(calls('following_set')).toEqual([{ kind: 'author', id: 'a-kessler', name: 'Kessler_Wolf', follow: true }]);
    expect(toasts()).toEqual(['Following “Kessler_Wolf”']);

    await user.click(following);
    expect(await screen.findByRole('button', { name: 'Follow Kessler_Wolf' })).toHaveTextContent('Follow');
    const unfollowed = useToasts.getState().toasts.at(-1)!;
    expect(unfollowed.message).toBe('Unfollowed “Kessler_Wolf”');

    await act(() => useToasts.getState().undo(unfollowed.id));
    expect(await screen.findByRole('button', { name: 'Following Kessler_Wolf' })).toBeInTheDocument();
    expect(db.following.map((f) => f.id)).toEqual(['a-kessler']);
    // Undo follows again from the "last seen" the unfollowed entry had.
    expect(calls('following_set').at(-1)).toEqual({
      kind: 'author',
      id: 'a-kessler',
      name: 'Kessler_Wolf',
      follow: true,
      lastSeenAt: '2026-09-19T10:00:00Z',
    });
  });

  it('Undo of a vehicle unfollow brings back its old "last seen"', async () => {
    const tiger: FollowEntry = { kind: 'vehicle', id: 'germ_tiger_IIH', name: 'Tiger II (H)', lastSeenAt: '2026-09-01T08:00:00Z' };
    fakeBackend({ following: [tiger] });
    const { user } = await renderLoaded();
    await user.click(await screen.findByRole('button', { name: 'Following Tiger II (H)' }));
    expect(await screen.findByRole('button', { name: 'Follow Tiger II (H)' })).toBeInTheDocument();
    expect(calls('following_set')).toEqual([{ kind: 'vehicle', id: 'germ_tiger_IIH', name: 'Tiger II (H)', follow: false }]);

    await act(() => useToasts.getState().undo(useToasts.getState().toasts.at(-1)!.id));
    expect(await screen.findByRole('button', { name: 'Following Tiger II (H)' })).toBeInTheDocument();
    expect(calls('following_set').at(-1)).toEqual({ ...tiger, follow: true });
    expect(db.following).toEqual([tiger]);
  });

  it('follows the vehicle with its own toggle, next to the vehicle card', async () => {
    const { user } = await renderLoaded();
    await user.click(await screen.findByRole('button', { name: 'Follow Tiger II (H)' }));
    expect(await screen.findByRole('button', { name: 'Following Tiger II (H)' })).toHaveTextContent('Following');
    expect(calls('following_set')).toEqual([{ kind: 'vehicle', id: 'germ_tiger_IIH', name: 'Tiger II (H)', follow: true }]);
  });

  it('opens Explore filtered by the vehicle from the vehicle card', async () => {
    const { user } = await renderLoaded();
    useExplore.setState({ nation: 'USA', q: 'desert' });
    await user.click(screen.getByRole('button', { name: /^Tiger II \(H\)germ_tiger_IIH/ }));
    expect(useUi.getState().screen).toBe('explore');
    expect(useExplore.getState()).toMatchObject({ tab: 'explore', vehicle: 'germ_tiger_IIH', nation: null, q: '' });
  });

  it('copies the original post link (no browser opener yet) and says so', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Open original post' }));
    await waitFor(() => expect(toasts()).toEqual(['Link to the original post copied. Livery can’t open the browser yet, so paste it there.']));
    await expect(navigator.clipboard.readText()).resolves.toBe('https://live.warthunder.com/post/s1/en/');
  });

  it('installs from the side panel and shows the steps', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Install 48 MB' }));
    expect(calls('install_from_wtlive')).toEqual([{ skinId: 's1', mode: 'normal' }]);
    const bar = screen.getByRole('progressbar', { name: 'Installing “Schwarzwald Ambush”' });
    expect(bar).toHaveFocus();
    expect(bar).toHaveAttribute('aria-valuetext', 'Downloading 0%');

    await waitFor(() => expect(useInstalls.getState().byInstallId['inst-1']).toBe('s1'));
    progress('extract', 56);
    expect(bar).toHaveAttribute('aria-valuetext', 'Extracting 56%');
    expect(bar).toHaveAttribute('aria-valuenow', '56');

    db.hangar = [hangarSkin()];
    progress('done', 100);
    expect(await screen.findByText('in Hangar')).toBeInTheDocument();
    await waitFor(() => expect(toasts()).toEqual(['Installed “Schwarzwald Ambush”']));
  });

  it('offers a copy when the install hits a folder conflict', async () => {
    fakeBackend({ fail: { install_from_wtlive: { code: 'conflict', message: 'The folder is taken' } } });
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Install 48 MB' }));
    expect(await screen.findByText('Install failed')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The folder is taken');
    db.fail = {};
    await user.click(screen.getByRole('button', { name: 'Install as a copy' }));
    expect(calls('install_from_wtlive').at(-1)).toEqual({ skinId: 's1', mode: 'normal', conflict: 'copy' });
  });

  it('keeps Add to collection disabled until the skin is installed', async () => {
    const { user } = await renderLoaded();
    const add = screen.getByRole('button', { name: 'Add to collection' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add).toHaveAttribute('title', 'Install it first');
    expect(add).not.toHaveAttribute('aria-haspopup');
    await user.click(add);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('adds the installed skin to a collection', async () => {
    fakeBackend({ hangar: [hangarSkin()] });
    const { user, container } = await renderLoaded();
    // Enabled once the hangar shows the installed copy (the trigger becomes a menu button).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to collection' })).toHaveAttribute('aria-haspopup', 'menu'));
    const add = screen.getByRole('button', { name: 'Add to collection' });
    await user.click(add);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Historical only', 'Screenshotsalready in it']);
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(within(menu).getByRole('menuitem', { name: 'Historical only' }));
    await waitFor(() => expect(toasts()).toEqual(['Added to “Historical only”']));
    expect(calls('collections_set_skins')).toEqual([{ id: 'c1', add: ['h-s1'], remove: [] }]);

    // Already a member: nothing to add.
    await user.click(add);
    await user.click(screen.getByRole('menuitem', { name: /Screenshots/ }));
    expect(toasts().at(-1)).toBe('Already in “Screenshots”');
    expect(calls('collections_set_skins')).toHaveLength(1);
  });
});
