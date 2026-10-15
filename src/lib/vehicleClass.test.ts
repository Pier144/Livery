import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { vehicleClassLabel } from './vehicleClass';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('vehicleClassLabel', () => {
  it('shows a known class in the UI language and an unknown one as is', async () => {
    expect(vehicleClassLabel(i18n.t, 'Medium tank')).toBe('Medium tank');
    await i18n.changeLanguage('ru');
    expect(vehicleClassLabel(i18n.t, 'Medium tank')).toBe('Средний танк');
    expect(vehicleClassLabel(i18n.t, 'mbt')).toBe('ОБТ');
    expect(vehicleClassLabel(i18n.t, 'Hovercraft')).toBe('Hovercraft');
  });

  it('covers every class the backend sends', async () => {
    const { readFileSync } = await import('node:fs');
    const rust = readFileSync('src-tauri/src/game/catalog.rs', 'utf8');
    const classes = [...rust.matchAll(/VehicleType::\w+, "([^"]+)"\)/g)].map((m) => m[1]!);
    expect(classes.length).toBeGreaterThan(20);
    await i18n.changeLanguage('de');
    expect(classes.filter((c) => vehicleClassLabel(i18n.t, c) === c && c !== 'Bomber')).toEqual([]);
  });
});
