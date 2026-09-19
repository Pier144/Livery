import { describe, expect, it } from 'vitest';
import { NO_FILTERS } from '@/store/hangar';
import type { HangarSkin, Vehicle } from '@/types';
import {
  buildRows,
  columnsFor,
  estimateRowSize,
  filterSkins,
  groupSkins,
  hangarStats,
  hasFilters,
  needsAttention,
  orderedIds,
  presentValues,
  type CardsRow,
  type ItemRow,
} from './hangarModel';

const vehicle = (code: string, name: string, nation: Vehicle['nation'], type: Vehicle['type']): Vehicle => ({
  code,
  name,
  nation,
  type,
  class: '',
});
const TIGER = vehicle('germ_pzkpfw_VI_ausf_e_tiger', 'Tiger H1', 'GER', 'ground');
const T34 = vehicle('ussr_t_34_85', 'T-34-85', 'USSR', 'ground');
const F4 = vehicle('f_4e', 'F-4E Phantom II', 'USA', 'air');
const NO_NAME = vehicle('us_m1a2_abrams', '', 'USA', 'ground');
const UNKNOWN = vehicle('', 'Unknown vehicle', 'UNK', 'air');

let n = 0;
function skin(name: string, v: Vehicle, extra: Partial<HangarSkin> = {}): HangarSkin {
  n += 1;
  return {
    id: `s${n}`,
    folder: name,
    name,
    vehicle: v,
    origin: 'imported',
    sizeBytes: 10 * 1024 * 1024,
    active: true,
    installedAt: '2026-09-19T10:00:00Z',
    ...extra,
  };
}

const SKINS = [
  skin('Winter whitewash', T34, { attention: [{ kind: 'missingTexture', message: 'x', file: 'turret_c.dds' }] }),
  skin('Factory olive', T34, { origin: 'mine', active: false }),
  skin('Ambush', TIGER, { origin: 'wtlive' }),
  skin('desert tan', TIGER, { active: false, sizeBytes: 5 * 1024 * 1024 }),
  skin('SEA Camo', F4, { origin: 'wtlive' }),
  skin('Orphan', UNKNOWN, { attention: [{ kind: 'noBlk', message: 'no blk' }] }),
  skin('Desert Storm', NO_NAME),
];

describe('filterSkins', () => {
  it('matches the skin name, vehicle name or code, ignoring case and outer spaces', () => {
    expect(filterSkins(SKINS, 'DESERT', NO_FILTERS).map((s) => s.name)).toEqual(['desert tan', 'Desert Storm']);
    expect(filterSkins(SKINS, ' tiger h1 ', NO_FILTERS).map((s) => s.name)).toEqual(['Ambush', 'desert tan']);
    expect(filterSkins(SKINS, 'F_4E', NO_FILTERS).map((s) => s.name)).toEqual(['SEA Camo']);
    expect(filterSkins(SKINS, '', NO_FILTERS)).toHaveLength(SKINS.length);
  });

  it('combines search and chips with AND', () => {
    expect(filterSkins(SKINS, '', { ...NO_FILTERS, nation: 'USSR' }).map((s) => s.name)).toEqual(['Winter whitewash', 'Factory olive']);
    expect(filterSkins(SKINS, '', { nation: 'USSR', type: 'ground', origin: 'mine' }).map((s) => s.name)).toEqual(['Factory olive']);
    expect(filterSkins(SKINS, 'winter', { ...NO_FILTERS, origin: 'mine' })).toEqual([]);
    expect(filterSkins(SKINS, '', { ...NO_FILTERS, type: 'air', origin: 'wtlive' }).map((s) => s.name)).toEqual(['SEA Camo']);
    expect(filterSkins(SKINS, 'desert', { ...NO_FILTERS, nation: 'USA' }).map((s) => s.name)).toEqual(['Desert Storm']);
  });

  it('knows when anything is filtered', () => {
    expect(hasFilters('  ', NO_FILTERS)).toBe(false);
    expect(hasFilters('t', NO_FILTERS)).toBe(true);
    expect(hasFilters('', { ...NO_FILTERS, origin: 'mine' })).toBe(true);
  });
});

describe('presentValues', () => {
  it('lists only values present, in a fixed order, plus the active filter', () => {
    expect(presentValues(SKINS)).toEqual({
      nations: ['USA', 'GER', 'USSR', 'UNK'],
      types: ['ground', 'air'],
      origins: ['wtlive', 'imported', 'mine'],
    });
    expect(presentValues(SKINS.slice(0, 1), { nation: 'JPN', type: 'naval', origin: null })).toEqual({
      nations: ['USSR', 'JPN'],
      types: ['ground', 'naval'],
      origins: ['imported'],
    });
  });
});

describe('groupSkins', () => {
  const groups = groupSkins(SKINS, 'Unknown');

  it('groups by vehicle code, titles by name (code as fallback), sorted by title, unknown last', () => {
    expect(groups.map((g) => [g.title, g.code, g.skins.length])).toEqual([
      ['F-4E Phantom II', 'f_4e', 1],
      ['T-34-85', 'ussr_t_34_85', 2],
      ['Tiger H1', 'germ_pzkpfw_VI_ausf_e_tiger', 2],
      ['us_m1a2_abrams', 'us_m1a2_abrams', 1],
      ['Unknown', '', 1],
    ]);
    expect(groups.at(-1)?.unknown).toBe(true);
  });

  it('sorts skins by name inside a group, case-insensitively', () => {
    expect(groups[1]?.skins.map((s) => s.name)).toEqual(['Factory olive', 'Winter whitewash']);
    expect(groups[2]?.skins.map((s) => s.name)).toEqual(['Ambush', 'desert tan']);
  });

  it('gives the on-screen order of ids', () => {
    expect(orderedIds(groups)).toEqual(groups.flatMap((g) => g.skins.map((s) => s.id)));
  });
});

describe('hangarStats', () => {
  it('counts skins, active ones, size on disk and skins needing attention', () => {
    expect(hangarStats(SKINS)).toEqual({ count: 7, active: 5, sizeBytes: 65 * 1024 * 1024, attention: 2 });
    expect(hangarStats([])).toEqual({ count: 0, active: 0, sizeBytes: 0, attention: 0 });
  });
});

describe('row model', () => {
  it('fits auto-fill minmax(220px, 1fr) with a 12px gap', () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(451)).toBe(1);
    expect(columnsFor(452)).toBe(2);
    expect(columnsFor(1000)).toBe(4);
    expect(columnsFor(1624)).toBe(7);
  });

  it('grid: a header per group, then card lines of `cols` cards', () => {
    const groups = groupSkins(SKINS, 'Unknown');
    const rows = buildRows(groups, 'grid', 1);
    expect(rows.map((r) => r.kind)).toEqual(['header', 'cards', 'header', 'cards', 'cards', 'header', 'cards', 'cards', 'header', 'cards', 'header', 'cards']);
    const wide = buildRows(groups, 'grid', 4);
    const t34Cards = wide.filter((r): r is CardsRow => r.kind === 'cards' && r.groupIndex === 1);
    expect(t34Cards).toHaveLength(1);
    expect(t34Cards[0]?.skins.map((s) => s.name)).toEqual(['Factory olive', 'Winter whitewash']);
    // The group gap sits under each group's last line, except the very last one.
    expect(wide.filter((r) => r.gapAfter).length).toBe(groups.length - 1);
    expect(wide.at(-1)?.gapAfter).toBe(false);
  });

  it('list: one row per skin, first/last flags per group; keys are unique', () => {
    const rows = buildRows(groupSkins(SKINS, 'Unknown'), 'list', 1);
    const items = rows.filter((r): r is ItemRow => r.kind === 'item');
    expect(items).toHaveLength(SKINS.length);
    const t34 = items.filter((r) => r.groupIndex === 1);
    expect(t34.map((r) => [r.firstInGroup, r.lastInGroup])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('estimates taller card lines when a card needs attention', () => {
    const lines = buildRows(groupSkins(SKINS, 'Unknown'), 'grid', 1).filter((r): r is CardsRow => r.kind === 'cards');
    const flagged = lines.find((r) => r.skins.some(needsAttention));
    const plain = lines.find((r) => !r.skins.some(needsAttention));
    if (!flagged || !plain) throw new Error('fixture needs both kinds of lines');
    const same = { gapAfter: false, lastInGroup: true };
    expect(estimateRowSize({ ...flagged, ...same }, 220, 1)).toBeGreaterThan(estimateRowSize({ ...plain, ...same }, 220, 1));
  });
});
