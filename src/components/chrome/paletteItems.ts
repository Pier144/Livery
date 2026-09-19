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
  /** WT Live skins already in the query cache (Explore pages, posts, Following). */
  skins: readonly PaletteSkin[];
  go: (section: Section) => void;
  /** Opens a skin's detail view. Without it, skins fall back to Explore. */
  openSkin?: (id: string) => void;
  /** Sets the Explore vehicle filter (by code) before a vehicle result jumps to Explore. */
  applyVehicle?: (code: string) => void;
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
    run: () => {
      ctx.applyVehicle?.(v.code);
      ctx.go('explore');
    },
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

/** Places kept for vehicle and action matches when skins alone could fill the list. */
const RESERVED_FOR_OTHERS = 3;

/**
 * Palette results. Empty query: the 5 actions, then the first 4 vehicles.
 * Otherwise skins → vehicles → actions whose label or hint contains the query
 * (case-insensitive), capped at 9. Up to 3 places go to matching vehicles and actions, so
 * thousands of cached WT Live skins never hide the vehicle you typed.
 */
export function buildPaletteItems(query: string, ctx: PaletteContext): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...actionItems(ctx), ...ctx.vehicles.slice(0, EMPTY_QUERY_VEHICLES).map((v) => vehicleItem(v, ctx))];

  const matches = (item: PaletteItem) => item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q);
  // Each scan stops at the cap, so thousands of cached skins are not all looked at.
  const collect = <T,>(source: readonly T[], toItem: (x: T) => PaletteItem): PaletteItem[] => {
    const out: PaletteItem[] = [];
    for (const x of source) {
      const item = toItem(x);
      if (matches(item) && out.push(item) >= PALETTE_MAX_RESULTS) break;
    }
    return out;
  };
  const skins = collect(ctx.skins, (s) => skinItem(s, ctx));
  const others = [...collect(ctx.vehicles, (v) => vehicleItem(v, ctx)), ...collect(actionItems(ctx), (a) => a)];
  const skinRoom = PALETTE_MAX_RESULTS - Math.min(RESERVED_FOR_OTHERS, others.length);
  return [...skins.slice(0, skinRoom), ...others].slice(0, PALETTE_MAX_RESULTS);
}
