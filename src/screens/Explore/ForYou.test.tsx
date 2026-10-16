import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vehicles } from '@/data/vehicles';
import { createQueryClient } from '@/queries/client';
import { mockLayout } from '@/screens/Hangar/testLayout';
import { resetSettingsUi, useSettingsUi } from '@/screens/Settings/settingsUi';
import { useExplore } from '@/store/explore';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { AppError, ForYouNew, HangarSkin, Lineups, Settings, WtLiveSkin } from '@/types';
import { Explore } from '../Explore';
import { FOR_YOU_NEW_DELAY_MS } from './ForYou';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@/lib/events', () => ({ listenEvent: () => Promise.resolve(() => {}) }));

const vehicle = (code: string) => vehicles.find((v) => v.code === code)!;
function post(id: string, name: string, code: string, downloads: number): WtLiveSkin {
  return {
    id,
    name,
    vehicle: vehicle(code),
    author: { id: 'a1', name: 'Kessler_Wolf', url: 'https://example.invalid' },
    category: 'Historical',
    downloads,
    likes: 1,
    postedAt: '2026-09-14T10:00:00Z',
    sizeBytes: 1,
    images: [],
    postUrl: '',
    downloadUrl: '',
  };
}

const TOP: Record<string, WtLiveSkin[]> = {
  germ_leopard_2a6: [post('s4', 'Bundeswehr Flecktarn', 'germ_leopard_2a6', 42806), post('s14', 'Baltic Winter', 'germ_leopard_2a6', 19950)],
  'bf-109g-6': [post('s7', 'JG 52 Yellow Nose', 'bf-109g-6', 15911)],
  ussr_t_34_85: [post('s2', "Winter '44 Whitewash", 'ussr_t_34_85', 18702)],
  su_27: [post('s9', 'Russian Knights Blue', 'su_27', 38417)],
};

const LINEUPS: Lineups = {
  status: 'ok',
  savedAt: '2026-10-16T08:34:00Z',
  current: 'germ_leopard_2a6',
  currentNation: 'GER',
  nations: [
    { nation: 'GER', presets: [{ index: 0, name: 'Heer', active: true, vehicles: ['germ_leopard_2a6', 'bf-109g-6', 'germ_unknown_x'] }] },
    {
      nation: 'USSR',
      presets: [
        { index: 0, name: '', active: false, vehicles: ['su_27'] },
        { index: 1, name: 'Main', active: true, vehicles: ['ussr_t_34_85'] },
      ],
    },
  ],
};

interface Fake {
  lineups: Lineups;
  lineupsError?: AppError;
  topError?: AppError;
  /** `wtlive_vehicle_top` waits for this before answering (when set). */
  topGate?: Promise<void>;
  /** `wtlive_for_you_new` waits for this before answering (when set). */
  freshGate?: Promise<void>;
  fresh: ForYouNew;
  hangar: HangarSkin[];
}
let fake: Fake;

function installBackend() {
  backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
    switch (cmd) {
      case 'game_lineups':
        if (fake.lineupsError) throw fake.lineupsError;
        return fake.lineups;
      case 'wtlive_vehicle_top':
        if (fake.topGate) await fake.topGate;
        if (fake.topError) throw fake.topError;
        return TOP[args.code as string] ?? [];
      case 'wtlive_for_you_new':
        if (fake.freshGate) await fake.freshGate;
        if (fake.topError) throw fake.topError;
        return fake.fresh;
      case 'for_you_mark_seen':
        fake.fresh = { items: [], checked: fake.fresh.checked };
        return '2026-10-16T10:00:00Z';
      case 'get_hangar':
        return fake.hangar;
      case 'following_list':
        return [];
      case 'wtlive_search':
        return { items: [], total: 0, tookMs: 1, hasMore: false, totalExact: true };
      default:
        throw { code: 'internal', message: `unexpected ${cmd}` };
    }
  });
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd);
const forYouTab = () => screen.getByRole('tab', { name: /^For you/ });
const LIST = 'Skins for the vehicles in your lineups';
const list = () => within(screen.getByRole('region', { name: LIST }));
/** A top skin's thumbnail, once the list and its row have loaded. */
const findThumb = async (name: string | RegExp) =>
  within(await screen.findByRole('region', { name: LIST })).findByRole('button', { name });

function renderForYou(settings: Partial<Settings> = {}) {
  useExplore.setState({ tab: 'forYou' });
  installBackend();
  return renderWithProviders(<Explore />, { client: createQueryClient(), settings });
}

let restoreLayout: () => void;

beforeEach(async () => {
  // The previous test unmounted on the For you tab: let its (deferred) mark-seen run first.
  await new Promise((r) => setTimeout(r, 0));
  resetStores();
  resetSettingsUi();
  backend.call.mockReset();
  fake = {
    lineups: LINEUPS,
    fresh: {
      items: [
        { vehicle: 'germ_leopard_2a6', skin: { ...TOP.germ_leopard_2a6![1]!, isNew: true } },
        { vehicle: 'su_27', skin: { ...post('s16', 'Ukrainian Digital', 'su_27', 1), isNew: true } },
      ],
      checked: 5,
    },
    hangar: [],
  };
  // Every row fits on screen.
  restoreLayout = mockLayout({ viewport: 2000, row: 60 });
});

afterEach(() => restoreLayout());

describe('For you', () => {
  it('lists the lineups by nation and preset with each vehicle’s top skins and new counts', async () => {
    renderForYou();
    expect(await screen.findByText('Profile saved', { exact: false })).toBeInTheDocument();
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['Germany · Heer', 'USSR · Main', 'USSR · Preset 1']);
    expect(screen.getByText('Active · 3 vehicles')).toBeInTheDocument();
    expect(screen.getByText('1 vehicle')).toBeInTheDocument();

    const leopard = await findThumb('Bundeswehr Flecktarn');
    expect(leopard).toBeInTheDocument();
    expect(list().getByRole('button', { name: 'JG 52 Yellow Nose' })).toBeInTheDocument();
    // The selected vehicle, and new counts once the rows have loaded.
    expect(screen.getByText('selected now')).toBeInTheDocument();
    await waitFor(() => expect(calls('wtlive_for_you_new')).toHaveLength(1));
    expect(calls('wtlive_for_you_new')[0]?.[1]).toEqual({
      vehicles: ['germ_leopard_2a6', 'bf-109g-6', 'germ_unknown_x', 'ussr_t_34_85', 'su_27'],
    });
    expect(await screen.findAllByText('1 new')).toHaveLength(2);
    await waitFor(() => expect(forYouTab()).toHaveTextContent('For you2 new'));
    // A new top skin carries the NEW badge.
    expect(within(list().getByRole('button', { name: /^Baltic Winter/ })).getByText('New')).toBeInTheDocument();

    // An unknown code shows as it is, and WT Live has nothing for it.
    expect(screen.getByText('germ_unknown_x')).toBeInTheDocument();
    expect(screen.getByText('No skins on WT Live for this vehicle')).toBeInTheDocument();
    expect(calls('for_you_mark_seen')).toHaveLength(0);
  });

  it('“All” filters Explore by the vehicle; a skin opens its detail; Search in Explore too', async () => {
    const user = userEvent.setup();
    renderForYou();
    await user.click(await screen.findByRole('button', { name: 'All skins for Leopard 2A6' }));
    expect(useExplore.getState()).toMatchObject({ tab: 'explore', vehicle: 'germ_leopard_2a6' });

    act(() => useExplore.getState().setTab('forYou'));
    await user.click(await screen.findByRole('button', { name: 'Search for germ_unknown_x in Explore' }));
    expect(useExplore.getState()).toMatchObject({ tab: 'explore', vehicle: 'germ_unknown_x' });

    act(() => useExplore.getState().setTab('forYou'));
    await user.click(await findThumb('Russian Knights Blue'));
    expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 's9' });
  });

  it('back from a skin opened here returns to the same place in the list; any other way back starts at the top', async () => {
    const user = userEvent.setup();
    restoreLayout();
    restoreLayout = mockLayout({ viewport: 120, row: 60 });
    const scrollTo = vi.fn();
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = scrollTo;
    // One query cache for every render, as in the app: the rows come back from it.
    const client = createQueryClient();
    const render = () => {
      useExplore.setState({ tab: 'forYou' });
      return renderWithProviders(<Explore />, { client });
    };
    installBackend();
    try {
      const first = render();
      const scroller = await screen.findByRole('region', { name: LIST });
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 240 });
      fireEvent.scroll(scroller);
      // At 240 px (four 60 px rows down) the T-34-85 row is on screen.
      await user.click(await findThumb("Winter '44 Whitewash"));
      expect(useUi.getState().screen).toBe('detail');
      first.unmount();

      act(() => useUi.getState().leaveDetail());
      scrollTo.mockClear();
      const back = render();
      await screen.findByRole('region', { name: LIST });
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 240 })));
      // The skin's thumbnail takes focus again.
      await waitFor(() => expect(document.activeElement).toHaveAttribute('data-skin-id', 's2'));
      back.unmount();

      // Leaving for another screen (not a Skin detail) forgets the place.
      act(() => {
        useUi.getState().go('hangar');
        useUi.getState().go('explore');
      });
      scrollTo.mockClear();
      render();
      await screen.findByRole('region', { name: LIST });
      await act(() => new Promise((r) => setTimeout(r, 10)));
      expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 240 }));
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it('a top skin shows its install state like the Explore card', async () => {
    fake.hangar = [{ id: 'h1', sourceId: 's7', name: 'JG 52', active: true } as HangarSkin];
    renderForYou();
    const thumb = await findThumb(/^JG 52 Yellow Nose/);
    await waitFor(() => expect(thumb).toHaveTextContent('Installed'));
  });

  it('leaving after the new skins answered marks it seen once, even with nothing new; opening a skin does not', async () => {
    const user = userEvent.setup();
    fake.fresh = { items: [], checked: 5 };
    renderForYou();
    await waitFor(() => expect(calls('wtlive_for_you_new')).toHaveLength(1));
    await user.click(await findThumb('Russian Knights Blue'));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(calls('for_you_mark_seen')).toHaveLength(0);

    act(() => useUi.setState({ screen: 'explore', detailSkinId: null }));
    await findThumb('Russian Knights Blue');
    await user.click(screen.getByRole('tab', { name: 'Explore' }));
    await waitFor(() => expect(calls('for_you_mark_seen')).toHaveLength(1));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(calls('for_you_mark_seen')).toHaveLength(1);
  });

  it('leaving before the new skins answered does not mark it seen', async () => {
    const user = userEvent.setup();
    fake.topGate = new Promise(() => {});
    renderForYou();
    await waitFor(() => expect(calls('wtlive_vehicle_top').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('tab', { name: 'Explore' }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls('wtlive_for_you_new')).toHaveLength(0);
    expect(calls('for_you_mark_seen')).toHaveLength(0);
  });

  it('a later visit left before its new skins answered does not mark it seen again', async () => {
    const user = userEvent.setup();
    renderForYou();
    await waitFor(() => expect(forYouTab()).toHaveTextContent('2 new'));
    await user.click(screen.getByRole('tab', { name: 'Explore' }));
    await waitFor(() => expect(calls('for_you_mark_seen')).toHaveLength(1));
    await waitFor(() => expect(forYouTab()).toHaveTextContent(/^For you$/));

    // Back on the tab: the emptied answer is only a placeholder until WT Live answers again.
    fake.freshGate = new Promise(() => {});
    await user.click(forYouTab());
    await screen.findByRole('heading', { name: 'Germany · Heer' });
    await waitFor(() => expect(calls('wtlive_for_you_new')).toHaveLength(2));
    await user.click(screen.getByRole('tab', { name: 'Explore' }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls('for_you_mark_seen')).toHaveLength(1);
  });

  it('NEW badges come only from the current new skins within checked, never from the post itself', async () => {
    const user = userEvent.setup();
    const flecktarn = TOP.germ_leopard_2a6![0]!;
    // WT Live's own flag on a top skin is not For you's "new".
    TOP.germ_leopard_2a6![0] = { ...flecktarn, isNew: true };
    // Russian Knights Blue is new but beyond `checked` (the Su-27 is the 5th vehicle).
    fake.fresh = {
      items: [
        { vehicle: 'germ_leopard_2a6', skin: { ...TOP.germ_leopard_2a6![1]!, isNew: true } },
        { vehicle: 'su_27', skin: { ...TOP.su_27![0]!, isNew: true } },
      ],
      checked: 4,
    };
    try {
      renderForYou();
      await waitFor(async () => expect(within(await findThumb(/^Baltic Winter/)).getByText('New')).toBeInTheDocument());
      expect(within(await findThumb(/^Bundeswehr Flecktarn/)).queryByText('New')).not.toBeInTheDocument();
      expect(within(await findThumb(/^Russian Knights Blue/)).queryByText('New')).not.toBeInTheDocument();

      // Seen: on the next visit nothing is new any more.
      await user.click(screen.getByRole('tab', { name: 'Explore' }));
      await waitFor(() => expect(calls('for_you_mark_seen')).toHaveLength(1));
      await user.click(forYouTab());
      const baltic = await findThumb(/^Baltic Winter/);
      await waitFor(() => expect(calls('wtlive_for_you_new')).toHaveLength(2));
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(within(baltic).queryByText('New')).not.toBeInTheDocument();
    } finally {
      TOP.germ_leopard_2a6![0] = flecktarn;
    }
  });

  it('a failed refetch of the lineups keeps the list', async () => {
    const client = createQueryClient();
    useExplore.setState({ tab: 'forYou' });
    installBackend();
    renderWithProviders(<Explore />, { client, settings: {} });
    expect(await screen.findByRole('heading', { name: 'Germany · Heer' })).toBeInTheDocument();
    fake.lineupsError = { code: 'io', message: "Livery couldn't read your War Thunder profile" };
    await act(() => client.refetchQueries({ queryKey: ['lineups'] }));
    expect(screen.getByRole('heading', { name: 'Germany · Heer' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Couldn't read your lineups" })).not.toBeInTheDocument();
  });

  it('every vehicle name has a sub-line, so names line up', async () => {
    renderForYou();
    await findThumb('JG 52 Yellow Nose');
    expect(screen.getAllByTestId('vehicle-sub')).toHaveLength(5);
  });

  it('the pill goes away after the visit', async () => {
    const user = userEvent.setup();
    renderForYou();
    await waitFor(() => expect(forYouTab()).toHaveTextContent('2 new'));
    await user.click(screen.getByRole('tab', { name: 'Explore' }));
    await waitFor(() => expect(forYouTab()).toHaveTextContent(/^For you$/));
  });

  it('asks for new skins only once the visible rows have their top skins', async () => {
    let open!: () => void;
    fake.topGate = new Promise((resolve) => (open = resolve));
    renderForYou();
    await waitFor(() => expect(calls('wtlive_vehicle_top').length).toBeGreaterThan(0));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls('wtlive_for_you_new')).toHaveLength(0);
    open();
    await waitFor(() => expect(calls('wtlive_for_you_new')).toHaveLength(1));
  });

  it('asks for new skins after 15 s even while a row is still loading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fake.topGate = new Promise(() => {});
      renderForYou();
      await waitFor(() => expect(calls('wtlive_vehicle_top').length).toBeGreaterThan(0));
      expect(calls('wtlive_for_you_new')).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(FOR_YOU_NEW_DELAY_MS));
      await waitFor(() => expect(calls('wtlive_for_you_new')).toHaveLength(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('Read data from the game off: explains, and Open Settings goes to the Game section', async () => {
    const user = userEvent.setup();
    fake.lineups = { status: 'off', nations: [] };
    renderForYou();
    expect(await screen.findByRole('heading', { name: 'Suggestions need the game’s data' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(useUi.getState().screen).toBe('settings');
    expect(useSettingsUi.getState().section).toBe('game');
  });

  it('no profile, and no lineups', async () => {
    fake.lineups = { status: 'noProfile', nations: [] };
    const { unmount } = renderForYou();
    expect(await screen.findByRole('heading', { name: 'No War Thunder profile found' })).toBeInTheDocument();
    expect(screen.getByText('Start War Thunder once on this PC, then come back.')).toBeInTheDocument();
    unmount();

    fake.lineups = { status: 'noLineups', nations: [] };
    renderForYou();
    expect(await screen.findByRole('heading', { name: 'No lineups yet' })).toBeInTheDocument();
    expect(screen.getByText('No lineups found in your War Thunder profile.')).toBeInTheDocument();
  });

  it('a profile that can’t be read: the localized message and Retry', async () => {
    const user = userEvent.setup();
    fake.lineupsError = { code: 'io', message: "Livery couldn't read your War Thunder profile" };
    renderForYou();
    expect(await screen.findByRole('heading', { name: 'Couldn\'t read your lineups' })).toBeInTheDocument();
    expect(screen.getByText("Livery couldn't read your War Thunder profile")).toBeInTheDocument();
    fake.lineupsError = undefined;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Germany · Heer' })).toBeInTheDocument();
  });

  it('WT Live offline: the lineups are listed, the rows explain; no pill', async () => {
    fake.topError = { code: 'network', message: 'down' };
    renderForYou();
    expect(await screen.findByRole('heading', { name: 'Germany · Heer' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Skins show up here when WT Live can be reached.')).toHaveLength(5));
    expect(forYouTab()).toHaveTextContent(/^For you$/);
  });

  it('Browse WT Live off: the lineups are listed with a note, nothing asks WT Live, nothing is marked seen', async () => {
    const user = userEvent.setup();
    renderForYou({ wtliveEnabled: false });
    expect(await screen.findByRole('heading', { name: 'Germany · Heer' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'WT Live is turned off' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Skins show up here when WT Live browsing is on.')).toHaveLength(5);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(backend.call.mock.calls.filter(([cmd]) => cmd.startsWith('wtlive_'))).toEqual([]);
    await user.click(screen.getByRole('tab', { name: 'Explore' }));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(calls('for_you_mark_seen')).toHaveLength(0);
  });

  it('has no serious axe violations', async () => {
    const { container } = renderForYou();
    await findThumb('Bundeswehr Flecktarn');
    expect(await seriousViolations(container)).toEqual([]);
  });
});
