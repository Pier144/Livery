import type { Vehicle } from '@/types';
import raw from './vehicles.json';

/**
 * Built-in vehicle list (code, name, nation, type, class): a small seed used until the game's own
 * list arrives (`useVehicles` in `src/queries/vehicles.ts`, read from the War Thunder install),
 * and by the mock backend.
 */
export const vehicles: Vehicle[] = raw as Vehicle[];
