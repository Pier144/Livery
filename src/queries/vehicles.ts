import { useQuery } from '@tanstack/react-query';
import { vehicles as builtIn } from '@/data/vehicles';
import { call, hasBackend } from '@/lib/tauri';
import type { AppError, Vehicle } from '@/types';
import { useSettings } from './settings';

export const VEHICLES_KEY = ['game', 'vehicles'] as const;

/**
 * Every vehicle of the game, read by the backend from the saved War Thunder install
 * (`game_vehicles`, cached there until the game updates). Until it arrives, without a game
 * folder, or when the game's files can't be read, the built-in list in `src/data/vehicles.json`.
 */
export function useVehicles(): readonly Vehicle[] {
  const settings = useSettings().data;
  const gamePath = settings?.gamePath ?? null;
  // Settings → Game → Read the vehicle list: switching it asks the backend again.
  const fromGame = settings?.readGameData !== false;
  const query = useQuery<Vehicle[], AppError>({
    queryKey: [...VEHICLES_KEY, gamePath, fromGame],
    queryFn: () => call<Vehicle[]>('game_vehicles'),
    enabled: hasBackend() && gamePath !== null,
    staleTime: Infinity,
  });
  return query.data && query.data.length > 0 ? query.data : builtIn;
}
