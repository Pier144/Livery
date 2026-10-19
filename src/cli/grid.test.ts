import { describe, expect, it } from 'vitest';
import { LABEL_H, LABEL_W, drawGrid, gridLine, labelBox } from './grid';

const LIGHT = [0xf2, 0xf2, 0xf2, 255];
const DARK = [0x10, 0x10, 0x10, 255];

function pixel(rgba: Uint8ClampedArray, size: number, x: number, y: number): number[] {
  const o = (y * size + x) * 4;
  return [...rgba.subarray(o, o + 4)];
}

describe('drawGrid', () => {
  const size = 256;

  it('draws light lines every 10 % with a dark outline on both sides', () => {
    const rgba = new Uint8ClampedArray(size * size * 4);
    drawGrid(rgba, size);
    const x = gridLine(size, 5);
    expect(x).toBe(128);
    // Down the middle line, away from the labels and the horizontal lines.
    const y = 90;
    expect(pixel(rgba, size, x, y)).toEqual(LIGHT);
    expect(pixel(rgba, size, x - 1, y)).toEqual(DARK);
    expect(pixel(rgba, size, x + 1, y)).toEqual(DARK);
    // Horizontal lines too, and a crossing stays light.
    expect(pixel(rgba, size, 90, gridLine(size, 3))).toEqual(LIGHT);
    expect(pixel(rgba, size, gridLine(size, 7), gridLine(size, 3))).toEqual(LIGHT);
  });

  it('leaves pixels far from the lines untouched', () => {
    const rgba = new Uint8ClampedArray(size * size * 4).fill(77);
    drawGrid(rgba, size);
    expect(pixel(rgba, size, 140, 140)).toEqual([77, 77, 77, 77]);
  });

  it('labels line 5 with a 5 on a dark box at the top and the left', () => {
    const rgba = new Uint8ClampedArray(size * size * 4);
    drawGrid(rgba, size);
    for (const edge of ['top', 'left'] as const) {
      const box = labelBox(size, 5, edge);
      const glyph: string[] = [];
      // Sample each font cell at its scaled top-left pixel (scale 2, 2 px margin).
      for (let ry = 0; ry < 5; ry++) {
        let row = '';
        for (let rx = 0; rx < 3; rx++) row += pixel(rgba, size, box.x + 2 + rx * 2, box.y + 2 + ry * 2)[0] === LIGHT[0] ? '#' : '.';
        glyph.push(row);
      }
      expect(glyph, edge).toEqual(['###', '#..', '###', '..#', '###']);
      // The box's margin is dark.
      expect(pixel(rgba, size, box.x, box.y)).toEqual(DARK);
      expect(pixel(rgba, size, box.x + LABEL_W - 1, box.y + LABEL_H - 1)).toEqual(DARK);
    }
    // The top label sits on its line, the left one across its line.
    expect(labelBox(size, 5, 'top').x).toBeLessThan(128);
    expect(labelBox(size, 5, 'top').x + LABEL_W).toBeGreaterThan(128);
  });
});
