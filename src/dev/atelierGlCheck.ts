// Real-WebGL check of the Atelier bake, for `pnpm dev:mock` only (nothing imports this file, so it
// never ships; it also refuses to run outside the mock). From the browser console of the mock:
//
//   await (await import('/src/dev/atelierGlCheck.ts')).runAtelierGlCheck()
//
// It bakes the mock cube with an image decal (a 2400×1600 cutout: an opaque disc, red kept under
// alpha 0 around it) on the +x/+z edge with Mirror on and the Base hidden, then compares the
// export with the TypeScript reference of the shaders (`decalSample` with its facing fade,
// `compositeTexel`, the detail map), does the same with a decal tilted so the +x face sits on the
// fade (cos θ = 0.5: half alpha), checks
// the preview's premultiplied edges, the full-size export pictures, the shared-texel check on a
// cube whose −z face reuses the +z UVs, a text layer, and a WebGL context loss and restore.
// Each check reports `ok` and the numbers behind it.

import * as THREE from 'three';
import { detailMap } from '@/atelier/detailMap';
import { Baker, buildUnwrapped, compositeTexel, decalContribution, decalCopies, decalSample, hexToSrgb, type Rgba, type TemplateImage } from '@/atelier/gl/baker';
import { camoParams, camoWeights } from '@/atelier/gl/camo';
import { parseModelBuffer, type VehicleModelData } from '@/atelier/modelBuffer';
import { CAMO_PATTERNS, type BaseLayer, type Decal, type ImageLayer, type Layer, type TextLayer, type Vec3 } from '@/atelier/project';
import { encodeMockModel, MOCK_TEXTURE_SIZE, mockTemplate } from './mockAtelier';

export interface GlCheck {
  name: string;
  ok: boolean;
  detail: Record<string, unknown>;
}

const SIZE = MOCK_TEXTURE_SIZE;
const PICTURE = { w: 2400, h: 1600, disc: { x: 1200, y: 800, r: 600 } };
const DISC_RGB: Vec3 = [214, 92, 64];
/**
 * Picture pixels from the disc's edge treated as "edge" and not compared: a bake texel spans about
 * 40 picture pixels here (more on a tilted face), so trilinear mip blending reaches ~150 px.
 */
const EDGE_BAND = 160;
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
/** Tilted 60° from +x: the +x face takes half the decal (cos θ = 0.5), the +z face all of it. */
const tiltedDecal: Decal = { ...edgeDecal, normal: [0.5, 0, Math.sqrt(3) / 2], mirror: false };
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
      const compare = (rgba: Uint8Array, decal: Decal) => {
        const copies = decalCopies(decal, model.header.mirrorAxis);
        const stats = { worst: null as unknown, compared: 0, maxErr: 0, transparentBad: 0, edgeMaxDev: 0, opaqueByCell: [0, 0, 0, 0, 0, 0], halfAlphaByCell: [0, 0, 0, 0, 0, 0] };
        const disc: Rgba = [DISC_RGB[0] / 255, DISC_RGB[1] / 255, DISC_RGB[2] / 255, 1];
        for (let y = 0; y < SIZE; y++)
          for (let x = 0; x < SIZE; x++) {
            const texel = locate(x, y);
            if (!texel) continue;
            const o = (y * SIZE + x) * 4;
            const px = rgba.subarray(o, o + 4);
            const det = detail[y * SIZE + x]!;
            const cell = Math.floor(y / (SIZE / 2)) * 3 + Math.floor(x / (SIZE / 3));
            // Contributions of the copies in draw order; a texel near the disc's edge (mip blending) isn't compared.
            const contributions: Rgba[] = [];
            let edge = false;
            for (const d of copies) {
              const sample = decalSample(texel, d, false);
              if (!sample) continue;
              const dist = Math.hypot(sample.uv[0] * PICTURE.w - PICTURE.disc.x, sample.uv[1] * PICTURE.h - PICTURE.disc.y) - PICTURE.disc.r;
              if (Math.abs(dist) <= EDGE_BAND) edge = true;
              else if (dist < 0) contributions.push(decalContribution(disc, 1, sample.weight));
            }
            if (edge) {
              if (px[3]! >= 16 && px[3]! < 255) stats.edgeMaxDev = Math.max(stats.edgeMaxDev, ...DISC_RGB.map((v, i) => Math.abs(px[i]! / det - v)));
              continue;
            }
            const ref = compositeTexel({ rgb: [0, 0, 0], alpha: 0 }, contributions, det, 0, false).map((v) => v * 255);
            if (ref[3]! === 0) {
              if (px[3] !== 0) stats.transparentBad++;
              continue;
            }
            stats.compared++;
            // Colour is stored premultiplied in 8 bits: compare it in premultiplied units (error × alpha).
            const colourErr = Math.max(...[0, 1, 2].map((i) => (Math.abs(ref[i]! - px[i]!) * ref[3]!) / 255));
            const err = Math.max(colourErr, Math.abs(ref[3]! - px[3]!));
            if (err > stats.maxErr) stats.worst = { x, y, px: [...px], ref: ref.map((v) => +v.toFixed(1)) };
            stats.maxErr = Math.max(stats.maxErr, err);
            if (px[3] === 255) stats.opaqueByCell[cell]! += 1;
            else if (Math.abs(px[3]! - 128) <= 3) stats.halfAlphaByCell[cell]! += 1;
          }
        stats.maxErr = +stats.maxErr.toFixed(2);
        stats.edgeMaxDev = +stats.edgeMaxDev.toFixed(1);
        return stats;
      };
      const edge = compare(out.rgba, edgeDecal);
      add('export equals the TS reference inside the decal', edge.compared > 1000 && edge.maxErr <= 2, { compared: edge.compared, maxErr: edge.maxErr });
      add('hidden Base: alpha only where the decal covers', edge.transparentBad === 0, { transparentBad: edge.transparentBad });
      // Cells: 0 = +x, 1 = −x, 2 = +z, 3 = −z (the mirrored copy).
      const cells = edge.opaqueByCell;
      add('decal crosses two faces, mirrored copy on the opposite face', cells[0]! > 0 && cells[2]! > 0 && cells[3]! > 0 && cells[1] === 0, { opaqueByCell: cells });
      add('no halo at export edges (alpha ≥ 16)', edge.edgeMaxDev <= 16, { edgeMaxDev: edge.edgeMaxDev });

      // The tilted decal: the +x face on the fade (half alpha), +z at full strength.
      baker.setLayers([hiddenBase, { ...imageLayer, decal: tiltedDecal }], slots);
      await baker.whenReady();
      await baker.prepareExport(false);
      const tilted = compare(baker.bakeForExport(body, false).rgba, tiltedDecal);
      baker.endExport();
      add('steep faces fade (cos θ = 0.5 gives half alpha)', tilted.maxErr <= 2 && tilted.halfAlphaByCell[0]! > 100 && tilted.opaqueByCell[2]! > 100 && tilted.opaqueByCell[0] === 0, {
        compared: tilted.compared,
        maxErr: tilted.maxErr,
        worst: tilted.worst,
        halfAlphaOnPlusX: tilted.halfAlphaByCell[0],
        opaqueOnPlusZ: tilted.opaqueByCell[2],
        opaqueOnPlusX: tilted.opaqueByCell[0],
      });
      baker.setLayers(layers, slots);
      await baker.whenReady();

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

  // ── Camo styles: every style, sharp and soft, against camoWeights (camo.ts).
  {
    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas') });
    const baker = new Baker(renderer, model, templates, {});
    const locate = texelLocator(model, 0);
    const detail = detailMap(templates.get(body)!.rgba, SIZE, SIZE);
    const colors = ['#d03020', '#20a040', '#2040c0', '#e0e040'];
    const rgb = colors.map(hexToSrgb);
    try {
      for (const pattern of CAMO_PATTERNS)
        for (const softness of [0, 0.5]) {
          const base: BaseLayer = { ...hiddenBase, visible: true, mode: 'camo', colors, scale: 0.3, seed: 5, ...(pattern === 'organic' ? {} : { pattern }), ...(softness ? { softness } : {}) };
          baker.setLayers([base], slots);
          await baker.whenReady();
          await baker.prepareExport(false);
          const out = baker.bakeForExport(body, false).rgba;
          baker.endExport();
          const prm = camoParams(base);
          let compared = 0;
          let bad = 0;
          let maxErr = 0;
          const used = new Set<number>();
          for (let y = 0; y < SIZE; y++)
            for (let x = 0; x < SIZE; x++) {
              const texel = locate(x, y);
              if (!texel) continue;
              const w = camoWeights(texel.pos, texel.normal, prm);
              used.add(w.indexOf(Math.max(...w)));
              const mixed: Vec3 = [0, 1, 2].map((c) => w.reduce((a, k, i) => a + k * rgb[i]![c]!, 0)) as Vec3;
              const ref = compositeTexel({ rgb: mixed, alpha: 1 }, [], detail[y * SIZE + x]!, 0, false).map((v) => v * 255);
              const o = (y * SIZE + x) * 4;
              const err = Math.max(...[0, 1, 2].map((c) => Math.abs(ref[c]! - out[o + c]!)));
              compared++;
              maxErr = Math.max(maxErr, err);
              if (err > 3) bad++;
            }
          add(`camo ${pattern}${softness ? ' soft' : ''} equals camoWeights`, compared > 1000 && bad / compared < 0.01 && used.size >= 3, { compared, bad, maxErr: +maxErr.toFixed(1), colours: used.size });
        }
    } finally {
      baker.dispose();
      renderer.dispose();
    }
  }

  const report = { ok: checks.every((c) => c.ok), checks };
  console.table(checks.map((c) => ({ check: c.name, ok: c.ok, ...c.detail })));
  return report;
}
