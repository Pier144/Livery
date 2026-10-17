# Atelier: geometric camouflage styles for the Base

Status: design approved by the author on 2026-10-17 (brainstorming, question by question). Next
step: implementation plan.

## Goal

The Base's camo is always organic blobs today (two octaves of 3D value noise over model-space
positions, `lvCamoNoise` in `src/atelier/gl/shaders.ts`, split into 2 to 4 colours by quantile
thresholds). The author wants modern and geometric camouflage as well. In camo mode the Base gets
a **style**:

| Style | Id | Look | Geometry |
|---|---|---|---|
| Organic | `organic` | Today's blobs | 3D noise (unchanged) |
| Digital | `digital` | Square pixels grouped into blobs (MARPAT/CADPAT) | Face projection (A) |
| Hexagons | `hex` | Hexagonal cells grouped into blobs | Face projection (A) |
| Splinter | `splinter` | Angular shards, one colour each (Splittertarn) | 3D Voronoi (B) |
| Triangles | `triangles` | Triangular cells grouped into blobs | Face projection (A) |
| Stripes | `stripes` | Tilted bands broken into steps (geometric tiger stripes) | 3D planes (B) |

Plus two settings for every style, chosen by the author: a **share per colour** (instead of equal
areas) and **Softness** (blurred colour edges, 0 = sharp as today).

Out of scope: outlines between cells, a rotation for every style, per-face grid orientation, any
change to solid mode, decals, wear or the mask.

## Parameters (agreed)

| Parameter | Styles | Range, default | Stored as |
|---|---|---|---|
| Colours | all | 2 to 4 (unchanged) | `colors` |
| Shares | all | each ≥ 5 %, sum 100 %, default equal | `weights?` |
| Scale (size of the blobs / shards / bands) | all | `SCALE_MIN..SCALE_MAX` (0.1 to 4), 1 | `scale` (unchanged) |
| Shuffle (seed) | all | unchanged | `seed` (unchanged) |
| Cell size | digital, hex, triangles | 0.25× to 4×, 1× | `cellSize?` |
| Angle | stripes | −80° to 80°, 30° | `angle?` (degrees) |
| Softness | all | 0 to 100 %, 0 | `softness?` (0..1) |

Cell size is separate from Scale (big blobs made of small pixels, like MARPAT). Splinter uses
Scale as the shard size; Stripes use Scale as the band width.

## Data model (`src/atelier/project.ts`)

`BaseLayer` gains optional fields; **absent means today's behaviour**, so saved projects render
bit for bit as before:

```ts
export type CamoPattern = 'organic' | 'digital' | 'hex' | 'splinter' | 'triangles' | 'stripes';
export const CAMO_PATTERNS: readonly CamoPattern[];

interface BaseLayer {
  // …existing: mode, colors, scale, seed, wear?
  /** Camo style; absent = organic. A value this version doesn't know is kept as written and drawn as organic. */
  pattern?: CamoPattern | (string & {});
  /** Share of each colour (same length as `colors`, each ≥ MIN_CAMO_WEIGHT, sum 1); absent = equal. */
  weights?: number[];
  /** Cell size multiplier for digital, hex and triangles; absent = 1. */
  cellSize?: number;
  /** Stripe angle in degrees; absent = DEFAULT_STRIPE_ANGLE. */
  angle?: number;
  /** 0..1; absent = 0 (sharp). */
  softness?: number;
}
```

Parsing (`toBase`) keeps every field it doesn't know (`...raw`, as today) and checks the new ones:
- `pattern`: any non-empty string other than `organic` is kept as written (unknown → drawn as
  organic, like `part`); `organic` and anything else are deleted (picking Organic in the UI also
  deletes the field, so the file is what an older Livery wrote).
- `weights`: kept only when it is an array of finite numbers > 0 whose length equals the parsed
  `colors` length (after the camo top-up), then passed through `normalizeWeights` (below);
  otherwise deleted (equal shares).
- `cellSize`: finite, clamped to `[0.25, 4]`; else deleted. `angle`: finite, clamped to
  `[−80, 80]`; else deleted. `softness`: finite, clamped to `[0, 1]`; deleted when 0 (like `wear`).
- Invalid new fields are explicitly `delete`d after the `...raw` spread (as `withWear` does), so
  nothing invalid reaches the bake.

`normalizeWeights(w)` (pure, in project.ts): scale to sum 1, then pin-and-rescale: every share
below `MIN_CAMO_WEIGHT` (0.05) is set to exactly 0.05 and the others are scaled to fill
`1 − 0.05·pinned`, repeated until no share is below the floor (at most `count` rounds; 4 × 0.05
always fits). Shares are rounded to 4 decimals for storage, the largest one taking the rounding rest (so a pinned share stays exactly 0.05); parsing is idempotent.

Explicit equal shares (e.g. after dragging back to 33/33/34) use the quantile table, so they can
differ by a hair from "absent"; the UI's Equal action deletes `weights` to get today's exact
thresholds back.

An older Livery (0.5.1) opening a project with a new style draws it as organic with the same
colours and keeps the new fields when it saves (`...raw`).

Rust is not touched: `project.json` layers are opaque JSON and the bake runs in the frontend.

## Rendering

### One shader, one branch per style

`BASE_FRAGMENT` keeps its uniforms, declares the `vNormal` varying the bake vertex shader already
writes, and adds `uPattern` (int), `uCell` (model units), `uStripeN`
and `uStripeB` (unit vectors), `uPeriod`, `uSoftness` (already scaled to the style's units, 0 =
sharp) and `uBounds` (vec4, the cumulative shares used by splinter and stripes). Every style ends
in the same place: a colour that the existing wear code then chips, so wear, decals, the mask and
the detail pass are unchanged. Each GLSL function has a TypeScript mirror in `shaders.ts` (as
`camoNoise`/`camoIndex` today), used by the tests and by the style thumbnails. The 3D preview and
Apply both use the Baker, so they agree by construction.

Model space: Y up, nose on +X, Z to the side (scene.ts). Units are metres.

### Colour from a noise value (organic, digital, hex, triangles)

`n = camoNoise(P · frequency, seed)` with `frequency = 1 / (CAMO_CELL · scale)` (unchanged). The
index is the count of thresholds reached (`camoIndex`, unchanged). Thresholds:
- `weights` absent → `CAMO_THRESHOLDS[count]` (today's table, so old projects are identical).
- `weights` present → the inverse CDF of `camoNoise` at the cumulative shares, from a new table
  `CAMO_QUANTILES` (65 values at i/64, measured over random points like `CAMO_THRESHOLDS`, linear
  interpolation between entries). A test checks the table and that the measured shares match the
  weights within 2 points.

### Organic

As today (exactly today's `step` sum when softness is 0, so old projects are bit-identical);
with softness, the colour is blended across each threshold:
`c = C0; for k: c = mix(c, C[k+1], smoothstep(t_k − w, t_k + w, n))` with
`w = softness · min(ORGANIC_SOFT_MAX, half the smallest gap between used thresholds)` (noise
units), so every colour still shows. At softness 0 the shader takes the step path (GLSL
`smoothstep` with equal edges is undefined).

### Face projection (digital, hex, triangles)

Per texel, the dominant axis of the normalised normal picks a plane (a zero-length normal counts
as +Y): X → (z, y), Y → (x, z), Z → (x, y)
(ties in the order X, Y, Z). On that plane a 2D lattice of cell size `s = CELL_BASE[style] ·
cellSize` (digital: square side 0.1 m; hex: circumradius 0.12 m; triangles: side 0.2 m) gives:
- `c`, the centre of the texel's cell, and for every edge k of the cell the centre of the
  neighbour across it and the distance `d_k` to it (plane units);
- digital: `c = (floor(q/s) + 0.5)·s`, four edges, neighbours `c ± s` along each axis;
- hex (pointy-top, circumradius `s`): axial rounding; the six neighbour centres are
  `c + √3·s·dir_k` (dir_k at 0°, 60°, …), the distance to edge k is
  `d_k = (√3/2)·s − dot(q − c, dir_k)`;
- triangles: three line families (normals at 90°, 210°, 330°, spacing `h = s·√3/2`), `a_k =
  dot(q, n_k)/h`; `ΣF = Σ floor(a_k)` is −1 (edges at the lower lines) or −2 (upper lines); the
  centroid is `(2h/3) Σ (F_k + 1/3 or 2/3) n_k`; edge k is at distance `g_k·h` (ΣF = −1) or
  `(1 − g_k)·h` (ΣF = −2) with `g_k = a_k − F_k`, and the neighbour across it is the centroid
  moved by `∓(2h/3)·n_k`.

The colour of a cell comes from the 3D noise at the point **on the texel's tangent plane** above
the cell centre: in-plane coordinates `c`, and the axis coordinate solving `dot(P − pos, normal)
= 0` (stable: the dominant component is ≥ 1/√3). Cells on a flat face therefore get one colour,
and neighbouring faces sample nearby 3D points, so the blobs carry across edges even though the
grid changes orientation. Known limits, accepted: cells stretch up to about 1.7× on steep slopes,
a cell on a curved casting can split where its texels' tangent planes disagree, and the grid
changes orientation where the dominant axis changes.

Softness (all edges, so the colour never jumps inside a cell): weights `1` for the own cell and
`v_k = 1 − smoothstep(0, w, d_k)` for each neighbour, colour = weighted mean of the colours. At an
edge, away from corners, both sides give 50/50, so the edge is continuous; near corners the two
sides see different third cells, which may show a slight seam (accepted). `w = softness · r`,
with r the square's inradius `s/2`, the triangle's `s·√3/6`, and `s/2` for the hex (below its
inradius, so its corner seams stay local); the cell's own colour always shows at its centre.

### Splinter (3D Voronoi)

Jittered 3D grid of cell `S = SPLINTER_CELL · scale`, one site per cell at
`cell + 0.1 + 0.8 · hash3(cell, seed)` (jitter 0.8 keeps the 27-cell search reliable); the nearest
site over the 27 neighbour cells. The shard's colour is `hash(site, seed)` (uniform in [0, 1)) split by the cumulative
shares (`uBounds`; equal shares = k/count). Softness uses every other site k of the search as a
neighbour with `d_k = (|p − s_k|² − |p − s1|²) / (2 |s_k − s1|)` (distance to the bisector) and the
same weighted mean as the grids, `w = softness · S / 4`; a far site entering or leaving the
27-cell set can pop where its weight is still above 0 (rare at this width, accepted).

### Stripes (3D planes)

`uStripeN = (cos α, sin α, 0)` (band normal, α = angle; 0° = vertical bands on the sides) and
`uStripeB = (−sin α, cos α, 0)` (along the band). Front and back faces (normal along X) see the
bands as horizontal stripes `P / |sin α|` apart. A period `P = count · STRIPE_BAND · scale` holds one band per colour, widths
proportional to the shares. The band coordinate is shifted per segment along the band (segment
length `STRIPE_SEGMENT · scale`, offset `(hash(segment, seed) − 0.5) · STRIPE_JITTER · P`), which
gives the stepped "geometric tiger" look; the pattern is the same on both sides of the vehicle
(no Z term). Softness: the same weighted mean with the bands on both sides, `w = softness · half the
narrowest band`; the steps between segments stay sharp.

Starting constants, tuned in the real app on a vehicle and recorded in DESIGN_NOTES:
`CELL_BASE = { digital: 0.1, hex: 0.12, triangles: 0.2 }` m, `SPLINTER_CELL = 0.6` m,
`STRIPE_BAND = 0.35` m, `STRIPE_SEGMENT = 0.5` m, `STRIPE_JITTER = 0.25`,
`ORGANIC_SOFT_MAX = 0.04`. The tests pin their own expectations to these names, not to numbers.

Cost: noise styles evaluate `camoNoise` once for the cell plus once per neighbour only when
softness > 0 (up to 7 for hex); splinter searches 27 cells. One full-screen pass per slot, so a
4096² export stays a fraction of a second on a desktop GPU; checked in the real app.

### `baseUniforms`

`baseUniforms(base)` (baker.ts) grows the new uniforms: pattern index (unknown → organic),
thresholds per the rules above (noise quantiles for noise styles, cumulative shares in `uBounds`
for splinter and stripes), cell size in metres, stripe vectors, softness in the style's units.
It stays pure and is unit-tested.

## Interface (`PropertiesPanel` → `BaseProperties`)

In camo mode, in this order:
1. **Style**: a 3×2 grid of tiles (radiogroup; arrow keys move and select, Home/End), each a
   small canvas thumbnail (64 × 40 px, redrawn at most once per animation frame) drawn on the
   CPU from the TS mirrors (cells drawn at least 3 thumbnail pixels wide, so small cells don't alias) with the project's colours,
   shares, cell size, angle and softness (a flat side patch about 3 × 1.8 m), with the style name
   under it. Selected tile: amber ring, as other selected controls.
2. **Colours** (unchanged swatches, add/remove).
3. **Shares**: one bar split into the colours, each segment as wide as its share, the percentage
   under each; the dividers are draggable and are `role="slider"` (arrow keys 1 %, Page keys
   10 %, aria-valuetext "Colour 1: 40 %"), never letting a share go under 5 %; double-click or a
   small "Equal" action resets (removes `weights`). Hidden in solid mode.
4. **Scale**, then **Cell size** (digital, hex, triangles) or **Angle** (stripes), then
   **Softness**, then **Shuffle** (unchanged).

Colour list edits keep `weights` consistent (pure helpers in `editorModel.ts`): removing colour
i drops share i; adding a colour gives it `1/n` and scales the others by `1 − 1/n`; both then go
through `normalizeWeights`, so no share ends under 5 %; with no `weights` both stay absent. Every slider and divider drag is one undo step
(`setBase(patch, key)` + `endGesture`, as today); a style click is one step.

Strings via i18n in all 9 languages (`atelier.props.style`, one label per style, `shares`,
`sharesEqual`, `shareN`, `cellSize`, `angle`, `softness`), translated by hand, no em dashes.
Colours are project data (`#rrggbb`), not UI styling; the UI itself uses tokens only.

## Testing

- `project.test.ts`: old project (no new fields) parses unchanged and round-trips; each new field
  valid/invalid/clamped; unknown pattern kept; weights length mismatch dropped; weights
  normalised and floored at 5 %.
- `shaders`/`baker.test.ts`: `baseUniforms` for every style and the legacy path (absent fields →
  exactly today's uniforms); `CAMO_QUANTILES` checked against sampled shares; per style mirror:
  shares within tolerance over random points, digital/hex/triangle cells constant inside a cell
  on a flat face, neighbour and distance correct at known points, splinter and stripe shares,
  softness 0 identical to sharp and continuous at edges when > 0.
- `editorModel.test.ts`: weight helpers (add/remove colour, drag a divider with the 5 % floor,
  reset).
- `editorStore.test.ts`: style change and share drag are single undo steps.
- `Editor.test.tsx` / component tests: style tiles render and select (mouse and arrows), the
  right sliders show per style, the share bar responds to keys.
- Real app: `pnpm tauri dev` with `LIVERY_DATA_DIR` on a copy of the data and a scratch game
  root; each style seen on a vehicle in the 3D view; an export to the scratch `UserSkins` decoded
  and compared with the preview. Never the real "Megumin Test" project, never the real UserSkins.
