import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/queries/client';
import type { Settings } from '@/types';
import { DEFAULT_SETTINGS, SETTINGS_KEY, useUpdateSettings } from './settings';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

/** A `set_settings` call the test answers by hand. */
interface Pending {
  patch: Partial<Settings>;
  answer: (settings: Settings) => void;
  refuse: (error: unknown) => void;
}

let pending: Pending[] = [];

beforeEach(() => {
  pending = [];
  backend.call.mockReset();
  backend.call.mockImplementation(
    (_cmd, args) =>
      new Promise((answer, refuse) => {
        pending.push({ patch: (args as { patch: Partial<Settings> }).patch, answer, refuse });
      }),
  );
});

function setup() {
  const client = createQueryClient();
  client.setQueryData(SETTINGS_KEY, DEFAULT_SETTINGS);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  // Two controls, each with its own mutation, as in Settings.
  const hooks = renderHook(() => ({ language: useUpdateSettings(), backups: useUpdateSettings() }), { wrapper });
  return { client, hooks };
}

/** Lets pending promises and TanStack's scheduling run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe('useUpdateSettings', () => {
  it('sends patches one after another, in the order they were made', async () => {
    const { client, hooks } = setup();
    act(() => {
      hooks.result.current.language.mutate({ language: 'it' });
      hooks.result.current.backups.mutate({ backups: false });
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    await settle();
    expect(pending.map((p) => p.patch)).toEqual([{ language: 'it' }]);
    expect(hooks.result.current.backups.isPaused).toBe(true);

    const afterFirst: Settings = { ...DEFAULT_SETTINGS, language: 'it' };
    act(() => pending[0]?.answer(afterFirst));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.patch).toEqual({ backups: false });
    expect(client.getQueryData(SETTINGS_KEY)).toEqual(afterFirst);

    const afterBoth: Settings = { ...afterFirst, backups: false };
    act(() => pending[1]?.answer(afterBoth));
    await waitFor(() => expect(hooks.result.current.backups.isSuccess).toBe(true));
    expect(client.getQueryData(SETTINGS_KEY)).toEqual(afterBoth);
  });

  it('a failed patch doesn’t hold up the next one', async () => {
    const { client, hooks } = setup();
    act(() => {
      hooks.result.current.language.mutate({ language: 'it' });
      hooks.result.current.backups.mutate({ backups: false });
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0]?.refuse({ code: 'io', message: 'File system error' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(hooks.result.current.language.error).toEqual({ code: 'io', message: 'File system error' });

    const saved: Settings = { ...DEFAULT_SETTINGS, backups: false };
    act(() => pending[1]?.answer(saved));
    await waitFor(() => expect(client.getQueryData(SETTINGS_KEY)).toEqual(saved));
  });
});
