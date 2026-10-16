//! The pack block codec: zstd and raw blocks round trip, damaged or oversized input is a parse
//! error. Oodle has no open encoder (and Livery never loads game code), so its correctness is
//! checked against the real install by `atelier_real.rs`; here it only has to fail cleanly.
//! Oodle streams are decoded by the worker process (`gameres_worker.rs` covers the process
//! handling); `oodle` below is the process-wide worker started from the `livery` executable.

use livery_lib::error::{AppResult, ErrorCode};
use livery_lib::game::gameres::bytes::Reader;
use livery_lib::game::gameres::codec::{self, check_kraken_family, read_block, zstd, MAX_TEXTURE_LEVEL};

/// `codec::oodle` with the Livery executable as the worker (the test binary can't be one).
fn oodle(src: &[u8], raw_len: usize, max: usize) -> AppResult<Vec<u8>> {
    codec::set_worker_exe(env!("CARGO_BIN_EXE_livery"));
    codec::oodle(src, raw_len, max)
}

/// An IGenLoad block: `u32 L` (tag in the top two bits, payload size below), then the payload.
fn block(tag: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = ((tag << 30) | payload.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(payload);
    out
}

fn assert_parse<T: std::fmt::Debug>(r: Result<T, livery_lib::error::AppError>) {
    let e = r.unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse, "{e:?}");
}

fn noise(seed: &mut u32, len: usize) -> Vec<u8> {
    (0..len)
        .map(|_| {
            *seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (*seed >> 16) as u8
        })
        .collect()
}

#[test]
fn a_zstd_frame_round_trips_within_its_limit() {
    let data: Vec<u8> = (0..5000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
    let frame = ::zstd::bulk::compress(&data, 3).unwrap();
    assert_eq!(zstd(&frame, data.len()).unwrap(), data);
    assert_eq!(zstd(&frame, usize::MAX - 1).unwrap(), data, "a huge limit allocates only what is there");
    assert_parse(zstd(&frame, data.len() - 1));
    assert_eq!(zstd(&::zstd::bulk::compress(&[], 3).unwrap(), 0).unwrap(), Vec::<u8>::new());
}

#[test]
fn a_zstd_bomb_stops_at_the_limit() {
    let frame = ::zstd::bulk::compress(&vec![0u8; 16 * 1024 * 1024], 3).unwrap();
    assert!(frame.len() < 4096, "zeros pack tightly");
    assert_parse(zstd(&frame, 1024 * 1024));
}

#[test]
fn damaged_zstd_is_a_parse_error() {
    let frame = ::zstd::bulk::compress(&noise(&mut 5, 4000), 3).unwrap();
    assert_parse(zstd(&frame[..frame.len() / 2], 1 << 20));
    assert_parse(zstd(&[1, 2, 3, 4, 5, 6, 7, 8], 1 << 20));
    assert_parse(zstd(&[], 1 << 20));
}

#[test]
fn read_block_handles_none_and_zstd_and_advances() {
    let data = b"a block of plain bytes".to_vec();
    let frame = ::zstd::bulk::compress(&data, 3).unwrap();
    let mut file = block(0, &data);
    file.extend(block(1, &frame));
    file.extend_from_slice(b"tail");
    let mut cur = Reader::new(&file);
    assert_eq!(read_block(&mut cur, 1024).unwrap(), data);
    assert_eq!(cur.pos(), 4 + data.len());
    assert_eq!(read_block(&mut cur, 1024).unwrap(), data);
    assert_eq!(cur.pos(), file.len() - 4);
    assert_eq!(cur.remaining(), 4);
}

#[test]
fn read_block_enforces_the_size_limit() {
    let data = vec![7u8; 100];
    assert_eq!(read_block(&mut Reader::new(&block(0, &data)), 100).unwrap(), data);
    assert_parse(read_block(&mut Reader::new(&block(0, &data)), 99));
    let frame = ::zstd::bulk::compress(&data, 3).unwrap();
    assert_parse(read_block(&mut Reader::new(&block(1, &frame)), 99));
    // An Oodle block that claims 4 GiB - 1 is refused before anything is allocated.
    let mut payload = u32::MAX.to_le_bytes().to_vec();
    payload.extend_from_slice(&[0x8C, 0x0C, 0, 0]);
    assert_parse(read_block(&mut Reader::new(&block(2, &payload)), 1024));
}

#[test]
fn a_block_that_runs_past_the_end_is_a_parse_error() {
    let file = block(0, b"0123456789");
    for cut in [0, 1, 3, 4, 5, 13] {
        assert_parse(read_block(&mut Reader::new(&file[..cut]), 1024));
    }
    // The size in the header is larger than what is left.
    let mut lying = file.clone();
    lying[..4].copy_from_slice(&0x3FFF_FFFFu32.to_le_bytes());
    assert_parse(read_block(&mut Reader::new(&lying), usize::MAX));
}

#[test]
fn unknown_tags_and_short_oodle_blocks_are_parse_errors() {
    assert_parse(read_block(&mut Reader::new(&block(3, b"abcdef")), 1024));
    for payload in [&b""[..], b"abc"] {
        assert_parse(read_block(&mut Reader::new(&block(2, payload)), 1024));
    }
}

#[test]
fn oodle_refuses_a_length_over_the_limit_without_allocating() {
    assert_parse(oodle(&[], usize::MAX, MAX_TEXTURE_LEVEL));
    assert_parse(oodle(&[0x8C, 0x0C], MAX_TEXTURE_LEVEL + 1, MAX_TEXTURE_LEVEL));
}

#[test]
fn oodle_garbage_is_a_parse_error_not_a_panic() {
    let mut seed = 99;
    assert_parse(oodle(&noise(&mut seed, 64), 1024, 1 << 20));
    // Shaped like a real stream (every tank stream starts 8C 0C) but cut short or nonsense.
    assert_parse(oodle(&[0x8C, 0x0C], 1024, 1 << 20));
    assert_parse(oodle(&[0x8C, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00], 1024, 1 << 20));
    assert_parse(oodle(&[], 1024, 1 << 20));
}

// ── Only the Kraken family reaches the decoder ──────────────────────────────

const BLOCK: usize = 0x40000;

/// A block header (`0x8C`: magic 0xC with bit 7 "restart") with decoder type `ty`.
fn header(ty: u8) -> Vec<u8> {
    vec![0x8C, ty]
}

/// A block with a 3-byte quantum header announcing `payload.len()` compressed bytes.
fn compressed_block(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = header(ty);
    out.extend_from_slice(&(payload.len() as u32 - 1).to_be_bytes()[1..]);
    out.extend_from_slice(payload);
    out
}

#[test]
fn kraken_mermaid_and_leviathan_headers_pass_the_precheck() {
    for ty in [0x06, 0x0A, 0x0C] {
        let stream = compressed_block(ty, &[0xAA; 10]);
        check_kraken_family(&stream, 1000).unwrap();
        check_kraken_family(&stream, BLOCK).unwrap();
    }
    // An uncompressed block (bit 6 of byte 0) holds the block's bytes as they are.
    let mut raw = vec![0xCC, 0x0C];
    raw.extend_from_slice(&[7; 100]);
    check_kraken_family(&raw, 100).unwrap();
    assert_parse(check_kraken_family(&raw[..50], 100));
    // A memset quantum: size field 0x3FFFF with bit 18 set, then the fill byte.
    check_kraken_family(&[0x8C, 0x0C, 0x07, 0xFF, 0xFF, 0x55], 1000).unwrap();
    assert_parse(check_kraken_family(&[0x8C, 0x0C, 0x07, 0xFF, 0xFF], 1000));
    // Nothing to unpack, nothing to check.
    check_kraken_family(&[], 0).unwrap();
}

#[test]
fn a_passing_stream_reaches_the_decoder_which_then_judges_it() {
    // The precheck lets a Leviathan header through; the (nonsense) payload fails in oozextract.
    let e = oodle(&compressed_block(0x0C, &[0xAA; 10]), 1000, 1 << 20).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert!(e.detail.unwrap().starts_with("oodle: "));
}

#[test]
fn bitknit_lzna_and_unknown_decoders_never_reach_oozextract() {
    for ty in [0x00, 0x05, 0x07, 0x09, 0x0B, 0x0D, 0x7F] {
        let stream = compressed_block(ty, &[0xAA; 10]);
        for call in [check_kraken_family(&stream, 1000), oodle(&stream, 1000, 1 << 20).map(|_| ())] {
            let e = call.unwrap_err();
            assert_eq!(e.code, ErrorCode::Parse, "type {ty:#X}");
            assert!(e.detail.unwrap().starts_with("oodle decoder"), "type {ty:#X}");
        }
    }
}

#[test]
fn malformed_headers_are_parse_errors() {
    let good = compressed_block(0x0C, &[1; 10]);
    // Magic nibble, bits 4-5 of byte 0, checksum flag.
    for (at, value) in [(0, 0x8D), (0, 0x9C), (0, 0xAC), (0, 0x00), (1, 0x8C)] {
        let mut stream = good.clone();
        stream[at] = value;
        assert_parse(check_kraken_family(&stream, 1000));
    }
    // Cut inside the block header, the quantum header, and the compressed bytes.
    for cut in [0, 1, 2, 3, 4, good.len() - 1] {
        assert_parse(check_kraken_family(&good[..cut], 1000));
    }
    // Size field 0x3FFFF without the memset marker.
    assert_parse(check_kraken_family(&[0x8C, 0x0C, 0x03, 0xFF, 0xFF, 0x00], 1000));
    assert_parse(check_kraken_family(&[0x8C, 0x0C, 0x0B, 0xFF, 0xFF, 0x00], 1000));
}

#[test]
fn the_blocks_must_cover_the_unpacked_length() {
    let one = compressed_block(0x0C, &[1; 10]);
    check_kraken_family(&one, BLOCK).unwrap();
    // One block unpacks to 256 KiB at most: a longer output needs a second block.
    assert_parse(check_kraken_family(&one, BLOCK + 1));
    let two = [one.clone(), compressed_block(0x06, &[2; 20])].concat();
    check_kraken_family(&two, BLOCK + 1).unwrap();
    check_kraken_family(&two, 2 * BLOCK).unwrap();
    assert_parse(check_kraken_family(&two, 2 * BLOCK + 1));
    // The second block's header is checked too.
    let mixed = [one, compressed_block(0x0B, &[2; 20])].concat();
    assert_parse(check_kraken_family(&mixed, BLOCK + 1));
    assert!(check_kraken_family(&mixed, BLOCK).is_ok(), "blocks past the unpacked length aren't read");
}

#[test]
fn a_full_block_of_garbage_behind_a_good_header_is_an_error_not_a_crash() {
    // A Leviathan header and a whole block of nonsense gets past the header walk into the decoder.
    let mut seed = 4242;
    for payload in [noise(&mut seed, BLOCK - 1), noise(&mut seed, BLOCK - 1), vec![0xFF; BLOCK - 1], vec![0; BLOCK - 1]]
    {
        let stream = compressed_block(0x0C, &payload);
        check_kraken_family(&stream, BLOCK).unwrap();
        assert_parse(oodle(&stream, BLOCK, 1 << 20));
    }
}

#[test]
fn a_panic_inside_the_decoder_is_an_error_not_a_crash() {
    // Synthetic bytes (found by fuzzing, not taken from the game) that pass the header walk
    // and make oozextract's tANS/Huffman code `assert!`. That kills the worker process, not this
    // one: the caller gets an error, and the next request (below) starts a new worker.
    #[rustfmt::skip]
    let stream = [
        0x8C, 0x0C, 0x00, 0x00, 0x1B, 0x10, 0x24, 0x6C, 0x00, 0x08, 0x4C, 0x58, 0x9C, 0x19, 0xBD, 0x6E, 0x4A,
        0xB0, 0xDD, 0x2E, 0x02, 0x64, 0x4E, 0xEC, 0x3F, 0xE7, 0xCE, 0x69, 0x2F, 0xA3, 0x3C, 0xE6, 0xBD,
    ];
    check_kraken_family(&stream, 2553).unwrap();
    let e = oodle(&stream, 2553, 1 << 20).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert_eq!(e.detail.as_deref(), Some("oodle stream damaged"));
    let again = oodle(&[0xCC, 0x0C, 1, 2, 3], 3, 1 << 20).unwrap();
    assert_eq!(again, [1, 2, 3], "a new worker answers after the crash");
}

#[test]
fn a_mutated_decoder_type_is_accepted_only_when_it_is_kraken_family() {
    let base = [compressed_block(0x0C, &[0; 24]), compressed_block(0x06, &[0; 24])].concat();
    let second = base.len() - 24 - 5;
    for block in [0, second] {
        for ty in 0..=255u8 {
            let mut stream = base.clone();
            stream[block + 1] = ty;
            let ok = [0x06, 0x0A, 0x0C].contains(&ty);
            let result = check_kraken_family(&stream, BLOCK + 1);
            assert_eq!(result.is_ok(), ok, "block at {block}, type {ty:#04X}");
            // What the precheck refuses never gets to oozextract; the rest may fail there.
            if !ok {
                assert_parse(oodle(&stream, BLOCK + 1, 1 << 20));
            }
        }
    }
}

#[test]
fn mutated_headers_are_judged_without_panicking() {
    // Flip bytes in the headers of a two-block stream: the walk itself must never panic (it runs
    // in the app's own process in tests), and whatever it accepts starts with a good block.
    let base = [compressed_block(0x0C, &[0; 24]), compressed_block(0x06, &[0; 24])].concat();
    let second = base.len() - 24 - 5;
    let mut seed = 31;
    for _ in 0..20_000 {
        let mut stream = base.clone();
        for _ in 0..1 + noise(&mut seed, 1)[0] % 3 {
            let r = noise(&mut seed, 2);
            let at = (r[0] as usize % 5) + if r[1] & 1 == 0 { 0 } else { second };
            stream[at] ^= noise(&mut seed, 1)[0] | 1;
        }
        let raw_len = [1, 1000, BLOCK, BLOCK + 1, 2 * BLOCK][noise(&mut seed, 1)[0] as usize % 5];
        if check_kraken_family(&stream, raw_len).is_ok() {
            // Whatever passed has a first block a Kraken-family decoder would accept.
            assert_eq!(stream[0] & 0x3F, 0x0C, "{stream:02X?}");
            assert!([0x06, 0x0A, 0x0C].contains(&stream[1]), "{stream:02X?}");
        }
    }
}
