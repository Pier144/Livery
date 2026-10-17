# Atelier shapes, repeats, folders and merged objects: implementation plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents
> available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Stock shapes (with striped fills and a hazard-stripe preset), Repeat on placed layers,
one-level folders in the Layers panel and merged objects (merge / separate) in the Atelier.

**Architecture:** Frontend only (Rust stores `layers` as opaque JSON). The layer list becomes a
shallow tree (folders and merged objects hold children) accessed through a pure `layerTree`
module. A pure `drawItems` module flattens the tree into draw groups (one picture, many boxes:
repeat copies and mirror copies already computed) that the Baker draws instead of image/text
layers. Shapes are rasterised on an OffscreenCanvas like text.

**Tech stack:** React 18, TypeScript strict, Zustand, three.js (existing), Vitest + RTL,
Tailwind with tokens, react-i18next (9 languages).

**Spec:** `docs/superpowers/specs/2026-10-17-atelier-shapes-repeat-folders-merge-design.md`
(read it first). One refinement here: the spec's `DrawItem` (one box per item) is implemented
as `DrawGroup` (one picture + all its boxes), which is what the Baker's bindings need.

**Rules for every task** (from CLAUDE.md and the author):
- Tailwind with existing tokens only, no hex in components; Lucide icons `size={14}` in
  controls, `strokeWidth={1.75}`; every visible string through `t('atelier.…')`.
- New strings go into **all nine** `src/i18n/*.json` (en, it, de, es, fr, pl, pt-BR, ru,
  zh-CN), real translations, **no em dash (—)** anywhere; `pnpm i18n:check` must pass.
- Comments and identifiers in English, matching the surrounding style (doc comments on exports,
  short "why" comments).
- Never add a dependency.
- Run `pnpm typecheck` and the touched test files (`pnpm vitest run <files>`) before
  committing; the whole `pnpm test` at the end of each chunk.
- Commit with a conventional message, e.g. `feat(atelier): …`. Do not push.

**Baseline (2026-10-17, c85b662 + spec):** `pnpm test` 1238 passing, typecheck clean.

## File map

| File | Responsibility |
|---|---|
| `src/atelier/project.ts` (modify) | Layer schema: new kinds, Repeat, constants, factories, validation (`checkLayers`), serialisation, `isPlacedLayer` |
| `src/atelier/layerTree.ts` (new) | Find / replace / remove / insert / walk layers across containers |
| `src/atelier/merge.ts` (new) | Frame maths: `pieceDecal`, `placeOf`, `repeatDecals`, `mergeFrame`, `separatePieces` |
| `src/atelier/drawItems.ts` (new) | `drawGroups(layers, mirrorAxis)`: what the bake draws, memoised, budgeted |
| `src/atelier/shapes.ts` (new) | Shape geometry, stripe bands, shape raster, cache key |
| `src/atelier/gl/baker.ts` (modify) | Bindings per draw group; shape pictures |
| `src/atelier/editorStore.ts` (modify) | Tree-aware actions, multi-select, folders, merge/separate, shape placement |
| `src/screens/Atelier/Viewport.tsx`, `DecalGizmo.tsx`, `Editor.tsx`, `CutoutDownloadDialog.tsx`, `RefineEdgeDialog.tsx` (modify) | Look layers up through the tree; edge handles; multi-select outlines |
| `src/screens/Atelier/LayersPanel.tsx` (modify, may split into `LayerRows.tsx`) | Add-shape menu, folders, merged rows, multi-select bar, drag into folders |
| `src/screens/Atelier/PropertiesPanel.tsx`, `DecalProperties.tsx` (modify), `ShapeProperties.tsx`, `RepeatSection.tsx`, `MergedProperties.tsx` (new) | Properties of the new kinds |
| `src/i18n/*.json` | Strings |
| `DESIGN_NOTES.md`, `HANDOFF.md` | Decisions and state |

---

## Chunk 1: Model, tree, maths (pure)

### Task 1: Layer schema (`project.ts`)

**Files:** Modify `src/atelier/project.ts`; Test `src/atelier/project.test.ts` (extend).

Types to add (exported), exactly:

```ts
export type ShapeKind = 'rect' | 'ellipse' | 'star' | 'polygon';
export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'star', 'polygon'];
export type ShapeFill =
  | { kind: 'solid'; color: string }
  | { kind: 'stripes'; colors: [string, string]; angle: number; stripeWidth: number };
export interface Repeat { count: number; gap: number; direction: 'row' | 'column'; alternate?: string }
export interface ShapeLayer extends LayerCommon {
  kind: 'shape';
  shape: ShapeKind | (string & {});
  corner?: number; points?: number; innerRatio?: number;
  fill: ShapeFill;
  outlineColor: string; outlineWidth: number;
  decal: Decal | null; opacity: number; wear?: number; repeat?: Repeat;
}
export interface Place { x: number; y: number; w: number; h: number; angle: number }
export type PieceLayer = ImageLayer | TextLayer | ShapeLayer;
/** A piece of a merged object: the layer without its own frame, repeat, part or mirror. */
export type Piece = (Omit<ImageLayer, 'decal'> | Omit<TextLayer, 'decal'> | Omit<ShapeLayer, 'decal' | 'repeat'>) & { place: Place };
export type UnsupportedPiece = UnsupportedLayer & { place?: Place };
export interface MergedLayer extends LayerCommon {
  kind: 'merged'; decal: Decal | null; opacity: number; repeat?: Repeat;
  children: (Piece | UnsupportedPiece)[];
}
export interface FolderLayer extends LayerCommon {
  kind: 'folder'; collapsed: boolean;
  children: (PlacedLayer | UnsupportedLayer)[];
}
export type PlacedLayer = ImageLayer | TextLayer | ShapeLayer | MergedLayer;
export type Layer = BaseLayer | PlacedLayer | FolderLayer | MaskLayer | UnsupportedLayer;
```

Also add `repeat?: Repeat` to `ImageLayer` and `TextLayer`.

Constants: `MAX_REPEAT = 50`, `MAX_REPEAT_GAP = 5`, `REPEAT_DEPTH_GROWTH = 0.35`,
`MAX_PIECES = 50`, `MAX_DRAW_ITEMS = 400`, `MERGE_MAX_ANGLE_DEG = 35`,
`MAX_SHAPE_POINTS = 12`, `MIN_SHAPE_POINTS = 3`, `DEFAULT_STAR_POINTS = 5`,
`DEFAULT_POLYGON_SIDES = 6`, `MIN_INNER_RATIO = 0.15`, `MAX_INNER_RATIO = 0.9`,
`DEFAULT_INNER_RATIO = 0.45`, `MAX_CORNER = 0.5`, `STRIPE_WIDTH_MIN = 0.01`,
`STRIPE_WIDTH_MAX = 1`, `DEFAULT_STRIPE_WIDTH = 0.08`, `SHAPE_STRIPE_ANGLE_MIN = -80`,
`SHAPE_STRIPE_ANGLE_MAX = 80`, `DEFAULT_SHAPE_STRIPE_ANGLE = 45`,
`DEFAULT_SHAPE_COLOR = '#e8b600'`, `HAZARD_DARK = '#141414'`, `HAZARD_ASPECT = 8`.

Steps:

- [ ] **1.1 Tests first** (extend `project.test.ts`, one `describe` per kind):
  - shape: defaults (`newShapeLayer('star')` → solid `DEFAULT_SHAPE_COLOR`, outline width 0,
    no corner/points fields written), `checkLayers` clamps `corner` to 0..0.5, `points` to 3..12
    (integers), `innerRatio`, `outlineWidth` 0..20, `opacity`; a bad fill becomes solid default;
    stripes clamp `angle` and `stripeWidth`, lower-case colours; unknown `shape` string kept;
    unknown fields kept.
  - `newHazardStripe(name)`: rect, stripes `[DEFAULT_SHAPE_COLOR, HAZARD_DARK]`, angle 45,
    width 0.08, the given name.
  - repeat: absent stays absent; `count` < 2 or invalid → field removed; count clamped to 50,
    gap 0..5, direction defaults to `row`, bad `alternate` removed; on image, text, shape and
    merged.
  - folder: kept with children; `collapsed` defaults false; a folder inside a folder is moved out
    right above its parent (`repaired: true`); a Base or mask inside a folder is moved out to its
    pinned place (only if the top level lacks one, else dropped; `repaired`).
  - merged: pieces validated (image needs `assetId`, place numbers finite, `w`,`h` > 0, `angle`
    finite); a piece with a bad place is dropped; unknown piece kind kept as unsupported piece;
    folder/base/mask/merged pieces dropped; no drawable piece → merged layer dropped
    (`repaired`); a `repeat` on a piece is removed.
  - ids unique across the whole tree (a piece with a top-level layer's id is renewed,
    `repaired`).
  - `serializeLayers` round-trips folders, merged objects and unsupported children/pieces
    exactly (unsupported → their `original` plus id/name/visible, and `place` for pieces).
  - `isPlacedLayer` true for image, text, shape, merged; false for folder, base, mask,
    unsupported.
- [ ] **1.2 Run** `pnpm vitest run src/atelier/project.test.ts` → the new tests fail.
- [ ] **1.3 Implement** in `project.ts`: the types and constants; `newShapeLayer(shape:
  ShapeKind, decal: Decal | null = null, name = '')`, `newHazardStripe(name: string, decal:
  Decal | null = null)`, `newFolder(name: string, children = [])`; validators `toShape`,
  `toRepeat`, `toPlace`, `toPiece`, `toMerged`, `toFolder` in the file's existing style
  (`...raw` first to keep unknown fields, then checked fields; delete optional fields that don't
  check out); `toLayer` dispatches the new kinds; `checkLayers` handles nesting repairs and
  tree-wide id uniqueness; `serializeLayers` recurses. Rename the guard: `isPlacedLayer(layer)`
  (image | text | shape | merged) and `isPictureLayer(layer)` (image | text, what `isDecalLayer`
  meant); keep `DecalLayer = ImageLayer | TextLayer` as the type for picture-and-text-only code.
  `checkDecalLayer` becomes `checkPlacedLayer(layer: PlacedLayer): PlacedLayer | null` (also
  shape and merged), plus `checkPiece(piece): Piece | null`. Update every import of
  `isDecalLayer` / `checkDecalLayer` so typecheck passes (behaviour-preserving: where code means
  "has a decal", use `isPlacedLayer`; where it means picture/text content, `isPictureLayer`).
  `decalLayers()` stays (image | text, top level) only if still used; otherwise remove.
- [ ] **1.4 Run** `pnpm vitest run src/atelier/project.test.ts` and `pnpm typecheck` → pass.
  Run the whole `pnpm test` (old projects must behave exactly as before).
- [ ] **1.5 Commit** `feat(atelier): shape, merged and folder layers in the project schema`.

### Task 2: Layer tree (`layerTree.ts`)

**Files:** Create `src/atelier/layerTree.ts`, `src/atelier/layerTree.test.ts`.

API (exported, pure, never mutating inputs; returning the same array when nothing changes):

```ts
export type ParentId = string | null;            // null = top level
export interface Found { layer: Layer | Piece | UnsupportedPiece; parentId: ParentId; index: number; parent: FolderLayer | MergedLayer | null }
export function findLayer(layers: readonly Layer[], id: string): Found | null;
export function childrenOf(layers: readonly Layer[], parentId: ParentId): readonly (Layer | Piece | UnsupportedPiece)[];
export function replaceLayer(layers: readonly Layer[], id: string, next: Layer | Piece | UnsupportedPiece): Layer[];
export function updateLayer(layers: readonly Layer[], id: string, change: (l: any) => any): Layer[]; // typed overloads ok
export function removeLayers(layers: readonly Layer[], ids: ReadonlySet<string> | readonly string[]): Layer[];
export function insertLayers(layers: readonly Layer[], parentId: ParentId, index: number, items: readonly (Layer | Piece)[]): Layer[];
/** Depth-first, bottom to top: every layer, folder children and merged pieces included (folders and merged objects before their children). */
export function allLayers(layers: readonly Layer[]): (Layer | Piece | UnsupportedPiece)[];
/** Placed layers that have a frame of their own (top level and in folders; not pieces). */
export function framedLayers(layers: readonly Layer[]): PlacedLayer[];
/** Every text layer or text piece (for fonts). */
export function textLayers(layers: readonly Layer[]): (TextLayer | (Piece & { kind: 'text' }))[];
export const isPiece: (found: Found) => boolean; // parent is a merged object
```

`insertLayers` clamps the index into the container; at the top level it keeps the Base first
and the mask last (index clamped to 1..length-without-mask).

- [ ] **2.1 Tests:** find at each depth (top, folder child, merged piece, folder→merged→piece),
  replace/remove/insert at each depth with structural sharing (untouched containers keep their
  object identity), insert clamps around Base/mask, `allLayers` order, `framedLayers` excludes
  pieces and folders, `textLayers` finds text in folders and pieces.
- [ ] **2.2 Run** → fail. **2.3 Implement.** **2.4 Run** → pass.
- [ ] **2.5 Commit** `feat(atelier): layer tree helpers`.

### Task 3: Frame maths (`merge.ts`)

**Files:** Create `src/atelier/merge.ts`, `src/atelier/merge.test.ts`.

Conventions: `R = decalRight(d)`, `U = d.up`, `N = d.normal`. Angles are counter-clockwise seen
from the front (as `rotateDecal` in `screens/Atelier/decalOps.ts`): `up(a) = cos a·U − sin a·R`.

```ts
/** A piece's frame on the vehicle: inside `frame` at `place` (normal, part, depth of the frame; mirror off). */
export function pieceDecal(frame: Decal, place: Place): Decal {
  const R = decalRight(frame), U = frame.up;
  const c = Math.cos(place.angle), s = Math.sin(place.angle);
  return {
    ...frame,
    center: add(add(frame.center, scale(R, place.x * frame.width)), scale(U, place.y * frame.height)),
    up: normalize(sub(scale(U, c), scale(R, s)))!,
    width: place.w * frame.width, height: place.h * frame.height,
    mirror: false,
  };
}
/** Inverse of `pieceDecal` for a decal on (or near) the frame's plane: its place, with its own size in metres. */
export function placeOf(frame: Decal, decal: Decal): Place;
/** The boxes of a layer's repeat copies, first copy first (just `[decal]` without a repeat). */
export function repeatDecals(decal: Decal, repeat: Repeat | undefined): Decal[];
/** The frame holding every copy (the envelope Mirror reflects): same axes, centre in the middle of the row. */
export function envelopeOf(decal: Decal, repeat: Repeat | undefined): Decal;
/** `boxes` reflected as one picture: the envelope mirrored (`mirrorDecal`), each box placed at the same local spot. Null for an invalid axis. */
export function mirrorAsOne(boxes: readonly Decal[], envelope: Decal, axis: number): Decal[] | null;
export type MergeRefusal = 'count' | 'unplaced' | 'angle' | 'pieces' | 'container';
export function mergeFrame(boxes: readonly Decal[], topUp: Vec3): { frame: Decal } | { refused: 'angle' };
export function separatePieces(merged: MergedLayer): PlacedLayer[]; // see spec "Separate"
```

Details:
- `repeatDecals`: copy *i* centre = `c + R·i·(1+gap)·width` (row) or `c − U·i·(1+gap)·height`
  (column); depth `min(MAX_DECAL_SIZE, depth + REPEAT_DEPTH_GROWTH·offset)`.
- `envelopeOf`: `L = (count−1)·(1+gap)·side`; centre moved by `L/2` the same way; width (row) or
  height (column) `+ L`.
- `mirrorAsOne`: `env' = mirrorDecal(envelope, axis)`; for each box `lx = (c−envC)·R_env`,
  `ly = (c−envC)·U_env`, its local up angle `a` vs the envelope (`atan2(−up·R, up·U)`); mirrored
  box = `{ ...box, center: env'.c + R'·lx + U'·ly, normal: env'.normal, up: rotate(env'.up, a) }`.
  For a single box without repeat this equals `mirrorDecal(box)` (test it).
- `mergeFrame` (spec "Merge"): `n` = normalised sum of normals; refuse `angle` when any
  `dot(ni, n) < cos(35°)`; `U` = `topUp` projected onto the plane, fallbacks world +y then +x
  (as `frameFromHit`); `R = normalize(cross(U, n))`; project every box's 4 corners
  (`decalCorners` logic; move it to `decal.ts` as `decalCorners` and re-export from
  `decalOps.ts` so existing imports keep working) on (R, U, n) relative to the first centre;
  width/height = extents (≥ MIN_DECAL_SIZE); centre at the extents' middle on all three axes;
  depth = `min(MAX_DECAL_SIZE, max(depth_i) + (zmax − zmin))`; part/mirror left to the caller.
- `placeOf`: `x = (c−F.c)·R/F.width`, `y = (c−F.c)·U/F.height`, angle from the decal's up
  projected on the plane, `w = d.width/F.width`, `h = d.height/F.height` (own size, not
  projected).
- `separatePieces`: each drawable piece → layer with `decal = { ...pieceDecal(frame, place),
  depth: frame.depth, part: frame.part, mirror: frame.mirror }`, `opacity = piece.opacity ×
  merged.opacity`, `visible = piece.visible && merged.visible`, same id, `place` removed;
  unsupported pieces come back as unsupported layers (without `place`).

- [ ] **3.1 Tests:** `pieceDecal`/`placeOf` inverse (random frames and places, 1e-9);
  `repeatDecals` offsets, depth growth, count 1 / undefined; `envelopeOf` centre; `mirrorAsOne`
  = `mirrorDecal` for one box; **order test**: two boxes "A" at local x=−0.3 and "B" at +0.3 in a
  frame on the left side (normal −z, mirror axis 2): after `mirrorAsOne`, A's centre expressed in
  the mirrored frame's local coordinates is still at x=−0.3 (reads A then B); `mergeFrame` on
  coplanar boxes (frame encloses all corners, normal = shared normal), on boxes tilted ±20°
  (accepted; every corner of every box is inside the frame's depth: `|offset| ≤ depth/2`), on
  boxes 50° apart (refused); merge → `placeOf` → `separatePieces` round trip for coplanar
  pieces within 1e-6 (centre, width, height, up).
- [ ] **3.2 Run** → fail. **3.3 Implement.** **3.4 Run** → pass.
- [ ] **3.5 Commit** `feat(atelier): frame maths for repeats, mirror and merged objects`.

### Task 4: Draw groups (`drawItems.ts`)

**Files:** Create `src/atelier/drawItems.ts`, `src/atelier/drawItems.test.ts`.

```ts
export interface DrawGroup {
  /** Binding id, stable: layer id; `${mergedId}/${pieceId}` for pieces; `:alt` suffix for the alternate colour. */
  id: string;
  source: PieceLayer;          // a piece is passed as `{ ...piece, decal: <first box> }` without `place`
  variant: 'main' | 'alt';
  /** Final boxes: repeat copies (of this variant) and their mirror copies, `mirror: false`. */
  boxes: Decal[];
  /** The first copy's box (raster size, texel density). */
  rasterDecal: Decal;
  opacity: number;
  wear: number | undefined;
  flipX: boolean;
}
export interface DrawPlan { groups: DrawGroup[]; boxes: number; truncated: boolean }
export function drawGroups(layers: readonly Layer[], mirrorAxis: number, budget = MAX_DRAW_ITEMS): DrawPlan;
```

Rules (spec section 2): bottom to top; folders (hidden → skipped) contribute their children in
order; a layer contributes nothing when hidden, unplaced or opacity 0. Plain placed layer:
boxes = `repeatDecals(decal, repeat)`; with `alternate` on a solid shape, even copies → main
group, odd copies → alt group (alt group's `source` has `fill.color = alternate`); with
`decal.mirror` the mirrored boxes come from `mirrorAsOne(allCopies, envelopeOf(decal, repeat),
axis)` and go to the same group as their originals. Merged object: frames =
`repeatDecals(merged.decal, merged.repeat)`, for each drawable visible piece (opacity × merged
opacity > 0) boxes = `frames.map(f => pieceDecal(f, place))`; mirror: `mirrorAsOne(<all boxes
of all pieces>, envelopeOf(merged.decal, merged.repeat), axis)`, split back per piece. Budget:
count boxes; when a layer's groups would push the total over `budget`, stop (that layer and
everything above are skipped) and set `truncated`.

Memoisation: a module-level `WeakMap<Layer, Map<number, DrawGroup[]>>` keyed by the top-level
or folder-child layer object and the mirror axis, so the same layer object yields the same
group objects (identity) on the next call. The returned `groups` array is new each call.

- [ ] **4.1 Tests:** visibility (layer, folder, merged, piece), unplaced, opacity 0; folder
  children order; repeat boxes and alt split; mirror of a plain layer equals `mirrorDecal`;
  mirror of a merged "A" "B" keeps order (as Task 3); merged repeat; budget/truncated (e.g. 9
  layers × 50 copies with budget 400); identity: two calls with the same layers return the
  same `DrawGroup` objects, a changed layer gets new ones while the others keep theirs.
- [ ] **4.2 Run** → fail. **4.3 Implement.** **4.4 Run** → pass.
- [ ] **4.5 Commit** `feat(atelier): draw groups for the bake`.

### Task 5: Shapes (`shapes.ts`)

**Files:** Create `src/atelier/shapes.ts`, `src/atelier/shapes.test.ts`.

```ts
/** Outline points in raster pixels (y down), for star/polygon; rect and ellipse are drawn with Path2D primitives. */
export function starPoints(points: number, innerRatio: number, w: number, h: number): [number, number][];
export function polygonPoints(sides: number, w: number, h: number): [number, number][];
/** Stripe bands for a frame `widthM × heightM` metres: quads in metres from the top-left (y down), colour index 0/1, a boundary through the centre. */
export function stripeBands(widthM: number, heightM: number, angleDeg: number, stripeWidth: number): { color: 0 | 1; quad: [number, number][] }[];
/** Sixteenth-octave quantisation (shape raster keys). */
export function quantiseOctave16(v: number): number;
export function shapeKey(layer: ShapeLayer, variant: 'main' | 'alt', frame: { width: number; height: number }, px: number, full: boolean): string;
/** Straight-alpha RGBA of the shape `pxHeight` tall, width from the quantised aspect; long side ≤ MAX_RASTER_SIDE. Null without OffscreenCanvas. */
export async function rasteriseShape(layer: ShapeLayer, variant: 'main' | 'alt', frame: { width: number; height: number }, pxHeight: number): Promise<DecalImage | null>;
```

Geometry: first vertex points up (angle −90° in canvas space), radius = half the frame's width
along x and half its height along y (inscribed in the frame's ellipse); star alternates radius
1 and `innerRatio`. Stripe boundaries lean right by `angle` from vertical: boundary direction
in metres (right, up) `(sin a, cos a)`, across-normal `(cos a, −sin a)`; band k spans
`s ∈ [k·sw, (k+1)·sw)` of `s = (p − centre)·normal`, colour `k mod 2` (0 for k = 0, handle
negative k with `((k % 2) + 2) % 2`); quads long enough to cover the frame's diagonal. Raster:
quantised `aspect = quantiseOctave16(w/h)`; for stripes also quantised `widthM`, `heightM`
(and drawn with those); fill the path (solid colour, `alternate` for `variant: 'alt'`, or clip
to the path and fill the bands mapped from metres to pixels), then the outline: clip to the
path and stroke with line width `2 × outlineWidth/100 × min(W, H)` (inner half shows); return
`ctx.getImageData` as straight RGBA (canvas gives unpremultiplied data). Key:
`shp:${JSON.stringify([shape, corner ?? 0, points ?? null, innerRatio ?? null, fillUsed, outlineColor, outlineWidth])}:${px}:${aspectQ}${stripes ? `:${wQ}x${hQ}` : ''}:${full ? 'f' : 'p'}`
where `fillUsed` is the fill after the variant is applied.

- [ ] **5.1 Tests:** star has `2·points` vertices, first at top-centre, alternate radii;
  polygon `sides` vertices; `stripeBands`: the centre lies on a boundary (the band with k=0
  starts there), adjacent bands alternate colours, every frame corner is covered by some quad,
  angle 0 gives vertical boundaries; `quantiseOctave16` idempotent and within 4.5 %;
  `shapeKey` changes with fill/variant/px/full, ignores frame size for solid fills, includes it
  for stripes; `rasteriseShape` returns null when `OffscreenCanvas` is undefined (jsdom).
- [ ] **5.2 Run** → fail. **5.3 Implement.** **5.4 Run** → pass.
- [ ] **5.5 Commit** `feat(atelier): shape geometry and raster`.

## Chunk 2: Bake and store

### Task 6: Baker on draw groups

**Files:** Modify `src/atelier/gl/baker.ts`; Test `src/atelier/gl/baker.test.ts`.

- `LayerBinding` becomes `{ group: DrawGroup; key; shown; boxes: Decal[]; draws: DecalDraw[] }`,
  keyed by `group.id`. `updateDecals(layers)` uses `drawGroups(layers,
  this.model.header.mirrorAxis).groups`; `changed` when the group list differs by identity;
  draws recomputed when `b.boxes !== group.boxes` (`group.boxes.map(d => this.decalDraw(d))`,
  no `decalCopies`: mirror copies are already in). Keep `drawnDecalLayers` only if tests need it
  (else remove with its tests updated to draw groups).
- `pictureKey(group, full)`: image → `imageKey(source.assetId, full)`; text →
  `textKey(source, this.textHeight(group.rasterDecal, full), full)`; shape →
  `shapeKey(source, variant, rasterDecal, this.textHeight(rasterDecal, full), full)`.
  `acquirePicture(group, key, full)`: shape → new option `rasteriseShape?: (layer, variant,
  frame, px) => Promise<DecalImage | null>` defaulting to `shapes.ts`'s.
- `drawPaint`: opacity/flipX/wear from the group (`flipX` true only for image sources with
  `flipX`). `prepareExport`/`exportKeys` keyed by `group.id`; the "share the preview copy"
  shortcut applies to image and text as today; shapes always load their export raster.
- `whenReady` unchanged in spirit (keys of the current bindings).
- Expose `get truncated(): boolean` (from the last plan) so the editor can warn.
- Shared-texel check (`decalTouchesSharedTexels`) is unchanged (callers pass the frame).

- [ ] **6.1 Tests** (extend `baker.test.ts` with the existing stub renderer/patterns):
  a shape layer acquires a `shp:` key through the `rasteriseShape` option; a repeated layer
  makes one binding with `count` draws (×2 with mirror); alternate makes two bindings;
  a merged object makes one binding per piece; a hidden folder releases its children's
  pictures; renaming a layer doesn't re-bake (identity); export keys per group;
  `truncated` reflects the budget. Existing baker tests keep passing (adapt names only).
- [ ] **6.2 Run** → fail. **6.3 Implement.** **6.4 Run** `pnpm vitest run src/atelier/gl` → pass.
- [ ] **6.5 Commit** `feat(atelier): bake shapes, repeats, folders and merged objects`.

### Task 7: Editor store, tree-aware actions and new actions

**Files:** Modify `src/atelier/editorStore.ts`; Test `src/atelier/editorStore.test.ts`.

Make every existing action work through `layerTree` (find by id at any depth): `setDecal`
(framed layers only, not pieces), `setLayerProps` (placed layers and pieces; pieces validated
with `checkPiece`; text pieces get `place.w = place.h × frameHeight × aspect / frameWidth`
from the measurer, centre and height kept), `toggleLayerVisible`, `renameLayer` (folders too),
`duplicateLayer` (placed layers and folders; merged/folder copies renew every inner id;
folder copy is not offset, its children's decals are), `deleteLayer` (any but Base; mask as
today), `moveLayer(id, toIndex)` (within its container), `restoreLayer(layer, index,
parentId = null)`, `applyCutout` (framed image layers only), `refreshTextMetrics` (finds text
layers and pieces at any depth, also in `past`/`future`), undo/redo selection fallback
searching the whole tree. `insertIndex` → `insertTarget(layers, selectedId): { parentId, index }`
per the spec ("Where a new layer goes").

New state/actions:

```ts
selectedIds: string[];                       // multi-selection (empty or one = single)
select(id: string | null): void;             // single selection (clears selectedIds)
toggleSelect(id: string): void;              // Ctrl+click: same container + placed/folder only, else single
selectRange(id: string): void;               // Shift+click: range from selectedId in the same container
beginPlacement(pending) // PendingPlacement gains | { kind: 'shape'; shape: ShapeKind; hazard?: boolean; name?: string; aspect: number }
createFolder(name: string, ids?: string[]): string;     // ids must share a container at the top level; returns the folder id
toggleCollapsed(id: string): void;           // not an undo step: patches layers, past and future
dissolveFolder(id: string): void;
moveInto(id: string, parentId: string | null, index: number): void; // drag into/out of a folder; folders only at the top level
deleteLayers(ids: string[]): DeletedEntry[];  // one undo step; returns what was removed for the toast
restoreLayers(entries: DeletedEntry[]): void; // one undo step
mergeLayers(ids: string[]): { ok: true; id: string; reset: { part: boolean; mirror: boolean } } | { ok: false; reason: MergeRefusal };
separate(id: string): { ok: true; ids: string[]; droppedRepeat: boolean } | { ok: false };
```

`DeletedEntry = { layer: Layer; parentId: string | null; index: number }`. Every structural
action is one undo step and resets the multi-selection; `toggleCollapsed`, `select*` are not
undo steps. `mergeLayers` checks: ≥ 2 ids, same container (`container`), all placed and placed
on the vehicle (`unplaced`), no folders (`container`), expands repeats and flattens merged
objects into boxes (`repeatDecals` / `pieceDecal`), `MAX_PIECES` (`pieces`), `mergeFrame`
(`angle`); topmost selected (highest index) gives `topUp` and the stack position; part common
else `'all'`, mirror all-on else off; pieces = sources without `decal`/`repeat` (+ `place` from
`placeOf`); each expanded copy of a repeated layer becomes a piece with a new id (the first
copy keeps the layer's id). `separate` uses `separatePieces` and selects the result
(`selectedIds` = their ids, `selectedId` = topmost).

`setLayerProps` patch type grows: shape fields (`shape`, `corner`, `points`, `innerRatio`,
`fill`, `outlineColor`, `outlineWidth`) and `repeat` (`null` removes it); fields of other kinds
are dropped as today.

- [ ] **7.1 Tests** (extend `editorStore.test.ts`, keep every existing test): placing a shape
  and a hazard stripe (aspect, name); repeat set/clear is one undo step; actions on a layer in a
  folder (rename, hide, delete, duplicate, setDecal, setLayerProps); undo with a folder child
  selected keeps the selection; create folder from a multi-selection; dissolve; moveInto
  in/out; folders can't go into folders; collapse not in history (undo after collapse doesn't
  expand it); multi-select rules (Ctrl on Base → single; different containers → single;
  Shift range); deleteLayers + restoreLayers across containers; merge happy path (pieces,
  frame, stack position, selection), refusals (one id, mixed containers, unplaced, angle,
  >50 pieces), merge of a repeated layer and of a merged object (flattened), part/mirror reset
  flags; separate (ids, selection, droppedRepeat); text piece width refit; applyCutout ignores
  pieces; new layer insert target inside a folder / above a merged object.
- [ ] **7.2 Run** → fail. **7.3 Implement.** **7.4 Run** `pnpm vitest run src/atelier` and
  `pnpm typecheck` → pass.
- [ ] **7.5 Commit** `feat(atelier): folders, multi-select, merge and separate in the editor store`.

## Chunk 3: Screens and strings

### Task 8: Viewport, gizmo, editor hooks, dialogs

**Files:** Modify `src/screens/Atelier/Viewport.tsx`, `DecalGizmo.tsx`, `Editor.tsx`,
`CutoutDownloadDialog.tsx`, `RefineEdgeDialog.tsx`, `decalOps.ts`, `decalSnap.ts` if needed;
tests `Editor.test.tsx`, `decalOps.test.ts`.

- Look layers up with `findLayer`; `selectedPlaced` = the single selected framed layer (not a
  piece). `placeAt` for "place again": shapes use aspect 1 (hazard name/stripes → 8), merged 1.
  Pending shape placement creates the layer through `placePending`.
- `DecalGizmo`: `liveDecal` via `findLayer`; `otherDecals` = `framedLayers` minus itself;
  Shift free ratio for image **and shape**; merged: corners only, uniform; **edge handles**
  (4 midpoints, `data-gizmo="edge-0..3"`) for shapes only, scaling one axis (`scaleDecal(decal,
  kx, 1)` or `(1, ky)`, the factor measured along that screen axis as the Shift path does);
  with Repeat on, a dashed polygon of the row envelope (`envelopeOf`).
- Multi-selection: Viewport draws a plain outline (no handles) for each selected framed layer
  when `selectedIds.length > 1` (new small component in `DecalGizmo.tsx`, `SelectionOutlines`).
- `Editor.tsx`: `useTextFonts` loads fonts of `textLayers(layers)`; `checkShared` finds the
  layer through the tree (merged → its frame); the selection effect uses `findLayer`.
- Cutout and Refine edge dialogs find the image through `findLayer` (framed images only).
- Baker `truncated` → `useDecalUi` flag `drawTruncated` set by the viewport after `setLayers`.

- [ ] **8.1 Tests:** `Editor.test.tsx` smoke: a project with a shape, a folder and a merged
  object opens; selecting a shape shows a gizmo with edge handles (`data-gizmo="edge-0"`),
  a merged object shows no edge handles; two selected show outlines and no gizmo. Unit tests
  for any new pure helper (e.g. edge scaling) in `decalOps.test.ts`.
- [ ] **8.2 Implement**, run tests, typecheck.
- [ ] **8.3 Commit** `feat(atelier): gizmo and viewport for shapes, merged objects and multi-select`.

### Task 9: Layers panel

**Files:** Modify `src/screens/Atelier/LayersPanel.tsx` (split rows into
`src/screens/Atelier/LayerRows.tsx` if it passes ~500 lines); tests in `Editor.test.tsx` or a
new `LayersPanel.test.tsx` (use `src/test/render.tsx` helpers like the existing tests).

- Add bar: `[+ Image] [+ Text] [+ Shape ▾]` (`Menu` component; items Rectangle, Ellipse, Star,
  Polygon, divider if the Menu supports it else plain order, Hazard stripe). Shape icons:
  `Square`, `Circle`, `Star`, `Hexagon`; hazard: `Construction` if present in lucide, else
  `TriangleAlert`.
- Title row: `FolderPlus` icon button "New folder" (creates with the localized "Folder N",
  N = 1 + existing count; with a multi-selection uses those ids; starts renaming).
- Rows from the tree: mask, top-level items top to bottom (folders with chevron
  `ChevronRight`/`ChevronDown`, `Folder`/`FolderOpen` icon, name, count when collapsed; their
  children indented `pl-4`), merged objects (`Combine` icon, chevron toggling local expanded
  state, pieces indented and selectable, no grip, no menu), Base.
- Click: plain → `select`; Ctrl → `toggleSelect`; Shift → `selectRange`. Rows show selected
  state for every id in `selectedIds` (or `selectedId`).
- Multi-select bar (≥ 2): `[Merge] [Put in folder] [Delete]` with the disabled rules and
  tooltips of the spec; Merge calls `mergeLayers` and toasts: success (with part/mirror reset
  note when flagged), or the refusal reason. Delete uses `deleteLayers` + `toast.undoable`
  (Undo: editor undo when the revision is unchanged, else `restoreLayers`).
- Menus: placed layers: Duplicate, Put in folder ▸ (submenu or flat items "Put in <folder
  name>" and "Put in new folder"), Move out of folder (inside a folder), Delete; folder: Rename,
  Dissolve folder, Delete folder and content; merged: Duplicate, Separate, Delete.
- Drag (existing grip logic generalised): rows carry `data-parent` and `data-index`; dropping
  on a folder row's middle → into that folder at the top; between rows → that container and
  index (`moveInto` or `moveLayer`); folders only drop at the top level.
- Alt+↑/↓ unchanged semantics (within container), also for folders.
- Truncation warning line when `drawTruncated`.

- [ ] **9.1 Tests:** add shape menu starts a shape placement; New folder creates and renames;
  folder collapse hides children rows, eye hides content; Ctrl+click two rows shows the bar;
  Merge from the bar creates a merged row; Separate from its menu; Delete folder and content
  shows the undo toast and Undo restores.
- [ ] **9.2 Implement**, run tests, typecheck.
- [ ] **9.3 Commit** `feat(atelier): folders, merged objects and multi-select in the Layers panel`.

### Task 10: Properties panel

**Files:** Modify `PropertiesPanel.tsx`, `DecalProperties.tsx`; create `ShapeProperties.tsx`,
`RepeatSection.tsx`, `MergedProperties.tsx`; tests in `Editor.test.tsx` or a new
`PropertiesPanel.test.tsx`.

- Dispatch via `findLayer(selectedId)`: multi-select (≥ 2) → "N layers selected" + the same
  three buttons; mask/base as today; shape → shape content + shared rows; image/text as today
  + Repeat; merged → `MergedProperties`; piece → content only (no placement, repeat, cutout,
  refine) + note; folder → name + count + Dissolve / Delete buttons; unsupported as today.
- `ShapeProperties`: shape picker (4 icon toggle buttons with `aria-pressed`, labels via
  `t`), Corner (rect, 0..50 %), Points (star 3..12) + Inner size (15..90 %), Sides (polygon
  3..12), Fill segmented Solid/Stripes (Solid: one swatch; Stripes: two swatches, Angle slider
  −80..80°, Stripe width slider 1..100 cm), Outline swatch + width slider 0..20 %, Size: two
  number inputs in cm (width, height; min 0.1, max 10000; apply on blur/Enter via `setDecal`).
- Shared rows (`DecalProperties` refactor): extract `PlacementRows` (Opacity, Wear, Depth,
  Only this part, Mirror) used by image/text/shape/merged (merged: no Wear).
- `RepeatSection`: a Switch "Repeat"; when on: Copies slider 2..min(50, what the budget
  allows), Spacing 0..500 %, Direction segmented Row/Column, and for solid shapes "Alternate
  colour" switch + swatch. Each slider drag one undo step (`mergeKey` + `endGesture`).
- `MergedProperties`: placement rows, Repeat, `Separate` button (toast when the repeat was
  dropped), piece count note.

- [ ] **10.1 Tests:** selecting a shape shows the shape picker and switching to Star shows
  Points; Fill Stripes shows angle and stripe width; Repeat switch adds `repeat` to the layer;
  a piece shows the separate note and no Depth slider; a merged object's Separate splits it.
- [ ] **10.2 Implement**, run tests, typecheck.
- [ ] **10.3 Commit** `feat(atelier): properties for shapes, repeats and merged objects`.

### Task 11: Strings in nine languages

**Files:** `src/i18n/{en,it,de,es,fr,pl,pt-BR,ru,zh-CN}.json`.

Tasks 9 and 10 add their English keys under `atelier.layers.*`, `atelier.props.*`,
`atelier.shape.*`, `atelier.repeat.*`, `atelier.merge.*`, `atelier.folder.*` as they go (with
Italian right away). This task fills the other seven with real translations (style: short UI
labels matching each file's existing Atelier strings), checks plurals use the i18next
`_one/_other` (and `_few/_many` for pl/ru as the files already do), and runs
`pnpm i18n:check` (no missing keys, no em dash).

- [ ] **11.1** Fill translations. **11.2** `pnpm i18n:check` + `pnpm test src/i18n` pass.
- [ ] **11.3 Commit** `feat(atelier): translations for shapes, repeats, folders and merged objects`.

## Chunk 4: Docs and verification

### Task 12: Docs and full checks

- [ ] DESIGN_NOTES.md rows dated 2026-10-17: "Atelier: shapes" (raster like text, stripes in
  metres, quantised keys), "Atelier: repeat" (first copy is the frame, planar copies, depth
  growth 0.35, budget 400), "Atelier: folders" (one level, collapse outside undo),
  "Atelier: merged objects" (one plane, 35°, envelope mirror, separate flattens), noting that
  older Livery versions show these layers as unsupported.
- [ ] HANDOFF.md: a top section for this feature (state, checks, what's not verified).
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm build` all clean; report counts.
- [ ] Commit `docs(atelier): notes for shapes, repeats, folders and merged objects`.

### Task 13: Real-app check (controller, not a subagent)

Scratch game root (junctions to the real `content` and `content.hq`, copied archives as needed,
empty `UserSkins`) and `LIVERY_DATA_DIR` scratch with a pre-written `settings.json` (see the
`livery-dev-app-verification` memory). `pnpm tauri dev`; on the Jumbo: hazard stripe along the
lower hull, star row with alternate colours, L from two rectangles merged → moved, rotated,
mirrored, separated; folders created, collapsed, hidden, dissolved; Apply to game into the
scratch UserSkins; decode the DDS and look at it. Fix what's wrong (with tests), then commit.
