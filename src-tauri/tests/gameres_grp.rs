//! The GRP2 pack reader on synthetic packs (`common::gameres::grp_bytes`): names, classes and
//! byte ranges, the header-only copies the game keeps, and damaged files.

mod common;

use common::gameres::{grp_bytes, grp_cache, grp_with_magic};
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::game::gameres::grp::{Grp, DYN_MODEL, GEOM_NODE_TREE};

const CHARACTER: u32 = 0xA6F8_7A9B;

fn sample() -> Vec<u8> {
    grp_bytes(&[
        (DYN_MODEL, "tank_a", &[1u8; 40]),
        (GEOM_NODE_TREE, "tank_a_skeleton", &[2u8; 70]),
        (CHARACTER, "tank_a_char", &[3u8; 5]),
    ])
}

fn is_parse<T: std::fmt::Debug>(r: Result<T, AppError>) {
    let e = r.unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse, "{e:?}");
}

fn put_u32(file: &mut [u8], at: usize, v: u32) {
    file[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

#[test]
fn resources_parse_with_names_classes_and_ranges() {
    let file = sample();
    let grp = Grp::parse(&file, Some(file.len())).unwrap();
    let got: Vec<(&str, u32)> = grp.resources.iter().map(|r| (r.name.as_str(), r.class_id)).collect();
    assert_eq!(got, [("tank_a", DYN_MODEL), ("tank_a_skeleton", GEOM_NODE_TREE), ("tank_a_char", CHARACTER)]);
    let [a, b, c] = &grp.resources[..] else { panic!("three resources") };
    assert_eq!(&file[a.start..a.start + 40], &[1u8; 40][..]);
    assert_eq!(&file[b.start..b.start + 70], &[2u8; 70][..]);
    assert_eq!(&file[c.start..c.start + 5], &[3u8; 5][..]);
    // Each resource runs up to the next one (alignment padding included); the last to EOF.
    assert_eq!((a.end, b.end, c.end), (b.start, c.start, file.len()));
    assert!(a.end - a.start >= 40 && b.end - b.start >= 70);
}

#[test]
fn find_matches_name_and_class() {
    let file = sample();
    let grp = Grp::parse(&file, Some(file.len())).unwrap();
    assert_eq!(grp.find("tank_a", DYN_MODEL).unwrap().class_id, DYN_MODEL);
    assert_eq!(grp.find("tank_a_skeleton", GEOM_NODE_TREE).unwrap().name, "tank_a_skeleton");
    assert!(grp.find("tank_a", GEOM_NODE_TREE).is_none(), "right name, wrong class");
    assert!(grp.find("tank_b", DYN_MODEL).is_none());
    assert!(grp.find("", DYN_MODEL).is_none());
}

#[test]
fn a_header_only_copy_reads_the_same_resources() {
    let file = sample();
    let full = Grp::parse(&file, Some(file.len())).unwrap();
    let cache = grp_cache(&file);
    assert!(cache.len() < file.len());
    let grp = Grp::parse(&cache, None).unwrap();
    assert_eq!(grp.resources.len(), full.resources.len());
    for (a, b) in grp.resources.iter().zip(&full.resources) {
        assert_eq!((&a.name, a.class_id, a.start), (&b.name, b.class_id, b.start));
    }
    // Without the file length the last range can't be closed: it ends where it starts.
    let last = grp.resources.last().unwrap();
    assert_eq!(last.end, last.start);
    assert_eq!(grp.resources[0].end, grp.resources[1].start);
}

#[test]
fn grp3_is_accepted() {
    let file = grp_with_magic(b"GRP3", &[(DYN_MODEL, "m", &[9u8; 8])]);
    let grp = Grp::parse(&file, Some(file.len())).unwrap();
    assert_eq!(grp.find("m", DYN_MODEL).unwrap().end, file.len());
}

#[test]
fn a_resource_without_data_has_an_empty_range_and_closes_nobody() {
    let file = grp_bytes(&[(DYN_MODEL, "a", &[1u8; 16]), (CHARACTER, "empty", &[]), (GEOM_NODE_TREE, "b", &[2u8; 16])]);
    let grp = Grp::parse(&file, Some(file.len())).unwrap();
    let empty = grp.find("empty", CHARACTER).unwrap();
    assert_eq!((empty.start, empty.end), (0, 0));
    assert_eq!(grp.find("a", DYN_MODEL).unwrap().end, grp.find("b", GEOM_NODE_TREE).unwrap().start);
}

#[test]
fn an_empty_pack_has_no_resources() {
    let file = grp_bytes(&[]);
    assert!(Grp::parse(&file, Some(file.len())).unwrap().resources.is_empty());
}

#[test]
fn damaged_headers_are_parse_errors() {
    let file = sample();
    let len = file.len();

    let mut bad_magic = file.clone();
    bad_magic[..4].copy_from_slice(b"GRP9");
    is_parse(Grp::parse(&bad_magic, Some(len)));
    is_parse(Grp::parse(&file[..0], Some(0)));
    is_parse(Grp::parse(&file[..15], None));
    is_parse(Grp::parse(&file[..0x30], None));
    // The header part is cut short of what fullDataSize promises.
    is_parse(Grp::parse(&grp_cache(&file)[..0x44], None));
    // The engine's own check: restFileSize must be the file size minus 16.
    let mut rest = file.clone();
    put_u32(&mut rest, 12, len as u32 - 15);
    is_parse(Grp::parse(&rest, Some(len)));
    assert!(Grp::parse(&rest, None).is_ok(), "a cache copy has no file length to compare");
}

#[test]
fn damaged_tables_and_names_are_parse_errors() {
    let file = sample();
    let len = file.len();
    let table_at = u32::from_le_bytes(file[0x20..0x24].try_into().unwrap()) as usize;
    let names_at = u32::from_le_bytes(file[0x10..0x14].try_into().unwrap()) as usize;

    // Name index out of range.
    let mut idx = file.clone();
    idx[table_at + 8..table_at + 10].copy_from_slice(&3u16.to_le_bytes());
    is_parse(Grp::parse(&idx, Some(len)));
    // Resource data past the end of the file.
    let mut past = file.clone();
    put_u32(&mut past, table_at + 4, len as u32 + 1);
    is_parse(Grp::parse(&past, Some(len)));
    assert!(Grp::parse(&past, None).is_ok(), "no file length, nothing to compare with");
    // Resource data that starts inside the description part (before the data region).
    let mut inside = file.clone();
    put_u32(&mut inside, table_at + 4, 0x20);
    is_parse(Grp::parse(&inside, Some(len)));
    // A name that lies in the data region rather than the description part.
    let data_at = u32::from_le_bytes(file[table_at + 4..table_at + 8].try_into().unwrap());
    let mut data_name = file.clone();
    put_u32(&mut data_name, names_at, data_at);
    is_parse(Grp::parse(&data_name, Some(len)));
    is_parse(Grp::parse(&data_name, None));
    // A name pointing past the header part / without a terminator.
    let mut name = file.clone();
    put_u32(&mut name, names_at, len as u32);
    is_parse(Grp::parse(&name, Some(len)));
    put_u32(&mut name, names_at, u32::MAX - 1);
    is_parse(Grp::parse(&name, Some(len)));
    // Tables that don't fit in the header, or whose size overflows.
    for (tab, ofs, count) in
        [(0x10, 0x40u32, u32::MAX), (0x20, 0x40, 0x7FFF_FFFF), (0x20, u32::MAX, 1), (0x10, u32::MAX, 0)]
    {
        let mut broken = file.clone();
        put_u32(&mut broken, tab, ofs);
        put_u32(&mut broken, tab + 4, count);
        is_parse(Grp::parse(&broken, Some(len)));
    }
    // A name of -1 is "no name", not an error.
    let mut none = file.clone();
    put_u32(&mut none, names_at, u32::MAX);
    assert_eq!(Grp::parse(&none, Some(len)).unwrap().resources[0].name, "");
}

#[test]
fn flipped_bytes_never_panic() {
    let file = sample();
    let mut seed: u32 = 11;
    for _ in 0..2000 {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let mut copy = file.clone();
        let at = (seed >> 8) as usize % 0x80.min(copy.len());
        copy[at] ^= (seed >> 24) as u8 | 1;
        let _ = Grp::parse(&copy, Some(copy.len()));
        let _ = Grp::parse(&copy[..copy.len() / 2], None);
    }
}
