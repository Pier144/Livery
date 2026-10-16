import { useTranslation } from 'react-i18next';
import { VehiclePicker } from '@/components/VehiclePicker';
import { vehicles as builtIn } from '@/data/vehicles';
import { useExplore } from '@/store/explore';
import type { Vehicle } from '@/types';

/**
 * Explore's 200×28 vehicle filter: a `VehiclePicker` bound to the Explore store's vehicle code.
 * Free text is allowed: Enter on text that names no suggestion searches it as a code (vehicles
 * missing from the local list).
 */
export function VehicleInput({ list = builtIn }: { list?: readonly Vehicle[] }) {
  const { t } = useTranslation();
  const vehicle = useExplore((s) => s.vehicle);
  const setVehicle = useExplore((s) => s.setVehicle);
  return (
    <VehiclePicker
      value={vehicle}
      onChange={setVehicle}
      list={list}
      allowFreeText
      label={t('explore.filters.vehicle')}
      placeholder={t('explore.filters.vehiclePlaceholder')}
      suggestionsLabel={t('explore.filters.vehicleSuggestions')}
      className="w-[200px]"
    />
  );
}
