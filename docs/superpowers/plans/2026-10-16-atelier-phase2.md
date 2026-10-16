# Atelier Phase 2 Implementation Plan (images, text, mirror, background removal)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** projected image and text layers placed by clicking on the 3D model and edited with handles; Mirror to the other side; Remove background (isnet-anime through ONNX Runtime, downloaded on first use) and Refine edge.

**Architecture:** Rust imports pictures into the project's `assets/` (`image` crate), lists Windows fonts, downloads and verifies the ONNX runtime and the model (own allowlisted HTTPS client, in-house SHA-256), loads the runtime safely and runs the cutout with `ort` (load-dynamic, telemetry off). The frontend adds `image`/`text` layers, places a decal box from a raycast, edits it with a gizmo, and the Baker composites decals in premultiplied space between the base and a final detail/mask pass, with a mirrored copy and a per-slot overlap map that disables Mirror where both sides share texels.

**Tech Stack:** as the MVP, plus `image` 0.25 (Rust, `default-features = false, features = ["png","jpeg","webp","bmp","tga"]`), `ort` 2.0.0-rc.14 (Rust, `default-features = false, features = ["std", "load-dynamic"]`, no `ndarray`, no `download-binaries`), ONNX Runtime (Microsoft, MIT, downloaded at runtime), isnet-anime.onnx (SkyTNT anime-segmentation, Apache-2.0, distributed by rembg; downloaded at runtime). Approved by the author on 2026-10-16. **No other new crate**: Windows API calls needed for safe DLL loading are declared with `extern "system"` FFI against kernel32 (std only).

**Spec:** [2026-10-16-atelier-skin-creator-design.md](../specs/2026-10-16-atelier-skin-creator-design.md) §1 (Cutout, Commands), §2 (Layers, Projection, Bake, Mirror, Refine edge). Conventions: the header of [2026-10-16-atelier-mvp.md](2026-10-16-atelier-mvp.md) (strings as you go in nine languages, local-only docs, shared test builders, commands, gotchas, `git add` only own files, no attribution trailers) all apply.

**Toolchain:** `ort` rc.14 needs Rust 1.92 (edition 2024). Bump `rust-version` in `src-tauri/Cargo.toml` to `1.92`; record it in DESIGN_NOTES and HANDOFF (CLAUDE.md is the author's file: mention the needed update in HANDOFF instead of editing it).

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/atelier/assets.rs` (new) | Import pictures, read/write assets as raw RGBA, asset ids, GC on editor open. |
| `src-tauri/src/atelier/fonts.rs` (new) | Windows fonts from the registry, font file bytes (whitelist only). |
| `src-tauri/src/atelier/sha256.rs` (new) | In-house SHA-256 (streaming), NIST vectors. |
| `src-tauri/src/atelier/download.rs` (new) | Allowlisted HTTPS blocking client, streamed download with hash, cancel, single-flight. |
| `src-tauri/src/atelier/models.rs` (new) | Pinned table (URLs, sizes, hashes), status, install (zip extract), remove (pending delete). |
| `src-tauri/src/atelier/cutout.rs` (new) | Safe DLL preload (FFI), ort environment (telemetry off), session cache, pre/post-processing, run, cancel. |
| `src-tauri/src/atelier/mod.rs` | New commands and state. |
| `src/atelier/project.ts`, `editorStore.ts` | Image/text layers, decal type, add/delete/duplicate/reorder, pending placement. |
| `src/atelier/decal.ts` (new) | Pure decal maths (frame from hit, matrices, facing, mirror, texel density). |
| `src/atelier/text.ts` (new) | Text rasteriser (FontFace from bytes, outline, skew, measured aspect). |
| `src/atelier/gl/shaders.ts`, `gl/baker.ts` | Decal passes, intermediate target, final pass, mirror, overlap map, `whenReady()`. |
| `src/atelier/gl/decalTextures.ts` (new) | Decal texture cache (ImageBitmap, preview-capped size, lifetime). |
| `src/screens/Atelier/*` | Layers panel (add/delete/duplicate/reorder), properties, placement + gizmo, input modes, download dialog, Refine edge dialog. |
| `src/screens/Settings/ExperimentalSection.tsx`, `LicensesDialog.tsx`, About privacy | Model size + Remove, "Downloaded on demand" licences, privacy text. |
| `src/dev/mockAtelier.ts` | Mock for every new command. |
| `src/i18n/*.json` | Strings (nine languages). |

---

## Chunk A: Rust

### Task P1: Assets and fonts

**Files:** `atelier/assets.rs`, `atelier/fonts.rs`, `atelier/mod.rs`, `Cargo.toml` (`image` as above), tests `tests/atelier_assets.rs`, `tests/atelier_fonts.rs`.

```rust
pub struct AssetRef { pub id: String, pub width: u32, pub height: u32 } // camelCase serde
pub fn import(project_dir: &Path, source: &Path) -> AppResult<AssetRef>;
pub fn read_rgba(project_dir: &Path, id: &str) -> AppResult<(u32, u32, Vec<u8>)>;
pub fn write_rgba(project_dir: &Path, w: u32, h: u32, rgba: &[u8]) -> AppResult<AssetRef>;
pub fn gc(project_dir: &Path, referenced: &HashSet<String>, created_this_session: &HashSet<String>) -> usize;
pub fn is_asset_id(id: &str) -> bool; // exactly the new_id_with("img") format
```
- **Import** (`atelier_import_image(projectId, path)`): reject non-absolute paths, UNC/device paths (`\\server\…`, `\\?\`, `\\.\`), non-files, extensions outside png/jpg/jpeg/webp/bmp/tga, files > 64 MiB. Read dimensions first (`image::ImageReader::with_guessed_format()?.into_dimensions()`) → > 16384 on a side → `IMAGE_TOO_LARGE`; then decode with `Limits { max_alloc: Some(1 GiB) … }`, apply EXIF orientation (`decoder.orientation()` + `apply_orientation`), convert to RGBA8 straight alpha, downscale to ≤ 4096 long side (first `imageops::thumbnail` to about 2×4096 when larger, then Lanczos3, so a 16384² picture never needs a ~1 GiB f32 intermediate), save `assets/<id>.png` atomically. Failure → `IMAGE_UNREADABLE`.
- **Read/write as raw RGBA** (not PNG through the frontend, so canvas premultiplication never destroys colour under alpha 0): `atelier_asset(projectId, assetId) -> Response` = `u32 w, u32 h` LE + RGBA; `atelier_asset_put(projectId, Request raw RGBA, headers x-width/x-height) -> AssetRef` (same checks as apply textures: sides ≤ 4096, length = w·h·4). Rust encodes the PNG.
- **GC**: `atelier_project_open(projectId)` (called by the editor when it opens a project; history is empty then) walks the saved `project.json` and keeps **every string value anywhere in it that matches `is_asset_id`** (image layers also carry `sourceAssetId` for Refine edge), and deletes `assets/*.png` not referenced and not in `AtelierState.created_assets` (ids created in this process). Returns nothing the UI needs. A layer whose asset is missing on load is kept with a warning flag in the frontend and skipped by the bake.
- **Fonts**: `atelier_fonts() -> Vec<FontInfo { family, style, file }>` re-reads `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` and `HKCU\…\Fonts` each call (winreg; non-Windows → empty), resolves relative names against `%WINDIR%\Fonts`, keeps existing `.ttf`/`.otf` (skip `.ttc`: FontFace loads face 0 only, which misnames families), parses `"Name Bold Italic (TrueType)"` into family + style. `atelier_font_file(family, style) -> Response`: looks up the entry in a fresh list (never takes a path), canonicalises, ≤ 32 MiB. Layers store `{ family, style }` (portable), not file names.
- Messages (nine languages): `IMAGE_UNREADABLE`, `IMAGE_TOO_LARGE`, `ASSET_NOT_FOUND`, `ASSET_INVALID`, `FONT_NOT_FOUND`.
- [ ] Tests: PNG/JPEG/WebP fixtures generated in the test with `image`; EXIF-rotated JPEG (write the orientation tag by hand or skip with a note if `image` can't write EXIF); UNC/device/relative paths refused; too-large via a crafted PNG header; RGBA round trip keeps RGB under alpha 0; GC keeps referenced and session-created ids; asset id format; font whitelist (no arbitrary path), registry parsing as a pure function with sample names. Commit `feat(atelier): image assets and Windows fonts`.

### Task P2: Downloads and model files

**Files:** `atelier/sha256.rs`, `atelier/download.rs`, `atelier/models.rs`, commands; tests `tests/atelier_sha256.rs`, `tests/atelier_download.rs` (local `TcpListener` HTTP server in the test serving bytes; the allowlist **and `https_only`** are relaxable for tests only via a `#[doc(hidden)]` constructor), `tests/atelier_models.rs`.

- **SHA-256**: streaming `Sha256::new/update/finalize`, NIST vectors ("", "abc", the 448-bit and 896-bit messages, one million 'a').
- **Client**: its own `reqwest::blocking::Client` (rustls, built lazily on the blocking thread like `wtlive::net::HttpTransport::client()`), https only, redirect policy allowing only `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` (and nothing else), user agent `Livery/<version>`, connect timeout 20 s, read (stall) timeout 60 s, no total timeout. Not the WT Live transport (its rate limiter, breaker and robots logic are WT Live's).
- **Download**: stream to `<models>/<name>.part`, hash while streaming, cap at the pinned size + 1 (`DOWNLOAD_FAILED` if exceeded or `received != total`), rename on hash match, delete on mismatch (`DOWNLOAD_CORRUPT`). Cancel flag checked between chunks (`DOWNLOAD_CANCELLED`). Single flight: a second download while one runs → `DOWNLOAD_BUSY`. Progress `atelier://download-progress { item: "runtime"|"model", received, total }`, throttled to ≤ 10/s. Gate on `atelierEnabled` (refuse when off).
- **Models dir**: `app_local_data_dir()/models` (Local, never Roaming); with `LIVERY_DATA_DIR` set, `<data>/models`.
- **Pinned table** (`models.rs`): `{ name, url, size, sha256 }` for the ORT zip and the model, plus the extracted DLL's `sha256`. Choose the ORT version: the newest Microsoft release `onnxruntime-win-x64-<ver>.zip` from `https://github.com/microsoft/onnxruntime/releases` that is ≥ 1.17 and at least two weeks old. Download it once now (approved), compute hashes, check `dumpbin /dependents` (or read the PE import table with a tiny script) for VC runtime dependencies and record them. Model URL `https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx` must hash to `f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99` (the local reference copy `%USERPROFILE%\.u2net\isnet-anime.onnx`, 176,069,933 bytes); if not, stop and report. Record date and source in a comment.
- **Install runtime**: verify the zip hash first, then extract only `lib/onnxruntime.dll` (and `onnxruntime_providers_shared.dll` if present and needed) with the existing `zip` crate into `<models>/ort-<ver>/`, verify the DLL hash.
- **Status/remove**: `atelier_cutout_status() -> CutoutStatus { runtime: bool, model: bool, bytes: u64, downloadBytes: u64 /* from the table */, pendingRemoval: bool }`. `atelier_cutout_remove()`: refuses while a download or a cutout runs (`CUTOUT_BUSY`); if the runtime was loaded in this process (the DLL can't be deleted while mapped), deletes what it can, writes `<models>/.remove` and reports `pendingRemoval: true`; a startup task purges a `.remove`-marked folder before anything loads it. **While `pendingRemoval` is set, downloads are refused** (`CUTOUT_RESTART_NEEDED`: "Restart Livery to finish removing the background-removal files"); the UI says so.
- Messages (nine languages): `DOWNLOAD_FAILED`, `DOWNLOAD_CORRUPT`, `DOWNLOAD_CANCELLED`, `DOWNLOAD_BUSY`, `CUTOUT_BUSY`, `CUTOUT_RESTART_NEEDED`.
- [ ] Tests: NIST vectors; local server: success, hash mismatch deletes `.part`, size overflow, short body, cancel, redirect to a non-allowlisted host refused, single flight; zip extraction picks only the DLL and verifies it; remove with pending marker; startup purge. Commit `feat(atelier): model downloads with pinned hashes`.

### Task P3: Cutout

**Files:** `atelier/cutout.rs`, commands; tests `tests/atelier_cutout.rs` (pure functions), ignored real test in `tests/atelier_real.rs`.

- **Safe load** (Windows): before `ort::init_from`, hash the DLL (every first load in a process), then preload it with `LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)` declared via `extern "system"` (`#[link(name = "kernel32")]`), so its dependencies resolve only from its own folder and System32; ort's later load by the same full path reuses that module. Load error 126 (missing dependency, e.g. VC runtime) → `CUTOUT_RUNTIME_MISSING_DEPS` with a clear message.
- **Environment**: `ort::init_from(dll)?` → `EnvironmentBuilder` → `.with_name("livery")` `.with_telemetry(false)` → `.build()` exactly once per process (`OnceLock`); a second need for a different DLL path in the same process → requires restart (documented).
- **Session**: `Session::builder(&env)?.with_intra_threads((available_parallelism()/2).clamp(1, 8))?.commit_from_file(model)?` (rc.14: `builder` takes the environment; `with_intra_threads` returns `Result<SessionBuilder, Error<SessionBuilder>>`, map it into `AppError`), cached in a `Mutex<Option<(Session, Instant)>>` (`run` takes `&mut self`), dropped after 5 minutes idle (timer checked on use and by a light background tick).
- **Pre/post** (pure, tested): resize to 1024² (bilinear or Lanczos3 via `image`), `(v/255 - mean) / 1.0`, NCHW f32 → `Tensor::from_array(([1, 3, 1024, 1024], data))`; output `outputs[0]` via `try_extract_tensor::<f32>()` → `(shape, &[f32])`, take the first 1024² plane, min-max normalise, resize to the source size, alpha = mask × source alpha; **source RGB kept untouched**; crop to the bbox of alpha > 20 **plus a 16 px margin** (clamped), never losing pixels inside the margin. The command returns the crop rect so the frontend can refit the decal.
- `atelier_cutout(projectId, assetId) -> CutoutResult { asset: AssetRef, crop: { x, y, w, h } }` (new asset; the original stays; crop in source pixels), progress `atelier://cutout-progress { step: "load"|"run"|"write" }`, cancel: keep an `Arc<RunOptions>` **outside** the session mutex and run with `session.run_with_options(inputs, &run_options)`; `atelier_cutout_cancel` calls `terminate()` without taking the session lock (it also cancels a running download). Never touches the network. Gated on `atelierEnabled`. Messages (nine languages): `CUTOUT_NOT_READY`, `CUTOUT_FAILED`, `CUTOUT_RUNTIME_MISSING_DEPS`.
- [ ] Tests: pre/post pure functions (normalisation values, NCHW layout, min-max, crop + margin, RGB preserved); ignored real test: copy the local model and the downloaded runtime into a temp models dir, cut out an anime picture (use `D:\Dev\Progetti\Livery-skin-lab\jumbo-megumin\` sources if an uncut one exists, else composite `megumin_isnet.png` over a flat background in the test) and check the alpha bbox covers the subject and the background goes transparent. Commit `feat(atelier): background removal with isnet-anime`.

---

## Chunk B: Frontend

### Task P4: Layer model and store

**Files:** `src/atelier/project.ts`, `editorStore.ts`, `src/queries/atelier.ts`, `src/dev/mockAtelier.ts`, tests.

```ts
type PartFilter = 'all' | 'hull' | 'turret' | 'gun';
interface Decal { center: Vec3; normal: Vec3 /* outward surface normal */; up: Vec3; width: number; height: number; depth: number /* box centred on the surface: ±depth/2 along normal */; part: PartFilter; mirror: boolean }
interface ImageLayer extends LayerCommon { kind: 'image'; assetId: string; decal: Decal; opacity: number; flipX: boolean;
  sourceAssetId?: string; sourceOffset?: { x: number; y: number; w: number; h: number } /* cutout crop inside the source, source px */ }
interface TextLayer extends LayerCommon { kind: 'text'; text: string /* ≤ 200 chars */; font: { family: string; style: string }; color: string; outlineColor: string; outlineWidth: number /* in em/100 */; skew: number /* -0.5..0.5 */; decal: Decal /* height = text size; width = height × measured aspect, written in the same store action as any text/font/skew/outline/size edit; refreshed silently (no history) when the real font finishes loading */; opacity: number }
```
- Store actions: `addDecalLayer(layer)` (inserted above the selected decal layer or just under the mask), `deleteLayer(id)`, `duplicateLayer(id)` (offset along the surface by 5% of height), `moveLayer(id, toIndex)` (Base stays first, mask last), `setDecal(id, patch, mergeKey)`, `setLayerProps(id, patch, mergeKey)`; all undoable. `applyCutout(layerId, asset, crop, sourceAsset)`: one undo step; switches `assetId`, sets `sourceAssetId`/`sourceOffset`, and refits the decal (keep model units per source pixel; new width/height from the crop; centre moved in decal space by the crop centre's offset from the source centre, image y down). **Pending placement** lives outside `layers` (`pending: { kind, assetId? , text? } | null`): no history, no autosave; the first placement click commits it as one undo step; Escape clears it.
- `checkLayers`/`validateLayers` accept image and text layers anywhere between Base and mask, keep their order, validate fields (clamp numbers, drop a decal with non-finite vectors → layer kept, flagged).
- Queries/mutations for every new command; large binary responses are not kept in the query cache (`gcTime: 0` for assets and fonts, consumers convert to ImageBitmap/FontFace and drop the bytes).
- Mock: import → generated picture (a gradient with a disc and a background), fonts → two families mapped to the self-hosted Geist/IBM Plex Mono bytes, status/download/cancel/remove with fake progress, cutout → disc-masked copy, `atelier_project_open` no-op, asset get/put raw RGBA.
- [ ] Tests: validation incl. order and clamping; store add/delete/duplicate/move + undo; pending placement (no history until placed, Escape no-op); mock parity. Commit `feat(atelier): image and text layers in the project model`.

### Task P5: Decal maths and text rasteriser (pure)

**Files:** `src/atelier/decal.ts`, `src/atelier/text.ts`, tests.
- `frameFromHit(point, normal, cameraMatrixWorld, sizeHint) → Decal`: `up` = camera screen-up (column 1 of `camera.matrixWorld`) projected onto the plane ⟂ normal and normalised; fallback when nearly parallel: world +y, then +x. `right = normalize(cross(up, normal))` (right-handed; the image's +u maps to `right`).
- `decalMatrix(decal)` (model → decal space: u along right, v along up, w along normal), `inBox`, `facing(n, decal) = dot(n, decal.normal) > 0.2 * |n|` (GLSL mirror).
- **Mirror** across the model's mirror plane (axis from the model header; z = 0): reflect `center` and `normal`, reflect `up`, and **recompute** `right = cross(up', normal')` so the frame stays right-handed: the copy then reads the right way round **without** flipping the image. Test: a texel at +u on the original appears on the viewer's right on both sides (looking at each side from outside).
- Default size: width = 25% of the model's bounding-box diagonal, height from the image aspect, depth = 10% of width (min 2 cm).
- Texel density for text resolution: `texelsPerUnit(slot, decal)` estimated from the triangles whose bounding sphere intersects the box (falling back to the hit triangle) (sum of UV area × slot pixels / sum of world area) — computed by the Baker helper from the model buffer; the rasteriser renders at `2 × texelsPerUnit × decal.height` px tall, clamped 64..4096.
- `text.ts`: `loadFont(family, style)` (bytes → `new FontFace(name, arrayBuffer)` → `document.fonts.add`, cached; fallback Geist + warning when missing), `measureText(layer) → aspect`, `rasterise(layer, pxHeight) → { rgba (straight alpha), w, h }` with outline (stroke under fill), skew (canvas transform), padding = outline width; read back with `getImageData` from a canvas created with `{ colorSpace: 'srgb' }`, un-premultiply is not needed because only RGB under alpha > 0 matters and the decal pass multiplies by alpha. Debounce re-rasterising during typing (150 ms).
- [ ] Tests: frame orthonormality and fallback; mirror reads correctly (the +u test); inBox/facing; default size; texel density on a synthetic quad; measure/rasterise with a stub canvas where possible. Commit `feat(atelier): decal maths and text rasteriser`.

### Task P6: Decals in the bake

**Files:** `src/atelier/gl/shaders.ts`, `gl/baker.ts`, `gl/decalTextures.ts`, tests.
- **Compositing scheme** (replaces the single paint pass):
  1. **Base pass** into a scratch **intermediate** RGBA8 target (premultiplied): colour = base (solid/camo), alpha = `uBaseAlpha` (0 when Base is hidden → the game's texture shows where no decal covers).
  2. **Decal passes** (one unwrapped draw per decal and per mirrored copy, in layer order) into the intermediate, premultiplied colour `rgb·a·opacity`, alpha `a·opacity`, blend `ONE, ONE_MINUS_SRC_ALPHA` for RGB and alpha. Fragment: transform `vPos` into decal space, skip outside the box or when not facing or when the part group doesn't match, sample the decal texture at `(u+0.5, 0.5-v)` (top-left image origin), `flipX` mirrors u.
  3. **Final pass** (unwrapped mesh, same size) reading the intermediate: `rgb = premul.rgb * detail`, `a = premul.a * (1 - mask)`; writes premultiplied output for preview targets, un-premultiplied (`rgb / max(a, ε)` where `a > 0`) for export targets.
  - One shared scratch intermediate keyed by exact (w, h) (preview sizes differ per slot), not one per slot.
  - Cull decal draws with the existing `triSphere` mechanism (sphere = decal box bounding sphere).
- **Decal textures** (`decalTextures.ts`): from asset RGBA bytes → `ImageData` → **premultiplied before mipmapping** (`createImageBitmap(…, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' })` or premultiply on the CPU), so the colours kept under alpha 0 by the cutout never bleed into edges through filtering; the decal shader then multiplies by opacity only; mipmapped, clamp-to-edge, `NoColorSpace` (sRGB numbers like the base); preview copies capped at 2048 on the long side; full size loaded only for export; ref-counted per asset id, disposed when unused; text layers keyed by content hash + raster size.
- **Readiness**: `baker.whenReady(): Promise<void>` resolves when every decal texture and font needed by the current layers is loaded (preview copies); `baker.prepareExport(): Promise<void>` loads the **full-size** decal textures (and text rasters at export resolution) and `baker.endExport()` releases them; `useApply` calls `prepareExport` before the per-slot bakes and `endExport` in `finally`; `setLayers` re-bakes when a texture finishes loading. `useApply` and the thumbnail await `whenReady()` before `bakeForExport` / thumbnail render; update `EngineBaker`/`EngineScene` types and stubs.
- **Overlap map** per slot (once per model): a count pass at 512² (R8, blend ADD, each triangle adds 1/255; sample-based rasterisation means count > 1 marks shared texels; tiny triangles below a texel are missed, acceptable for a hint). `decalTouchesSharedTexels(decal) → Promise<boolean>`: render the decal footprint × (count > 1) into a 128² target per slot it touches, read back, any non-zero → true. Called at gesture end only (not every move).
- [ ] Tests: pass ordering and blend states; hidden base + decal gives alpha only where the decal covers; a red background under alpha 0 in a decal image does not tint edge texels; un-premultiply on export; cache ref-counting/disposal; whenReady behaviour; overlap logic with a fake readback. Real-WebGL check in the mock (a decal on the cube crossing two faces, mirrored copy on the opposite face, a hidden base, readback equals a TS reference on sample texels). Commit `feat(atelier): projected decals, mirror and shared-texel check in the bake`.

### Task P7: Editor UI

**Files:** `src/screens/Atelier/{LayersPanel,PropertiesPanel,Viewport,Editor}.tsx`, new `DecalGizmo.tsx`, `CutoutDownloadDialog.tsx`, `RefineEdgeDialog.tsx`, `src/screens/Settings/ExperimentalSection.tsx`, `LicensesDialog.tsx`, About privacy text, i18n, tests.
- **Layers panel**: Add image (Tauri: `@tauri-apps/plugin-dialog` `open` with filters png/jpg/jpeg/webp/bmp/tga; mock: a hidden `<input type=file>` whose file bytes go to the mock import), Add text; per-layer menu Duplicate / Delete (undoable via Ctrl+Z; a toast "Layer deleted" with Undo), drag and keyboard (Alt+↑/↓) reorder between Base and mask; missing-asset/font warning icons with a tooltip.
- **Placement**: a new layer enters place mode (`aria-live` announcement + cursor hint); click on the model places it; Enter places at the centre of the view (raycast through the centre); Escape cancels.
- **Gizmo** (selected decal): an outline of the box projected on screen, a body drag that slides the centre along the surface (re-raycast under the pointer, normal and up re-derived), corner handles scale keeping the ratio (Shift frees it), a rotate handle (rotates `up` around `normal`), depth via the properties slider and Alt+wheel. **Input modes**: with a decal selected, arrow keys nudge (Shift+arrows rotate, +/− scale) and orbiting moves to Alt+arrows / right drag; without a decal selected the MVP bindings stay. Each gesture is one undo step (`mergeKey` + `endGesture`).
- **Properties**: image: opacity, flip, Only this part (`PartFilter`), Mirror (off by default; disabled with the shared-texture hint when `decalTouchesSharedTexels`), Remove background, Refine edge; text: text (≤ 200 chars), font family/style pickers from `atelier_fonts`, colour, outline colour/width, skew, opacity, Only this part, Mirror.
- **Remove background**: status → if not ready, `CutoutDownloadDialog` (what: ONNX Runtime by Microsoft and the isnet-anime model by SkyTNT via the rembg project, from GitHub; size from `downloadBytes`; stored on this PC, pictures never leave it; Download / Cancel) → progress with Cancel → cutout progress with Cancel → `applyCutout` (one undo step: new asset, source kept, decal refitted so the picture stays where it was). While `pendingRemoval` is set the dialog says "Restart Livery first" instead of downloading.
- **Refine edge** dialog: the asset on a checkerboard with zoom; erase/restore brush on alpha only (restore brings back the original alpha of the asset the cutout came from: the layer's `sourceAssetId` + `sourceOffset` let restore read the true RGB/alpha of the source pixels under each cutout pixel; Refine on a non-cutout image restores to its own original); Apply saves a new asset via `atelier_asset_put` (raw RGBA), one undo step.
- **Settings → Experimental**: when downloaded, "Background removal files: 190 MB" (from status) and a Remove button (confirm dialog, not an undoable toast: the files can be downloaded again; record in DESIGN_NOTES), disabled while busy; after a remove that needs a restart, a note "Finishes the next time Livery starts".
- **About**: privacy text updated in nine languages (Livery also downloads, only on request, the background-removal files from GitHub; pictures stay on the PC); Licenses dialog: a "Downloaded on demand" group with ONNX Runtime (MIT) and isnet-anime (Apache-2.0, SkyTNT anime-segmentation); `pnpm notices` for `image` and `ort`.
- [ ] Tests (stubbed engine): add image → place (click and Enter) → nudge/rotate/scale by keyboard → undo each; text edit re-rasterises (debounced); mirror disabled when shared; delete/duplicate/reorder + undo; remove-background flow (download consent, progress, cancel, success); refine edge saves a new asset; Settings remove (busy, pending removal); axe on the editor, dialogs and settings. Visual check in the mock at 1440×900 and 1100×700. Commit `feat(atelier): images, text, mirror and background removal in the editor`.

### Task P8: Audit, docs, acceptance

- [ ] i18n audit (nine languages, natural Italian, no em dashes); `settings.general.keys.sections` mentions 6 when Atelier is on; README features + privacy paragraph (public file: no internal doc references); DESIGN_NOTES rows for Phase 2 (main checkout, local only): versions and hashes, DLL loading, telemetry off, models dir, remove semantics, text sizing, mirror convention, compositing scheme, asset GC; `docs/wtlive-terms.md` §8 subsection (local only); HANDOFF notes (Rust 1.92, CLAUDE.md stack line to update).
- [ ] Full checks: `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm build` + dist grep (three and the editor in their own chunk), `cargo test`, clippy 1.94 and `+1.99.0`, fmt, `pnpm notices`.
- [ ] Real app on the scratch game root (junctions to `content`/`content.hq`, copied archives, empty `UserSkins`, scratch `LIVERY_DATA_DIR`; the real game folder stays untouched): Jumbo, camo base, an anime picture with a background → Remove background (real download once, then cutout) → placed on the glacis, "EXPLOSION!" on a hull side with Mirror, stowage protected, Apply; decode the body DDS and compare with the 3D view; timings (download, cutout, apply); console and log clean.
