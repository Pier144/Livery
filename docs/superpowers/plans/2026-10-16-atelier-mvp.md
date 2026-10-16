# Atelier MVP (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 of Atelier: pick a ground vehicle, see it in 3D with its original textures read from the game's packs, paint a base colour or camo, protect areas with a brush, and apply the result to the game as an installed skin.

**Architecture:** Rust reads the vehicle's model (GRP2 + DynModel + GeomNodeTree), its materials (`dynModelDesc.bin`) and its `_c` textures (DxP2, Oodle via `oozextract`) and serves them as raw binary through `tauri::ipc::Response`. The frontend draws the model with three.js and bakes every enabled texture slot on the GPU by rendering the mesh unwrapped in UV space (base colour or 3D-noise camo, multiplied by the template's detail map, protected-area mask into alpha). Apply sends each baked slot back as a raw request body; Rust encodes DXT5 DDS, writes the `.blk` and installs through a new library entry point that keeps the skin's id across replaces.

**Tech Stack:** Rust (Tauri 2, `oozextract`, `texpresso`, existing `zstd`), React 18 + TypeScript, three.js, Zustand, TanStack Query, react-i18next, Vitest + RTL, cargo test.

**Spec:** [docs/superpowers/specs/2026-10-16-atelier-skin-creator-design.md](../specs/2026-10-16-atelier-skin-creator-design.md). Format notes: [2026-10-16-atelier-phase0-formats.md](../specs/2026-10-16-atelier-phase0-formats.md). Read both first. Phase 0 spike scripts (Python, reference only): `C:\Users\piera\AppData\Local\Temp\claude\D--Dev-Progetti-Livery\f0929977-7776-4221-ba0c-79874e5498b5\scratchpad\spike\scripts\` (`dynmodel.py`, `export_obj.py`, `dxp.py`, `blk.py`, `map_vehicle.py`).

**Not in this plan (Phase 2/3):** image and text layers, Mirror, Refine edge, background removal (`ort`, `image`, model download, in-house SHA-256), fonts. Their dependencies are NOT added now.

**Repo conventions (CLAUDE.md, binding):** Tailwind tokens only (no hex in components), all strings via `t()` in nine languages (en, it, de, ru, fr, es, pl, pt-BR, zh-CN; hand-translated, no English copies, no em dashes), Lucide icons `size={14}` in controls / `16` in nav, `strokeWidth={1.75}`, no spinners (Skeleton), `motion-safe:` for animation, commands return `Result<T, AppError>`, `AppError` messages are `pub const` with unique names and must appear under `common.errors.backend` in all nine `src/i18n/*.json` (guard in `src/lib/errors.test.ts`). Dependencies approved for this plan: `oozextract`, `texpresso` (Rust), `three` + `@types/three` (npm). Nothing else.

**Strings as you go:** every task that first **uses** a Rust `AppError` message const in an `AppError::new` (the guard also fails on messages no code sends) or adds a `t(…)` key adds it to all nine `src/i18n/*.json` files in the same task (`src/lib/errors.test.ts` and the typed `t()` keys break otherwise). Task 22 only audits.

**Local-only docs:** `DESIGN_NOTES.md` and `docs/wtlive-terms.md` are gitignored and do not exist in the worktree: edit them at `D:\Dev\Progetti\Livery\DESIGN_NOTES.md` and `D:\Dev\Progetti\Livery\docs\wtlive-terms.md` (never `git add`).

**Shared test builders:** encoders used by more than one test file (BLK, vromfs, GRP, DynModel, DxP2 builders) live in `src-tauri/tests/common/` (`mod common;`), not copied.

**Commands to know** (run from the worktree root `D:\Dev\Progetti\Livery\.claude\worktrees\atelier`):
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml --test <file>`; all: `cargo test --manifest-path src-tauri/Cargo.toml`; `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`; also `cargo +1.99.0 clippy ...` before the final commit (CI runs newer clippy); `cargo fmt --manifest-path src-tauri/Cargo.toml`.
- Real-install tests (ignored, read-only): `cargo test --manifest-path src-tauri/Cargo.toml --test atelier_real -- --ignored --nocapture`. Game root: `D:\SteamLibrary\steamapps\common\War Thunder` (env `LIVERY_REAL_GAME` overrides). Never write to the game folder.
- Frontend: `pnpm test -- <path>`, `pnpm typecheck`, `pnpm i18n:check`, `pnpm build` (then grep `dist/` for `mockCall|mockListen|livery.mock`: must find nothing), `pnpm dev:mock`.
- Gotchas (HANDOFF.md): write Rust/TS containing backslashes with the Write/Edit tools, not shell heredocs; commit messages via `git commit -F - <<'EOF'`; normalise CRLF before multi-line Edits; tests that mock `@/lib/tauri` override `isTauri`, `hasBackend`, `call`.

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/game/binblk.rs` | Fix kind numbering to Dagor's `blk_shared.h` (1 to 5), support fat+zstd. |
| `src-tauri/src/game/gameres/mod.rs` (new) | Module root, error messages, `GameResError` helpers. |
| `src-tauri/src/game/gameres/bytes.rs` (new) | Bounds-checked little-endian reader, `PatchableTab`, C strings. |
| `src-tauri/src/game/gameres/codec.rs` (new) | IGenLoad block (`tag/size`), Oodle (`oozextract`) and zstd decoding. |
| `src-tauri/src/game/gameres/grp.rs` (new) | GRP2 header, name map, resource table, resource byte ranges. |
| `src-tauri/src/game/gameres/meshopt.rs` (new) | meshoptimizer index-sequence decoder. |
| `src-tauri/src/game/gameres/dynmodel.rs` (new) | DynModel: matVdata, LOD 0 rigids/elems, node names, unpacked vertices. |
| `src-tauri/src/game/gameres/skeleton.rs` (new) | GeomNodeTree: node names, parents, model-space matrices. |
| `src-tauri/src/game/gameres/desc.rs` (new) | `dynModelDesc.bin`: per model texture list and `matR` → `t0` diffuse. |
| `src-tauri/src/game/gameres/dxp.rs` (new) | DxP2 directory, DDSx headers, top-level texture bytes. |
| `src-tauri/src/game/gameres/index.rs` (new) | Vehicle → model, model → `.grp`, texture → `.dxp.bin` (from `grp_hdr.vromfs.bin`), cached per game version. |
| `src-tauri/src/game/gameres/assemble.rs` (new) | `VehicleModel`: parts (hull/turret/gun), slots, right-handed buffers, binary encoding. |
| `src-tauri/src/textures/bc.rs` (new) | DXT1/DXT5 decode, DXT5 encode (`texpresso`). |
| `src-tauri/src/textures/dds.rs` (new) | DDS writer (DXT5, no mips). |
| `src-tauri/src/archive/generated.rs` (new) | `install_generated` (Replace keeps id / New with `(2)` rule). |
| `src-tauri/src/atelier/mod.rs` (new) | State, commands, events. |
| `src-tauri/src/atelier/project.rs` (new) | Project store: envelope validation, atomic save, trash, thumbnails. |
| `src-tauri/src/atelier/apply.rs` (new) | Apply lifecycle (begin, texture, commit, cancel), `.blk` writer. |
| `src-tauri/src/model.rs`, `settings.rs`, `lib.rs` | Types, `atelier_enabled`, registration. |
| `src-tauri/tests/gameres_*.rs`, `atelier_*.rs`, `textures_bc.rs`, `install_generated.rs`, `game_catalog.rs` | Tests (synthetic fixtures built in code; game files never committed). |
| `src/lib/tauri.ts` | `callRaw` (raw request body + headers). |
| `src/types.ts` | Atelier types. |
| `src/queries/atelier.ts` (new) | Query and mutation hooks. |
| `src/atelier/modelBuffer.ts` (new) | Parse the model binary into typed arrays. |
| `src/atelier/project.ts` (new) | Layer types, defaults, load validation. |
| `src/atelier/editorStore.ts` (new) | Zustand editor store: layers, selection, 100-step history. |
| `src/atelier/detailMap.ts` (new) | Detail factor map from a template (pure, box-blur Gaussian). |
| `src/atelier/dilate.ts` (new) | Edge dilation of a baked slot (pure). |
| `src/atelier/gl/shaders.ts` (new) | GLSL: unwrapped bake, 3D value noise camo, mask stamping. |
| `src/atelier/gl/baker.ts` (new) | Render targets per slot, bake passes, mask replay, read-back. |
| `src/atelier/gl/scene.ts` (new) | three.js scene, camera, orbit, quick views, raycast. |
| `src/components/VehiclePicker.tsx` (new) | Controlled vehicle autocomplete extracted from Explore's `VehicleInput`. |
| `src/screens/Explore/VehicleInput.tsx` | Becomes a thin wrapper over `VehiclePicker`. |
| `src/screens/Atelier.tsx`, `src/screens/Atelier/*` (new) | Home, new-project dialog, editor (top bar, layers, viewport, properties, apply). |
| `src/screens/Settings/ExperimentalSection.tsx` (new), `settingsUi.ts`, `Settings.tsx` | Experimental section with the Atelier switch. |
| `src/types.ts` (`Section`), `App.tsx`, `components/chrome/Sidebar.tsx`, `hooks/useKeyboardShortcuts.ts`, `components/chrome/paletteItems.ts` | Navigation entry shown only when `atelierEnabled`. |
| `src/dev/mockBackend.ts`, `src/dev/mockAtelier.ts` (new) | Mock commands: a cube model with three slots, projects, apply. |
| `src/i18n/*.json` | `atelier.*`, `settings.experimental.*`, `common.nav.atelier`, backend errors. |
| `DESIGN_NOTES.md`, `docs/wtlive-terms.md` §8 | Decisions and terms (local-only files: never `git add` them). |

---

## Chunk 1: Reading the game's packs (Rust)

### Task 1: Dependencies and module skeleton

**Files:** Modify `src-tauri/Cargo.toml`, `src-tauri/src/game/mod.rs`; create `src-tauri/src/game/gameres/mod.rs`, `bytes.rs`.

- [ ] **Step 1:** Add to `[dependencies]` (comment each like the existing ones):
```toml
# Oodle (Kraken/Leviathan) decompressor, MIT, pure Rust: the game's models and textures are Oodle streams (Atelier).
oozextract = { version = "0.5.5", default-features = false }
# DXT5 (BC3) encoder, MIT: Atelier writes the painted textures as DDS.
texpresso = "2"
```
Run `cargo tree --manifest-path src-tauri/Cargo.toml -e normal -i oozextract` and check no new transitive dependency with a non-permissive licence; then `pnpm notices` (cargo-about) and confirm both appear in the generated notices without errors.

- [ ] **Step 2:** `game/mod.rs`: `pub mod gameres;`. `gameres/mod.rs`:
```rust
//! Read-only readers of War Thunder's game-resource packs (Atelier): models (`.grp`), their
//! materials (`dynModelDesc.bin`) and textures (`.dxp.bin`). Formats follow the Dagor Engine
//! sources Gaijin published under BSD-3; see docs/superpowers/specs/2026-10-16-atelier-phase0-formats.md.
//! Everything is bounds-checked: a damaged or changed file is a `parse` error, never a panic.

pub mod assemble;
pub mod bytes;
pub mod codec;
pub mod desc;
pub mod dxp;
pub mod dynmodel;
pub mod grp;
pub mod index;
pub mod meshopt;
pub mod skeleton;

use crate::error::{AppError, ErrorCode};

/// A pack or model that can't be read (format changed or file damaged).
pub const MODEL_UNREADABLE: &str = "This vehicle's 3D model can't be read";
/// The vehicle has no model Livery can find in the game's files.
pub const MODEL_NOT_FOUND: &str = "This vehicle's 3D model isn't in the game's files";
/// A texture named by the model's materials isn't in any texture pack.
pub const TEXTURE_NOT_FOUND: &str = "A texture of this vehicle isn't in the game's files";

pub(crate) fn bad(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Parse, MODEL_UNREADABLE).with_detail(detail.into())
}
```
(Stub the other modules with an empty doc comment so it compiles; each task fills one.)

- [ ] **Step 3:** `bytes.rs`: a cursor over `&[u8]` with `u8/u16/u32/i32/u64/f32` reads at absolute offsets and sequentially, `slice(at, len)`, `cstr(at)` (NUL-terminated, lossy UTF-8, max 4096 bytes), and `tab(at) -> (u32 ofs, u32 count)` for a 16-byte PatchableTab. Every read returns `AppResult` via `bad("…")` on overflow (`checked_add`). Unit tests in the same file (`#[cfg(test)]`): reads at the end, one past the end, overflowing `at + len`, `cstr` without NUL.

- [ ] **Step 4:** `cargo test --manifest-path src-tauri/Cargo.toml gameres::bytes` passes; clippy clean. Commit `feat(atelier): game-resource module skeleton and dependencies`.

### Task 2: Fix binary BLK kinds (Dagor numbering)

Real files (checked 2026-10-16): `char.vromfs.bin` BLKs start with byte 4 (20 files) or 3 (1); `aces.vromfs.bin` BLKs with 5 (24,169) or 3 (1,897); `dynModelDesc.bin` with 2. Dagor `blk_shared.h`: 1 fat, 2 fat+zstd (`u24` packed size then a zstd frame whose content starts with byte 1), 3 slim, 4 slim+zstd, 5 slim+zstd+dictionary. Livery's current 0..4 numbering works on `wpcost` only because a dictionary passed to a frame that doesn't use one is harmless.

**Files:** Modify `src-tauri/src/game/binblk.rs` (doc table and `Blk::parse`), `src-tauri/tests/game_catalog.rs`.

- [ ] **Step 1: Failing tests** in `tests/game_catalog.rs` using the existing encoders (`slim_blk`, `uleb`): a kind-3 slim BLK (raw, no zstd) parses; a kind-4 slim BLK (zstd) parses (today's test bytes already use 4: keep it); a kind-5 BLK compressed with a zstd dictionary built in the test (`zstd::dict::from_samples` over a few slim bodies, then `zstd::bulk::Compressor::with_dictionary`) parses when the dictionary is passed and fails cleanly without it; a fat kind-1 BLK (write a `fat_blk(root, names)` encoder: `uleb count, uleb size, NUL-joined names`, then the same body as slim) parses; a kind-2 BLK = `[2] + u24(len) + zstd([1] + fat body)` parses; kinds 0 and 6 are parse errors (`not a binary BLK`).
- [ ] **Step 2:** Run, see the new ones fail.
- [ ] **Step 3:** Implement in `Blk::parse`:
```rust
let body: Vec<u8> = match kind {
    1 | 3 => rest.to_vec(),
    4 | 5 => unzstd(rest, if kind == 5 { dict } else { None }, MAX_BLK)?,
    2 => {
        // u24 packed size, then one zstd frame holding a kind-1 file.
        let size = rest.get(..3).map(|b| u32::from_le_bytes([b[0], b[1], b[2], 0]) as usize).ok_or_else(|| bad("truncated"))?;
        let frame = rest.get(3..3 + size).ok_or_else(|| bad("truncated"))?;
        let inner = unzstd(frame, None, MAX_BLK)?;
        return Self::parse(&inner, shared, dict);
    }
    other => return Err(bad(format!("not a binary BLK (kind {other})"))),
};
let slim = kind >= 3;
```
Guard the recursion: the inner file must start with 1 (`bad("nested packed BLK")` otherwise). Update the module doc table to the Dagor numbers. `NameMap::parse` is unchanged (it is a different format).
- [ ] **Step 4:** All `game_catalog` tests pass; run the ignored `game_catalog_real` test by hand (`--ignored`) and confirm the real vehicle count is unchanged (3,383 on 2026-10-15 ± game updates). Commit `fix(game): binary BLK kinds follow Dagor's numbering; fat+zstd and dictionary kinds`.

### Task 3: Block codec (zstd / Oodle)

**Files:** `src-tauri/src/game/gameres/codec.rs`; test `src-tauri/tests/gameres_codec.rs`.

API:
```rust
/// Compression of an IGenLoad block (`u32 L`: tag = L >> 30, size = L & 0x3FFF_FFFF).
pub enum Tag { None, Zstd, Oodle }
/// Reads one block at `cur`'s position: returns the unpacked bytes. OODLE: `u32 rawSize` then
/// `size - 4` bytes of stream; ZSTD: one frame of `size` bytes; NONE: `size` raw bytes.
pub fn read_block(cur: &mut Reader, max: usize) -> AppResult<Vec<u8>>;
/// A bare Oodle stream of known unpacked length (DxP2 textures).
pub fn oodle(src: &[u8], raw_len: usize, max: usize) -> AppResult<Vec<u8>>;
/// One zstd frame, at most `max` bytes.
pub fn zstd(src: &[u8], max: usize) -> AppResult<Vec<u8>>;
```
`oodle` uses `oozextract::Extractor::new().read_from_slice(src, &mut out)` with `out = vec![0; raw_len]` and fails with `bad` unless it returns exactly `raw_len`. Reject `raw_len > max` before allocating (max 256 MiB for vertex data, 128 MiB for one texture level).

- [ ] **Step 1: Failing tests:** zstd round trip (compress in the test with the `zstd` crate); a NONE block; a block whose size runs past the end → parse error; `raw_len > max` → error without allocation. Oodle has no open encoder and Livery never loads game code, so `oodle` is tested for correctness only by the ignored real-install test (Task 9); here, garbage input must return a parse error, never panic (a 64-byte pseudo-random buffer with `raw_len` 1024, and a truncated real-shaped header). Note the release profile uses `panic = "abort"`, so `catch_unwind` can't rescue a panic in production: if a test shows `oozextract` panicking on bad input, report it (an upstream fix or a pre-check is then needed) rather than wrapping it.
- [ ] **Step 2-4:** Implement, pass, commit `feat(atelier): pack block codec (zstd, Oodle via oozextract)`.

Verified on 2026-10-16: `oozextract` 0.5.5 decodes the Jumbo's vertex block (1,021,269 → 3,820,392 bytes) and body texture (2,617,968 → 4,194,316) byte-identical to the game's own Oodle DLL, in 10 to 18 ms.

### Task 4: GRP2 reader

**Files:** `src-tauri/src/game/gameres/grp.rs`; test `src-tauri/tests/gameres_grp.rs` (synthetic pack built by a `grp_bytes(resources: &[(class_id, name, data)])` helper in the test file).

Format (formats doc §1): 16-byte header `"GRP2"|"GRP3"`, `u32 descOnlySize`, `u32 fullDataSize`, `u32 restFileSize (= file size - 16)`; at 0x10 three PatchableTabs (nameMap of `i32` absolute offsets of NUL-terminated names, resTable of 12-byte `ResEntry {u32 classId, u32 offset, u16 nameIdx, u16 reserved}`, resData ignored). A resource spans `[offset, next non-zero offset in file order)`, the last to EOF.

API:
```rust
pub const DYN_MODEL: u32 = 0xB4B7_D9C4;
pub const GEOM_NODE_TREE: u32 = 0x56F8_1B6D;
pub struct GrpResource { pub class_id: u32, pub name: String, pub start: usize, pub end: usize }
pub struct Grp { pub resources: Vec<GrpResource> }
impl Grp {
    /// From the header part (a `.grpcache.bin` copy or the file's first `fullDataSize + 16` bytes);
    /// `file_len` closes the last range (pass `None` for a cache copy: ranges then end at `start`).
    pub fn parse(head: &[u8], file_len: Option<usize>) -> AppResult<Self>;
    pub fn find(&self, name: &str, class_id: u32) -> Option<&GrpResource>;
}
```
- [ ] Tests: two resources parse with names, classes and ranges; `find` by name+class; wrong magic, truncated header, name index out of range, offset past EOF → parse errors; `GRP3` accepted. Implement, pass, commit `feat(atelier): GRP2 pack reader`.

### Task 5: meshoptimizer index-sequence decoder

**Files:** `src-tauri/src/game/gameres/meshopt.rs` (+ unit tests in-file).

```rust
/// meshoptimizer `meshopt_decodeIndexSequence` (MIT): byte 0 = 0xD0 | version (0 or 1); per
/// index one vbyte `v` (7 bits per byte, high bit = more, at most 5 bytes); `cur = v & 1;
/// v >>= 1; d = (v >> 1) ^ -(v & 1); idx = last[cur] + d; last[cur] = idx`; the stream ends
/// with 4 zero bytes and decoding must stop exactly at `len - 4`.
pub fn decode_index_sequence(buf: &[u8], count: usize) -> AppResult<Vec<u32>>;
```
Use wrapping arithmetic on `u32`. Tests: encode in the test with a tiny encoder that mirrors the rules (zig-zag delta against `last[0]`, `cur = 0`) for `[0,1,2,2,1,3,100000,5]`, decode equals; bad header byte, truncated stream, tail not reached, vbyte longer than 5 → errors. Commit `feat(atelier): meshoptimizer index decoder`.

### Task 6: DynModel reader

**Files:** `src-tauri/src/game/gameres/dynmodel.rs`; test `src-tauri/tests/gameres_dynmodel.rs` with a builder that writes a minimal DynModel (one vdata, stride 16 layout, block tag NONE, one LOD, one rigid, one elem) following formats doc §2/§2a exactly.

Reference implementation: spike `dynmodel.py` (`parse_dynmodel`, `load_matvdata`) and `export_obj.py` (`decode_vdata`). Port faithfully; differences from the spike: accept block tag NONE too (`matVdataHdrSz & 0xE0000000 == 0xC0000000` → block; any other top bits → `bad("vertex data packing {hex}")`), and only LOD 0 is kept (still walk all LOD scene dumps sequentially only as far as needed: LOD 0's scene and meshes come first).

API:
```rust
pub struct Elem { pub mat: u32, pub vdata: u32, pub si: u32, pub numf: u32, pub base_vertex: i32 }
pub struct Rigid { pub node_id: i32, pub elems: Vec<Elem> }
pub struct Vdata { pub positions: Vec<[f32; 3]>, pub normals: Vec<[f32; 3]>, pub uvs: Vec<[f32; 2]>, pub indices: Vec<u32> }
pub struct DynModel {
    pub node_names: HashMap<i32, String>, // nodeId -> name, from the names dump's `id` table
    pub rigids: Vec<Rigid>,               // LOD 0
    pub vdata: Vec<Vdata>,                // only the vdata LOD 0 elems reference are decoded; others empty
}
pub fn parse(res: &[u8]) -> AppResult<DynModel>;
```
`VdataHdr` (32 bytes): `vertNum = u32`, `w1 = u32` (`stride = w1 & 0xFF`, `packedLo = w1 >> 8`), `w2 = u32` (`idxSize = w2 & 0x0FFF_FFFF`, `packedHi = w2 >> 28`, packed IB size = `packedLo | packedHi << 24`), `flags = u32`, then the vDecl PatchableTab. VB/IB data starts at `matVdataHdrSz` (low 30 bits) in the unpacked buffer, vdata after vdata (VB `vertNum*stride`, then IB). Decoding (§2a): POS `SHORT4N` → `xyz = s / 32767 * bpC255.xyz + bpC254.xyz`; NORM `E3DCOLOR` bytes B,G,R,A → `(R,G,B)/255*2-1`; TC usage 3 index 0 `SHORT2` → `/4096`. Attributes packed in vDecl order with sizes from the VSDT table (`FLOAT1 4, FLOAT2 8, FLOAT3 12, FLOAT4 16, E3DCOLOR 4, UBYTE4 4, SHORT2 4, SHORT4 8, SHORT2N 4, SHORT4N 8, USHORT2N 4, USHORT4N 8, UDEC3 4, DEC3N 4, HALF2 4, HALF4 8, INT1/UINT1 4`); a vdata needed by LOD 0 without POS SHORT4N, NORM E3DCOLOR or TC0 SHORT2 → `bad("vertex layout …")`. Indices: `flags & 0x200` packed (`meshopt::decode_index_sequence`, count = `idxSize / isz`), else raw u16/u32; `isz = 4` if `flags & 0x40` or (`vertNum > 65536` and not `flags & 0x20`), else 2. Assert the vdata section consumes the unpacked buffer exactly. `texCount != -1`: skip the inline TexStr (`i32 sz` + bytes) — not seen on tanks. Skinned meshes after the rigids are ignored (stop after LOD 0's meshes).

Limits: at most 64 vdata, 4,000,000 vertices per vdata, 16,000,000 indices total, 4,096 rigids.

- [ ] Tests: the synthetic model parses to the expected positions (check unpack scale/offset), normals, UVs, indices (packed and raw variants), node name map; truncated/oversized inputs → errors; an unknown vertex layout → `bad`. Commit `feat(atelier): DynModel reader (LOD 0)`.

### Task 7: Skeleton (GeomNodeTree)

**Files:** `src-tauri/src/game/gameres/skeleton.rs`; test in `tests/gameres_dynmodel.rs` (same builder file).

Format (§2b): `u32 a` (dump size = `a & 0xFFFFF`), `u32 n` (bit 31 = compressed: then the dump is an IGenLoad block via `codec::read_block`); dump = `n` × 160 bytes: `tm` 16 f32, `wtm` 16 f32 (4 columns: col0, col1, col2, col3 = translation), child PatchableTab (offset/160 = first child index, count), parent ptr, name ptr (offsets relative to the dump).

```rust
pub struct Node { pub name: String, pub parent: Option<usize>, pub wtm: [[f32; 4]; 4] /* columns */ }
pub struct Skeleton { pub nodes: Vec<Node> }
impl Skeleton {
    pub fn parse(res: &[u8]) -> AppResult<Self>;
    pub fn by_name(&self, name: &str) -> Option<&Node>;
    /// Names from `name` up to the root, `name` first.
    pub fn ancestry(&self, name: &str) -> Vec<&str>;
}
```
Parents come from the children tables (more robust than the parent pointer): for node `i`, children `[ofs/160, ofs/160 + count)` get `parent = Some(i)`. Transform a point: `p = col0*x + col1*y + col2*z + col3`; normals by the 3×3 part, then normalise.

- [ ] Tests: a 3-node tree (`@root`-less: `bone_body` → `bone_turret` → `bone_gun`) parses names, parents, matrices; `ancestry("bone_gun") == ["bone_gun","bone_turret","bone_body"]`; child range past `n` → error. Commit `feat(atelier): GeomNodeTree reader`.

### Task 8: dynModelDesc and DxP2 readers, DXT decode

**Files:** `gameres/desc.rs`, `gameres/dxp.rs`, `src-tauri/src/textures/bc.rs` (+ `pub mod bc;` in `textures/mod.rs`); tests `tests/gameres_dxp.rs`, `tests/textures_bc.rs`.

`desc.rs` (§2c): `dynModelDesc.bin` is a binary BLK of kind 2 (after Task 2 `Blk::parse(bytes, None, None)` reads it). Per model block: `tex` block (params `tex="<name>*"` in order) and `matR` block (child `mat` blocks with params `cls`, `t0`..). API:
```rust
pub struct ModelMaterials { pub textures: Vec<String>, pub diffuse_of_mat: Vec<Option<String>> /* matR index -> t0 name without trailing '*' */ }
pub fn materials(desc: &Blk, model: &str) -> Option<ModelMaterials>;
```
`t0` is an integer index into the model's `tex` list (missing or `-1` = no diffuse). `dxp.rs` (§3): names, headers and records are parallel arrays by index (entry `i` = name `i`, header `i`, record `i`; `texId` is informational). header `"DxP2"`, `u32 version (2|3)`, `u32 texCount`, `u32 dumpSize`; dump at 0x10 with names (8-byte ptrs relative to the dump), 32-byte `DDSx` headers, records (v2: 24 bytes `{u64, i32 texId, i32 ofs, i32 packedDataSize, i32}`; v3: 12 bytes `{i32 texId, i32 ofs, i32 packedDataSize}`; `ofs` absolute in the file).
```rust
pub struct DdsxHeader { pub fourcc: [u8; 4], pub flags: u32, pub w: u16, pub h: u16, pub levels: u8, pub dxt_shift: u8, pub mem_sz: u32, pub packed_sz: u32 }
pub struct DxpEntry { pub name: String, pub header: DdsxHeader, pub ofs: u64, pub data_size: u32 }
pub struct DxpDir { pub entries: Vec<DxpEntry> }
impl DxpDir { pub fn parse(head: &[u8]) -> AppResult<Self>; }
/// Base name of an entry: the part before `*` or `$` (e.g. `m4a3e2_sherman_jumbo_body_c`).
pub fn base_name(entry: &str) -> &str;
/// `true` for the `$hq` part.
pub fn is_hq(entry: &str) -> bool;
/// Reads and unpacks the entry's data, returns the top mip level's BC blocks (w×h).
pub fn top_level(file: &mut (impl Read + Seek), e: &DxpEntry) -> AppResult<Vec<u8>>;
```
Compression = `flags & 0xE000_0000`: 0 none, `0x2000_0000` zstd, `0x6000_0000` Oodle (bare stream, no size prefix; unpacked length `mem_sz`); others → `bad`. Level size `max(w>>i>>2,1)*max(h>>i>>2,1) << dxt_shift`. GENMIP flags (`0x2000`/`0x4000`) → only the top level is stored (Kaiser adds 12 trailing bytes); else if `0x40000` REV_MIP_ORDER → top level is the last `top` bytes; else the first. Only `DXT1` and `DXT5` fourccs are accepted for `_c` (others → `bad("texture format …")`).

`textures/bc.rs`:
```rust
/// Decodes DXT1 (8-byte blocks) or DXT5 (16-byte blocks) to RGBA8, `w`×`h` (multiples of 4; smaller levels padded).
pub fn decode(fourcc: &[u8; 4], blocks: &[u8], w: usize, h: usize) -> AppResult<Vec<u8>>;
/// Encodes RGBA8 to DXT5 blocks with texpresso (quality: ClusterFit).
pub fn encode_dxt5(rgba: &[u8], w: usize, h: usize) -> Vec<u8>;
```
Write the decoder in-house (standard BC1 colour block with the 4/3-colour mode by `c0 > c1`, BC3 = 8-byte alpha block with 8/6-value modes + BC1 colour block always in 4-colour mode). Tests: hand-made blocks with known colours (solid red, 2-colour gradient, alpha ramp), and an encode → decode round trip of a 64×64 gradient within mean abs error ≤ 6 per channel.

- [ ] Tests for desc (a fat BLK built with the Task 2 encoder: model block with `tex` and `matR`), dxp (synthetic pack with one zstd and one raw entry, base name / hq parsing, rev mip order), bc. Commit `feat(atelier): materials, texture packs and DXT decode`.

### Task 9: Index and assembled model, real-install test

**Files:** `gameres/index.rs`, `gameres/assemble.rs`; test `tests/atelier_real.rs` (`#[ignore]`) and `tests/gameres_assemble.rs`.

`index.rs` (§4):
```rust
pub struct GameResIndex {
    pub version: String,                         // game version (aces.vromfs.bin header) or file mtimes
    pub model_of: HashMap<String, String>,       // vehicle code -> model (tankmodels only)
    pub grp_of: HashMap<String, String>,         // model -> pack path relative to the game root ("content/base/res/tanks/usa_m4a3e2_sherman_jumbo.grp")
    pub tex_of: HashMap<String, Vec<TexRef>>,    // base texture name -> where it lives
}
pub struct TexRef { pub pack: String /* relative path */, pub entry: String, pub hq: bool, pub w: u16, pub h: u16, pub fourcc: [u8; 4] }
pub fn build(game_root: &Path) -> AppResult<GameResIndex>;
pub struct IndexStore { /* Mutex<Option<Arc<GameResIndex>>>, cache file path */ }
impl IndexStore { pub fn new(cache: PathBuf) -> Self; pub fn get(&self, game_root: &Path) -> AppResult<Arc<GameResIndex>>; pub fn forget(&self); }
```
`build`: open `aces.vromfs.bin` with `Vromfs::open`, shared names + dictionary exactly as `catalog::read_catalog` does; for every path `gamedata/units/tankmodels/<code>.blk` read root param `model` (string) → `model_of[code]`. For each existing `grp_hdr.vromfs.bin` under `content/base/res`, `content.hq/hq_tex/res`, `content/pkg_infantry/res`, `content.hq/pkg_cockpits/res`: entries ending `.grpcache.bin` → `Grp::parse(bytes, None)`, every `DYN_MODEL` resource name → `grp_of[name] = <root>/<entry without "cache.bin">`; entries ending `.dxp.bincache.bin` → `DxpDir::parse`, every entry except thumbnails (`$tq` in the name) → `tex_of[base_name].push(TexRef{…, w, h, fourcc from its DDSx header})`. Load the archive's `.dict` whenever one exists (kind-5 BLKs need it even when the name map doesn't). Also record `overrides_of[code] = true` when the vehicle's tankmodels BLK has, outside its `user_skin` block, any `replace_tex`/`set_tex`-like block whose `from` ends in `_c*` (vehicles such as `us_m4a3e2_sherman_jumbo_cobra_king` reuse a model with their own `king_*_c` textures); check the real cobra_king BLK in the ignored test to confirm the block names. Cache as JSON at `<data>/atelier/gameres-index.json` keyed by `version`; rebuild when the version (or, without one, the mtimes of `aces.vromfs.bin` and the `grp_hdr` files) changes. Log the build time.

`assemble.rs`:
```rust
pub enum PartGroup { Hull, Turret, Gun }
pub struct Slot { pub texture: String /* base name, ends in _c */, pub width: u32, pub height: u32, pub hq: bool, pub paintable_by_default: bool }
pub struct Part { pub node: String, pub group: PartGroup, pub slot: usize, pub vertex_count: u32, pub index_count: u32 }
pub struct VehicleModel { pub vehicle: String, pub model: String, pub slots: Vec<Slot>, pub parts: Vec<Part>,
    pub positions: Vec<f32>, pub normals: Vec<f32>, pub uvs: Vec<f32>, pub indices: Vec<u32>, pub mirror_axis: u8 /* 2 = z */ }
pub fn load(game_root: &Path, index: &GameResIndex, desc: &Blk, vehicle: &str) -> AppResult<VehicleModel>;
pub fn template_texture(game_root: &Path, index: &GameResIndex, slot: &Slot) -> AppResult<Vec<u8> /* RGBA8, ×2 clamped, alpha 255 */>;
pub fn encode(model: &VehicleModel) -> Vec<u8>; // binary for the frontend, see below
```
`load`: a vehicle with `overrides_of` → `Unsupported` `TEXTURE_OVERRIDES = "Atelier can't paint this vehicle yet: it uses its own textures on a shared model"` (new message, nine languages; supporting overrides is a later phase). `model_of[vehicle]` (else `NotFound MODEL_NOT_FOUND`), `grp_of[model]`, read the `.grp`, `Grp::parse(&bytes, Some(len))`, DynModel = `find(model, DYN_MODEL)`, skeleton = `find(model + "_skeleton", GEOM_NODE_TREE)`, materials from `desc`. For each LOD 0 rigid and elem whose material's diffuse is a `_c` texture present in `tex_of`: transform vertices by the node's `wtm` (`@root` or a node missing from the skeleton = identity), convert to right-handed (negate z of positions and normals, swap the 2nd and 3rd index of each triangle), append to one part per (node, slot), copying only the vertices the elem's indices reference (remap per elem; never the whole vdata). Normals use the 3×3 part of `wtm` (non-uniform scale is ignored). Group: ancestry contains a name starting with `bone_gun` or `gun_barrel` → Gun; else `bone_turret` → Turret; else Hull. Slot dimensions from the HQ `TexRef` when present, else the largest non-HQ one; `paintable_by_default = texture.starts_with(model)`. Elements whose material has no `_c` diffuse are dropped.
`template_texture`: open the pack, `DxpDir::parse` of its head (read `16 + dumpSize` bytes), find the entry, `top_level`, `bc::decode`, then RGB × 2 clamped to 255, alpha 255. Prefer `hq`.
Binary encoding (little-endian), consumed by `src/atelier/modelBuffer.ts`:
```
magic "LVM1"; u32 headerJsonLen; header JSON (UTF-8, padded with spaces to a multiple of 4):
  { vehicle, model, mirrorAxis, slots:[{texture,width,height,hq,paintableByDefault}],
    parts:[{node,group:"hull"|"turret"|"gun",slot,vertexOffset,vertexCount,indexOffset,indexCount}],
    vertexCount, indexCount }
then f32 positions[3*vertexCount], f32 normals[3*vertexCount], f32 uvs[2*vertexCount], u32 indices[indexCount]
(indices are absolute into the shared vertex arrays).
```
- [ ] `tests/gameres_assemble.rs`: build a synthetic game root (temp dir) with a tiny `aces.vromfs.bin` (use `game_catalog.rs`'s `vromfs()` encoder: copy the helpers), a `grp_hdr.vromfs.bin` holding a `.grpcache.bin` and `.dxp.bincache.bin`, the `.grp` (Task 6/7 builders), a raw (uncompressed) DXT5 `.dxp.bin` and a `dynModelDesc.bin`; `index::build` then `assemble::load` returns one hull part with the expected right-handed positions and flipped winding; `template_texture` returns the decoded ×2 pixels; `encode` round-trips its header.
- [ ] `tests/atelier_real.rs` (`#[ignore]`, read-only, game root from `LIVERY_REAL_GAME` or the default path): build the index (print time), load `us_m4a3e2_sherman_jumbo`: model `m4a3e2_sherman_jumbo`, slots include `m4a3e2_sherman_jumbo_body_c` 2048×2048 (hq), `_turret_c` 2048×1024, `_gun_c` 1024×512; > 100,000 vertices; at least one part in each group. Decode the body template and, when `UserSkins/template_us_m4a3e2_sherman_jumbo/m4a3e2_sherman_jumbo_body.tga` exists, compare RGB mean abs error < 10 (write a tiny uncompressed-TGA reader in the test: 18-byte header, BGRA, honour the origin bit). Also load `us_m4a3e2_76w_sherman_jumbo` and one other nation's tank (`germ_pzkpfw_VI_ausf_b_tiger_IIh`) without error.
- [ ] Run both; commit `feat(atelier): vehicle model and template textures from the game's packs`.

---

## Chunk 2: Projects, apply and install (Rust)

### Task 10: Types, settings switch, state, model commands

**Files:** `src-tauri/src/model.rs`, `settings.rs` (no change unless a side effect is needed), `src-tauri/src/atelier/mod.rs`, `src-tauri/src/lib.rs`; tests `tests/settings_fixtures.rs` (new field default), `tests/atelier_projects.rs` later.

- [ ] `Settings.atelier_enabled: bool` (default `false`), `SettingsPatch.atelier_enabled: Option<bool>`, `apply`. Test: old settings files without the field load with `false`.
- [ ] Types (camelCase serde): `AtelierProjectSummary { id, name, vehicle, updated_at, has_thumb }`, `AtelierProject { version: u32, id, name, vehicle, created_at, updated_at, slots: Vec<AtelierSlotChoice { texture, enabled }>, output: AtelierOutput { high_quality: bool }, installed_skin_id: Option<String>, layers: serde_json::Value }`, `ApplyProgress { apply_id, step: ApplyStep { Encode, Write, Install, Done, Error }, pct: u8, message: Option<String>, skin_id: Option<String>, backup_id: Option<String> }`, `ApplyStarted { apply_id }`.
- [ ] `atelier/mod.rs`: `pub struct AtelierState { index: IndexStore, models: Mutex<LruCache-like HashMap<String, Arc<VehicleModel>> (keep 2)>, desc: Mutex<Option<Arc<Blk>>>, applies: Mutex<HashMap<String, ApplyJob>> }`, managed in `lib.rs` with `data_dir.join("atelier")`. Gate helper `fn game_root_for_atelier(app) -> AppResult<PathBuf>`: `read_game_data` off → `InvalidInput` `ATELIER_NEEDS_GAME_DATA = "Atelier needs Read data from the game turned on"`; no game folder → existing `library::game_root` error.
- [ ] Commands (all `async`, work in `crate::blocking`):
  - `atelier_model(app, vehicle: String) -> AppResult<tauri::ipc::Response>`: load (cached), `Response::new(assemble::encode(&model))`.
  - `atelier_template_texture(app, vehicle: String, slot: String) -> AppResult<tauri::ipc::Response>`: RGBA8 bytes (the frontend knows width/height from the model header).
- [ ] Register in `lib.rs`. Commit `feat(atelier): settings switch, state and model commands`.

### Task 11: Project store

**Files:** `src-tauri/src/atelier/project.rs`; commands in `atelier/mod.rs`; test `tests/atelier_projects.rs`.

```rust
pub struct ProjectStore { root: PathBuf /* <data>/atelier/projects */ }
impl ProjectStore {
    pub fn list(&self) -> AppResult<Vec<AtelierProjectSummary>>;              // newest first; unreadable folders skipped with a warning
    pub fn create(&self, name: &str, vehicle: &str, slots: Vec<AtelierSlotChoice>, now: SystemTime) -> AppResult<AtelierProject>;
    pub fn get(&self, id: &str) -> AppResult<AtelierProject>;
    pub fn save(&self, project: &AtelierProject, now: SystemTime) -> AppResult<AtelierProject>; // validates envelope, sets updated_at, atomic write
    pub fn duplicate(&self, id: &str, now: SystemTime) -> AppResult<AtelierProject>;           // name "<name> (2)"-style via layout::unique_name, no installed_skin_id
    pub fn delete(&self, id: &str) -> AppResult<()>;      // moves to <data>/atelier/.trash/<id>
    pub fn undo_delete(&self, id: &str) -> AppResult<()>;
    pub fn forget_deleted(&self, id: &str) -> AppResult<()>;
    pub fn purge_trash(&self) -> usize;                    // at launch
    pub fn set_thumb(&self, id: &str, png: &[u8]) -> AppResult<()>; // checks the PNG signature, max 2 MiB
    pub fn thumb(&self, id: &str) -> AppResult<Vec<u8>>;
}
```
Ids: `library::index::new_id_with("p")`. Envelope validation: `version == 1`, `id` matches the folder and is a safe folder name (`layout::is_folder_name`), `name` 1 to 80 chars after trim, `vehicle` non-empty ASCII `[A-Za-z0-9_-]`, `layers` is a JSON array of at most 500 entries and serialises to < 8 MiB. Messages: `PROJECT_NOT_FOUND = "This Atelier project no longer exists"`, `PROJECT_INVALID = "This Atelier project can't be read"`. Atomic write: temp file in the same folder + `fs::rename` (retry like `rename_retrying`).
- [ ] Tests: create/list/get/save round trip keeps opaque `layers` exactly; `updated_at` moves; invalid envelopes rejected; delete → undo → present; delete → forget → gone; purge at launch; duplicate naming; thumbnail PNG check. Commands `atelier_projects`, `atelier_project_create(name, vehicle)` (slots from the model: `enabled = paintable_by_default`), `atelier_project_get`, `atelier_project_save`, `atelier_project_duplicate`, `atelier_project_delete`, `atelier_project_undo_delete`, `atelier_project_forget_deleted`, `atelier_project_thumb` (raw PNG body, header `x-project-id`), `atelier_project_thumb_get` (Response). Call `purge_trash` in the startup tasks. Commit `feat(atelier): project store with trash`.

### Task 12: `install_generated`

**Files:** `src-tauri/src/archive/generated.rs` (+ `pub mod generated;` in `archive/mod.rs`); test `tests/install_generated.rs` (copy `install_replace.rs`'s `Env`).

```rust
pub enum Target { Replace(String /* skin id */), New(String /* folder name, unsanitised */) }
pub struct Generated { pub skin: HangarSkin, pub backup_id: Option<String> }
/// Installs the skin folder at `staged` (inside `partial_dir`) into the library. Replace keeps
/// the skin's id, folder and active state and backs up the previous version (`keep_backup` as
/// Settings → Backups); a missing id falls back to New. New installs active, `Origin::Mine`,
/// folder from `sanitize_folder_name`, `free_name` on a clash (never asks).
pub fn install_generated(user_skins: &Path, store: &LibraryStore, staged: &Path, target: Target, keep_backup: bool, now: SystemTime) -> AppResult<Generated>;
```
Call `library::purge_in` first (every library command purges expired backups). Implementation inside one `store.transact`: Replace with the id indexed but its folder gone (neither active nor inactive) → drop the stale entry and install as New **keeping that id**; Replace → `layout::find_skin(user_skins, &skin)` gives `(dir, active)`; reuse `install::replace(us, lib, journal, &Clash { path: dir, folder, active, index: Some(pos) }, keep_backup, now)` (check `analyze::Clash`'s exact fields), then `rename_retrying(journal, staged, dir)`, then `scan::scan_skin(&dir)` and push `HangarSkin { id: <old id>, name: <old name>, folder: <old folder>, origin: Origin::Mine, active, installed_at: now, ..scanned }`. New → `free_name`, `rename_retrying` into `UserSkins/<name>`, push with `new_id()`. Make `free_name`, `replace`, `rename_retrying` `pub(crate)` if needed (they are).
- [ ] Tests: new install appears active with `Origin::Mine`; clash with an existing folder gives `(2)`; replace of an active skin keeps id/folder/active and creates a backup record; replace of an inactive skin stays inactive in `.livery/inactive`; replace after the id was deleted → New; `undo_replace` after a replace restores the previous files and the same id; apply → undo → apply again leaves exactly one skin with that id; backups off (`keep_backup = false`) → ephemeral record. Commit `feat(library): install a generated skin, keeping its id on replace`.

### Task 13: DDS writer, `.blk` writer, apply lifecycle

**Files:** `src-tauri/src/textures/dds.rs`, `src-tauri/src/atelier/apply.rs`; commands; tests `tests/textures_bc.rs` (DDS), `tests/atelier_apply.rs`.

- `dds::write_dxt5(w, h, blocks) -> Vec<u8>`: `"DDS "`, 124-byte header (flags CAPS|HEIGHT|WIDTH|PIXELFORMAT|LINEARSIZE, linear size = blocks.len(), pixel format FOURCC `DXT5`, caps TEXTURE), no mips. Test: `textures::header::parse_dds` reads it back as DXT5 w×h.
- `apply.rs`:
```rust
pub struct ApplyJob { pub project_id: String, pub vehicle: String, pub dir: PathBuf /* partial/<applyId>/<folder> */, pub root: PathBuf /* partial/<applyId> */,
    pub enabled: Vec<String> /* slots allowed, from begin */, pub written: Vec<String> /* slots encoded so far */ }
pub fn begin(user_skins: &Path, queue: &QueueStore, project: &AtelierProject, enabled: Vec<String>, folder: &str) -> AppResult<(String, ApplyJob)>;
pub fn texture(job: &mut ApplyJob, slot: &str, w: u32, h: u32, rgba: &[u8]) -> AppResult<()>; // encode DXT5, write <base>.dds
pub fn blk_text(vehicle: &str, slots: &[String]) -> String;
pub fn commit(job: ApplyJob, user_skins: &Path, store: &LibraryStore, target: Target, keep_backup: bool, now: SystemTime) -> AppResult<Generated>;
pub fn cancel(job: ApplyJob);
```
`begin` calls `queue.ensure_partials_purged(user_skins)` first, then creates `partial_dir(us)/<new_id_with("a")>/<folder>`; `folder` = `sanitize_folder_name(&format!("{vehicle}_{project name}"), vehicle)`. `texture` validates: `slot` is one of the project's enabled slots and ends in `_c`; `w`,`h` multiples of 4 and ≤ 4096; `rgba.len() == w*h*4`; a slot written twice → overwrite. File name: `<base>.dds` where base = slot without the trailing `_c`. `blk_text`:
```
name:t="user"

set_tex{
  from:t="<base>_c*"
  to:t="<base>.dds"
  param:t="camo_skin_tex"
}
```
(one block per slot, LF line endings, blank line between blocks), written to `<vehicle>.blk`. `commit` requires at least one written slot (`APPLY_NOTHING`), writes the blk from `written`, then `install_generated`, then removes the empty `partial/<applyId>`. Messages: `APPLY_NOT_FOUND = "This apply is no longer running"`, `APPLY_BAD_TEXTURE = "A painted texture has the wrong size"`, `APPLY_NOTHING = "Turn on at least one part to apply"`.
- Commands: `atelier_apply_begin(app, project_id, enabled: Vec<String>) -> ApplyStarted` (the frontend passes its current enabled slots, so a toggle not yet autosaved can't break the apply) (stores the job in `AtelierState.applies`), `atelier_apply_texture(app, request: tauri::ipc::Request<'_>)` (headers `x-apply-id`, `x-slot`, `x-width`, `x-height`; body must be `InvokeBody::Raw`; copy the bytes then do the work in `blocking`; emit `atelier://apply-progress` Encode/Write with pct), `atelier_apply_commit(app, apply_id) -> ApplyResult { skin: HangarSkin, backup_id: Option<String> }` (camelCase; the frontend needs `backupId` for Undo and must not depend on event order; Install step; sets the project's `installed_skin_id` and saves it, and `ProjectStore::save` always keeps an existing `installed_skin_id` when the incoming project has none, so an autosave racing the apply can't drop it; emits Done with `skin_id`/`backup_id`; on error emits Error and removes the job's folder), `atelier_apply_cancel(app, apply_id)`. Event name const `APPLY_PROGRESS_EVENT = "atelier://apply-progress"`. Never hold the `applies` mutex while encoding: take the job out of the map, work, put it back (cancel during an encode then finds no job and the texture call removes its folder when it finishes). Measure DXT5 ClusterFit on 4096² in the test log; if it takes more than ~3 s, use `RangeFit` for 4096 and note it in DESIGN_NOTES.
- [ ] Tests (`tests/atelier_apply.rs`, temp UserSkins + LibraryStore + QueueStore): begin → texture ×2 → commit installs a folder with two `.dds` and the exact blk text, skin `Origin::Mine`; commit with no texture → `APPLY_NOTHING`; wrong size → `APPLY_BAD_TEXTURE`; cancel removes the partial folder; a queue `ensure_partials_purged` after begin does not remove the job's folder (begin already purged once); second apply with `Replace(id)` keeps the id; unknown apply id → `APPLY_NOT_FOUND`. (`textures::header::parse_dds` labels DXT5 as `"BC3"`.) Commit `feat(atelier): apply to game (DDS, blk, install)`.

---

## Chunk 3: Frontend foundation

### Task 14: Types, bridge, queries, mock backend

**Files:** `src/types.ts`, `src/lib/tauri.ts`, `src/queries/atelier.ts`, `src/queries/settings.ts`, `src/dev/mockAtelier.ts`, `src/dev/mockBackend.ts`; tests `src/lib/tauri.test.ts` (if present, else new), `src/queries/atelier.test.tsx`, `src/dev/mockAtelier.test.ts`.

- [ ] `npm`-side dependency: `pnpm add three@^0.180.0` and `pnpm add -D @types/three@^0.180.0` (caret ranges like the rest of `package.json`; if 0.180 isn't published, the newest 0.17x/0.18x release at least two weeks old, with matching types). Record both in DESIGN_NOTES (approved 2026-10-16).
- [ ] `types.ts`: `Settings.atelierEnabled: boolean`; `Section` gains `'atelier'`; `AtelierProjectSummary`, `AtelierProject`, `AtelierSlotChoice`, `ApplyProgress`, `ApplyStep` mirroring Rust; `ModelHeader` (the binary header JSON).
- [ ] `lib/tauri.ts`: `export async function callRaw<T>(cmd: string, body: Uint8Array, headers: Record<string, string>): Promise<T>` → Tauri: `invoke(cmd, body, { headers })`; mock: `mockCall(cmd, { __body: body, __headers: headers })`. Binary responses from `call` arrive as `ArrayBuffer`.
- [ ] `queries/atelier.ts`: `useAtelierProjects()`, `useAtelierProject(id)`, `useCreateProject()`, `useSaveProject()` (no invalidation of the project itself on autosave; invalidates the list), `useDuplicateProject()`, `useDeleteProject()` (calls delete then `toast.undoable(t(...), undo, forget)`), `useVehicleModel(vehicle)` (`call<ArrayBuffer>('atelier_model')` → `parseModelBuffer`, `staleTime: Infinity`), `useTemplateTexture(vehicle, slot)` (ArrayBuffer → `Uint8Array`), `useThumb(id)`. `DEFAULT_SETTINGS.atelierEnabled = false`.
- [ ] Mock (`mockAtelier.ts`, imported by `mockBackend.ts` only): a unit cube split in three parts (hull = 4 sides + bottom, turret = top face, gun = a thin box on +x) with 3 slots of 256×256 whose template textures are generated checkerboards with panel lines; projects in memory; apply commands emit `atelier://apply-progress` with `later()` and add a `Mine` skin to the mock hangar; `atelier_model` returns the same `LVM1` binary built by a TS encoder (share the format constants with `modelBuffer.ts`). Add `atelierEnabled: isBool` to `PATCH_FIELDS`. Start-up flag `?atelier=1` turns the switch on.
- [ ] Tests: `parseModelBuffer(encodeMockModel())` round trip; mock project CRUD; `callRaw` forwards body/headers to the mock. Commit `feat(atelier): frontend types, queries and mock backend`.

### Task 15: Model buffer, project model, editor store

**Files:** `src/atelier/modelBuffer.ts`, `src/atelier/project.ts`, `src/atelier/editorStore.ts`; tests next to each (`*.test.ts`).

- `modelBuffer.ts`: `parseModelBuffer(buf: ArrayBuffer): VehicleModelData` (`{ header: ModelHeader, positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }`, views over the same buffer; validates magic, lengths, offsets; throws `Error('model buffer')` on mismatch).
- `project.ts`: `Layer` union per the spec's schema restricted to the MVP kinds `base` and `mask` (unknown kinds are preserved as `{ kind: string; [k: string]: unknown }` and listed as unsupported); `newBaseLayer()` (mode `solid`, `colors: ['#56603f']`, scale 1, seed 1; colours are project data stored as hex strings, not UI styling, so the no-hex rule doesn't apply), `newMaskLayer()`; `validateLayers(json: unknown): Layer[]` (repairs: missing base → insert default at 0; base not at 0 → move; more than one mask → keep the first; mask pinned last); `Vec3 = [number, number, number]`; `Stroke` with `dir`.
- `editorStore.ts` (Zustand, not persisted): `{ project, layers, selectedId, past: Layer[][], future: Layer[][], dirty }` with actions `load(project)`, `setBase(patch)`, `addStroke(stroke)`, `removeLastStroke()`, `clearMask()`, `toggleLayerVisible(id)`, `renameLayer(id, name)`, `select(id)`, `undo()`, `redo()`, `setSlotEnabled(texture, on)`, `setHighQuality(on)`; slot toggles and High quality are project settings outside the undo history (they save but don't push `past`); every mutating layer action pushes the previous `layers` onto `past` (cap 100) and clears `future`; a stroke being drawn is one entry (`beginStroke` / `extendStroke` / `endStroke`, history pushed at begin). Add `resetAtelierEditor()` to `resetStores()` in `src/test/render.tsx`.
- Autosave hook `useAutosave()` (in `src/screens/Atelier/useAutosave.ts`): debounced 1 s after `dirty`, calls `useSaveProject`, sets `dirty=false`, exposes `saveState: 'saved'|'saving'|'error'`; flushes on unmount.
- [ ] Tests: history cap and undo/redo; stroke grouping; validation repairs; autosave debounce with fake timers. Commit `feat(atelier): project model and editor store`.

### Task 16: VehiclePicker extraction

**Files:** `src/components/VehiclePicker.tsx` (new), `src/screens/Explore/VehicleInput.tsx`; tests `src/components/VehiclePicker.test.tsx`; existing Explore tests must still pass.

`VehiclePicker({ value: string | null, onChange(code: string | null), list: readonly Vehicle[], types?: VehicleType[], allowFreeText?: boolean, id?, 'aria-labelledby'?, className? })`: the current `VehicleInput` UI and keyboard behaviour, minus the `useExplore` coupling; `types` filters the list; with `allowFreeText=false`, Enter only accepts a highlighted list item. `VehicleInput` becomes `<VehiclePicker value={vehicle} onChange={setVehicle} list={list} allowFreeText />` with its existing sizing class. Commit `refactor(explore): controlled VehiclePicker`.

### Task 17: Navigation and settings

**Files:** `src/screens/Settings/ExperimentalSection.tsx`, `settingsUi.ts`, `src/screens/Settings.tsx`, `src/App.tsx`, `src/components/chrome/Sidebar.tsx`, `src/hooks/useKeyboardShortcuts.ts`, `src/components/chrome/paletteItems.ts`, `src/screens/Atelier.tsx` (placeholder), i18n.

- [ ] Settings → `experimental` section (after `updates`, before `about`): `SectionTitle`, one `SettingRow` with a `Switch` bound to `atelierEnabled` (label "Atelier", helper "Create skins on a 3D model of your vehicle. Experimental: things may change or break."), and when `readGameData` is off a helper line explaining Atelier needs it with a link button to Game (`openSettingsAt('game')`).
- [ ] Sidebar `NAV` entry `{ id: 'atelier', icon: Paintbrush, hint: '6' }` rendered only when `useSettings().data?.atelierEnabled`; shortcut digit `6` and palette action likewise gated (the keyboard hook reads `queryClient.getQueryData<Settings>(SETTINGS_KEY)?.atelierEnabled` at key time; the palette gets an `atelierEnabled` field in its context; update palette tests that count items); `App.tsx` `SCREENS.atelier = Atelier`; leaving `atelier` when the switch goes off → `go('explore')`.
- [ ] i18n keys (all nine files, hand-translated): `common.nav.atelier`, `common.palette.actions.atelier`, `settings.nav.experimental`, `settings.experimental.{title, atelier, atelierHelper, needsGameData, openGame}`.
- [ ] Tests: sidebar hides/shows the entry; the switch patches settings; i18n check. Commit `feat(atelier): experimental switch and navigation`.

---

## Chunk 4: Atelier screens and GPU bake

### Task 18: Atelier home and new-project dialog

**Files:** `src/screens/Atelier.tsx`, `src/screens/Atelier/AtelierHome.tsx`, `ProjectCard.tsx`, `NewProjectDialog.tsx`, `src/store/atelier.ts` (`{ openProjectId: string | null, open(id), close() }`, reset in `resetStores`); tests `src/screens/Atelier/AtelierHome.test.tsx`.

- `Atelier.tsx`: `openProjectId ? <Editor id/> : <AtelierHome/>`; when `readGameData` is off → `EmptyState` explaining it with a button to Settings → Game; WebGL check (`document.createElement('canvas').getContext('webgl2')`) → `EmptyState` "Atelier needs WebGL 2" if missing.
- Home: `ScreenHeader` (title `t('common.nav.atelier')`, right: "New project" primary `Button`), grid like Hangar's (`SkeletonGrid` while loading), cards with thumbnail (`useThumb`, object URL revoked on unmount; placeholder tile when none), name, vehicle label (`useVehicleName`), relative date (reuse the shared date helper used by Hangar), a `Menu` with Open, Rename (inline `TextInput`), Duplicate, Delete (`useDeleteProject`: undoable toast). Empty state: title "Start your first skin", body, "New project".
- `NewProjectDialog` (copy `LicensesDialog`'s modal structure: `role="dialog"`, focus trap, Escape closes): name `TextInput` (default: vehicle name once chosen), `VehiclePicker` with `list={useVehicles()}` (the game catalog, built-in fallback), `types={['ground']}`, `allowFreeText={false}`, Create button; on create the backend loads the model: show an inline skeleton line "Reading the model" and on error show the localized message in the dialog (nothing is created).
- [ ] Tests: empty state, list render, create flow with the mocked backend, delete with undo calls the right commands, axe has no serious violations. Commit `feat(atelier): home and new project`.

### Task 19: Detail map and dilation (pure)

**Files:** `src/atelier/detailMap.ts`, `src/atelier/dilate.ts`; tests next to them.

- `detailMap(rgba: Uint8Array, w, h): Float32Array` — luminance `L = 0.299R + 0.587G + 0.114B` (template brightness, i.e. already ×2); local mean = Gaussian with `sigma = 24 * w / 2048` approximated by 3 successive box blurs (radius from the standard box-for-gauss formula), horizontal and vertical with running sums (O(1) per pixel); `d = clamp((L+1)/(local+1), 0.6, 1.3)`; `glob = clamp(local / mean(local), 0.6, 1.3)`; result `d^0.6 * glob^0.35`. Port of `detail_map` in `D:\Dev\Progetti\Livery-skin-lab\jumbo-megumin\make_skin.py` (PIL `GaussianBlur(24)` = sigma 24, on 2048).
- `dilate(rgba: Uint8Array, covered: Uint8Array, w, h, px = 4): void` — for `px` iterations, every uncovered texel with a covered 4-neighbour takes the average of its covered neighbours' RGBA and becomes covered.
- [ ] Tests: flat image → all ones; a single dark line → factor < 1 on the line, ≈ 1 far away; box-blur equals a naive Gaussian within 2% on a random 64×64; dilation grows coverage by exactly `px` texels on a square. Commit `feat(atelier): detail map and seam dilation`.

### Task 20: GPU bake

**Files:** `src/atelier/gl/shaders.ts`, `src/atelier/gl/baker.ts`; test `src/atelier/gl/baker.test.ts` (logic only: batching, uniform packing; WebGL stubbed).

Built on three.js (`WebGLRenderer`, `WebGLRenderTarget`, `ShaderMaterial`, `BufferGeometry`). Per slot:
1. **Unwrapped geometry:** for the parts of that slot, a `BufferGeometry` whose `position` attribute is the model position (needed in the fragment shader) and a custom `uv` attribute; the vertex shader writes `gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0)`: DirectX v = 0 lands on render-target row 0, so `readRenderTargetPixels` returns rows top-to-bottom with no flip, and the raw DirectX UVs sample the render targets, the template `DataTexture` (`flipY = false`) and the detail map consistently (the preview mesh uses the raw UVs too), varyings `vPos`, `vNormal`, `vGroup`. UVs outside 0..1: triangles are shifted by `-floor(min(u))`, `-floor(min(v))` on the CPU when building the geometry. Culling off; no depth buffer on bake targets (`depthBuffer: false`), depth test and write off (every fragment is at z = 0).
2. **Mask target** (R8 or RGBA8, slot size, persistent): cleared to 0; strokes stamped in batches of up to 64 points: uniforms `uPoints[64]` (xyz + radius), `uParams` (hardness, erase, part group or -1, count), `uDir`; fragment: for each point, `w = 1 - smoothstep(r * hardness, r, distance(vPos, p))`, skipped when `part` mismatches or `dot(vNormal, -uDir) <= 0.2`; paint outputs `w` with blend equation `MaxEquation`; erase outputs `1 - w` with `MinEquation` (idempotent and order-correct, so incremental stamping and a full replay give the same mask). Cull per batch: skip triangles whose vertices are all farther than the batch's bounding sphere (vertex-shader check that collapses them), so long replays stay fast. Replaying a project = clear + all strokes in order.
**Colour model:** all maths happens in sRGB values exactly like the Jumbo script (colours from `#rrggbb` are used as sRGB numbers, never through `THREE.Color`'s linear conversion; the detail factor multiplies sRGB values). Paint targets are plain RGBA8 (`NoColorSpace`), so read-back bytes are the sRGB bytes written into the DDS. The preview shader samples these and the template as sRGB data and converts to linear itself before lighting; never set `SRGBColorSpace` on a render target that is written.
3. **Paint target** (RGBA8, slot size): fragment = base colour (solid: `uColors[0]`; camo: 3D value noise of `vPos * uScale` with `uSeed` offset, two octaves, thresholds splitting into `uCount` colours) × `texture(uDetail, vUv).r` (detail map uploaded as an R16F `DataTexture`: `HalfFloatType`, values via `THREE.DataUtils.toHalfFloat`, `LinearFilter`, because R32F isn't filterable without an extension), alpha = `255 * (1 - mask)`. Coverage target (or alpha of a separate pass) marks texels drawn, for dilation at export.
4. **Preview:** a custom material per slot (`MeshStandardMaterial` + `onBeforeCompile`, or a small `ShaderMaterial` with simple lambert lighting) showing `mix(template.rgb, paint.rgb, paint.a)`, so protected areas visibly show the original; the Template toggle shows the template alone; parts whose slot is turned off show the template. While dragging/painting, bake into a 1024 target and upgrade to full size 300 ms after the last change; only the selected slot keeps its full-size targets between bakes.
5. **Export:** `bakeForExport(slot, size)` renders at full (or 4096 with High quality for the body slot, i.e. a texture ending `_body_c`, when its template is smaller) size, `readRenderTargetPixels` → `Uint8Array`, `dilate`, returns RGBA top-to-bottom. GPU limit: `renderer.capabilities.maxTextureSize`; above it fall back to 2048 and flag `downscaled`.

API:
```ts
export class Baker {
  constructor(renderer: THREE.WebGLRenderer, model: VehicleModelData, templates: Map<string, { rgba: Uint8Array; w: number; h: number }>);
  setLayers(layers: Layer[], enabled: string[]): void;   // diff-based: replays the mask only when strokes changed
  previewTexture(slot: string): THREE.Texture;
  stampStroke(slot: string | 'all', stroke: Stroke, from: number): void; // incremental while painting
  bakeForExport(slot: string, highQuality: boolean): { rgba: Uint8Array; w: number; h: number; downscaled: boolean };
  dispose(): void;
}
```
- [ ] Tests (logic): stroke points split into batches of 64; camo uniforms from a base layer; slot size rules (high quality only raises a body slot below 4096); UV shift of out-of-range triangles. Manual check in `pnpm dev:mock` with the cube (Task 22). Commit `feat(atelier): GPU bake (base, camo, detail, mask)`.

### Task 21: Editor

**Files:** `src/screens/Atelier/Editor.tsx`, `EditorTopBar.tsx`, `LayersPanel.tsx`, `PartsList.tsx`, `PropertiesPanel.tsx`, `Viewport.tsx`, `ApplyButton.tsx`, `src/atelier/gl/scene.ts`, `useAutosave.ts`; tests `Editor.test.tsx` (WebGL stubbed: `Viewport` behind an injectable renderer factory).

- `scene.ts`: `createScene(canvas)` → three.js renderer (antialias, `outputColorSpace = SRGBColorSpace`; template/paint textures are sRGB), perspective camera, a minimal orbit controller written here (left drag orbit, right drag pan, wheel zoom; no `OrbitControls` import from `three/examples` is needed but it is allowed since it ships inside `three`), hemisphere + directional light, `setModel(model, textures)`, `quickView('front'|'side'|'rear'|'top')` (Dagor X forward → after the z flip, front looks along −X), `raycast(clientX, clientY) -> { point: Vec3, normal: Vec3, part: string, group } | null` (three `Raycaster`, throttled to one per animation frame), resize via `ResizeObserver`, `dispose()`.
- Layout (tokens only; panel widths like Hangar's detail panel): top bar (back arrow → `close()`, editable name, vehicle label, save state, undo/redo buttons + Ctrl+Z / Ctrl+Y, Template/Paint `SegmentedControl`, Apply primary); left: `LayersPanel` (Protected areas at the top, Base at the bottom, visibility toggles, rename on double click) and `PartsList` (one `Switch` per slot with a friendly label: `body`, `turret`, `gun` from the texture name suffix, else the raw name); centre `Viewport` (quick-view buttons bottom-left; brush cursor circle overlay when the mask layer is selected); right `PropertiesPanel`: Base → mode `SegmentedControl` (Solid / Camo), colour swatches with `<input type="color">` (2 to 4 for camo, add/remove), scale slider, seed with a "Shuffle" button; Protected areas → brush radius and hardness sliders, Paint/Erase toggle, "Only this part" `ChipDropdown` (All, Hull, Turret, Gun), "Clear" (undoable through history).
- Painting: pointer down on the viewport with the mask layer selected → `beginStroke({ radius, hardness, erase, part, dir: camera direction })`; pointer move → raycast → `extendStroke(point)` (skip points closer than `radius / 3` to the previous) and `baker.stampStroke`; pointer up → `endStroke()`. Orbit only with right/middle button or Alt+left while the brush is active.
- `ApplyButton`: disabled while running; flow: `atelier_apply_begin` → for each enabled slot `baker.bakeForExport` then `callRaw('atelier_apply_texture', rgba, headers)` (progress: Bake = 0..50% split across slots in the frontend, then Rust's Encode/Write/Install events map to 50..100%) → `atelier_apply_commit`; on error `atelier_apply_cancel` and an error toast; on success: a replace shows `toast.undoable(t('atelier.apply.replaced'), () => call('undo_replace', { skinId, backupId }))`, a new install shows `toast(t('atelier.apply.installed'))`; both followed by the hint "Re-select the skin in the hangar to see it" (`atelier.apply.reselect`); invalidate the hangar query. Then render a 512×512 thumbnail from the current view (`renderer.domElement.toBlob` after a render) and send it with `atelier_project_thumb`; also on leaving the editor.
- Downscale notice: when the export fell back to 2048, toast `atelier.apply.downscaled`.
- After `atelier_apply_commit` returns, write `installedSkinId` into the editor store's project immediately (so the next autosave carries it); flush any pending autosave before `atelier_apply_begin`.
- High quality: a `Switch` under Parts ("High quality body (4096)"), shown only when the body slot's template is smaller than 4096.
- No HQ pack: when any enabled slot has `hq: false`, a notice line in the Parts list ("The game's high-quality textures aren't installed: Atelier works from smaller ones").
- Leaving the editor (back, closing the project, switching screen) during an apply calls `atelier_apply_cancel`.
- Deferred to Phase 2 (noted in DESIGN_NOTES): the shared/mirrored-UV hint for strokes.
- [ ] Tests: renders panels for a mocked project; base edits mark dirty and autosave; undo/redo buttons; apply flow calls commands in order with the stubbed baker and shows the right toast; axe. Commit `feat(atelier): editor with base, protected areas and apply`.

### Task 22: Strings, docs, checks, visual pass

- [ ] Audit (they were added task by task): all `atelier.*` strings in nine languages (titles, buttons, empty states, errors, apply steps, hints), `common.errors.backend` entries for every new Rust message (`MODEL_UNREADABLE`, `MODEL_NOT_FOUND`, `TEXTURE_NOT_FOUND`, `ATELIER_NEEDS_GAME_DATA`, `PROJECT_NOT_FOUND`, `PROJECT_INVALID`, `APPLY_NOT_FOUND`, `APPLY_BAD_TEXTURE`, `APPLY_NOTHING`). `pnpm i18n:check` clean.
- [ ] DESIGN_NOTES rows "Atelier (MVP)" (decisions: experimental switch, formats, `oozextract`/`texpresso`/`three` approved 2026-10-16, binblk numbering fix, id kept on replace, texture ×2, tracks not shown, mask strokes as model-space spheres) and `docs/wtlive-terms.md` §8 subsection "Models and textures (Atelier)". Both files are local only (in `.gitignore`) and live in the main checkout (paths in the header): edit there, never `git add`. Also record the deviations from the spec: projects in `<data>/atelier/projects/<id>/`, `install_generated` in `archive::generated`, vehicles with texture overrides refused for now.
- [ ] Full checks: `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm build` + grep `dist/`, `cargo test`, clippy (1.94 and `+1.99.0`), `cargo fmt --check`.
- [ ] `pnpm dev:mock` with `?atelier=1`: create a project on the cube, paint camo, brush a protected area, apply, check the toast and the Hangar entry; screenshots at 1440×900 and 1100×700; dark theme only (the app has one theme).
- [ ] Real app (`$env:LIVERY_DATA_DIR` = a scratch folder copy, real game folder read-only except `UserSkins`, which Apply writes): open the Jumbo, paint, apply, check `UserSkins/us_m4a3e2_sherman_jumbo_<name>` contains `m4a3e2_sherman_jumbo_body.dds` (DXT5) + blk, then ask the author to look in the hangar. Commit `feat(atelier): MVP strings and docs`.
