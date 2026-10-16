import type { PartGroup } from '@/types';

/**
 * GLSL of the Atelier bake (spec §2 "Bake", plan Task 20) and the TypeScript mirrors of its
 * maths, so Vitest checks what the GPU computes without WebGL.
 *
 * Every bake pass draws the slot's mesh **unwrapped**: `gl_Position = (uv · 2 − 1, 0, 1)` with
 * the raw DirectX UVs (v = 0 is the top of the texture). v = 0 lands on framebuffer row 0, which
 * `readRenderTargetPixels` returns first, so read-back is top-to-bottom with no flip, and the
 * same raw UVs sample the bake targets, the template and the detail map consistently. Each
 * fragment gets the texel's model-space position, normal and part group as varyings.
 *
 * Colour model: all values are sRGB numbers (0..1), like the Jumbo script; nothing goes through
 * three's linear conversion, and the bake targets are plain RGBA8 / R8 (`NoColorSpace`).
 *
 * The shaders are written for three's `ShaderMaterial` on WebGL 2 (three adds `#version 300 es`,
 * the built-in `position` / `normal` / `uv` attributes and maps `gl_FragColor` / `texture2D`).
 */

/** Points per mask stamping draw (`uPoints[64]`). */
export const BAKE_MAX_POINTS = 64;
/** A texel is stamped only when its normal faces the stroke: `dot(n, −dir) > FACING_MIN`. */
export const FACING_MIN = 0.2;
/** Hardness is capped below 1 so `smoothstep(inner, r, d)` never gets equal edges. */
export const MAX_HARDNESS = 0.999;
/** The part group as the shaders see it (`partGroup` attribute, `uParams.z`); −1 = every part. */
export const GROUP_INDEX: Record<PartGroup, number> = { hull: 0, turret: 1, gun: 2 };
/** Camo: model units (metres) per noise cell at scale 1. */
export const CAMO_CELL = 0.8;
/** Camo: weights of the two value-noise octaves (the second at twice the frequency). */
export const CAMO_OCTAVE_WEIGHTS: readonly [number, number] = [0.65, 0.35];
/** Camo: offset of the second octave, so its lattice doesn't line up with the first. */
export const CAMO_OCTAVE_OFFSET: readonly [number, number, number] = [17.31, 5.27, 11.83];
/** Camo: added to the seed of the second octave (golden-ratio constant, wraps at 2³²). */
export const CAMO_SEED_STEP = 0x9e3779b9;
/**
 * Camo thresholds per colour count: the quantiles of `camoNoise` at k / count, measured over
 * 400k random points, so each colour covers about the same area (baker.test.ts checks the
 * shares). Unused entries are 2 (never reached).
 */
export const CAMO_THRESHOLDS: Record<number, readonly [number, number, number]> = {
  1: [2, 2, 2],
  2: [0.5, 2, 2],
  3: [0.438, 0.562, 2],
  4: [0.404, 0.5, 0.596],
};

// ---------------------------------------------------------------- TypeScript mirrors

/** lowbias32 integer hash (Chris Wellons), the same in GLSL (`lvHash`). */
export function hash32(x: number): number {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Lattice value in [0, 1) of integer cell (x, y, z): 24 bits, exact in a float32 on the GPU too. */
export function latticeValue(x: number, y: number, z: number, seed: number): number {
  const h = hash32((seed >>> 0) ^ hash32((x >>> 0) ^ hash32((y >>> 0) ^ hash32(z >>> 0))));
  return (h >>> 8) / 16777216;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const fade = (t: number) => t * t * (3 - 2 * t);

/** Trilinear value noise with a smoothstep fade, in [0, 1). */
export function valueNoise(px: number, py: number, pz: number, seed: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const ux = fade(px - ix);
  const uy = fade(py - iy);
  const uz = fade(pz - iz);
  const v = (dx: number, dy: number, dz: number) => latticeValue(ix + dx, iy + dy, iz + dz, seed);
  return lerp(
    lerp(lerp(v(0, 0, 0), v(1, 0, 0), ux), lerp(v(0, 1, 0), v(1, 1, 0), ux), uy),
    lerp(lerp(v(0, 0, 1), v(1, 0, 1), ux), lerp(v(0, 1, 1), v(1, 1, 1), ux), uy),
    uz,
  );
}

/** Two octaves of value noise at `p` (already multiplied by the frequency), in [0, 1). */
export function camoNoise(px: number, py: number, pz: number, seed: number): number {
  const [w1, w2] = CAMO_OCTAVE_WEIGHTS;
  const [ox, oy, oz] = CAMO_OCTAVE_OFFSET;
  return (
    w1 * valueNoise(px, py, pz, seed) +
    w2 * valueNoise(px * 2 + ox, py * 2 + oy, pz * 2 + oz, (seed + CAMO_SEED_STEP) >>> 0)
  );
}

/** Which camo colour a noise value picks: how many thresholds it reaches (GLSL: sum of `step`). */
export function camoIndex(n: number, thresholds: readonly [number, number, number]): number {
  return (n >= thresholds[0] ? 1 : 0) + (n >= thresholds[1] ? 1 : 0) + (n >= thresholds[2] ? 1 : 0);
}

/** `1 − smoothstep(r · hardness, r, d)`: the brush weight of one point at distance `d`. */
export function brushWeight(d: number, radius: number, hardness: number): number {
  const inner = radius * Math.min(Math.max(hardness, 0), MAX_HARDNESS);
  const t = Math.min(1, Math.max(0, (d - inner) / (radius - inner)));
  return 1 - t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- GLSL

const NOISE_GLSL = /* glsl */ `
uint lvHash(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float lvLattice(ivec3 c, uint seed) {
  uint h = lvHash(seed ^ lvHash(uint(c.x) ^ lvHash(uint(c.y) ^ lvHash(uint(c.z)))));
  return float(h >> 8u) * (1.0 / 16777216.0);
}

float lvValueNoise(vec3 p, uint seed) {
  vec3 i = floor(p);
  vec3 u = p - i;
  u = u * u * (3.0 - 2.0 * u);
  ivec3 c = ivec3(i);
  float n000 = lvLattice(c, seed);
  float n100 = lvLattice(c + ivec3(1, 0, 0), seed);
  float n010 = lvLattice(c + ivec3(0, 1, 0), seed);
  float n110 = lvLattice(c + ivec3(1, 1, 0), seed);
  float n001 = lvLattice(c + ivec3(0, 0, 1), seed);
  float n101 = lvLattice(c + ivec3(1, 0, 1), seed);
  float n011 = lvLattice(c + ivec3(0, 1, 1), seed);
  float n111 = lvLattice(c + ivec3(1, 1, 1), seed);
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

float lvCamoNoise(vec3 p, uint seed) {
  return ${CAMO_OCTAVE_WEIGHTS[0].toFixed(4)} * lvValueNoise(p, seed)
    + ${CAMO_OCTAVE_WEIGHTS[1].toFixed(4)} * lvValueNoise(
        p * 2.0 + vec3(${CAMO_OCTAVE_OFFSET.map((v) => v.toFixed(4)).join(', ')}),
        seed + ${CAMO_SEED_STEP >>> 0}u);
}
`;

/**
 * Unwrapped vertex shader shared by every bake pass. Attributes: `position` (model space),
 * `normal`, `uv` (raw UVs shifted into 0..1 per triangle on the CPU), `partGroup` (0 hull,
 * 1 turret, 2 gun) and `triSphere` (the triangle's centroid and bounding radius, the same on its
 * three vertices). With `LV_BATCH_CULL`, triangles entirely outside the stamping batch's
 * bounding sphere `uSphere` are moved outside the clip volume (all three vertices alike).
 */
export const BAKE_VERTEX = /* glsl */ `
attribute float partGroup;
attribute vec4 triSphere;
uniform vec4 uSphere;
varying vec3 vPos;
varying vec3 vNormal;
varying float vGroup;
varying vec2 vUv;

void main() {
  vPos = position;
  vNormal = normal;
  vGroup = partGroup;
  vUv = uv;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
#ifdef LV_BATCH_CULL
  if (distance(triSphere.xyz, uSphere.xyz) > uSphere.w + triSphere.w) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
#endif
}
`;

/**
 * Mask stamping: the per-texel weight of a batch of brush points is the max over the points of
 * `1 − smoothstep(r · hardness, r, |vPos − p|)`, zero for texels of another part or not facing
 * the stroke direction. Paint writes `w` with `MaxEquation`, erase writes `1 − w` with
 * `MinEquation`: idempotent and associative, so stamping a stroke in any batch split (while
 * painting) and replaying it whole give the same mask (`maskAt` in baker.ts is the reference).
 *
 * `uPoints[i]` = (x, y, z, radius); `uParams` = (hardness, erase 0/1, part group or −1, count).
 */
export const MASK_FRAGMENT = /* glsl */ `
#define LV_MAX_POINTS ${BAKE_MAX_POINTS}
uniform vec4 uPoints[LV_MAX_POINTS];
uniform vec4 uParams;
uniform vec3 uDir;
varying vec3 vPos;
varying vec3 vNormal;
varying float vGroup;

void main() {
  if (uParams.z >= 0.0 && abs(vGroup - uParams.z) > 0.5) discard;
  // Facing test without normalize(): a zero-length normal is never stamped (as in stampWeight).
  float normalLength = length(vNormal);
  if (normalLength <= 0.0 || dot(vNormal, -uDir) <= ${FACING_MIN.toFixed(2)} * normalLength) discard;
  float hardness = clamp(uParams.x, 0.0, ${MAX_HARDNESS});
  int count = int(uParams.w + 0.5);
  float w = 0.0;
  for (int i = 0; i < LV_MAX_POINTS; i++) {
    if (i >= count) break;
    vec4 p = uPoints[i];
    w = max(w, 1.0 - smoothstep(p.w * hardness, p.w, distance(vPos, p.xyz)));
  }
  if (w <= 0.0) discard;
  float v = uParams.y > 0.5 ? 1.0 - w : w;
  gl_FragColor = vec4(v, v, v, v);
}
`;

/**
 * Paint pass: the Base (solid `uColors[0]`, or camo: `lvCamoNoise(vPos · uFrequency, seed)`
 * split by `uThresholds` into `uColors[0..3]`), times the template's detail factor (R16F,
 * sampled at the texel's UV), alpha = 1 − mask (the protected areas show the game's texture).
 * `uBaseAlpha` is 0 when the Base is hidden (nothing painted).
 *
 * `uPremultiply` 1 (preview targets) writes `rgb · a`: the cleared background (0, 0, 0, 0) is
 * then a valid transparent texel, so bilinear filtering and mipmaps at UV island edges don't
 * darken the paint (`PREVIEW_MAP_FRAGMENT` composites premultiplied). Export writes straight
 * alpha (`uPremultiply` 0) and dilates the islands instead.
 */
export const PAINT_FRAGMENT = /* glsl */ `
${NOISE_GLSL}
uniform int uMode;
uniform vec3 uColors[4];
uniform vec3 uThresholds;
uniform float uFrequency;
uniform int uSeed;
uniform sampler2D uDetail;
uniform float uHasDetail;
uniform sampler2D uMask;
uniform float uHasMask;
uniform float uBaseAlpha;
uniform float uPremultiply;
varying vec3 vPos;
varying vec2 vUv;

void main() {
  vec3 color = uColors[0];
  if (uMode == 1) {
    float n = lvCamoNoise(vPos * uFrequency, uint(uSeed));
    int index = int(step(uThresholds.x, n) + step(uThresholds.y, n) + step(uThresholds.z, n));
    color = uColors[index];
  }
  float detail = uHasDetail > 0.5 ? texture2D(uDetail, vUv).r : 1.0;
  float mask = uHasMask > 0.5 ? texture2D(uMask, vUv).r : 0.0;
  float alpha = uBaseAlpha * (1.0 - mask);
  color = clamp(color * detail, 0.0, 1.0);
  gl_FragColor = vec4(uPremultiply > 0.5 ? color * alpha : color, alpha);
}
`;

/** Coverage pass (export only): 1 wherever a triangle lands, for the seam dilation. */
export const COVERAGE_FRAGMENT = /* glsl */ `
void main() {
  gl_FragColor = vec4(1.0);
}
`;

/**
 * Preview: replaces `map_fragment` of a `MeshStandardMaterial` (`onBeforeCompile`), whose `map`
 * is the slot's template (sRGB data, `NoColorSpace`). The paint is premultiplied, so this is
 * `mix(template, paint, paint.a)` as `T · (1 − a) + P.rgb`, in sRGB, then decoded to linear for
 * the lighting; `uPaintMix` 0 shows the template alone.
 */
export const PREVIEW_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  vec4 lvTemplate = texture2D( map, vMapUv );
  vec4 lvPaint = texture2D( uPaint, vMapUv ) * uPaintMix;
  vec3 lvSrgb = lvTemplate.rgb * ( 1.0 - lvPaint.a ) + lvPaint.rgb;
  diffuseColor.rgb *= sRGBTransferEOTF( vec4( lvSrgb, 1.0 ) ).rgb;
#endif
`;

/** Uniform declarations the preview fragment needs (prepended to `main`). */
export const PREVIEW_UNIFORMS = /* glsl */ `
uniform sampler2D uPaint;
uniform float uPaintMix;
`;
