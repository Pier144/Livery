# Atelier phase 0: War Thunder model + texture formats (feasibility spike)

Date: 2026-10-16. Game build on disk: War Thunder (Steam), `D:\SteamLibrary\steamapps\common\War Thunder`, packs dated 2026-09-17.
Reference: Dagor Engine sources (BSD-3), sparse checkout in the session scratchpad `dagor/src`.
Scripts (throwaway Python, read-only on the game): `<scratchpad>\spike\scripts\`. Outputs: `<scratchpad>\spike\out\`.
`<scratchpad>` = `<session scratchpad>`.

## Verdict

**Feasible.** The Jumbo LOD0 mesh (85 rigid objects, 114,725 verts, 99,202 tris), its node hierarchy, its
material -> texture binding and the original `_c` textures were all read straight from the packs, assembled into a
correct model (see `out/render_34.png`), and the UV layout lands exactly on the template texture (`out/uv_layout_body.png`).

**One real dependency issue, not a format blocker: everything is Oodle (Leviathan).**
- 3656/3656 tank DynModel vertex blocks and every non-empty tank `_c` texture (7781/7781) are Oodle-compressed;
  every stream starts `8C 0C` = Oodle Leviathan.
- The spike decoded them by loading the game's own `oo2core_9_win64.dll` via ctypes. That DLL ships only in
  `win-arm64ec\` on this install (it is an x86-64 PE despite the folder name); `win64\` has none (Oodle is linked
  into `aces.exe`). Not a robust production path, and the DLL can't be redistributed.
- Production path: the `oozextract` crate (crates.io, **MIT**, pure Rust, v0.5.5, 2026-08-12, "Kraken / Mermaid /
  Selkie / Leviathan / LZNA / Bitknit decompressor"). **Not yet tested against these streams** (adding it needs the
  author's approval). The C++ original (`powzix/ooz`) has no license file; don't use it.
- Other new dependencies the feature will need (also need approval): a BC1/BC3/BC7 decoder (Livery only reads texture
  headers today), e.g. `texture2ddecoder`/`bcdec_rs`, or upload the BC blocks unchanged to WebGL in WebView2
  (`WEBGL_compressed_texture_s3tc` + `EXT_texture_compression_bptc`). The meshoptimizer index decoder is ~20 lines
  (below); no crate needed. zstd is already a dependency.

## Common Dagor building blocks (all little-endian, 64-bit dump layout)

- **PatchableTab<T>** (16 bytes): `u32 ofs, u32 count, u64 reserved(0)`. `ofs` is relative to the dump base named
  per structure. `count == 0` means empty (ofs is ignored).
- **PatchablePtr<T>** (8 bytes): `u32 ofs, u32 pad`. Relative to the same base. In several places the low u32 is
  not an offset but an inline int (`toInt()`), e.g. a resource size or an index (noted below).
- **IGenLoad block** (`beginBlock`): `u32 L`; `tag = L >> 30` (0 none, 1 ZSTD, 2 OODLE, per `btag_compr`),
  `size = L & 0x3FFFFFFF`. For OODLE the payload is `u32 rawSize` then `size-4` bytes of Oodle stream.
  For ZSTD the payload is one zstd frame.
- **Oodle stream**: a plain OodleLZ buffer; decompress whole with the known raw size
  (`OodleLZ_Decompress(src, len, dst, rawLen, fuzzSafe=1, ...)` returns rawLen).

## 1. GRP2 (`content/base/res/tanks/*.grp`)

Source: `prog/engine/gameRes/grpData.h`, `gameResSystem.cpp`.

```
0x00  char[4] label       "GRP2" (also "GRP3" accepted by the engine)
0x04  u32 descOnlySize    size of the description part after the header
0x08  u32 fullDataSize    bytes to read after the header to get GrpData (desc + dependency data)
0x0C  u32 restFileSize    file size - 16 (engine checks this)
0x10  GrpData (dump base = file offset 0, i.e. offsets are absolute file offsets)
      +0x00 PatchableTab<i32>      nameMap   -> offsets of NUL-terminated names (-1 = none)
      +0x10 PatchableTab<ResEntry> resTable  -> real resources
      +0x20 PatchableTab<ResData>  resData   -> dependency records
ResEntry (12 B): u32 classId, u32 offset (absolute file offset of the resource data; 0 = no data),
                 u16 nameIdx (into nameMap), u16 reserved
ResData GRP2 (24 B): u32 classId, u16 nameIdx, u16 reserved, u32 refOfs (absolute), u32 refCount, u32 r1, u32 r2
ResData GRP3 (16 B): u32 classId, u16 nameIdx, u16 refCount, u32 refOfs, u32 pad
refs: refCount x u16 nameIdx (0xFFFF = none)
```
- Resource data is **not** compressed at the GRP level: a resource spans `[offset, next non-zero offset)`
  (last one to EOF) and its own loader handles compression.
- Class ids (`dag_stdGameResId.h`): DynModel `0xB4B7D9C4`, GeomNodeTree `0x56F81B6D`, Character `0xA6F87A9B`,
  FastPhysData `0x855A1BE6`, CollisionResource `0xACE50000`, RendInst `0x77F8232F`, PhysObj `0xD543E771`.
- Jumbo pack `usa_m4a3e2_sherman_jumbo.grp` (3,360,727 B) holds 22 resources: for each of `m4a3e2_sherman_jumbo`
  and `m4a3e2_76w_sherman_jumbo`: `<m>` (DynModel, 1,084,704 B), `<m>_skeleton` (GeomNodeTree), `<m>_char`
  (Character, refs `<m>` + `<m>_skeleton`), `_dmg`/`_xray` DynModels and skeletons, `_dm_skeleton`, `_collision`, `_fastphys`.
- Locate the model: scan resTable for `name == model && classId == 0xB4B7D9C4`; skeleton = `model + "_skeleton"`.

## 2. DynModel (DynamicRenderableSceneLodsResource)

Sources: `engine/shaders/dynSceneRes.cpp`, `matVdataLoad.cpp`, `shaderMesh.cpp`, `shadersRes.cpp`,
`dagorInclude/shaders/dag_dynSceneRes.h`, `dag_shaderMesh.h`.

Read sequentially from `ResEntry.offset`:

```
i32 res_sz                              size of the LODs dump below (Jumbo: 136)
i32 texCount, i32 matCount              both -1 for every tank => tex/mat live in dynModelDesc.bin (see 2c)
i32 vdataCount                          Jumbo: 8
u32 matVdataHdrSz                       top bits = compression of the vertex data:
                                         (v & 0xE0000000) == 0xC0000000 -> block-compressed (zstd/oodle by block tag)
                                         else v < 0 -> zlib (size = -v); v & 0x40000000 -> lzma; else raw
                                         header size = v & 0x3FFFFFFF  (Jumbo: 0xC0000150 -> 0x150)
[only if texCount != -1: i32 sz + TexStr dump (PatchableTab<i32> name offsets + strings); not seen on tanks]
matVdata block                          u32 blockHdr (tag 2 = OODLE on all 3656 tank models), u32 rawSize, stream
                                         Jumbo: block 0x0F9559 B -> 3,820,392 B raw
LODs dump (res_sz bytes)                base = start of this dump
  +0x00 PatchableTab<Lod> lods          Lod (16 B): u32 sceneResSz (inline int), u32 pad, f32 range, f32 texScale
  +0x10 f32 bbox[6]                     min xyz, max xyz; if min > max (swapped) the bound-pack is used
  +0x28 f32 bpC254[4]                   position unpack OFFSET (pos_unp_s_ofs)
  +0x38 f32 bpC255[4]                   position unpack SCALE  (pos_unp_s_mul)
  +0x48 Lod[lods.count]
names: i32 sz + RoNameMapEx dump        base = start of this dump
  +0x00 PatchableTab<PatchablePtr<char>> map   node names, alphabetically sorted
  +0x10 PatchableTab<u16> id                    node id for each sorted name (id order = rigid nodeId space)
for each LOD i:
  scene dump (Lod.sceneResSz bytes)     base = start of this dump
    +0x00 PatchableTab<RigidObject> rigids
    +0x10 PatchableTab<PatchablePtr>  skins    (count only matters here; skins come later)
    RigidObject (32 B): u32 meshResSz (inline int), u32 pad, f32 sph_c[3], f32 sph_r, i32 nodeId, u32 uniqueRefId
  then, for each rigid in order, ShaderMesh dump (meshResSz bytes), base = start of that dump:
    +0x00 PatchableTab<RElem> elems
    +0x10 u16 stageEndElemIdx[8]        cumulative elem counts per stage (opaque, atest, ..., trans)
    +0x20 i32 maxMatPass (bit31 set = modern format), i32 reserved
    RElem (48 B): u64 shaderElem(0), u64 matIndex (into matR), u64 vdataIndex (into vdata),
                  i32 vdOrderIndex, i32 sv, i32 numv, i32 si (start index), i32 numf (triangles), i32 baseVertex
if any LOD has skins: i32 variantCount, i32 skipSize, variants..., second ShaderMatVdata (matS) and
  zlib-wrapped ShaderSkinnedMesh records. Not parsed in the spike (only the tracks are skinned).
```
Triangles of an elem: `vdata.idx[si .. si + 3*numf] + baseVertex`, indices into that vdata's vertex buffer.

### 2a. Decompressed matVdata
```
MatVdataHdr (matVdataHdrSz bytes), base = start of the raw buffer
  +0x00 PatchableTab<ShaderMaterialProperties> mat   count 0 on tanks (materials come from the desc)
  +0x10 PatchableTab<VdataHdr> vdata
VdataHdr (32 B): u32 vertNum
                 u32 vertStride:8 | packedIdxSizeLo:24
                 u32 idxSize:28   | packedIdxSizeHi:4        (idxSize = unpacked IB bytes)
                 u32 flags
                 PatchableTab<CompiledShaderChannelId> vDecl
CompiledShaderChannelId (12 B): i32 type (VSDT code << 16), i32 usage, i16 usageIndex, u16 streamId
then, per vdata in order: VB (vertNum * stride), then IB:
  flags & 0x200 (PACKED_IB): packedIdxSize bytes of meshoptimizer index-sequence encoding
  else idxSize raw bytes
```
- flags: `0x20` I16 indices, `0x40` I32 (also I32 if vertNum > 65536 and not I16), `0x200` packed IB,
  `0xF000` LOD index (`(flags >> 12) & 15`), `0x08/0x10` no IB/VB. Jumbo: 8 vdata = 2 per LOD (LOD0 = vdata 6 and 7);
  vdata 6 has 106,485 verts with 16-bit indices, the second half addressed through `baseVertex` (50,561).
- Usage: 0 POS, 1 NORM, 2 VCOL, 3 TC, 4 LIGHTMAP, 5 EXTRA. VSDT codes (`dag_consts_base.h`): 0 FLOAT1, 1 FLOAT2,
  2 FLOAT3, 3 FLOAT4, 4 E3DCOLOR, 5 UBYTE4, 6 SHORT2, 7 SHORT4, 9 SHORT2N, 10 SHORT4N, 11 USHORT2N, 12 USHORT4N,
  13 UDEC3, 14 DEC3N, 15 HALF2, 16 HALF4, 17-20 INT1-4, 21-24 UINT1-4.
- Vertex layouts seen on the Jumbo (attributes packed in vDecl order, no padding):
  - stride 20: TC1 SHORT2, POS SHORT4N, NORM E3DCOLOR, TC0 SHORT2
  - stride 16: POS SHORT4N, NORM E3DCOLOR, TC0 SHORT2
- **Position**: `xyz = short / 32767 * bpC255.xyz + bpC254.xyz` (w is always 32767). Result is in the rigid's
  **node-local** space (bounding-sphere centres are small, near 0).
- **UV0**: `SHORT2 / 4096` (verified: body/turret/gun all land in [0,1]; tracks/nets tile beyond 1). DirectX
  convention, origin top-left: pixel = (u * W, v * H). For OBJ write `1 - v`. TC1 (also /4096, range 0.24..0.99) is a
  second set used by some shaders; the skin template layout matches **TC0**.
- **Normal**: E3DCOLOR stored B,G,R,A in memory; used as `xyz = (R,G,B)/255*2-1`. Assumed, not rigorously verified.
- **Index sequence decoder** (meshoptimizer `meshopt_decodeIndexSequence`, MIT): byte0 = 0xD0 | version(0..1); then per
  index one vbyte (LEB128-like: 7 bits/byte, high bit = more, max 5 bytes) `v`; `cur = v & 1; v >>= 1;
  d = (v >> 1) ^ -(v & 1); idx = last[cur] + d; last[cur] = idx`; the stream ends with 4 zero tail bytes and the
  decoder must stop exactly at `len - 4`.

### 2b. Node hierarchy (GeomNodeTree `<model>_skeleton`)
Source: `engine/math/geomTree.cpp` (`GeomNodeTree::load`, `OldGeomTreeNode`).
```
u32 a    dump size = a & 0xFFFFF; lastUnimportantCount = a >> 20
u32 n    node count; bit31 = compressed (then an IGenLoad block, zstd or oodle, holds the dump) - 0 of 4993 tank skeletons
dump (base = start of dump): n x 160 B
  mat44f tm   (4 columns x float4: col0, col1, col2, col3 = translation)  local
  mat44f wtm  (same layout)                                                 model space
  PatchableTab child, PatchablePtr parent (offset of parent node; self or null = root), PatchablePtr name
```
Assembling: `nodeName = names.map[k]` where `names.id[k] == rigid.nodeId`; find the skeleton node with that name;
`p_model = wtm.col0*x + wtm.col1*y + wtm.col2*z + wtm.col3`, normals by the 3x3 part. `@root` is not in the skeleton
(identity). Jumbo: 115 DynModel node names, 169 skeleton nodes, every other rigid matched.
Nodes of interest exist by name: `bone_turret`, `bone_gun`, `gun_barrel`, `hatch_*`, `bone_wheel_*`, `suspension_*`,
`ex_decor_*`, etc. Body geometry sits on `@root`.
Dagor is Y-up, X forward, **left-handed**; exporting to glTF/OBJ for a right-handed viewer: negate one axis (z) and
flip the triangle winding. The spike's OBJ is written unflipped (mirror image in right-handed tools).

### 2c. Material -> texture binding (`content/base/res/dynModelDesc.bin`)
Because tanks store `texCount = matCount = -1`, materials are in `dynModelDesc.bin` (engine global
`gameres_dynmodel_desc`), one block per model name:
```
m4a3e2_sherman_jumbo {
  tex { tex="m4a3e2_sherman_jumbo_turret_c*" tex="us_camo_olive*" ... }   (39 entries, index = position)
  matR { mat { cls="dynamic_masked_tank" par="" t0=7 t1=1 t2=8 t3=9 } ... }  (17 rigid materials)
  texScale_data { texScale0=... }
  matS { ... }                                                               (skinned materials, num_bones=4)
}
```
`RElem.matIndex` -> `matR` block i. Slots for `dynamic_masked_tank`: **t0 = diffuse `_c`**, t1 = camo (the texture the
skin's `replace_tex from="us_camo_olive*"` targets), t2 = normal `_n`, t3 = AO `_ao`. Jumbo: mat 0 -> body_c,
mat 1 -> turret_c, mat 3 -> gun_c, mat 14 -> body_c (selfillum), mat 9 -> turret_c.
File format: `u8 0x02, u24 compressedSize, zstd frame`; the frame holds `u8 0x01` + a full binary BLK with its own
names = the same body layout Livery's `binblk.rs` calls "fat" (uleb name count, uleb names size, names, uleb blocks,
uleb params, uleb data size, data, 8-byte param infos, block infos). Labels per Dagor `blk_shared.h`: 1 full,
2 full+zstd (u24 size), 3 shared-names, 4 shared-names+zstd, 5 shared-names+zstd+dict, 6 full dedup.
Side note: `aces.vromfs.bin` tankModels BLKs start with byte **5** (zstd + dictionary); Livery's `binblk.rs` doc
numbers kinds 0..4, so it would reject them as-is. Worth checking before reusing it for these files.

## 3. DxP2 texture packs (`*.dxp.bin`)

Source: `engine/lib3d/texPackMgr2.cpp`, `engine/sharedInclude/3d/ddsxTex.h`, `ddsxTexMipOrder.h`.
```
0x00 char[4] "DxP2"; u32 version (2 or 3); u32 texCount; u32 dumpSize
0x10 dump (dumpSize bytes); offsets below are relative to the dump start (file 0x10)
  +0x00 PatchableTab<PatchablePtr<char>> names   texture names (8-byte entries, low u32 = offset)
  +0x10 PatchableTab<ddsx::Header>       headers (32 B each)
  +0x20 PatchableTab<Rec>                records: v2 24 B = {u64 unused, i32 texId, i32 ofs, i32 packedDataSize, i32 resv}
                                                  v3 12 B = {i32 texId, i32 ofs, i32 packedDataSize}
  Rec.ofs is an ABSOLUTE file offset.
ddsx::Header (32 B): char[4] "DDSx"; u32 d3dFormat (FourCC "DXT1", "DXT5", "BC7 " ...); u32 flags;
  u16 w, h; u8 levels, hqPartLevels; u16 depth; u16 bitsPerPixel; u8 lQmip:4|mQmip:4; u8 dxtShift:4|uQmip:4;
  u32 memSz (unpacked bytes); u32 packedSz (0 = stored raw)
flags: 0x000F addrU, 0x00F0 addrV, 0x0800 cube, 0x1000 volume, 0x2000 GENMIP_BOX, 0x4000 GENMIP_KAIZER,
  0x8000 GAMMA_EQ_1 (linear), 0x10000 hold sysmem, 0x20000 need paired base tex, 0x40000 REV_MIP_ORDER,
  0x80000 HQ_PART, 0x200000 array; compression = flags & 0xE0000000: 0 none, 0x20000000 zstd,
  0x40000000 7zip/lzma, 0x60000000 OODLE, 0x80000000 zlib.
```
- Lookup: names are like `m4a3e2_sherman_jumbo_body_c*?q0-1-1u01` (base quality), `..._c$hq*` (HQ part),
  `..._c$tq*` (thumbnail); strip at `*` / `$` and compare with the desc's `tex` name (also ends with `*`).
- Data at `Rec.ofs`: if compressed, `packedSz` bytes -> `memSz`. Oodle here is the bare stream (no size prefix).
- Block size per 4x4 = `1 << dxtShift` (3 = 8 B DXT1, 4 = 16 B DXT5/BC7). Mip `i` size = `max(w>>i>>2,1)*max(h>>i>>2,1) << dxtShift`.
- If GENMIP_* is set, only the top level is stored; with GENMIP_KAIZER the buffer ends with 12 extra bytes
  (3 floats, observed 2.2 / 40.0 / 2.0 = Kaiser mip-gen parameters). If REV_MIP_ORDER is set (no GENMIP),
  mips are stored smallest first, so the top level is the last `topSize` bytes.
- Where the Jumbo `_c` textures live (header caches make this cheap, see section 4):
  - base: `content/base/res/tanks/usa_gm_bq.dxp.bin` - body_c DXT5 512x512, levels 10, hqPartLevels 2, Oodle
  - HQ: `content.hq/hq_tex/res/hq_tex_tanks/usa_m4a3e2_sherman_jumbo.dxp.bin` - body_c DXT5 **2048x2048**
    (= template size), turret_c 2048x1024, gun_c 1024x512, all Oodle, flag HQ_PART
  - thumbnails: `content/base/res/zzz-tq_pack.dxp.bin`
  - shared parts (MGs, glass, nets) in `tanks/gm.dxp.bin` / `gm-hq.dxp.bin`; tracks in `phys_tracks.dxp.bin`.
  HQ data is only present when the HQ texture pack is installed; fall back to the 512 base level otherwise.
- `_n` normal maps are BC7 (Pillow decodes them); `_ao` DXT1.

### Texture vs template (ground truth)
Decoded HQ `m4a3e2_sherman_jumbo_body_c` vs `UserSkins/template_us_m4a3e2_sherman_jumbo/m4a3e2_sherman_jumbo_body.tga`
(both 2048x2048): **identical layout** (`out/_cmp_body.png`), but the game texture is stored at about **half
intensity** (max channel ~128-165).
| texture | raw MAD RGB (0-255) | MAD after x2 (clamped) | MAD after x2.04 |
|---|---|---|---|
| body 2048 | 58.86 | 6.95 | 6.16 |
| turret 2048x1024 | 58.17 | 7.19 | 6.64 |
| gun 1024x512 | 64.96 | 7.04 | 6.79 |
| body base 512 (upscaled) | 78.12 | - | - |
The residual ~6-7 is consistent with independent DXT5 encodes. Alpha is unrelated (template alpha = "SAMPLE"
watermark). So: template RGB ~= clamp(2 x game `_c`).

## 4. Vehicle code -> model -> files
- `aces.vromfs.bin` (not `char.vromfs.bin`): `gamedata/units/tankmodels/<code>.blk`, root param
  **`model`** = DynModel resource name. Examples: `us_m4a3e2_sherman_jumbo`, `fr_m4a3e2_sherman_jumbo`,
  `us_m4a3e2_sherman_jumbo_cobra_king` -> `m4a3e2_sherman_jumbo`; `us_m4a3e2_76w_sherman_jumbo` ->
  `m4a3e2_76w_sherman_jumbo`. Also `user_skin { name="us_m4a3e2_sherman_jumbo" replace_tex { from="us_camo_olive*" } }`
  and `skin { name=..., replace_tex{from,to} }` blocks.
- GRP file and texture packs: `content/base/res/grp_hdr.vromfs.bin` (VRFs archive, 3174 entries) holds
  `<relpath>.grpcache.bin` = the GRP header+desc of every pack (byte-identical to the file's first fullDataSize+16
  bytes) and `<relpath>.dxp.bincache.bin` = the DxP2 header+dump of every texture pack. Same file exists in
  `content.hq/hq_tex/res/`, `content/pkg_infantry/res/`, `content.hq/pkg_cockpits/res/`. Scanning all of them gives
  `model -> tanks/usa_m4a3e2_sherman_jumbo.grp` and an index of 69,902 texture names in **0.36 s** (Python).
- Texture list per model: `dynModelDesc.bin` block (section 2c); diffuse names -> dxp via the cache index.

## 5. Deliverables produced
- `out/model.obj` + `model.mtl`: Jumbo LOD0, one group per `node__matN_<diffuse>`, v/vt/vn, node transforms applied
  (written in Dagor's left-handed axes, V flipped for OBJ).
- `out/m4a3e2_sherman_jumbo_{body,turret,gun}_c.png` (HQ, decoded), `*_c_bq.png` (512 base), `body_n_bq.png` (BC7).
- `out/uv_layout_body.png`: LOD0 body triangles (mats 0 and 14) drawn over the decoded body_c: lines up exactly with
  sprocket, wheels, hatches, etc. (`_uv_crop.png` is a zoom).
- `out/render_34.png`, `render_side.png`, `render_top.png`: flat-shaded painter's-algorithm renders sampling the `_c`
  colour per triangle; assembly (hull, turret, gun, MGs, wheels, stowage) is correct. Tracks are missing (skinned).
- `out/_cmp_body.png`: decoded body_c next to the template TGA.

## Pitfalls / notes for the Rust parser
- Treat every offset as untrusted: bounds-check PatchableTab ranges, block sizes and the meshopt tail check.
- `RigidObject.mesh` and `Lod.scene` are not pointers in the file: their low u32 is the size of the next dump.
- `RElem.mat` / `RElem.vertexData` hold indices, not pointers.
- Node names are sorted; use the `id` table to map `nodeId -> name`. Don't index `map[]` by nodeId.
- 16-bit IB + `baseVertex` is used for >65535-vertex buffers; don't assume 32-bit indices by vertex count when `0x20` is set.
- The vdata header sizes are packed bitfields (stride 8 bits, packed IB size split 24+4 bits).
- Tanks never use the inline TexStr path; still parse it (or reject) when texCount != -1.
- Positions need the per-model `bpC254/bpC255` unpack, then the node `wtm`.
- `_c` textures: use the `$hq` part when present (it matches the template size), else the base pack.
- The 76W and base Jumbo share one GRP; `cobra_king` reuses the Jumbo model with different textures (`king_*_c`).
- Skinned meshes (tracks, after the rigid meshes) and `_dmg`/`_xray` variants were not needed and not parsed.
- GeomNodeTree and matVdata may be zstd or Oodle by block tag; the spike only saw raw skeletons and Oodle vdata.

## Scripts (`<scratchpad>\spike\scripts\`, run with `py -3.13 -I`)
- `grp.py <grp>`: GRP2 header, resource table, refs.
- `dxp.py <dxp.bin> [name filter]`: DxP2 directory and ddsx headers.
- `oodle.py`: ctypes wrapper over the game's `oo2core_9_win64.dll` (env `OODLE_DLL` overrides the path).
- `tex.py`, `decode_tex.py <dxp> <tex> <out.png> [template.tga]`: decode a texture (DDS wrapper + Pillow), compare.
- `blk.py <file.bin> [block]`: Dagor binary BLK (full / zstd).
- `vromfs.py <archive> <path | --find s>`: VRFs/VRFx reader + slim BLK (shared names, dict).
- `dynmodel.py <grp> <model>`: DynModel parse summary (vdata, decls, LODs, rigids).
- `export_obj.py <grp> <model> <dynModelDesc.bin> <out_dir> [body_c.png]`: OBJ, UV layout, renders.
- `map_vehicle.py <game_dir> <vehicle>`: vehicle -> model -> grp + texture packs via header caches.
- `survey.py <game_dir>`: compression census across all tank packs.
