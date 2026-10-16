import type { PartGroup } from '@/types';

/**
 * The layer schema of an Atelier project (`AtelierProject.layers`, stored by Rust as opaque
 * JSON). Phase 1 knows the Base and the Protected areas (mask); any other kind a project holds
 * (a later Livery's image or text layers) is kept as it came and listed as unsupported.
 *
 * Layers run bottom to top: exactly one Base, always first; at most one mask, always last.
 * Colours are project data stored as `#rrggbb` strings (not UI styling).
 */

export type Vec3 = [number, number, number];

/** "Only this part": every part, or one of the vehicle's three groups. */
export type PartFilter = 'all' | PartGroup;

export interface LayerCommon {
  id: string;
  /** The user's name for the layer; empty shows the kind's label (in the UI language). */
  name: string;
  visible: boolean;
}

export type BaseMode = 'solid' | 'camo';

export interface BaseLayer extends LayerCommon {
  kind: 'base';
  mode: BaseMode;
  /** `#rrggbb`: one for solid (the first is used), 2 to 4 for camo. */
  colors: string[];
  /** Camo pattern scale (model units per noise cell, relative). */
  scale: number;
  seed: number;
}

/** One brush stroke of the Protected areas, in model space (resolution-independent). */
export interface Stroke {
  /** Erase gives the paint back where the stroke goes. */
  erase: boolean;
  radius: number;
  /** 0 (soft) to 1 (hard). */
  hardness: number;
  part: PartFilter;
  /** Camera view direction when painted: only texels facing it are touched. */
  dir: Vec3;
  points: Vec3[];
}

export interface MaskLayer extends LayerCommon {
  kind: 'mask';
  strokes: Stroke[];
}

/** A layer kind this version can't edit: shown as unsupported and saved back exactly as it came. */
export interface UnsupportedLayer extends LayerCommon {
  kind: 'unsupported';
  /** The layer's own kind, e.g. `image`. */
  original: Record<string, unknown> & { kind: string };
}

export type Layer = BaseLayer | MaskLayer | UnsupportedLayer;

export const DEFAULT_BASE_COLOR = '#56603f';
/** Second camo colour when a camo Base has only one. */
export const DEFAULT_CAMO_COLOR = '#8a7a55';
export const MIN_CAMO_COLORS = 2;
export const MAX_CAMO_COLORS = 4;
export const DEFAULT_DIR: Vec3 = [0, 0, -1];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PART_FILTERS: readonly PartFilter[] = ['all', 'hull', 'turret', 'gun'];

let counter = 0;

/** A new layer id, unique within the session (and practically across them). */
export function newLayerId(): string {
  counter += 1;
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `l-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
}

export function newBaseLayer(): BaseLayer {
  return { id: newLayerId(), kind: 'base', name: '', visible: true, mode: 'solid', colors: [DEFAULT_BASE_COLOR], scale: 1, seed: 1 };
}

export function newMaskLayer(): MaskLayer {
  return { id: newLayerId(), kind: 'mask', name: '', visible: true, strokes: [] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);

function common(raw: Record<string, unknown>): LayerCommon {
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : newLayerId(),
    name: typeof raw.name === 'string' ? raw.name : '',
    visible: typeof raw.visible === 'boolean' ? raw.visible : true,
  };
}

function toBase(raw: Record<string, unknown>): BaseLayer {
  const mode: BaseMode = raw.mode === 'camo' ? 'camo' : 'solid';
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .filter((c): c is string => typeof c === 'string' && HEX_COLOR.test(c))
    .map((c) => c.toLowerCase())
    .slice(0, MAX_CAMO_COLORS);
  if (colors.length === 0) colors.push(DEFAULT_BASE_COLOR);
  if (mode === 'camo' && colors.length < MIN_CAMO_COLORS) colors.push(DEFAULT_CAMO_COLOR);
  return {
    ...common(raw),
    kind: 'base',
    mode,
    colors,
    scale: isFiniteNumber(raw.scale) && raw.scale > 0 ? raw.scale : 1,
    seed: isFiniteNumber(raw.seed) ? Math.trunc(raw.seed) : 1,
  };
}

/** A stroke that checks out, or null (dropped). */
function toStroke(raw: unknown): Stroke | null {
  if (!isObject(raw) || !Array.isArray(raw.points) || !raw.points.every(isVec3) || raw.points.length === 0) return null;
  if (!isFiniteNumber(raw.radius) || raw.radius <= 0) return null;
  return {
    erase: raw.erase === true,
    radius: raw.radius,
    hardness: isFiniteNumber(raw.hardness) ? Math.min(1, Math.max(0, raw.hardness)) : 0.5,
    part: PART_FILTERS.includes(raw.part as PartFilter) ? (raw.part as PartFilter) : 'all',
    dir: isVec3(raw.dir) ? raw.dir : DEFAULT_DIR,
    points: raw.points,
  };
}

function toMask(raw: Record<string, unknown>): MaskLayer {
  const strokes = (Array.isArray(raw.strokes) ? raw.strokes : []).map(toStroke).filter((s): s is Stroke => s !== null);
  return { ...common(raw), kind: 'mask', strokes };
}

function toLayer(raw: unknown): Layer | null {
  if (!isObject(raw) || typeof raw.kind !== 'string' || raw.kind.length === 0) return null;
  if (raw.kind === 'base') return toBase(raw);
  if (raw.kind === 'mask') return toMask(raw);
  return { ...common(raw), kind: 'unsupported', original: raw as UnsupportedLayer['original'] };
}

/**
 * The layers of a project file, repaired: entries that aren't layers are dropped, fields that
 * don't check out get their defaults, a missing Base is added and the Base moved to the bottom,
 * only the first mask is kept and pinned at the top, and repeated ids are renewed.
 */
export function validateLayers(json: unknown): Layer[] {
  const parsed = (Array.isArray(json) ? json : []).map(toLayer).filter((l): l is Layer => l !== null);
  const base = parsed.find((l): l is BaseLayer => l.kind === 'base') ?? newBaseLayer();
  const mask = parsed.find((l): l is MaskLayer => l.kind === 'mask');
  const middle = parsed.filter((l) => l.kind === 'unsupported');
  const layers: Layer[] = [base, ...middle, ...(mask ? [mask] : [])];
  const seen = new Set<string>();
  return layers.map((l) => {
    if (!seen.has(l.id)) {
      seen.add(l.id);
      return l;
    }
    const renewed = { ...l, id: newLayerId() };
    seen.add(renewed.id);
    return renewed;
  });
}

/** The layers as `project.json` stores them (unsupported ones exactly as they came). */
export function serializeLayers(layers: readonly Layer[]): unknown[] {
  return layers.map((l) => (l.kind === 'unsupported' ? { ...l.original, id: l.id, name: l.name, visible: l.visible } : l));
}

/** The Base (always first after `validateLayers`). */
export function baseOf(layers: readonly Layer[]): BaseLayer | undefined {
  return layers.find((l): l is BaseLayer => l.kind === 'base');
}

/** The Protected areas layer, if the project has one (always last). */
export function maskOf(layers: readonly Layer[]): MaskLayer | undefined {
  return layers.find((l): l is MaskLayer => l.kind === 'mask');
}
