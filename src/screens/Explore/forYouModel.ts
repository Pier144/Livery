// For you (spec 2026-10-16 §3): the player's lineups as the tab lists them. Pure: no React, no i18n.

import { NATION_ORDER } from '@/screens/Hangar/hangarModel';
import type { ForYouNew, Lineups, Nation } from '@/types';

/** One preset as the tab shows it: a title row and its vehicles. */
export interface ForYouSection {
  nation: Nation;
  /** The player's text; empty → the UI shows "Preset {presetIndex + 1}". */
  presetName: string;
  /** Position of the preset in the nation's list in the profile (file order). */
  presetIndex: number;
  active: boolean;
  /** Vehicle codes not shown in an earlier section; never empty. */
  vehicles: string[];
}

/** A row of the virtual list: a section title, or one vehicle of that section. */
export type ForYouRow =
  | { kind: 'header'; key: string; section: ForYouSection }
  | { kind: 'vehicle'; key: string; code: string; section: ForYouSection };

const nationRank = (nation: Nation, current: Nation | null | undefined) =>
  nation === current ? -1 : NATION_ORDER.indexOf(nation);

/**
 * Sections in display order: the current nation first, then the game's nation order; inside a
 * nation the active preset first, then the others in file order. A vehicle appears once, in the
 * first place it would appear (so the active preset keeps it); presets left empty are dropped.
 */
export function forYouSections(lineups: Lineups | undefined): ForYouSection[] {
  if (!lineups || lineups.status !== 'ok') return [];
  const nations = [...lineups.nations].sort(
    (a, b) => nationRank(a.nation, lineups.currentNation) - nationRank(b.nation, lineups.currentNation),
  );
  const seen = new Set<string>();
  const sections: ForYouSection[] = [];
  for (const { nation, presets } of nations) {
    const ordered = presets.map((preset, presetIndex) => ({ preset, presetIndex }));
    ordered.sort((a, b) => Number(b.preset.active) - Number(a.preset.active));
    for (const { preset, presetIndex } of ordered) {
      const vehicles = preset.vehicles.filter((code) => {
        const key = code.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (vehicles.length > 0) sections.push({ nation, presetName: preset.name, presetIndex, active: preset.active, vehicles });
    }
  }
  return sections;
}

/** Every vehicle in section order: the list `wtlive_for_you_new` is asked about. */
export function forYouVehicles(sections: readonly ForYouSection[]): string[] {
  return sections.flatMap((s) => s.vehicles);
}

/**
 * New skins per vehicle, only for vehicles the answer covered (`vehicles` is the list that was
 * asked, `checked` how many of it were looked at); vehicles without new skins are left out.
 */
export function newCounts(answer: ForYouNew | undefined, vehicles: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!answer) return counts;
  const covered = new Set(vehicles.slice(0, answer.checked));
  for (const { vehicle } of answer.items) {
    if (covered.has(vehicle)) counts.set(vehicle, (counts.get(vehicle) ?? 0) + 1);
  }
  return counts;
}

/** Every new skin of the answer (the tab's pill). */
export function totalNew(answer: ForYouNew | undefined): number {
  return answer?.items.length ?? 0;
}

/** The virtual list: each section's title, then its vehicles. Keys hold nation, preset and code. */
export function forYouRows(sections: readonly ForYouSection[]): ForYouRow[] {
  return sections.flatMap((section): ForYouRow[] => {
    const base = `${section.nation}:${section.presetIndex}`;
    return [
      { kind: 'header', key: `h:${base}`, section },
      ...section.vehicles.map((code): ForYouRow => ({ kind: 'vehicle', key: `v:${base}:${code}`, code, section })),
    ];
  });
}
