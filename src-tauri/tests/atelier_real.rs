//! Atelier against the real War Thunder install (ignored: reads the machine's game files,
//! read-only, nothing is written there).
//! `cargo test --test atelier_real -- --ignored --nocapture`. The game root comes from
//! `LIVERY_REAL_GAME`, else the default Steam path. Oodle streams are decoded by the worker
//! process, which is the `livery` executable of this test build unless `LIVERY_WORKER_EXE`
//! names another one (for example `target/release/livery.exe`).

use livery_lib::game::gameres::bytes::Reader;
use livery_lib::game::gameres::codec::{
    check_kraken_family, decode_in_process, oodle, read_block, set_worker_exe, OodleWorker, MAX_VERTEX_DATA,
};
use livery_lib::game::gameres::dynmodel;
use livery_lib::game::gameres::grp::{Grp, DYN_MODEL};
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
    /// Past the walk, the decoder looped (release builds wrap arithmetic where debug builds panic)
    /// until the deadline killed the worker.
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
                Mode::Block => rng.next() as usize % if rng.next() % 2 == 0 { 300 } else { take },
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
/// They `assert!` on bad data (about one block in eight), which ends the worker process, and in
/// release builds (arithmetic wraps instead of panicking) some copies loop until the deadline
/// kills the worker. The handle starts a new worker after each crash or timeout, and the test
/// process never notices anything but the "damaged" and "timed out" errors. 2,000 rounds (not
/// 20,000): every crash costs a process start and every hang the 2 s deadline set here.
#[test]
#[ignore = "reads the real War Thunder install"]
fn damaged_blocks_crash_the_worker_never_the_caller() {
    let (_, stream, _) = jumbo_vertex_stream();
    let mut w = worker();
    w.set_timeout(Duration::from_secs(2));
    let started = Instant::now();
    let tally = mutate(&mut w, 2_000, Mode::Block);
    println!("damaged blocks: {tally:?} in {} s", started.elapsed().as_secs());
    assert_eq!(tally.decoded + tally.refused + tally.rejected_by_decoder + tally.crashed + tally.timed_out, 2_000);
    assert!(tally.crashed > 50, "about one block in eight should kill the worker: {tally:?}");
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
