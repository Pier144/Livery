# Atelier: create War Thunder skins in Livery

> **Implementation status (2026-10-17):** Phase 1 (MVP) and Phase 2 are implemented on branch
> `feat/atelier`, reviewed task by task and checked in the real app on the M4A3E2 Jumbo. Plans:
> [MVP](../plans/2026-10-16-atelier-mvp.md), [Phase 2](../plans/2026-10-16-atelier-phase2.md).
> Where the code differs from this document (Oodle in a worker process, `ort` rc.13, compositing
> scheme, folders), the plans and their review fixes are the reference.

Status: design approved by the author on 2026-10-16, section by section; revised the same day
after a spec review (install entry point, staging lifecycle, project schema, masks, mirrored UVs,
no new hashing crate). The author gave free hand on additions ("Hai piena liberta nelle
aggiunte"); the one addition is **Mirror to the other side** (section 2). **Phase 0 passed** the
same day (see "Phase 0 outcome"); the author approved `oozextract` for the Oodle streams. Next
step: implementation plan.

## Goal

A skin creator inside Livery, **Atelier**, that turns what was done by hand for the Megumin
M4A3E2 Jumbo (2026-10-16, scripts in `D:\Dev\Progetti\Livery-skin-lab\jumbo-megumin`) into a
tool: pick a vehicle, paint it on a 3D model with a base colour/camo, projected images and text,
keep the parts that must stay original, and apply the result to the game in one click.

Audience: **the author first, then the public.** Atelier ships hidden behind an experimental
switch; the switch goes away when the author is satisfied.

### What the Jumbo taught us (the problems this design removes)

| Pain on the Jumbo | How Atelier removes it |
|---|---|
| The in-game template (Customization, magic wand) copies whatever user skin is active, so it must be generated with User skin = Disabled. | Atelier reads the vehicle's original `_c` textures from the game's packs: no template step at all. |
| UV regions (hull side strips, the glacis lying on its side with its top toward +u, stowage at the lower right) were found by trial and error. | Painting happens on the 3D model; images are projected and baked into UV space, so nobody needs to know where the islands are. |
| Placement/rotation of the bust (rotate -90, fit, centre) was code. | Click on the model, then handles for move/rotate/scale/depth. |
| Background removal needed `isnet-anime.onnx` run by hand with onnxruntime in Python 3.13. | "Remove background" button, same model, downloaded on first use. |
| Detail preservation (`detail_map`: luminance over local mean) and the keep mask were bespoke. | Built into the bake: every skin keeps panel lines, rivets and grime; the "Protected areas" layer replaces the keep mask. |
| DDS DXT5 via Pillow, `.blk` rewritten by hand. | Rust encodes DXT5 and writes the `.blk`; Livery installs it into its library. |

Facts carried over (recorded in the `wt-skin-authoring` memory and checked on the real install):
- Skins use `set_tex{ from:t="<base>_c*"; to:t="<file>"; param:t="camo_skin_tex" }`, where
  `<base>` is the texture name without its `_c` suffix (e.g. `m4a3e2_sherman_jumbo_body`). RGB is
  the paint, alpha 255 shows the paint, alpha 0 shows the game's original texture.
- DDS DXT5 without mips works; the Jumbo body ran at 4096 (template 2048).
- After overwriting an installed skin's files, re-selecting the skin in the hangar shows the
  change (author, 2026-10-16). No game restart needed.
- The game's template folder is `UserSkins/template_<vehicle>`, and its `.blk` is named
  `<vehicle code>.blk`; the Jumbo's (`template_us_m4a3e2_sherman_jumbo`) is on the author's disk
  and serves as ground truth.
- Ground vehicle models live in `<game>/content/base/res/tanks/*.grp` (magic `GRP2`, Dagor Engine
  game-resource packs; e.g. `usa_m4a3e2_sherman_jumbo.grp` holds `m4a3e2_sherman_jumbo` plus
  `_dmg`, `_xray`, `_collision`… resources). Textures live in `*.dxp.bin` (magic `DxP2`).
  Gaijin published the Dagor Engine under BSD-3, which documents both formats.

### Out of scope for v1

Aircraft, helicopters and ships (v1 reads `res/tanks` only), a freehand **colour** brush (the
only brushes are the protected-area mask and the cutout eraser), procedural ornaments (the
Jumbo's magic circles and flames stay custom work), editing the 2D template directly,
sharing/importing projects, publishing to WT Live (Livery's existing ZIP export covers it), the
"UV probe skin" (kept only as Plan B, see Phase 0).

## Decisions (author, 2026-10-16)

| Question | Choice |
|---|---|
| Who is it for | The author first, then Livery's users |
| Where it lives | Inside Livery, hidden behind an experimental switch in Settings |
| Finding UV regions | 3D preview from the game's own models |
| Layer types in v1 | Base colour and camo, images, text, protected areas |
| Placing images and text | Projection from the 3D view (decal-style), baked into the textures |
| Background removal | isnet-anime, downloaded on demand |
| Template source | Read from the game's files by Livery (no in-game template step) |
| Bake architecture | A: everything on the GPU in the frontend (three.js + WebGL); Rust for game files, cutout, DDS and install |
| New dependencies (approved for this feature) | `three` (npm, MIT), `ort` (Rust, MIT/Apache, `load-dynamic`) with ONNX Runtime and the model downloaded at runtime, `image` (Rust, MIT/Apache), `texpresso` (Rust, MIT), and after Phase 0 `oozextract` (Rust, MIT, pure-Rust Oodle decompressor). Nothing else: sha256, the DXT1/DXT5 decoder and the meshoptimizer index decoder are written in-house. |

## Phases

- **Phase 0, feasibility spike (gate).** Read `usa_m4a3e2_sherman_jumbo.grp`: name table, the
  `m4a3e2_sherman_jumbo` DynModel, LOD 0 meshes (positions, normals, UVs, indices), the node
  hierarchy (hull/turret/gun transforms), materials and their `_c` texture names. Find and
  decode `m4a3e2_sherman_jumbo_body_c` (and turret, gun) in the `.dxp.bin` packs. Pass criteria:
  the mesh renders correctly with the decoded textures, and the decoded textures match
  `UserSkins/template_us_m4a3e2_sherman_jumbo` (allowing for the template's "SAMPLE" alpha).
  Also settle the points listed at the end of this document. **If the formats turn out to be
  impractical (e.g. a proprietary codec), stop and go back to the author** with Plan B: a "UV
  probe skin" (a generated grid with coordinates and up arrows, installed, read in the hangar and
  marked on a 2D template). The outcome is recorded in DESIGN_NOTES.
- **Phase 1:** Rust readers, projects, 3D view, base colour/camo, protected areas, Apply to game.
- **Phase 2:** projected images and text, Mirror to the other side, background removal.
- **Phase 3:** polish (a11y, tests, mock backend completeness, native-speaker-quality
  translations), then the author decides when the experimental switch goes.

Every user-visible string exists in all nine languages from the phase that adds it
(`pnpm i18n:check` fails otherwise; no English copies, no em dashes).

## 1. Backend (Rust)

One module per domain, as CLAUDE.md asks.

### `game::gameres` (read-only readers of the game's packs)

Written in-house from the open Dagor Engine sources (credited in About → Licenses), like
`game::vromfs`. `zstd` is already a dependency.

- `grp`: the `GRP2` name table and resource directory; the DynModel resource of a vehicle → LOD 0
  meshes (positions, normals, UV0, indices), nodes with their transforms, materials with their
  texture names. Other LODs and the `_dmg`/`_xray`/`_collision` resources are ignored.
- `dxp`: the `DxP2` directory; find a texture by name, decode it (DXT1/DXT5 through
  `textures::bc`) to RGBA8.
- `index`: vehicle code → model name (`aces.vromfs.bin`, `gamedata/units/tankmodels/<code>.blk`,
  param `model`), model → `.grp`, texture → `.dxp.bin` (from the header copies in
  `grp_hdr.vromfs.bin`), model → materials and `_c` textures (`dynModelDesc.bin`). Built once per
  game version and cached in the app data folder.
- Oodle streams are decoded with `oozextract`; zstd with the existing `zstd` crate.

Parsed meshes are cached per game version + file mtime, so reopening a project is fast.

**Slots.** A slot is one `_c` texture referenced by the LOD 0 materials. `atelier_model` lists all
of them with `paintableByDefault = true` when the texture name starts with the model name
(`m4a3e2_sherman_jumbo_body_c`, `_turret_c`, `_gun_c`) and `false` for shared textures
(`mg_browning_m2hb_mount_c`, `us_net_tile_roll_c`, tracks, camo tiles). The project stores the
user's per-slot on/off choice; only enabled slots are painted, baked and exported.

### `textures::bc`

DXT1/DXT5 decode (shared with `dxp`) and DXT5 encode with `texpresso`; DDS writer (DXT5, no
mips). The existing `textures::header` parser stays as is.

### `atelier`

- **Projects** in `<app data>/atelier/<projectId>/`: `project.json` (see "Project file" below),
  `assets/<assetId>.png` (imported images downscaled to at most 4096 px on the long side, cutouts
  as new assets), `thumb.png`. Writes are atomic (temp file + rename). Rust validates the
  envelope (schema version, id, name, vehicle, slots, installed skin id) and stores `layers` as
  opaque JSON: the frontend owns the layer schema and validates it on load (unknown layer kinds
  are kept but shown as unsupported).
- **Project trash:** delete moves the folder to `<app data>/atelier/.trash/<projectId>`; Undo in
  the toast moves it back; when the toast closes without Undo the trash entry is removed (the
  same rule the author chose for deleted skins on 2026-10-15). Leftover trash is purged at launch.
  Not listed in Settings → Backups.
- **Cutout** (`ort`, `load-dynamic`): on the first "Remove background", download Microsoft's
  official ONNX Runtime release zip (a version `ort`'s `load-dynamic` supports, pinned) and
  extract `onnxruntime.dll` with the existing `zip` crate, and download `isnet-anime.onnx`
  (176 MB, Apache-2.0), into `<app data>/models/`, with pinned URLs and pinned sha256. Hashing
  uses an in-house SHA-256 (`atelier::sha256`, tested against the NIST vectors), so no new crate.
  A mismatch deletes the file and fails. The download can be cancelled; Settings → Experimental
  shows the model's size and a "Remove" button. Pipeline as in `isnet.py`: resize to 1024×1024,
  normalise (mean 0.485/0.456/0.406, std 1.0), run, min-max normalise the mask, resize back, crop
  to the mask's bounding box (threshold 20/255). Runs on a blocking thread with progress events.
  Only the download touches the network, and only on the user's click.
- **Apply** (staging lifecycle, see section 3).

### Library entry point (new)

`library::ops::install_generated(user_skins, store, staged_dir, target)`, inside one
`LibraryStore::transact`, reusing the existing pieces (`scan::scan_skin`, `free_name`,
`rename_retrying`, the replace backup of `backup.rs`):

- `target = Replace(skinId)` and the id is in the index (active **or** inactive, found with
  `layout::find_skin`): back up the current folder (the existing replace backup: kept
  `backupDays` with Settings → Backups on, ephemeral otherwise, so Undo then works only while the
  toast is up; Undo via the existing `undo_replace`, same folder key), swap in the staged files,
  keep the folder name, the active state **and the library id** (the new entry reuses the old
  id, so the project's `installedSkinId` stays valid after an apply and after an Undo, which
  removes the newer entry before re-adding the backed-up one).
- `target = New(folderName)` or the id is gone: install as a new skin in `UserSkins` (active),
  `Origin::Mine`, folder name from `archive::analyze::sanitize_folder_name`, a clash takes
  `<folder> (2)` (the `free_name` rule) regardless of Settings → Conflicts (nothing to ask: it is
  the user's own new skin).

Renaming a project doesn't rename the installed folder (the user can rename it in Hangar; the id
stays the same, so applies keep replacing it).

### Commands

All return `Result<T, AppError>`. Binary payloads use `tauri::ipc::Response` (out) and raw
request bodies (in), never JSON arrays.

| Command | Returns |
|---|---|
| `atelier_model(vehicle)` | Binary mesh buffer (header + per-part vertex/index arrays, node transforms, material → slot) and the slot list (texture name, size, `paintableByDefault`) |
| `atelier_template_texture(vehicle, slot)` | RGBA8 bytes of the original `_c` texture |
| `atelier_projects()` | Project summaries (id, name, vehicle, updatedAt, hasThumb) |
| `atelier_project_create(name, vehicle)` / `atelier_project_get(id)` / `atelier_project_save(project)` / `atelier_project_duplicate(id)` | Project |
| `atelier_project_delete(id)` / `atelier_project_undo_delete(id)` / `atelier_project_forget_deleted(id)` | Unit |
| `atelier_project_thumb(id, png bytes)` | Unit (sent when leaving the editor and after an apply, not on every autosave) |
| `atelier_import_image(projectId, path)` | Asset ref (id, width, height) |
| `atelier_asset(projectId, assetId)` | PNG bytes |
| `atelier_asset_put(projectId, png bytes)` | Asset ref (used by the cutout eraser's result) |
| `atelier_cutout_status()` / `atelier_cutout_download()` / `atelier_cutout_cancel()` / `atelier_cutout_remove()` | Readiness / unit |
| `atelier_cutout(projectId, assetId)` | New asset ref |
| `atelier_apply_begin(projectId)` → `applyId`; `atelier_apply_texture(applyId, slot, rgba bytes)`; `atelier_apply_commit(applyId)` → installed skin; `atelier_apply_cancel(applyId)` | See section 3 |
| `atelier_fonts()` / `atelier_font_file(name)` | Windows fonts from the registry (via `winreg`) / font bytes for `FontFace` |

Events: `atelier://download-progress`, `atelier://cutout-progress`, `atelier://apply-progress`
(Rust's steps only: encode, write, install).

Contract additions go into `src/types.ts` ↔ `model.rs` and are recorded in DESIGN_NOTES
(`DATA_MODEL.md` is not edited).

### Project file

```ts
interface AtelierProject {
  version: 1;
  id: string; name: string; vehicle: string;          // vehicle code, e.g. us_m4a3e2_sherman_jumbo
  createdAt: string; updatedAt: string;
  slots: { texture: string; enabled: boolean }[];      // from atelier_model, user's choice
  output: { highQuality: boolean };                    // body slot to 4096 when its template is smaller
  installedSkinId?: string;                            // library id, never a path
  layers: Layer[];                                     // bottom to top; layers[0] is the Base
}
type Layer = BaseLayer | ImageLayer | TextLayer | MaskLayer;
interface LayerCommon { id: string; name: string; visible: boolean }
interface BaseLayer extends LayerCommon { kind: 'base'; mode: 'solid' | 'camo';
  colors: string[]; scale: number; seed: number }      // colors '#rrggbb', 1 for solid, 2 to 4 for camo
interface Decal { center: Vec3; normal: Vec3; up: Vec3; width: number; height: number;
  depth: number; part: 'all' | string; mirror: boolean } // part = node name; mirror = Mirror to the other side
interface ImageLayer extends LayerCommon { kind: 'image'; assetId: string; decal: Decal;
  opacity: number; flipX: boolean }
interface TextLayer extends LayerCommon { kind: 'text'; text: string; font: string; color: string; // size = the decal's height
  outlineColor: string; outlineWidth: number; skew: number; decal: Decal; opacity: number }
interface MaskLayer extends LayerCommon { kind: 'mask'; strokes: Stroke[] }
interface Stroke { erase: boolean; radius: number; hardness: number; part: 'all' | string;
  dir: Vec3;                                           // camera view direction when painted (facing limit)
  points: Vec3[] }                                     // model-space points, resolution-independent
```

There is exactly one mask layer (created on first use), pinned at the top of the list as the
Base is pinned at the bottom; it is applied last.

### Game-data and experimental switches

- Atelier needs Settings → Game → "Read data from the game" (`readGameData`). With it off, the
  Atelier section explains why and links to the setting; no pack is opened.
- A new Settings section **Experimental** (it: "Sperimentale") holds "Atelier" (new field
  `atelierEnabled: boolean`, default `false`, in `Settings`/`SettingsPatch` in `model.rs` and
  `types.ts`, the defaults in `queries/settings.ts`, the mock backend's validators) and, once the
  model is downloaded, its size and a Remove button.

## 2. Frontend

### Navigation

With `atelierEnabled` on, the sidebar shows **Atelier** (Lucide `Paintbrush`, 16 px). Routes:
Atelier home (project grid) and the editor.

### Atelier home

A grid of project cards (thumbnail, name, vehicle, last edit) and "New project". Card actions:
open, rename, duplicate, delete (`toast.undoable()` + the project trash). The empty state invites
the first project. Skeletons while loading, never spinners.

New project dialog: name + vehicle. The vehicle field is a new controlled `VehiclePicker`
extracted from `src/screens/Explore/VehicleInput.tsx` (value/onChange props, a `types` filter,
`allowFreeText`); Explore keeps its current behaviour through it (free text allowed), Atelier
uses ground vehicles only and accepts only a listed vehicle. If the vehicle's model can't be
read, the dialog says so and creates nothing.

### Editor layout

- **Top bar:** back, project name (editable) + vehicle, save state ("Saved"), undo/redo,
  "Template / Paint" toggle (compare with the original), **Apply to game** (the one primary
  button).
- **Left: layers** (bottom to top; reorder by drag and keyboard, hide, rename, delete). Add image
  (file dialog via `tauri-plugin-dialog`), add text, protected areas. Below the layers, **Parts**:
  the slot list with on/off switches.
- **Centre: 3D view** (three.js): orbit, zoom, pan; quick views (front, side, rear, top). Click to
  place the selected layer; handles to move, rotate, scale; wheel or slider for projection depth.
- **Right: properties** of the selected layer.

Wireframe agreed in the brainstorm (left layers, centre 3D, right properties, top bar). Exact
widths, spacing and colour follow `tokens/` and the existing screens at 1440×900 and 1100×700;
no ad-hoc hex values; strings via `t('atelier.*')`.

### Layers

| Layer | Properties |
|---|---|
| **Base** (exactly one, always at the bottom) | Solid colour, or camo: 2 to 4 colours, scale, seed. Applies to every enabled slot. |
| **Image** | Asset, decal (position, rotation, width/height, depth), opacity, flip, "Only this part" (hull, turret, gun, or all), Mirror to the other side, Remove background, Refine edge. |
| **Text** | Text, Windows font, size, colour, outline width and colour, skew; rendered to a canvas (2× the decal's texel size, at most 4096), then projected like an image. If the font is missing when the project reopens, Geist is used and the layer shows a warning. |
| **Protected areas** | Brush and eraser painted on the 3D model (radius, hardness, "Only this part"); where painted, the output alpha is 0, so the game shows its original texture (the Jumbo's canvas/stowage keep mask). |

- **Mirror to the other side** (the addition): a second copy of the decal reflected across the
  model's left/right symmetry plane (the axis comes from `atelier_model`'s header, settled in
  Phase 0; Dagor models are usually X forward, Y up, so the plane is likely z = 0; the copy's
  image is flipped so text stays readable), for hull-side writing on both sides. Off by default.
  Where the overlap map says both sides share texels, Mirror is unavailable for that decal and
  the shared-texture hint explains why (one side would read backwards).
- **Refine edge**: a dialog showing the image on a checkerboard with a 2D erase/restore brush on
  its alpha; the result is saved as a new asset (`atelier_asset_put`), so the original stays.

Undo/redo: a 100-step history in the editor's Zustand store (a stroke or a drag is one step).
Autosave debounced (about 1 s after the last change) through `atelier_project_save`.

### Projection

A click casts a ray into the mesh; the hit gives position and normal, and the camera's up gives
the decal's up. The decal is an oriented box; a texel receives the decal if its model-space
position is inside the box and its normal faces the projection direction (normal · −box normal
> 0.2), so the image doesn't appear on the opposite side. "Only this part" limits the decal to
one node's meshes, so a decal on the glacis doesn't paint the gun barrel in front of it. A decal
may span several UV islands: the bake works per texel in 3D.

**Shared and mirrored UVs.** If several triangles map to the same texels (mirrored sides, road
wheels), whatever is painted on one shows on all of them. v1 accepts this: the bake draws every
triangle (last drawn wins on conflicts), and when a decal or stroke touches triangles whose UVs
overlap others, the properties panel shows a hint ("This area shares its texture with another
part of the vehicle"). The overlap map is computed once per model. UVs outside 0 to 1 wrap
(triangles are drawn at `uv − floor(min uv)`); the actual frequency is checked in Phase 0.

### Bake (architecture A)

For every enabled slot, one WebGL render target at the output size. The meshes using that slot
are drawn **unwrapped** (vertex position = UV), so each texel knows its model-space position and
normal. Passes, in order:

1. **Base:** solid colour, or camo from 3D value noise of the texel's model-space position
   (two octaves, thresholded into the 2 to 4 colours), so islands have no seams.
2. **Projected layers** (images and text, with their mirrored copies), in layer order, with
   opacity.
3. **Detail preservation:** the paint is multiplied by the template's detail map, the Jumbo
   formula `d^0.6 · glob^0.35`: `d` = template luminance over its local Gaussian mean (sigma
   24 px at 2048, scaled with the template size), clamped 0.6 to 1.3; `glob` = local mean over the
   global mean, same clamp. Computed at the template's native size, then sampled at the output
   size.
4. **Protected areas** into alpha (255 elsewhere): mask strokes are rasterised per texel as
   spheres around their points (with hardness falloff), limited to their part and to texels
   facing the camera direction stored with the stroke.
5. **Dilation** of 4 px past island edges, so seams don't show at lower mips in game.

The 3D view uses the same render targets: at reduced size (1024) while dragging or painting, full
size at rest, and only the selected slot is kept at full size between bakes (GPU memory). The
"High quality" option raises the body slot to 4096 when its template is smaller; other slots stay
at their template size.

## 3. Apply to game

1. The frontend shows the steps: **Bake** (frontend, per slot), then **Encode**, **Write**,
   **Install** (from `atelier://apply-progress`). The button is disabled while an apply runs.
2. `atelier_apply_begin(projectId)` first calls `QueueStore::ensure_partials_purged(user_skins)`
   (so a later queue or WT Live action in the same session can't purge the folder mid-apply),
   then creates `UserSkins/.livery/partial/<applyId>` (the existing partial folder, so
   `purge_partials` cleans up after a crash) and returns `applyId`.
3. For each enabled slot, the frontend bakes and sends RGBA with `atelier_apply_texture`; Rust
   encodes DXT5 DDS (no mips) right away into the partial folder and drops the buffer, so at most
   one 64 MB slot is held at a time. File name `<base>.dds` (e.g.
   `m4a3e2_sherman_jumbo_body.dds`).
4. `atelier_apply_commit(applyId)` writes `<vehicle code>.blk` (e.g.
   `us_m4a3e2_sherman_jumbo.blk`, which is how the library scan resolves the vehicle) with
   `name:t="user"` and one `set_tex` per slot (`from:t="<base>_c*"`, `to:t="<base>.dds"`,
   `param:t="camo_skin_tex"`), then calls `install_generated`: `Replace(installedSkinId)` when the
   project has one, else `New(<vehicle>_<project name>)`. The project's `installedSkinId` is set.
5. Replace shows `toast.undoable()` (Undo restores the previous version through `undo_replace`).
   The final toast reminds the user to re-select the skin in the hangar.
6. `atelier_apply_cancel(applyId)` (user cancel, leaving the editor, or any error) removes the
   partial folder; the installed skin stays as it was.

## 4. Errors

All `AppError`s with localized messages in the nine languages (the guard in
`src/lib/errors.test.ts` applies; message constants get unique names): model not found or format
not recognised (the `.grp` name in `detail`), texture missing from the packs, download failed,
cancelled or sha256 mismatch, image unreadable or larger than 16384 px, apply failed (partial
folder removed, previous skin untouched), unknown `applyId`. Frontend-only: WebGL unavailable
(Atelier explains it and stays closed), render target above the GPU limit (falls back to 2048 and
says so). Paths hidden by default, as everywhere in Livery.

## 5. Terms

Reading models and textures goes further than the vehicle names `game::catalog` reads. Same
posture as `docs/wtlive-terms.md` §8: read-only, local, nothing redistributed (an exported skin
contains only the user's paint, as any skin made from the in-game template does), under the
"Read data from the game" switch. Phase 1 adds a subsection to §8. Accepting the risk is the
author's decision before the experimental switch is removed.

## 6. Testing

- **Rust, fixture-based** (`src-tauri/tests/fixtures`): a small hand-made `GRP2` and `DxP2` (game
  files never go into the repo), DXT1/DXT5 decode and encode round trip within a tolerance, DDS
  writer header, `.blk` writer, SHA-256 against the NIST vectors, project store (atomic save,
  envelope validation, trash and undo), `install_generated` (new, clash → `(2)`, replace active,
  replace inactive, id kept on replace, id gone → new, undo replace, apply → Undo → apply again
  leaves exactly one skin) on temp folders, apply lifecycle (begin, texture,
  commit, cancel, unknown id), cutout pre/post-processing as pure functions.
- **Rust, ignored (run by hand, read-only on the real install):** Jumbo model + textures decode;
  the decoded body/turret/gun match `template_us_m4a3e2_sherman_jumbo` within a tolerance.
- **Vitest:** layer store (history, reorder, serialisation, load validation), projection maths
  (pure functions: decal box from a hit, texel-in-box, facing test, mirror reflection), stroke
  rasterisation maths, autosave debounce, `VehiclePicker` in both modes; components
  smoke-tested with WebGL stubbed.
- **Mock backend** for `pnpm dev:mock`: a textured cube with three slots instead of a tank, a
  fake cutout, a fake apply.
- **By hand:** the Megumin Jumbo rebuilt in Atelier (base, bust on the glacis with Remove
  background, "EXPLOSION!" on both hull sides with Mirror, canvas protected), applied, checked in
  the hangar.

## Phase 0 outcome (2026-10-16)

**Feasible.** A throwaway Python spike read the Jumbo's LOD 0 (85 rigid objects, 114,725
vertices, 99,202 triangles), its node hierarchy, the material → texture binding and the
original `_c` textures straight from the packs; the assembled model renders correctly and the
UV layout lands exactly on the template. Full format notes (offsets, field sizes, enums,
pitfalls): [2026-10-16-atelier-phase0-formats.md](2026-10-16-atelier-phase0-formats.md).
Facts that change or settle the design:

- **Oodle everywhere.** Every tank DynModel vertex block and every `_c` texture is Oodle
  (Leviathan). Livery decodes it with `oozextract` (approved). The spike used the game's own
  `oo2core_9_win64.dll` through ctypes; Livery never loads game code.
- **Vehicle → model:** `aces.vromfs.bin` (not `char.vromfs.bin`),
  `gamedata/units/tankmodels/<code>.blk`, root param `model`. Those BLKs are "slim" with shared
  names, zstd and a dictionary (kind 5): `game::binblk` must support that kind (it documents
  0 to 4 today).
- **Model/texture → pack:** `content/base/res/grp_hdr.vromfs.bin` (and the same file under
  `content.hq/hq_tex/res/`) holds header copies of every `.grp` and `.dxp.bin`; the index is
  built from those without opening any pack.
- **Materials** are not in the `.grp` for tanks: `content/base/res/dynModelDesc.bin` (zstd
  binary BLK) has, per model, a `tex` list and `matR` materials; slot `t0` is the diffuse `_c`.
- **Textures:** the full-size `_c` (same size as the in-game template) is the `$hq` part in
  `content.hq/hq_tex/res/hq_tex_tanks/<pack>.dxp.bin`; without the HQ pack only a 512 level
  exists (Atelier then works at 512 upscaled and says so). `_c` is DXT5.
- **Brightness:** the game stores `_c` at about half intensity; template RGB ≈ clamp(2 × game
  `_c`). Atelier shows and paints at template brightness (×2), which is what skins expect.
- **Geometry:** positions are SHORT4N with a per-model scale/offset, then the node's model-space
  matrix from `<model>_skeleton`; UV0 = SHORT2 / 4096, origin top-left; indices use
  meshoptimizer's index-sequence encoding plus `baseVertex`. Dagor is Y up, X forward,
  left-handed: the viewer negates z and flips the winding. The left/right mirror plane is z = 0.
- **Tracks** are skinned meshes: not parsed in v1. The 3D view shows the vehicle without tracks
  (track textures are shared and not paintable anyway).
- **Body geometry** sits on `@root`; turret and gun on `bone_turret` / `bone_gun` (and children):
  "Only this part" uses those three groups (hull = everything not under turret or gun).

## Open points left for implementation

- How much of the Jumbo's UV space is shared or mirrored, and whether UVs leave 0 to 1.
- Which `_c` textures the LOD 0 materials reference, and whether the `paintableByDefault` rule
  (name starts with the model name) holds.
- Vehicles sharing a model with different textures (e.g. `cobra_king` reuses the Jumbo model with
  `king_*_c`): the slot list must come from the vehicle's own `tankmodels` BLK texture overrides
  when it has them.
- Other vertex layouts than the two seen on the Jumbo (stride 16 and 20): unknown layouts fail
  with "format not recognised" rather than guessing.
