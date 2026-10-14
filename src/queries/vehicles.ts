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
  const gamePath = useSettings().data?.gamePath ?? null;
  const query = useQuery<Vehicle[], AppError>({
    queryKey: [...VEHICLES_KEY, gamePath],
    queryFn: () => call<Vehicle[]>('game_vehicles'),
    enabled: hasBackend() && gamePath !== null,
    staleTime: Infinity,
  });
  return query.data && query.data.length > 0 ? query.data : builtIn;
}
