import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vehicles as builtIn } from '@/data/vehicles';
import { createQueryClient } from '@/queries/client';
import type { Settings, Vehicle } from '@/types';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from './settings';
import { useVehicleName, useVehicleNames, useVehicles } from './vehicles';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

const GAME: Vehicle[] = [
  { code: 'germ_pz_ii', name: 'Pz.II C', nation: 'GER', type: 'ground', class: 'Light tank', rank: 1 },
];

function wrap(settings: Partial<Settings>) {
  const client = createQueryClient();
  client.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...settings });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function render(settings: Partial<Settings>) {
  const client = createQueryClient();
  client.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...settings });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useVehicles(), { wrapper });
}

beforeEach(() => backend.call.mockReset());

describe('useVehicles', () => {
  it('uses the game’s own list once the backend has read it', async () => {
    backend.call.mockResolvedValue(GAME);
    const { result } = render({ gamePath: 'D:\War Thunder' });
    expect(result.current).toBe(builtIn);
    await waitFor(() => expect(result.current).toEqual(GAME));
    expect(backend.call).toHaveBeenCalledWith('game_vehicles', undefined);
  });

  it('keeps the built-in list without a game folder or when the game’s list is empty', async () => {
    const { result } = render({});
    expect(result.current).toBe(builtIn);
    expect(backend.call).not.toHaveBeenCalled();
    backend.call.mockResolvedValue([]);
    const empty = render({ gamePath: 'D:\War Thunder' });
    await waitFor(() => expect(backend.call).toHaveBeenCalled());
    expect(empty.result.current).toBe(builtIn);
  });
});

describe('useVehicleNames', () => {
  it('asks for the names in the UI language and shows them, English as the fallback', async () => {
    backend.call.mockResolvedValue({ GERM_PZ_II: 'Танк Pz.II C' });
    const { result } = renderHook(() => ({ names: useVehicleNames(), nameOf: useVehicleName() }), {
      wrapper: wrap({ gamePath: 'D:\War Thunder', language: 'ru' }),
    });
    await waitFor(() => expect(result.current.names.size).toBe(1));
    expect(backend.call).toHaveBeenCalledWith('game_vehicle_names', { language: 'ru' });
    expect(result.current.nameOf(GAME[0]!)).toBe('Танк Pz.II C');
    expect(result.current.nameOf({ code: 'other', name: 'Other' })).toBe('Other');
  });

  it('asks nothing in English, without a game folder or when the game isn’t read', () => {
    for (const settings of [{ gamePath: 'D:\WT', language: 'en' as const }, { language: 'ru' as const }, { gamePath: 'D:\WT', language: 'ru' as const, readGameData: false }]) {
      const { result } = renderHook(() => useVehicleNames(), { wrapper: wrap(settings) });
      expect(result.current.size).toBe(0);
    }
    expect(backend.call).not.toHaveBeenCalled();
  });
});
