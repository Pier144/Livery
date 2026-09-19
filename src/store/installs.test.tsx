import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/queries/client';
import { HANGAR_KEY, useHangar } from '@/queries/hangar';
import { useToasts } from '@/store/toasts';
import { resetStores } from '@/test/render';
import { EVENTS, type HangarSkin, type InstallProgress } from '@/types';
import { useInstalls, useWtLiveInstall, useWtLiveInstallEvents } from './installs';

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

const skin = (id: string, extra: Partial<HangarSkin> = {}): HangarSkin => ({
  id,
  folder: id,
  name: `Skin ${id}`,
  vehicle: { code: 'germ_tiger', name: 'Tiger', nation: 'GER', type: 'ground', class: 'Heavy tank' },
  origin: 'wtlive',
  sizeBytes: 1,
  active: true,
  installedAt: '2026-09-19T10:00:00Z',
  ...extra,
});

let hangar: HangarSkin[];
/** Holds `get_hangar` open so a test can look at the state before the refetch lands. */
let hangarGate: Promise<void>;

const progress = (step: InstallProgress['step'], pct: number, extra: Partial<InstallProgress> = {}) =>
  act(() => backend.listeners.get(EVENTS.installProgress)?.({ installId: 'inst-1', step, pct, ...extra }));

function setup() {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(
    () => {
      useWtLiveInstallEvents();
      return { install: useWtLiveInstall({ id: 'wt-1' }), hangar: useHangar().data };
    },
    { wrapper },
  );
  return { client, view };
}

beforeEach(() => {
  resetStores();
  backend.listeners.clear();
  hangar = [];
  hangarGate = Promise.resolve();
  backend.call.mockReset();
  backend.call.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_hangar') {
      await hangarGate;
      return hangar;
    }
    if (cmd === 'install_from_wtlive') return { installId: 'inst-1' };
    throw { code: 'internal', message: `unexpected ${cmd}` };
  });
});

describe('useHangar', () => {
  it('leaves Try-in-game installs out unless asked for them', async () => {
    hangar = [skin('a'), skin('b', { temporary: true, sourceId: 'wt-1' })];
    const { view } = setup();
    await waitFor(() => expect(view.result.current.hangar).toHaveLength(1));
    expect(view.result.current.hangar?.[0]?.id).toBe('a');
    expect(view.result.current.install.state).toEqual({ kind: 'installed', temporary: true });
  });
});

describe('WT Live installs', () => {
  it('stays in progress at 100% until the hangar shows the skin, then toasts once', async () => {
    const { view } = setup();
    await waitFor(() => expect(view.result.current.hangar).toEqual([]));

    act(() => view.result.current.install.install());
    await waitFor(() => expect(useInstalls.getState().byInstallId['inst-1']).toBe('wt-1'));
    progress('download', 40);
    expect(view.result.current.install.state).toEqual({ kind: 'installing', step: 'download', pct: 40 });

    let release!: () => void;
    hangarGate = new Promise((resolve) => (release = resolve));
    hangar = [skin('h-1', { sourceId: 'wt-1', name: 'Tiger Winter' })];
    progress('done', 100, { skinId: 'h-1' });

    // The refetch hasn't landed: no flash back to idle.
    expect(view.result.current.install.state).toEqual({ kind: 'installing', step: 'done', pct: 100 });
    expect(useToasts.getState().toasts).toHaveLength(0);

    await act(async () => release());
    await waitFor(() => expect(view.result.current.install.state).toEqual({ kind: 'installed', temporary: false }));
    expect(useInstalls.getState().bySkin['wt-1']).toBeUndefined();
    expect(useInstalls.getState().byInstallId).toEqual({});
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Installed “Tiger Winter”']);
  });

  it("doesn't toast a Try-in-game install (the Try tab has its own UI)", async () => {
    const { view, client } = setup();
    await waitFor(() => expect(view.result.current.hangar).toEqual([]));

    await act(() => useInstalls.getState().start('wt-1', 'temporary'));
    hangar = [skin('h-1', { sourceId: 'wt-1', temporary: true })];
    progress('done', 100, { skinId: 'h-1' });

    await waitFor(() => expect(view.result.current.install.state).toEqual({ kind: 'installed', temporary: true }));
    expect(client.getQueryData<HangarSkin[]>(HANGAR_KEY)).toHaveLength(1);
    expect(view.result.current.hangar).toEqual([]);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('ignores a second start while one is running, and retries after an error', async () => {
    const { view } = setup();
    await waitFor(() => expect(view.result.current.hangar).toEqual([]));

    await act(() => useInstalls.getState().start('wt-1'));
    await act(() => useInstalls.getState().start('wt-1'));
    expect(backend.call.mock.calls.filter(([cmd]) => cmd === 'install_from_wtlive')).toHaveLength(1);

    progress('error', 10, { message: 'Disk full' });
    expect(view.result.current.install.state).toEqual({ kind: 'error', message: 'Disk full', code: undefined });

    await act(() => useInstalls.getState().start('wt-1'));
    expect(backend.call.mock.calls.filter(([cmd]) => cmd === 'install_from_wtlive')).toHaveLength(2);
  });
});
