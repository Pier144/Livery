// Real-WebGL check of the Atelier bake, for `pnpm dev:mock` only (nothing imports this file, so it
// never ships; it also refuses to run outside the mock). From the browser console of the mock:
//
//   await (await import('/src/dev/atelierGlCheck.ts')).runAtelierGlCheck()
//
// It bakes the mock cube with an image decal (a 2400×1600 cutout: an opaque disc, red kept under
// alpha 0 around it) on the +x/+z edge with Mirror on and the Base hidden, then compares the
// export with the TypeScript reference of the shaders (`decalSampleUv`, the detail map), checks
// the preview's premultiplied edges, the full-size export pictures, the shared-texel check on a
// cube whose −z face reuses the +z UVs, a text layer, and a WebGL context loss and restore.
// Each check reports `ok` and the numbers behind it.

import * as THREE from 'three';
import { detailMap } from '@/atelier/detailMap';
import { Baker, buildUnwrapped, decalCopies, decalSampleUv, type TemplateImage } from '@/atelier/gl/baker';
import { parseModelBuffer, type VehicleModelData } from '@/atelier/modelBuffer';
import type { BaseLayer, Decal, ImageLayer, Layer, TextLayer, Vec3 } from '@/atelier/project';
import { encodeMockModel, MOCK_TEXTURE_SIZE, mockTemplate } from './mockAtelier';

export interface GlCheck {
  name: string;
  ok: boolean;
  detail: Record<string, unknown>;
}

const SIZE = MOCK_TEXTURE_SIZE;
const PICTURE = { w: 2400, h: 1600, disc: { x: 1200, y: 800, r: 600 } };
const DISC_RGB: Vec3 = [214, 92, 64];
/** Picture pixels from the disc's edge treated as "edge" (mip blending reaches that far). */
const EDGE_BAND = 60;
const SQRT1_2 = Math.SQRT1_2;

function cutoutPicture() {
  const { w, h, disc } = PICTURE;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) rgba.set(Math.hypot(x - disc.x, y - disc.y) <= disc.r ? [...DISC_RGB, 255] : [255, 0, 0, 0], (y * w + x) * 4);
  return { rgba, w, h };
}

function mockModel(): VehicleModelData {
  return parseModelBuffer(encodeMockModel('glcheck'));
}

function templatesOf(model: VehicleModelData): Map<string, TemplateImage> {
  return new Map(model.header.slots.map((s, i) => [s.texture, { rgba: mockTemplate(i), w: SIZE, h: SIZE }]));
}

const hiddenBase: BaseLayer = { id: 'base', kind: 'base', name: '', visible: false, mode: 'solid', colors: ['#3050a0'], scale: 1, seed: 1 };
const edgeDecal: Decal = { center: [0.5, 0, 0.5], normal: [SQRT1_2, 0, SQRT1_2], up: [0, 1, 0], width: 0.7, height: 0.7, depth: 0.6, part: 'all', mirror: true };
const imageLayer: ImageLayer = { id: 'img', kind: 'image', name: '', visible: true, assetId: 'disc', decal: edgeDecal, opacity: 1, flipX: false };

/** The texel's model-space position, normal and group from the unwrapped triangles (null: no triangle). */
function texelLocator(model: VehicleModelData, slot: number) {
  const g = buildUnwrapped(model, slot);
  return (x: number, y: number) => {
    const s = (x + 0.5) / SIZE;
    const t = (y + 0.5) / SIZE;
    for (let k = 0; k < g.vertexCount; k += 3) {
      const [a, b, c] = [k, k + 1, k + 2];
      const ax = g.uvs[a * 2]!, ay = g.uvs[a * 2 + 1]!, bx = g.uvs[b * 2]!, by = g.uvs[b * 2 + 1]!, cx = g.uvs[c * 2]!, cy = g.uvs[c * 2 + 1]!;
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      const l1 = ((by - cy) * (s - cx) + (cx - bx) * (t - cy)) / d;
      const l2 = ((cy - ay) * (s - cx) + (ax - cx) * (t - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const lerp = (arr: Float32Array, n: number, i: number) => l1 * arr[a * n + i]! + l2 * arr[b * n + i]! + l3 * arr[c * n + i]!;
      return {
        pos: [lerp(g.positions, 3, 0), lerp(g.positions, 3, 1), lerp(g.positions, 3, 2)] as Vec3,
        normal: [lerp(g.normals, 3, 0), lerp(g.normals, 3, 1), lerp(g.normals, 3, 2)] as Vec3,
        group: g.groups[a]!,
      };
    }
    return null;
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAtelierGlCheck(): Promise<{ ok: boolean; checks: GlCheck[] }> {
  if (import.meta.env.VITE_MOCK_BACKEND !== '1') throw new Error('atelierGlCheck runs in pnpm dev:mock only');
  const checks: GlCheck[] = [];
  const add = (name: string, ok: boolean, detail: Record<string, unknown>) => checks.push({ name, ok, detail });
  const model = mockModel();
  const templates = templatesOf(model);
  const slots = model.header.slots.map((s) => s.texture);
  const body = slots[0]!;
  const picture = cutoutPicture();

  // ── Image decal: export vs the TS reference, mirror, hidden Base, edges, full-size pictures.
  {
    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas') });
    const loads: string[] = [];
    const baker = new Baker(renderer, model, templates, {
      loadAsset: async (id) => {
        loads.push(id);
        return picture;
      },
    });
    try {
      const layers: Layer[] = [hiddenBase, imageLayer];
      baker.setLayers(layers, slots);
      await baker.whenReady();
      const cache = (baker as unknown as { decalTextures: { keys(): string[]; get(k: string): THREE.Texture | null } }).decalTextures;
      const previewPicture = cache.get('img:disc:p')?.image as { width: number } | undefined;
      await baker.prepareExport(false);
      const fullPicture = cache.get('img:disc:f')?.image as { width: number } | undefined;
      const out = baker.bakeForExport(body, false);
      baker.endExport();
      add('export uses full-size pictures', previewPicture?.width === 1200 && fullPicture?.width === 2400 && loads.length === 2 && !cache.keys().includes('img:disc:f'), {
        preview: previewPicture?.width,
        full: fullPicture?.width,
        loads: loads.length,
        keysAfter: cache.keys(),
      });

      const detail = detailMap(templates.get(body)!.rgba, SIZE, SIZE);
      const locate = texelLocator(model, 0);
      const copies = decalCopies(edgeDecal, model.header.mirrorAxis);
      let compared = 0;
      let maxErr = 0;
      let transparentBad = 0;
      let edgeMaxDev = 0;
      const opaqueByCell = [0, 0, 0, 0, 0, 0];
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          const texel = locate(x, y);
          if (!texel) continue;
          const o = (y * SIZE + x) * 4;
          const px = out.rgba.subarray(o, o + 4);
          let state: 'none' | 'inside' | 'outside' | 'edge' = 'none';
          for (const d of copies) {
            const uv = decalSampleUv(texel, d, false);
            if (!uv) continue;
            const dist = Math.hypot(uv[0] * PICTURE.w - PICTURE.disc.x, uv[1] * PICTURE.h - PICTURE.disc.y) - PICTURE.disc.r;
            const here = dist < -EDGE_BAND ? 'inside' : dist > EDGE_BAND ? 'outside' : 'edge';
            if (state === 'none' || here === 'inside' || (here === 'edge' && state === 'outside')) state = here;
          }
          const det = detail[y * SIZE + x]!;
          if (state === 'inside') {
            compared++;
            const err = Math.max(...DISC_RGB.map((v, i) => Math.abs(Math.min(255, v * det) - px[i]!)), Math.abs(255 - px[3]!));
            maxErr = Math.max(maxErr, err);
            opaqueByCell[Math.floor(y / (SIZE / 2)) * 3 + Math.floor(x / (SIZE / 3))]! += 1;
          } else if (state !== 'edge') {
            if (px[3] !== 0) transparentBad++;
          } else if (px[3]! >= 16 && px[3]! < 255) {
            edgeMaxDev = Math.max(edgeMaxDev, ...DISC_RGB.map((v, i) => Math.abs(px[i]! / det - v)));
          }
        }
      add('export equals the TS reference inside the decal', compared > 1000 && maxErr <= 2, { compared, maxErr: +maxErr.toFixed(2) });
      add('hidden Base: alpha only where the decal covers', transparentBad === 0, { transparentBad });
      // Cells: 0 = +x, 2 = +z, 3 = −z (the mirrored copy).
      add('decal crosses two faces, mirrored copy on the opposite face', opaqueByCell[0]! > 0 && opaqueByCell[2]! > 0 && opaqueByCell[3]! > 0 && opaqueByCell[1] === 0, {
        opaqueByCell,
      });
      add('no halo at export edges (alpha ≥ 16)', edgeMaxDev <= 16, { edgeMaxDev: +edgeMaxDev.toFixed(1) });

      const target = (baker as unknown as { slots: { paintSmall: THREE.WebGLRenderTarget | null }[] }).slots[0]!.paintSmall!;
      const pre = new Uint8Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pre);
      let premultiplied = true;
      let previewDev = 0;
      for (let i = 0; i < target.width * target.height; i++) {
        const o = i * 4;
        const a = pre[o + 3]!;
        if (pre[o]! > a + 1 || pre[o + 1]! > a + 1 || pre[o + 2]! > a + 1) premultiplied = false;
        if (a < 16 || a === 255) continue;
        previewDev = Math.max(previewDev, ...DISC_RGB.map((v, c) => Math.abs((pre[o + c]! * 255) / a / detail[i]! - v)));
      }
      add('preview is premultiplied without halos', premultiplied && previewDev <= 20, { premultiplied, previewDev: +previewDev.toFixed(1) });

      // Context loss and restore: the same export afterwards.
      const opaque = (rgba: Uint8Array) => {
        let n = 0;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 255) n++;
        return n;
      };
      const before = opaque(out.rgba);
      const lose = renderer.getContext().getExtension('WEBGL_lose_context');
      if (lose) {
        lose.loseContext();
        await tick(150);
        let refused = false;
        try {
          baker.bakeForExport(body, false);
        } catch {
          refused = true;
        }
        lose.restoreContext();
        await tick(300);
        await baker.whenReady();
        await baker.prepareExport(false);
        const after = opaque(baker.bakeForExport(body, false).rgba);
        baker.endExport();
        add('context loss: refused while lost, same export after restore', refused && after === before, { refused, before, after });
      } else {
        add('context loss: refused while lost, same export after restore', true, { skipped: 'no WEBGL_lose_context' });
      }
    } finally {
      baker.dispose();
      renderer.dispose();
    }
  }

  // ── Shared texels (−z reuses the +z UVs) and a text layer.
  {
    const shared = mockModel();
    for (let i = 0; i < 8; i++) shared.uvs[3 * 8 + i] = shared.uvs[2 * 8 + i]!;
    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas') });
    const baker = new Baker(renderer, shared, templates, {});
    try {
      const text: TextLayer = {
        id: 'txt',
        kind: 'text',
        name: '',
        visible: true,
        text: 'LIVERY',
        font: { family: 'Geist', style: 'Regular' },
        color: '#ffffff',
        outlineColor: '#000000',
        outlineWidth: 8,
        skew: 0,
        decal: { center: [0.5, 0, 0], normal: [1, 0, 0], up: [0, 1, 0], width: 0.8, height: 0.2, depth: 0.1, part: 'all', mirror: false },
        opacity: 1,
      };
      baker.setLayers([{ ...hiddenBase, visible: true }, text], slots);
      await baker.whenReady();
      await baker.prepareExport(false);
      const out = baker.bakeForExport(body, false);
      baker.endExport();
      let white = 0;
      let dark = 0;
      for (let y = 0; y < SIZE / 2; y++)
        for (let x = 0; x < SIZE / 3; x++) {
          const o = (y * SIZE + x) * 4;
          const [r, g, b] = [out.rgba[o]!, out.rgba[o + 1]!, out.rgba[o + 2]!];
          if (r > 180 && g > 180 && b > 180) white++;
          else if (r < 40 && g < 40 && b < 40) dark++;
        }
      add('text layer draws its fill and outline', white > 20 && dark > 20, { white, dark });
      const face = (center: Vec3, normal: Vec3): Decal => ({ center, normal, up: [0, 1, 0], width: 0.3, height: 0.3, depth: 0.1, part: 'all', mirror: false });
      const onShared = await baker.decalTouchesSharedTexels(face([0, 0, 0.5], [0, 0, 1]));
      const onOwn = await baker.decalTouchesSharedTexels(face([0.5, 0, 0], [1, 0, 0]));
      add('shared-texel check', onShared && !onOwn, { onShared, onOwn });
    } finally {
      baker.dispose();
      renderer.dispose();
    }
  }

  const report = { ok: checks.every((c) => c.ok), checks };
  console.table(checks.map((c) => ({ check: c.name, ok: c.ok, ...c.detail })));
  return report;
}
