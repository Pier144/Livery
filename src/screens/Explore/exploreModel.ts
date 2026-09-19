// Pure Explore logic: filters → search params, the active-filters line, vehicle suggestions,
// number/date formatting, install step text, the virtual grid's row model and the WT Live skins
// already in the query cache. No React, no i18n (labels come in as arguments).

import type { QueryClient } from '@tanstack/react-query';
import { formatShortDate } from '@/lib/format';
import { WTLIVE_KEY } from '@/queries/wtlive';
import { NATION_ORDER, TYPE_ORDER } from '@/screens/Hangar/hangarModel';
import type { ExploreFilterKey, ExploreFilters } from '@/store/explore';
import type { Category, InstallStep, Nation, SearchParams, SortOrder, Vehicle, VehicleType, WtLiveSkin } from '@/types';

// ── Options ─────────────────────────────────────────────────────────────────

/** Nation chip options, in game order (the `UNK` fallback is not a filter). */
export const EXPLORE_NATIONS: readonly Nation[] = NATION_ORDER.filter((n) => n !== 'UNK');
export const EXPLORE_TYPES: readonly VehicleType[] = TYPE_ORDER;
export const EXPLORE_CATEGORIES: readonly Category[] = ['Historical', 'Semi-historical', 'Fictional', 'Camouflage', 'Other'];
export const EXPLORE_SORTS: readonly SortOrder[] = ['downloads', 'likes', 'newest', 'name'];

/**
 * Class chip options from the local vehicle list: grouped by vehicle type (game order), first
 * appearance inside a type. With a type filter only that type's classes are offered (the others
 * could only empty the grid); the current class is always kept so the chip never hides it.
 */
export function classOptions(list: readonly Vehicle[], type: VehicleType | null, current: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of TYPE_ORDER) {
    if (type !== null && t !== type) continue;
    for (const v of list) {
      if (v.type !== t || !v.class || seen.has(v.class)) continue;
      seen.add(v.class);
      out.push(v.class);
    }
  }
  if (current !== null && !seen.has(current)) out.push(current);
  return out;
}

// ── Filters → search ────────────────────────────────────────────────────────

/** `wtlive_search` params (without the page): only the filters that are set, text trimmed. */
export function toSearchParams(filters: ExploreFilters, sort: SortOrder): Omit<SearchParams, 'page'> {
  const params: Omit<SearchParams, 'page'> = { sort };
  const q = filters.q.trim();
  if (q) params.q = q;
  if (filters.nation) params.nation = filters.nation;
  if (filters.type) params.type = filters.type;
  if (filters.class) params.class = filters.class;
  if (filters.vehicle) params.vehicle = filters.vehicle;
  if (filters.category) params.category = filters.category;
  return params;
}

export interface ActiveFilter {
  key: ExploreFilterKey;
  label: string;
}

export interface FilterLabels {
  nation: (nation: Nation) => string;
  type: (type: VehicleType) => string;
  category: (category: Category) => string;
  /** Vehicle code → shown name. */
  vehicle: (code: string) => string;
  /** Free text → shown label (quoted). */
  query: (q: string) => string;
}

/** The active-filters line, in the prototype's order: nation, type, class, vehicle, category, text. */
export function activeFilters(filters: ExploreFilters, labels: FilterLabels): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  if (filters.nation) out.push({ key: 'nation', label: labels.nation(filters.nation) });
  if (filters.type) out.push({ key: 'type', label: labels.type(filters.type) });
  if (filters.class) out.push({ key: 'class', label: filters.class });
  if (filters.vehicle) out.push({ key: 'vehicle', label: labels.vehicle(filters.vehicle) });
  if (filters.category) out.push({ key: 'category', label: labels.category(filters.category) });
  const q = filters.q.trim();
  if (q) out.push({ key: 'q', label: labels.query(q) });
  return out;
}

// ── Vehicles ────────────────────────────────────────────────────────────────

/** Suggestions shown under the vehicle input. */
export const VEHICLE_SUGGESTIONS = 8;

export function findVehicle(list: readonly Vehicle[], code: string): Vehicle | undefined {
  const needle = code.toLowerCase();
  return list.find((v) => v.code.toLowerCase() === needle);
}

/** Shown name of a vehicle code; codes missing from the local list show as themselves. */
export function vehicleLabel(list: readonly Vehicle[], code: string): string {
  return findVehicle(list, code)?.name ?? code;
}

/**
 * Vehicles whose name or internal code contains the text (case-insensitive), those starting with
 * it first, capped at `max`. Blank text → none.
 */
export function matchVehicles(list: readonly Vehicle[], text: string, max = VEHICLE_SUGGESTIONS): Vehicle[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const starts: Vehicle[] = [];
  const contains: Vehicle[] = [];
  for (const v of list) {
    const name = v.name.toLowerCase();
    const code = v.code.toLowerCase();
    if (name.startsWith(needle) || code.startsWith(needle)) starts.push(v);
    else if (name.includes(needle) || code.includes(needle)) contains.push(v);
  }
  return [...starts, ...contains].slice(0, max);
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Compact counts in the UI language: 24120 → "24.1k" (Italian "24,1k"), 1284000 → "1.3M". */
export function compactNumber(n: number, lang: string): string {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (value < 1000) return new Intl.NumberFormat(lang).format(Math.round(value));
  const [scaled, suffix] = value >= 999_950 ? [value / 1e6, 'M'] : [value / 1e3, 'k'];
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(scaled)}${suffix}`;
}

/** Post date as "12 Sep 2026" (English) or the language's own short form ("12 set 2026"). */
export const formatPostDate = (iso: string, lang: string): string => formatShortDate(iso, lang) ?? '';

// ── Install steps ───────────────────────────────────────────────────────────

export type StepName = Exclude<InstallStep, 'error'>;
export const STEP_ORDER: readonly StepName[] = ['download', 'extract', 'verify', 'done'];

export interface StepText {
  /** Finished steps ("Download ✓ · Extract ✓"). */
  done: StepName[];
  /** Current step, drawn in amber ("Extracting 56%"). */
  now: StepName;
  /** Overall percentage shown next to the current step; null once done. */
  pct: number | null;
  /** Steps still to come ("Verify · Done"). */
  next: StepName[];
}

/**
 * The card's step line (the prototype's `stepOf`, driven by the backend step instead of the
 * percentage). At `done` every step is ticked.
 */
export function stepText(step: StepName, pct: number): StepText {
  const i = STEP_ORDER.indexOf(step);
  if (step === 'done') return { done: STEP_ORDER.slice(0, 3), now: 'done', pct: null, next: [] };
  return {
    done: STEP_ORDER.slice(0, i),
    now: step,
    pct: Math.max(0, Math.min(100, Math.round(pct))),
    next: STEP_ORDER.slice(i + 1),
  };
}

// ── Grid rows ───────────────────────────────────────────────────────────────

export const CARD_MIN_WIDTH = 250;
export const GRID_GAP = 16;
export const GRID_BOTTOM_PADDING = 24;
/** Card body under the 16:9 image: 2 border + 12 + 18 name + 7 + 17 nation + 7 + 16 author + 7 + 4 + 30 action + 12. */
export const CARD_BODY = 132;
/** Rows from the end at which the next page is asked for. */
export const PREFETCH_ROWS = 2;

export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)));
}

export type GridRow =
  | { kind: 'cards'; key: string; skins: WtLiveSkin[] }
  /** Skeleton cards for the page being fetched. */
  | { kind: 'loading'; key: string }
  /** The next page failed: a line with Retry. */
  | { kind: 'moreFailed'; key: string };

/** Card lines of `cols` cards, then a loading or failed-page row when asked. */
export function buildRows(skins: readonly WtLiveSkin[], cols: number, tail: 'loading' | 'moreFailed' | null = null): GridRow[] {
  const rows: GridRow[] = [];
  const n = Math.max(1, cols);
  for (let i = 0; i < skins.length; i += n) {
    const line = skins.slice(i, i + n);
    rows.push({ kind: 'cards', key: `c:${line[0]?.id ?? i}`, skins: line });
  }
  if (tail === 'loading') rows.push({ kind: 'loading', key: 'loading' });
  if (tail === 'moreFailed') rows.push({ kind: 'moreFailed', key: 'moreFailed' });
  return rows;
}

/** Estimated row height (px) before measuring: the 16:9 image of a card at this width, the body and the gap. */
export function estimateRowSize(row: GridRow | undefined, width: number, cols: number): number {
  if (row?.kind === 'moreFailed') return 56;
  const n = Math.max(1, cols);
  const cardWidth = Math.max(CARD_MIN_WIDTH, (width - (n - 1) * GRID_GAP) / n);
  return Math.round(((cardWidth - 2) * 9) / 16) + CARD_BODY + GRID_GAP;
}

// ── WT Live cache ───────────────────────────────────────────────────────────

function isSkin(value: object): value is WtLiveSkin {
  const v = value as Partial<WtLiveSkin>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.vehicle === 'object' && typeof v.author === 'object';
}

function collect(data: unknown, out: Map<string, WtLiveSkin>, depth = 0): void {
  // Deepest shape: InfiniteData → pages[] → page → items[] → skin.
  if (typeof data !== 'object' || data === null || depth > 5) return;
  if (Array.isArray(data)) {
    for (const item of data) collect(item, out, depth + 1);
    return;
  }
  const record = data as { pages?: unknown; items?: unknown };
  if (Array.isArray(record.pages)) collect(record.pages, out, depth + 1);
  else if (Array.isArray(record.items)) collect(record.items, out, depth + 1);
  else if (isSkin(data) && !out.has(data.id)) out.set(data.id, data);
}

/**
 * Every WT Live skin in the query cache (search pages, posts, Following's new skins), each once,
 * in cache order. Feeds the command palette's skin results and Following's author counts.
 */
export function cachedWtLiveSkins(qc: QueryClient): WtLiveSkin[] {
  const out = new Map<string, WtLiveSkin>();
  for (const [, data] of qc.getQueriesData({ queryKey: WTLIVE_KEY })) collect(data, out);
  return [...out.values()];
}

/** An author's WT Live skin count, when some cached skin of theirs carries it. */
export function authorSkinCount(skins: readonly WtLiveSkin[], authorId: string): number | undefined {
  for (const s of skins) if (s.author.id === authorId && typeof s.author.skinCount === 'number') return s.author.skinCount;
  return undefined;
}
