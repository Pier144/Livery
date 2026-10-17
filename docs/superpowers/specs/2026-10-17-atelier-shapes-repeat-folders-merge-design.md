# Atelier: shapes, repeats, folders and merged objects

Status: sections 1 (data model) and 2 (drawing and bake) approved by the author on 2026-10-17;
the author then said to carry on alone ("procedi pure in autonomia da adesso in poi"), so
sections 3 to 5 are my design, reviewed but not walked through with the author. Builds on
[the Atelier design](2026-10-16-atelier-skin-creator-design.md) and
[geometric camo](2026-10-17-atelier-geometric-camo-design.md).

## Why

The author made the Auto-Meg skin on the Jumbo with the Atelier on 2026-10-17 and asked for four
things a real project needed:

1. **Stock shapes** next to Image and Text: rectangle, circle/ellipse, star, regular polygon, with
   fill and outline, projected like pictures and text (same frame, resize, rotate, depth, "Only
   this part", Mirror).
2. **Repeats**: rows of copies, striped fills and above all the classic **hazard stripe** (yellow
   slanted bars on black along an edge; the author's reference is a tank with a yellow/black band
   along the lower hull).
3. **Folders in the Layers panel**: named, collapsible, to keep large projects tidy.
4. **Merge layers into one object** (two lines forming an L) that moves, scales, turns and
   projects as one, and can be separated again.

## Decisions (author, 2026-10-17)

| Question | Choice |
|---|---|
| Shapes | Rectangle (rounded corners; a line is a thin rectangle), ellipse, star, regular polygon |
| Hazard stripe | A **striped fill** any shape can use, plus a "Hazard stripe" preset (long rectangle, yellow/black at 45°) |
| Repeat on curved surfaces | Copies stay on the first copy's plane; projection depth grows with the distance, automatically |
| Folder nesting | One level (no folders in folders) |
| Merge | One plane, separable: the pieces get one shared frame and projection; colours and text stay editable inside; Separate gives the layers back; refused when pieces face too differently |

No new dependencies. No backend change: Rust keeps `layers` as opaque JSON
(`src-tauri/src/atelier/project.rs`), so the whole feature is frontend.

## 1. Data model (`src/atelier/project.ts`)

### Layer kinds

```ts
type Layer = BaseLayer | PlacedLayer | FolderLayer | MaskLayer | UnsupportedLayer;
/** Everything that has a frame on the vehicle (`decal`). */
type PlacedLayer = ImageLayer | TextLayer | ShapeLayer | MergedLayer;
/** What a merged object holds. */
type PieceLayer = ImageLayer | TextLayer | ShapeLayer;
```

`isDecalLayer` / `DecalLayer` (image | text) are renamed to `isPlacedLayer` / `PlacedLayer` and
widened; code that only means pictures and text (text width, Remove background) keeps checking
`kind`.

**ShapeLayer**

```ts
type ShapeKind = 'rect' | 'ellipse' | 'star' | 'polygon';
type ShapeFill =
  | { kind: 'solid'; color: string }
  | { kind: 'stripes'; colors: [string, string]; angle: number; stripeWidth: number };
interface ShapeLayer extends LayerCommon {
  kind: 'shape';
  shape: ShapeKind | (string & {});   // unknown kinds kept, drawn as rect
  corner?: number;      // rect only: 0..0.5 of the short side; absent = 0 (sharp)
  points?: number;      // star points / polygon sides, 3..12; absent = 5 (star) / 6 (polygon)
  innerRatio?: number;  // star only: 0.15..0.9; absent = 0.45
  fill: ShapeFill;
  outlineColor: string;
  outlineWidth: number; // hundredths of the short side, 0..MAX_OUTLINE_WIDTH (20)
  decal: Decal | null;
  opacity: number;
  wear?: number;
  repeat?: Repeat;
}
```

- `stripeWidth` is in **metres on the vehicle** (0.01..1, default 0.08): stretching a band adds
  stripes instead of widening them. `angle` is in degrees, −80..80 (default 45), measured from
  the frame's vertical, positive leaning right. Stripes alternate `colors[0]`, `colors[1]` at
  equal widths; a boundary between the two colours passes through the frame's centre, so a band
  stretched from its centre stays symmetric.
- Shapes fill their frame: a square frame gives a circle, a stretched one an ellipse; stars and
  polygons are inscribed in the frame's ellipse (one vertex pointing up), so stretching stretches
  them.
- Defaults (`newShapeLayer(shape)`): solid `#e8b600` fill (a usable yellow), outline `#000000`
  width 0, square frame. Hazard preset: rect, stripes `#e8b600` / `#141414`, angle 45,
  stripeWidth 0.08, frame aspect 8:1, name = the localized "Hazard stripe".

**Repeat** (optional on every placed layer, merged objects included; absent = one copy)

```ts
interface Repeat {
  count: number;        // 2..MAX_REPEAT (50)
  gap: number;          // space between copies, fraction of the copy's width (row) or height (column), 0..5
  direction: 'row' | 'column';
  alternate?: string;   // shapes with a solid fill only: '#rrggbb' of every second copy
}
```

The layer's `decal` stays the **first** copy (gizmo, snapping and keys act on it); copy *i*
(0-based) sits `i × (1 + gap) × width` along the frame's right (row) or
`i × (1 + gap) × height` along its −up (column, downwards), on the same plane, with the same
normal, up and size. Its depth is `depth + REPEAT_DEPTH_GROWTH × distance` (0.35, tuned in the
app), so a row keeps landing on gently curved surfaces. `alternate` on a non-shape or a striped
shape is kept but ignored. Copies are drawn with the first copy's raster (one raster per layer,
its height from the first copy's texel density).

**MergedLayer** (shown as "Merged object")

```ts
interface Place { x: number; y: number; w: number; h: number; angle: number }
type Piece = Omit<PieceLayer, 'decal'> & { place: Place };
interface MergedLayer extends LayerCommon {
  kind: 'merged';
  decal: Decal | null;
  opacity: number;
  repeat?: Repeat;
  children: Piece[];    // bottom to top, 1..MAX_PIECES (50)
}
```

`place` is in the merged frame's normalized plane: centre `x, y` in fractions of the frame's
width/height (−0.5..0.5 inside, may exceed slightly), size `w, h` in fractions, `angle` in
radians counter-clockwise from the frame's up. Pieces keep their own opacity, wear and
fill/text. Pieces have **no repeat** (merging a repeated layer turns each copy into its own
piece) and no `part`/`mirror` of their own: the merged frame's apply. A piece of a kind this
version doesn't know is kept as an unsupported piece (saved back, not drawn).

**FolderLayer**

```ts
interface FolderLayer extends LayerCommon {
  kind: 'folder';
  collapsed: boolean;
  children: (PlacedLayer | UnsupportedLayer)[];  // bottom to top
}
```

### The layer tree (`src/atelier/layerTree.ts`, pure)

Containers are the top level (`null`), a folder (its id) and a merged object (its id, pieces
only). The API every store action and screen uses instead of `layers.find`:

- `findLayer(layers, id) → { layer, parentId: string | null, index } | null` (searches folders
  and merged pieces);
- `childrenOf(layers, parentId)`, `replaceLayer(layers, id, next)`, `removeLayers(layers, ids)`,
  `insertLayers(layers, parentId, index, items)`;
- `allLayers(layers)` (depth-first, bottom to top, folders and pieces included) for fonts,
  assets, snapping targets and the like; `serializeLayers` recurses so unsupported children and
  pieces are saved back as they came.

**Where a new layer goes:** above the selected layer in that layer's container; when a folder is
selected, at the top of that folder; when a piece is selected, above its merged object; with
the Base or the mask selected, just under the mask (as today).

### Invariants (`checkLayers`)

Top level: Base first, at most one mask last, everything else in between. Folders only at the
top level and only hold placed or unsupported layers (a folder inside a folder is moved out,
right above its parent; a Base or mask inside is moved to its pinned place). Merged objects may sit
in a folder; their pieces are image, text, shape or unsupported (a folder, Base, mask or merged
object found among pieces is dropped; no drawable piece left → the merged layer is dropped). Ids are unique across the whole tree (repeats renewed). Each of
those repairs sets `repaired`. Field checks follow the existing style: bad values take defaults,
numbers are clamped, unknown fields kept.

Old projects load unchanged. A Livery before this feature opens a new project with these kinds
as "unsupported" layers: kept and saved back, not drawn (folder contents hidden). Acceptable:
projects are local.

### Merge (`mergeLayers(ids)`, pure maths in `src/atelier/merge.ts`)

Selected placed layers, all in the same container (top level or one folder), at least two;
layers without a placement can't be merged. Merged objects in the selection are flattened (their
pieces are re-expressed in the new frame); repeated layers contribute one piece per copy. More
than MAX_PIECES (50) pieces → refused.

- **Plane:** `n` = normalized mean of the pieces' normals; refused (`reason: 'angle'`) when any
  piece's normal is more than MERGE_MAX_ANGLE (35°) from `n`.
- **Up:** the topmost selected layer's up projected onto the plane (fallbacks as `frameFromHit`).
- **Frame:** every piece's corners projected onto the plane; the frame is their bounding
  rectangle in (right, up). The plane sits at the midrange of the corners' offsets along `n`;
  depth = max piece depth + 2 × the largest corner offset from the plane, so no piece's box is
  clipped.
- **Part / Mirror:** `part` kept when all agree, else `all`; `mirror` on only when all were on.
  When either was reset, the merge toast says so.
- **Pieces:** each piece's place from its projected centre, the angle of its up in the plane, and
  its own size in metres (not the projected one) as fractions of the frame. Opacity and the rest
  move over as they are.
- The merged object takes the topmost selected layer's place in the stack and is selected.
  Name: empty (shows "Merged object").

**Separate** (`separate(id)`): each piece becomes a layer at the merged object's place (same
stack order, same id), with a decal built from the frame and its place (normal, part, mirror of
the frame; depth of the frame), opacity × the object's, hidden when the object was hidden. The
object's repeat is dropped and the toast says so; Undo brings it back. Afterwards the separated
layers are selected (the topmost active). Normals and depths of the original layers are not
restored: merge → separate gives the same centres, sizes and ups (within 1e-6) only for layers
that were on one plane; tilted ones come back flattened onto the frame's plane.

A text piece whose width changes (text, font, outline, skew) keeps its centre and height and
gets its new width; the frame is not refitted (a place may reach past the frame).

## 2. Drawing and bake

### `drawItems(layers)` (new, `src/atelier/drawItems.ts`, pure)

The one place that flattens the tree into what gets projected, bottom to top:

```ts
interface DrawItem {
  key: string;            // stable per layer/piece/copy: `${layerId}`, `${layerId}/${pieceId}`, `#${i}` suffix for copies
  source: PieceLayer;     // what the picture is drawn from (an image, a text, a shape)
  variant: 'main' | 'alt';// alt = the shape's `alternate` colour
  decal: Decal;           // final frame on the vehicle
  opacity: number;        // layer × merged object
  wear?: number;
  flipX: boolean;
}
```

- Hidden layers, hidden folders and hidden merged objects contribute nothing; unplaced layers
  nothing; opacity 0 nothing; unsupported pieces nothing.
- Merged: piece decal = frame centre + `x·width·right + y·height·up`, its up turned by `angle`,
  size `w·width × h·height`, normal/part/depth of the frame. Opacity applies per piece, so where
  semi-transparent pieces overlap the overlap is darker (documented, as for separate layers).
- Repeat: one item per copy (copy offsets as in section 1); a merged object's repeat repeats all
  its pieces together.
- **Mirror is applied by `drawItems`, on the envelope.** The envelope is the frame that holds
  everything a layer draws: a merged object's frame, or a repeated layer's whole row (centre in
  the middle of the row). With Mirror on, `drawItems` reflects the envelope with `mirrorDecal`
  (which keeps pictures readable) and places the pieces/copies inside the reflected envelope at
  the same local coordinates; so two text pieces "A" "B" or a row "1 2 3" read the same on the
  other side and cover the reflection of the original's area. Items it emits have `mirror:
  false`, so the Baker's `decalCopies` doesn't mirror them again. A plain single layer gives the
  same result as today.
- **Budget:** at most MAX_DRAW_ITEMS (400) items per project, mirror copies counted. Past it,
  `drawItems` stops (the topmost layers are not drawn) and reports `truncated`; the editor shows
  a warning in the Layers panel ("Too many copies: some layers aren't drawn"). The Repeat count
  control doesn't offer more than what fits.
- **Stable objects:** items are memoised per source layer object (WeakMap) and mirror axis, so
  an unchanged layer gives the same `DrawItem` and `Decal` objects on every `setLayers`; the
  Baker's identity checks and its density cache keep working, and a rename or a collapse
  re-bakes nothing.

The Baker (`gl/baker.ts`) iterates `drawItems` instead of `drawnDecalLayers`; a binding is keyed
by `DrawItem.key`, and `prepareExport`/`drawPaint` read the item's fields (opacity, flipX, wear,
source) instead of the layer's. Shaders, the picture cache, facing fade, densities and the export
path stay as they are. The other readers of "decal layers" move to placed layers
or draw items: snapping targets (`otherDecals`: every placed frame), the shared-texel check
(a merged object checks its frame), export preparation.

### Shapes (`src/atelier/shapes.ts`)

- Pure geometry, unit-tested: rounded-rectangle path, ellipse, star and polygon vertices, the
  stripe bands for a frame of `width × height` metres (polygons clipped by the shape at draw
  time), outline inset.
- Rasteriser on `OffscreenCanvas` with `Path2D` (like `text.ts`): height `2 × texel density ×
  frame height` quantised (`quantiseRasterHeight`), width from the frame's aspect, long side at
  most MAX_RASTER_SIDE (4096). Outline drawn inside the shape edge, so the frame is the shape's
  outer edge. Straight-alpha RGBA like text.
- Cache key `shp:<JSON of shape, corner, points, innerRatio, fill, outline, variant>:<px>:<aspect>:<p|f>`
  where the aspect is quantised to sixteenth octaves (about 4 %: the raster is stretched onto
  the exact frame, so only corner, outline and stripe proportions shift a little); for striped
  fills the frame's width and height, quantised the same way, join the key. With the Baker's
  "keep the shown picture until the new one is ready", an edge drag re-rasterises a few times,
  not on every frame.
- `variant: 'alt'` draws the solid fill in `repeat.alternate`.

## 3. Editor UI

### Layers panel (left)

- **Add bar:** `[+ Image] [+ Text] [+ Shape ▾]`. The Shape menu lists Rectangle, Ellipse, Star,
  Polygon, a divider, Hazard stripe. Each starts a placement like Image and Text (the pending
  layer waits for its click on the model; Escape cancels).
- **New folder:** a `FolderPlus` icon button at the right of the "Layers" title. It creates
  "Folder N" (localized) above the selection and starts renaming it. With several layers
  selected it creates the folder with them inside ("Put in new folder").
- **Rows:** folders show a chevron (collapse/expand, state saved in the project but outside the
  undo history), `Folder` icon, name, item count when collapsed, eye (hides the whole content),
  menu (Rename, Dissolve folder, Delete folder and content). Children are indented by 16 px.
  Merged objects show a chevron too (`Combine` icon); their pieces are listed indented, selectable
  (properties panel), not draggable on their own. Shapes use `Square`, `Circle`, `Star`,
  `Hexagon` icons by kind.
- **Multi-select:** store state `selectedIds: string[]` (empty or one = single selection) next
  to `selectedId` (the active row, always one of them when there are several). Only placed
  layers and folders in the **same container** can be multi-selected; Ctrl+click toggles,
  Shift+click selects the range in that container; a plain click, a click on the Base, the mask
  or a piece, Escape in the panel, undo, redo and any structural action go back to a single
  selection (ids that no longer exist are dropped; when the active one is gone, the selection
  falls back as today, searched in the whole tree). With 2 or more selected the panel shows a
  bar under the list: `[Merge] [Put in folder] [Delete]`. Merge is disabled with a tooltip when
  the selection holds a folder or an unplaced layer; Put in folder when it holds a folder
  (no nesting). A refused merge (angle, too many pieces) shows a toast with the reason. The 3D
  view shows a gizmo only for a single placed selection; with several, their frames are outlined
  (no handles).
- **Drag:** dropping on a folder row puts the layer at the top of the folder; dropping between
  a folder's rows positions it inside; dragging a folder moves it with its content. Keyboard:
  Alt+↑/↓ moves the selected layer or folder within its container (as today); the row menus'
  "Put in folder ▸" and "Move out of folder" cross containers.
- **Delete:** a folder's "Delete folder and content" and the multi-select Delete go through the
  existing undoable toast ("Deleted N layers"); its Undo uses the editor's undo when nothing
  changed since, else `restoreLayers(entries)` puts every deleted layer back into its container
  at its index (containers that are gone: the top level, under the mask). Dissolve keeps the
  content in place.
- **Collapse:** folders keep `collapsed` in the project; toggling it is not an undo step: the
  store applies the flag to the current layers and to every `past`/`future` snapshot (as
  `refreshTextMetrics` does), so undo never flips it. Merged objects' expanded state is panel
  state only (collapsed by default).
- Merged object menu: Duplicate (new ids for the object and its pieces), Separate, Delete.
  Placed layers' menus gain "Put in folder ▸" (existing folders, new folder) and, inside a
  folder, "Move out of folder".

### Properties panel (right)

- **Shape:** Shape picker (four icon buttons), shape-specific sliders (Corner rounding; Points
  and Inner size for stars; Sides for polygons), **Fill** (segmented Solid / Stripes; Solid → one
  colour; Stripes → two colours, Angle, Stripe width in cm), **Outline** colour and width,
  **Size** (width and height in cm, editable numbers, so a line can be exactly 5 × 150 cm), then
  the shared rows: Opacity, Wear, Depth, Only this part, Mirror.
- **Repeat** section on every placed layer (collapsed to a "Repeat" switch when off): Copies
  (2..50), Spacing (0..500 % of the copy), Direction (Row / Column), and for solid shapes
  "Alternate colour" (switch + swatch).
- **Merged object:** Opacity, Depth, Only this part, Mirror, Repeat, and a "Separate" button;
  a note lists the pieces. Uniform scale only (see gizmo).
- **Piece inside a merged object:** its content settings (text, font, colours, fill, outline,
  shape options, opacity, wear; images: flip) but no placement, repeat, Remove background or
  Refine edge rows; a note says "To move this piece or change its picture, separate the object".
- **Multi-select:** "N layers selected" and the same three buttons as the panel bar.

### Gizmo (3D view)

- Shapes get **edge handles** (midpoints of the four sides) that stretch one axis; corners keep
  the ratio, Shift frees it (as images today). Images and text keep today's handles. Merged objects scale uniformly only (stretching would skew
  rotated pieces): corners only, Shift ignored.
- With Repeat on, the whole row's outline is drawn dashed around the first copy's frame.
- Snapping (centre line, level, other frames) works for every placed layer, merged objects
  included; the snap targets are every other placed frame (pieces excluded).

### Code that looks layers up (moves to `layerTree`)

Store: `decalLayer`, `replaced`, `insertIndex`, `deleteLayer` (next selection), `restoreLayer`,
`duplicateLayer`, `toggleLayerVisible`, `renameLayer`, `applyCutout` (top-level and folder
images only), `refreshTextMetrics` (incl. `past`/`future`), undo/redo selection fallback.
Screens: `selectedPlaced` and `placeAt` in `Viewport.tsx` (re-placing an unplaced shape uses
aspect 1, a hazard stripe 8), `liveDecal`/`otherDecals` in `DecalGizmo.tsx`, `checkShared` and
`useTextFonts` in `Editor.tsx` (fonts of text in folders and pieces load too),
`PropertiesPanel.tsx`, `LayersPanel.tsx` (warnings, `deleteWithToast`), `CutoutDownloadDialog.tsx`,
`RefineEdgeDialog.tsx`.

### Undo

Every structural action (add shape, repeat edits, create/rename/dissolve/delete folder, move
in/out, merge, separate, multi-delete) is one undo step. Collapse/expand and the selection are
not.

## 4. Errors and limits

- Merge refused: mixed containers, fewer than two placed layers, an unplaced layer, pieces facing
  more than 35° apart, more than 50 pieces. Shown as a toast (`atelier.merge.*`).
- Repeat count capped at 50, pieces at 50, and the project at MAX_DRAW_ITEMS (400) draw items,
  mirror copies counted (section 2).
- Copies on strongly curved or wrapped surfaces (round turret, around corners) stretch like any
  projection; documented as a known limit (DESIGN_NOTES).
- A raster over the GPU limit falls back as text does.

## 5. Testing and checks

- **Vitest, pure:** `layerTree.ts` (find, replace, remove, insert, move across containers,
  flatten order, serialisation of unsupported children), `checkLayers` for every new kind and
  repair, `shapes.ts` geometry, stripe bands and phase, `drawItems` (visibility, folders, merged
  maths, repeat offsets, alternate variant, depth growth, keys, envelope mirror: a merged "A" "B"
  and a row keep their order on the other side, budget and `truncated`, memoised identity),
  `merge.ts` (plane, depth covers tilted pieces, refusal, bounds, flattening nested and repeated
  layers, coplanar round trip merge → separate within 1e-6), editor store actions (one undo step
  each, selection rules incl. undo with a folder child selected, collapse outside the history,
  multi-delete restore, text width inside merged objects).
- **Baker tests:** drawn items for shapes/merged/repeats with the stub renderer; shape raster
  keys.
- **Components (smoke):** add-shape menu, folder rows (collapse, eye, rename), multi-select bar,
  merge/separate buttons, shape and repeat properties, piece note.
- **i18n:** every new string in the nine languages (en, it, de, es, fr, pl, pt-BR, ru, zh-CN),
  no em dashes; `pnpm i18n:check`.
- **Checks:** `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm build`. No Rust change, so
  `cargo test` only if a Rust file is touched.
- **Real app:** `pnpm tauri dev` with `LIVERY_DATA_DIR` on a scratch folder and a scratch game
  root (junctions to `content`/`content.hq`, empty `UserSkins`), never the real UserSkins. On
  the Jumbo: a hazard stripe along the lower hull, a row of stars with alternate colours, an L
  from two rectangles merged, moved, rotated, mirrored and separated, folders created, collapsed,
  hidden, dissolved; Apply to game into the scratch UserSkins; the DDS decoded and looked at.
- DESIGN_NOTES rows "Atelier: shapes", "Atelier: repeat", "Atelier: folders", "Atelier: merged
  objects"; HANDOFF top section.
