import { SECTION_KEYS } from '@/hooks/useKeyboardShortcuts';
import type { Author, Section, Vehicle } from '@/types';

export type PaletteKind = 'skin' | 'vehicle' | 'action';

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  /** Vehicle code, "vehicle · author" for skins, the section shortcut for actions. */
  hint: string;
  run: () => void;
}

/** The part of a WT Live skin the palette needs (`WtLiveSkin` satisfies it). */
export interface PaletteSkin {
  id: string;
  name: string;
  vehicle: Pick<Vehicle, 'name'>;
  author: Pick<Author, 'name'>;
}

export type PaletteActionKey = `common.palette.actions.${Section}`;

export interface PaletteContext {
  t: (key: PaletteActionKey) => string;
  vehicles: readonly Vehicle[];
  /** Cached WT Live skins; empty until M5. */
  skins: readonly PaletteSkin[];
  go: (section: Section) => void;
  /** Opens a skin's detail view (M5). Without it, skins fall back to Explore. */
  openSkin?: (id: string) => void;
}

export const PALETTE_MAX_RESULTS = 9;
/** Vehicles listed under the actions when the query is empty. */
const EMPTY_QUERY_VEHICLES = 4;

const ACTION_SECTIONS: readonly Section[] = ['explore', 'hangar', 'collections', 'queue', 'settings'];

/** First key bound to a section by the global shortcuts ("1"–"5"). */
function shortcutFor(section: Section): string {
  return Object.keys(SECTION_KEYS).find((key) => SECTION_KEYS[key] === section) ?? '';
}

function actionItems(ctx: PaletteContext): PaletteItem[] {
  return ACTION_SECTIONS.map((section) => ({
    id: `action:${section}`,
    kind: 'action',
    label: ctx.t(`common.palette.actions.${section}`),
    hint: shortcutFor(section),
    run: () => ctx.go(section),
  }));
}

function vehicleItem(v: Vehicle, ctx: PaletteContext): PaletteItem {
  return {
    id: `vehicle:${v.code}`,
    kind: 'vehicle',
    label: v.name,
    hint: v.code,
    // TODO(M5): also apply this vehicle as the Explore vehicle filter.
    run: () => ctx.go('explore'),
  };
}

function skinItem(s: PaletteSkin, ctx: PaletteContext): PaletteItem {
  return {
    id: `skin:${s.id}`,
    kind: 'skin',
    label: s.name,
    hint: `${s.vehicle.name} · ${s.author.name}`,
    run: () => (ctx.openSkin ? ctx.openSkin(s.id) : ctx.go('explore')),
  };
}

/**
 * Palette results. Empty query: the 5 actions, then the first 4 vehicles.
 * Otherwise skins → vehicles → actions whose label or hint contains the query
 * (case-insensitive), capped at 9.
 */
export function buildPaletteItems(query: string, ctx: PaletteContext): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...actionItems(ctx), ...ctx.vehicles.slice(0, EMPTY_QUERY_VEHICLES).map((v) => vehicleItem(v, ctx))];

  const results: PaletteItem[] = [];
  // Returns true once the cap is reached, so thousands of cached skins are not all scanned.
  const add = (item: PaletteItem) => {
    if (item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q)) results.push(item);
    return results.length >= PALETTE_MAX_RESULTS;
  };
  for (const s of ctx.skins) if (add(skinItem(s, ctx))) return results;
  for (const v of ctx.vehicles) if (add(vehicleItem(v, ctx))) return results;
  for (const a of actionItems(ctx)) if (add(a)) return results;
  return results;
}
