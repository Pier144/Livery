import { describe, expect, it } from 'vitest';
import type { ForYouNew, Lineups, WtLiveSkin } from '@/types';
import { forYouRows, forYouSections, forYouVehicles, newCounts, newSkinIds, totalNew, type ForYouSection } from './forYouModel';

const LINEUPS: Lineups = {
  status: 'ok',
  savedAt: '2026-10-16T08:34:00Z',
  current: 'ussr_t_34_85',
  currentNation: 'USSR',
  nations: [
    {
      nation: 'USA',
      presets: [
        { name: 'Air', active: false, vehicles: ['f_4e', 'p-26a_34_m2'] },
        { name: 'Army', active: true, vehicles: ['us_m4_t26', 'us_m18_hellcat'] },
      ],
    },
    {
      nation: 'GER',
      presets: [
        { name: 'Heer', active: true, vehicles: ['germ_leopard_2a6'] },
        // Every vehicle already shown above: the preset is dropped.
        { name: 'Copy', active: false, vehicles: ['germ_leopard_2a6'] },
        { name: 'Old', active: false, vehicles: ['germ_leopard_2a6', 'bf-109g-6'] },
      ],
    },
    {
      nation: 'USSR',
      presets: [
        { name: '', active: false, vehicles: ['su_27', 'ussr_t_34_85'] },
        { name: 'Main', active: true, vehicles: ['ussr_t_34_85', 'ussr_is_2_1943'] },
      ],
    },
    { nation: 'ITA', presets: [{ name: 'Empty', active: true, vehicles: [] }] },
  ],
};

const summary = (sections: ForYouSection[]) => sections.map((s) => [s.nation, s.presetName, s.presetIndex, s.active, s.vehicles]);

describe('forYouSections', () => {
  it('puts the current nation first, then game order; the active preset first, then file order', () => {
    expect(summary(forYouSections(LINEUPS))).toEqual([
      ['USSR', 'Main', 1, true, ['ussr_t_34_85', 'ussr_is_2_1943']],
      // The T-34-85 is already in the active preset: only the Su-27 is left here.
      ['USSR', '', 0, false, ['su_27']],
      ['USA', 'Army', 1, true, ['us_m4_t26', 'us_m18_hellcat']],
      ['USA', 'Air', 0, false, ['f_4e', 'p-26a_34_m2']],
      ['GER', 'Heer', 0, true, ['germ_leopard_2a6']],
      ['GER', 'Old', 2, false, ['bf-109g-6']],
    ]);
  });

  it('follows game nation order whatever the file order, and without a current nation', () => {
    const shuffled: Lineups = { ...LINEUPS, currentNation: null, nations: [...LINEUPS.nations].reverse() };
    expect(forYouSections(shuffled).map((s) => s.nation)).toEqual(['USA', 'USA', 'GER', 'GER', 'USSR', 'USSR']);
  });

  it('has nothing for missing data or another status', () => {
    expect(forYouSections(undefined)).toEqual([]);
    expect(forYouSections({ status: 'off', nations: [] })).toEqual([]);
    expect(forYouSections({ ...LINEUPS, status: 'noLineups' })).toEqual([]);
  });
});

describe('forYouVehicles', () => {
  it('is the flat list in section order', () => {
    expect(forYouVehicles(forYouSections(LINEUPS))).toEqual([
      'ussr_t_34_85',
      'ussr_is_2_1943',
      'su_27',
      'us_m4_t26',
      'us_m18_hellcat',
      'f_4e',
      'p-26a_34_m2',
      'germ_leopard_2a6',
      'bf-109g-6',
    ]);
  });
});

describe('newCounts / totalNew', () => {
  const skin = (id: string) => ({ id }) as WtLiveSkin;
  const answer: ForYouNew = {
    items: [
      { vehicle: 'su_27', skin: skin('a') },
      { vehicle: 'ussr_t_34_85', skin: skin('b') },
      { vehicle: 'su_27', skin: skin('c') },
      // Beyond `checked`: not counted per vehicle.
      { vehicle: 'f_4e', skin: skin('d') },
    ],
    checked: 3,
  };
  const vehicles = ['ussr_t_34_85', 'ussr_is_2_1943', 'su_27', 'us_m4_t26', 'f_4e'];

  it('counts per vehicle, only within checked', () => {
    expect(Object.fromEntries(newCounts(answer, vehicles))).toEqual({ ussr_t_34_85: 1, su_27: 2 });
    expect(newCounts(undefined, vehicles).size).toBe(0);
  });

  it('lists the new skin ids within checked', () => {
    expect([...newSkinIds(answer, vehicles)].sort()).toEqual(['a', 'b', 'c']);
    expect(newSkinIds(undefined, vehicles).size).toBe(0);
  });

  it('totals every new skin', () => {
    expect(totalNew(answer)).toBe(4);
    expect(totalNew(undefined)).toBe(0);
  });
});

describe('forYouRows', () => {
  it('a header per section, then a row per vehicle, with unique keys', () => {
    const sections = forYouSections(LINEUPS);
    const rows = forYouRows(sections);
    expect(rows.map((r) => (r.kind === 'header' ? `# ${r.section.nation} ${r.section.presetName}` : r.code))).toEqual([
      '# USSR Main',
      'ussr_t_34_85',
      'ussr_is_2_1943',
      '# USSR ',
      'su_27',
      '# USA Army',
      'us_m4_t26',
      'us_m18_hellcat',
      '# USA Air',
      'f_4e',
      'p-26a_34_m2',
      '# GER Heer',
      'germ_leopard_2a6',
      '# GER Old',
      'bf-109g-6',
    ]);
    expect(rows[1]).toMatchObject({ kind: 'vehicle', code: 'ussr_t_34_85', section: sections[0] });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
