/**
 * Edge dilation of a baked slot: texels no triangle covers take the colour of the island next to
 * them, `px` texels deep, so lower mips and bilinear filtering in game don't pull the black (or
 * transparent) background into the seams.
 *
 * Each iteration, every uncovered texel with at least one covered 4-neighbour becomes the
 * (rounded) average of those neighbours' RGBA and is marked covered; texels covered during an
 * iteration are only read from the next one, so the growth is exactly one texel per iteration
 * (an L1 / diamond growth). Works in place on `rgba` and `covered` (non-zero = covered).
 * After the first full scan only the neighbours of the last ring are visited.
 */
export const DILATE_PX = 4;

function accumulate(rgba: Uint8Array, j: number, sum: Uint32Array): void {
  const p = j * 4;
  sum[0]! += rgba[p]!;
  sum[1]! += rgba[p + 1]!;
  sum[2]! += rgba[p + 2]!;
  sum[3]! += rgba[p + 3]!;
  sum[4]! += 1;
}

export function dilate(rgba: Uint8Array, covered: Uint8Array, w: number, h: number, px = DILATE_PX): void {
  const n = w * h;
  if (rgba.length < n * 4 || covered.length < n) throw new Error('dilate: buffer too small');
  if (px <= 0 || n === 0) return;

  /** Iteration that last queued each texel (0 = never), so a texel is queued once per ring. */
  const queued = new Uint16Array(n);
  let candidates: number[] = [];
  const hasCoveredNeighbour = (i: number, x: number, y: number) =>
    (x > 0 && covered[i - 1] !== 0) ||
    (x < w - 1 && covered[i + 1] !== 0) ||
    (y > 0 && covered[i - w] !== 0) ||
    (y < h - 1 && covered[i + w] !== 0);

  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (covered[i] === 0 && hasCoveredNeighbour(i, x, y)) {
        candidates.push(i);
        queued[i] = 1;
      }
    }
  }

  let values = new Uint8Array(candidates.length * 4);
  /** RGBA sums and the neighbour count. */
  const sum = new Uint32Array(5);
  for (let iter = 1; iter <= px && candidates.length > 0; iter++) {
    if (values.length < candidates.length * 4) values = new Uint8Array(candidates.length * 4);
    // 1. Values from texels covered before this ring.
    for (let k = 0; k < candidates.length; k++) {
      const i = candidates[k]!;
      const x = i % w;
      const y = (i - x) / w;
      sum.fill(0);
      if (x > 0 && covered[i - 1] !== 0) accumulate(rgba, i - 1, sum);
      if (x < w - 1 && covered[i + 1] !== 0) accumulate(rgba, i + 1, sum);
      if (y > 0 && covered[i - w] !== 0) accumulate(rgba, i - w, sum);
      if (y < h - 1 && covered[i + w] !== 0) accumulate(rgba, i + w, sum);
      const count = sum[4]!;
      const q = k * 4;
      for (let c = 0; c < 4; c++) values[q + c] = Math.round(sum[c]! / count);
    }
    // 2. Write them and mark the ring covered.
    for (let k = 0; k < candidates.length; k++) {
      const i = candidates[k]!;
      for (let c = 0; c < 4; c++) rgba[i * 4 + c] = values[k * 4 + c]!;
      covered[i] = 1;
    }
    if (iter === px) break;
    // 3. Next ring: uncovered neighbours of this one.
    const next: number[] = [];
    const stamp = iter + 1;
    const visit = (j: number) => {
      if (covered[j] === 0 && queued[j] !== stamp) {
        queued[j] = stamp;
        next.push(j);
      }
    };
    for (const i of candidates) {
      const x = i % w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i + w < n) visit(i + w);
    }
    candidates = next;
  }
}
