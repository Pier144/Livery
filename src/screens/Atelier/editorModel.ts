import type { TFunction } from 'i18next';
import { HQ_SIZE, isBodySlot } from '@/atelier/gl/baker';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import type { AtelierProject } from '@/types';

/** Pure helpers of the editor (no React, no WebGL). */

/** Selection id of the Protected areas row before the project has a mask layer (it is created by the first stroke). */
export const MASK_ROW_ID = 'mask:new';

/** Brush size limits, as fractions of the model's bounding radius (strokes store model units). */
export const BRUSH_MIN = 0.01;
export const BRUSH_MAX = 0.25;
export const BRUSH_DEFAULT = 0.05;
export const HARDNESS_DEFAULT = 0.6;
/** A point is added to a stroke once the brush moved this fraction of its radius. */
export const POINT_SPACING = 1 / 3;

/** Camo pattern scale range (the Base's `scale`). */
export const SCALE_MIN = 0.1;
export const SCALE_MAX = 4;

/** A project name the backend accepts: 1 to 80 characters once trimmed. */
export const NAME_MAX = 80;

export type SlotKind = 'body' | 'turret' | 'gun';

/** `body`, `turret` or `gun` from a slot's texture name (`…_body_c`), else null. */
export function slotKind(texture: string): SlotKind | null {
  const m = /_(body|turret|gun)_c$/i.exec(texture);
  return m ? (m[1]!.toLowerCase() as SlotKind) : null;
}

/** A slot's friendly label: Body, Turret, Gun, or the texture name without `_c`. */
export function slotLabel(texture: string, t: TFunction): string {
  const kind = slotKind(texture);
  return kind ? t(`atelier.parts.${kind}`) : texture.replace(/_c$/i, '');
}

/** The textures the project paints: its enabled slots that the model has, in the model's order. */
export function enabledSlots(project: Pick<AtelierProject, 'slots'>, model: VehicleModelData): string[] {
  const on = new Set(project.slots.filter((s) => s.enabled).map((s) => s.texture.toLowerCase()));
  return model.header.slots.filter((s) => on.has(s.texture.toLowerCase())).map((s) => s.texture);
}

/** The project's slots as the Parts list shows them: the model's slots with the project's choice. */
export function partRows(project: Pick<AtelierProject, 'slots'>, model: VehicleModelData): { texture: string; enabled: boolean; hq: boolean }[] {
  const chosen = new Map(project.slots.map((s) => [s.texture.toLowerCase(), s]));
  return model.header.slots
    .filter((s) => chosen.has(s.texture.toLowerCase()))
    .map((s) => ({ texture: chosen.get(s.texture.toLowerCase())!.texture, enabled: chosen.get(s.texture.toLowerCase())!.enabled, hq: s.hq }));
}

/** High quality is offered when the model has a body slot smaller than 4096. */
export function offersHighQuality(model: VehicleModelData): boolean {
  return model.header.slots.some((s) => isBodySlot(s.texture) && Math.max(s.width, s.height) < HQ_SIZE);
}

/** Some painted slot comes from the game's smaller textures (its high-quality pack isn't installed). */
export function missingHqPack(project: Pick<AtelierProject, 'slots'>, model: VehicleModelData): boolean {
  return partRows(project, model).some((r) => r.enabled && !r.hq);
}

/**
 * Overall apply progress 0..100: the frontend's bake takes 0..50 (split across the slots), Rust's
 * encode, write and install (its own 0..100) the other half.
 */
export function applyPercent(baked: number, slots: number, rustPct: number): number {
  const bake = slots > 0 ? (50 * Math.min(baked, slots)) / slots : 50;
  return Math.round(Math.min(100, bake + Math.min(100, Math.max(0, rustPct)) / 2));
}

/** `name` trimmed when the backend would take it, else null. */
export function checkedName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length > 0 && [...trimmed].length <= NAME_MAX ? trimmed : null;
}

/** A new camo seed (a positive 31-bit integer, never `current`). */
export function shuffledSeed(current: number, random = Math.random): number {
  let seed = current;
  while (seed === current) seed = 1 + Math.floor(random() * 0x7ffffffe);
  return seed;
}

/** Euclidean distance between two points. */
export function distance(a: readonly number[], b: readonly number[]): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  const dz = a[2]! - b[2]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
