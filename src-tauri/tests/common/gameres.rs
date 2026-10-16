//! Builders for the game-resource formats (GRP2 packs and what they hold), following
//! docs/superpowers/specs/2026-10-16-atelier-phase0-formats.md. The inverse of
//! `livery_lib::game::gameres`, so synthetic packs can stand in for Gaijin's files.

/// A GRP2 (or `magic`) pack: header, the three PatchableTabs, the name map and resource table,
/// the names, then every resource's bytes (16-byte aligned). A resource with no data (an empty
/// slice) gets offset 0, as the engine writes for resources without a payload.
///
/// ```text
/// 0x00 magic | u32 descOnlySize | u32 fullDataSize | u32 restFileSize (file size - 16)
/// 0x10 nameMap tab | resTable tab | resData tab (always empty here)
/// ```
pub fn grp_with_magic(magic: &[u8; 4], resources: &[(u32, &str, &[u8])]) -> Vec<u8> {
    let count = resources.len();
    let name_map_at = 0x40;
    let res_table_at = name_map_at + 4 * count;
    let names_at = res_table_at + 12 * count;
    let mut desc = vec![0u8; names_at];
    let mut name_offsets = Vec::new();
    for (_, name, _) in resources {
        name_offsets.push(desc.len() as i32);
        desc.extend_from_slice(name.as_bytes());
        desc.push(0);
    }
    let desc_end = desc.len();
    let mut file = desc;
    let mut data_offsets = Vec::new();
    for (_, _, data) in resources {
        if data.is_empty() {
            data_offsets.push(0u32);
            continue;
        }
        while file.len() % 16 != 0 {
            file.push(0);
        }
        data_offsets.push(file.len() as u32);
        file.extend_from_slice(data);
    }
    file[0..4].copy_from_slice(magic);
    file[4..8].copy_from_slice(&(desc_end as u32 - 16).to_le_bytes());
    file[8..12].copy_from_slice(&(desc_end as u32 - 16).to_le_bytes());
    let rest = file.len() as u32 - 16;
    file[12..16].copy_from_slice(&rest.to_le_bytes());
    // nameMap tab, resTable tab; the resData tab (0x30) stays empty.
    file[0x10..0x14].copy_from_slice(&(name_map_at as u32).to_le_bytes());
    file[0x14..0x18].copy_from_slice(&(count as u32).to_le_bytes());
    file[0x20..0x24].copy_from_slice(&(res_table_at as u32).to_le_bytes());
    file[0x24..0x28].copy_from_slice(&(count as u32).to_le_bytes());
    for (i, offset) in name_offsets.iter().enumerate() {
        file[name_map_at + 4 * i..name_map_at + 4 * i + 4].copy_from_slice(&offset.to_le_bytes());
    }
    for (i, (class_id, _, _)) in resources.iter().enumerate() {
        let at = res_table_at + 12 * i;
        file[at..at + 4].copy_from_slice(&class_id.to_le_bytes());
        file[at + 4..at + 8].copy_from_slice(&data_offsets[i].to_le_bytes());
        file[at + 8..at + 10].copy_from_slice(&(i as u16).to_le_bytes());
    }
    file
}

/// A `GRP2` pack, see [`grp_with_magic`].
pub fn grp_bytes(resources: &[(u32, &str, &[u8])]) -> Vec<u8> {
    grp_with_magic(b"GRP2", resources)
}

/// What `grp_hdr.vromfs.bin` stores for a pack (`.grpcache.bin`): its first `fullDataSize + 16` bytes.
pub fn grp_cache(file: &[u8]) -> Vec<u8> {
    let full = u32::from_le_bytes(file[8..12].try_into().unwrap()) as usize;
    file[..16 + full].to_vec()
}
