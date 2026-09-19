import { describe, expect, it, vi } from 'vitest';
import { vehicles } from '@/data/vehicles';
import i18n from '@/i18n';
import type { Vehicle } from '@/types';
import { buildPaletteItems, PALETTE_MAX_RESULTS, type PaletteContext, type PaletteSkin } from './paletteItems';

function ctx(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return { t: (key) => i18n.t(key), vehicles, skins: [], go: vi.fn(), ...overrides };
}

const skin = (id: string, name: string, vehicle = 'Leopard 2A6', author = 'Kestrel'): PaletteSkin => ({
  id,
  name,
  vehicle: { name: vehicle },
  author: { name: author },
});

describe('buildPaletteItems', () => {
  it('empty query → 5 actions, then the first 4 vehicles', () => {
    const items = buildPaletteItems('', ctx());
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.kind)).toEqual([...Array(5).fill('action'), ...Array(4).fill('vehicle')]);
    expect(items.slice(0, 5).map((i) => [i.label, i.hint])).toEqual([
      ['Go to Explore', '1'],
      ['Go to My Hangar', '2'],
      ['Go to Collections', '3'],
      ['Open Install queue', '4'],
      ['Open Settings', '5'],
    ]);
    expect(items.slice(5).map((i) => i.label)).toEqual(vehicles.slice(0, 4).map((v) => v.name));
  });

  it('treats a whitespace-only query as empty', () => {
    expect(buildPaletteItems('   ', ctx())).toHaveLength(9);
  });

  it('finds a vehicle by name, case-insensitively, with its code as hint', () => {
    const items = buildPaletteItems('LEO', ctx());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'vehicle', label: 'Leopard 2A6', hint: 'germ_leopard_2a6' });
  });

  it('finds a vehicle by code', () => {
    const items = buildPaletteItems('su_27', ctx());
    expect(items.map((i) => i.label)).toEqual(['Su-27']);
  });

  it('finds an action by label and runs it', () => {
    const go = vi.fn();
    const items = buildPaletteItems('hangar', ctx({ go }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'action', label: 'Go to My Hangar' });
    items[0]?.run();
    expect(go).toHaveBeenCalledWith('hangar');
  });

  it('vehicles jump to Explore', () => {
    const go = vi.fn();
    buildPaletteItems('ariete', ctx({ go }))[0]?.run();
    expect(go).toHaveBeenCalledWith('explore');
  });

  it('orders skins → vehicles → actions and matches skin hints ("vehicle · author")', () => {
    const skins = [skin('s1', 'Bundeswehr Flecktarn'), skin('s2', 'Winter wash', 'T-34-85', 'Oleg')];
    const items = buildPaletteItems('leopard', ctx({ skins }));
    expect(items.map((i) => [i.kind, i.label, i.hint])).toEqual([
      ['skin', 'Bundeswehr Flecktarn', 'Leopard 2A6 · Kestrel'],
      ['vehicle', 'Leopard 2A6', 'germ_leopard_2a6'],
    ]);
    expect(buildPaletteItems('oleg', ctx({ skins })).map((i) => i.label)).toEqual(['Winter wash']);
  });

  it('skins open their detail when available, Explore otherwise', () => {
    const skins = [skin('s1', 'Bundeswehr Flecktarn')];
    const openSkin = vi.fn();
    buildPaletteItems('flecktarn', ctx({ skins, openSkin }))[0]?.run();
    expect(openSkin).toHaveBeenCalledWith('s1');
    const go = vi.fn();
    buildPaletteItems('flecktarn', ctx({ skins, go }))[0]?.run();
    expect(go).toHaveBeenCalledWith('explore');
  });

  it(`caps the results at ${PALETTE_MAX_RESULTS}`, () => {
    const many: Vehicle[] = Array.from({ length: 20 }, (_, i) => ({
      code: `test_${i}`,
      name: `Test ${i}`,
      nation: 'ITA',
      type: 'ground',
      class: 'MBT',
    }));
    const items = buildPaletteItems('test', ctx({ vehicles: many }));
    expect(items).toHaveLength(PALETTE_MAX_RESULTS);
    expect(items.map((i) => i.hint)).toEqual(many.slice(0, 9).map((v) => v.code));
    // Also when the matches span skins and vehicles.
    const skins = Array.from({ length: 6 }, (_, i) => skin(`s${i}`, `Test skin ${i}`));
    expect(buildPaletteItems('test', ctx({ vehicles: many, skins }))).toHaveLength(PALETTE_MAX_RESULTS);
  });

  it('returns [] when nothing matches', () => {
    expect(buildPaletteItems('zzzz', ctx())).toEqual([]);
  });

  it('item ids are unique', () => {
    const ids = buildPaletteItems('', ctx()).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
