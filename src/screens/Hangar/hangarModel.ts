// Pure My Hangar logic: filtering, grouping by vehicle, stats and the flattened row model the
// virtualized grid/list renders. No React, no i18n (labels come in as arguments).

import type { HangarFilters, HangarView } from '@/store/hangar';
import type { HangarSkin, Nation, Origin, VehicleType } from '@/types';

/** Game order for the Nation chip (the `UNK` fallback last). */
export const NATION_ORDER: readonly Nation[] = ['USA', 'GER', 'USSR', 'GBR', 'JPN', 'CHN', 'ITA', 'FRA', 'SWE', 'ISR', 'UNK'];
export const TYPE_ORDER: readonly VehicleType[] = ['ground', 'air', 'heli', 'naval'];
export const ORIGIN_ORDER: readonly Origin[] = ['wtlive', 'imported', 'mine'];

// ── Filtering ───────────────────────────────────────────────────────────────

/** Search text as matched: trimmed, lower-cased. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/** `needle` (normalized) is in the skin name, the vehicle name or the vehicle code. */
export function matchesQuery(skin: HangarSkin, needle: string): boolean {
  if (needle === '') return true;
  return (
    skin.name.toLowerCase().includes(needle) ||
    skin.vehicle.name.toLowerCase().includes(needle) ||
    skin.vehicle.code.toLowerCase().includes(needle)
  );
}

/** Search and chip filters combine with AND. */
export function filterSkins(skins: readonly HangarSkin[], q: string, filters: HangarFilters): HangarSkin[] {
  const needle = normalizeQuery(q);
  return skins.filter(
    (s) =>
      (filters.nation === null || s.vehicle.nation === filters.nation) &&
      (filters.type === null || s.vehicle.type === filters.type) &&
      (filters.origin === null || s.origin === filters.origin) &&
      matchesQuery(s, needle),
  );
}

export function hasFilters(q: string, filters: HangarFilters): boolean {
  return normalizeQuery(q) !== '' || filters.nation !== null || filters.type !== null || filters.origin !== null;
}

export interface PresentValues {
  nations: Nation[];
  types: VehicleType[];
  origins: Origin[];
}

/**
 * Chip options: only values some skin in the hangar has, in a fixed order. The current filter
 * value is kept even when no skin has it any more, so the chip never hides an active filter.
 */
export function presentValues(skins: readonly HangarSkin[], current: HangarFilters = { nation: null, type: null, origin: null }): PresentValues {
  const nations = new Set<Nation>();
  const types = new Set<VehicleType>();
  const origins = new Set<Origin>();
  for (const s of skins) {
    nations.add(s.vehicle.nation);
    types.add(s.vehicle.type);
    origins.add(s.origin);
  }
  if (current.nation) nations.add(current.nation);
  if (current.type) types.add(current.type);
  if (current.origin) origins.add(current.origin);
  return {
    nations: NATION_ORDER.filter((n) => nations.has(n)),
    types: TYPE_ORDER.filter((t) => types.has(t)),
    origins: ORIGIN_ORDER.filter((o) => origins.has(o)),
  };
}

// ── Grouping ────────────────────────────────────────────────────────────────

export interface SkinGroup {
  /** Stable React/virtualizer key: the vehicle code, or a fixed key for unknown vehicles. */
  key: string;
  /** Vehicle code ('' for skins whose vehicle couldn't be detected). */
  code: string;
  /** Vehicle name, falling back to the code, or the "unknown vehicle" label. */
  title: string;
  unknown: boolean;
  /** Sorted by name. */
  skins: HangarSkin[];
}

/** Can't collide with a vehicle code: codes are .blk file names, and `?` is invalid in Windows file names. */
const UNKNOWN_KEY = '?unknown';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function byName(a: HangarSkin, b: HangarSkin): number {
  return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Groups by vehicle code. Groups are sorted by title (the unknown-vehicle group last, since it is
 * not a vehicle), skins inside a group by name.
 */
export function groupSkins(skins: readonly HangarSkin[], unknownTitle: string): SkinGroup[] {
  const byCode = new Map<string, SkinGroup>();
  for (const skin of skins) {
    const code = skin.vehicle.code;
    const key = code === '' ? UNKNOWN_KEY : code;
    let group = byCode.get(key);
    if (!group) {
      const unknown = code === '';
      group = { key, code, title: unknown ? unknownTitle : skin.vehicle.name.trim() || code, unknown, skins: [] };
      byCode.set(key, group);
    }
    group.skins.push(skin);
  }
  const groups = [...byCode.values()];
  for (const g of groups) g.skins.sort(byName);
  return groups.sort(
    (a, b) => Number(a.unknown) - Number(b.unknown) || collator.compare(a.title, b.title) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}

/** Skin ids in on-screen order (groups, then skins), for Shift+click ranges and "Select all". */
export function orderedIds(groups: readonly SkinGroup[]): string[] {
  return groups.flatMap((g) => g.skins.map((s) => s.id));
}

// ── Stats ───────────────────────────────────────────────────────────────────

export interface HangarStats {
  count: number;
  active: number;
  sizeBytes: number;
  /** Skins with at least one attention item. */
  attention: number;
}

export function needsAttention(skin: HangarSkin): boolean {
  return (skin.attention?.length ?? 0) > 0;
}

export function hangarStats(skins: readonly HangarSkin[]): HangarStats {
  let active = 0;
  let sizeBytes = 0;
  let attention = 0;
  for (const s of skins) {
    if (s.active) active += 1;
    sizeBytes += s.sizeBytes;
    if (needsAttention(s)) attention += 1;
  }
  return { count: skins.length, active, sizeBytes, attention };
}

// ── Row model (virtualization) ──────────────────────────────────────────────

/** `repeat(auto-fill, minmax(220px, 1fr))` with a 12px gap, computed for the virtualizer. */
export const CARD_MIN_WIDTH = 220;
export const GRID_GAP = 12;
/** Space between vehicle groups. */
export const GROUP_GAP = 22;
/** Group header: 25px row (13px text, line-height normal, 4px padding) + 10px before the first card. */
export const HEADER_HEIGHT = 25;
export const HEADER_GAP = 10;
/** List row: 8px padding, 26px thumb, 8px padding, 1px rule. */
export const LIST_ROW_HEIGHT = 43;
/** Room under the last row so the bulk bar never covers it. */
export const BOTTOM_PADDING = 80;

export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)));
}

interface RowBase {
  key: string;
  groupIndex: number;
  /** The last row of its group, not in the last group: carries the 22px group gap. */
  gapAfter: boolean;
}
export interface HeaderRow extends RowBase {
  kind: 'header';
}
/** One line of grid cards. */
export interface CardsRow extends RowBase {
  kind: 'cards';
  skins: HangarSkin[];
  /** Last line of its group (no 12px gap under it). */
  lastInGroup: boolean;
}
/** One list-view row. */
export interface ItemRow extends RowBase {
  kind: 'item';
  skin: HangarSkin;
  firstInGroup: boolean;
  lastInGroup: boolean;
}
export type HangarRow = HeaderRow | CardsRow | ItemRow;

/**
 * Flattens groups into rows: a header per group, then card lines of `cols` cards (grid) or one
 * row per skin (list). Card-line keys include `cols` so a column change starts from estimates.
 */
export function buildRows(groups: readonly SkinGroup[], view: HangarView, cols: number): HangarRow[] {
  const rows: HangarRow[] = [];
  const perLine = Math.max(1, cols);
  groups.forEach((group, groupIndex) => {
    const lastGroup = groupIndex === groups.length - 1;
    rows.push({ kind: 'header', key: `h:${group.key}`, groupIndex, gapAfter: false });
    if (view === 'grid') {
      const lines = Math.ceil(group.skins.length / perLine);
      for (let line = 0; line < lines; line++) {
        const lastInGroup = line === lines - 1;
        rows.push({
          kind: 'cards',
          key: `c:${perLine}:${group.key}:${line}`,
          groupIndex,
          skins: group.skins.slice(line * perLine, (line + 1) * perLine),
          lastInGroup,
          gapAfter: lastInGroup && !lastGroup,
        });
      }
    } else {
      group.skins.forEach((skin, i) => {
        const lastInGroup = i === group.skins.length - 1;
        rows.push({
          kind: 'item',
          key: `i:${skin.id}`,
          groupIndex,
          skin,
          firstInGroup: i === 0,
          lastInGroup,
          gapAfter: lastInGroup && !lastGroup,
        });
      });
    }
  });
  return rows;
}

/** Card body below the 16:9 image: padding, name, origin line, footer (without attention). */
const CARD_BODY = 2 + 20 + 16 + 5 + 14 + 5 + 2 + 24;
const ATTENTION_LINE = 5 + 14;

/** First guess of a row's height before it is measured. */
export function estimateRowSize(row: HangarRow, width: number, cols: number): number {
  const after = row.gapAfter ? GROUP_GAP : 0;
  switch (row.kind) {
    case 'header':
      return HEADER_HEIGHT + HEADER_GAP;
    case 'cards': {
      const cardWidth = Math.max(CARD_MIN_WIDTH, (width - (cols - 1) * GRID_GAP) / Math.max(1, cols));
      const attention = row.skins.some(needsAttention) ? ATTENTION_LINE : 0;
      return Math.round((cardWidth * 9) / 16) + CARD_BODY + attention + (row.lastInGroup ? after : GRID_GAP);
    }
    case 'item':
      return LIST_ROW_HEIGHT + (needsAttention(row.skin) ? 14 : 0) + after;
  }
}
