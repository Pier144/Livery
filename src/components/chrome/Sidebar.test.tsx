import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createQueryClient } from '@/queries/client';
import { HANGAR_KEY } from '@/queries/hangar';
import type { HangarSkin } from '@/types';
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

  it('shows Atelier (shortcut 6) unless Settings → Atelier → Show Atelier is off', async () => {
    const user = userEvent.setup();
    const { client } = await renderSidebar();
    const atelier = await within(nav()).findByRole('button', { name: 'Atelier' });
    expect(atelier).toHaveAttribute('aria-keyshortcuts', '6');
    // Between the Install queue and Settings.
    const names = within(nav())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-keyshortcuts'));
    expect(names.slice(0, 6)).toEqual(['1', '2', '3', '4', '6', ',']);
    await user.click(atelier);
    expect(useUi.getState().screen).toBe('atelier');
    expect(atelier).toHaveAttribute('aria-current', 'page');
    act(() => client.setQueryData(['settings'], { ...DEFAULT_SETTINGS, atelierEnabled: false }));
    await waitFor(() => expect(within(nav()).queryByRole('button', { name: 'Atelier' })).not.toBeInTheDocument());
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

  it('shows no WT Live status, online or offline', async () => {
    await renderSidebar();
    expect(screen.queryByText(/WT Live/)).not.toBeInTheDocument();
    act(() => useUi.getState().setOnline(false));
    expect(screen.queryByText(/WT Live/)).not.toBeInTheDocument();
    act(() => useUi.getState().toggleSidebar());
    expect(screen.queryByRole('img', { name: /WT Live/ })).not.toBeInTheDocument();
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

  it('resizes from its edge with the keyboard (←/→, Shift, Home/End, Enter resets)', async () => {
    const user = userEvent.setup();
    await renderSidebar();
    const edge = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(edge).toHaveAttribute('aria-controls', nav().id);
    expect(edge).toHaveAttribute('aria-valuenow', '216');
    expect(nav()).toHaveStyle({ width: '216px' });
    edge.focus();
    await user.keyboard('{ArrowRight}');
    expect(useUi.getState().sidebarWidth).toBe(224);
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(useUi.getState().sidebarWidth).toBe(264);
    expect(edge).toHaveAttribute('aria-valuenow', '264');
    expect(nav()).toHaveStyle({ width: '264px' });
    await user.keyboard('{Home}');
    expect(useUi.getState().sidebarWidth).toBe(184);
    await user.keyboard('{ArrowLeft}');
    expect(useUi.getState().sidebarWidth).toBe(184);
    // jsdom's window is 1024px wide: the sidebar may take 35 % of it (358px), not the full 360.
    await user.keyboard('{End}');
    expect(useUi.getState().sidebarWidth).toBe(358);
    expect(edge).toHaveAttribute('aria-valuemax', '358');
    await user.keyboard('{Enter}');
    expect(useUi.getState().sidebarWidth).toBe(216);
  });

  it('shows a stored width narrower when the window is too small for it, and keeps it', async () => {
    useUi.setState({ sidebarWidth: 340 });
    await renderSidebar();
    const width = window.innerWidth;
    try {
      // e.g. the 1100px minimum window at 150 % interface size.
      act(() => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 733 });
        window.dispatchEvent(new Event('resize'));
      });
      expect(nav()).toHaveStyle({ width: '256px' });
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '256');
      expect(useUi.getState().sidebarWidth).toBe(340);
    } finally {
      act(() => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
        window.dispatchEvent(new Event('resize'));
      });
    }
    expect(nav()).toHaveStyle({ width: '340px' });
  });

  it('resizes by dragging its edge; dragging far left collapses it and keeps the width', async () => {
    await renderSidebar();
    const edge = screen.getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.pointerDown(edge, { button: 0, clientX: 216, pointerId: 1 });
    expect(document.documentElement.style.cursor).toBe('col-resize');
    fireEvent.pointerMove(edge, { clientX: 300, pointerId: 1 });
    expect(useUi.getState().sidebarWidth).toBe(300);
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(document.documentElement.style.cursor).toBe('');

    fireEvent.pointerDown(edge, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 260, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 20, pointerId: 1 });
    expect(useUi.getState()).toMatchObject({ sidebarOpen: false, sidebarWidth: 300 });
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(document.documentElement.style.cursor).toBe('');

    act(() => useUi.getState().setSidebarOpen(true));
    await screen.findByText('NOT SET');
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize sidebar' }));
    expect(useUi.getState().sidebarWidth).toBe(216);
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
