import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { vehicles } from '@/data/vehicles';
import { WTLIVE_KEY } from '@/queries/wtlive';
import { NO_EXPLORE_FILTERS, type ExploreFilters } from '@/store/explore';
import type { SearchResult, Vehicle, WtLiveSkin } from '@/types';
import {
  activeFilters,
  authorSkinCount,
  buildRows,
  cachedWtLiveSkins,
  classOptions,
  columnsFor,
  compactNumber,
  EXPLORE_NATIONS,
  formatPostDate,
  matchVehicles,
  stepText,
  toSearchParams,
  vehicleLabel,
  type FilterLabels,
} from './exploreModel';

const filters = (over: Partial<ExploreFilters> = {}): ExploreFilters => ({ ...NO_EXPLORE_FILTERS, ...over });

const skin = (id: string, extra: Partial<WtLiveSkin> = {}): WtLiveSkin => ({
  id,
  name: `Skin ${id}`,
  vehicle: { code: 'su_27', name: 'Su-27', nation: 'USSR', type: 'air', class: 'Fighter' },
  author: { id: 'a1', name: 'Flanker_Ivan', url: 'https://example.invalid' },
  category: 'Historical',
  downloads: 1,
  likes: 1,
  postedAt: '2026-09-12T10:00:00Z',
  sizeBytes: 1,
  images: [],
  postUrl: '',
  downloadUrl: '',
  ...extra,
});

describe('toSearchParams', () => {
  it('sends only the filters that are set', () => {
    expect(toSearchParams(filters(), 'downloads')).toEqual({ sort: 'downloads' });
    expect(
      toSearchParams(
        filters({ q: '  kessler ', nation: 'GER', type: 'ground', class: 'MBT', vehicle: 'germ_leopard_2a6', category: 'Fictional' }),
        'likes',
      ),
    ).toEqual({ sort: 'likes', q: 'kessler', nation: 'GER', type: 'ground', class: 'MBT', vehicle: 'germ_leopard_2a6', category: 'Fictional' });
  });

  it('drops blank text', () => {
    expect(toSearchParams(filters({ q: '   ' }), 'name')).toEqual({ sort: 'name' });
  });
});

describe('activeFilters', () => {
  const labels: FilterLabels = {
    nation: (n) => `nation:${n}`,
    type: (t) => `type:${t}`,
    category: (c) => `cat:${c}`,
    vehicle: (code) => vehicleLabel(vehicles, code),
    query: (q) => `“${q}”`,
  };

  it('is empty without filters', () => {
    expect(activeFilters(filters(), labels)).toEqual([]);
  });

  it('lists nation, type, class, vehicle, category, then the text', () => {
    const list = activeFilters(
      filters({ q: 'Kessler_Wolf', category: 'Historical', vehicle: 'germ_leopard_2a6', class: 'MBT', type: 'ground', nation: 'GER' }),
      labels,
    );
    expect(list).toEqual([
      { key: 'nation', label: 'nation:GER' },
      { key: 'type', label: 'type:ground' },
      { key: 'class', label: 'MBT' },
      { key: 'vehicle', label: 'Leopard 2A6' },
      { key: 'category', label: 'cat:Historical' },
      { key: 'q', label: '“Kessler_Wolf”' },
    ]);
  });

  it('shows an unknown vehicle code as itself', () => {
    expect(activeFilters(filters({ vehicle: 'ussr_is_7' }), labels)).toEqual([{ key: 'vehicle', label: 'ussr_is_7' }]);
  });
});

describe('options', () => {
  it('nations leave out the unknown fallback', () => {
    expect(EXPLORE_NATIONS).not.toContain('UNK');
    expect(EXPLORE_NATIONS[0]).toBe('USA');
  });

  it('classes come from the vehicle list, grouped by type, narrowed by the type filter', () => {
    expect(classOptions(vehicles, null, null)).toEqual(['Heavy tank', 'Medium tank', 'MBT', 'Strike aircraft', 'Fighter']);
    expect(classOptions(vehicles, 'air', null)).toEqual(['Strike aircraft', 'Fighter']);
    // The current class stays offered even when the type no longer has it.
    expect(classOptions(vehicles, 'air', 'MBT')).toEqual(['Strike aircraft', 'Fighter', 'MBT']);
  });
});

describe('matchVehicles', () => {
  const list: Vehicle[] = vehicles;

  it('matches name or code, case-insensitively, prefix matches first', () => {
    expect(matchVehicles(list, 'LEO').map((v) => v.code)).toEqual(['germ_leopard_2a6']);
    expect(matchVehicles(list, 'su_27').map((v) => v.name)).toEqual(['Su-27']);
    expect(matchVehicles(list, 'ti').map((v) => v.name)).toEqual(['Tiger II (H)']);
    expect(matchVehicles(list, 'germ').map((v) => v.name)).toEqual(['Tiger II (H)', 'Leopard 2A6']);
    // Anywhere in the name or code counts too, after the prefix matches.
    expect(matchVehicles(list, 'ariete').map((v) => v.code)).toEqual(['it_c1_ariete']);
    expect(matchVehicles(list, 'c1_').map((v) => v.name)).toEqual(['Ariete']);
  });

  it('is empty for blank text and capped', () => {
    expect(matchVehicles(list, '  ')).toEqual([]);
    expect(matchVehicles(list, 'e', 3)).toHaveLength(3);
  });
});

describe('compactNumber', () => {
  it('abbreviates thousands and millions like the prototype', () => {
    expect(compactNumber(512, 'en')).toBe('512');
    expect(compactNumber(1000, 'en')).toBe('1k');
    expect(compactNumber(1932, 'en')).toBe('1.9k');
    expect(compactNumber(24120, 'en')).toBe('24.1k');
    expect(compactNumber(42806, 'en')).toBe('42.8k');
    expect(compactNumber(1_284_000, 'en')).toBe('1.3M');
    expect(compactNumber(999_960, 'en')).toBe('1M');
  });

  it('uses the language’s decimal separator', () => {
    expect(compactNumber(24120, 'it')).toBe('24,1k');
  });

  it('never shows negative or broken numbers', () => {
    expect(compactNumber(-5, 'en')).toBe('0');
    expect(compactNumber(Number.NaN, 'en')).toBe('0');
  });
});

describe('formatPostDate', () => {
  it('formats like the prototype in English and natively in Italian', () => {
    expect(formatPostDate('2026-09-12T10:00:00Z', 'en')).toBe('12 Sep 2026');
    expect(formatPostDate('2026-09-12T10:00:00Z', 'it')).toBe('12 set 2026');
    expect(formatPostDate('not a date', 'en')).toBe('');
  });
});

describe('stepText', () => {
  it('walks Download → Extract → Verify → Done', () => {
    expect(stepText('download', 34)).toEqual({ done: [], now: 'download', pct: 34, next: ['extract', 'verify', 'done'] });
    expect(stepText('extract', 56)).toEqual({ done: ['download'], now: 'extract', pct: 56, next: ['verify', 'done'] });
    expect(stepText('verify', 90.4)).toEqual({ done: ['download', 'extract'], now: 'verify', pct: 90, next: ['done'] });
  });

  it('ticks every step once done', () => {
    expect(stepText('done', 100)).toEqual({ done: ['download', 'extract', 'verify'], now: 'done', pct: null, next: [] });
  });

  it('clamps the percentage', () => {
    expect(stepText('download', 140).pct).toBe(100);
    expect(stepText('download', -3).pct).toBe(0);
  });
});

describe('grid rows', () => {
  it('fits 250px cards with 16px gaps', () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(515)).toBe(1);
    expect(columnsFor(516)).toBe(2);
    expect(columnsFor(1000)).toBe(3);
    expect(columnsFor(1048)).toBe(4);
  });

  it('chunks skins into lines and adds the loading / failed tail', () => {
    const skins = Array.from({ length: 7 }, (_, i) => skin(`s${i}`));
    const rows = buildRows(skins, 3);
    expect(rows.map((r) => (r.kind === 'cards' ? r.skins.length : r.kind))).toEqual([3, 3, 1]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(buildRows(skins, 3, 'loading').at(-1)?.kind).toBe('loading');
    expect(buildRows(skins, 3, 'moreFailed').at(-1)?.kind).toBe('moreFailed');
    expect(buildRows([], 3)).toEqual([]);
  });
});

describe('WT Live cache', () => {
  it('collects every cached skin once: search pages, single pages, posts and following-new', () => {
    const qc = new QueryClient();
    const page = (ids: string[]): SearchResult => ({ items: ids.map((id) => skin(id)), total: 9, tookMs: 20 });
    qc.setQueryData([...WTLIVE_KEY, 'search-pages', { sort: 'downloads' }], { pages: [page(['s1', 's2']), page(['s3'])], pageParams: [0, 1] });
    qc.setQueryData([...WTLIVE_KEY, 'search', { sort: 'likes', page: 0 }], page(['s2', 's4']));
    qc.setQueryData([...WTLIVE_KEY, 'post', 's5'], skin('s5'));
    qc.setQueryData([...WTLIVE_KEY, 'following-new', [], ['a1']], [skin('s6'), skin('s1')]);
    qc.setQueryData(['hangar'], [{ id: 'h1', name: 'not WT Live', vehicle: {}, author: {} }]);
    expect(cachedWtLiveSkins(qc).map((s) => s.id).sort()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('finds an author’s skin count on any cached skin', () => {
    const skins = [skin('s1'), skin('s2', { author: { id: 'a2', name: 'Kessler_Wolf', url: '', skinCount: 14 } })];
    expect(authorSkinCount(skins, 'a2')).toBe(14);
    expect(authorSkinCount(skins, 'a1')).toBeUndefined();
  });
});
