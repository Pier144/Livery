import type { TFunction } from 'i18next';
import { HQ_SIZE, isBodySlot } from '@/atelier/gl/baker';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import { MIN_CAMO_WEIGHT, normalizeWeights } from '@/atelier/project';
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

// ── Camo shares (`BaseLayer.weights`; undefined = equal shares) ─────────────

/** Equal shares of `count` colours (stored rounded, the first taking the rest). */
export function equalShares(count: number): number[] {
  return normalizeWeights(Array.from({ length: count }, () => 1));
}

/** The shares after "Add a colour": the new one gets 1/n, the others shrink in proportion (none under 5 %). */
export function weightsWithColorAdded(weights: readonly number[] | undefined): number[] | undefined {
  if (!weights) return undefined;
  const n = weights.length + 1;
  return normalizeWeights([...weights.map((w) => w * (1 - 1 / n)), 1 / n]);
}

/** The shares after removing colour `index`. */
export function weightsWithColorRemoved(weights: readonly number[] | undefined, index: number): number[] | undefined {
  if (!weights) return undefined;
  return normalizeWeights(weights.filter((_, i) => i !== index));
}

/**
 * The shares with divider `index` (between colour `index` and `index + 1`) moved to `position`
 * (0..1 along the bar), clamped so both neighbours keep MIN_CAMO_WEIGHT; the other shares stay.
 * Without shares the bar starts from equal ones of `count` colours.
 */
export function moveShareDivider(weights: readonly number[] | undefined, index: number, position: number, count = weights?.length ?? 2): number[] {
  const w = weights ? [...weights] : Array.from({ length: count }, () => 1 / count);
  const before = w.slice(0, index).reduce((a, b) => a + b, 0);
  const after = before + w[index]! + w[index + 1]!;
  const p = Math.min(after - MIN_CAMO_WEIGHT, Math.max(before + MIN_CAMO_WEIGHT, position));
  w[index] = p - before;
  w[index + 1] = after - p;
  return normalizeWeights(w);
}

/** A project name the backend accepts: 1 to 80 characters once trimmed. */
export const NAME_MAX = 80;

export type SlotKind = 'body' | 'turret' | 'gun';

/** `body`, `turret` or `gun` from a slot's texture name (`…_body_c`), else null. */
export function slotKind(texture: string): SlotKind | null {
  const m = /_(body|turret|gun)_c$/i.exec(texture);
  return m ? (m[1]!.toLowerCase() as SlotKind) : null;
}

/** Words of a texture name after a matched prefix, e.g. `m2hb` from `mg_m2hb`. */
const rest = (name: string) => name.replace(/_+/g, ' ').trim();

/**
 * A slot's friendly label: Body, Turret, Gun for the vehicle's own textures; for shared ones a
 * label where the name says what it is (`mg_*` machine gun, `net_*` net, `track*` track,
 * `*barrel*` barrel) followed by the rest of the name; else the texture name without `_c`.
 */
export function slotLabel(texture: string, t: TFunction): string {
  const kind = slotKind(texture);
  if (kind) return t(`atelier.parts.${kind}`);
  const name = texture.replace(/_c$/i, '');
  const lower = name.toLowerCase();
  const labelled = (key: 'mg' | 'net' | 'track' | 'barrel', tail: string) => {
    const words = rest(tail);
    return words ? `${t(`atelier.parts.${key}`)} ${words}` : t(`atelier.parts.${key}`);
  };
  if (lower.startsWith('mg_')) return labelled('mg', name.slice(3));
  if (lower === 'net' || lower.startsWith('net_')) return labelled('net', name.slice(3));
  const track = /^tracks?(?:_|$)/i.exec(name);
  if (track) return labelled('track', name.slice(track[0].length));
  const barrel = /_?barrel_?/i.exec(name);
  if (barrel) return labelled('barrel', `${name.slice(0, barrel.index)} ${name.slice(barrel.index + barrel[0].length)}`);
  return name;
}

/** The textures the project paints: its enabled slots that the model has, in the model's order. */
export function enabledSlots(project: Pick<AtelierProject, 'slots'>, model: VehicleModelData): string[] {
  const on = new Set(project.slots.filter((s) => s.enabled).map((s) => s.texture.toLowerCase()));
  return model.header.slots.filter((s) => on.has(s.texture.toLowerCase())).map((s) => s.texture);
}

export interface PartRow {
  texture: string;
  enabled: boolean;
  hq: boolean;
  /** One of the vehicle's own textures (painted by default), not a shared one (machine gun, net…). */
  main: boolean;
}

const MAIN_ORDER: Record<SlotKind, number> = { body: 0, turret: 1, gun: 2 };

/**
 * The project's slots as the Parts list shows them: the vehicle's own textures first (body,
 * turret, gun, then any other by name), then the shared ones by name.
 */
export function partRows(project: Pick<AtelierProject, 'slots'>, model: VehicleModelData): PartRow[] {
  const chosen = new Map(project.slots.map((s) => [s.texture.toLowerCase(), s]));
  const rows = model.header.slots
    .filter((s) => chosen.has(s.texture.toLowerCase()))
    .map((s) => {
      const choice = chosen.get(s.texture.toLowerCase())!;
      return { texture: choice.texture, enabled: choice.enabled, hq: s.hq, main: s.paintableByDefault };
    });
  const rank = (r: PartRow) => {
    const kind = slotKind(r.texture);
    return kind ? MAIN_ORDER[kind] : 3;
  };
  const byName = (a: PartRow, b: PartRow) => (a.texture.toLowerCase() < b.texture.toLowerCase() ? -1 : a.texture.toLowerCase() > b.texture.toLowerCase() ? 1 : 0);
  return [
    ...rows.filter((r) => r.main).sort((a, b) => rank(a) - rank(b) || byName(a, b)),
    ...rows.filter((r) => !r.main).sort(byName),
  ];
}

/** The project paints the body slot (High quality applies to it only). */
export function bodyEnabled(project: Pick<AtelierProject, 'slots'>): boolean {
  return project.slots.some((s) => s.enabled && isBodySlot(s.texture));
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

/**
 * Keys typed into this element are text editing (the editor's Ctrl+Z / Ctrl+Y leave it alone):
 * text fields, selects and editable content, but not sliders, colour wells or checkboxes.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !['range', 'color', 'checkbox', 'radio', 'button'].includes(target.type);
  const tag = target.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

function hexToHsl(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Largest channel difference between two `#rrggbb` colours (0..255). */
function colorDistance(a: string, b: string): number {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  return Math.max(Math.abs(((x >> 16) & 255) - ((y >> 16) & 255)), Math.abs(((x >> 8) & 255) - ((y >> 8) & 255)), Math.abs((x & 255) - (y & 255)));
}

/** Smallest channel difference a new camo colour keeps from the others. */
const MIN_COLOR_DISTANCE = 40;

/**
 * The colour "Add a colour" adds: the last one made lighter (or darker when it is already light),
 * a little more saturated and turned 35° round the hue circle; turned further until it is clearly
 * different from every colour already there. Deterministic.
 */
export function nextCamoColor(colors: readonly string[]): string {
  const valid = colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const last = valid[valid.length - 1] ?? '#56603f';
  const [h, s, l] = hexToHsl(last);
  const lightness = l > 0.5 ? l - 0.24 : l + 0.24;
  const saturation = Math.min(1, Math.max(0.25, s + 0.1));
  let candidate = hslToHex((h + 35) % 360, saturation, lightness);
  for (let step = 1; step < 12; step++) {
    if (valid.every((c) => colorDistance(c, candidate) >= MIN_COLOR_DISTANCE)) return candidate;
    candidate = hslToHex((h + 35 + step * 30) % 360, saturation, step % 2 === 0 ? lightness : 1 - lightness);
  }
  return candidate;
}
