import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpdate } from '@/store/update';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { UpdateInfo } from '@/types';
import { UpdateDialog } from './UpdateDialog';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string) => Promise<unknown>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string) => backend.call(cmd),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => backend.openUrl(url) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('0.2.0') }));

let feed: UpdateInfo;

beforeEach(() => {
  resetStores();
  feed = { current: '0.2.0', latest: '0.3.0', ready: false };
  backend.call.mockReset().mockImplementation(async (cmd) => {
    if (cmd === 'check_update') return feed;
    if (cmd === 'install_update') return new Promise(() => {});
    throw { code: 'internal', message: `unexpected ${cmd}` };
  });
  backend.openUrl.mockReset().mockResolvedValue(undefined);
});

async function launch() {
  const user = userEvent.setup();
  const view = renderWithProviders(<UpdateDialog />);
  await act(() => useUpdate.getState().checkAtLaunch());
  return { user, ...view };
}

describe('UpdateDialog', () => {
  it('opens for a newer version with Install focused, and has no serious axe violations', async () => {
    const { container } = await launch();
    const dialog = screen.getByRole('dialog', { name: 'Livery 0.3.0 is available' });
    await waitFor(() => expect(dialog).toHaveAccessibleDescription('You have 0.2.0. Installing closes Livery, updates it and opens it again.'));
    expect(screen.getByRole('button', { name: 'Install and restart' })).toHaveFocus();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('stays closed when Livery is up to date or the check fails', async () => {
    feed = { current: '0.2.0', ready: false };
    await launch();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useUpdate.getState().phase).toBe('upToDate');

    resetStores();
    backend.call.mockRejectedValue({ code: 'network', message: "Livery couldn't check for updates" });
    await launch();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useUpdate.getState().phase).toBe('idle');
  });

  it('Install shows the download in the dialog', async () => {
    const { user } = await launch();
    await user.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(backend.call).toHaveBeenCalledWith('install_update');
    act(() => useUpdate.getState().progress({ downloaded: 30, total: 100 }));
    expect(screen.getByRole('progressbar', { name: 'Livery 0.3.0 is available' })).toHaveAttribute('aria-valuenow', '30');
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
    act(() => useUpdate.getState().progress({ downloaded: 100, total: 100 }));
    expect(screen.getByText('Livery closes and opens again on the new version.')).toBeInTheDocument();
  });

  it('Later (or Escape) closes it until Livery restarts', async () => {
    const { user } = await launch();
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Another check this session doesn't bring it back for the same version.
    useUpdate.setState({ phase: 'idle' });
    await act(() => useUpdate.getState().checkAtLaunch());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    resetStores();
    await launch();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers Restart when the version is already downloaded, and links to what’s new', async () => {
    feed = { current: '0.2.0', latest: '0.3.0', ready: true };
    const { user } = await launch();
    expect(screen.getByRole('button', { name: 'Restart and update' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'What’s new' }));
    await waitFor(() => expect(backend.openUrl).toHaveBeenCalledWith('https://github.com/Pier144/Livery/releases/tag/v0.3.0'));
  });

  it('a failed install shows why and can be tried again', async () => {
    const { user } = await launch();
    backend.call.mockImplementation(async (cmd) => {
      if (cmd === 'install_update') throw { code: 'network', message: "The update couldn't be downloaded" };
      return feed;
    });
    await user.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(await screen.findByText("The update couldn't be downloaded")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install and restart' })).toBeInTheDocument();
  });
});
