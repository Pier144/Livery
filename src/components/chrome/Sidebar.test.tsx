import { QueryClientProvider, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createQueryClient } from '@/queries/client';
import { HANGAR_KEY } from '@/queries/hangar';
import { WTLIVE_KEY } from '@/queries/wtlive';
import type { HangarSkin, SearchResult } from '@/types';
import { DEFAULT_SETTINGS } from '@/queries/settings';
import { useQueue } from '@/store/queue';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { Sidebar } from './Sidebar';

const ITEMS = [
  ['Explore', '1'],
  ['My Hangar', '2'],
  ['Collections', '3'],
  ['Install queue', '4'],
  ['Settings', ','],
] as const;

/** Renders the sidebar and waits for the status card queries to settle. */
async function renderSidebar(ui = <Sidebar />) {
  const result = renderWithProviders(ui);
  if (useUi.getState().sidebarOpen) await screen.findByText('NOT SET');
  return result;
}

const nav = () => screen.getByRole('navigation', { name: 'Sections' });

describe('Sidebar', () => {
  beforeEach(() => resetStores());

  it('renders the five sections with icons and shortcut hints', async () => {
    await renderSidebar();
    for (const [name, key] of ITEMS) {
      const item = within(nav()).getByRole('button', { name });
      expect(item.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(item).toHaveAttribute('aria-keyshortcuts', key);
      expect(within(item).getByText(key).tagName).toBe('KBD');
    }
    const explore = screen.getByRole('button', { name: 'Explore' });
    expect(explore).toHaveAttribute('aria-current', 'page');
    expect(explore).toHaveClass('border-amber', 'bg-bg-hover', 'text-ink-1');
    expect(screen.getByRole('button', { name: 'My Hangar' })).toHaveClass('border-transparent', 'text-ink-3');
  });

  it('navigates with the keyboard', async () => {
    const user = userEvent.setup();
    await renderSidebar();
    screen.getByRole('button', { name: 'Collections' }).focus();
    await user.keyboard('{Enter}');
    expect(useUi.getState().screen).toBe('collections');
  });

  it('navigates on click and moves aria-current', async () => {
    const user = userEvent.setup();
    await renderSidebar();
    await user.click(screen.getByRole('button', { name: 'My Hangar' }));
    expect(useUi.getState().screen).toBe('hangar');
    expect(screen.getByRole('button', { name: 'My Hangar' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Explore' })).not.toHaveAttribute('aria-current');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUi.getState().screen).toBe('settings');
  });

  it('shows the pending queue count as a badge with an accessible description', async () => {
    await renderSidebar();
    const queue = screen.getByRole('button', { name: 'Install queue' });
    expect(queue).not.toHaveAttribute('aria-describedby');

    act(() => {
      useQueue.getState().addPaths(['a.zip', 'b.zip']);
    });
    expect(within(queue).getByText('2')).toBeInTheDocument();
    expect(queue).toHaveAccessibleName('Install queue');
    expect(queue).toHaveAccessibleDescription('2 archives waiting');

    // Installed items no longer count.
    act(() => {
      const [first] = useQueue.getState().items;
      useQueue.getState().update(first!.id, { status: 'done' });
    });
    expect(within(queue).getByText('1')).toBeInTheDocument();
    expect(queue).toHaveAccessibleDescription('1 archive waiting');
  });

  it('switches the WT Live dot and text when offline', async () => {
    await renderSidebar();
    const onlineRow = screen.getByText('WT Live online');
    expect(onlineRow.querySelector('span')).toHaveClass('bg-amber');

    act(() => useUi.getState().setOnline(false));
    const offlineRow = screen.getByText('WT Live offline');
    expect(offlineRow.querySelector('span')).toHaveClass('bg-ink-5');
    expect(screen.queryByText('WT Live online')).not.toBeInTheDocument();
  });

  it('shows the WT Live skin count when one is provided', async () => {
    await renderSidebar(<Sidebar liveSkinCount={2318} />);
    expect(screen.getByText('WT Live online · 2,318 skins')).toBeInTheDocument();
  });

  describe('WT Live count from the Explore cache', () => {
    const page = (total: number): InfiniteData<SearchResult, number> => ({ pages: [{ items: [], total, tookMs: 20 }], pageParams: [0] });
    const searchKey = (params: Record<string, unknown>) => [...WTLIVE_KEY, 'search-pages', params];

    async function renderWith(client: QueryClient) {
      renderWithProviders(<Sidebar />, { client });
      await screen.findByText('NOT SET');
    }

    it('reads the unfiltered search total without asking WT Live, and follows the cache', async () => {
      const client = createQueryClient();
      await renderWith(client);
      // Explore never ran: today's text, and the sidebar started no WT Live query of its own.
      expect(screen.getByText('WT Live online')).toBeInTheDocument();
      expect(client.getQueryCache().findAll({ queryKey: WTLIVE_KEY })).toHaveLength(0);

      // Explore's first page lands.
      act(() => client.setQueryData(searchKey({ sort: 'downloads' }), page(2318)));
      expect(screen.getByText('WT Live online · 2,318 skins')).toBeInTheDocument();

      // A filtered search counts only its filter's skins: it doesn't change the catalogue size.
      act(() => client.setQueryData(searchKey({ sort: 'downloads', vehicle: 'f_4e' }), page(12)));
      expect(screen.getByText('WT Live online · 2,318 skins')).toBeInTheDocument();

      // Another sort of the whole catalogue, fetched later, wins.
      act(() => client.setQueryData(searchKey({ sort: 'newest' }), page(2320)));
      expect(screen.getByText('WT Live online · 2,320 skins')).toBeInTheDocument();

      // Offline wins over the count; back online, the count comes back.
      act(() => useUi.getState().setOnline(false));
      expect(screen.getByText('WT Live offline')).toBeInTheDocument();
      act(() => useUi.getState().setOnline(true));
      expect(screen.getByText('WT Live online · 2,320 skins')).toBeInTheDocument();
    });

    it('keeps the last count when Explore’s queries are garbage-collected', async () => {
      const client = createQueryClient();
      client.setQueryData(searchKey({ sort: 'downloads' }), page(2318));
      await renderWith(client);
      expect(screen.getByText('WT Live online · 2,318 skins')).toBeInTheDocument();
      act(() => client.removeQueries({ queryKey: WTLIVE_KEY }));
      expect(screen.getByText('WT Live online · 2,318 skins')).toBeInTheDocument();
    });

    it('ignores filtered searches when no unfiltered one is cached', async () => {
      const client = createQueryClient();
      client.setQueryData(searchKey({ sort: 'downloads', q: 'desert' }), page(7));
      await renderWith(client);
      expect(screen.getByText('WT Live online')).toBeInTheDocument();
      // The collapsed dot speaks the same text.
      act(() => useUi.getState().toggleSidebar());
      expect(screen.getByRole('img', { name: 'WT Live online' })).toBeInTheDocument();
    });

    it('a count passed in wins over the cache', async () => {
      const client = createQueryClient();
      client.setQueryData(searchKey({ sort: 'downloads' }), page(2318));
      renderWithProviders(<Sidebar liveSkinCount={10} />, { client });
      await screen.findByText('NOT SET');
      expect(screen.getByText('WT Live online · 10 skins')).toBeInTheDocument();
    });
  });

  it('shows the game source and the hangar summary', async () => {
    const client = createQueryClient();
    client.setQueryData(['settings'], { ...DEFAULT_SETTINGS, gameSource: 'steam' });
    client.setQueryDefaults(HANGAR_KEY, { staleTime: Infinity });
    // 214 skins adding up to 3.8 GB; only the count and sizeBytes matter to the summary.
    const each = (3.8 * 1024 ** 3) / 214;
    client.setQueryData(
      HANGAR_KEY,
      Array.from({ length: 214 }, (_, i) => ({ id: `h${i}`, sizeBytes: each }) as HangarSkin),
    );
    render(
      <QueryClientProvider client={client}>
        <Sidebar />
      </QueryClientProvider>,
    );
    expect(screen.getByText('War Thunder')).toBeInTheDocument();
    expect(screen.getByText('STEAM')).toBeInTheDocument();
    expect(screen.getByText('Hangar 214 · 3.8 GB')).toBeInTheDocument();
  });

  it('defaults to an empty hangar and an unset game source', async () => {
    await renderSidebar();
    expect(screen.getByText('NOT SET')).toBeInTheDocument();
    expect(screen.getByText('Hangar 0 · 0 B')).toBeInTheDocument();
  });

  it('collapses to an icon rail that keeps accessible names, and expands again', async () => {
    const user = userEvent.setup();
    await renderSidebar();
    act(() => {
      useQueue.getState().addPaths(['a.zip']);
    });

    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-keyshortcuts', '[');
    await user.click(collapse);
    expect(useUi.getState().sidebarOpen).toBe(false);
    expect(screen.queryByText('War Thunder')).not.toBeInTheDocument();

    for (const [name, key] of ITEMS) {
      const item = within(nav()).getByRole('button', { name });
      expect(item).toHaveAttribute('title', name);
      expect(item).toHaveAttribute('aria-keyshortcuts', key);
      expect(item.querySelector('svg')).toBeInTheDocument();
      expect(within(item).queryByText(key)).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');
    const queue = screen.getByRole('button', { name: 'Install queue' });
    expect(queue).toHaveAccessibleDescription('1 archive waiting');
    // The pill becomes a 6px amber dot; the number is no longer rendered.
    expect(queue.querySelector('span.bg-amber')).toHaveClass('h-1.5', 'w-1.5', 'rounded-full');
    expect(within(queue).queryByText('1')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'WT Live online' })).toHaveAttribute('title', 'WT Live online');

    act(() => useUi.getState().setOnline(false));
    expect(screen.getByRole('img', { name: 'WT Live offline' })).toHaveClass('bg-ink-5');

    // Focus stays on the toggle across the variant switch.
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toHaveAttribute('aria-keyshortcuts', ']');
    expect(expand).toHaveFocus();
    await user.click(expand);
    expect(useUi.getState().sidebarOpen).toBe(true);
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
    await screen.findByText('NOT SET');
  });

  it('follows the store when toggled by the [ / ] shortcuts', async () => {
    await renderSidebar();
    act(() => useUi.getState().toggleSidebar());
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(nav()).toHaveClass('w-sidebar-c');
  });

  it('has no serious axe violations when expanded', async () => {
    const { container } = await renderSidebar();
    act(() => {
      useQueue.getState().addPaths(['a.zip', 'b.zip']);
    });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('has no serious axe violations when collapsed', async () => {
    useUi.setState({ sidebarOpen: false });
    const { container } = await renderSidebar();
    act(() => {
      useQueue.getState().addPaths(['a.zip']);
    });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
