import type { ModelHeader, ModelPart, ModelSlot, PartGroup } from '@/types';

/**
 * The binary `atelier_model` answers (`src-tauri/src/game/gameres/assemble.rs`, `encode`),
 * little-endian: the magic `"LVM1"`, a `u32` header length, the header JSON (UTF-8, padded with
 * spaces to a multiple of 4, so the arrays that follow are 4-byte aligned), then f32 positions
 * (3 per vertex), f32 normals (3), f32 UVs (2, origin top-left) and u32 indices (absolute).
 * Right-handed model space (the z axis the game's left-handed data had is negated).
 */
export const MODEL_MAGIC = 'LVM1';
/** Magic plus the header length. */
export const MODEL_PREAMBLE_BYTES = 8;
export const POSITION_COMPONENTS = 3;
export const NORMAL_COMPONENTS = 3;
export const UV_COMPONENTS = 2;

/** A parsed model: the header and typed views over the same buffer (no copies). */
export interface VehicleModelData {
  header: ModelHeader;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Bytes of the arrays that follow the header of a model with these counts. */
export function modelArraysBytes(vertexCount: number, indexCount: number): number {
  return 4 * (vertexCount * (POSITION_COMPONENTS + NORMAL_COMPONENTS + UV_COMPONENTS) + indexCount);
}

function bad(why: string): never {
  throw new Error(`model buffer: ${why}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const GROUPS: readonly PartGroup[] = ['hull', 'turret', 'gun'];

function checkSlot(v: unknown, i: number): ModelSlot {
  if (
    !isObject(v) ||
    typeof v.texture !== 'string' ||
    !isCount(v.width) ||
    !isCount(v.height) ||
    typeof v.hq !== 'boolean' ||
    typeof v.paintableByDefault !== 'boolean'
  ) {
    return bad(`slot ${i}`);
  }
  return { texture: v.texture, width: v.width, height: v.height, hq: v.hq, paintableByDefault: v.paintableByDefault };
}

function checkPart(v: unknown, i: number, header: { slots: number; vertexCount: number; indexCount: number }): ModelPart {
  if (
    !isObject(v) ||
    typeof v.node !== 'string' ||
    !GROUPS.includes(v.group as PartGroup) ||
    !isCount(v.slot) ||
    !isCount(v.vertexOffset) ||
    !isCount(v.vertexCount) ||
    !isCount(v.indexOffset) ||
    !isCount(v.indexCount)
  ) {
    return bad(`part ${i}`);
  }
  if (v.slot >= header.slots) bad(`part ${i}: slot ${v.slot}`);
  if (v.vertexOffset + v.vertexCount > header.vertexCount) bad(`part ${i}: vertices`);
  if (v.indexOffset + v.indexCount > header.indexCount || v.indexCount % 3 !== 0) bad(`part ${i}: indices`);
  return {
    node: v.node,
    group: v.group as PartGroup,
    slot: v.slot,
    vertexOffset: v.vertexOffset,
    vertexCount: v.vertexCount,
    indexOffset: v.indexOffset,
    indexCount: v.indexCount,
  };
}

function checkHeader(v: unknown): ModelHeader {
  if (
    !isObject(v) ||
    typeof v.vehicle !== 'string' ||
    typeof v.model !== 'string' ||
    !isCount(v.mirrorAxis) ||
    v.mirrorAxis > 2 ||
    !Array.isArray(v.slots) ||
    !Array.isArray(v.parts) ||
    !isCount(v.vertexCount) ||
    !isCount(v.indexCount)
  ) {
    return bad('header');
  }
  const slots = v.slots.map(checkSlot);
  const counts = { slots: slots.length, vertexCount: v.vertexCount, indexCount: v.indexCount };
  return {
    vehicle: v.vehicle,
    model: v.model,
    mirrorAxis: v.mirrorAxis,
    slots,
    parts: v.parts.map((p, i) => checkPart(p, i, counts)),
    vertexCount: v.vertexCount,
    indexCount: v.indexCount,
  };
}

/**
 * Reads an `LVM1` buffer into its header and typed arrays (views over `buf`). Throws
 * `Error('model buffer: …')` when the magic, the lengths, a part's offsets or an index don't
 * check out, so a damaged buffer never reaches WebGL.
 */
export function parseModelBuffer(buf: ArrayBuffer): VehicleModelData {
  if (buf.byteLength < MODEL_PREAMBLE_BYTES) bad('too short');
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== MODEL_MAGIC) bad('magic');
  const headerLen = new DataView(buf).getUint32(4, true);
  if (headerLen % 4 !== 0 || MODEL_PREAMBLE_BYTES + headerLen > buf.byteLength) bad('header length');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(MODEL_PREAMBLE_BYTES, MODEL_PREAMBLE_BYTES + headerLen)));
  } catch {
    return bad('header JSON');
  }
  const header = checkHeader(json);
  const { vertexCount, indexCount } = header;
  const start = MODEL_PREAMBLE_BYTES + headerLen;
  if (buf.byteLength !== start + modelArraysBytes(vertexCount, indexCount)) bad('length');

  let at = start;
  const floats = (components: number) => {
    const view = new Float32Array(buf, at, vertexCount * components);
    at += view.byteLength;
    return view;
  };
  const positions = floats(POSITION_COMPONENTS);
  const normals = floats(NORMAL_COMPONENTS);
  const uvs = floats(UV_COMPONENTS);
  const indices = new Uint32Array(buf, at, indexCount);
  const outside = indices.findIndex((i) => i >= vertexCount);
  if (outside >= 0) bad(`index ${outside}`);
  return { header, positions, normals, uvs, indices };
}
