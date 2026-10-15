import type { TFunction } from 'i18next';
import en from '@/i18n/en.json';

type ClassKey = keyof typeof en.common.vehicleClass;

/** English class (as the backend and the filters keep it) → its key under `common.vehicleClass`. */
const BY_ENGLISH = new Map(Object.entries(en.common.vehicleClass).map(([key, text]) => [text.toLowerCase(), key as ClassKey]));

/**
 * A vehicle class in the UI language ("Medium tank" → "Средний танк"), with the game's own terms.
 * The class itself stays English everywhere else (filters, the backend); an unknown one shows as is.
 */
export function vehicleClassLabel(t: TFunction, vehicleClass: string): string {
  const key = BY_ENGLISH.get(vehicleClass.trim().toLowerCase());
  return key ? t(`common.vehicleClass.${key}`) : vehicleClass;
}
