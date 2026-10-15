import { describe, expect, it } from 'vitest';
import { NO_VEHICLE_NAMES, localNameLower, localVehicleName } from './vehicleNames';

describe('vehicle names in the UI language', () => {
  const names = new Map([['ussr_t_34_85', 'Т-34-85']]);

  it('shows the local name, else the English one', () => {
    expect(localVehicleName(names, { code: 'USSR_T_34_85', name: 'T-34-85' })).toBe('Т-34-85');
    expect(localVehicleName(names, { code: 'us_m1a2_sep', name: 'M1A2 SEP' })).toBe('M1A2 SEP');
    expect(localVehicleName(NO_VEHICLE_NAMES, { code: 'ussr_t_34_85', name: 'T-34-85' })).toBe('T-34-85');
    expect(localVehicleName(names, { code: '', name: 'Unknown' })).toBe('Unknown');
  });

  it('gives the local name in lower case for searches', () => {
    expect(localNameLower(names, { code: 'ussr_t_34_85' })).toBe('т-34-85');
    expect(localNameLower(names, { code: 'other' })).toBeUndefined();
  });
});
