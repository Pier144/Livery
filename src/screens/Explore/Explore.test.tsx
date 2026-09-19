import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vehicles } from '@/data/vehicles';
import i18n from '@/i18n';
import itJson from '@/i18n/it.json';
import { createQueryClient } from '@/queries/client';
import { mockLayout } from '@/screens/Hangar/testLayout';
import { useExplore } from '@/store/explore';
import { useWtLiveInstallEvents } from '@/store/installs';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { EVENTS, type AppError, type HangarSkin, type SearchParams, type SearchResult, type WtLiveSkin } from '@/types';
import { useScreenFocus } from '@/hooks/useScreenFocus';
import { Explore } from '../Explore';
import { installErrorText } from './CardAction';

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const vehicle = (code: string) => vehicles.find((v) => v.code === code)!;
const author = (name: string, skinCount?: number) => ({ id: name.toLowerCase(), name, url: 'https://example.invalid', skinCount });

function post(id: string, name: string, code: string, by: string, extra: Partial<WtLiveSkin> = {}): WtLiveSkin {
  return {
    id,
    name,
    vehicle: vehicle(code),
    author: author(by),
    category: 'Historical',
    downloads: 24120,
    likes: 1932,
    postedAt: '2026-06-12T10:00:00Z',
    sizeBytes: 48 * MB,
    images: [],
    postUrl: 'https://example.invalid/post',
    downloadUrl: 'https://example.invalid/file.zip',
    ...extra,
  };
}

const CATALOG: WtLiveSkin[] = [
  post('s1', 'Schwarzwald Ambush', 'germ_pzkpfw_VI_ausf_b_tiger_IIH', 'Kessler_Wolf'),
  post('s2', "Winter '44 Whitewash", 'ussr_t_34_85', 'RedOak_Petrov', { downloads: 18702, likes: 1204 }),
  post('s3', 'Desert Storm Tan', 'us_m1a2_sep', 'ironclad_mia', { category: 'Semi-historical', downloads: 31244 }),
  post('s4', 'Bundeswehr Flecktarn', 'germ_leopard_2a6', 'Kessler_Wolf', { downloads: 42806, likes: 3115 }),
  post('s5', 'Tricolore Parade', 'it_c1_ariete', 'Vesuvio_Skins', { category: 'Fictional', downloads: 6318, likes: 512, isNew: true }),
  post('s6', 'SEA Camo, 388th TFW', 'f_4e', 'Skyhook_Dan', { downloads: 27533 }),
];

interface Fake {
  catalog: WtLiveSkin[];
  hangar: HangarSkin[];
  /** `wtlive_search` rejects with this. */
  searchError?: AppError;
  /** `install_from_wtlive` rejects with this once. */
  installError?: AppError;
  tookMs: number;
}
let fake: Fake;
const PAGE = 60;

function search(params: SearchParams): SearchResult {
  const q = params.q?.toLowerCase();
  const found = fake.catalog.filter(
    (s) =>
      (!q || [s.name, s.vehicle.name, s.author.name].some((f) => f.toLowerCase().includes(q))) &&
      (!params.nation || s.vehicle.nation === params.nation) &&
      (!params.type || s.vehicle.type === params.type) &&
      (!params.class || s.vehicle.class === params.class) &&
      (!params.vehicle || s.vehicle.code === params.vehicle) &&
      (!params.category || s.category === params.category),
  );
  const items = found.slice(params.page * PAGE, params.page * PAGE + PAGE);
  return { items, total: found.length, tookMs: fake.tookMs };
}

function installBackend() {
  backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
    switch (cmd) {
      case 'wtlive_search':
        if (fake.searchError) throw fake.searchError;
        return search(args.params as SearchParams);
      case 'get_hangar':
        return fake.hangar;
      case 'install_from_wtlive': {
        const error = fake.installError;
        fake.installError = undefined;
        if (error) throw error;
        return { installId: 'inst-1' };
      }
      case 'following_list':
        return [];
      default:
        throw { code: 'internal', message: `unexpected ${cmd}` };
    }
  });
}

const searches = () => backend.call.mock.calls.filter(([cmd]) => cmd === 'wtlive_search').map(([, a]) => (a as { params: SearchParams }).params);
const lastSearch = () => searches().at(-1);
const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);
const card = (name: string) => screen.getByRole('group', { name });
const progress = (step: string, pct: number, extra: Args = {}) =>
  act(() => backend.listeners.get(EVENTS.installProgress)?.({ installId: 'inst-1', step, pct, ...extra }));

function Harness() {
  useWtLiveInstallEvents();
  return <Explore />;
}

let restoreLayout: () => void;

function renderExplore(catalog: WtLiveSkin[] = CATALOG) {
  fake = { catalog, hangar: [], tookMs: 24 };
  installBackend();
  return renderWithProviders(<Harness />, { client: createQueryClient() });
}

beforeEach(() => {
  resetStores();
  backend.call.mockReset();
  backend.listeners.clear();
  restoreLayout = mockLayout();
});

afterEach(() => restoreLayout());

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Explore', () => {
  it('shows skeleton cards, then the grid with the result count and time', async () => {
    renderExplore();
    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Schwarzwald Ambush' })).toBeInTheDocument();
    expect(screen.getByText('6 results · 24 ms')).toBeInTheDocument();
    expect(lastSearch()).toEqual({ sort: 'downloads', page: 0 });

    const c = within(card('Bundeswehr Flecktarn'));
    expect(c.getByText('Leopard 2A6')).toBeInTheDocument();
    expect(c.getByText('GER')).toBeInTheDocument();
    expect(c.getByText('Kessler_Wolf')).toBeInTheDocument();
    expect(c.getByText('42.8k dl · 3.1k likes')).toBeInTheDocument();
    expect(c.getByText('Historical')).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Install 48 MB' })).toBeInTheDocument();
    expect(within(card('Tricolore Parade')).getByText('New')).toBeInTheDocument();
    expect(c.queryByText('New')).not.toBeInTheDocument();
  });

  it('chips, the type control and the sort menu filter the search (AND) and list active filters', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });

    await user.click(screen.getByRole('button', { name: 'Nation Any' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Germany' }));
    await waitFor(() => expect(lastSearch()).toEqual({ sort: 'downloads', nation: 'GER', page: 0 }));
    expect(screen.getByRole('button', { name: 'Nation Germany' })).toBeInTheDocument();
    expect(screen.getByText('1 filter')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2 results · 24 ms')).toBeInTheDocument());
    expect(screen.queryByRole('group', { name: 'Desert Storm Tan' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Ground' }));
    expect(screen.getByRole('radio', { name: 'Ground' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: 'Class Any' }));
    // Only ground classes are offered once the type is Ground.
    expect(screen.queryByRole('menuitemradio', { name: 'Fighter' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: 'MBT' }));
    await user.click(screen.getByRole('button', { name: 'Category Any' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Historical' }));
    await user.click(screen.getByRole('button', { name: 'Sort Most downloaded' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Most liked' }));

    await waitFor(() =>
      expect(lastSearch()).toEqual({ sort: 'likes', nation: 'GER', type: 'ground', class: 'MBT', category: 'Historical', page: 0 }),
    );
    expect(screen.getByText('4 filters combined')).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Bundeswehr Flecktarn' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Schwarzwald Ambush' })).not.toBeInTheDocument();

    // Removing one filter moves focus to the next one.
    await user.click(screen.getByRole('button', { name: 'Remove filter: Ground' }));
    expect(screen.getByText('3 filters combined')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter: MBT' })).toHaveFocus();
    await waitFor(() => expect(lastSearch()).toEqual({ sort: 'likes', nation: 'GER', class: 'MBT', category: 'Historical', page: 0 }));

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(lastSearch()).toEqual({ sort: 'likes', page: 0 }));
    expect(screen.queryByText(/filters? combined|1 filter/)).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Nation Any' })).toHaveFocus();
  });

  it('the vehicle input suggests by name or code, picks with the keyboard, and Escape closes only the menu', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });
    const input = screen.getByRole('combobox', { name: 'Vehicle' });

    await user.type(input, 'germ');
    const listbox = screen.getByRole('listbox', { name: 'Matching vehicles' });
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Tiger II (H)germ_pzkpfw_VI_ausf_b_tiger_IIH',
      'Leopard 2A6germ_leopard_2a6',
    ]);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', within(listbox).getAllByRole('option')[1]?.id);
    // The code is ink-3 on the highlighted option (bg-4, where ink-4 is 4.25:1), ink-4 elsewhere.
    expect(within(listbox).getByText('germ_leopard_2a6')).toHaveClass('text-ink-3');
    expect(within(listbox).getByText('germ_pzkpfw_VI_ausf_b_tiger_IIH')).toHaveClass('text-ink-4');

    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).toHaveValue('germ');
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(input).toHaveValue('Leopard 2A6');
    expect(useExplore.getState().vehicle).toBe('germ_leopard_2a6');
    await waitFor(() => expect(lastSearch()).toEqual({ sort: 'downloads', vehicle: 'germ_leopard_2a6', page: 0 }));
    expect(screen.getByRole('button', { name: 'Remove filter: Leopard 2A6' })).toBeInTheDocument();

    // A second Escape (menu closed) clears the field and the filter.
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    expect(useExplore.getState().vehicle).toBeNull();

    // A code the local list doesn't know is searched as typed.
    await user.type(input, 'ussr_is_7{Enter}');
    expect(useExplore.getState().vehicle).toBe('ussr_is_7');
    // Clicking a suggestion works too.
    await user.clear(input);
    await user.type(input, 'su-');
    await user.click(screen.getByRole('option', { name: /Su-27/ }));
    expect(useExplore.getState().vehicle).toBe('su_27');
  });

  it('a removed vehicle filter empties the input', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });
    act(() => useExplore.getState().applyVehicle('f_4e'));
    expect(screen.getByRole('combobox', { name: 'Vehicle' })).toHaveValue('F-4E Phantom II');
    await user.click(screen.getByRole('button', { name: 'Remove filter: F-4E Phantom II' }));
    expect(screen.getByRole('combobox', { name: 'Vehicle' })).toHaveValue('');
  });

  it('Install: progress with steps, then Installed once the hangar has it', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });
    const c = () => within(card('Schwarzwald Ambush'));

    await user.click(c().getByRole('button', { name: 'Install 48 MB' }));
    // Optimistic: the progress shows before the backend answers.
    expect(c().getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    // The pressed button is gone; focus stays on the card.
    expect(c().getByRole('button', { name: 'Schwarzwald Ambush' })).toHaveFocus();
    expect(useUi.getState().screen).toBe('explore');
    await waitFor(() => expect(backend.call).toHaveBeenCalledWith('install_from_wtlive', { skinId: 's1', mode: 'normal' }));

    progress('extract', 56);
    expect(c().getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Extracting 56%');
    expect(c().getByText('Extracting 56%')).toBeInTheDocument();
    expect(c().getByText('Download')).toBeInTheDocument();
    expect(c().getByText('Verify · Done')).toBeInTheDocument();
    expect(c().getByRole('status')).toHaveTextContent('Installing');

    fake.hangar = [
      {
        id: 'h1',
        folder: 'tiger_kessler',
        name: 'Schwarzwald Ambush',
        vehicle: vehicle('germ_pzkpfw_VI_ausf_b_tiger_IIH'),
        origin: 'wtlive',
        sizeBytes: 48 * MB,
        active: true,
        installedAt: '2026-09-19T10:00:00Z',
        sourceId: 's1',
      },
    ];
    progress('done', 100, { skinId: 'h1' });
    await waitFor(() => expect(c().getByText('Installed')).toBeInTheDocument());
    expect(c().getByText('in Hangar')).toBeInTheDocument();
    expect(c().queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
    await waitFor(() => expect(toastTexts()).toEqual(['Installed “Schwarzwald Ambush”']));
  });

  it('a finished install shows every step ticked until the hangar shows it', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await user.click(within(card('Schwarzwald Ambush')).getByRole('button', { name: 'Install 48 MB' }));
    await waitFor(() => expect(backend.call).toHaveBeenCalledWith('install_from_wtlive', expect.anything()));
    backend.call.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_hangar') {
        await gate;
        return fake.hangar;
      }
      throw { code: 'internal', message: cmd };
    });
    progress('done', 100);
    const bar = within(card('Schwarzwald Ambush')).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar).toHaveAttribute('aria-valuetext', 'Done');
    expect(within(card('Schwarzwald Ambush')).getByText('Download · Extract · Verify')).toBeInTheDocument();
    release();
  });

  it('a failed install shows the reason and Retry', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Desert Storm Tan' });
    fake.installError = { code: 'network', message: "WT Live can't be reached" };
    const c = () => within(card('Desert Storm Tan'));
    await user.click(c().getByRole('button', { name: 'Install 48 MB' }));
    expect(await c().findByText("WT Live can't be reached. Check your connection, then retry.")).toBeInTheDocument();
    expect(c().getByRole('status')).toHaveTextContent('Install failed');
    expect(useUi.getState().screen).toBe('explore');

    await user.click(c().getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(backend.call.mock.calls.filter(([cmd]) => cmd === 'install_from_wtlive')).toHaveLength(2));
    expect(c().getByRole('progressbar')).toBeInTheDocument();
  });

  it('a conflict offers Install as a copy', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Desert Storm Tan' });
    fake.installError = { code: 'conflict', message: 'This skin is already installed' };
    const c = () => within(card('Desert Storm Tan'));
    await user.click(c().getByRole('button', { name: 'Install 48 MB' }));
    expect(await c().findByText("It's already in My Hangar.")).toBeInTheDocument();
    expect(c().queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await user.click(c().getByRole('button', { name: 'Install as a copy' }));
    await waitFor(() => expect(backend.call).toHaveBeenCalledWith('install_from_wtlive', { skinId: 's3', mode: 'normal', conflict: 'copy' }));
  });

  it('a skin being tried in game reads "Trying in game"', async () => {
    renderExplore();
    fake.hangar = [
      {
        id: 'h9',
        folder: 'f4',
        name: 'SEA Camo, 388th TFW',
        vehicle: vehicle('f_4e'),
        origin: 'wtlive',
        sizeBytes: 1,
        active: true,
        installedAt: '2026-09-19T10:00:00Z',
        sourceId: 's6',
        temporary: true,
      },
    ];
    const c = within(await screen.findByRole('group', { name: 'SEA Camo, 388th TFW' }));
    expect(await c.findByText('Trying in game')).toBeInTheDocument();
    expect(c.getByText('Keep or discard it on the skin page')).toBeInTheDocument();
  });

  it('clicking a card or pressing Enter on it opens the detail; Install does not', async () => {
    const user = userEvent.setup();
    renderExplore();
    await screen.findByRole('group', { name: 'Tricolore Parade' });
    await user.click(within(card('Tricolore Parade')).getByRole('button', { name: 'Install 48 MB' }));
    expect(useUi.getState().screen).toBe('explore');

    // The full-card hit area (in the app it lies over the card's text and image).
    await user.click(within(card('Bundeswehr Flecktarn')).getByRole('button', { name: 'Bundeswehr Flecktarn' }));
    expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 's4' });

    act(() => useUi.getState().go('explore'));
    within(await screen.findByRole('group', { name: 'Desert Storm Tan' })).getByRole('button', { name: 'Desert Storm Tan' }).focus();
    await user.keyboard('{Enter}');
    expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 's3' });
  });

  it('offline: explains, opens My Hangar, and Retry says it is still offline', async () => {
    const user = userEvent.setup();
    fake = { catalog: CATALOG, hangar: [], tookMs: 24, searchError: { code: 'unsupported', message: 'WT Live needs HTTP' } };
    installBackend();
    renderWithProviders(<Harness />);
    expect(await screen.findByRole('heading', { name: "WT Live can't be reached" })).toBeInTheDocument();
    expect(screen.queryByText(/results ·/)).not.toBeInTheDocument();
    expect(useUi.getState().online).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(toastTexts()).toEqual(['Still offline. Your library is fully available.']));
    await user.click(screen.getByRole('button', { name: 'Open My Hangar' }));
    expect(useUi.getState().screen).toBe('hangar');
  });

  it('offline, then back: Retry shows the grid', async () => {
    const user = userEvent.setup();
    fake = { catalog: CATALOG, hangar: [], tookMs: 24, searchError: { code: 'network', message: 'down' } };
    installBackend();
    renderWithProviders(<Harness />);
    await screen.findByRole('heading', { name: "WT Live can't be reached" });
    fake.searchError = undefined;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Schwarzwald Ambush' })).toBeInTheDocument();
    expect(toastTexts()).toEqual([]);
  });

  it('no results: "No skins match" with Clear all filters', async () => {
    const user = userEvent.setup();
    useExplore.setState({ nation: 'JPN' });
    renderExplore();
    expect(await screen.findByRole('heading', { name: 'No skins match' })).toBeInTheDocument();
    expect(screen.getByText('Try fewer filters, or search by vehicle code instead.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(await screen.findByRole('group', { name: 'Schwarzwald Ambush' })).toBeInTheDocument();
  });

  it('keeps a bounded window of cards for 500 results and asks for the next page near the end', async () => {
    const many = Array.from({ length: 500 }, (_, i) => post(`m${i}`, `Skin ${String(i).padStart(3, '0')}`, 'su_27', 'Flanker_Ivan'));
    const { container } = renderExplore(many);
    await screen.findByRole('group', { name: 'Skin 000' });
    expect(screen.getByText('500 results · 24 ms')).toBeInTheDocument();
    const rendered = () => container.querySelectorAll('[data-skin-id]').length;
    // 1000px → 3 columns; 600px viewport of 200px lines + overscan.
    expect(rendered()).toBeGreaterThan(0);
    expect(rendered()).toBeLessThanOrEqual(24);
    expect(searches().map((p) => p.page)).toEqual([0]);

    // Held at the end of the grid, each page that arrives brings the end near again: every page
    // is asked for once, in order, until the last result shows — never more than a window of cards.
    const scroller = screen.getByRole('region', { name: 'WT Live skins' });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 1e6 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(searches().map((p) => p.page)).toContain(1));
    expect(rendered()).toBeLessThanOrEqual(24);
    await waitFor(() => expect(searches().map((p) => p.page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(await screen.findByRole('group', { name: 'Skin 499' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Skin 000' })).not.toBeInTheDocument();
    expect(rendered()).toBeLessThanOrEqual(24);
    expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument();
  });

  it('never pages on from the previous filters while the new first page loads', async () => {
    const many = Array.from({ length: 500 }, (_, i) => post(`m${i}`, `Skin ${String(i).padStart(3, '0')}`, 'su_27', 'Flanker_Ivan'));
    renderExplore(many);
    await screen.findByRole('group', { name: 'Skin 000' });

    // The new filter's first page is held back: the old results stay on screen meanwhile.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const plain = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd, args) => {
      if (cmd === 'wtlive_search' && (args?.params as SearchParams).category) await gate;
      return plain(cmd, args);
    });
    act(() => useExplore.getState().setCategory('Historical'));
    await waitFor(() => expect(searches().some((p) => p.category)).toBe(true));
    expect(screen.getByRole('group', { name: 'Skin 000' })).toBeInTheDocument();

    // Scrolling to the end of those old results asks for nothing more.
    const scroller = screen.getByRole('region', { name: 'WT Live skins' });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 1e6 });
    await act(async () => {
      fireEvent.scroll(scroller);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(searches().map((p) => p.page)).toEqual([0, 0]);
    expect(scroller.parentElement).toHaveAttribute('aria-busy', 'true');

    // Once the new first page is in, paging goes on from it.
    await act(async () => release());
    await waitFor(() => expect(searches().filter((p) => p.category).map((p) => p.page)).toEqual([0, 1]));
    expect(searches().filter((p) => !p.category).map((p) => p.page)).toEqual([0]);
    expect(scroller.parentElement).not.toHaveAttribute('aria-busy');
  });

  it('has a level-one heading, and each card title is a heading screen readers can jump through', async () => {
    renderExplore();
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });
    expect(screen.getByRole('heading', { level: 1, name: 'Explore' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(CATALOG.map((s) => s.name));
    expect(within(card('Tricolore Parade')).getByRole('heading', { level: 2 })).toHaveTextContent('Tricolore Parade');
  });

  it('has no serious axe violations: grid, an open menu, suggestions, and card states', async () => {
    const user = userEvent.setup();
    const { container } = renderExplore();
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Nation Any' }));
    expect(await seriousViolations(container)).toEqual([]);
    await user.keyboard('{Escape}');

    await user.type(screen.getByRole('combobox', { name: 'Vehicle' }), 'leo');
    expect(await seriousViolations(container)).toEqual([]);
    await user.keyboard('{Escape}');

    fake.installError = { code: 'conflict', message: 'x' };
    await user.click(within(card('Desert Storm Tan')).getByRole('button', { name: 'Install 48 MB' }));
    await within(card('Desert Storm Tan')).findByRole('button', { name: 'Install as a copy' });
    await user.click(within(card('Schwarzwald Ambush')).getByRole('button', { name: 'Install 48 MB' }));
    expect(await seriousViolations(container)).toEqual([]);
  });
});

describe('installErrorText', () => {
  it('explains its own codes, else shows the backend message in the UI language', async () => {
    const t = i18n.t;
    expect(installErrorText(t, 'network', 'x')).toBe("WT Live can't be reached. Check your connection, then retry.");
    expect(installErrorText(t, 'io', 'Could not copy the skin files')).toBe('Could not copy the skin files');
    expect(installErrorText(t, undefined, ' ')).toBe('Install failed');
    await i18n.changeLanguage('it');
    try {
      expect(installErrorText(t, 'io', 'Could not copy the skin files')).toBe('Impossibile copiare i file della skin');
      expect(installErrorText(t, 'io', 'Disk full')).toBe(itJson.common.errors.io);
      expect(installErrorText(t, 'conflict', 'x')).toBe(itJson.explore.card.errors.conflict);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('Explore · focus back from the Skin detail', () => {
  /** App in miniature: Explore or a stand-in detail (its back button) in <main>, and the screen-focus hook. */
  function RoundTrip() {
    useWtLiveInstallEvents();
    useScreenFocus();
    const current = useUi((s) => s.screen);
    return (
      <main>
        {current === 'detail' ? (
          <button type="button" onClick={() => useUi.getState().leaveDetail()}>
            Back to Explore
          </button>
        ) : (
          <Explore />
        )}
      </main>
    );
  }

  function renderRoundTrip(catalog: WtLiveSkin[]) {
    fake = { catalog, hangar: [], tookMs: 24 };
    installBackend();
    return renderWithProviders(<RoundTrip />, { client: createQueryClient() });
  }

  const hitArea = (name: string) => within(card(name)).getByRole('button', { name });

  it('Enter opens the detail; Back puts focus on the card that opened it', async () => {
    const user = userEvent.setup();
    renderRoundTrip(CATALOG);
    await screen.findByRole('group', { name: 'Desert Storm Tan' });
    hitArea('Desert Storm Tan').focus();
    await user.keyboard('{Enter}');
    expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 's3' });

    await user.click(screen.getByRole('button', { name: 'Back to Explore' }));
    expect(useUi.getState().screen).toBe('explore');
    await waitFor(() => expect(hitArea('Desert Storm Tan')).toHaveFocus());
    expect(useUi.getState().returnFocusSkin).toBeNull();
  });

  it('brings a card far down the virtual grid back into the window and focuses it', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, i) => post(`m${i}`, `Skin ${String(i).padStart(3, '0')}`, 'su_27', 'Flanker_Ivan'));
    renderRoundTrip(many);
    await screen.findByRole('group', { name: 'Skin 000' });
    // Line 14 of 3 cards: far outside the 600px window (+ overscan) at the top.
    expect(screen.queryByRole('group', { name: 'Skin 042' })).not.toBeInTheDocument();

    act(() => useUi.getState().openSkin('m42'));
    await user.click(screen.getByRole('button', { name: 'Back to Explore' }));
    await waitFor(() => expect(hitArea('Skin 042')).toHaveFocus());
  });

  it('falls back to the Explore heading when the skin is not in the results', async () => {
    const user = userEvent.setup();
    renderRoundTrip(CATALOG);
    await screen.findByRole('group', { name: 'Schwarzwald Ambush' });
    // Opened from the palette with a skin these filters don't show.
    act(() => useUi.getState().openSkin('elsewhere'));
    await user.click(screen.getByRole('button', { name: 'Back to Explore' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Explore' })).toHaveFocus());
  });
});
