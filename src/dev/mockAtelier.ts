// Atelier in the `pnpm dev:mock` backend (imported by src/dev/mockBackend.ts only, so it never
// ships). Mirrors src-tauri/src/atelier/{mod,project,apply}.rs: same command and argument names,
// result shapes, error codes and messages.
//
// Every ground vehicle of the built-in list has the same model: a unit cube in three parts (hull =
// the four sides and the bottom, turret = the top face, gun = a thin box sticking out on +x) with
// three 256×256 slots `<code>_body_c`, `<code>_turret_c`, `<code>_gun_c`, all painted by default.
// The templates are generated checkerboards with panel lines. `atelier_model` answers the same
// `LVM1` binary as Rust (`encodeMockModel`, format in src/atelier/modelBuffer.ts). Other codes are
// `notFound` "This vehicle's 3D model isn't in the game's files". Like the real app, the model
// commands and project creation need Read data from the game on and a game folder.
//
// Projects live in memory (newest save first); delete parks them in a trash until Undo or
// `atelier_project_forget_deleted`. Apply: `atelier_apply_begin` → `atelier_apply_texture` (raw
// body + `x-apply-id`/`x-slot`/`x-width`/`x-height` headers, checked like Rust) emits the encode
// and write steps of `atelier://apply-progress` a moment apart → `atelier_apply_commit` installs
// a `mine` skin in the hangar (over the project's skin, keeping its id, when it is still there)
// and emits install then done.

import {
  MODEL_MAGIC,
  MODEL_PREAMBLE_BYTES,
  NORMAL_COMPONENTS,
  POSITION_COMPONENTS,
  UV_COMPONENTS,
  modelArraysBytes,
} from '@/atelier/modelBuffer';
import {
  EVENTS,
  type ApplyProgress,
  type ApplyResult,
  type ApplyStarted,
  type ApplyStep,
  type AtelierProject,
  type AtelierProjectSummary,
  type HangarSkin,
  type ModelHeader,
  type ModelPart,
  type ModelSlot,
  type PartGroup,
  type Settings,
  type Vehicle,
} from '@/types';

// ── Messages (the Rust consts) ──────────────────────────────────────────────

export const ATELIER_NEEDS_GAME_DATA = 'Atelier needs Read data from the game turned on';
export const MODEL_NOT_FOUND = "This vehicle's 3D model isn't in the game's files";
export const TEXTURE_NOT_FOUND = "A texture of this vehicle isn't in the game's files";
export const PROJECT_NOT_FOUND = 'This Atelier project no longer exists';
export const PROJECT_INVALID = "This Atelier project can't be read";
export const PROJECT_NAME_INVALID = 'A project name must be 1 to 80 characters long';
export const PROJECT_THUMB_INVALID = "The project's picture can't be saved";
export const APPLY_NOT_FOUND = 'This apply is no longer running';
export const APPLY_NOTHING = 'Turn on at least one part to apply';
export const APPLY_BAD_SLOT = "This part isn't turned on for this apply";
export const APPLY_BAD_TEXTURE = 'A painted texture has the wrong size';
export const APPLY_FAILED = "The skin couldn't be applied to the game";

const MAX_NAME_CHARS = 80;
const MAX_LAYERS = 500;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_APPLY_SIDE = 4096;
/** `pct` reached when every texture is written; install takes the rest (apply.rs `TEXTURES_PCT`). */
const TEXTURES_PCT = 90;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Time between the encode and write steps of one texture. */
const ENCODE_MS = 400;

// ── Model ───────────────────────────────────────────────────────────────────

/** Side of the mock's template textures. */
export const MOCK_TEXTURE_SIZE = 256;

type V3 = [number, number, number];

/** Arrays of the model being built. */
interface Builder {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A quad facing `n` around `c` with half-extents `u` and `v` (tangent vectors), mapped onto the
 * UV rectangle `[u0, v0, u1, v1]` (origin top-left, `+v` up in the picture). Counter-clockwise
 * seen from outside, as three.js expects.
 */
function quad(b: Builder, c: V3, n: V3, u: V3, v: V3, rect: [number, number, number, number]): void {
  // Turn `u` around when (u, v, n) is left-handed, so the corners below run counter-clockwise.
  const uu: V3 = dot(cross(u, v), n) < 0 ? [-u[0], -u[1], -u[2]] : u;
  const [u0, v0, u1, v1] = rect;
  const base = b.positions.length / 3;
  const corners: [V3, number, number][] = [
    [sub(sub(c, uu), v), u0, v1],
    [sub(add(c, uu), v), u1, v1],
    [add(add(c, uu), v), u1, v0],
    [add(sub(c, uu), v), u0, v0],
  ];
  for (const [p, s, t] of corners) {
    b.positions.push(...p);
    b.normals.push(...n);
    b.uvs.push(s, t);
  }
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Cell `i` of a 3×2 grid of UV rectangles, with a small margin for dilation. */
function cell(i: number): [number, number, number, number] {
  const col = i % 3;
  const row = Math.floor(i / 3);
  const m = 0.02;
  return [col / 3 + m, row / 2 + m, (col + 1) / 3 - m, (row + 1) / 2 - m];
}

/** The six faces of a box (centre `c`, half-sizes `h`), on cells 0 to 5 (or the listed faces only). */
function box(b: Builder, c: V3, h: V3, faces: readonly number[]): void {
  const [hx, hy, hz] = h;
  const all: [V3, V3, V3][] = [
    [[1, 0, 0], [0, 0, -hz], [0, hy, 0]],
    [[-1, 0, 0], [0, 0, hz], [0, hy, 0]],
    [[0, 0, 1], [hx, 0, 0], [0, hy, 0]],
    [[0, 0, -1], [-hx, 0, 0], [0, hy, 0]],
    [[0, -1, 0], [hx, 0, 0], [0, 0, -hz]],
    [[0, 1, 0], [hx, 0, 0], [0, 0, hz]],
  ];
  faces.forEach((face, k) => {
    const entry = all[face];
    if (!entry) return;
    const [n, u, v] = entry;
    const centre: V3 = [c[0] + n[0] * hx, c[1] + n[1] * hy, c[2] + n[2] * hz];
    quad(b, centre, n, u, v, cell(k));
  });
}

interface MockPart {
  node: string;
  group: PartGroup;
  slot: number;
  build: (b: Builder) => void;
}

const PARTS: readonly MockPart[] = [
  // Hull: +x, -x, +z, -z sides and the bottom.
  { node: '@root', group: 'hull', slot: 0, build: (b) => box(b, [0, 0, 0], [0.5, 0.5, 0.5], [0, 1, 2, 3, 4]) },
  // Turret: the top face, over the whole texture.
  { node: 'bone_turret', group: 'turret', slot: 1, build: (b) => quad(b, [0, 0.5, 0], [0, 1, 0], [0.5, 0, 0], [0, 0, 0.5], [0.04, 0.04, 0.96, 0.96]) },
  // Gun: a thin box on +x.
  { node: 'bone_gun', group: 'gun', slot: 2, build: (b) => box(b, [0.8, 0.25, 0], [0.3, 0.05, 0.05], [0, 1, 2, 3, 4, 5]) },
];

/** The mock's slots for `vehicle`. */
export function mockSlots(vehicle: string): ModelSlot[] {
  return ['body', 'turret', 'gun'].map((name) => ({
    texture: `${vehicle}_${name}_c`,
    width: MOCK_TEXTURE_SIZE,
    height: MOCK_TEXTURE_SIZE,
    hq: true,
    paintableByDefault: true,
  }));
}

/** The cube model for `vehicle` as the `LVM1` binary `atelier_model` answers. */
export function encodeMockModel(vehicle = 'mock_vehicle'): ArrayBuffer {
  const all: Builder = { positions: [], normals: [], uvs: [], indices: [] };
  const parts: ModelPart[] = PARTS.map((p) => {
    const one: Builder = { positions: [], normals: [], uvs: [], indices: [] };
    p.build(one);
    const vertexOffset = all.positions.length / POSITION_COMPONENTS;
    const part: ModelPart = {
      node: p.node,
      group: p.group,
      slot: p.slot,
      vertexOffset,
      vertexCount: one.positions.length / POSITION_COMPONENTS,
      indexOffset: all.indices.length,
      indexCount: one.indices.length,
    };
    all.positions.push(...one.positions);
    all.normals.push(...one.normals);
    all.uvs.push(...one.uvs);
    all.indices.push(...one.indices.map((i) => i + vertexOffset));
    return part;
  });
  const header: ModelHeader = {
    vehicle,
    model: vehicle,
    mirrorAxis: 2,
    slots: mockSlots(vehicle),
    parts,
    vertexCount: all.positions.length / POSITION_COMPONENTS,
    indexCount: all.indices.length,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headerLen = Math.ceil(json.length / 4) * 4;
  const start = MODEL_PREAMBLE_BYTES + headerLen;
  const buf = new ArrayBuffer(start + modelArraysBytes(header.vertexCount, header.indexCount));
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < 4; i += 1) bytes[i] = MODEL_MAGIC.charCodeAt(i);
  new DataView(buf).setUint32(4, headerLen, true);
  bytes.fill(0x20, MODEL_PREAMBLE_BYTES, start);
  bytes.set(json, MODEL_PREAMBLE_BYTES);
  const view = new DataView(buf);
  let at = start;
  const vc = header.vertexCount;
  for (const [arr, n] of [
    [all.positions, vc * POSITION_COMPONENTS],
    [all.normals, vc * NORMAL_COMPONENTS],
    [all.uvs, vc * UV_COMPONENTS],
  ] as const) {
    for (let i = 0; i < n; i += 1, at += 4) view.setFloat32(at, arr[i] ?? 0, true);
  }
  for (const i of all.indices) {
    view.setUint32(at, i, true);
    at += 4;
  }
  return buf;
}

/** Template colours per slot (body, turret, gun): two checker tones each. Data, not UI styling. */
const DEFAULT_TONES: [V3, V3] = [[118, 124, 92], [104, 110, 80]];
const TEMPLATE_TONES: readonly [V3, V3][] = [
  [[118, 124, 92], [104, 110, 80]],
  [[112, 118, 98], [96, 104, 84]],
  [[96, 98, 90], [82, 84, 78]],
];

/**
 * The template of slot `slot` (0 body, 1 turret, 2 gun): RGBA8 rows top to bottom, a 32 px
 * checkerboard with dark panel lines every 64 px and a rivet at each crossing.
 */
export function mockTemplate(slot: number, size = MOCK_TEXTURE_SIZE): Uint8Array {
  const [a, b] = TEMPLATE_TONES[slot % TEMPLATE_TONES.length] ?? DEFAULT_TONES;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const checker = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0 ? a : b;
      const line = x % 64 === 0 || y % 64 === 0;
      const rivet = Math.hypot((x % 64) - 32, (y % 64) - 32) < 2;
      const k = line ? 0.45 : rivet ? 1.25 : 1;
      const o = (y * size + x) * 4;
      out[o] = Math.min(255, Math.round(checker[0] * k));
      out[o + 1] = Math.min(255, Math.round(checker[1] * k));
      out[o + 2] = Math.min(255, Math.round(checker[2] * k));
      out[o + 3] = 255;
    }
  }
  return out;
}

// ── State ───────────────────────────────────────────────────────────────────

interface MockApply {
  projectId: string;
  /** The project's installed skin at begin (commit's target if the project is gone by then). */
  installedSkinId?: string;
  vehicle: string;
  /** The folder a new skin installs under. */
  folder: string;
  enabled: string[];
  written: string[];
}

export interface AtelierMockState {
  projects: Map<string, AtelierProject>;
  trash: Map<string, { project: AtelierProject; thumb?: Uint8Array }>;
  thumbs: Map<string, Uint8Array>;
  applies: Map<string, MockApply>;
}

export function createAtelierState(): AtelierMockState {
  return { projects: new Map(), trash: new Map(), thumbs: new Map(), applies: new Map() };
}

/** What Atelier needs from the rest of the mock backend. */
export interface AtelierHost {
  atelier(): AtelierMockState;
  settings(): Settings;
  hasGameFolder(): boolean;
  /** The ground vehicle with this code in the mock catalog. */
  groundVehicle(code: string): Vehicle | undefined;
  newId(prefix: string): string;
  /** RFC 3339 UTC, second resolution. */
  now(): string;
  fail(code: string, message: string, detail?: string): never;
  emit(name: string, payload: unknown): void;
  /** Resolves after `ms` (scaled like the rest of the mock's background work). */
  wait(ms: number): Promise<void>;
  /**
   * Installs a generated skin: over `replaceId` keeping its id, name, folder and active state
   * (with a backup) when that skin is in the library, else as a new active `mine` skin in
   * `folder` (`(2)` on a clash).
   */
  installGenerated(target: { replaceId?: string; folder: string; vehicle: Vehicle }): { skin: HangarSkin; backupId?: string };
}

type Args = Record<string, unknown>;

/** Mock counterpart of `sanitize_folder_name`: characters Windows refuses become `_`. */
export function mockFolderName(name: string, fallback: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return cleaned || fallback;
}

/** `name (2)`, `(3)`… the first one not taken, cut to fit 80 characters (`free_copy_name`). */
function freeCopyName(name: string, taken: (n: string) => boolean): string {
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const base = [...name].slice(0, MAX_NAME_CHARS - suffix.length).join('').trimEnd();
    const candidate = `${base}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

const isSlotName = (name: string) =>
  name.length > 2 && name.length <= 128 && !name.startsWith('.') && /^[A-Za-z0-9_.-]+$/.test(name) && /_c$/i.test(name);
const isVehicleCode = (code: string) => code.length > 0 && code.length <= 128 && /^[A-Za-z0-9_-]+$/.test(code);

// ── Commands ────────────────────────────────────────────────────────────────

/** The Atelier commands, keyed like `src-tauri/src/lib.rs` registers them. */
export function atelierCommands(host: AtelierHost): Record<string, (args: Args) => unknown> {
  const { fail } = host;

  const str = (cmd: string, args: Args, key: string): string => {
    const value = args[key];
    return typeof value === 'string' ? value : fail('internal', `invalid args \`${key}\` for command \`${cmd}\``);
  };

  /** `atelier_game_root`: Read data from the game on, a game folder saved. */
  const requireGame = () => {
    if (!host.settings().readGameData) fail('invalidInput', ATELIER_NEEDS_GAME_DATA);
    if (!host.hasGameFolder()) fail('invalidInput', 'No game folder set');
  };

  const vehicleOf = (code: string): Vehicle => host.groundVehicle(code) ?? fail('notFound', MODEL_NOT_FOUND, code);

  const project = (id: string): AtelierProject => host.atelier().projects.get(id) ?? fail('notFound', PROJECT_NOT_FOUND, id);

  const checkedName = (name: string): string => {
    const trimmed = name.trim();
    const chars = [...trimmed].length;
    if (chars === 0 || chars > MAX_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      fail('invalidInput', PROJECT_NAME_INVALID, `${chars} characters`);
    }
    return trimmed;
  };

  const checkEnvelope = (p: AtelierProject) => {
    const invalid = (detail: string): never => fail('invalidInput', PROJECT_INVALID, detail);
    if (p.version !== 1) invalid(`version ${p.version}`);
    checkedName(p.name);
    if (!isVehicleCode(p.vehicle)) invalid(`vehicle ${JSON.stringify(p.vehicle)}`);
    const seen = new Set<string>();
    for (const slot of p.slots ?? invalid('slots')) {
      if (!isSlotName(slot.texture) || typeof slot.enabled !== 'boolean') invalid(`slot ${JSON.stringify(slot.texture)}`);
      if (seen.has(slot.texture.toLowerCase())) invalid(`slot ${JSON.stringify(slot.texture)} twice`);
      seen.add(slot.texture.toLowerCase());
    }
    if (!Array.isArray(p.layers)) invalid('layers is not an array');
    if (p.layers.length > MAX_LAYERS) invalid(`${p.layers.length} layers`);
  };

  const summary = (p: AtelierProject): AtelierProjectSummary => ({
    id: p.id,
    name: p.name,
    vehicle: p.vehicle,
    updatedAt: p.updatedAt,
    hasThumb: host.atelier().thumbs.has(p.id),
  });

  const header = (args: Args, name: string): string | undefined => {
    const headers = args.__headers as Record<string, string> | undefined;
    return headers?.[name];
  };

  const body = (args: Args): Uint8Array | undefined => (args.__body instanceof Uint8Array ? args.__body : undefined);

  const progress = (applyId: string, step: ApplyStep, pct: number, extra: Partial<ApplyProgress> = {}) =>
    host.emit(EVENTS.atelierApplyProgress, { applyId, step, pct, ...extra } satisfies ApplyProgress);

  return {
    atelier_model: (args) => {
      requireGame();
      const code = str('atelier_model', args, 'vehicle');
      vehicleOf(code);
      return encodeMockModel(code);
    },

    atelier_template_texture: (args) => {
      requireGame();
      const code = str('atelier_template_texture', args, 'vehicle');
      const slot = str('atelier_template_texture', args, 'slot');
      vehicleOf(code);
      const at = mockSlots(code).findIndex((s) => s.texture.toLowerCase() === slot.toLowerCase());
      if (at < 0) fail('notFound', TEXTURE_NOT_FOUND, slot);
      const rgba = mockTemplate(at);
      return rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
    },

    atelier_projects: () =>
      [...host.atelier().projects.values()]
        .map(summary)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),

    atelier_project_create: (args) => {
      const name = str('atelier_project_create', args, 'name');
      const code = str('atelier_project_create', args, 'vehicle');
      // Name and vehicle code first (`check_new`), then the game and the model.
      checkedName(name);
      if (!isVehicleCode(code)) fail('invalidInput', PROJECT_INVALID, `vehicle ${JSON.stringify(code)}`);
      requireGame();
      vehicleOf(code);
      const now = host.now();
      const created: AtelierProject = {
        version: 1,
        id: host.newId('p'),
        name: checkedName(name),
        vehicle: code,
        createdAt: now,
        updatedAt: now,
        slots: mockSlots(code).map((s) => ({ texture: s.texture, enabled: s.paintableByDefault })),
        output: { highQuality: false },
        layers: [],
      };
      host.atelier().projects.set(created.id, created);
      return created;
    },

    atelier_project_get: (args) => project(str('atelier_project_get', args, 'id')),

    atelier_project_save: (args) => {
      const incoming = args.project as AtelierProject | undefined;
      if (typeof incoming !== 'object' || incoming === null) return fail('internal', 'invalid args `project` for command `atelier_project_save`');
      const stored = project(incoming.id);
      checkEnvelope(incoming);
      const saved: AtelierProject = {
        ...incoming,
        name: checkedName(incoming.name),
        createdAt: stored.createdAt,
        updatedAt: host.now(),
        output: incoming.output ?? { highQuality: false },
        installedSkinId: incoming.installedSkinId ?? stored.installedSkinId,
      };
      host.atelier().projects.set(saved.id, saved);
      return saved;
    },

    atelier_project_duplicate: (args) => {
      const source = project(str('atelier_project_duplicate', args, 'id'));
      const names = new Set([...host.atelier().projects.values()].map((p) => p.name));
      const now = host.now();
      const copy: AtelierProject = {
        ...structuredClone(source),
        id: host.newId('p'),
        name: freeCopyName(source.name, (n) => names.has(n)),
        createdAt: now,
        updatedAt: now,
      };
      delete copy.installedSkinId;
      const st = host.atelier();
      st.projects.set(copy.id, copy);
      const thumb = st.thumbs.get(source.id);
      if (thumb) st.thumbs.set(copy.id, thumb.slice());
      return copy;
    },

    atelier_project_delete: (args) => {
      const id = str('atelier_project_delete', args, 'id');
      const p = project(id);
      const st = host.atelier();
      st.trash.set(id, { project: p, thumb: st.thumbs.get(id) });
      st.projects.delete(id);
      st.thumbs.delete(id);
      return null;
    },

    atelier_project_undo_delete: (args) => {
      const id = str('atelier_project_undo_delete', args, 'id');
      const st = host.atelier();
      const parked = st.trash.get(id) ?? fail('notFound', PROJECT_NOT_FOUND, id);
      if (st.projects.has(id)) fail('conflict', 'Could not save the Atelier project', `${id} exists`);
      st.projects.set(id, parked.project);
      if (parked.thumb) st.thumbs.set(id, parked.thumb);
      st.trash.delete(id);
      return null;
    },

    atelier_project_forget_deleted: (args) => {
      host.atelier().trash.delete(str('atelier_project_forget_deleted', args, 'id'));
      return null;
    },

    atelier_project_thumb: (args) => {
      const id = header(args, 'x-project-id') ?? fail('notFound', PROJECT_NOT_FOUND, 'no x-project-id header');
      const png = body(args) ?? fail('invalidInput', PROJECT_THUMB_INVALID, 'not a raw request body');
      project(id);
      if (png.length > MAX_THUMB_BYTES || !PNG_SIGNATURE.every((b, i) => png[i] === b)) {
        fail('invalidInput', PROJECT_THUMB_INVALID, `${png.length} bytes`);
      }
      host.atelier().thumbs.set(id, png.slice());
      return null;
    },

    atelier_project_thumb_get: (args) => {
      const id = str('atelier_project_thumb_get', args, 'id');
      project(id);
      const png = host.atelier().thumbs.get(id) ?? new Uint8Array(0);
      return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    },

    atelier_apply_begin: (args): ApplyStarted => {
      const projectId = str('atelier_apply_begin', args, 'projectId');
      const enabled = args.enabled;
      if (!Array.isArray(enabled) || !enabled.every((s): s is string => typeof s === 'string')) {
        return fail('internal', 'invalid args `enabled` for command `atelier_apply_begin`');
      }
      if (!host.hasGameFolder()) fail('invalidInput', 'No game folder set');
      const p = project(projectId);
      if (enabled.length === 0) fail('invalidInput', APPLY_NOTHING);
      const slots: string[] = [];
      for (const slot of enabled) {
        const known = p.slots.find((s) => s.texture.toLowerCase() === slot.toLowerCase()) ?? fail('invalidInput', APPLY_BAD_SLOT, slot);
        if (!slots.some((s) => s.toLowerCase() === known.texture.toLowerCase())) slots.push(known.texture);
      }
      // One apply per project (the mock has no stale timeout: a reload resets it anyway).
      const running = [...host.atelier().applies.entries()].find(([, job]) => job.projectId === p.id);
      if (running) fail('conflict', APPLY_FAILED, `another apply of this project is running (${running[0]})`);
      const applyId = host.newId('a');
      host.atelier().applies.set(applyId, {
        projectId: p.id,
        installedSkinId: p.installedSkinId,
        vehicle: p.vehicle,
        folder: mockFolderName(`${p.vehicle}_${p.name}`, p.vehicle),
        enabled: slots,
        written: [],
      });
      return { applyId };
    },

    atelier_apply_texture: async (args) => {
      const applyId = header(args, 'x-apply-id') ?? fail('notFound', APPLY_NOT_FOUND, 'no x-apply-id header');
      const slotHeader = header(args, 'x-slot') ?? fail('invalidInput', APPLY_BAD_SLOT, 'no x-slot header');
      const side = (name: string): number => {
        const value = header(args, name)?.trim() ?? '';
        return /^\d+$/.test(value) ? Number(value) : fail('invalidInput', APPLY_BAD_TEXTURE, `no number in ${name}`);
      };
      const w = side('x-width');
      const h = side('x-height');
      const rgba = body(args) ?? fail('invalidInput', APPLY_BAD_TEXTURE, 'not a raw request body');
      // The size is checked on the request before the apply is looked up (as in Rust).
      const sideOk = (s: number) => s > 0 && s <= MAX_APPLY_SIDE && s % 4 === 0;
      if (!sideOk(w) || !sideOk(h) || rgba.length !== w * h * 4) {
        fail('invalidInput', APPLY_BAD_TEXTURE, `${w}x${h} image in ${rgba.length} bytes`);
      }
      const job = host.atelier().applies.get(applyId) ?? fail('notFound', APPLY_NOT_FOUND, applyId);
      const at = job.enabled.findIndex((s) => s.toLowerCase() === slotHeader.toLowerCase());
      if (at < 0) fail('invalidInput', APPLY_BAD_SLOT, slotHeader);
      const n = job.enabled.length;
      const pct = (half: number) => Math.floor((TEXTURES_PCT * half) / (2 * n));
      progress(applyId, 'encode', pct(2 * at));
      await host.wait(ENCODE_MS);
      // Cancelled meanwhile: like Rust's check-in, the call fails.
      if (host.atelier().applies.get(applyId) !== job) fail('notFound', APPLY_NOT_FOUND, applyId);
      progress(applyId, 'write', pct(2 * at + 1));
      const slot = job.enabled[at] ?? slotHeader;
      if (!job.written.includes(slot)) job.written.push(slot);
      return null;
    },

    atelier_apply_commit: (args): ApplyResult => {
      const applyId = str('atelier_apply_commit', args, 'applyId');
      const st = host.atelier();
      const job = st.applies.get(applyId) ?? fail('notFound', APPLY_NOT_FOUND, applyId);
      st.applies.delete(applyId);
      const p = st.projects.get(job.projectId);
      progress(applyId, 'install', TEXTURES_PCT);
      try {
        if (!host.hasGameFolder()) fail('invalidInput', 'No game folder set');
        if (!job.enabled.some((s) => job.written.includes(s))) fail('invalidInput', APPLY_NOTHING);
        const vehicle = vehicleOf(job.vehicle);
        const replaceId = p ? (p.installedSkinId ?? job.installedSkinId) : job.installedSkinId;
        const { skin, backupId } = host.installGenerated({ replaceId, folder: job.folder, vehicle });
        if (p) st.projects.set(p.id, { ...p, installedSkinId: skin.id, updatedAt: host.now() });
        progress(applyId, 'done', 100, { skinId: skin.id, backupId });
        return backupId === undefined ? { skin } : { skin, backupId };
      } catch (e) {
        const message = typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : String(e);
        progress(applyId, 'error', TEXTURES_PCT, { message });
        throw e;
      }
    },

    atelier_apply_cancel: (args) => {
      host.atelier().applies.delete(str('atelier_apply_cancel', args, 'applyId'));
      return null;
    },
  };
}
