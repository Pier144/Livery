import type { PartGroup } from '@/types';
import { DECAL_FADE_END, DECAL_FADE_START, FACING_MIN } from '../decal';

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
/**
 * A texel is stamped by a brush stroke only when its normal faces the stroke:
 * `dot(n, −dir) > FACING_MIN · |n|`. Decals fade instead (`facingWeight`). One definition of
 * each, in decal.ts, for the TS maths and the GLSL.
 */
export { DECAL_FADE_END, DECAL_FADE_START, FACING_MIN };
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

/**
 * Wear (chipped paint, `wear` on the Base, images and text). A texel's wear field is
 * `chipNoise(pos / WEAR_CELL) + WEAR_EDGE_BOOST · (1 − smoothstep(0, WEAR_EDGE_WIDTH, d))`, with
 * `d` its distance to the nearest sharp convex edge of the model (`wear.ts`); the paint is chipped
 * where the field reaches `wearThreshold(amount)`. Low amounts only reach the edges, high ones the
 * flat surfaces too. One field for every layer, so a decal's chips fall on the Base's.
 */
/** Model units (metres) per noise cell of the chips. */
export const WEAR_CELL = 0.028;
/** How far from a sharp edge (metres) the edge still adds to the field. */
export const WEAR_EDGE_WIDTH = 0.06;
/** What a sharp edge adds to the field. */
export const WEAR_EDGE_BOOST = 0.5;
/** Field threshold at the smallest wear (only the edges' highest noise reaches it) and at full wear. */
export const WEAR_THRESHOLD_MIN_WEAR = 0.82 + WEAR_EDGE_BOOST;
export const WEAR_THRESHOLD_FULL_WEAR = 0.5;
/**
 * Weights, frequencies and offsets of the value-noise octaves of the chips (the high ones give
 * them ragged rims instead of round blobs).
 */
export const WEAR_OCTAVE_WEIGHTS: readonly number[] = [0.42, 0.28, 0.18, 0.12];
export const WEAR_OCTAVE_FREQUENCIES: readonly number[] = [1, 2.13, 4.37, 9.1];
export const WEAR_OCTAVE_OFFSET: readonly number[] = [0, 3.9, 47.1, 12.3];
/** Seed of the chips' noise (fixed: the chips don't move when colours or the camo seed change). */
export const WEAR_SEED = 0x2545f491;
/** Under the Base's chips: bare steel, with rust specks. */
export const WEAR_METAL = '#3a3936';
export const WEAR_RUST = '#5a3420';
/** Model units per noise cell of the rust specks inside the chips, and the noise band they fill. */
export const WEAR_RUST_CELL = 0.05;
export const WEAR_RUST_FROM = 0.5;
export const WEAR_RUST_TO = 0.68;
/** Width (in field units) of the darker rim around the Base's chips, and how much it darkens. */
export const WEAR_RIM = 0.06;
export const WEAR_RIM_DARKEN = 0.35;
/** Distance written for edges that aren't sharp (never near). */
export const WEAR_FAR = 1e4;
/** The threshold uniform without wear: no field reaches it, and the shaders skip the noise. */
export const WEAR_NONE = 1e6;

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

/** The chips' noise at `p` (already divided by WEAR_CELL): the octaves of value noise, in [0, 1). */
export function chipNoise(px: number, py: number, pz: number): number {
  let n = 0;
  for (let i = 0; i < WEAR_OCTAVE_WEIGHTS.length; i++) {
    const f = WEAR_OCTAVE_FREQUENCIES[i]!;
    const o = WEAR_OCTAVE_OFFSET[i]!;
    n += WEAR_OCTAVE_WEIGHTS[i]! * valueNoise(px * f + o, py * f + o, pz * f + o, (WEAR_SEED + i * CAMO_SEED_STEP) >>> 0);
  }
  return n;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The wear field of a texel at model position `p`, `edgeDistance` metres from the nearest sharp edge. */
export function wearField(p: readonly [number, number, number], edgeDistance: number): number {
  const edge = 1 - smoothstep(0, WEAR_EDGE_WIDTH, edgeDistance);
  return chipNoise(p[0] / WEAR_CELL, p[1] / WEAR_CELL, p[2] / WEAR_CELL) + WEAR_EDGE_BOOST * edge;
}

/** The field a texel needs to be chipped at `amount` (0..1); above every field at 0 (nothing chips). */
export function wearThreshold(amount: number): number {
  if (!(amount > 0)) return Infinity;
  const a = Math.min(1, amount);
  return WEAR_THRESHOLD_MIN_WEAR + (WEAR_THRESHOLD_FULL_WEAR - WEAR_THRESHOLD_MIN_WEAR) * a;
}

/** How chipped a texel is (0..1): the field against the threshold, `aa` field units of anti-aliasing. */
export function chipAmount(field: number, amount: number, aa = 0): number {
  const t = wearThreshold(amount);
  if (!Number.isFinite(t)) return 0;
  return aa > 0 ? smoothstep(t - aa, t + aa, field) : field >= t ? 1 : 0;
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

const glslFloat = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * Wear, shared by the base and decal passes: `lvEdgeDistance()` is the texel's distance to the
 * nearest sharp convex edge of its triangle (`vBary` · per-edge heights `vEdgeH`, negative for
 * edges that aren't sharp); `lvWearField()` and `lvChip(threshold)` mirror `wearField` and
 * `chipAmount` (anti-aliased over the field's screen derivative, taken before any discard).
 */
const WEAR_GLSL = /* glsl */ `
varying vec3 vBary;
varying vec3 vEdgeH;

float lvEdgeDistance() {
  vec3 d = mix(vec3(${glslFloat(WEAR_FAR)}), vBary * vEdgeH, step(0.0, vEdgeH));
  return min(min(d.x, d.y), d.z);
}

float lvChipNoise(vec3 p) {
  float n = 0.0;
${WEAR_OCTAVE_WEIGHTS.map(
  (w, i) =>
    `  n += ${glslFloat(w)} * lvValueNoise(p * ${glslFloat(WEAR_OCTAVE_FREQUENCIES[i]!)} + vec3(${glslFloat(WEAR_OCTAVE_OFFSET[i]!)}), ${(WEAR_SEED + i * CAMO_SEED_STEP) >>> 0}u);`,
).join('\n')}
  return n;
}

float lvWearField() {
  float edge = 1.0 - smoothstep(0.0, ${glslFloat(WEAR_EDGE_WIDTH)}, lvEdgeDistance());
  return lvChipNoise(vPos / ${glslFloat(WEAR_CELL)}) + ${glslFloat(WEAR_EDGE_BOOST)} * edge;
}

float lvChip(float field, float threshold) {
  float aa = max(fwidth(field), 1e-4);
  return smoothstep(threshold - aa, threshold + aa, field);
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
attribute vec3 edgeBary;
attribute vec3 edgeH;
uniform vec4 uSphere;
varying vec3 vPos;
varying vec3 vNormal;
varying float vGroup;
varying vec2 vUv;
varying vec3 vBary;
varying vec3 vEdgeH;

void main() {
  vPos = position;
  vNormal = normal;
  vGroup = partGroup;
  vUv = uv;
  vBary = edgeBary;
  vEdgeH = edgeH;
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
 * Paint, step 1 (base pass, into the scratch intermediate, premultiplied): the Base (solid
 * `uColors[0]`, or camo: `lvCamoNoise(vPos · uFrequency, seed)` split by `uThresholds` into
 * `uColors[0..3]`) as `(rgb · a, a)` with `a = uBaseAlpha` (0 when the Base is hidden: the game's
 * texture shows wherever no decal covers). With wear (`uWearThreshold` finite), `wearBaseColor`:
 * a darker rim around the chips, and bare metal (rust in patches) inside them.
 */
export const BASE_FRAGMENT = /* glsl */ `
${NOISE_GLSL}
varying vec3 vPos;
${WEAR_GLSL}
uniform int uMode;
uniform vec3 uColors[4];
uniform vec3 uThresholds;
uniform float uFrequency;
uniform int uSeed;
uniform float uBaseAlpha;
uniform float uWearThreshold;
uniform vec3 uWearMetal;
uniform vec3 uWearRust;

void main() {
  vec3 color = uColors[0];
  if (uMode == 1) {
    float n = lvCamoNoise(vPos * uFrequency, uint(uSeed));
    int index = int(step(uThresholds.x, n) + step(uThresholds.y, n) + step(uThresholds.z, n));
    color = uColors[index];
  }
  // A uniform branch: the field's derivatives stay defined.
  if (uWearThreshold < ${glslFloat(WEAR_NONE)}) {
    float field = lvWearField();
    float chip = lvChip(field, uWearThreshold);
    float rim = clamp(smoothstep(uWearThreshold - ${glslFloat(WEAR_RIM)}, uWearThreshold, field) - chip, 0.0, 1.0);
    float rust = smoothstep(${glslFloat(WEAR_RUST_FROM)}, ${glslFloat(WEAR_RUST_TO)}, lvValueNoise(vPos / ${glslFloat(WEAR_RUST_CELL)}, ${WEAR_SEED >>> 0}u));
    vec3 metal = mix(uWearMetal, uWearRust, rust);
    color = mix(color * (1.0 - ${glslFloat(WEAR_RIM_DARKEN)} * rim), metal, chip);
  }
  gl_FragColor = vec4(color * uBaseAlpha, uBaseAlpha);
}
`;

/**
 * The decal tests shared by the decal and footprint passes: `lvDecalSpace()` is the texel's
 * position in normalised decal space (`uDecal`, column-major, see `decalMatrix`);
 * `lvDecalWeight(d)` is how much of the decal the texel takes: 0 when its part group doesn't
 * match `uPart` (−1 = every part) or `d` lies outside the box `|u|, |v|, |w| <= 0.5`, else the
 * facing fade `smoothstep(DECAL_FADE_START, DECAL_FADE_END, dot(n, decal normal) / |n|)` (0 for a
 * zero-length normal), the mirror of `facingWeight` in decal.ts.
 */
const DECAL_TEST_GLSL = /* glsl */ `
uniform mat4 uDecal;
uniform vec3 uDecalNormal;
uniform float uPart;
varying vec3 vPos;
varying vec3 vNormal;
varying float vGroup;

vec3 lvDecalSpace() {
  return (uDecal * vec4(vPos, 1.0)).xyz;
}

float lvDecalWeight(vec3 d) {
  if (uPart >= 0.0 && abs(vGroup - uPart) > 0.5) return 0.0;
  if (any(greaterThan(abs(d), vec3(0.5)))) return 0.0;
  float normalLength = length(vNormal);
  if (normalLength <= 0.0) return 0.0;
  return smoothstep(${DECAL_FADE_START.toFixed(4)}, ${DECAL_FADE_END.toFixed(4)}, dot(vNormal, uDecalNormal) / normalLength);
}
`;

/**
 * Paint, step 2 (one draw per decal and per mirrored copy, in layer order, into the
 * intermediate with blend `ONE, ONE_MINUS_SRC_ALPHA` on colour and alpha): the decal's picture,
 * premultiplied on upload (so mipmaps and filtering never pull the colour kept under alpha 0
 * into the edges), sampled at `(u + 0.5, 0.5 − v)` (top-left origin; `uFlipX` mirrors u) and
 * scaled by `uOpacity` and by the facing fade (premultiplied, so colour and alpha alike). The
 * picture is sampled before the (non-uniform) discard, so the implicit derivatives that pick its
 * mip level are defined on every GPU.
 */
export const DECAL_FRAGMENT = /* glsl */ `
${NOISE_GLSL}
${DECAL_TEST_GLSL}
${WEAR_GLSL}
uniform sampler2D uDecalTex;
uniform float uOpacity;
uniform float uFlipX;
uniform float uWearThreshold;

void main() {
  vec3 d = lvDecalSpace();
  float u = uFlipX > 0.5 ? -d.x : d.x;
  vec4 color = texture2D(uDecalTex, vec2(u + 0.5, 0.5 - d.y));
  // Before the discard, so the field's derivatives are defined.
  float chip = uWearThreshold < ${glslFloat(WEAR_NONE)} ? lvChip(lvWearField(), uWearThreshold) : 0.0;
  float weight = lvDecalWeight(d);
  if (weight <= 0.0) discard;
  gl_FragColor = color * (uOpacity * weight * (1.0 - chip));
}
`;

/**
 * Paint, step 3 (final pass into the slot's target, same size as the intermediate, read texel
 * for texel): the composite times the template's detail factor (R16F, sampled at the texel's
 * UV), alpha times `1 − mask` (protected areas show the game's texture).
 *
 * `uPremultiply` 1 (preview targets) writes premultiplied colour: the cleared background
 * (0, 0, 0, 0) is then a valid transparent texel, so filtering and mipmaps at UV island edges
 * don't darken the paint (`PREVIEW_MAP_FRAGMENT` composites premultiplied). Export writes
 * straight alpha (`uPremultiply` 0, colour un-premultiplied where alpha > 0) and is dilated.
 */
export const FINAL_FRAGMENT = /* glsl */ `
uniform sampler2D uIntermediate;
uniform sampler2D uDetail;
uniform float uHasDetail;
uniform sampler2D uMask;
uniform float uHasMask;
uniform float uPremultiply;
varying vec2 vUv;

void main() {
  vec4 p = texelFetch(uIntermediate, ivec2(gl_FragCoord.xy), 0);
  float detail = uHasDetail > 0.5 ? texture2D(uDetail, vUv).r : 1.0;
  float mask = uHasMask > 0.5 ? texture2D(uMask, vUv).r : 0.0;
  vec3 straight = p.a > 0.0 ? clamp(p.rgb * detail / p.a, 0.0, 1.0) : vec3(0.0);
  float alpha = p.a * (1.0 - mask);
  gl_FragColor = vec4(uPremultiply > 0.5 ? straight * alpha : straight, alpha);
}
`;

/** Overlap map (once per slot, R8, additive blending): every triangle adds 1/255 to its texels. */
export const COUNT_FRAGMENT = /* glsl */ `
void main() {
  gl_FragColor = vec4(1.0 / 255.0);
}
`;

/** Overlap map side and footprint side (each footprint texel checks `ratio²` overlap texels). */
export const OVERLAP_SIZE = 512;
export const FOOTPRINT_SIZE = 128;

/**
 * Shared-texel check: 1 where the decal's footprint lands on texels drawn by more than one
 * triangle (mirrored or repeated UVs), read from the overlap map at `uOverlapRatio²` texels per
 * footprint texel; discarded elsewhere.
 */
export const FOOTPRINT_FRAGMENT = /* glsl */ `
${DECAL_TEST_GLSL}
uniform sampler2D uOverlap;
uniform int uOverlapRatio;

void main() {
  if (lvDecalWeight(lvDecalSpace()) <= 0.0) discard;
  ivec2 base = ivec2(gl_FragCoord.xy) * uOverlapRatio;
  float most = 0.0;
  for (int y = 0; y < 8; y++) {
    if (y >= uOverlapRatio) break;
    for (int x = 0; x < 8; x++) {
      if (x >= uOverlapRatio) break;
      most = max(most, texelFetch(uOverlap, base + ivec2(x, y), 0).r);
    }
  }
  if (most < 1.5 / 255.0) discard;
  gl_FragColor = vec4(1.0);
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
