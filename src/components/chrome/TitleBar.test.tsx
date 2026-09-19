import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBar } from './TitleBar';
import { appWindow } from '@/lib/tauri';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';

const DRAG = 'data-tauri-drag-region';

describe('TitleBar', () => {
  beforeEach(() => resetStores());
  afterEach(() => vi.restoreAllMocks());

  it('renders the brand without the offline tag while online', () => {
    renderWithProviders(<TitleBar />);
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('LIVERY')).toBeInTheDocument();
    expect(screen.queryByText('OFFLINE · library only')).not.toBeInTheDocument();
  });

  it('shows the offline tag only while WT Live is unreachable', () => {
    renderWithProviders(<TitleBar />);
    act(() => useUi.getState().setOnline(false));
    expect(screen.getByRole('status')).toHaveTextContent('OFFLINE · library only');
    act(() => useUi.getState().setOnline(true));
    expect(screen.queryByText('OFFLINE · library only')).not.toBeInTheDocument();
  });

  it('opens the command palette from the search button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TitleBar />);
    const search = screen.getByRole('button', { name: /Search skins, vehicles, authors/ });
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    expect(search).toHaveTextContent('Ctrl K');
    expect(search).toHaveAttribute('aria-expanded', 'false');
    await user.click(search);
    expect(useUi.getState().palette.open).toBe(true);
    expect(search).toHaveAttribute('aria-expanded', 'true');
  });

  it('drives the native window from the window controls', async () => {
    const minimize = vi.spyOn(appWindow, 'minimize').mockResolvedValue();
    const toggleMaximize = vi.spyOn(appWindow, 'toggleMaximize').mockResolvedValue();
    const close = vi.spyOn(appWindow, 'close').mockResolvedValue();
    const user = userEvent.setup();
    renderWithProviders(<TitleBar />);

    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    await user.click(screen.getByRole('button', { name: 'Maximize' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(minimize).toHaveBeenCalledTimes(1);
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the window controls keyboard operable', async () => {
    const close = vi.spyOn(appWindow, 'close').mockResolvedValue();
    const user = userEvent.setup();
    renderWithProviders(<TitleBar />);
    const button = screen.getByRole('button', { name: 'Close' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('labels the middle control "Restore" while the window is maximized', async () => {
    vi.spyOn(appWindow, 'isMaximized').mockResolvedValue(true);
    renderWithProviders(<TitleBar />);
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Maximize' })).not.toBeInTheDocument();
  });

  it('re-checks the maximized state on resize and unsubscribes on unmount', async () => {
    const isMaximized = vi.spyOn(appWindow, 'isMaximized').mockResolvedValue(false);
    const unlisten = vi.fn();
    let onResize: (() => void) | undefined;
    vi.spyOn(appWindow, 'onResized').mockImplementation(async (cb) => {
      onResize = cb;
      return unlisten;
    });
    const { unmount } = renderWithProviders(<TitleBar />);
    expect(await screen.findByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    await vi.waitFor(() => expect(onResize).toBeDefined());

    isMaximized.mockResolvedValue(true);
    act(() => onResize?.());
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale maximized answer that resolves after a newer one', async () => {
    const pending: Array<(value: boolean) => void> = [];
    vi.spyOn(appWindow, 'isMaximized').mockImplementation(
      () => new Promise<boolean>((resolve) => pending.push(resolve)),
    );
    let onResize: (() => void) | undefined;
    vi.spyOn(appWindow, 'onResized').mockImplementation(async (cb) => {
      onResize = cb;
      return () => {};
    });
    renderWithProviders(<TitleBar />);
    await vi.waitFor(() => expect(onResize).toBeDefined());
    act(() => onResize?.());
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!(true));
    await act(async () => pending[0]!(false));
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('swallows a rejected window action instead of leaking an unhandled rejection', async () => {
    const minimize = vi.spyOn(appWindow, 'minimize').mockRejectedValue({ code: 'internal', message: 'denied' });
    const user = userEvent.setup();
    renderWithProviders(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(minimize).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes even when the resize listener resolves after unmount', async () => {
    const unlisten = vi.fn();
    let resolveListener: (stop: () => void) => void = () => {};
    vi.spyOn(appWindow, 'onResized').mockReturnValue(
      new Promise((resolve) => {
        resolveListener = resolve;
      }),
    );
    const { unmount } = renderWithProviders(<TitleBar />);
    unmount();
    await act(async () => resolveListener(unlisten));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('makes the bar a drag region without covering its buttons', () => {
    act(() => useUi.getState().setOnline(false));
    renderWithProviders(<TitleBar />);
    const banner = screen.getByRole('banner');
    expect(banner).toHaveAttribute(DRAG);
    expect(within(banner).getByText('LIVERY')).toHaveAttribute(DRAG);
    expect(within(banner).getByText('OFFLINE · library only')).toHaveAttribute(DRAG);
    const buttons = within(banner).getAllByRole('button');
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button).not.toHaveAttribute(DRAG);
      expect(button.closest(`[${DRAG}]`)).toBe(button.parentElement);
    }
  });

  it('has no serious axe violations online, offline and maximized', async () => {
    vi.spyOn(appWindow, 'isMaximized').mockResolvedValue(true);
    const { container } = renderWithProviders(<TitleBar />);
    await screen.findByRole('button', { name: 'Restore' });
    expect(await seriousViolations(container)).toEqual([]);
    act(() => useUi.getState().setOnline(false));
    expect(await seriousViolations(container)).toEqual([]);
  });
});
