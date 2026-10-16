import { describe, expect, it } from 'vitest';
import { encodeMockModel, mockSlots } from '@/dev/mockAtelier';
import { MODEL_PREAMBLE_BYTES, parseModelBuffer } from './modelBuffer';

/** A copy of `buf` with `edit` applied to its bytes. */
function edited(buf: ArrayBuffer, edit: (bytes: Uint8Array, view: DataView) => void): ArrayBuffer {
  const copy = buf.slice(0);
  edit(new Uint8Array(copy), new DataView(copy));
  return copy;
}

/** The buffer with its header JSON replaced (re-padded), arrays kept. */
function withHeader(buf: ArrayBuffer, change: (header: Record<string, unknown>) => void): ArrayBuffer {
  const view = new DataView(buf);
  const len = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, MODEL_PREAMBLE_BYTES, len))) as Record<string, unknown>;
  change(header);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const arrays = new Uint8Array(buf, MODEL_PREAMBLE_BYTES + len);
  const out = new Uint8Array(MODEL_PREAMBLE_BYTES + padded + arrays.length);
  out.set(new Uint8Array(buf, 0, 4));
  new DataView(out.buffer).setUint32(4, padded, true);
  out.fill(0x20, MODEL_PREAMBLE_BYTES, MODEL_PREAMBLE_BYTES + padded);
  out.set(json, MODEL_PREAMBLE_BYTES);
  out.set(arrays, MODEL_PREAMBLE_BYTES + padded);
  return out.buffer;
}

describe('parseModelBuffer', () => {
  it('reads the mock cube back: header, slots, parts and arrays as views over the buffer', () => {
    const buf = encodeMockModel('germ_leopard_2a6');
    const model = parseModelBuffer(buf);

    expect(model.header.vehicle).toBe('germ_leopard_2a6');
    expect(model.header.mirrorAxis).toBe(2);
    expect(model.header.slots).toEqual(mockSlots('germ_leopard_2a6'));
    expect(model.header.parts.map((p) => [p.node, p.group, p.slot])).toEqual([
      ['@root', 'hull', 0],
      ['bone_turret', 'turret', 1],
      ['bone_gun', 'gun', 2],
    ]);
    // Hull: 5 faces, turret: 1, gun: 6; 4 vertices and 6 indices each.
    expect(model.header.parts.map((p) => [p.vertexCount, p.indexCount])).toEqual([
      [20, 30],
      [4, 6],
      [24, 36],
    ]);
    expect(model.header.vertexCount).toBe(48);
    expect(model.positions).toHaveLength(48 * 3);
    expect(model.normals).toHaveLength(48 * 3);
    expect(model.uvs).toHaveLength(48 * 2);
    expect(model.indices).toHaveLength(72);
    expect(model.positions.buffer).toBe(buf);
    expect(model.indices.buffer).toBe(buf);
    // Parts follow each other.
    const [hull, turret, gun] = model.header.parts;
    expect(turret?.vertexOffset).toBe(hull?.vertexCount);
    expect(gun?.indexOffset).toBe((hull?.indexCount ?? 0) + (turret?.indexCount ?? 0));
  });

  it('keeps UVs inside 0..1 and every triangle facing its normal (counter-clockwise from outside)', () => {
    const { positions, normals, uvs, indices } = parseModelBuffer(encodeMockModel());
    for (const uv of uvs) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
    const p = (i: number) => [positions[3 * i] ?? 0, positions[3 * i + 1] ?? 0, positions[3 * i + 2] ?? 0];
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const e1 = pb.map((v, k) => v - (pa[k] ?? 0));
      const e2 = pc.map((v, k) => v - (pa[k] ?? 0));
      const n = [
        (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
        (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
        (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
      ];
      const facing = n[0]! * normals[3 * a]! + n[1]! * normals[3 * a + 1]! + n[2]! * normals[3 * a + 2]!;
      expect(facing).toBeGreaterThan(0);
    }
  });

  it('refuses a wrong magic, a short buffer, a bad header length and trailing bytes', () => {
    const buf = encodeMockModel();
    expect(() => parseModelBuffer(new ArrayBuffer(4))).toThrow(/model buffer/);
    expect(() => parseModelBuffer(edited(buf, (b) => (b[0] = 0x58)))).toThrow(/model buffer: magic/);
    expect(() => parseModelBuffer(edited(buf, (_, v) => v.setUint32(4, 6, true)))).toThrow(/model buffer: header length/);
    expect(() => parseModelBuffer(edited(buf, (_, v) => v.setUint32(4, 1 << 30, true)))).toThrow(/model buffer: header length/);
    const longer = new Uint8Array(buf.byteLength + 4);
    longer.set(new Uint8Array(buf));
    expect(() => parseModelBuffer(longer.buffer)).toThrow(/model buffer: length/);
    expect(() => parseModelBuffer(buf.slice(0, buf.byteLength - 4))).toThrow(/model buffer: length/);
  });

  it('refuses a header that is not the model JSON, and parts outside the arrays', () => {
    const buf = encodeMockModel();
    expect(() => parseModelBuffer(edited(buf, (b) => (b[MODEL_PREAMBLE_BYTES] = 0x5b)))).toThrow(/model buffer/);
    expect(() => parseModelBuffer(withHeader(buf, (h) => delete h.slots))).toThrow(/model buffer: header/);
    expect(() =>
      parseModelBuffer(withHeader(buf, (h) => ((h.parts as Record<string, unknown>[])[0]!.slot = 7))),
    ).toThrow(/model buffer: part 0: slot/);
    expect(() =>
      parseModelBuffer(withHeader(buf, (h) => ((h.parts as Record<string, unknown>[])[2]!.vertexCount = 999))),
    ).toThrow(/model buffer: part 2: vertices/);
    expect(() =>
      parseModelBuffer(withHeader(buf, (h) => ((h.parts as Record<string, unknown>[])[1]!.group = 'wing'))),
    ).toThrow(/model buffer: part 1/);
  });

  it('refuses an index past the last vertex', () => {
    const buf = encodeMockModel();
    const bad = edited(buf, (_, v) => v.setUint32(buf.byteLength - 4, 48, true));
    expect(() => parseModelBuffer(bad)).toThrow(/model buffer: index 71/);
  });
});
