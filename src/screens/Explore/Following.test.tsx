import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vehicles } from '@/data/vehicles';
import { createQueryClient } from '@/queries/client';
import { mockLayout } from '@/screens/Hangar/testLayout';
import { useExplore } from '@/store/explore';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { FollowEntry, FollowKind, SearchParams, WtLiveSkin } from '@/types';
import { Explore } from '../Explore';
import { newFor } from './Following';

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
function post(id: string, name: string, code: string, by: string, skinCount?: number): WtLiveSkin {
  return {
    id,
    name,
    vehicle: vehicle(code),
    author: { id: by.toLowerCase(), name: by, url: 'https://example.invalid', skinCount },
    category: 'Fictional',
    downloads: 100,
    likes: 10,
    postedAt: '2026-09-14T10:00:00Z',
    sizeBytes: 1,
    images: [],
    postUrl: '',
    downloadUrl: '',
    isNew: true,
  };
}

const NEW: WtLiveSkin[] = [
  post('s14', 'Baltic Winter', 'germ_leopard_2a6', 'Kessler_Wolf', 14),
  post('s11', 'Night Ops Matte', 'germ_leopard_2a6', 'nachtjaeger'),
  post('s12', 'Ace of Spades', 'f_4e', 'Skyhook_Dan'),
];
const follow = (kind: FollowKind, id: string, name: string): FollowEntry => ({ kind, id, name, lastSeenAt: '2026-09-09T00:00:00Z' });
const FOLLOWS: FollowEntry[] = [
  follow('vehicle', 'germ_leopard_2a6', 'Leopard 2A6'),
  follow('author', 'kessler_wolf', 'Kessler_Wolf'),
  follow('author', 'skyhook_dan', 'Skyhook_Dan'),
  follow('vehicle', 'spitfire_mk9c', 'Spitfire Mk IX'),
];

let following: FollowEntry[];
let fresh: WtLiveSkin[];

function installBackend() {
  backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
    switch (cmd) {
      case 'wtlive_search': {
        const params = args.params as SearchParams;
        const items = NEW.filter((s) => !params.vehicle || s.vehicle.code === params.vehicle);
        return { items, total: items.length, tookMs: 20 };
      }
      case 'get_hangar':
        return [];
      case 'following_list':
        return following;
      case 'wtlive_following_new':
        return fresh;
      case 'following_set': {
        const { kind, id, name, follow: on, lastSeenAt } = args as Omit<FollowEntry, 'lastSeenAt'> & { follow: boolean; lastSeenAt?: string };
        following = following.filter((f) => !(f.kind === kind && f.id === id));
        if (on) following = [...following, { kind, id, name, lastSeenAt: lastSeenAt ?? '2026-09-19T10:00:00Z' }];
        return following;
      }
      case 'following_mark_seen':
        fresh = [];
        following = following.map((f) => ({ ...f, lastSeenAt: '2026-09-19T10:00:00Z' }));
        return following;
      default:
        throw { code: 'internal', message: `unexpected ${cmd}` };
    }
  });
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd);
const followingTab = () => screen.getByRole('tab', { name: /^Following/ });
const followCard = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

let restoreLayout: () => void;

function renderExplore() {
  installBackend();
  return renderWithProviders(<Explore />, { client: createQueryClient() });
}

beforeEach(async () => {
  // The previous test unmounted on the Following tab: let its (deferred) mark-seen run first.
  await new Promise((r) => setTimeout(r, 0));
  resetStores();
  backend.call.mockReset();
  following = [...FOLLOWS];
  fresh = [...NEW];
  restoreLayout = mockLayout();
});

afterEach(() => restoreLayout());

describe('Following', () => {
  it('counts new skins on the tab and per follow', async () => {
    const user = userEvent.setup();
    renderExplore();
    await waitFor(() => expect(followingTab()).toHaveTextContent('Following3 new'));
    await user.click(followingTab());
    expect(followingTab()).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: /^Following/ })).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Following · 4' })).toBeInTheDocument();
    const list = within(screen.getByRole('list', { name: 'Following · 4' }));
    expect(list.getAllByRole('listitem')).toHaveLength(4);
    expect(followCard('Leopard 2A6')).toHaveTextContent('Leopard 2A6Vehicle · germ_leopard_2a62 new');
    // Kessler_Wolf's count comes from a cached WT Live skin of theirs.
    expect(followCard('Kessler_Wolf')).toHaveTextContent('Kessler_WolfAuthor · 14 skins on WT Live1 new');
    expect(followCard('Skyhook_Dan')).toHaveTextContent('Skyhook_DanAuthor1 new');
    expect(followCard('Spitfire Mk IX')).toHaveTextContent('Spitfire Mk IXVehicle · spitfire_mk9c');
    expect(followCard('Spitfire Mk IX')).not.toHaveTextContent('new');

    const newGrid = within(screen.getByRole('region', { name: 'New from people and vehicles you follow' }));
    expect(newGrid.getByRole('button', { name: /^Baltic Winter/ })).toHaveTextContent(/Leopard 2A6 · by Kessler_Wolf · 14 Sep 2026/);
    expect(newGrid.getAllByRole('button')).toHaveLength(3);
    // Opening the tab doesn't reset the counts.
    expect(calls('following_mark_seen')).toHaveLength(0);
  });

  it('newFor counts a follow’s vehicle or author', () => {
    expect(FOLLOWS.map((f) => newFor(f, NEW))).toEqual([2, 1, 1, 0]);
  });

  it('a vehicle follow opens Explore filtered by it; an author follow searches for the author', async () => {
    const user = userEvent.setup();
    useExplore.setState({ tab: 'following', nation: 'USSR' });
    renderExplore();
    await user.click(await screen.findByRole('button', { name: /^Leopard 2A6/ }));
    expect(useExplore.getState()).toMatchObject({ tab: 'explore', vehicle: 'germ_leopard_2a6', nation: null });
    expect(await screen.findByRole('combobox', { name: 'Vehicle' })).toHaveValue('Leopard 2A6');
    await waitFor(() => expect(calls('wtlive_search').at(-1)?.[1]).toEqual({ params: { sort: 'downloads', vehicle: 'germ_leopard_2a6', page: 0 } }));

    act(() => useExplore.getState().setTab('following'));
    await user.click(await screen.findByRole('button', { name: /^Skyhook_Dan/ }));
    expect(useExplore.getState()).toMatchObject({ tab: 'explore', q: 'Skyhook_Dan', vehicle: null });
    expect(screen.getByRole('button', { name: 'Remove filter: “Skyhook_Dan”' })).toBeInTheDocument();
  });

  it('unfollow is undoable and keeps focus in the list', async () => {
    const user = userEvent.setup();
    useExplore.setState({ tab: 'following' });
    renderExplore();
    await waitFor(() => expect(followCard('Skyhook_Dan')).toHaveTextContent('1 new'));
    await user.click(await screen.findByRole('button', { name: 'Unfollow Skyhook_Dan' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Skyhook_Dan/ })).not.toBeInTheDocument());
    expect(calls('following_set').at(-1)?.[1]).toEqual({ kind: 'author', id: 'skyhook_dan', name: 'Skyhook_Dan', follow: false });
    expect(screen.getByRole('heading', { name: 'Following · 3' })).toBeInTheDocument();
    // Focus moves on to the next card.
    expect(followCard('Spitfire Mk IX')).toHaveFocus();

    const toast = useToasts.getState().toasts.at(-1);
    expect(toast?.message).toBe('Unfollowed “Skyhook_Dan”');
    await act(() => useToasts.getState().undo(toast!.id));
    // Followed again from the old "last seen": its new skins count as new again.
    expect(calls('following_set').at(-1)?.[1]).toEqual({
      kind: 'author',
      id: 'skyhook_dan',
      name: 'Skyhook_Dan',
      follow: true,
      lastSeenAt: '2026-09-09T00:00:00Z',
    });
    expect(following.find((f) => f.id === 'skyhook_dan')?.lastSeenAt).toBe('2026-09-09T00:00:00Z');
    expect(await screen.findByRole('button', { name: /^Skyhook_Dan/ })).toHaveTextContent('1 new');
  });

  it('says so when Undo of an unfollow fails', async () => {
    const user = userEvent.setup();
    useExplore.setState({ tab: 'following' });
    renderExplore();
    await user.click(await screen.findByRole('button', { name: 'Unfollow Skyhook_Dan' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Skyhook_Dan/ })).not.toBeInTheDocument());
    const toast = useToasts.getState().toasts.at(-1);
    const base = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
      if (cmd === 'following_set') throw { code: 'io', message: 'disk full' };
      return base(cmd, args);
    });
    await act(() => useToasts.getState().undo(toast!.id));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toContain("Couldn't follow “Skyhook_Dan” again"));
  });

  it('counts reset when the user leaves the tab, not on opening it or opening a skin from it', async () => {
    const user = userEvent.setup();
    renderExplore();
    await waitFor(() => expect(followingTab()).toHaveTextContent('3 new'));
    await user.click(followingTab());
    await screen.findByRole('button', { name: /^Baltic Winter/ });

    // Opening a new skin keeps the counts for the way back.
    await user.click(screen.getByRole('button', { name: /^Night Ops Matte/ }));
    expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 's11' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls('following_mark_seen')).toHaveLength(0);
  });

  it('leaving the tab marks everything seen and the pill goes away', async () => {
    const user = userEvent.setup();
    renderExplore();
    await waitFor(() => expect(followingTab()).toHaveTextContent('3 new'));
    await user.click(followingTab());
    await screen.findByRole('button', { name: /^Baltic Winter/ });
    expect(calls('following_mark_seen')).toHaveLength(0);

    // Arrow keys move between the tabs (automatic activation).
    act(() => followingTab().focus());
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Explore' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Explore' })).toHaveFocus();
    await waitFor(() => expect(calls('following_mark_seen')).toHaveLength(1));
    await waitFor(() => expect(followingTab()).toHaveTextContent(/^Following$/));
  });

  it('nothing followed: explains how to follow', async () => {
    const user = userEvent.setup();
    following = [];
    useExplore.setState({ tab: 'following' });
    renderExplore();
    expect(await screen.findByRole('heading', { name: "You're not following anyone yet" })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Browse skins' }));
    expect(useExplore.getState().tab).toBe('explore');
  });

  it('WT Live offline: the list still works; new skins explain why they are missing', async () => {
    backend.call.mockReset();
    useExplore.setState({ tab: 'following' });
    installBackend();
    const base = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd, args) => {
      if (cmd === 'wtlive_following_new' || cmd === 'wtlive_search') throw { code: 'network', message: 'down' };
      return base(cmd, args);
    });
    renderWithProviders(<Explore />, { client: createQueryClient() });
    expect(await screen.findByText('New skins show up here when WT Live can be reached.')).toBeInTheDocument();
    expect(followCard('Leopard 2A6')).toBeInTheDocument();
  });

  it('has no serious axe violations', async () => {
    useExplore.setState({ tab: 'following' });
    const { container } = renderExplore();
    await screen.findByRole('button', { name: /^Baltic Winter/ });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
