/**
 * The `render --grid` overlay: lines every 10 % of the picture with their tenth (`1` … `9`)
 * along the top and the left edge, so a point read on the picture can be given to `place --at`.
 * Drawn straight into the RGBA pixels (a built-in 3×5 digit font, no canvas text).
 *
 * The two colours are picture pixels for the agent, not UI colours, so CLAUDE.md's token rule
 * doesn't apply: a light line with a dark outline on both sides reads on any paint.
 */

const LIGHT = [0xf2, 0xf2, 0xf2] as const;
const DARK = [0x10, 0x10, 0x10] as const;

/** 3×5 bitmaps of the digits 1 to 9, rows from the top. */
const DIGITS: Record<number, readonly string[]> = {
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '###', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '..#', '..#', '..#'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'],
};
const SCALE = 2;
const PAD = 2;
/** Label box: the scaled digit plus its dark margin. */
export const LABEL_W = 3 * SCALE + 2 * PAD;
export const LABEL_H = 5 * SCALE + 2 * PAD;
/** Gap between the picture's edge and a label box. */
const EDGE = 2;

/** Position of line `k` (1..9) in a picture `size` px wide. */
export function gridLine(size: number, k: number): number {
  return Math.round((size * k) / 10);
}

/** Top-left corner of the label of line `k`: at the top of a vertical line or the left of a horizontal one. */
export function labelBox(size: number, k: number, edge: 'top' | 'left'): { x: number; y: number } {
  const at = gridLine(size, k);
  return edge === 'top' ? { x: at - Math.floor(LABEL_W / 2), y: EDGE } : { x: EDGE, y: at - Math.floor(LABEL_H / 2) };
}

function put(rgba: Uint8ClampedArray, size: number, x: number, y: number, c: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const o = (y * size + x) * 4;
  rgba[o] = c[0];
  rgba[o + 1] = c[1];
  rgba[o + 2] = c[2];
  rgba[o + 3] = 255;
}

function label(rgba: Uint8ClampedArray, size: number, k: number, box: { x: number; y: number }): void {
  for (let y = 0; y < LABEL_H; y++) for (let x = 0; x < LABEL_W; x++) put(rgba, size, box.x + x, box.y + y, DARK);
  const rows = DIGITS[k]!;
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < 3; rx++) {
      if (row[rx] !== '#') continue;
      for (let sy = 0; sy < SCALE; sy++)
        for (let sx = 0; sx < SCALE; sx++) put(rgba, size, box.x + PAD + rx * SCALE + sx, box.y + PAD + ry * SCALE + sy, LIGHT);
    }
  });
}

/** Draws the grid and its labels on a square straight-alpha RGBA picture (rows from the top), in place. */
export function drawGrid(rgba: Uint8ClampedArray, size: number): void {
  // Outlines first, then the lines, so a crossing stays light; labels last, on top.
  for (const colour of [DARK, LIGHT]) {
    for (let k = 1; k <= 9; k++) {
      const at = gridLine(size, k);
      const offsets = colour === DARK ? [-1, 1] : [0];
      for (const d of offsets) {
        for (let i = 0; i < size; i++) {
          put(rgba, size, at + d, i, colour);
          put(rgba, size, i, at + d, colour);
        }
      }
    }
  }
  for (let k = 1; k <= 9; k++) {
    label(rgba, size, k, labelBox(size, k, 'top'));
    label(rgba, size, k, labelBox(size, k, 'left'));
  }
}
