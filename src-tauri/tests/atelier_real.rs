//! Atelier against the real War Thunder install (ignored: reads the machine's game files,
//! read-only, nothing is written there).
//! `cargo test --test atelier_real -- --ignored --nocapture`. The game root comes from
//! `LIVERY_REAL_GAME`, else the default Steam path.

use livery_lib::game::gameres::bytes::Reader;
use livery_lib::game::gameres::codec::{oodle, read_block, MAX_VERTEX_DATA};
use livery_lib::game::gameres::grp::{Grp, DYN_MODEL};
use std::path::PathBuf;

fn game_root() -> PathBuf {
    std::env::var_os("LIVERY_REAL_GAME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\SteamLibrary\steamapps\common\War Thunder"))
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

#[test]
#[ignore = "reads the real War Thunder install"]
fn oodle_decodes_the_jumbo_vertex_block() {
    let (model, stream, raw_len) = jumbo_vertex_stream();
    assert_eq!(raw_len, 3_820_392);
    let started = std::time::Instant::now();
    let direct = oodle(&stream, raw_len, MAX_VERTEX_DATA).unwrap();
    println!("vertex block: {} -> {} bytes in {} ms", stream.len(), direct.len(), started.elapsed().as_millis());
    assert_eq!(direct.len(), 3_820_392);
    assert_eq!(read_block(&mut Reader::new(&model[20..]), MAX_VERTEX_DATA).unwrap(), direct);
}

/// Damaged copies of a real stream: 1 to 6 byte flips (half of them in the first 300 bytes, where
/// the headers are). `whole_first_block` keeps the first 256 KiB block complete so the damage
/// gets past the header walk into the decoder; otherwise the copy is cut short (4096 to 40000
/// bytes), which the header walk refuses. Each copy must be Ok or Err, never a panic (release
/// builds abort on one). Returns (decoded, rejected).
fn mutate(rounds: usize, whole_first_block: bool) -> (usize, usize) {
    let (_, stream, raw_len) = jumbo_vertex_stream();
    let quantum = u32::from_be_bytes([0, stream[2], stream[3], stream[4]]) & 0x3FFFF;
    let first_block = 5 + quantum as usize + 1;
    let mut rng = Rng(0x1234_5678_9ABC);
    let (mut ok, mut err) = (0, 0);
    for _ in 0..rounds {
        let take = if whole_first_block { first_block } else { 4096 + rng.next() as usize % 36_000 };
        let mut copy = stream[..take].to_vec();
        for _ in 0..1 + rng.next() % 6 {
            let span = if rng.next() % 2 == 0 { copy.len().min(300) } else { copy.len() };
            let at = rng.next() as usize % span;
            copy[at] ^= rng.next() as u8 | 1;
        }
        let len = match (whole_first_block, rng.next() % 4) {
            (true, 0 | 1) => 0x40000,
            (true, _) => 1 + rng.next() as usize % 0x40000,
            (false, 0) => raw_len,
            (false, 1) => 1 + rng.next() as usize % 200_000,
            (false, 2) => take * 4,
            (false, _) => 3_820_392,
        };
        match oodle(&copy, len, MAX_VERTEX_DATA) {
            Ok(_) => ok += 1,
            Err(_) => err += 1,
        }
    }
    (ok, err)
}

/// What the reviewer's fuzzer did to `oozextract` 0.5.5 (59 panics in BitKnit and LZNA): the
/// header walk refuses those decoders, and anything cut short.
#[test]
#[ignore = "reads the real War Thunder install"]
fn damaged_headers_and_cut_streams_never_panic() {
    let (ok, err) = mutate(20_000, false);
    println!("cut copies: {ok} decoded, {err} rejected");
}

/// KNOWN FAILURE. Damage inside a complete block reaches the Kraken/Leviathan decoders of
/// `oozextract` 0.5.5, which `assert!` on bad data (tANS tables in `decoder/tans.rs`, Huffman
/// ranges in `decoder/huffman.rs`, `decoder/bit_reader.rs`, `decoder/mod.rs`, plus an unchecked
/// subtraction in `algorithm/leviathan.rs`): about 12 percent of damaged blocks panic, which
/// aborts a release build. Run it by hand to see the count: `-- --ignored damaged_blocks`.
#[test]
#[ignore = "known failure: oozextract's Kraken/Leviathan decoders panic on damaged blocks"]
fn damaged_blocks_never_panic_in_the_decoder() {
    let (ok, err) = mutate(20_000, true);
    println!("damaged blocks: {ok} decoded, {err} rejected");
}
