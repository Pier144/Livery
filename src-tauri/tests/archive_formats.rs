//! ZIP, 7z and RAR sources: analysis and installs that end exactly like a skin folder's, and every
//! guard (unsafe paths, links, encryption, split volumes, size and count caps, sizes that lie,
//! damaged data). ZIP and 7z fixtures are built here with the crates' writers (some then patched
//! byte by byte); the RAR ones are committed in `fixtures/archives` (see its README). Also the
//! ZIP export of My Hangar.

use livery_lib::archive::source::SOURCE_GONE;
use livery_lib::archive::unpack::{
    entry_path, Limits, ARCHIVE_DAMAGED, ARCHIVE_ENCRYPTED, ARCHIVE_METHOD, ARCHIVE_SPLIT, ARCHIVE_TOO_BIG,
    ARCHIVE_TOO_MANY_FILES, LINK_ENTRY, MAX_FILE_BYTES, NOT_AN_ARCHIVE, UNSAFE_ENTRY,
};
use livery_lib::archive::{
    analyze_path, open_source, open_source_with, partial_dir, prepare, purge_textures_scratch, run, textures_for_queue,
    Ctx, FolderSource, InstallJob, QueueStore, SkinSource,
};
use livery_lib::error::{AppError, AppResult, ErrorCode};
use livery_lib::library::import_folders;
use livery_lib::library::index::LibraryStore;
use livery_lib::library::ops::{export_as, export_zip, ExportFormat};
use livery_lib::model::{ConflictPolicy, InstallProgress, InstallStep, QueueItem, QueueStatus, Settings};
use sevenz_rust2::encoder_options::AesEncoderOptions;
use sevenz_rust2::{ArchiveEntry, ArchiveWriter, EncoderMethod, Password, SourceReader};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-formats-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

fn source_fixture(name: &str) -> PathBuf {
    fixtures().join("sources").join(name)
}

fn rar_fixture(name: &str) -> PathBuf {
    fixtures().join("archives").join(name)
}

fn err<T>(result: Result<T, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

/// One archive entry: a folder (no bytes) or a file.
type Entry = (String, Option<Vec<u8>>);

fn file(name: &str, bytes: &[u8]) -> Entry {
    (name.to_owned(), Some(bytes.to_vec()))
}

fn dir(name: &str) -> Entry {
    (name.to_owned(), None)
}

/// Every folder and file of a committed source folder, under `prefix` (`""` = at the top).
fn entries_of(folder: &Path, prefix: &str) -> Vec<Entry> {
    FolderSource::new(folder)
        .entries()
        .unwrap()
        .into_iter()
        .map(|e| {
            let name = format!("{prefix}{}", e.path);
            if e.is_dir {
                (name, None)
            } else {
                (name, Some(fs::read(folder.join(&e.path)).unwrap()))
            }
        })
        .collect()
}

/// A committed source folder as archive entries under its own name (`Winter Tiger/…`).
fn packed(name: &str) -> Vec<Entry> {
    let mut entries = vec![dir(name)];
    entries.extend(entries_of(&source_fixture(name), &format!("{name}/")));
    entries
}

/// Every file under `dir`, relative, `/`-separated, with its bytes, sorted.
fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<(String, Vec<u8>)> = FolderSource::new(dir)
        .entries()
        .unwrap()
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| {
            let bytes = fs::read(dir.join(&e.path)).unwrap();
            (e.path, bytes)
        })
        .collect();
    files.sort();
    files
}

fn write_zip(path: &Path, entries: &[Entry]) -> PathBuf {
    let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in entries {
        match bytes {
            None => zip.add_directory(name.as_str(), SimpleFileOptions::default()).unwrap(),
            Some(bytes) => {
                zip.start_file(
                    name.as_str(),
                    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
                )
                .unwrap();
                zip.write_all(bytes).unwrap();
            }
        }
    }
    zip.finish().unwrap();
    path.to_path_buf()
}

fn sevenz_entry(name: &str, bytes: &Option<Vec<u8>>) -> ArchiveEntry {
    match bytes {
        None => ArchiveEntry::new_directory(name),
        Some(_) => ArchiveEntry::new_file(name),
    }
}

/// A 7z of `entries`, each file in its own block, or all in one solid block.
fn write_7z(path: &Path, entries: &[Entry], solid: bool) -> PathBuf {
    let mut writer = ArchiveWriter::create(path).unwrap();
    if solid {
        let (dirs, files): (Vec<&Entry>, Vec<&Entry>) = entries.iter().partition(|(_, b)| b.is_none());
        for (name, bytes) in dirs {
            writer.push_archive_entry::<&[u8]>(sevenz_entry(name, bytes), None).unwrap();
        }
        let list = files.iter().map(|(n, b)| sevenz_entry(n, b)).collect();
        let readers =
            files.iter().map(|(_, b)| SourceReader::new(Cursor::new(b.clone().unwrap_or_default()))).collect();
        writer.push_archive_entries(list, readers).unwrap();
    } else {
        for (name, bytes) in entries {
            writer.push_archive_entry(sevenz_entry(name, bytes), bytes.as_deref()).unwrap();
        }
    }
    writer.finish().unwrap();
    path.to_path_buf()
}

/// Byte offsets of every `sig` in `bytes`.
fn find_all(bytes: &[u8], sig: &[u8]) -> Vec<usize> {
    bytes.windows(sig.len()).enumerate().filter(|(_, w)| *w == sig).map(|(i, _)| i).collect()
}

/// Rewrites the ZIP at `path`: `patch(central_header_offset, local_header_offset, bytes)` for
/// each entry (the n-th central header goes with the n-th local header).
fn patch_zip(path: &Path, patch: impl Fn(usize, usize, &mut Vec<u8>)) {
    let mut bytes = fs::read(path).unwrap();
    let central = find_all(&bytes, b"PK\x01\x02");
    let local = find_all(&bytes, b"PK\x03\x04");
    assert_eq!(central.len(), local.len());
    for (c, l) in central.into_iter().zip(local) {
        patch(c, l, &mut bytes);
    }
    fs::write(path, bytes).unwrap();
}

/// CRC-32 (IEEE), as RAR and 7z headers carry it.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// 7-Zip's variable-length number.
fn sevenz_number(value: u64) -> Vec<u8> {
    let (mut first, mut mask, mut extra) = (0u8, 0x80u8, 0usize);
    while extra < 8 {
        if value < 1u64 << (7 * (extra + 1)) {
            first |= (value >> (8 * extra)) as u8;
            break;
        }
        first |= mask;
        mask >>= 1;
        extra += 1;
    }
    let mut out = vec![first];
    out.extend((0..extra).map(|i| (value >> (8 * i)) as u8));
    out
}

/// `winter_tiger.rar` with the header of its first file (the `.blk`) rewritten by `patch`, which
/// gets the header from its type field to the end of its extra area. The header CRC and size are
/// written again, so UnRAR reads the result as a sound archive.
fn patched_rar(to: &Path, patch: impl Fn(&mut Vec<u8>)) -> PathBuf {
    let bytes = fs::read(rar_fixture("winter_tiger.rar")).unwrap();
    // Signature (8) + main archive header (4 + 1 + 10): the file header starts at 23.
    let (head, block) = bytes.split_at(23);
    let size = usize::from(block[4]);
    assert!(size < 0x80, "a one-byte header size");
    let mut body = block[5..5 + size].to_vec();
    assert_eq!(body[0], 2, "a file header");
    patch(&mut body);
    assert!(body.len() < 0x80);
    let mut sized = vec![body.len() as u8];
    sized.extend(&body);
    let mut out = head.to_vec();
    out.extend(crc32(&sized).to_le_bytes());
    out.extend(sized);
    out.extend(&block[5 + size..]);
    fs::write(to, out).unwrap();
    to.to_path_buf()
}

/// In [`patched_rar`]'s header: the two-byte compression information field.
const RAR_COMPRESSION_AT: std::ops::Range<usize> = 13..15;

/// A game folder in a temp dir with its library, queue and settings.
struct Env {
    tmp: TempDir,
    user_skins: PathBuf,
    store: LibraryStore,
    queue: QueueStore,
    settings: Settings,
}

impl Env {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        let user_skins = tmp.path().join("game").join("UserSkins");
        fs::create_dir_all(&user_skins).unwrap();
        fs::create_dir_all(tmp.path().join("downloads")).unwrap();
        let store = LibraryStore::load(tmp.path().join("data").join("library.json"));
        Self { tmp, user_skins, store, queue: QueueStore::default(), settings: Settings::default() }
    }

    /// Where test archives are written.
    fn download(&self, name: &str) -> PathBuf {
        self.tmp.path().join("downloads").join(name)
    }

    fn ctx(&self) -> Ctx<'_> {
        Ctx { user_skins: &self.user_skins, library: &self.store, queue: &self.queue, settings: &self.settings }
    }

    fn analyze(&self, path: &Path) -> QueueItem {
        analyze_path(path, Some(&self.user_skins), &self.store, &self.queue).unwrap().item
    }

    fn prepare(&self, id: &str, vehicle: Option<&str>, conflict: Option<ConflictPolicy>) -> AppResult<InstallJob> {
        prepare(&self.ctx(), id, vehicle, conflict)
    }

    /// Installs a queued item; returns every progress event.
    fn install(&self, id: &str, vehicle: Option<&str>, conflict: Option<ConflictPolicy>) -> Vec<InstallProgress> {
        let job = self.prepare(id, vehicle, conflict).unwrap();
        let mut events = Vec::new();
        run(&self.ctx(), job, &mut |p| events.push(p.clone()));
        events
    }

    /// A skin folder already in `UserSkins`, imported into the index.
    fn installed(&self, folder: &str, code: &str) -> String {
        let dir = self.user_skins.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{code}.blk")), "replace_tex{}").unwrap();
        import_folders(&self.user_skins, &self.store, &[folder.to_owned()]).unwrap();
        self.store.all().into_iter().find(|s| s.folder == folder).unwrap().id
    }

    /// Nothing staged is left, and nothing landed next to the game folder or the downloads.
    fn assert_clean(&self) {
        let partial = partial_dir(&self.user_skins);
        assert!(fs::read_dir(&partial).map(|rd| rd.count() == 0).unwrap_or(true), "staging left in {partial:?}");
        for entry in fs::read_dir(self.tmp.path()).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(["data", "downloads", "game"].contains(&name.as_str()), "unexpected {name}");
        }
        assert_eq!(fs::read_dir(self.tmp.path().join("game")).unwrap().count(), 1, "only UserSkins in the game folder");
    }
}

/// The install ended `done` after the usual step boundaries.
fn assert_done(events: &[InstallProgress]) {
    let last = events.last().unwrap();
    assert_eq!(last.step, InstallStep::Done, "{:?}", last.message);
    assert_eq!(last.pct, 100);
    assert!(last.skin_id.is_some());
    let marks: Vec<(InstallStep, u8)> = events.iter().map(|e| (e.step, e.pct)).collect();
    for boundary in [(InstallStep::Extract, 0), (InstallStep::Verify, 80), (InstallStep::Verify, 95)] {
        assert!(marks.contains(&boundary), "missing {boundary:?} in {marks:?}");
    }
    assert!(events.windows(2).all(|w| w[0].pct <= w[1].pct), "pct never goes back");
}

/// The error an archive's queue item carries (and returns when installing or reading textures).
fn assert_refused(env: &Env, path: &Path, message: &str) {
    let item = env.analyze(path);
    assert_eq!(item.status, QueueStatus::Error, "{item:?}");
    assert_eq!(item.error.as_deref(), Some(message));
    assert_eq!(item.size_bytes, fs::metadata(path).unwrap().len(), "the archive's own size");
    assert_eq!(err(env.prepare(&item.id, None, None)).message, message);
    assert_eq!(err(textures_for_queue(&env.queue, &item.id)).message, message);
    assert!(fs::read_dir(&env.user_skins).unwrap().next().is_none(), "nothing in UserSkins");
    assert!(message.is_ascii() && message.len() < 160, "short enough for a queue row");
}

// ── Entry names ─────────────────────────────────────────────────────────────

#[test]
fn entry_names_become_safe_relative_paths() {
    let ok = |raw: &str| entry_path(raw).unwrap();
    assert_eq!(ok("Winter Tiger/tiger.blk").as_deref(), Some("Winter Tiger/tiger.blk"));
    assert_eq!(ok("Winter Tiger\\sub\\a.dds").as_deref(), Some("Winter Tiger/sub/a.dds"), "\\ splits too");
    assert_eq!(ok("./a//b/").as_deref(), Some("a/b"));
    assert_eq!(ok("Skin/").as_deref(), Some("Skin"));
    assert_eq!(ok("/").as_deref(), None);
    assert_eq!(ok("Skin/.livery/x").as_deref(), None, "Livery's own files are never taken");
    assert_eq!(ok("Skin/.livery-partial").as_deref(), None);
}

#[test]
fn unsafe_entry_names_are_refused() {
    for raw in [
        "../evil.blk",
        "Skin/../../evil.blk",
        "..\\evil.blk",
        "/etc/passwd",
        "\\\\server\\share\\x.dds",
        "C:/Windows/x.dds",
        "C:x.dds",
        "Skin/file.dds:stream",
        "Skin/.. /x.dds",
        "Skin/x.dds.",
        "Skin/x ",
        "CON",
        "Skin/nul.txt",
        "Skin/COM1.dds",
        "Skin/LPT9",
        "con.dds.bak/x",
        "Skin/a\u{0}b.dds",
        "Skin/a?.dds",
        "Skin/a*.dds",
        "Skin/a|b.dds",
    ] {
        let e = err(entry_path(raw));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, UNSAFE_ENTRY), "{raw:?}");
    }
}

// ── ZIP ─────────────────────────────────────────────────────────────────────

#[test]
fn a_ready_zip_installs_exactly_like_its_folder() {
    let env = Env::new("zip-ready");
    let zip = write_zip(&env.download("winter_tiger.zip"), &packed("Winter Tiger"));
    let item = env.analyze(&zip);
    assert_eq!(item.status, QueueStatus::Ready, "{item:?}");
    assert_eq!(item.target_folder.as_deref(), Some("Winter Tiger"));
    assert_eq!(item.vehicle.as_ref().unwrap().code, "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    assert_eq!(item.texture_count, Some(2));
    assert_eq!(item.blk_ok, Some(true));
    assert_eq!(item.size_bytes, fs::metadata(&zip).unwrap().len());
    // The same file list a folder analysis gives.
    let folder_queue = QueueStore::default();
    let folder =
        analyze_path(&source_fixture("Winter Tiger"), None, &LibraryStore::detached(), &folder_queue).unwrap().item;
    assert_eq!(item.files, folder.files);
    assert_eq!(item.note, folder.note);

    let events = env.install(&item.id, None, None);
    assert_done(&events);
    assert_eq!(tree(&env.user_skins.join("Winter Tiger")), tree(&source_fixture("Winter Tiger")));
    let skin = env.store.all().into_iter().find(|s| s.folder == "Winter Tiger").unwrap();
    assert_eq!(skin.vehicle.code, "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    assert_eq!(env.queue.get(&item.id).unwrap().status, QueueStatus::Done);
    env.assert_clean();
}

#[test]
fn a_skin_at_the_top_of_an_archive_takes_the_archive_name() {
    let env = Env::new("zip-top");
    let zip = write_zip(&env.download("Tiger Winter.ZIP"), &entries_of(&source_fixture("Winter Tiger"), ""));
    let item = env.analyze(&zip);
    assert_eq!(item.status, QueueStatus::Ready);
    assert_eq!(item.file_name, "Tiger Winter.ZIP");
    assert_eq!(item.target_folder.as_deref(), Some("Tiger Winter"), "without the extension");
    assert_done(&env.install(&item.id, None, None));
    assert_eq!(tree(&env.user_skins.join("Tiger Winter")), tree(&source_fixture("Winter Tiger")));
}

#[test]
fn a_zip_whose_folder_is_taken_is_a_conflict() {
    let env = Env::new("zip-conflict");
    let owner = env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    let zip = write_zip(&env.download("winter_tiger.zip"), &packed("Winter Tiger"));
    let item = env.analyze(&zip);
    assert_eq!(item.status, QueueStatus::Conflict);
    assert_eq!(item.conflict_with.as_deref(), Some(owner.as_str()));
    assert_eq!(err(env.prepare(&item.id, None, Some(ConflictPolicy::Ask))).code, ErrorCode::Conflict);
    assert_done(&env.install(&item.id, None, Some(ConflictPolicy::Copy)));
    assert_eq!(tree(&env.user_skins.join("Winter Tiger (2)")), tree(&source_fixture("Winter Tiger")));
    env.assert_clean();
}

#[test]
fn a_zip_holding_several_skins_needs_a_pick() {
    let env = Env::new("zip-multi");
    let zip = write_zip(&env.download("desert_pack.zip"), &packed("Desert Pack"));
    let item = env.analyze(&zip);
    assert_eq!(item.status, QueueStatus::NeedsLook);
    assert_eq!(item.candidates.len(), 3);
    assert_eq!(err(env.prepare(&item.id, None, None)).code, ErrorCode::InvalidInput, "pick first");
    assert_done(&env.install(&item.id, Some("su_27"), None));
    assert_eq!(tree(&env.user_skins.join("Su-27 Desert")), tree(&source_fixture("Desert Pack").join("Su-27 Desert")));
    assert_eq!(
        fs::read_dir(&env.user_skins).unwrap().filter(|e| e.as_ref().unwrap().file_type().unwrap().is_dir()).count(),
        2,
        "Su-27 Desert and .livery"
    );
}

#[test]
fn a_zip_whose_blk_is_nested_installs_the_inner_folder() {
    let env = Env::new("zip-nested");
    let zip = write_zip(&env.download("nested.zip"), &packed("Nested Download"));
    let item = env.analyze(&zip);
    assert_eq!(item.status, QueueStatus::Ready);
    assert_eq!(item.target_folder.as_deref(), Some("Inner Skin"));
    assert_done(&env.install(&item.id, None, None));
    assert_eq!(
        tree(&env.user_skins.join("Inner Skin")),
        tree(&source_fixture("Nested Download").join("outer").join("Inner Skin"))
    );
}

#[test]
fn zip_slip_entries_refuse_the_whole_archive() {
    let env = Env::new("zip-slip");
    for (i, evil) in [
        "../evil.blk",
        "Skin/../../evil.blk",
        "/abs/evil.blk",
        "C:/evil.blk",
        "Skin\\..\\..\\evil.blk",
        "Skin/.. /evil.blk",
    ]
    .into_iter()
    .enumerate()
    {
        let zip = env.download(&format!("slip{i}.zip"));
        write_zip(&zip, &[file("Skin/su_27.blk", b"x{}"), file(evil, b"owned")]);
        assert_refused(&env, &zip, UNSAFE_ENTRY);
        let e = err(open_source(&zip));
        assert!(e.detail.unwrap().contains("evil.blk"), "the detail names the entry");
    }
    assert!(!env.tmp.path().join("evil.blk").exists());
    assert!(!env.tmp.path().join("downloads").join("evil.blk").exists());
    env.assert_clean();
}

#[test]
fn a_symlink_entry_refuses_the_whole_archive() {
    let env = Env::new("zip-link");
    let zip = env.download("link.zip");
    let mut writer = ZipWriter::new(fs::File::create(&zip).unwrap());
    writer.start_file("Skin/su_27.blk", SimpleFileOptions::default()).unwrap();
    writer.write_all(b"x{}").unwrap();
    writer.add_symlink("Skin/hull_c.dds", "../../../secret.dds", SimpleFileOptions::default()).unwrap();
    writer.finish().unwrap();
    assert_refused(&env, &zip, LINK_ENTRY);
}

#[test]
fn an_encrypted_zip_says_it_needs_a_password() {
    let env = Env::new("zip-locked");
    let zip = write_zip(&env.download("locked.zip"), &packed("Winter Tiger"));
    // Bit 0 of the general purpose flags: "encrypted" (the crate here can't write ZipCrypto).
    patch_zip(&zip, |central, local, bytes| {
        bytes[central + 8] |= 1;
        bytes[local + 6] |= 1;
    });
    assert_refused(&env, &zip, ARCHIVE_ENCRYPTED);
    assert_eq!(err(open_source(&zip)).code, ErrorCode::Unsupported);
}

#[test]
fn a_bomb_sized_declaration_is_refused_before_anything_is_written() {
    let env = Env::new("zip-bomb");
    let zip =
        write_zip(&env.download("bomb.zip"), &[file("Skin/su_27.blk", b"x{}"), file("Skin/hull_c.dds", &[0; 4096])]);
    // The central directory says the texture unpacks to ~4 GB.
    patch_zip(&zip, |central, local, bytes| {
        if bytes[central + 46..].starts_with(b"Skin/hull_c.dds") {
            bytes[central + 24..central + 28].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
            bytes[local + 22..local + 26].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
        }
    });
    assert!(u64::from(0xFFFF_FFF0u32) > MAX_FILE_BYTES);
    assert_refused(&env, &zip, ARCHIVE_TOO_BIG);
}

#[test]
fn the_caps_hold_for_data_that_really_unpacks_big() {
    let env = Env::new("zip-caps");
    // 3 MB of zeros deflates to a few KB.
    let zip = write_zip(
        &env.download("zeros.zip"),
        &[file("Skin/su_27.blk", b"x{}"), file("Skin/hull_c.dds", &vec![0; 3 << 20])],
    );
    assert!(fs::metadata(&zip).unwrap().len() < 64 * 1024);
    let small = Limits { max_entries: 100, max_total_bytes: 1 << 20, max_file_bytes: 1 << 20 };
    let e = err(open_source_with(&zip, small));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ARCHIVE_TOO_BIG));
    let total = Limits { max_file_bytes: 8 << 20, ..small };
    assert_eq!(err(open_source_with(&zip, total)).message, ARCHIVE_TOO_BIG, "the total is capped too");

    let many: Vec<Entry> = (0..12).map(|i| file(&format!("Skin/f{i}.txt"), b"x")).collect();
    let crowded = write_zip(&env.download("many.zip"), &many);
    let few = Limits { max_entries: 10, ..Limits::DEFAULT };
    let e = err(open_source_with(&crowded, few));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ARCHIVE_TOO_MANY_FILES));
    assert!(open_source_with(&crowded, Limits { max_entries: 13, ..Limits::DEFAULT }).is_ok(), "12 files + 1 folder");
}

#[test]
fn a_declared_size_that_lies_never_installs() {
    let env = Env::new("zip-lie");
    let zip =
        write_zip(&env.download("lie.zip"), &[file("Skin/su_27.blk", b"x{}"), file("Skin/hull_c.dds", &[7; 5000])]);
    // Declares 10 bytes for a texture whose data unpacks to 5000.
    patch_zip(&zip, |central, local, bytes| {
        if bytes[central + 46..].starts_with(b"Skin/hull_c.dds") {
            bytes[central + 24..central + 28].copy_from_slice(&10u32.to_le_bytes());
            bytes[local + 22..local + 26].copy_from_slice(&10u32.to_le_bytes());
        }
    });
    let item = env.analyze(&zip);
    assert_eq!(item.status, QueueStatus::Ready, "the headers alone look fine");
    let events = env.install(&item.id, None, None);
    let last = events.last().unwrap();
    assert_eq!(last.step, InstallStep::Error);
    assert_eq!(last.message.as_deref(), Some(ARCHIVE_DAMAGED));
    assert!(!env.user_skins.join("Skin").exists());
    assert_eq!(env.queue.get(&item.id).unwrap().status, QueueStatus::Error);
    env.assert_clean();
}

#[test]
fn a_truncated_zip_is_damaged() {
    let env = Env::new("zip-cut");
    let zip = write_zip(&env.download("cut.zip"), &packed("Winter Tiger"));
    let bytes = fs::read(&zip).unwrap();
    fs::write(&zip, &bytes[..bytes.len() / 2]).unwrap();
    assert_refused(&env, &zip, ARCHIVE_DAMAGED);
}

#[test]
fn names_differing_only_in_case_are_one_file_and_one_folder() {
    let tmp = TempDir::new("zip-case");
    let zip = write_zip(
        &tmp.path().join("case.zip"),
        &[file("Skin/su_27.blk", b"x{}"), file("skin/HULL.dds", b"first"), file("SKIN/hull.dds", b"second")],
    );
    let source = open_source(&zip).unwrap();
    let paths: Vec<(String, bool)> = source.entries().unwrap().into_iter().map(|e| (e.path, e.is_dir)).collect();
    assert_eq!(
        paths,
        [("Skin".to_owned(), true), ("Skin/HULL.dds".to_owned(), false), ("Skin/su_27.blk".to_owned(), false)]
    );
    let out = tmp.path().join("out");
    fs::create_dir(&out).unwrap();
    source.extract("Skin", &out, &mut |_| Ok(())).unwrap();
    assert_eq!(tree(&out), [("HULL.dds".to_owned(), b"first".to_vec()), ("su_27.blk".to_owned(), b"x{}".to_vec())]);
}

#[test]
fn zip_reads_give_the_first_bytes_of_listed_files() {
    let tmp = TempDir::new("zip-read");
    let zip = write_zip(&tmp.path().join("r.zip"), &packed("Winter Tiger"));
    let source = open_source(&zip).unwrap();
    let blk = fs::read(source_fixture("Winter Tiger").join("germ_pzkpfw_VI_ausf_b_tiger_IIH.blk")).unwrap();
    assert_eq!(source.read("Winter Tiger/germ_pzkpfw_VI_ausf_b_tiger_IIH.blk", 10).unwrap(), &blk[..10]);
    let many =
        source.read_many(&[("Winter Tiger/tiger_camo.tga".into(), 4), ("Winter Tiger/missing.dds".into(), 4)]).unwrap();
    assert_eq!(many.len(), 1);
    assert_eq!(err(source.read("Winter Tiger/missing.dds", 4)).message, SOURCE_GONE);
    assert!(source.local_dir("Winter Tiger").is_none(), "nothing on disk to look at");
}

#[test]
fn textures_of_a_queued_archive_read_like_the_folder() {
    let env = Env::new("zip-textures");
    let zip = write_zip(&env.download("winter_tiger.zip"), &packed("Winter Tiger"));
    let item = env.analyze(&zip);
    let from_zip = textures_for_queue(&env.queue, &item.id).unwrap();
    let folder = env.analyze(&source_fixture("Winter Tiger"));
    let from_folder = textures_for_queue(&env.queue, &folder.id).unwrap();
    assert_eq!(from_zip, from_folder);
    assert!(from_zip.iter().any(|t| t.format.is_some() && t.width.is_some()), "{from_zip:?}");
    assert!(!std::env::temp_dir().read_dir().unwrap().any(|e| {
        let name = e.unwrap().file_name().to_string_lossy().into_owned();
        name.starts_with("livery-textures-") && name.contains(&item.id)
    }));
}

// ── 7z ──────────────────────────────────────────────────────────────────────

#[test]
fn a_ready_7z_installs_exactly_like_its_folder_solid_or_not() {
    for solid in [false, true] {
        let env = Env::new("7z-ready");
        let archive = write_7z(&env.download("winter_tiger.7z"), &packed("Winter Tiger"), solid);
        let item = env.analyze(&archive);
        assert_eq!(item.status, QueueStatus::Ready, "solid {solid}: {item:?}");
        assert_eq!(item.target_folder.as_deref(), Some("Winter Tiger"));
        assert_eq!(item.blk_ok, Some(true));
        assert_done(&env.install(&item.id, None, None));
        assert_eq!(tree(&env.user_skins.join("Winter Tiger")), tree(&source_fixture("Winter Tiger")), "solid {solid}");
        env.assert_clean();
    }
}

#[test]
fn a_7z_holding_several_skins_needs_a_pick_and_installs_one() {
    let env = Env::new("7z-multi");
    let archive = write_7z(&env.download("desert_pack.7z"), &packed("Desert Pack"), true);
    let item = env.analyze(&archive);
    assert_eq!(item.status, QueueStatus::NeedsLook);
    assert_eq!(item.candidates.len(), 3);
    assert_done(&env.install(&item.id, Some("f_4e"), None));
    assert_eq!(
        tree(&env.user_skins.join("Phantom Desert")),
        tree(&source_fixture("Desert Pack").join("Phantom Desert"))
    );
}

#[test]
fn a_7z_conflict_and_a_nested_blk() {
    let env = Env::new("7z-conflict");
    env.installed("Inner Skin", "su_27");
    let archive = write_7z(&env.download("nested.7z"), &packed("Nested Download"), false);
    let item = env.analyze(&archive);
    assert_eq!(item.status, QueueStatus::Conflict);
    assert_eq!(item.target_folder.as_deref(), Some("Inner Skin"));
    let events = env.install(&item.id, None, Some(ConflictPolicy::Replace));
    assert_done(&events);
    assert!(events.last().unwrap().backup_id.is_some());
    assert_eq!(
        tree(&env.user_skins.join("Inner Skin")),
        tree(&source_fixture("Nested Download").join("outer").join("Inner Skin"))
    );
}

#[test]
fn encrypted_7z_archives_say_they_need_a_password() {
    let env = Env::new("7z-locked");
    for encrypt_header in [false, true] {
        let path = env.download(&format!("locked-{encrypt_header}.7z"));
        let mut writer = ArchiveWriter::create(&path).unwrap();
        writer.set_content_methods(vec![
            AesEncoderOptions::new(Password::from("secret")).into(),
            EncoderMethod::LZMA2.into(),
        ]);
        writer.set_encrypt_header(encrypt_header);
        for (name, bytes) in packed("Winter Tiger") {
            writer.push_archive_entry(sevenz_entry(&name, &bytes), bytes.as_deref()).unwrap();
        }
        writer.finish().unwrap();
        assert_refused(&env, &path, ARCHIVE_ENCRYPTED);
    }
}

#[test]
fn links_and_unsafe_names_in_a_7z_refuse_it() {
    let env = Env::new("7z-unsafe");
    // A Unix symlink (7-Zip's 0x8000 marker + mode in the high bits), then a Windows reparse point.
    for (i, attributes) in [0x8000 | (0o120_777 << 16), 0x400 | 0x20].into_iter().enumerate() {
        let path = env.download(&format!("link{i}.7z"));
        let mut writer = ArchiveWriter::create(&path).unwrap();
        writer.push_archive_entry(ArchiveEntry::new_file("Skin/su_27.blk"), Some(&b"x{}"[..])).unwrap();
        let mut link = ArchiveEntry::new_file("Skin/hull_c.dds");
        link.has_windows_attributes = true;
        link.windows_attributes = attributes;
        writer.push_archive_entry(link, Some(&b"../../secret"[..])).unwrap();
        writer.finish().unwrap();
        assert_refused(&env, &path, LINK_ENTRY);
    }
    let slip =
        write_7z(&env.download("slip.7z"), &[file("Skin/su_27.blk", b"x{}"), file("../../evil.blk", b"owned")], false);
    assert_refused(&env, &slip, UNSAFE_ENTRY);
    assert!(!env.tmp.path().parent().unwrap().join("evil.blk").exists());
}

#[test]
fn empty_files_in_a_7z_unpack_wherever_they_sit() {
    let tmp = TempDir::new("7z-empty");
    let entries = [file("Skin/a.blk", b"x{}"), file("Skin/b_empty.txt", b""), file("Skin/c.dds", b"DDS data")];
    for solid in [false, true] {
        let archive = write_7z(&tmp.path().join(format!("e{solid}.7z")), &entries, solid);
        let out = tmp.path().join(format!("out{solid}"));
        fs::create_dir(&out).unwrap();
        let tick = open_source(&archive).unwrap().extract("Skin", &out, &mut |_| Ok(())).unwrap();
        assert_eq!((tick.files_done, tick.bytes_done), (3, 11));
        let files = tree(&out);
        let expected = [("a.blk", &b"x{}"[..]), ("b_empty.txt", b""), ("c.dds", b"DDS data")];
        assert_eq!(files.len(), 3, "solid {solid}");
        for ((path, bytes), (want_path, want)) in files.iter().zip(expected) {
            assert_eq!((path.as_str(), bytes.as_slice()), (want_path, want), "solid {solid}");
        }
    }
}

#[test]
fn a_7z_bomb_is_capped() {
    let tmp = TempDir::new("7z-bomb");
    let archive = write_7z(
        &tmp.path().join("zeros.7z"),
        &[file("Skin/su_27.blk", b"x{}"), file("Skin/hull_c.dds", &vec![0; 3 << 20])],
        true,
    );
    assert!(fs::metadata(&archive).unwrap().len() < 64 * 1024);
    let small = Limits { max_entries: 100, max_total_bytes: 1 << 20, max_file_bytes: 1 << 20 };
    assert_eq!(err(open_source_with(&archive, small)).message, ARCHIVE_TOO_BIG);
    assert!(open_source(&archive).is_ok());
}

#[test]
fn a_damaged_7z_is_refused() {
    let env = Env::new("7z-cut");
    let archive = write_7z(&env.download("cut.7z"), &packed("Winter Tiger"), true);
    let mut bytes = fs::read(&archive).unwrap();
    bytes.truncate(bytes.len() - 20);
    fs::write(&archive, bytes).unwrap();
    assert_refused(&env, &archive, ARCHIVE_DAMAGED);
}

#[test]
fn a_7z_with_a_compressed_header_opens() {
    let tmp = TempDir::new("7z-encoded-header");
    let mut entries = vec![file("Skin/su_27.blk", b"x{}")];
    entries.extend((0..300).map(|i| file(&format!("Skin/decals/decal_number_{i:04}_c.dds"), b"DDS ")));
    let archive = write_7z(&tmp.path().join("many.7z"), &entries, true);
    let bytes = fs::read(&archive).unwrap();
    let next = 32 + u64::from_le_bytes(bytes[12..20].try_into().unwrap()) as usize;
    assert_eq!(bytes[next], 0x17, "the writer compressed the header");
    let source = open_source(&archive).unwrap();
    assert_eq!(source.entries().unwrap().iter().filter(|e| !e.is_dir).count(), 301);
}

/// A 7z whose header is compressed ("encoded") with LZMA (`dictionary`), saying it unpacks to
/// `unpacked` bytes; 16 bytes of packed data that would never decode. Checksums are valid.
fn sevenz_with_encoded_header(path: &Path, dictionary: u32, unpacked: u64) -> PathBuf {
    let packed = [0x5Du8; 16];
    // PackInfo (at 0, one stream of 16 bytes), UnpackInfo (one folder, one LZMA coder).
    let mut next = vec![0x17, 0x06, 0x00, 0x01, 0x09, 16, 0x00, 0x07, 0x0B, 0x01, 0x00];
    next.extend([0x01, 0x23, 0x03, 0x01, 0x01, 0x05, 0x5D]);
    next.extend(dictionary.to_le_bytes());
    next.push(0x0C);
    next.extend(sevenz_number(unpacked));
    next.extend([0x00, 0x00]);
    let mut start = Vec::new();
    start.extend((packed.len() as u64).to_le_bytes());
    start.extend((next.len() as u64).to_le_bytes());
    start.extend(crc32(&next).to_le_bytes());
    let mut bytes = b"7z\xBC\xAF\x27\x1C\x00\x04".to_vec();
    bytes.extend(crc32(&start).to_le_bytes());
    bytes.extend(&start);
    bytes.extend(packed);
    bytes.extend(&next);
    fs::write(path, bytes).unwrap();
    path.to_path_buf()
}

#[test]
fn a_7z_header_bomb_is_refused_before_the_header_is_unpacked() {
    let env = Env::new("7z-header-bomb");
    // The crate would decode a compressed header into memory before listing a single entry.
    let bomb = sevenz_with_encoded_header(&env.download("bomb.7z"), 1 << 16, 1 << 30);
    assert_refused(&env, &bomb, ARCHIVE_TOO_BIG);
    let greedy = sevenz_with_encoded_header(&env.download("greedy.7z"), 1 << 30, 1 << 10);
    assert_eq!(err(open_source(&greedy)).message, ARCHIVE_METHOD);
    // Within the caps the crate reads it, and finds the packed data doesn't decode.
    let small = sevenz_with_encoded_header(&env.download("small.7z"), 1 << 16, 1 << 10);
    assert_eq!(err(open_source(&small)).message, ARCHIVE_DAMAGED);
}

#[test]
fn an_unfinished_7z_is_damaged() {
    let env = Env::new("7z-unfinished");
    let archive = write_7z(&env.download("unfinished.7z"), &packed("Winter Tiger"), true);
    let mut bytes = fs::read(&archive).unwrap();
    // 7-Zip writes the start header last: an interrupted archive has zeros there, and the crate
    // would go looking for a header in the last megabyte.
    bytes[8..32].fill(0);
    fs::write(&archive, bytes).unwrap();
    assert_refused(&env, &archive, ARCHIVE_DAMAGED);
}

#[test]
fn stale_texture_scratch_folders_are_purged() {
    let tmp = TempDir::new("textures-scratch");
    let fresh = tmp.path().join("livery-textures-fresh");
    let other = tmp.path().join("someone-else");
    fs::create_dir_all(&fresh).unwrap();
    fs::create_dir_all(&other).unwrap();
    assert_eq!(purge_textures_scratch(tmp.path()), 0, "a scratch folder in use stays");
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS opens a folder; its time is set back two hours.
        let handle = fs::OpenOptions::new().write(true).custom_flags(0x0200_0000).open(&fresh).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        handle.set_modified(old).unwrap();
        drop(handle);
        assert_eq!(purge_textures_scratch(tmp.path()), 1);
        assert!(!fresh.exists());
    }
    assert!(other.exists(), "only Livery's scratch folders");
}

#[test]
fn textures_of_a_queued_7z_read_like_the_folder() {
    let env = Env::new("7z-textures");
    let archive = write_7z(&env.download("winter_tiger.7z"), &packed("Winter Tiger"), true);
    let item = env.analyze(&archive);
    let folder = env.analyze(&source_fixture("Winter Tiger"));
    assert_eq!(textures_for_queue(&env.queue, &item.id).unwrap(), textures_for_queue(&env.queue, &folder.id).unwrap());
}

// ── RAR (committed fixtures) ────────────────────────────────────────────────

#[test]
fn a_ready_rar_installs() {
    let env = Env::new("rar-ready");
    let rar = rar_fixture("winter_tiger.rar");
    let item = env.analyze(&rar);
    assert_eq!(item.status, QueueStatus::Ready, "{item:?}");
    assert_eq!(item.target_folder.as_deref(), Some("Winter Tiger"));
    assert_eq!(item.vehicle.as_ref().unwrap().code, "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    let files: Vec<(&str, u64)> = item.files.iter().map(|f| (f.path.as_str(), f.size_bytes)).collect();
    assert_eq!(files, [("germ_pzkpfw_VI_ausf_b_tiger_IIH.blk", 73), ("tiger_c.dds", 9)]);
    assert_eq!(item.size_bytes, fs::metadata(&rar).unwrap().len());

    let source = open_source(&rar).unwrap();
    let read = source.read_many(&[("Winter Tiger/tiger_c.dds".into(), 4)]).unwrap();
    assert_eq!(read["Winter Tiger/tiger_c.dds"].len(), 4);

    assert_done(&env.install(&item.id, None, None));
    let installed = tree(&env.user_skins.join("Winter Tiger"));
    let sizes: Vec<(&str, usize)> = installed.iter().map(|(p, b)| (p.as_str(), b.len())).collect();
    assert_eq!(sizes, [("germ_pzkpfw_VI_ausf_b_tiger_IIH.blk", 73), ("tiger_c.dds", 9)]);
    assert_eq!(read["Winter Tiger/tiger_c.dds"], installed[1].1[..4]);
    env.assert_clean();
}

#[test]
fn password_protected_rars_say_so() {
    let env = Env::new("rar-locked");
    // File data encrypted (names readable), then encrypted headers (nothing readable).
    for name in ["locked.rar", "locked_headers.rar"] {
        let e = err(open_source(&rar_fixture(name)));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, ARCHIVE_ENCRYPTED), "{name}: {e:?}");
        assert_refused(&env, &rar_fixture(name), ARCHIVE_ENCRYPTED);
    }
}

#[test]
fn every_volume_of_a_split_rar_says_it_is_split() {
    let env = Env::new("rar-split");
    for name in ["split.part1.rar", "split.part2.rar"] {
        let e = err(open_source(&rar_fixture(name)));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, ARCHIVE_SPLIT), "{name}: {e:?}");
        assert_refused(&env, &rar_fixture(name), ARCHIVE_SPLIT);
    }
}

#[test]
fn a_rar_holding_a_symlink_is_refused() {
    let env = Env::new("rar-link");
    // `Skin/hull_c.dds` is a Windows symbolic link to `..\secret.dds` (stored with `rar -ol`).
    assert_refused(&env, &rar_fixture("link.rar"), LINK_ENTRY);
}

#[test]
fn rar_dictionaries_are_capped_before_unrar_decodes() {
    let env = Env::new("rar-dictionary");
    // The fixture as is stores a 128 KiB dictionary (compression information 0).
    let fine = patched_rar(&env.download("fine.rar"), |_| {});
    assert_eq!(env.analyze(&fine).status, QueueStatus::Ready);
    // RAR 5, 512 MiB (128 KiB << 12): above the cap, UnRAR would allocate it.
    let big = patched_rar(&env.download("big.rar"), |h| {
        h.splice(RAR_COMPRESSION_AT, [0x80, 0x60]);
    });
    assert_refused(&env, &big, ARCHIVE_METHOD);
    // RAR 7, 8 GiB (128 KiB << 16): above UnRAR's 4 GiB default, it answers ERAR_LARGE_DICT,
    // which the `unrar` crate `unwrap()`s (a panic, an abort in release builds).
    let huge = patched_rar(&env.download("huge.rar"), |h| {
        h.splice(RAR_COMPRESSION_AT, [0x81, 0x80, 0x01]);
    });
    let e = err(open_source(&huge));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, ARCHIVE_METHOD), "{e:?}");
    assert!(e.detail.unwrap().contains("8589934592-byte dictionary"));
    assert_refused(&env, &huge, ARCHIVE_METHOD);
}

#[test]
fn a_rar_hard_link_or_file_copy_is_refused() {
    let env = Env::new("rar-hardlink");
    for kind in [4u8, 5] {
        // A redirection record (size 4: type 5, kind, flags 0, empty name) in the extra area.
        let rar = patched_rar(&env.download(&format!("redirect{kind}.rar")), |h| {
            h[2] += 5;
            h.extend([0x04, 0x05, kind, 0x00, 0x00]);
        });
        assert_refused(&env, &rar, LINK_ENTRY);
    }
}

#[test]
fn a_rar_named_file_without_a_rar_signature_is_not_an_archive() {
    let env = Env::new("rar-renamed");
    let mut bytes = b"MZ".to_vec();
    bytes.extend(fs::read(rar_fixture("winter_tiger.rar")).unwrap());
    let sfx = env.download("setup.rar");
    fs::write(&sfx, bytes).unwrap();
    let item = env.analyze(&sfx);
    assert_eq!(item.status, QueueStatus::Error, "{item:?}");
    assert_eq!(item.error.as_deref(), Some(NOT_AN_ARCHIVE));
}

#[test]
fn a_damaged_rar_is_refused() {
    let env = Env::new("rar-cut");
    let bytes = fs::read(rar_fixture("winter_tiger.rar")).unwrap();
    let cut = env.download("cut.rar");
    fs::write(&cut, &bytes[..40]).unwrap();
    let item = env.analyze(&cut);
    assert_eq!(item.status, QueueStatus::Error, "{item:?}");
    assert!(item.error.is_some());
}

// ── Export ──────────────────────────────────────────────────────────────────

/// A My Hangar with the Winter Tiger skin (plus Livery's own marker files, never exported).
fn hangar(env: &Env) -> String {
    let dir = env.user_skins.join("Winter Tiger");
    for (path, bytes) in tree(&source_fixture("Winter Tiger")) {
        let to = dir.join(&path);
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::write(to, bytes).unwrap();
    }
    fs::write(dir.join("preview.png"), [0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
    import_folders(&env.user_skins, &env.store, &["Winter Tiger".to_owned()]).unwrap();
    env.store.all().into_iter().find(|s| s.folder == "Winter Tiger").unwrap().id
}

#[test]
fn export_writes_one_zip_per_skin_that_installs_back_the_same() {
    let env = Env::new("export");
    let id = hangar(&env);
    let dest = env.tmp.path().join("downloads");
    let ids = vec![id.clone(), "unknown".to_owned(), id.clone()];
    let result = export_zip(&env.user_skins, &env.store, &ids, &dest).unwrap();
    assert_eq!(result.exported, 1, "unknown ids and repeats are skipped");
    let zip = dest.join("Winter Tiger.zip");
    assert!(zip.is_file());

    // Folder inside, PNG stored, the rest deflated.
    let mut archive = ZipArchive::new(fs::File::open(&zip).unwrap()).unwrap();
    let names: Vec<String> = archive.file_names().map(str::to_owned).collect();
    assert!(names.iter().all(|n| n.starts_with("Winter Tiger/")), "{names:?}");
    assert_eq!(archive.by_name("Winter Tiger/preview.png").unwrap().compression(), CompressionMethod::Stored);
    assert_eq!(archive.by_name("Winter Tiger/tiger_body_c.dds").unwrap().compression(), CompressionMethod::Deflated);
    let mut blk = String::new();
    archive.by_name("Winter Tiger/germ_pzkpfw_VI_ausf_b_tiger_IIH.blk").unwrap().read_to_string(&mut blk).unwrap();
    assert!(blk.contains("replace_tex"));

    // A second export doesn't overwrite: "(2)".
    export_as(&env.user_skins, &env.store, std::slice::from_ref(&id), &dest, ExportFormat::Zip).unwrap();
    assert!(dest.join("Winter Tiger (2).zip").is_file());
    let leftovers: Vec<String> = fs::read_dir(&dest)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".part"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // Round trip: the exported zip installs as the same folder, same files.
    let other = Env::new("export-back");
    let item = other.analyze(&zip);
    assert_eq!(item.status, QueueStatus::Ready);
    assert_eq!(item.target_folder.as_deref(), Some("Winter Tiger"));
    assert_done(&other.install(&item.id, None, None));
    assert_eq!(tree(&other.user_skins.join("Winter Tiger")), tree(&env.user_skins.join("Winter Tiger")));
}

#[test]
fn export_as_folder_still_copies_folders() {
    let env = Env::new("export-folder");
    let id = hangar(&env);
    let dest = env.tmp.path().join("downloads");
    let result = export_as(&env.user_skins, &env.store, &[id], &dest, ExportFormat::Folder).unwrap();
    assert_eq!(result.exported, 1);
    assert_eq!(tree(&dest.join("Winter Tiger")), tree(&env.user_skins.join("Winter Tiger")));
    let e = err(export_zip(&env.user_skins, &env.store, &[], &dest.join("missing")));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, "The export folder can't be found"));
}

#[test]
fn the_export_format_reads_from_the_command_argument() {
    assert_eq!(serde_json::from_str::<ExportFormat>("\"zip\"").unwrap(), ExportFormat::Zip);
    assert_eq!(serde_json::from_str::<ExportFormat>("\"folder\"").unwrap(), ExportFormat::Folder);
    assert_eq!(ExportFormat::default(), ExportFormat::Zip);
}
