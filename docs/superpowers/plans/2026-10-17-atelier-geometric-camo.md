# Atelier geometric camo: implementation plan

> **For agentic workers:** executed in the session that wrote it (the author asked for plan +
> implementation in one go). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Base's camo gets six styles (organic, digital, hexagons, splinter, triangles,
stripes), a share per colour and Softness, with the 3D preview and Apply agreeing and old
projects rendering bit for bit as before.

**Spec:** [2026-10-17-atelier-geometric-camo-design.md](../specs/2026-10-17-atelier-geometric-camo-design.md)

**Architecture:** one pure module (`gl/camo.ts`) holds the pattern maths twice: a TypeScript
reference `camoWeights(pos, normal, params) → [w0, w1, w2, w3]` (colour weights, sum 1) and the
GLSL `lvCamoWeights()` with the same structure. `baseUniforms` turns a `BaseLayer` into
`CamoParams` (shared by the shader uniforms, the thumbnails and the tests). The Base shader mixes
`uColors` by the weights, then wear as today. UI: a style picker and a shares bar in a new
`CamoControls.tsx`; weight edits are pure helpers in `editorModel.ts`.

**Tech stack:** TypeScript strict, three.js GLSL ES 3 (ShaderMaterial on WebGL2), React 18,
Zustand, Vitest + RTL. No new dependency, no Rust change.

---

## File map

| File | Change |
|---|---|
| `src/atelier/project.ts` | `CamoPattern`, `CAMO_PATTERNS`, `MIN_CAMO_WEIGHT`, `CELL_SIZE_MIN/MAX`, `STRIPE_ANGLE_MIN/MAX`, `DEFAULT_STRIPE_ANGLE`, `normalizeWeights`, `toBase` parsing of `pattern`, `weights`, `cellSize`, `angle`, `softness` |
| `src/atelier/gl/camo.ts` (new) | constants (`CELL_BASE`, `SPLINTER_CELL`, `STRIPE_*`, `ORGANIC_SOFT_MAX`, `CAMO_QUANTILES`), `PATTERN_INDEX`, `noiseThresholds`, `cumulativeBounds`, `CamoParams`, `camoParams(base)`, `camoWeights`, `CAMO_GLSL` |
| `src/atelier/gl/shaders.ts` | export `NOISE_GLSL` use in `CAMO_GLSL`; `BASE_FRAGMENT` declares `vNormal`, new uniforms, mixes by `lvCamoWeights` |
| `src/atelier/gl/baker.ts` | `BaseUniforms` = `CamoParams` + colours + alpha; material uniforms; `applyBaseUniforms` |
| `src/atelier/editorStore.ts` | `BasePatch` adds the new fields; `setBase` deletes defaults (`pattern: 'organic'`, `weights: undefined`, `softness ≤ 0`, undefined keys) |
| `src/screens/Atelier/editorModel.ts` | `weightsWithColorAdded`, `weightsWithColorRemoved`, `moveShareDivider`, `CELL_SIZE` slider bounds re-export |
| `src/screens/Atelier/camoThumbnail.ts` (new) | `drawCamoThumbnail(ctx, base, pattern)` from `camoWeights` on a flat side patch |
| `src/screens/Atelier/CamoControls.tsx` (new) | `CamoStylePicker` (radiogroup of tiles), `CamoSharesBar` (dividers with `role="slider"`) |
| `src/screens/Atelier/PropertiesPanel.tsx` | `BaseProperties` uses them, per-style sliders |
| `src/i18n/*.json` (9) | `atelier.props.camoStyle`, `camo.<style>`, `shares`, `sharesEqual`, `shareN`, `shareDivider`, `cellSize`, `angle`, `softness` |
| `src/dev/atelierGlCheck.ts` | GPU vs `camoWeights` per style on the mock cube |
| tests | `project.test.ts`, `gl/camo.test.ts` (new), `gl/baker.test.ts`, `editorModel.test.ts`, `editorStore.test.ts`, `Editor.test.tsx` |

## Chunk 1: data model

### Task 1: `BaseLayer` fields and parsing

- [ ] Tests in `project.test.ts` (describe "camo styles"): an old camo project parses to exactly
  what it parsed before (no new keys) and round-trips through JSON; `pattern: 'hex'` kept,
  `'organic'` deleted, `'sticker-camo'` kept as written, `7` deleted; `weights` of the wrong
  length, with a 0, a NaN or a string deleted; `[1, 3]` → `[0.25, 0.75]`; `[0.01, 0.99]` →
  `[0.05, 0.95]`; `[0.01, 0.01, 0.98]` → `[0.05, 0.05, 0.9]`; parsing a parsed layer gives the
  same weights (idempotent); `cellSize` 10 → 4, 0.01 → 0.25, `'x'` deleted; `angle` 120 → 80;
  `softness` 2 → 1, 0 deleted, −1 deleted.
- [ ] `normalizeWeights(w: readonly number[]): number[]`: sum to 1; loop: pin shares
  `< MIN_CAMO_WEIGHT` to it and rescale the rest to `1 − pinned·MIN`, until stable; round to 4
  decimals, the largest share takes the rest.
- [ ] `toBase`: after `...raw`, delete the five keys, then set the valid ones (weights length
  check after the colour top-up). `pnpm vitest run src/atelier/project.test.ts` green.

## Chunk 2: pattern maths (TS reference)

### Task 2: `gl/camo.ts` thresholds and params

- [ ] Tests (`gl/camo.test.ts`): `CAMO_QUANTILES` is 65 increasing values from 0 to 1 and matches
  sampled `camoNoise` quantiles within 0.005 (60k points); `noiseThresholds(undefined, n)` is
  `CAMO_THRESHOLDS[n]`; `noiseThresholds([0.5, 0.3, 0.2], 3)` gives measured shares within 0.02;
  `cumulativeBounds([0.5, 0.3, 0.2])` = `[0.5, 0.8, 2]`, absent = k/count; `camoParams` of an old
  base equals today's uniforms (mode, thresholds, frequency, seed) with `pattern` 0 and `soft` 0;
  unknown pattern → 0; per-style `cell`/`soft` from the constants.
- [ ] Implement.

### Task 3: `camoWeights` per style

- [ ] Tests, each on random points of a flat face (normal ±X, ±Y, ±Z) and of a tilted one:
  - weights are non-negative and sum to 1; softness 0 → one-hot;
  - organic, softness 0: one-hot at `camoIndex(camoNoise(...))` (the legacy path);
  - digital/hex/triangles: two points in the same cell of a flat face get the same colour;
    the shares over many points follow the weights (±0.04); a known point's cell centre and
    neighbour distances (digital: point (0.03, 0.07) in a 0.1 cell → edges 0.03/0.07/0.03/0.07;
    hex: the centre has distance `s/2·√3` to all six edges; triangles: centroid distances `h/3`);
  - splinter: shares follow the bounds (±0.04); points next to a site share its colour;
  - stripes: shares follow the weights (±0.04); angle 0 → constant along Y on a side face
    within a segment;
  - softness > 0: continuous across a cell edge (two points 1e-6 apart on either side of a
    digital edge differ by < 1e-3), the own colour at a cell centre is one-hot.
- [ ] Implement `camoWeights` with helpers `planeOf`, `digitalCell`, `hexCell`, `triangleCell`,
  `splinterSites`, `stripeBand`.

## Chunk 3: GPU

### Task 4: GLSL and the Baker

- [ ] `CAMO_GLSL` mirrors `camoWeights` line by line (same hashes via `lvHash`, `lvLattice`,
  `lvCamoNoise`); `BASE_FRAGMENT`: `vec4 w = lvCamoWeights(vPos, vNormal)` when `uMode == 1`,
  `color = uColors[0]·w.x + …`; the legacy branch (`uPattern == 0 && uSoft <= 0`) stays the old
  `step` sum. Shader-source tests in `baker.test.ts`: the fragment declares every uniform
  `applyBaseUniforms` sets (string check, as the existing tests do).
- [ ] `baseUniforms` returns `CamoParams` fields; material uniforms and `applyBaseUniforms` set
  them. Update the existing `baseUniforms` tests.
- [ ] `atelierGlCheck.ts`: for each style (softness 0 and 0.5) a visible Base on the mock cube,
  export, compare each texel's colour (÷ detail) with `camoWeights` · colours; ok when ≥ 99 % of
  texels match within 3 and the rest are next to a cell edge.

## Chunk 4: store and UI

### Task 5: store and weight helpers

- [ ] `editorModel.test.ts`: add colour to `[0.05, 0.05, 0.9]` keeps every share ≥ 0.05;
  remove; `moveShareDivider(w, i, pos)` moves the boundary between share i and i+1 to `pos`
  (cumulative), clamped so both keep ≥ 0.05, others unchanged, sum stays 1.
- [ ] `editorStore.test.ts`: `setBase({ pattern: 'hex' })` one undo step; `setBase({ pattern:
  'organic' })` deletes the key; `setBase({ weights: undefined })` deletes; softness 0 deletes;
  a divider drag with a merge key is one step.
- [ ] Implement.

### Task 6: Properties panel

- [ ] `Editor.test.tsx`: in camo mode the six style tiles show (radiogroup, one checked); clicking
  Hexagons sets `pattern: 'hex'` and shows Cell size, not Angle; Stripes shows Angle; Organic
  shows neither; ArrowRight on the picker moves to the next style; the shares bar has one
  slider per divider, ArrowRight moves 1 %, Equal deletes `weights`; adding a colour keeps the
  shares bar consistent; solid mode shows none of it.
- [ ] `camoThumbnail.ts`, `CamoControls.tsx`, `PropertiesPanel` changes; tokens only (amber ring
  for the selected tile, `bg-bg-*`, `border-line-*`); thumbnails redrawn in a
  `requestAnimationFrame`, cells at least 3 px.
- [ ] i18n in en, it, de, es, fr, pl, pt-BR, ru, zh-CN by hand, no em dashes;
  `pnpm i18n:check`.

## Chunk 5: verification and commit

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm build`.
- [ ] `pnpm dev:mock` in the browser pane: run `runAtelierGlCheck()`, all checks ok.
- [ ] `pnpm tauri dev` with `LIVERY_DATA_DIR` on a copy of the app data and a scratch game root:
  each style on a real vehicle, tune the constants, Apply to the scratch UserSkins and decode one
  DDS to compare with the preview. Open a copy of an old project: identical.
- [ ] DESIGN_NOTES row "Atelier: geometric camo", HANDOFF line; commit
  `feat(atelier): geometric camo styles, colour shares and softness for the Base`.
