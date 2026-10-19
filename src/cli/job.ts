import type { OrbitState, QuickView } from '@/atelier/gl/scene';
import type { EngineScene } from '@/screens/Atelier/engine';
import type { Decal } from '@/atelier/project';
import type { AtelierProject, ModelSlot, PartGroup } from '@/types';

/**
 * The agent CLI's job, as Rust sends it (`CliCommand::page_job` in
 * `src-tauri/src/cli/args.rs`): keep the two in step. The `--out` folder is never in it; the page
 * names its files and Rust writes them there (`cli_file`).
 */

/** A view as typed on the command line: a quick view or an orbit round the model's centre. */
export type ViewArg = { kind: 'quick'; name: QuickView } | { kind: 'orbit'; theta: number; phi: number; zoom: number };

export type CliJob =
  | { command: 'put'; project: AtelierProject }
  | { command: 'vehicleInfo'; vehicle: string }
  | {
      command: 'place';
      id: string;
      view: ViewArg;
      at: [number, number];
      part: PartGroup | null;
      width: number | null;
      height: number | null;
      depth: number | null;
    }
  | { command: 'render'; id: string; views: ViewArg[]; size: number; grid: boolean; flat: boolean }
  | { command: 'apply'; id: string };

/** A failure the page reports through `cli_finish` (an `AppError` or a CLI-only code such as `noHit`). */
export interface CliError {
  code: string;
  message: string;
  detail?: string | null;
}

export function isCliError(e: unknown): e is CliError {
  return typeof e === 'object' && e !== null && typeof (e as CliError).code === 'string' && typeof (e as CliError).message === 'string';
}

// ── Answers (the `ok` JSON printed on stdout) ───────────────────────────────

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface VehicleInfo {
  vehicle: string;
  model: string;
  /** The left/right mirror axis (2 = z). */
  mirrorAxis: number;
  /** Paintable textures: name, template size, whether it is the vehicle's own body texture. */
  slots: (ModelSlot & { body: boolean })[];
  /** Model-space bounds per part; `null` for a part without vertices. */
  parts: { node: string; group: PartGroup; slot: string; triangles: number; bounds: Bounds | null }[];
  /** Box of the whole model. */
  bounds: Bounds;
  /** Bounding sphere (as the editor frames the model): the box's centre and the farthest vertex from it. */
  center: [number, number, number];
  radius: number;
}

export interface PutResult {
  project: AtelierProject;
  /** `checkLayers` changed something (an invalid or unsupported value was repaired). */
  repaired: boolean;
  /** Ids of placed layers with Mirror on whose decal lands on shared texels (the editor turns Mirror off there). */
  sharedTexels: string[];
}

export interface PlaceResult {
  decal: Decal;
  group: PartGroup;
  node: string;
}

export interface RenderedFile {
  /** A bare file name; Rust turns it into the absolute path in `--out` before printing. */
  file: string;
  width: number;
  height: number;
}

export interface RenderResult {
  views: (RenderedFile & { view: string })[];
  flat: (RenderedFile & { slot: string })[];
}

// ── Views ───────────────────────────────────────────────────────────────────

/** A view's name, also its picture's file name (without `.png`): `front`, `orbit_0.50_1.20_1.00`. */
export function viewName(v: ViewArg): string {
  if (v.kind === 'quick') return v.name;
  return `orbit_${v.theta.toFixed(2)}_${v.phi.toFixed(2)}_${v.zoom.toFixed(2)}`;
}

/** The camera of a view, framed for a square picture. */
export function viewOrbit(v: ViewArg, scene: Pick<EngineScene, 'quickOrbit' | 'orbitFor'>): OrbitState {
  return v.kind === 'quick' ? scene.quickOrbit(v.name) : scene.orbitFor(v.theta, v.phi, v.zoom);
}

/** `--at` (fractions of the picture, 0,0 top left) to normalised device coordinates (x right, y up). */
export function atToNdc([x, y]: [number, number]): [number, number] {
  return [x * 2 - 1, 1 - y * 2];
}
