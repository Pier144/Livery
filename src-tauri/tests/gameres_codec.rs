//! The pack block codec: zstd and raw blocks round trip, damaged or oversized input is a parse
//! error. Oodle has no open encoder (and Livery never loads game code), so its correctness is
//! checked against the real install by `atelier_real.rs`; here it only has to fail cleanly.

use livery_lib::error::ErrorCode;
use livery_lib::game::gameres::bytes::Reader;
use livery_lib::game::gameres::codec::{oodle, read_block, zstd, MAX_TEXTURE_LEVEL};

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

#[test]
fn oodle_never_panics_on_damaged_input() {
    // Release builds abort on panic, so a decoder that panics on bad input would take the whole
    // app down: hammer it with noise that has plausible headers (debug build: overflow checks on).
    let mut seed = 2024;
    let headers: [&[u8]; 5] = [&[], &[0x8C, 0x0C], &[0x8C, 0x06], &[0x8C, 0x0A], &[0x8C, 0x0C, 0x00, 0x00, 0x80]];
    for round in 0..3000usize {
        let mut input = headers[round % headers.len()].to_vec();
        let len = 1 + (noise(&mut seed, 1)[0] as usize) * (1 + round % 7);
        input.extend(noise(&mut seed, len));
        let raw_len = 1 + (round * 977) % 70_000;
        let _ = oodle(&input, raw_len, 1 << 20);
    }
}
