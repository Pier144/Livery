//! Atelier against the real War Thunder install (ignored: reads the machine's game files,
//! read-only, nothing is written there).
//! `cargo test --test atelier_real -- --ignored --nocapture`. The game root comes from
//! `LIVERY_REAL_GAME`, else the default Steam path. Oodle streams are decoded by the worker
//! process, which is the `livery` executable of this test build unless `LIVERY_WORKER_EXE`
//! names another one (for example `target/release/livery.exe`).

use livery_lib::game::binblk::Blk;
use livery_lib::game::gameres::assemble::{self, PartGroup};
use livery_lib::game::gameres::bytes::Reader;
use livery_lib::game::gameres::codec::{
    check_kraken_family, decode_in_process, oodle, read_block, set_worker_exe, OodleWorker, MAX_VERTEX_DATA,
};
use livery_lib::game::gameres::desc::materials;
use livery_lib::game::gameres::dxp::{base_name, is_hq, top_level, DxpDir};
use livery_lib::game::gameres::dynmodel;
use livery_lib::game::gameres::grp::{Grp, DYN_MODEL, GEOM_NODE_TREE};
use livery_lib::game::gameres::index::IndexStore;
use livery_lib::game::gameres::skeleton::Skeleton;
use livery_lib::game::gameres::{desc, TEXTURE_OVERRIDES};
use livery_lib::textures::bc;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn game_root() -> PathBuf {
    std::env::var_os("LIVERY_REAL_GAME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\SteamLibrary\steamapps\common\War Thunder"))
}

fn worker_exe() -> PathBuf {
    std::env::var_os("LIVERY_WORKER_EXE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_livery")))
}

fn worker() -> OodleWorker {
    set_worker_exe(worker_exe());
    OodleWorker::new(worker_exe())
}

/// The Jumbo's DynModel resource bytes.
fn jumbo_model() -> Vec<u8> {
    let path = game_root().join("content/base/res/tanks/usa_m4a3e2_sherman_jumbo.grp");
    let file = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let grp = Grp::parse(&file, Some(file.len())).unwrap();
    let model = grp.find("m4a3e2_sherman_jumbo", DYN_MODEL).expect("the Jumbo's DynModel");
    file[model.start..model.end].to_vec()
}

/// Seeded xorshift, so a failure reproduces.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// The Jumbo's vertex block as a bare Oodle stream and its unpacked length. A DynModel starts
/// i32 resSz, texCount, matCount, vdataCount, u32 matVdataHdrSz (all tanks have
/// texCount = matCount = -1), then the block: u32 L (tag 2 = Oodle), u32 rawSize, the stream.
fn jumbo_vertex_stream() -> (Vec<u8>, Vec<u8>, usize) {
    let model = jumbo_model();
    let r = Reader::new(&model);
    assert_eq!((r.i32_at(4).unwrap(), r.i32_at(8).unwrap()), (-1, -1));
    let head = r.u32_at(20).unwrap();
    assert_eq!(head >> 30, 2, "an Oodle block");
    let raw_len = r.u32_at(24).unwrap() as usize;
    let stream = r.slice(28, (head & 0x3FFF_FFFF) as usize - 4).unwrap().to_vec();
    (model, stream, raw_len)
}

/// Every `.grp` pack of `content/base/res/tanks` parses (header part only, the file's length from
/// its metadata), with the resource table bounds the reader enforces.
#[test]
#[ignore = "reads the real War Thunder install"]
fn every_tank_pack_parses() {
    use std::io::Read;
    let dir = game_root().join("content/base/res/tanks");
    let (mut packs, mut resources, mut models) = (0, 0, 0);
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())).flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("grp") {
            continue;
        }
        let len = entry.metadata().unwrap().len() as usize;
        let mut head = [0u8; 16];
        let mut file = std::fs::File::open(&path).unwrap();
        file.read_exact(&mut head).unwrap();
        let full = u32::from_le_bytes([head[8], head[9], head[10], head[11]]) as usize;
        let mut desc = vec![0u8; 16 + full];
        std::io::Seek::rewind(&mut file).unwrap();
        file.read_exact(&mut desc).unwrap();
        let grp = Grp::parse(&desc, Some(len)).unwrap_or_else(|e| panic!("{}: {e:?}", path.display()));
        packs += 1;
        resources += grp.resources.len();
        models += grp.resources.iter().filter(|r| r.class_id == DYN_MODEL).count();
    }
    println!("{packs} packs, {resources} resources, {models} DynModels");
    assert!(packs > 900 && models > 3000, "{packs} packs, {models} DynModels");
}

#[test]
#[ignore = "reads the real War Thunder install"]
fn the_worker_decodes_the_jumbo_vertex_block() {
    let (model, stream, raw_len) = jumbo_vertex_stream();
    assert_eq!(raw_len, 3_820_392);
    let mut w = worker();
    let started = Instant::now();
    let direct = w.decode(&stream, raw_len).unwrap();
    println!(
        "vertex block: {} -> {} bytes in {} ms (worker start included)",
        stream.len(),
        direct.len(),
        started.elapsed().as_millis()
    );
    assert_eq!(direct.len(), 3_820_392);
    // The same bytes in-process (valid streams don't panic), and through `read_block` + the shared worker.
    assert_eq!(decode_in_process(&stream, raw_len, MAX_VERTEX_DATA).unwrap(), direct);
    assert_eq!(read_block(&mut Reader::new(&model[20..]), MAX_VERTEX_DATA).unwrap(), direct);
}

/// Statistics of a run of damaged copies.
#[derive(Debug, Default)]
struct Tally {
    decoded: usize,
    /// The header walk said no (and the worker repeated its message).
    refused: usize,
    /// Past the walk, the decoder returned an error.
    rejected_by_decoder: usize,
    /// Past the walk, the decoder asserted and the worker died; the caller got "oodle stream damaged".
    crashed: usize,
    /// Past the walk, the worker did not answer within the deadline and was killed.
    timed_out: usize,
}

/// Which part of a real stream the damage goes to.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Copies cut to 4096..40000 bytes with flips after the first 5 bytes: the first quantum
    /// always runs past the end, so the header walk refuses every one.
    Cut,
    /// The whole first 256 KiB block with flips in its first 5 bytes (block and quantum header).
    Headers,
    /// The whole first block with flips anywhere (half of them in the first 300 bytes).
    Block,
}

/// Damaged copies of a real stream, all through ONE worker handle (which starts a new worker
/// after each crash). Whenever the header walk refuses a copy, the error must be the walk's own;
/// whatever it lets through may decode, be refused by the decoder, or kill the worker, and the
/// last is reported as "oodle stream damaged" and nothing else.
fn mutate(w: &mut OodleWorker, rounds: usize, mode: Mode) -> Tally {
    let (_, stream, raw_len) = jumbo_vertex_stream();
    let quantum = u32::from_be_bytes([0, stream[2], stream[3], stream[4]]) & 0x3FFFF;
    let first_block = 5 + quantum as usize + 1;
    let mut rng = Rng(0x1234_5678_9ABC);
    let mut tally = Tally::default();
    for _ in 0..rounds {
        let take = if mode == Mode::Cut { 4096 + rng.next() as usize % 36_000 } else { first_block };
        let mut copy = stream[..take].to_vec();
        for _ in 0..1 + rng.next() % 6 {
            let at = match mode {
                Mode::Cut => 5 + rng.next() as usize % (take - 5),
                Mode::Headers => rng.next() as usize % 5,
                Mode::Block => rng.next() as usize % if rng.next().is_multiple_of(2) { 300 } else { take },
            };
            copy[at] ^= rng.next() as u8 | 1;
        }
        let len = match (mode == Mode::Cut, rng.next() % 4) {
            (false, 0 | 1) => 0x40000,
            (false, _) => 1 + rng.next() as usize % 0x40000,
            (true, 0) => raw_len,
            (true, 1) => 1 + rng.next() as usize % 200_000,
            (true, 2) => take * 4,
            (true, _) => 3_820_392,
        };
        let walk = check_kraken_family(&copy, len);
        if mode == Mode::Cut {
            assert!(walk.is_err(), "a cut copy of {take} bytes should fail the header walk");
        }
        match w.decode(&copy, len) {
            Ok(_) => {
                assert!(walk.is_ok());
                tally.decoded += 1;
            }
            Err(e) => {
                let detail = e.detail.unwrap_or_default();
                match walk {
                    Err(refused) => {
                        assert_eq!(
                            Some(detail.as_str()),
                            refused.detail.as_deref(),
                            "the worker repeats the walk's error"
                        );
                        tally.refused += 1;
                    }
                    Ok(()) if detail == "oodle stream damaged" => tally.crashed += 1,
                    Ok(()) if detail == "oodle stream timed out" => tally.timed_out += 1,
                    Ok(()) => {
                        assert!(
                            detail.starts_with("oodle: ") || detail.starts_with("Oodle stream unpacked"),
                            "unexpected error: {detail}"
                        );
                        tally.rejected_by_decoder += 1;
                    }
                }
            }
        }
    }
    tally
}

/// What the reviewer's fuzzer did to `oozextract` 0.5.5 (59 panics in BitKnit and LZNA): the
/// header walk refuses anything cut short, so no copy reaches the decoder.
#[test]
#[ignore = "reads the real War Thunder install"]
fn cut_streams_are_refused_by_the_header_walk() {
    let mut w = worker();
    let tally = mutate(&mut w, 20_000, Mode::Cut);
    println!("cut copies: {tally:?}");
    assert_eq!(tally.refused, 20_000);
}

/// Damage to the block and quantum headers: some of it still passes the walk (a smaller quantum
/// size, say) and then the decoder judges it.
#[test]
#[ignore = "reads the real War Thunder install"]
fn damaged_headers_are_refused_or_judged_by_the_decoder() {
    let mut w = worker();
    let tally = mutate(&mut w, 5_000, Mode::Headers);
    println!("damaged headers: {tally:?}");
    assert_eq!(tally.decoded + tally.refused + tally.rejected_by_decoder + tally.crashed + tally.timed_out, 5_000);
    assert!(tally.refused > 0);
}

/// Damage inside a complete block reaches the Kraken/Leviathan decoders of `oozextract` 0.5.5.
/// They `assert!` on bad data (about one block in eight), which ends the worker process. The
/// handle starts a new worker after each crash, and the test process never notices anything but
/// the "damaged" error (a 2 s deadline is set so that a hang would show up as "timed out").
#[test]
#[ignore = "reads the real War Thunder install"]
fn damaged_blocks_crash_the_worker_never_the_caller() {
    let (_, stream, _) = jumbo_vertex_stream();
    let mut w = worker();
    w.set_timeout(Duration::from_secs(2));
    let started = Instant::now();
    let tally = mutate(&mut w, 20_000, Mode::Block);
    println!("damaged blocks: {tally:?} in {} s", started.elapsed().as_secs());
    assert_eq!(tally.decoded + tally.refused + tally.rejected_by_decoder + tally.crashed + tally.timed_out, 20_000);
    assert_eq!(tally.timed_out, 0, "nothing should hang: {tally:?}");
    assert!(tally.crashed > 1_000, "about one block in eight should kill the worker: {tally:?}");
    assert!(tally.decoded > 0 && tally.rejected_by_decoder + tally.refused > 0);
    w.set_timeout(Duration::from_secs(10));
    // After all those crashes the handle still decodes the real thing.
    let quantum = u32::from_be_bytes([0, stream[2], stream[3], stream[4]]) & 0x3FFFF;
    let first_block = &stream[..5 + quantum as usize + 1];
    let good = w.decode(first_block, 0x40000).unwrap();
    assert_eq!(good, decode_in_process(first_block, 0x40000, MAX_VERTEX_DATA).unwrap());
}

/// Finds the Jumbo HQ texture streams (body 2048x2048, turret 2048x1024, gun 1024x512 are the
/// three largest `_c` entries of that pack) without the DxP2 reader: tries every Oodle block
/// start after the pack's directory with the unpacked sizes those textures have.
fn jumbo_texture_streams() -> Vec<(usize, Vec<u8>)> {
    let path = game_root().join("content.hq/hq_tex/res/hq_tex_tanks/usa_m4a3e2_sherman_jumbo.dxp.bin");
    let file = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let dump = u32::from_le_bytes(file[12..16].try_into().unwrap()) as usize;
    let mut w = worker();
    let mut found: Vec<(usize, Vec<u8>)> = Vec::new();
    let wanted = [4_194_316usize, 4_194_304, 2_097_164, 2_097_152, 524_300, 524_288];
    let mut at = 16 + dump;
    while at + 2 < file.len() && found.len() < 3 {
        if file[at] == 0x8C && file[at + 1] == 0x0C {
            for raw in wanted {
                if found.iter().any(|(r, _)| r.abs_diff(raw) < 16) {
                    continue;
                }
                if w.decode(&file[at..], raw).is_ok() {
                    found.push((raw, file[at..].to_vec()));
                    break;
                }
            }
            at += 1000;
        } else {
            at += 1;
        }
    }
    found
}

/// The four Jumbo streams (vertex block and three textures), one worker against in-process.
#[test]
#[ignore = "reads the real War Thunder install; timing"]
fn worker_against_in_process_on_the_jumbo_streams() {
    let (_, vertex, vertex_raw) = jumbo_vertex_stream();
    let mut streams = vec![(vertex_raw, vertex)];
    streams.extend(jumbo_texture_streams());
    println!("{} streams: raw sizes {:?}", streams.len(), streams.iter().map(|(r, _)| *r).collect::<Vec<_>>());

    let started = Instant::now();
    let mut in_process = Vec::new();
    for (raw, src) in &streams {
        let t = Instant::now();
        let out = decode_in_process(src, *raw, MAX_VERTEX_DATA).unwrap();
        println!("  in-process {raw:>8}: {:>4} ms", t.elapsed().as_millis());
        in_process.push(out);
    }
    println!("in-process total: {} ms", started.elapsed().as_millis());

    let mut w = worker();
    let started = Instant::now();
    for (i, (raw, src)) in streams.iter().enumerate() {
        let t = Instant::now();
        let out = w.decode(src, *raw).unwrap();
        println!(
            "  worker     {raw:>8}: {:>4} ms{}",
            t.elapsed().as_millis(),
            if i == 0 { " (includes the worker's start)" } else { "" }
        );
        assert_eq!(out, in_process[i]);
    }
    println!("worker total (one handle): {} ms", started.elapsed().as_millis());

    // Through the process-wide convenience too.
    let started = Instant::now();
    for (raw, src) in &streams {
        oodle(src, *raw, MAX_VERTEX_DATA).unwrap();
    }
    println!("oodle() total (shared worker, already warm after the first): {} ms", started.elapsed().as_millis());
}

// ── DynModel, skeleton, materials, textures ─────────────────────────────────

/// The Jumbo's LOD 0 as the Phase 0 spike measured it: 85 rigids, vdata 6 with 106,485 vertices,
/// 114,725 vertices / 99,202 triangles once each element's referenced vertices are copied out.
#[test]
#[ignore = "reads the real War Thunder install"]
fn the_jumbo_dynmodel_parses() {
    set_worker_exe(worker_exe());
    let bytes = jumbo_model();
    let started = Instant::now();
    let model = dynmodel::parse(&bytes).unwrap();
    println!("DynModel parsed in {} ms", started.elapsed().as_millis());
    assert_eq!(model.rigids.len(), 85);
    assert_eq!(model.vdata.len(), 8);
    assert_eq!(model.vdata[6].positions.len(), 106_485);
    for (i, v) in model.vdata.iter().enumerate() {
        println!(
            "  vdata {i}: {} vertices, {} indices, packed {}",
            v.positions.len(),
            v.indices.len(),
            v.packed_indices
        );
    }
    println!("  {} node names", model.node_names.len());
    assert_eq!(model.node_names.len(), 115);

    let (mut vertices, mut triangles) = (0, 0);
    for rigid in &model.rigids {
        assert!(model.node_names.contains_key(&rigid.node_id), "node {}", rigid.node_id);
        for elem in &rigid.elems {
            let vdata = &model.vdata[elem.vdata as usize];
            let used: std::collections::BTreeSet<usize> = elem.vertex_indices(vdata).collect();
            vertices += used.len();
            triangles += elem.numf as usize;
            for &v in &used {
                assert!(v < vdata.positions.len());
            }
        }
    }
    println!("LOD 0: {vertices} vertices, {triangles} triangles");
    assert_eq!((vertices, triangles), (114_725, 99_202));
}

/// Every DynModel of the tank packs that isn't a damage or x-ray variant parses (all of them go
/// through Oodle), so a layout or limit the reader refuses shows up here first.
#[test]
#[ignore = "reads the real War Thunder install; slow"]
fn every_tank_dynmodel_parses() {
    set_worker_exe(worker_exe());
    let dir = game_root().join("content/base/res/tanks");
    let started = Instant::now();
    let (mut models, mut packed, mut failed) = (0, 0usize, Vec::new());
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("grp") {
            continue;
        }
        let file = std::fs::read(&path).unwrap();
        let grp = Grp::parse(&file, Some(file.len())).unwrap();
        for res in grp.resources.iter().filter(|r| r.class_id == DYN_MODEL) {
            if res.name.ends_with("_dmg") || res.name.ends_with("_xray") || res.start == 0 {
                continue;
            }
            models += 1;
            match dynmodel::parse(&file[res.start..res.end]) {
                Ok(m) => packed += m.vdata.iter().filter(|v| v.packed_indices).count(),
                Err(e) => failed.push(format!("{}: {:?}", res.name, e.detail)),
            }
        }
    }
    println!(
        "{models} models in {} s, {packed} packed index buffers among LOD 0's, {} failed",
        started.elapsed().as_secs(),
        failed.len()
    );
    for f in failed.iter().take(20) {
        println!("  {f}");
    }
    assert!(models > 1000);
    // 2026-10-16: one model (`9a35m2`) has FLOAT3 positions in LOD 0, which the reader refuses
    // by design (the unpack constants apply to SHORT4N only); nothing else may fail.
    assert!(failed.iter().all(|f| f.contains("vertex layout")), "{failed:?}");
    assert!(failed.len() <= 5, "{failed:?}");
}

fn jumbo_pack() -> Vec<u8> {
    let path = game_root().join("content/base/res/tanks/usa_m4a3e2_sherman_jumbo.grp");
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The Jumbo's skeleton: 169 nodes with the turret and gun bones, and every LOD 0 rigid but the
/// `@root` ones sits on a node of it.
#[test]
#[ignore = "reads the real War Thunder install"]
fn the_jumbo_skeleton_places_every_rigid() {
    set_worker_exe(worker_exe());
    let file = jumbo_pack();
    let grp = Grp::parse(&file, Some(file.len())).unwrap();
    let res = grp.find("m4a3e2_sherman_jumbo_skeleton", GEOM_NODE_TREE).unwrap();
    let skeleton = Skeleton::parse(&file[res.start..res.end]).unwrap();
    assert_eq!(skeleton.nodes.len(), 169);
    let gun = skeleton.ancestry("bone_gun");
    println!("bone_gun ancestry: {gun:?}");
    assert!(gun.contains(&"bone_turret"), "{gun:?}");
    assert!(skeleton.by_name("bone_turret").is_some());
    assert!(skeleton.nodes[1..].iter().all(|n| n.parent.is_some()), "one root");

    let model = dynmodel::parse(&jumbo_model()).unwrap();
    let mut missing = std::collections::BTreeSet::new();
    for rigid in &model.rigids {
        let name = &model.node_names[&rigid.node_id];
        if skeleton.by_name(name).is_none() {
            missing.insert(name.clone());
        }
    }
    println!("rigid nodes missing from the skeleton: {missing:?}");
    assert_eq!(missing.into_iter().collect::<Vec<_>>(), ["@root"]);
}

/// Every skeleton of the tank packs parses (none is compressed today).
#[test]
#[ignore = "reads the real War Thunder install"]
fn every_tank_skeleton_parses() {
    set_worker_exe(worker_exe());
    let dir = game_root().join("content/base/res/tanks");
    let (mut count, mut failed) = (0, Vec::new());
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("grp") {
            continue;
        }
        let file = std::fs::read(&path).unwrap();
        let grp = Grp::parse(&file, Some(file.len())).unwrap();
        for res in grp.resources.iter().filter(|r| r.class_id == GEOM_NODE_TREE && r.start != 0) {
            count += 1;
            if let Err(e) = Skeleton::parse(&file[res.start..res.end]) {
                failed.push(format!("{}: {:?}", res.name, e.detail));
            }
        }
    }
    println!("{count} skeletons, {} failed {:?}", failed.len(), failed.iter().take(10).collect::<Vec<_>>());
    assert!(count > 3000 && failed.is_empty());
}

/// dynModelDesc.bin binds the Jumbo's rigid materials 0, 1 and 3 to its body, turret and gun.
#[test]
#[ignore = "reads the real War Thunder install"]
fn the_jumbo_materials_name_its_diffuse_textures() {
    let path = game_root().join("content/base/res/dynModelDesc.bin");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(bytes[0], 2, "a kind 2 BLK");
    let desc = Blk::parse(&bytes, None, None).unwrap();
    let m = materials(&desc, "m4a3e2_sherman_jumbo").unwrap();
    println!("{} textures, {} rigid materials", m.textures.len(), m.diffuse_of_mat.len());
    for (i, d) in m.diffuse_of_mat.iter().enumerate() {
        println!("  mat {i}: {d:?}");
    }
    assert_eq!(m.textures.len(), 39);
    assert_eq!(m.diffuse_of_mat.len(), 17);
    let d = |i: usize| m.diffuse_of_mat[i].as_deref();
    assert_eq!(d(0), Some("m4a3e2_sherman_jumbo_body_c"));
    assert_eq!(d(1), Some("m4a3e2_sherman_jumbo_turret_c"));
    assert_eq!(d(3), Some("m4a3e2_sherman_jumbo_gun_c"));
    assert_eq!(d(14), Some("m4a3e2_sherman_jumbo_body_c"));
    assert!(m.textures.iter().any(|t| t == "us_camo_olive"));
}

/// A pack's first `16 + dumpSize` bytes and the file's length.
fn dxp_head(path: &std::path::Path) -> (Vec<u8>, u64) {
    use std::io::Read;
    let mut file = std::fs::File::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let len = file.metadata().unwrap().len();
    let mut head = vec![0u8; 16];
    file.read_exact(&mut head).unwrap();
    let dump = u32::from_le_bytes(head[12..16].try_into().unwrap()) as usize;
    head.resize(16 + dump, 0);
    file.read_exact(&mut head[16..]).unwrap();
    (head, len)
}

/// An uncompressed 24/32-bit TGA as RGBA8 (top row first).
fn read_tga(bytes: &[u8]) -> (usize, usize, Vec<u8>) {
    let id_len = bytes[0] as usize;
    assert_eq!(bytes[1], 0, "no colour map");
    assert_eq!(bytes[2], 2, "uncompressed true colour");
    let w = u16::from_le_bytes([bytes[12], bytes[13]]) as usize;
    let h = u16::from_le_bytes([bytes[14], bytes[15]]) as usize;
    let bpp = bytes[16] as usize / 8;
    assert!(bpp == 3 || bpp == 4, "{bpp} bytes per pixel");
    let top_first = bytes[17] & 0x20 != 0;
    let pixels = &bytes[18 + id_len..];
    let mut out = vec![0u8; w * h * 4];
    for row in 0..h {
        let y = if top_first { row } else { h - 1 - row };
        for x in 0..w {
            let p = &pixels[(row * w + x) * bpp..];
            let at = 4 * (y * w + x);
            out[at..at + 4].copy_from_slice(&[p[2], p[1], p[0], if bpp == 4 { p[3] } else { 255 }]);
        }
    }
    (w, h, out)
}

/// The Jumbo's HQ pack: body, turret and gun `_c` are DXT5 at template size and decode; the body
/// doubled matches the template the game installs for skin makers.
#[test]
#[ignore = "reads the real War Thunder install"]
fn the_jumbo_hq_textures_decode_and_match_the_template() {
    set_worker_exe(worker_exe());
    let path = game_root().join("content.hq/hq_tex/res/hq_tex_tanks/usa_m4a3e2_sherman_jumbo.dxp.bin");
    let dir = DxpDir::parse(&dxp_head(&path).0).unwrap();
    let mut file = std::fs::File::open(&path).unwrap();
    println!("{} entries", dir.entries.len());

    let mut body = None;
    for (texture, w, h) in [("body_c", 2048, 2048), ("turret_c", 2048, 1024), ("gun_c", 1024, 512)] {
        let base = format!("m4a3e2_sherman_jumbo_{texture}");
        let e = dir
            .entries
            .iter()
            .find(|e| base_name(&e.name) == base && is_hq(&e.name))
            .unwrap_or_else(|| panic!("{base}$hq"));
        println!(
            "  {} {:?} {}x{} levels {} flags {:#X}",
            e.name, e.header.fourcc, e.header.w, e.header.h, e.header.levels, e.header.flags
        );
        assert_eq!((&e.header.fourcc, e.header.w, e.header.h), (b"DXT5", w, h));
        let started = Instant::now();
        let blocks = top_level(&mut file, e).unwrap();
        let rgba = bc::decode(&e.header.fourcc, &blocks, w as usize, h as usize).unwrap();
        println!("    decoded in {} ms", started.elapsed().as_millis());
        if texture == "body_c" {
            body = Some(rgba);
        }
    }

    let template = game_root().join("UserSkins/template_us_m4a3e2_sherman_jumbo/m4a3e2_sherman_jumbo_body.tga");
    let Ok(tga) = std::fs::read(&template) else {
        println!("no template at {}: comparison skipped", template.display());
        return;
    };
    let (tw, th, tpx) = read_tga(&tga);
    assert_eq!((tw, th), (2048, 2048));
    let body = body.unwrap();
    let mut sum = 0u64;
    for (game, tmpl) in body.as_chunks::<4>().0.iter().zip(tpx.as_chunks::<4>().0) {
        for c in 0..3 {
            sum += u64::from((u16::from(game[c]) * 2).min(255).abs_diff(u16::from(tmpl[c])));
        }
    }
    let mae = sum as f64 / (tw * th * 3) as f64;
    println!("body x2 vs template: mean abs error {mae:.2}");
    assert!(mae < 10.0, "{mae}");
}

/// Every texture pack directory of the tank folders parses (header part only).
#[test]
#[ignore = "reads the real War Thunder install"]
fn every_tank_texture_pack_directory_parses() {
    let mut packs = 0;
    let mut entries = 0;
    for dir in ["content/base/res/tanks", "content.hq/hq_tex/res/hq_tex_tanks"] {
        let Ok(list) = std::fs::read_dir(game_root().join(dir)) else { continue };
        for entry in list.flatten() {
            let path = entry.path();
            if !path.to_string_lossy().ends_with(".dxp.bin") {
                continue;
            }
            let (head, len) = dxp_head(&path);
            let parsed = DxpDir::parse(&head).unwrap_or_else(|e| panic!("{}: {e:?}", path.display()));
            for e in &parsed.entries {
                assert!(e.ofs + u64::from(e.data_size) <= len, "{} in {}", e.name, path.display());
            }
            packs += 1;
            entries += parsed.entries.len();
        }
    }
    println!("{packs} packs, {entries} textures");
    assert!(packs > 100);
}

// ── Index and assembled model ───────────────────────────────────────────────

/// Share of triangles whose counter-clockwise face normal points the way their vertex normals
/// do (the right-handed front face three.js culls by).
fn facing_normals(m: &assemble::VehicleModel) -> f64 {
    let at = |a: &[f32], i: u32| [0, 1, 2].map(|k| a[3 * i as usize + k]);
    let (mut agree, mut total) = (0usize, 0usize);
    for t in m.indices.as_chunks::<3>().0 {
        let [a, b, c] = [at(&m.positions, t[0]), at(&m.positions, t[1]), at(&m.positions, t[2])];
        let (e1, e2) = ([0, 1, 2].map(|k| b[k] - a[k]), [0, 1, 2].map(|k| c[k] - a[k]));
        let face = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        let n = [0, 1, 2].map(|k| at(&m.normals, t[0])[k] + at(&m.normals, t[1])[k] + at(&m.normals, t[2])[k]);
        let dot = face[0] * n[0] + face[1] * n[1] + face[2] * n[2];
        if dot.abs() > 1e-12 {
            total += 1;
            agree += usize::from(dot > 0.0);
        }
    }
    agree as f64 / total.max(1) as f64
}

/// The index (first build, then a cached load in a new store), the Jumbo assembled, its body
/// template against the game's skin template, and two more tanks.
#[test]
#[ignore = "reads the real War Thunder install"]
fn the_jumbo_is_assembled_from_the_index() {
    set_worker_exe(worker_exe());
    let root = game_root();
    let cache = std::env::temp_dir().join(format!("livery-atelier-real-{}/gameres-index.json", std::process::id()));
    let started = Instant::now();
    let index = IndexStore::new(cache.clone()).get(&root).unwrap();
    println!(
        "index built in {} ms: {} vehicles, {} models, {} textures, {} overriding; version {}",
        started.elapsed().as_millis(),
        index.model_of.len(),
        index.grp_of.len(),
        index.tex_of.len(),
        index.overrides_of.len(),
        index.version
    );
    let started = Instant::now();
    let cached = IndexStore::new(cache.clone()).get(&root).unwrap();
    println!(
        "cached index loaded in {} ms ({} bytes)",
        started.elapsed().as_millis(),
        std::fs::metadata(&cache).unwrap().len()
    );
    assert_eq!(*cached, *index);
    let _ = std::fs::remove_dir_all(cache.parent().unwrap());

    assert_eq!(index.model("us_m4a3e2_sherman_jumbo"), Some("m4a3e2_sherman_jumbo"));
    assert_eq!(index.model("us_m4a3e2_sherman_jumbo_cobra_king"), Some("m4a3e2_sherman_jumbo"));
    assert!(index.overrides("us_m4a3e2_sherman_jumbo_cobra_king"));
    assert!(!index.overrides("us_m4a3e2_sherman_jumbo"));
    println!("overriding vehicles (first 15): {:?}", index.overrides_of.iter().take(15).collect::<Vec<_>>());
    assert_eq!(index.grp_of["m4a3e2_sherman_jumbo"], "content/base/res/tanks/usa_m4a3e2_sherman_jumbo.grp");

    let desc = desc::read(&root).unwrap();
    let e = assemble::load(&root, &index, &desc, "us_m4a3e2_sherman_jumbo_cobra_king").unwrap_err();
    assert_eq!(e.message, TEXTURE_OVERRIDES);

    let started = Instant::now();
    let m = assemble::load(&root, &index, &desc, "us_m4a3e2_sherman_jumbo").unwrap();
    println!("Jumbo assembled in {} ms", started.elapsed().as_millis());
    assert_eq!(m.model, "m4a3e2_sherman_jumbo");
    for s in &m.slots {
        println!("  slot {} {}x{} hq {} paintable {}", s.texture, s.width, s.height, s.hq, s.paintable_by_default);
        assert!(s.width > 0 && s.height > 0, "{s:?}");
    }
    let slot = |name: &str| m.slots.iter().find(|s| s.texture == name).unwrap_or_else(|| panic!("{name}"));
    let body = slot("m4a3e2_sherman_jumbo_body_c");
    assert_eq!((body.width, body.height, body.hq, body.paintable_by_default), (2048, 2048, true, true));
    let turret = slot("m4a3e2_sherman_jumbo_turret_c");
    assert_eq!((turret.width, turret.height), (2048, 1024));
    let gun = slot("m4a3e2_sherman_jumbo_gun_c");
    assert_eq!((gun.width, gun.height), (1024, 512));
    let vertices = m.positions.len() / 3;
    let count = |g: PartGroup| m.parts.iter().filter(|p| p.group == g).count();
    println!(
        "  {vertices} vertices, {} triangles, {} parts: {} hull, {} turret, {} gun",
        m.indices.len() / 3,
        m.parts.len(),
        count(PartGroup::Hull),
        count(PartGroup::Turret),
        count(PartGroup::Gun)
    );
    assert!(vertices > 100_000, "{vertices}");
    assert!(count(PartGroup::Hull) > 0 && count(PartGroup::Turret) > 0 && count(PartGroup::Gun) > 0);
    assert!(m.indices.iter().all(|&i| (i as usize) < vertices));
    let facing = facing_normals(&m);
    println!("  {:.2}% of triangles face their normals (counter-clockwise, right-handed)", 100.0 * facing);
    assert!(facing > 0.99, "{facing}");
    let encoded = assemble::encode(&m);
    println!("  encoded: {} bytes", encoded.len());

    let started = Instant::now();
    let rgba = assemble::template_texture(&root, &index, body).unwrap();
    println!("body template decoded in {} ms", started.elapsed().as_millis());
    let template = root.join("UserSkins/template_us_m4a3e2_sherman_jumbo/m4a3e2_sherman_jumbo_body.tga");
    if let Ok(tga) = std::fs::read(&template) {
        let (tw, th, tpx) = read_tga(&tga);
        assert_eq!((tw, th), (2048, 2048));
        let sum: u64 = rgba
            .as_chunks::<4>()
            .0
            .iter()
            .zip(tpx.as_chunks::<4>().0)
            .map(|(a, b)| (0..3).map(|c| u64::from(a[c].abs_diff(b[c]))).sum::<u64>())
            .sum();
        let mae = sum as f64 / (tw * th * 3) as f64;
        println!("body template vs the game's TGA: mean abs error {mae:.2}");
        assert!(mae < 10.0, "{mae}");
    } else {
        println!("no template at {}: comparison skipped", template.display());
    }

    for vehicle in ["us_m4a3e2_76w_sherman_jumbo", "germ_pzkpfw_VI_ausf_b_tiger_IIh"] {
        let started = Instant::now();
        let m = assemble::load(&root, &index, &desc, vehicle).unwrap_or_else(|e| panic!("{vehicle}: {e:?}"));
        println!(
            "{vehicle}: {} in {} ms, {} vertices, {} parts, slots {:?}",
            m.model,
            started.elapsed().as_millis(),
            m.positions.len() / 3,
            m.parts.len(),
            m.slots.iter().map(|s| (s.texture.as_str(), s.width, s.height, s.paintable_by_default)).collect::<Vec<_>>()
        );
        assert!(m.slots.iter().all(|s| s.width > 0 && s.height > 0));
        let facing = facing_normals(&m);
        println!("  {:.2}% of triangles face their normals", 100.0 * facing);
        assert!(facing > 0.99, "{vehicle}: {facing}");
        // Body, turret and gun are painted by default (the 76W's body and turret are the
        // Jumbo's textures); shared ones (machine guns, nets, tracks, barrels, glass) aren't.
        let paintable: Vec<&str> =
            m.slots.iter().filter(|s| s.paintable_by_default).map(|s| s.texture.as_str()).collect();
        for part in ["_body_c", "_turret_c", "_gun_c"] {
            assert!(paintable.iter().any(|t| t.ends_with(part)), "{vehicle}: no {part} in {paintable:?}");
        }
        for s in m.slots.iter().filter(|s| {
            ["mg_", "us_net", "net_", "_track_c", "rifled_barrel", "headlight"].iter().any(|k| s.texture.contains(k))
        }) {
            assert!(!s.paintable_by_default, "{vehicle}: {} is shared", s.texture);
        }
        if vehicle == "us_m4a3e2_76w_sherman_jumbo" {
            let mut own = paintable.clone();
            own.sort_unstable();
            assert_eq!(
                own,
                ["m4a3e2_76w_sherman_jumbo_gun_c", "m4a3e2_sherman_jumbo_body_c", "m4a3e2_sherman_jumbo_turret_c"]
            );
        }
    }
}

/// Over the ground vehicles: how many have a model the packs don't list, how many sampled ones
/// load (failures by error), and how many rigids sit on mirrored nodes (their winding isn't
/// flipped). Every `LIVERY_SAMPLE_STEP`-th vehicle in code order (default 10).
#[test]
#[ignore = "reads the real War Thunder install; slow"]
fn a_sample_of_vehicles_loads() {
    set_worker_exe(worker_exe());
    let root = game_root();
    let step: usize = std::env::var("LIVERY_SAMPLE_STEP").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
    let index = livery_lib::game::gameres::index::build(&root).unwrap();
    let desc = desc::read(&root).unwrap();
    let mut codes: Vec<&str> = index.model_of.keys().map(String::as_str).collect();
    codes.sort_unstable();
    let no_pack: Vec<&str> =
        codes.iter().copied().filter(|c| !index.grp_of.contains_key(&index.model_of[*c])).collect();
    println!(
        "{} vehicles, {} with a model no pack lists (first 10: {:?})",
        codes.len(),
        no_pack.len(),
        &no_pack[..no_pack.len().min(10)]
    );

    let started = Instant::now();
    let (mut loaded, mut failures) = (0, std::collections::BTreeMap::<String, Vec<&str>>::new());
    let (mut worst, mut inside_out) = (1.0f64, Vec::new());
    let (mut rigids, mut mirrored, mut mirrored_models) = (0, 0, 0);
    for &code in codes.iter().step_by(step.max(1)) {
        match assemble::load(&root, &index, &desc, code) {
            Ok(m) => {
                loaded += 1;
                let facing = facing_normals(&m);
                worst = worst.min(facing);
                if facing < 0.98 {
                    inside_out.push((code, facing));
                }
            }
            Err(e) => {
                let detail = e.detail.unwrap_or_default();
                let kind = if detail.contains("vertex layout") { "vertex layout".to_string() } else { e.message };
                failures.entry(format!("{:?}: {kind}", e.code)).or_default().push(code);
            }
        }
        // Mirrored nodes, read the way `load` places rigids.
        let model = &index.model_of[code];
        let Some(pack) = index.grp_of.get(model) else { continue };
        let Ok(file) = std::fs::read(root.join(pack)) else { continue };
        let Ok(grp) = Grp::parse(&file, Some(file.len())) else { continue };
        let (Some(dm), Some(sk)) = (grp.find(model, DYN_MODEL), grp.find(&format!("{model}_skeleton"), GEOM_NODE_TREE))
        else {
            continue;
        };
        let (Ok(dm), Ok(sk)) = (dynmodel::parse(&file[dm.start..dm.end]), Skeleton::parse(&file[sk.start..sk.end]))
        else {
            continue;
        };
        let before = mirrored;
        for rigid in &dm.rigids {
            rigids += 1;
            let node = dm.node_names.get(&rigid.node_id).and_then(|n| sk.by_name(n));
            if node.is_some_and(|n| assemble::determinant(&n.wtm) < 0.0) {
                mirrored += 1;
            }
        }
        if mirrored > before {
            mirrored_models += 1;
        }
    }
    let sampled = loaded + failures.values().map(Vec::len).sum::<usize>();
    println!("{sampled} sampled in {} s: {loaded} loaded", started.elapsed().as_secs());
    for (kind, codes) in &failures {
        println!("  {kind}: {} {:?}", codes.len(), &codes[..codes.len().min(8)]);
    }
    println!("{rigids} LOD 0 rigids, {mirrored} on mirrored nodes (in {mirrored_models} models)");
    println!(
        "triangles facing their normals: worst model {:.2}%, {} models under 98% {inside_out:?}",
        100.0 * worst,
        inside_out.len()
    );
    assert!(inside_out.len() * 20 <= loaded, "winding looks wrong on many models: {inside_out:?}");
    let refused = |k: &str| k.contains("can't paint this vehicle yet") || k.contains("vertex layout");
    let other: usize = failures.iter().filter(|(k, _)| !refused(k)).map(|(_, v)| v.len()).sum();
    assert!(other * 20 <= sampled, "more than 5% fail for other reasons: {failures:?}");
}

// ── Background removal (real runtime and model; nothing from the network) ───

fn env_path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(default))
}

/// The real pinned runtime (from this platform's archive in `LIVERY_ORT_ARCHIVE`) and model (`LIVERY_ISNET_MODEL`)
/// copied into a temp models folder; an anime picture's cut-out (`LIVERY_CUTOUT_SOURCE`, RGBA)
/// composited over a flat background. The cut must cover the subject and make the background
/// transparent.
#[test]
#[ignore = "needs the downloaded ONNX Runtime archive and the isnet-anime model"]
fn background_removal_cuts_out_an_anime_picture() {
    use image::{Rgba, RgbaImage};
    use livery_lib::atelier::cutout::{alpha_bbox, ALPHA_THRESHOLD, CROP_MARGIN, UNMIX_ALPHA};
    use livery_lib::atelier::models::{extract_runtime, pinned, ModelFiles};
    use livery_lib::atelier::CutoutState;

    let archive = env_path(
        "LIVERY_ORT_ARCHIVE",
        r"C:\Users\piera\AppData\Local\Temp\claude\D--Dev-Progetti-Livery\f0929977-7776-4221-ba0c-79874e5498b5\scratchpad\downloads\onnxruntime-win-x64-1.30.0.zip",
    );
    let model = env_path("LIVERY_ISNET_MODEL", r"C:\Users\piera\.u2net\isnet-anime.onnx");
    let cut_source =
        env_path("LIVERY_CUTOUT_SOURCE", r"D:\Dev\Progetti\Livery-skin-lab\jumbo-megumin\megumin_isnet.png");

    let dir = std::env::temp_dir().join(format!("livery-real-cutout-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let models = dir.join("models");
    let files = ModelFiles::new(&models);
    let pins = pinned();
    let (format, hash) = (pins.runtime_format, &pins.runtime_archive.hash);
    extract_runtime(&archive, format, hash, &pins.dll_entry, &pins.dll, &files.runtime_dll()).unwrap();
    std::fs::copy(&model, files.model_path()).unwrap();
    let state = CutoutState::new(&models);
    let status = state.files.status();
    assert!(status.runtime && status.model, "{status:?}");

    // The subject over a flat blue, with 200 px of background around it.
    let subject = image::open(&cut_source).unwrap().into_rgba8();
    let pad = 200;
    let bg = [40u16, 120, 200];
    let source = RgbaImage::from_fn(subject.width() + 2 * pad, subject.height() + 2 * pad, |x, y| {
        let inside = x >= pad && y >= pad && x < subject.width() + pad && y < subject.height() + pad;
        let fg = if inside { *subject.get_pixel(x - pad, y - pad) } else { Rgba([0, 0, 0, 0]) };
        let a = u16::from(fg[3]);
        let mix = |c: usize| ((u16::from(fg[c]) * a + bg[c] * (255 - a) + 127) / 255) as u8;
        Rgba([mix(0), mix(1), mix(2), 255])
    });
    let truth = alpha_bbox(&subject, ALPHA_THRESHOLD).unwrap();
    let truth = livery_lib::model::PixelRect { x: truth.x + pad, y: truth.y + pad, ..truth };

    let started = Instant::now();
    let mut steps = Vec::new();
    let (cut, crop) = state.cut(&source, &mut |s| steps.push(s)).unwrap();
    let first = started.elapsed();
    let started = Instant::now();
    state.cut(&source, &mut |_| {}).unwrap();
    let second = started.elapsed();
    println!(
        "cutout of {}x{}: first run (load + run) {first:?}, second run {second:?}; crop {crop:?}, subject {truth:?}",
        source.width(),
        source.height()
    );
    assert_eq!(steps.len(), 2);
    assert!(state.cutout.runtime_loaded());

    // The crop covers the subject (within a little of the model's edge) and not much background.
    let slack = CROP_MARGIN + 60;
    assert!(crop.x <= truth.x + 40 && crop.y <= truth.y + 40, "{crop:?} vs {truth:?}");
    assert!(
        crop.x + crop.w + 40 >= truth.x + truth.w && crop.y + crop.h + 40 >= truth.y + truth.h,
        "{crop:?} vs {truth:?}"
    );
    assert!(crop.x + slack >= truth.x && crop.y + slack >= truth.y, "{crop:?} vs {truth:?}");
    assert!(
        crop.x + crop.w <= truth.x + truth.w + slack && crop.y + crop.h <= truth.y + truth.h + slack,
        "{crop:?} vs {truth:?}"
    );

    // Background transparent, subject opaque, colours as in the source.
    let (mut bg_px, mut bg_clear, mut fg_px, mut fg_solid) = (0u64, 0u64, 0u64, 0u64);
    let (mut edges, mut raw_error, mut clean_error) = (0u64, 0u64, 0u64);
    for (x, y, px) in cut.enumerate_pixels() {
        let (sx, sy) = (crop.x + x, crop.y + y);
        let inside = sx >= pad && sy >= pad && sx < subject.width() + pad && sy < subject.height() + pad;
        let a = if inside { subject.get_pixel(sx - pad, sy - pad)[3] } else { 0 };
        // Edge pixels are un-mixed from the flat blue; the others keep the source's colour.
        let alpha = f32::from(px[3]) / 255.0;
        if alpha <= UNMIX_ALPHA.0 || alpha >= UNMIX_ALPHA.1 {
            assert_eq!(px.0[..3], source.get_pixel(sx, sy).0[..3]);
        } else if a >= 64 {
            // Against the subject's true colour: the cleaned edge must be closer than the blend.
            let truth = subject.get_pixel(sx - pad, sy - pad);
            let raw = source.get_pixel(sx, sy);
            let off = |p: &[u8]| (0..3).map(|c| u64::from(p[c].abs_diff(truth[c]))).sum::<u64>();
            edges += 1;
            raw_error += off(&raw.0);
            clean_error += off(&px.0);
        }
        if a == 0 {
            bg_px += 1;
            bg_clear += u64::from(px[3] < ALPHA_THRESHOLD);
        } else if a >= 200 {
            fg_px += 1;
            fg_solid += u64::from(px[3] >= 150);
        }
    }
    let per = |e: u64| e as f64 / edges.max(1) as f64 / 3.0;
    println!(
        "background clear {bg_clear}/{bg_px}, subject solid {fg_solid}/{fg_px}; {edges} edge pixels off their true \
         colour by {:.1} blended, {:.1} cleaned (mean per channel)",
        per(raw_error),
        per(clean_error)
    );
    assert!(clean_error < raw_error, "edges not cleaner: {clean_error} vs {raw_error}");
    assert!(bg_clear * 100 >= bg_px * 97, "background left: {bg_clear}/{bg_px}");
    assert!(fg_solid * 100 >= fg_px * 95, "subject lost: {fg_solid}/{fg_px}");

    // Removing now marks the folder: this process holds the DLL.
    let status = state.remove().unwrap();
    assert!(status.pending_removal);
    drop(state);
    let _ = std::fs::remove_dir_all(&dir);
}
