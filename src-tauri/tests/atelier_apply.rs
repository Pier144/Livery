//! Atelier's apply on temp game and data folders: begin stages in `UserSkins/.livery/partial`,
//! each painted slot becomes a DXT5 `.dds`, commit writes the `.blk` and installs the skin (a new
//! one, or over the project's skin keeping its id); cancel and errors leave nothing behind.

use livery_lib::archive::generated::Target;
use livery_lib::archive::{partial_dir, QueueStore};
use livery_lib::atelier::apply::{
    self, blk_text, encode_painted, folder_name, Applies, ApplyJob, APPLY_BAD_SLOT, APPLY_FAILED, APPLY_NOTHING,
    APPLY_NOT_FOUND, CLUSTER_FIT_MAX_SIDE, STALE_APPLY,
};
use livery_lib::atelier::project::ProjectStore;
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::library::index::LibraryStore;
use livery_lib::model::{ApplyStep, AtelierProject, AtelierSlotChoice, Origin};
use livery_lib::textures::bc::{decode, encode_dxt5, APPLY_BAD_TEXTURE};
use livery_lib::textures::header::parse_dds;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-apply-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn err<T>(result: Result<T, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

const JUMBO: &str = "us_m4a3e2_sherman_jumbo";
const BODY: &str = "m4a3e2_sherman_jumbo_body_c";
const TURRET: &str = "m4a3e2_sherman_jumbo_turret_c";
const MOUNT: &str = "mg_browning_m2hb_mount_c";

struct Env {
    _tmp: TempDir,
    user_skins: PathBuf,
    store: LibraryStore,
    queue: QueueStore,
    projects: ProjectStore,
}

impl Env {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        let user_skins = tmp.0.join("game").join("UserSkins");
        fs::create_dir_all(&user_skins).unwrap();
        let store = LibraryStore::load(tmp.0.join("data").join("library.json"));
        let projects = ProjectStore::new(&tmp.0.join("data").join("atelier"));
        Self { _tmp: tmp, user_skins, store, queue: QueueStore::default(), projects }
    }

    fn project(&self, name: &str) -> AtelierProject {
        let slots = [(BODY, true), (TURRET, true), (MOUNT, false)]
            .map(|(t, enabled)| AtelierSlotChoice { texture: t.into(), enabled })
            .to_vec();
        self.projects.create(name, JUMBO, slots, SystemTime::now()).unwrap()
    }

    fn begin(&self, project: &AtelierProject, enabled: &[&str]) -> (String, ApplyJob) {
        apply::begin(&self.user_skins, &self.queue, project, enabled.iter().map(|s| s.to_string()).collect()).unwrap()
    }

    fn commit(&self, job: ApplyJob, target: Target) -> Result<livery_lib::archive::generated::Generated, AppError> {
        self.commit_with(job, None, target)
    }

    fn commit_with(
        &self,
        job: ApplyJob,
        preview: Option<&[u8]>,
        target: Target,
    ) -> Result<livery_lib::archive::generated::Generated, AppError> {
        apply::commit(job, preview, &self.user_skins, &self.store, target, true, 30, SystemTime::now())
    }
}

/// A `side`×`side` RGBA image of one colour.
fn image(side: u32, rgba: [u8; 4]) -> Vec<u8> {
    rgba.repeat((side * side) as usize)
}

fn paint(job: &mut ApplyJob, slot: &str, side: u32) -> Result<(), AppError> {
    apply::texture(job, slot, side, side, &image(side, [200, 120, 40, 255]), &mut |_, _| {})
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

#[test]
fn the_blk_sets_each_painted_texture() {
    assert_eq!(
        blk_text(&[BODY.to_owned(), "Tank_Turret_C".to_owned()]),
        "name:t=\"user\"\n\
         \n\
         set_tex{\n  from:t=\"m4a3e2_sherman_jumbo_body_c*\"\n  to:t=\"m4a3e2_sherman_jumbo_body.dds\"\n  param:t=\"camo_skin_tex\"\n}\n\
         \n\
         set_tex{\n  from:t=\"Tank_Turret_c*\"\n  to:t=\"Tank_Turret.dds\"\n  param:t=\"camo_skin_tex\"\n}\n"
    );
}

#[test]
fn begin_texture_texture_commit_installs_a_new_skin() {
    let env = Env::new("new");
    let project = env.project("Desert");
    let (id, mut job) = env.begin(&project, &[BODY, TURRET]);
    assert!(id.starts_with("a-"), "{id}");
    assert_eq!(job.project_id, project.id);
    let folder = folder_name(&project);
    assert_eq!(folder, format!("{JUMBO}_Desert"));
    assert_eq!(job.root, partial_dir(&env.user_skins).join(&id));
    assert_eq!(job.dir, job.root.join(&folder));
    assert!(job.dir.is_dir());

    let mut steps = Vec::new();
    apply::texture(&mut job, BODY, 8, 8, &image(8, [10, 20, 30, 255]), &mut |step, pct| steps.push((step, pct)))
        .unwrap();
    apply::texture(&mut job, TURRET, 4, 4, &image(4, [1, 2, 3, 0]), &mut |step, pct| steps.push((step, pct))).unwrap();
    assert_eq!(
        steps,
        [(ApplyStep::Encode, 0), (ApplyStep::Write, 22), (ApplyStep::Encode, 45), (ApplyStep::Write, 67)]
    );
    let body = fs::read(job.dir.join("m4a3e2_sherman_jumbo_body.dds")).unwrap();
    let header = parse_dds(&body).unwrap();
    assert_eq!((header.width, header.height, header.format.as_str()), (8, 8, "BC3"));
    // 8×8 and its 4×4 mip.
    assert_eq!(body.len(), 128 + 4 * 16 + 16);
    assert_eq!(u32::from_le_bytes(body[28..32].try_into().unwrap()), 2, "mipmap count");

    let root = job.root.clone();
    let done = env.commit(job, Target::New(folder.clone())).unwrap();
    assert_eq!(done.backup_id, None);
    assert_eq!(done.skin.origin, Origin::Mine);
    assert_eq!(done.skin.folder, folder);
    assert_eq!(done.skin.vehicle.code, JUMBO);
    assert!(done.skin.active);
    assert!(done.skin.attention.is_empty(), "{:?}", done.skin.attention);
    let installed = env.user_skins.join(&folder);
    assert_eq!(
        names_in(&installed),
        ["m4a3e2_sherman_jumbo_body.dds", "m4a3e2_sherman_jumbo_turret.dds", &format!("{JUMBO}.blk")]
    );
    assert_eq!(
        fs::read_to_string(installed.join(format!("{JUMBO}.blk"))).unwrap(),
        blk_text(&[BODY.to_owned(), TURRET.to_owned()])
    );
    assert!(!root.exists(), "the staging folder went");
    assert_eq!(env.store.all(), vec![done.skin]);
}

#[test]
fn only_written_slots_go_into_the_blk_in_enabled_order() {
    let env = Env::new("order");
    let project = env.project("Order");
    let (_, mut job) = env.begin(&project, &[BODY, TURRET]);
    paint(&mut job, TURRET, 4).unwrap();
    // A slot written twice is overwritten.
    paint(&mut job, TURRET, 8).unwrap();
    let done = env.commit(job, Target::New(folder_name(&project))).unwrap();
    let installed = env.user_skins.join(&done.skin.folder);
    assert_eq!(fs::read_to_string(installed.join(format!("{JUMBO}.blk"))).unwrap(), blk_text(&[TURRET.to_owned()]));
    let turret = fs::read(installed.join("m4a3e2_sherman_jumbo_turret.dds")).unwrap();
    assert_eq!(parse_dds(&turret).unwrap().width, 8);
}

#[test]
fn commit_with_no_texture_installs_nothing() {
    let env = Env::new("nothing");
    let project = env.project("Empty");
    let (_, job) = env.begin(&project, &[BODY]);
    let root = job.root.clone();
    let e = err(env.commit(job, Target::New("x".into())));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, APPLY_NOTHING));
    assert!(!root.exists());
    assert!(env.store.all().is_empty());
    assert_eq!(names_in(&env.user_skins), [".livery"]);

    let e = err(apply::begin(&env.user_skins, &env.queue, &project, Vec::new()));
    assert_eq!(e.message, APPLY_NOTHING);
}

#[test]
fn wrong_sizes_and_slots_are_refused() {
    let env = Env::new("sizes");
    let project = env.project("Sizes");
    let (_, mut job) = env.begin(&project, &[BODY]);
    let bad_size = |e: AppError| assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, APPLY_BAD_TEXTURE));
    let none = &mut |_: ApplyStep, _: u8| {};
    bad_size(err(apply::texture(&mut job, BODY, 6, 4, &image(6, [0; 4])[..96], none)));
    bad_size(err(apply::texture(&mut job, BODY, 0, 0, &[], none)));
    bad_size(err(apply::texture(&mut job, BODY, 8192, 4, &[], none)));
    bad_size(err(apply::texture(&mut job, BODY, 8, 8, &image(4, [0; 4]), none)));
    bad_size(err(apply::texture(&mut job, BODY, u32::MAX - 3, u32::MAX - 3, &[], none)));

    let bad_slot = |e: AppError| assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, APPLY_BAD_SLOT));
    // Not turned on for this apply, not a slot of the project, not a `_c` texture.
    for slot in [TURRET, "other_body_c", "../../evil_c", "m4a3e2_sherman_jumbo_body_n"] {
        bad_slot(err(paint(&mut job, slot, 4)));
    }
    // Case doesn't matter.
    paint(&mut job, &BODY.to_uppercase(), 4).unwrap();
    assert_eq!(names_in(&job.dir), ["m4a3e2_sherman_jumbo_body.dds"]);

    for enabled in [vec![MOUNT, "not_in_project_c"], vec!["../x_c"], vec!["body_n"]] {
        let e =
            err(apply::begin(&env.user_skins, &env.queue, &project, enabled.iter().map(|s| s.to_string()).collect()));
        assert_eq!(e.message, APPLY_BAD_SLOT, "{enabled:?}");
    }
    // A slot that is off in the saved project can still be applied (the toggle wasn't saved yet).
    let (_, mut job) = env.begin(&project, &[MOUNT]);
    paint(&mut job, MOUNT, 4).unwrap();
    apply::cancel(job);
}

#[test]
fn cancel_removes_the_staging_folder() {
    let env = Env::new("cancel");
    let project = env.project("Cancel");
    let (_, mut job) = env.begin(&project, &[BODY]);
    paint(&mut job, BODY, 4).unwrap();
    let root = job.root.clone();
    apply::cancel(job);
    assert!(!root.exists());
    assert!(env.store.all().is_empty());
}

#[test]
fn the_queue_purge_after_begin_spares_the_apply() {
    let env = Env::new("purge");
    let project = env.project("Purge");
    let (_, mut job) = env.begin(&project, &[BODY]);
    // A queue or WT Live action later in the session purges stale staging "once per session":
    // begin already did, so the apply's folder stays.
    env.queue.ensure_partials_purged(&env.user_skins);
    assert!(job.dir.is_dir());
    paint(&mut job, BODY, 4).unwrap();
    assert!(env.commit(job, Target::New(folder_name(&project))).is_ok());
}

#[test]
fn begin_purges_stale_staging_first() {
    let env = Env::new("stale");
    let stale = partial_dir(&env.user_skins).join("i-old").join("leftover");
    fs::create_dir_all(&stale).unwrap();
    let project = env.project("Stale");
    let (id, _job) = env.begin(&project, &[BODY]);
    assert_eq!(names_in(&partial_dir(&env.user_skins)), [id]);
}

#[test]
fn a_second_apply_replaces_the_skin_and_keeps_its_id() {
    let env = Env::new("replace");
    let project = env.project("Replace");
    let (_, mut job) = env.begin(&project, &[BODY]);
    paint(&mut job, BODY, 4).unwrap();
    let first = env.commit(job, Target::New(folder_name(&project))).unwrap();

    let (_, mut job) = env.begin(&project, &[BODY, TURRET]);
    paint(&mut job, BODY, 8).unwrap();
    paint(&mut job, TURRET, 4).unwrap();
    let second = env.commit(job, Target::Replace(first.skin.id.clone())).unwrap();
    assert_eq!(
        (second.skin.id.as_str(), second.skin.folder.as_str()),
        (first.skin.id.as_str(), first.skin.folder.as_str())
    );
    assert!(second.backup_id.is_some());
    assert_eq!(env.store.all().len(), 1);
    let installed = env.user_skins.join(&second.skin.folder);
    assert_eq!(names_in(&installed).len(), 3);
    assert_eq!(parse_dds(&fs::read(installed.join("m4a3e2_sherman_jumbo_body.dds")).unwrap()).unwrap().width, 8);
}

#[test]
fn the_registry_hands_out_each_job_once_and_honours_a_cancel_during_work() {
    let env = Env::new("registry");
    let project = env.project("Registry");
    let applies = Applies::default();
    let unknown = |e: AppError| assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, APPLY_NOT_FOUND));
    unknown(err(applies.checkout("a-missing")));
    unknown(err(applies.remove("a-missing")));
    applies.cancel("a-missing");

    let (id, job) = env.begin(&project, &[BODY]);
    let root = job.root.clone();
    applies.insert(id.clone(), job).unwrap();
    let mut job = applies.checkout(&id).unwrap();
    // While a texture is being written, the job is busy.
    unknown(err(applies.checkout(&id)));
    unknown(err(applies.remove(&id)));
    paint(&mut job, BODY, 4).unwrap();
    job.checkin().unwrap();
    let job = applies.remove(&id).unwrap();
    unknown(err(applies.checkout(&id)));
    apply::cancel(job);

    // Cancel while busy: the texture call finds it cancelled when it returns, and the folder goes.
    let (id, job) = env.begin(&project, &[BODY]);
    let busy_root = job.root.clone();
    applies.insert(id.clone(), job).unwrap();
    let job = applies.checkout(&id).unwrap();
    applies.cancel(&id);
    assert!(busy_root.exists(), "the encode in progress still has it");
    unknown(err(job.checkin()));
    assert!(!busy_root.exists());
    unknown(err(applies.checkout(&id)));

    // Cancel while idle removes at once.
    let (id, job) = env.begin(&project, &[BODY]);
    let idle_root = job.root.clone();
    applies.insert(id.clone(), job).unwrap();
    applies.cancel(&id);
    assert!(!idle_root.exists());
    unknown(err(applies.remove(&id)));
    assert!(!root.exists());
}

/// Noise in every channel, so each block encodes differently.
fn noise(w: usize, h: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    (0..w * h * 4)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

#[test]
fn painted_textures_encode_in_strips_like_the_whole_image() {
    // Up to the ClusterFit limit: the same blocks as the one-thread encoder.
    let (w, h) = (64usize, 256usize);
    let rgba = noise(w, h);
    assert_eq!(encode_painted(&rgba, w as u32, h as u32).unwrap(), encode_dxt5(&rgba, w, h).unwrap());

    // Above it (RangeFit): every block in place, a flat colour comes back as it was.
    let (w, h) = (CLUSTER_FIT_MAX_SIDE as usize + 4, 8usize);
    let flat: Vec<u8> = [96, 160, 48, 255].repeat(w * h);
    let blocks = encode_painted(&flat, w as u32, h as u32).unwrap();
    assert_eq!(blocks.len(), w * h);
    let back = decode(b"DXT5", &blocks, w, h).unwrap();
    assert!(back.chunks(4).all(|p| p.iter().zip([96u8, 160, 48, 255]).all(|(a, b)| a.abs_diff(b) <= 4)));

    let e = encode_painted(&flat, 6, 8).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, APPLY_BAD_TEXTURE));
}

#[test]
fn a_project_has_one_apply_at_a_time() {
    let env = Env::new("one");
    let project = env.project("One");
    let other = env.project("Other");
    let applies = Applies::default();
    let (first, job) = env.begin(&project, &[BODY]);
    let first_root = job.root.clone();
    applies.insert(first.clone(), job).unwrap();
    let (_, job) = env.begin(&other, &[BODY]);
    let other_root = job.root.clone();
    applies.insert("a-other".into(), job).unwrap();

    // A second begin of the same project is refused and leaves no staging.
    let (second, job) = env.begin(&project, &[BODY]);
    let second_root = job.root.clone();
    let e = err(applies.insert(second.clone(), job));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Conflict, APPLY_FAILED));
    assert!(!second_root.exists());
    // Busy counts too.
    let busy = applies.checkout(&first).unwrap();
    let (_, job) = env.begin(&project, &[BODY]);
    assert!(applies.insert("a-busy".into(), job).is_err());
    busy.checkin().unwrap();

    // One left idle longer than STALE_APPLY (its editor went away) is replaced.
    let later = Instant::now() + STALE_APPLY + Duration::from_secs(1);
    let (third, job) = env.begin(&project, &[BODY]);
    applies.insert_at(third.clone(), job, later).unwrap();
    assert!(!first_root.exists());
    assert!(applies.remove(&first).is_err());
    assert!(applies.remove(&third).is_ok());
    assert!(other_root.exists(), "other projects' applies stay");
}

#[test]
fn a_job_dropped_while_checked_out_ends_the_apply() {
    let env = Env::new("unwind");
    let project = env.project("Unwind");
    let applies = Applies::default();
    let (id, job) = env.begin(&project, &[BODY]);
    let root = job.root.clone();
    applies.insert(id.clone(), job).unwrap();
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _job = applies.checkout(&id).unwrap();
        panic!("the encoder failed");
    }));
    assert!(unwound.is_err());
    assert!(!root.exists(), "the staging went");
    assert_eq!(err(applies.checkout(&id)).message, APPLY_NOT_FOUND);
    // The project can be applied again at once.
    let (again, job) = env.begin(&project, &[BODY]);
    applies.insert(again, job).unwrap();
}

#[test]
fn the_job_remembers_the_installed_skin_and_the_last_pct() {
    let env = Env::new("remember");
    let project = env.project("Remember");
    let project = env.projects.set_installed_skin(&project.id, "s-1", SystemTime::now()).unwrap();
    let (_, mut job) = env.begin(&project, &[BODY, TURRET]);
    assert_eq!(job.installed_skin_id.as_deref(), Some("s-1"));
    assert_eq!(job.last_pct, 0);
    paint(&mut job, TURRET, 4).unwrap();
    assert_eq!(job.last_pct, 67);
    apply::cancel(job);
}

#[test]
fn painted_textures_carry_their_mipmaps() {
    // A 16×8 texture: 16×8, 8×4, 4×2 (the first level with both sides at most 4).
    let (w, h) = (16usize, 8usize);
    let left_white: Vec<u8> =
        (0..w * h).flat_map(|i| if i % w < w / 2 { [255u8; 4] } else { [0, 0, 0, 255] }).collect();
    let levels = apply::encode_mips(&left_white, w as u32, h as u32).unwrap();
    assert_eq!(levels.iter().map(Vec::len).collect::<Vec<_>>(), [8 * 16, 2 * 16, 16]);
    assert_eq!(levels[0], encode_dxt5(&left_white, w, h).unwrap(), "level 0 as before");
    // Each level is the box-filtered one before: still white on the left, black on the right.
    let mip = decode(b"DXT5", &levels[1], 8, 4).unwrap();
    assert_eq!(&mip[..4], &[255, 255, 255, 255]);
    assert_eq!(&mip[4 * 7..4 * 8], &[0, 0, 0, 255]);

    let env = Env::new("mips");
    let project = env.project("Mips");
    let (_, mut job) = env.begin(&project, &[BODY]);
    let side = 64u32;
    apply::texture(&mut job, BODY, side, side, &image(side, [90, 90, 90, 255]), &mut |_, _| {}).unwrap();
    let file = fs::read(job.dir.join("m4a3e2_sherman_jumbo_body.dds")).unwrap();
    // 64, 32, 16, 8, 4.
    let blocks: usize = [16 * 16, 8 * 8, 4 * 4, 2 * 2, 1].iter().sum();
    assert_eq!(file.len(), 128 + 16 * blocks);
    let header = parse_dds(&file).unwrap();
    assert_eq!((header.width, header.height, header.format.as_str()), (64, 64, "BC3"));
    apply::cancel(job);
}

#[test]
fn the_projects_picture_becomes_the_skins_preview() {
    let env = Env::new("preview");
    let project = env.project("Preview");
    let png = [&[0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..], &[1, 2, 3]].concat();
    let (_, mut job) = env.begin(&project, &[BODY]);
    paint(&mut job, BODY, 4).unwrap();
    let with = env.commit_with(job, Some(&png), Target::New(folder_name(&project))).unwrap();
    let dir = env.user_skins.join(&with.skin.folder);
    assert_eq!(fs::read(dir.join(apply::PREVIEW_FILE)).unwrap(), png);
    assert!(with.skin.attention.is_empty(), "{:?}", with.skin.attention);

    let other = env.project("No picture");
    let (_, mut job) = env.begin(&other, &[BODY]);
    paint(&mut job, BODY, 4).unwrap();
    let without = env.commit(job, Target::New(folder_name(&other))).unwrap();
    assert!(!env.user_skins.join(&without.skin.folder).join(apply::PREVIEW_FILE).exists());

    // Not a PNG: left out, the apply still goes through.
    let third = env.project("Bad picture");
    let (_, mut job) = env.begin(&third, &[BODY]);
    paint(&mut job, BODY, 4).unwrap();
    let bad = env.commit_with(job, Some(b"GIF89a"), Target::New(folder_name(&third))).unwrap();
    assert!(!env.user_skins.join(&bad.skin.folder).join(apply::PREVIEW_FILE).exists());
}
