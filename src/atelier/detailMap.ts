/**
 * The template's detail factor map: what keeps panel lines, rivets, weld seams and grime visible
 * under a new paint. Port of `detail_map` in the Jumbo script (`Livery-skin-lab/jumbo-megumin/make_skin.py`):
 *
 *   L     = template luminance (0.299 R + 0.587 G + 0.114 B, 0..255; the template's own brightness,
 *           i.e. already the ×2 the game applies)
 *   local = Gaussian blur of L, sigma 24 px at 2048 (scaled with the width)
 *   d     = clamp((L + 1) / (local + 1), 0.6, 1.3)        panel lines, rivets
 *   glob  = clamp(local / mean(local), 0.6, 1.3)          broad dirt and shading
 *   out   = d^0.6 · glob^0.35
 *
 * The paint (sRGB values) is multiplied by `out`. Pure and allocation-bounded (three float
 * buffers of `w·h`), O(1) per pixel whatever the sigma.
 */

/** Sigma of the local mean at a template 2048 px wide (PIL's `GaussianBlur(24)`). */
export const DETAIL_SIGMA_AT_2048 = 24;
export const DETAIL_MIN = 0.6;
export const DETAIL_MAX = 1.3;
const D_EXPONENT = 0.6;
const GLOB_EXPONENT = 0.35;
/** Box passes approximating the Gaussian (PIL uses 3 as well). */
export const GAUSS_BOX_PASSES = 3;

/**
 * Box widths (odd) whose `n` successive passes approximate a Gaussian of `sigma`: the standard
 * formula (W. Jarosz / I. Kutskir), widths `wl` or `wl + 2` chosen so the variances add up to sigma².
 */
export function boxesForGauss(sigma: number, n = GAUSS_BOX_PASSES): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl -= 1;
  wl = Math.max(1, wl);
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/** One horizontal box pass of radius `r` (edges clamped), `src` → `dst`, running sums. */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row]!;
    // Window [-r-1, r-1] (edge clamped); each step adds x+r and drops x-r-1.
    let acc = (r + 1) * first;
    for (let j = 0; j < r; j++) acc += src[row + (j < last ? j : last)]!;
    for (let x = 0; x < w; x++) {
      const add = x + r;
      const drop = x - r - 1;
      acc += src[row + (add < last ? add : last)]! - src[row + (drop > 0 ? drop : 0)]!;
      dst[row + x] = acc * inv;
    }
  }
}

/**
 * One vertical box pass, row by row with a running sum per column (`acc`, length `w`), so memory is
 * read in order instead of striding down columns.
 */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, acc: Float64Array): void {
  const inv = 1 / (2 * r + 1);
  const last = h - 1;
  for (let x = 0; x < w; x++) acc[x] = (r + 1) * src[x]!;
  for (let j = 0; j < r; j++) {
    const row = (j < last ? j : last) * w;
    for (let x = 0; x < w; x++) acc[x]! += src[row + x]!;
  }
  for (let y = 0; y < h; y++) {
    const add = y + r;
    const drop = y - r - 1;
    const addRow = (add < last ? add : last) * w;
    const dropRow = (drop > 0 ? drop : 0) * w;
    const out = y * w;
    for (let x = 0; x < w; x++) {
      const a = acc[x]! + src[addRow + x]! - src[dropRow + x]!;
      acc[x] = a;
      dst[out + x] = a * inv;
    }
  }
}

/**
 * Gaussian blur of a single-channel float image by successive box blurs (edges clamped).
 * `src` is left untouched; `scratch`, when given, must hold `w·h` floats and is overwritten.
 */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number, scratch?: Float32Array): Float32Array {
  const out = new Float32Array(src);
  if (sigma <= 0 || w === 0 || h === 0) return out;
  const tmp = scratch ?? new Float32Array(w * h);
  const acc = new Float64Array(w);
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) / 2;
    if (r === 0) continue;
    boxH(out, tmp, w, h, r);
    boxV(tmp, out, w, h, r, acc);
  }
  return out;
}

/** Sigma of the local mean for a template `w` px wide. */
export function detailSigma(w: number): number {
  return (DETAIL_SIGMA_AT_2048 * w) / 2048;
}

const clamp = (v: number) => (v < DETAIL_MIN ? DETAIL_MIN : v > DETAIL_MAX ? DETAIL_MAX : v);

/**
 * The detail factor per texel (row-major, same orientation as `rgba`), from an RGBA8 template of
 * `w × h`. Values lie in 0.6^0.95 .. 1.3^0.95.
 */
export function detailMap(rgba: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  if (rgba.length < n * 4) throw new Error('detailMap: buffer too small');
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
  }
  const out = new Float32Array(n);
  // `out` doubles as the blur's scratch: it is only written for real after the blur.
  const local = gaussianBlur(lum, w, h, detailSigma(w), out);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += local[i]!;
  const mean = n > 0 ? sum / n : 0;
  const invMean = mean > 0 ? 1 / mean : 0;
  for (let i = 0; i < n; i++) {
    const l = local[i]!;
    const d = clamp((lum[i]! + 1) / (l + 1));
    const glob = mean > 0 ? clamp(l * invMean) : 1;
    out[i] = Math.pow(d, D_EXPONENT) * Math.pow(glob, GLOB_EXPONENT);
  }
  return out;
}
