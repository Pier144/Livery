import type { Vehicle } from '@/types';
import raw from './vehicles.json';

/**
 * Local vehicle list (code, name, nation, type, class).
 * M1 ships a placeholder seed; M5 replaces it with the full list built from a public datamine.
 */
export const vehicles: Vehicle[] = raw as Vehicle[];
