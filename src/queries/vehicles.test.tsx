import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vehicles as builtIn } from '@/data/vehicles';
import { createQueryClient } from '@/queries/client';
import type { Settings, Vehicle } from '@/types';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from './settings';
import { useVehicles } from './vehicles';

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
