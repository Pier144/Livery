import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { vehicles as builtIn } from '@/data/vehicles';
import { call, hasBackend } from '@/lib/tauri';
import { NO_VEHICLE_NAMES, localVehicleName, type VehicleNames } from '@/lib/vehicleNames';
import type { AppError, Vehicle } from '@/types';
import { useSettings } from './settings';

export const VEHICLES_KEY = ['game', 'vehicles'] as const;
export const VEHICLE_NAMES_KEY = ['game', 'vehicleNames'] as const;

/**
 * Every vehicle of the game, read by the backend from the saved War Thunder install
 * (`game_vehicles`, cached there until the game updates). Until it arrives, without a game
 * folder, or when the game's files can't be read, the built-in list in `src/data/vehicles.json`.
 */
export function useVehicles(): readonly Vehicle[] {
  const settings = useSettings().data;
  const gamePath = settings?.gamePath ?? null;
  // Settings → Game → Read data from the game: switching it asks the backend again.
  const fromGame = settings?.readGameData !== false;
  const query = useQuery<Vehicle[], AppError>({
    queryKey: [...VEHICLES_KEY, gamePath, fromGame],
    queryFn: () => call<Vehicle[]>('game_vehicles'),
    enabled: hasBackend() && gamePath !== null,
    staleTime: Infinity,
  });
  return query.data && query.data.length > 0 ? query.data : builtIn;
}

/**
 * The vehicles' names in the UI language (`game_vehicle_names`, from the game's `units.csv`), keyed
 * by lower-case code; empty for English, without a game folder or when the game's files aren't
 * read, so the English names show.
 */
export function useVehicleNames(): VehicleNames {
  const settings = useSettings().data;
  const gamePath = settings?.gamePath ?? null;
  const fromGame = settings?.readGameData !== false;
  const language = settings?.language ?? 'en';
  const query = useQuery<Record<string, string>, AppError>({
    queryKey: [...VEHICLE_NAMES_KEY, gamePath, fromGame, language],
    queryFn: () => call<Record<string, string>>('game_vehicle_names', { language }),
    enabled: hasBackend() && gamePath !== null && fromGame && language !== 'en',
    staleTime: Infinity,
  });
  const data = language === 'en' ? undefined : query.data;
  return useMemo(
    () => (data ? new Map(Object.entries(data).map(([code, name]) => [code.toLowerCase(), name])) : NO_VEHICLE_NAMES),
    [data],
  );
}

/** `useVehicleNames` as a function: a vehicle's name in the UI language, else its English name. */
export function useVehicleName(): (v: Pick<Vehicle, 'code' | 'name'>) => string {
  const names = useVehicleNames();
  return useCallback((v) => localVehicleName(names, v), [names]);
}
