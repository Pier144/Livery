import type { Vehicle } from '@/types';

/**
 * Vehicle names in the UI language, read from the game (`game_vehicle_names`): lower-case code →
 * name, only where the name differs from the English `Vehicle.name`. Codes, filters and the backend
 * stay English; the UI shows these names and searches both.
 */
export type VehicleNames = ReadonlyMap<string, string>;

export const NO_VEHICLE_NAMES: VehicleNames = new Map();

/** The vehicle's name in the UI language, else its English name. */
export function localVehicleName(names: VehicleNames, v: Pick<Vehicle, 'code' | 'name'>): string {
  return (v.code && names.get(v.code.toLowerCase())) || v.name;
}

/** The vehicle's localized name when there is one (lower case), for searches. */
export function localNameLower(names: VehicleNames, v: Pick<Vehicle, 'code'>): string | undefined {
  return v.code ? names.get(v.code.toLowerCase())?.toLowerCase() : undefined;
}
