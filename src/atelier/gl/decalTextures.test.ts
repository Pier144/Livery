import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DecalTextureCache, prepareDecalImage, premultiply, PREVIEW_DECAL_MAX, reduce, reductionFor, type DecalImage } from './decalTextures';

const tick = () => new Promise((r) => setTimeout(r, 0));

function picture(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): DecalImage {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(px(x, y), (y * w + x) * 4);
  return { rgba, w, h };
}

describe('decal picture preparation', () => {
  it('premultiplies colour by alpha', () => {
    expect([...premultiply(new Uint8Array([255, 128, 0, 128, 255, 0, 0, 0, 10, 20, 30, 255]))]).toEqual([128, 64, 0, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
  });

  it('reduces by an integer box filter to fit the preview cap', () => {
    expect(reductionFor(4096, 1024, PREVIEW_DECAL_MAX)).toBe(2);
    expect(reductionFor(3000, 10, PREVIEW_DECAL_MAX)).toBe(2);
    expect(reductionFor(2048, 2048, PREVIEW_DECAL_MAX)).toBe(1);
    const r = reduce(new Uint8Array([0, 0, 0, 0, 200, 100, 50, 255, 100, 0, 0, 255]), 3, 1, 2);
    expect(r).toMatchObject({ w: 2, h: 1 });
    expect([...r.rgba]).toEqual([100, 50, 25, 128, 100, 0, 0, 255]);
  });

  it('never lets a red background kept under alpha 0 tint the edge texels', () => {
    // A cutout: opaque white on the left half, red kept under alpha 0 on the right.
    const cut = picture(8, 2, (x) => (x < 4 ? [255, 255, 255, 255] : [255, 0, 0, 0]));
    const reduced = prepareDecalImage(cut, 4); // factor 2: the edge block mixes x = 2,3 | 4,5
    const edge = reduced.rgba.subarray(4 * 2, 4 * 3); // block x = 4,5: all transparent
    expect([...edge]).toEqual([0, 0, 0, 0]);
    // A block straddling the edge (bilinear or a mip) un-premultiplies to white, not pink.
    const mixed = reduce(premultiply(picture(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [255, 0, 0, 0])).rgba), 2, 1, 2).rgba;
    expect([...mixed]).toEqual([128, 128, 128, 128]);
    expect(Math.round((mixed[0]! * 255) / mixed[3]!)).toBe(Math.round((mixed[1]! * 255) / mixed[3]!));
  });
});

describe('DecalTextureCache', () => {
  function cache() {
    const onSettled = vi.fn();
    const created: THREE.Texture[] = [];
    const c = new DecalTextureCache({
      onSettled,
      createTexture: (img) => {
        const t = new THREE.Texture();
        t.userData = { w: img.w, h: img.h };
        vi.spyOn(t, 'dispose');
        created.push(t);
        return t;
      },
    });
    return { c, onSettled, created };
  }
  const img = (w = 2, h = 2): DecalImage => ({ rgba: new Uint8Array(w * h * 4).fill(255), w, h });

  it('loads a key once for every reference and disposes it with the last', async () => {
    const { c, onSettled, created } = cache();
    const make = vi.fn(async () => img());
    c.acquire('a', make);
    c.acquire('a', make);
    expect(c.settled('a')).toBe(false);
    await c.whenSettled(['a']);
    expect(make).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('a');
    expect(c.get('a')).toBe(created[0]);
    c.release('a');
    expect(c.refs('a')).toBe(1);
    expect(created[0]!.dispose).not.toHaveBeenCalled();
    c.release('a');
    expect(c.keys()).toEqual([]);
    expect(created[0]!.dispose).toHaveBeenCalled();
  });

  it('drops a load that ends after the last release', async () => {
    const { c, onSettled, created } = cache();
    let finish!: (v: DecalImage) => void;
    c.acquire('a', () => new Promise((r) => (finish = r)));
    c.release('a');
    finish(img());
    await tick();
    expect(onSettled).not.toHaveBeenCalled();
    expect(created[0]!.dispose).toHaveBeenCalled();
  });

  it('settles failed and empty loads with no texture', async () => {
    const { c } = cache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.acquire('bad', async () => {
      throw new Error('no such asset');
    });
    c.acquire('none', async () => null);
    await c.whenSettled(['bad', 'none']);
    expect(c.settled('bad') && c.settled('none')).toBe(true);
    expect(c.get('bad')).toBeNull();
    expect(c.get('none')).toBeNull();
    warn.mockRestore();
  });

  it('caps preview copies and reloads everything after a context loss', async () => {
    const { c, created } = cache();
    const make = vi.fn(async () => img(4100, 10));
    c.acquire('big', make);
    c.acquire('full', make, Infinity);
    await c.whenSettled(['big', 'full']);
    // 4100 / ceil(4100 / 2048) = 3 → 1367 × 4.
    expect(c.get('big')!.userData).toEqual({ w: 1367, h: 4 });
    expect(c.get('full')!.userData).toEqual({ w: 4100, h: 10 });
    c.reloadAll();
    expect(created[0]!.dispose).toHaveBeenCalled();
    await c.whenSettled(['big', 'full']);
    expect(make).toHaveBeenCalledTimes(4);
    c.dispose();
    expect(created.slice(2).every((t) => vi.mocked(t.dispose).mock.calls.length === 1)).toBe(true);
  });
});
