//! WT Live without an HTTP client: every network call is `unsupported` and reads as offline
//! (`finalize_try`, local, is `unsupported` too but says nothing about the network), nothing
//! panics, the client seam hands the real client what it needs, and `read_textures` takes
//! exactly one of its three ids.

use livery_lib::archive::UNSUPPORTED_ARCHIVES;
use livery_lib::error::{AppError, AppResult, ErrorCode};
use livery_lib::model::{
    Author, Category, ConflictPolicy, FollowEntry, FollowKind, InstallMode, Nation, SearchParams, SearchResult,
    Vehicle, VehicleType, WtLiveSkin,
};
use livery_lib::textures::{texture_target, TextureTarget, ONE_TEXTURE_TARGET};
use livery_lib::wtlive::{
    following_new, is_offline_error, keep_or_discard, net_status_after, net_status_of, post, post_textures,
    start_install, unsupported, DisabledClient, DownloadProgress, NetStatus, WtLive, WtLiveCall, WtLiveClient,
    FOLLOWING_FILE, MISSING_SKIN_ID, NET_STATUS_EVENT, UNSUPPORTED_MESSAGE,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn params() -> SearchParams {
    serde_json::from_value(serde_json::json!({ "q": "tiger", "nation": "GER", "sort": "downloads", "page": 0 }))
        .unwrap()
}

fn assert_unsupported<T: std::fmt::Debug>(result: AppResult<T>) -> AppError {
    let e = result.expect_err("unsupported");
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert_eq!(e.message, UNSUPPORTED_MESSAGE);
    assert!(is_offline_error(&e));
    e
}

fn assert_blank_id<T: std::fmt::Debug>(result: AppResult<T>) {
    let e = result.expect_err("invalid input");
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert_eq!(e.message, MISSING_SKIN_ID);
    assert_eq!(net_status_of(&Err::<(), _>(e)), None, "a bad argument says nothing about WT Live");
}

fn follow(kind: FollowKind, id: &str, seen: &str) -> FollowEntry {
    FollowEntry { kind, id: id.into(), name: format!("name of {id}"), last_seen_at: seen.into() }
}

#[test]
fn the_message_is_user_safe() {
    assert_eq!(
        UNSUPPORTED_MESSAGE,
        "WT Live can't be reached from this build yet: it needs a network library the author hasn't approved."
    );
    let json = serde_json::to_value(unsupported()).unwrap();
    assert_eq!(json, serde_json::json!({ "code": "unsupported", "message": UNSUPPORTED_MESSAGE }));
}

#[test]
fn disabled_client_refuses_everything() {
    let client = DisabledClient;
    let e = assert_unsupported(client.ready());
    assert!(e.detail.as_deref().is_some_and(|d| d.contains("no HTTP client")), "{e:?}");
    assert_unsupported(client.search(&params()));
    assert_unsupported(client.post("s1"));
    assert_unsupported(client.following_new(&[]));
    let mut ticks = 0;
    let dest = std::env::temp_dir().join("livery-wtlive-never-created");
    assert_unsupported(client.download("s1", &dest, &mut |_: DownloadProgress| ticks += 1));
    assert_eq!(ticks, 0, "nothing was downloaded");
    assert!(!dest.exists(), "nothing was written");
}

#[test]
fn offline_errors_are_network_and_unsupported_only() {
    assert!(is_offline_error(&AppError::new(ErrorCode::Network, "down")));
    assert!(is_offline_error(&unsupported()));
    for code in [ErrorCode::NotFound, ErrorCode::InvalidInput, ErrorCode::Parse, ErrorCode::Io, ErrorCode::Internal] {
        assert!(!is_offline_error(&AppError::new(code, "x")), "{code:?}");
    }
}

#[test]
fn net_status_follows_the_outcome() {
    assert_eq!(net_status_of(&Ok::<_, AppError>(1)), Some(NetStatus { online: true }));
    assert_eq!(net_status_of(&Err::<(), _>(unsupported())), Some(NetStatus { online: false }));
    assert_eq!(
        net_status_of(&Err::<(), _>(AppError::new(ErrorCode::Network, "timeout"))),
        Some(NetStatus { online: false })
    );
    assert_eq!(net_status_of(&Err::<(), _>(AppError::new(ErrorCode::NotFound, "no such post"))), None);
    assert_eq!(NET_STATUS_EVENT, "net://status");
    assert_eq!(serde_json::to_value(NetStatus { online: false }).unwrap(), serde_json::json!({ "online": false }));
}

#[test]
fn every_wtlive_command_core_is_unsupported_and_offline() {
    let client = DisabledClient;
    let followed = [follow(FollowKind::Author, "a1", "2026-09-01T00:00:00Z")];
    let outcomes = [
        client.search(&params()).map(|_| ()).unwrap_err(),
        post(&client, "s1").map(|_| ()).unwrap_err(),
        following_new(&client, &followed, &[], &["a1".into()]).map(|_| ()).unwrap_err(),
        start_install(&client, "s1", InstallMode::Normal, None).map(|_| ()).unwrap_err(),
        start_install(&client, "s1", InstallMode::Temporary, Some(ConflictPolicy::Copy)).map(|_| ()).unwrap_err(),
        post_textures(&client, "s1").map(|_| ()).unwrap_err(),
    ];
    for e in outcomes {
        assert_eq!(e.code, ErrorCode::Unsupported, "{e:?}");
        assert_eq!(e.message, UNSUPPORTED_MESSAGE, "{e:?}");
        assert_eq!(net_status_of(&Err::<(), _>(e)), Some(NetStatus { online: false }));
    }
}

#[test]
fn finalize_try_is_local_and_never_reports_the_network() {
    for keep in [true, false] {
        let e = keep_or_discard("s1", keep).map(|_| ()).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, UNSUPPORTED_MESSAGE));
        let result = Err::<(), _>(e);
        assert_eq!(net_status_after(WtLiveCall::FinalizeTry, &result), None, "unsupported, yet not offline");
    }
    assert_eq!(net_status_after(WtLiveCall::FinalizeTry, &Ok(())), None, "nor online");
    assert!(!WtLiveCall::FinalizeTry.reaches_wtlive());
}

#[test]
fn every_other_wtlive_call_reports_its_outcome() {
    let calls =
        [WtLiveCall::Search, WtLiveCall::Post, WtLiveCall::FollowingNew, WtLiveCall::Install, WtLiveCall::Textures];
    for call in calls {
        assert!(call.reaches_wtlive(), "{call:?}");
        assert_eq!(net_status_after(call, &Err::<(), _>(unsupported())), Some(NetStatus { online: false }), "{call:?}");
        assert_eq!(net_status_after(call, &Ok(())), Some(NetStatus { online: true }), "{call:?}");
        let blank = Err::<(), _>(AppError::new(ErrorCode::InvalidInput, MISSING_SKIN_ID));
        assert_eq!(net_status_after(call, &blank), None, "{call:?}");
    }
}

#[test]
fn blank_ids_are_invalid_input_before_any_call() {
    let client = DisabledClient;
    assert_blank_id(post(&client, "  "));
    assert_blank_id(start_install(&client, "", InstallMode::Normal, None));
    assert_blank_id(keep_or_discard(" ", true));
    assert_blank_id(post_textures(&client, ""));
}

// ── The seam: what a real client gets ───────────────────────────────────────

/// A client that is "online": records what it's asked and answers empty results.
#[derive(Default)]
struct Recorder {
    posts: Mutex<Vec<String>>,
    follows: Mutex<Vec<Vec<FollowEntry>>>,
}

fn skin(id: &str) -> WtLiveSkin {
    WtLiveSkin {
        id: id.into(),
        name: "Winter Tiger".into(),
        vehicle: Vehicle {
            code: "germ_pzkpfw_VI_ausf_e_tiger".into(),
            name: "Tiger H1".into(),
            nation: Nation::Ger,
            vehicle_type: VehicleType::Ground,
            class: "Heavy tank".into(),
            rank: Some(4),
        },
        author: Author { id: "a1".into(), name: "Ostwind".into(), url: String::new(), skin_count: None },
        category: Category::Historical,
        downloads: 1,
        likes: 1,
        posted_at: "2026-09-10T00:00:00Z".into(),
        size_bytes: 1,
        images: vec![],
        post_url: String::new(),
        download_url: String::new(),
        files: None,
        is_new: None,
    }
}

impl WtLiveClient for Recorder {
    fn ready(&self) -> AppResult<()> {
        Ok(())
    }
    fn search(&self, _params: &SearchParams) -> AppResult<SearchResult> {
        Ok(SearchResult { items: vec![], total: 0, took_ms: 1 })
    }
    fn post(&self, id: &str) -> AppResult<WtLiveSkin> {
        self.posts.lock().unwrap().push(id.to_owned());
        Ok(skin(id))
    }
    fn following_new(&self, follows: &[FollowEntry]) -> AppResult<Vec<WtLiveSkin>> {
        self.follows.lock().unwrap().push(follows.to_vec());
        Ok(vec![])
    }
    fn download(&self, _id: &str, _dest: &Path, _progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf> {
        Err(AppError::new(ErrorCode::Network, "not in this test"))
    }
}

#[test]
fn post_passes_the_trimmed_id() {
    let client = Recorder::default();
    let result = post(&client, " s7 ");
    assert_eq!(result.as_ref().map(|s| s.id.as_str()), Ok("s7"));
    assert_eq!(net_status_of(&result), Some(NetStatus { online: true }));
    assert_eq!(*client.posts.lock().unwrap(), vec!["s7".to_owned()]);
}

#[test]
fn following_new_hands_the_client_each_followed_entry_with_its_last_seen() {
    let client = Recorder::default();
    let followed = [
        follow(FollowKind::Vehicle, "germ_pzkpfw_VI_ausf_e_tiger", "2026-09-01T00:00:00Z"),
        follow(FollowKind::Vehicle, "ussr_t_34_85", "2026-09-02T00:00:00Z"),
        follow(FollowKind::Author, "a1", "2026-09-03T00:00:00Z"),
    ];
    following_new(
        &client,
        &followed,
        &["germ_pzkpfw_VI_ausf_e_tiger".into(), "not_followed".into()],
        &["a1".into(), "a2".into()],
    )
    .unwrap();
    assert_eq!(*client.follows.lock().unwrap(), vec![vec![followed[0].clone(), followed[2].clone()]]);
}

#[test]
fn a_ready_client_still_waits_for_the_archive_crates_to_install() {
    let client = Recorder::default();
    for e in [
        start_install(&client, "s1", InstallMode::Temporary, None).map(|_| ()).unwrap_err(),
        post_textures(&client, "s1").map(|_| ()).unwrap_err(),
    ] {
        assert_eq!(e.code, ErrorCode::Unsupported);
        assert_eq!(e.message, UNSUPPORTED_ARCHIVES);
    }
}

#[test]
fn managed_state_uses_the_disabled_client_and_following_json() {
    let dir = std::env::temp_dir().join(format!("livery-wtlive-state-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let state = WtLive::load(&dir);
    assert_unsupported(state.client().search(&params()));
    assert_eq!(state.following().path(), dir.join(FOLLOWING_FILE));
    assert!(state.following().list().is_empty());
    assert!(!dir.exists(), "loading writes nothing");

    let custom = WtLive::with_client(Arc::new(Recorder::default()), dir.join("f.json"));
    assert!(custom.client().ready().is_ok(), "the real client plugs in without touching the commands");
}

// ── read_textures ───────────────────────────────────────────────────────────

#[test]
fn read_textures_takes_exactly_one_id() {
    let s = || Some("x".to_owned());
    assert_eq!(texture_target(s(), None, None), Ok(TextureTarget::Skin("x".into())));
    assert_eq!(texture_target(None, s(), None), Ok(TextureTarget::Queue("x".into())));
    assert_eq!(texture_target(None, None, s()), Ok(TextureTarget::WtLive("x".into())));
    for (skin, queue, wtlive) in
        [(None, None, None), (s(), s(), None), (s(), None, s()), (None, s(), s()), (s(), s(), s())]
    {
        let e = texture_target(skin, queue, wtlive).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert_eq!(e.message, ONE_TEXTURE_TARGET);
    }
}
