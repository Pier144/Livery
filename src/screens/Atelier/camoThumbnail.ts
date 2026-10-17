import { hexToSrgb } from '@/atelier/gl/baker';
import { camoParams, camoWeights, PATTERN_INDEX } from '@/atelier/gl/camo';
import type { BaseLayer, CamoPattern } from '@/atelier/project';

/** Thumbnail size in pixels and the patch of a vehicle's side it shows, in model units. */
export const THUMB_W = 64;
export const THUMB_H = 40;
export const THUMB_PATCH_W = 3;
/** Grid cells are drawn at least this many thumbnail pixels wide, so small cells don't alias. */
const MIN_CELL_PX = 3;

/**
 * Draws `base` as camo style `pattern` on a flat side patch (normal +Z, like a hull side) into
 * `ctx`, with the project's colours, shares, cell size, angle and softness, from `camoWeights`:
 * what the bake paints on such a face, minus the detail of the game's texture.
 */
export function drawCamoThumbnail(ctx: CanvasRenderingContext2D, base: BaseLayer, pattern: CamoPattern): void {
  const params = camoParams({ ...base, mode: 'camo', pattern });
  const px = THUMB_PATCH_W / THUMB_W;
  if (params.pattern === PATTERN_INDEX.digital || params.pattern === PATTERN_INDEX.hex || params.pattern === PATTERN_INDEX.triangles) {
    const minCell = MIN_CELL_PX * px;
    if (params.cell < minCell) {
      params.soft *= minCell / params.cell;
      params.cell = minCell;
    }
  }
  const colors = [0, 1, 2, 3].map((i) => hexToSrgb(base.colors[Math.min(i, params.count - 1)] ?? '#000000'));
  const image = ctx.createImageData(THUMB_W, THUMB_H);
  for (let y = 0; y < THUMB_H; y++)
    for (let x = 0; x < THUMB_W; x++) {
      const w = camoWeights([(x + 0.5) * px, (THUMB_H - y - 0.5) * px, 0], [0, 0, 1], params);
      const o = (y * THUMB_W + x) * 4;
      for (let c = 0; c < 3; c++) image.data[o + c] = Math.round(255 * (w[0] * colors[0]![c]! + w[1] * colors[1]![c]! + w[2] * colors[2]![c]! + w[3] * colors[3]![c]!));
      image.data[o + 3] = 255;
    }
  ctx.putImageData(image, 0, 0);
}
