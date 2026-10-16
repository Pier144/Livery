//! GRP2 packs (`content/base/res/tanks/*.grp`): a table of named game resources, each a byte
//! range of the file that its own loader decodes (see the formats doc, section 1).
//!
//! ```text
//! 0x00  "GRP2" | "GRP3"   u32 descOnlySize | u32 fullDataSize | u32 restFileSize (file size - 16)
//! 0x10  nameMap tab (i32 absolute offsets of NUL-terminated names, -1 = none)
//! 0x20  resTable tab (12-byte entries: u32 classId, u32 offset, u16 nameIdx, u16 reserved)
//! 0x30  resData tab (dependency records, not read here)
//! ```

use super::bad;
use super::bytes::Reader;
use crate::error::AppResult;

/// Class id of a DynModel (a vehicle's 3D model).
pub const DYN_MODEL: u32 = 0xB4B7_D9C4;
/// Class id of a GeomNodeTree (a model's skeleton).
pub const GEOM_NODE_TREE: u32 = 0x56F8_1B6D;

const HEADER: usize = 0x10;
const TABS_END: usize = 0x40;
const ENTRY: usize = 12;

/// One resource of a pack. `start..end` is its byte range in the `.grp` file; a resource with
/// no data (offset 0) has `start == end == 0`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrpResource {
    pub class_id: u32,
    pub name: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grp {
    pub resources: Vec<GrpResource>,
}

impl Grp {
    /// Reads the resource table from the header part (a `.grpcache.bin` copy, or the file's
    /// first `fullDataSize + 16` bytes, or the whole file). The tables and names must lie in that
    /// description part, and with `file_len` every resource must start after it (the data
    /// follows the description) and inside the file. A resource ends where the next one starts;
    /// `file_len` closes the last one. Pass `None` for a cache copy: the last range then ends at
    /// its own start (the engine's `restFileSize` is only checked when the length is known).
    pub fn parse(head: &[u8], file_len: Option<usize>) -> AppResult<Self> {
        if head.len() < TABS_END {
            return Err(bad(format!("GRP header of {} bytes", head.len())));
        }
        let magic = Reader::new(head).slice(0, 4)?;
        if magic != b"GRP2" && magic != b"GRP3" {
            return Err(bad(format!("not a GRP pack (magic {magic:02X?})")));
        }
        let full = Reader::new(head).u32_at(8)? as usize;
        let data_start = HEADER.checked_add(full).ok_or_else(|| bad("GRP description size overflows"))?;
        let desc = head
            .get(..data_start)
            .ok_or_else(|| bad(format!("GRP header holds {} of {data_start} bytes", head.len())))?;
        let r = Reader::new(desc);
        if let Some(len) = file_len {
            let rest = r.u32_at(12)? as usize;
            if rest != len.saturating_sub(HEADER) {
                return Err(bad(format!(
                    "GRP says {rest} bytes after the header, the file has {}",
                    len.saturating_sub(HEADER)
                )));
            }
        }

        let (names_ofs, names_count) = r.tab(0x10)?;
        let (table_ofs, table_count) = r.tab(0x20)?;
        let (names_ofs, names_count) = (names_ofs as usize, names_count as usize);
        let (table_ofs, table_count) = (table_ofs as usize, table_count as usize);
        // Bounds first: the counts can't make us allocate more than the header holds.
        let names_len = names_count.checked_mul(4).ok_or_else(|| bad("GRP name map too large"))?;
        let table_len = table_count.checked_mul(ENTRY).ok_or_else(|| bad("GRP resource table too large"))?;
        r.slice(names_ofs, names_len)?;
        r.slice(table_ofs, table_len)?;

        let mut resources = Vec::with_capacity(table_count);
        for i in 0..table_count {
            let at = table_ofs.checked_add(i * ENTRY).ok_or_else(|| bad("GRP resource table overflows"))?;
            let class_id = r.u32_at(at)?;
            let start = r.u32_at(at + 4)? as usize;
            let name_idx = r.u16_at(at + 8)? as usize;
            if name_idx >= names_count {
                return Err(bad(format!("resource {i}: name {name_idx} of {names_count}")));
            }
            let name_at = names_ofs.checked_add(name_idx * 4).ok_or_else(|| bad("GRP name map overflows"))?;
            let name_ofs = r.i32_at(name_at)?;
            // -1 = no name.
            let name = match name_ofs {
                -1 => String::new(),
                ofs => r.cstr(usize::try_from(ofs).map_err(|_| bad(format!("resource {i}: name offset {ofs}")))?)?,
            };
            if let Some(len) = file_len {
                if start > len {
                    return Err(bad(format!("resource {name:?} at {start} past the end ({len})")));
                }
                if start != 0 && start < data_start {
                    return Err(bad(format!(
                        "resource {name:?} at {start} inside the description (ends at {data_start})"
                    )));
                }
            }
            resources.push(GrpResource { class_id, name, start, end: start });
        }

        // A resource spans [its offset, the next non-zero offset in file order), the last to EOF.
        let mut starts: Vec<usize> = resources.iter().map(|res| res.start).filter(|&s| s != 0).collect();
        starts.sort_unstable();
        starts.dedup();
        for res in resources.iter_mut().filter(|res| res.start != 0) {
            let next = starts.partition_point(|&s| s <= res.start);
            res.end = starts.get(next).copied().or(file_len).unwrap_or(res.start);
        }
        Ok(Self { resources })
    }

    /// The resource called `name` of class `class_id`.
    pub fn find(&self, name: &str, class_id: u32) -> Option<&GrpResource> {
        self.resources.iter().find(|res| res.class_id == class_id && res.name == name)
    }
}
