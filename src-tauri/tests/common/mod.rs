//! Encoders shared by the integration tests: the inverse of what Livery reads from the game's
//! data archives (`.vromfs.bin`, binary BLK), so synthetic fixtures can be built in code.
//! Gaijin's files can't ship in the repository.

#![allow(dead_code)] // each test crate uses a different part

use livery_lib::game::vromfs::deobfuscate;

pub fn uleb(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// A `.vromfs.bin`: `VRFx` packed with zstd and obfuscated, or `VRFs` stored as is.
pub fn vromfs(files: &[(&str, &[u8])], packed: bool) -> Vec<u8> {
    let count = files.len();
    let names_at = 0x20;
    let info_at = names_at + 8 * count;
    let mut strings_at = info_at + 16 * count;
    let mut payload = vec![0u8; strings_at];
    payload[0..4].copy_from_slice(&(names_at as u32).to_le_bytes());
    payload[4..8].copy_from_slice(&(count as u32).to_le_bytes());
    payload[16..20].copy_from_slice(&(info_at as u32).to_le_bytes());
    payload[20..24].copy_from_slice(&(count as u32).to_le_bytes());
    for (i, (name, _)) in files.iter().enumerate() {
        payload[names_at + 8 * i..names_at + 8 * i + 8].copy_from_slice(&(strings_at as u64).to_le_bytes());
        // `\u{ff}` is stored as the single byte 0xFF.
        let raw: Vec<u8> = name.chars().map(|c| c as u32 as u8).collect();
        payload.extend_from_slice(&raw);
        payload.push(0);
        strings_at = payload.len();
    }
    for (i, (_, data)) in files.iter().enumerate() {
        while payload.len() % 16 != 0 {
            payload.push(0);
        }
        let at = payload.len();
        payload[info_at + 16 * i..info_at + 16 * i + 4].copy_from_slice(&(at as u32).to_le_bytes());
        payload[info_at + 16 * i + 4..info_at + 16 * i + 8].copy_from_slice(&(data.len() as u32).to_le_bytes());
        payload.extend_from_slice(data);
    }
    let mut out = Vec::new();
    if packed {
        let mut body = zstd::bulk::compress(&payload, 3).unwrap();
        deobfuscate(&mut body);
        out.extend_from_slice(b"VRFx\0\0PC");
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&((body.len() as u32) | (0x30 << 26)).to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&[65, 0, 59, 2]); // 2.59.0.65
        out.extend_from_slice(&body);
    } else {
        out.extend_from_slice(b"VRFs\0\0PC");
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&payload);
    }
    out.extend_from_slice(&[0u8; 16]); // digest
    out
}

/// A name map file: digests (zero: no dictionary), then zstd of count, size and names.
pub fn name_map(names: &[&str]) -> Vec<u8> {
    let mut raw = Vec::new();
    let joined: Vec<u8> = names.iter().flat_map(|n| n.bytes().chain(std::iter::once(0))).collect();
    uleb(names.len() as u64, &mut raw);
    uleb(joined.len() as u64, &mut raw);
    raw.extend_from_slice(&joined);
    let mut file = vec![0u8; 40];
    file.extend_from_slice(&zstd::bulk::compress(&raw, 3).unwrap());
    file
}

pub enum V {
    Str(&'static str),
    Int(i32),
    Bool(bool),
}

pub struct B {
    pub name: &'static str,
    pub params: Vec<(&'static str, V)>,
    pub children: Vec<B>,
}

pub fn b(name: &'static str, params: Vec<(&'static str, V)>, children: Vec<B>) -> B {
    B { name, params, children }
}

/// A slim BLK (kind 4, zstd, no dictionary) over the shared `names`.
pub fn slim_blk(root: &B, names: &[&str]) -> Vec<u8> {
    let mut file = vec![4u8];
    file.extend_from_slice(&zstd::bulk::compress(&blk_body(root, names, false), 3).unwrap());
    file
}

/// A fat BLK body (the file's own names first), without the kind byte.
pub fn fat_body(root: &B, names: &[&str]) -> Vec<u8> {
    blk_body(root, names, true)
}

/// A fat BLK file (kind 1: the file's own names, not compressed).
pub fn fat_blk(root: &B, names: &[&str]) -> Vec<u8> {
    with_kind(1, &fat_body(root, names))
}

/// A BLK file: the kind byte, then `body`.
pub fn with_kind(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut file = vec![kind];
    file.extend_from_slice(body);
    file
}

/// The body of a BLK: names (`fat`: the file's own, else none: they are shared), then blocks,
/// params and data. Blocks are breadth-first so each block's children are contiguous.
pub fn blk_body(root: &B, names: &[&str], fat: bool) -> Vec<u8> {
    let id = |n: &str| names.iter().position(|x| *x == n).unwrap_or_else(|| panic!("{n} not in the name map"));
    let mut order: Vec<&B> = vec![root];
    let mut first_child: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < order.len() {
        let block = order[i];
        first_child.push(order.len());
        order.extend(block.children.iter());
        i += 1;
    }
    let mut data = Vec::new();
    let mut infos = Vec::new();
    for block in &order {
        for (name, value) in &block.params {
            let (ty, raw) = match value {
                V::Str(s) => {
                    let at = data.len() as u32;
                    data.extend_from_slice(s.as_bytes());
                    data.push(0);
                    (1u32, at)
                }
                V::Int(v) => (2, *v as u32),
                V::Bool(v) => (9, u32::from(*v)),
            };
            infos.extend_from_slice(&((id(name) as u32) | (ty << 24)).to_le_bytes());
            infos.extend_from_slice(&raw.to_le_bytes());
        }
    }
    let params: usize = order.iter().map(|b| b.params.len()).sum();
    let mut body = Vec::new();
    if fat {
        let joined: Vec<u8> = names.iter().flat_map(|n| n.bytes().chain(std::iter::once(0))).collect();
        uleb(names.len() as u64, &mut body);
        uleb(joined.len() as u64, &mut body);
        body.extend_from_slice(&joined);
    } else {
        uleb(0, &mut body);
    }
    uleb(order.len() as u64, &mut body);
    uleb(params as u64, &mut body);
    uleb(data.len() as u64, &mut body);
    body.extend_from_slice(&data);
    body.extend_from_slice(&infos);
    for (index, block) in order.iter().enumerate() {
        uleb(if index == 0 { 0 } else { id(block.name) as u64 + 1 }, &mut body);
        uleb(block.params.len() as u64, &mut body);
        uleb(block.children.len() as u64, &mut body);
        if !block.children.is_empty() {
            uleb(first_child[index] as u64, &mut body);
        }
    }
    body
}
