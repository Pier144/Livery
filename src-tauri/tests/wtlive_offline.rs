//! WT Live that can't be reached: the disabled client and the Settings switch answer
//! `unsupported` and read as offline, nothing panics, nothing is sent; `finalize_try` is local
//! and says nothing about the network; the client seam hands the client what it needs; and
//! `read_textures` takes exactly one of its three ids.

use livery_lib::error::{AppError, AppResult, ErrorCode};
use livery_lib::library::index::LibraryStore;
use livery_lib::library::time::parse_rfc3339;
use livery_lib::model::{
    Author, Category, FollowEntry, FollowKind, ForYouNew, Nation, SearchParams, SearchResult, Vehicle, VehicleType,
    WtLiveSkin,
};
use livery_lib::textures::{texture_target, TextureTarget, ONE_TEXTURE_TARGET};
use livery_lib::wtlive::{
    following_new, for_you_new, is_offline_error, keep_or_discard, net_status_after, net_status_of, post,
    post_textures, turned_off, unsupported, DisabledClient, DownloadProgress, ForYouStore, NetStatus, WtLive,
    WtLiveCall, WtLiveClient, FOLLOWING_FILE, FOR_YOU_FILE, MISSING_SKIN_ID, NET_STATUS_EVENT, TURNED_OFF_MESSAGE,
    UNSUPPORTED_MESSAGE,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn params() -> SearchParams {
    serde_json::from_value(serde_json::json!({ "q": "tiger", "nation": "GER", "sort": "downloads", "page": 0 }))
        .unwrap()
}

fn assert_unsupported<T: std::fmt::Debug>(result: AppResult<T>, message: &str) -> AppError {
    let e = result.expect_err("unsupported");
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert_eq!(e.message, message);
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

fn temp_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("livery-wtlive-{name}-{}-{nanos}", std::process::id()))
}

#[test]
fn the_messages_are_user_safe() {
    let json = serde_json::to_value(unsupported()).unwrap();
    assert_eq!(json, serde_json::json!({ "code": "unsupported", "message": UNSUPPORTED_MESSAGE }));
    let json = serde_json::to_value(turned_off()).unwrap();
    assert_eq!(json, serde_json::json!({ "code": "unsupported", "message": TURNED_OFF_MESSAGE }));
    assert_eq!(TURNED_OFF_MESSAGE, "WT Live browsing is turned off in Settings");
}

#[test]
fn disabled_client_refuses_everything() {
    let client = DisabledClient;
    let e = assert_unsupported(client.ready(), UNSUPPORTED_MESSAGE);
    assert!(e.detail.as_deref().is_some_and(|d| d.contains("never reaches WT Live")), "{e:?}");
    assert_unsupported(client.search(&params()), UNSUPPORTED_MESSAGE);
    assert_unsupported(client.post("1"), UNSUPPORTED_MESSAGE);
    assert_unsupported(client.following_new(&[]), UNSUPPORTED_MESSAGE);
    let mut ticks = 0;
    assert_unsupported(client.archive("1", &mut |_: DownloadProgress| ticks += 1), UNSUPPORTED_MESSAGE);
    assert_eq!(ticks, 0, "nothing was downloaded");
}

#[test]
fn disabled_client_refuses_for_you() {
    let client = DisabledClient;
    let e = assert_unsupported(client.vehicle_top("ussr_t_34_85"), UNSUPPORTED_MESSAGE);
    assert!(e.detail.as_deref().is_some_and(|d| d.starts_with("vehicle_top")), "{e:?}");
    let e = assert_unsupported(client.for_you_new(&["ussr_t_34_85".into()], 0), UNSUPPORTED_MESSAGE);
    assert!(e.detail.as_deref().is_some_and(|d| d.starts_with("for_you_new")), "{e:?}");
    // Even an empty list: the UI stays offline.
    assert_unsupported(client.for_you_new(&[], 0), UNSUPPORTED_MESSAGE);
}

#[test]
fn offline_errors_are_network_and_unsupported_only() {
    assert!(is_offline_error(&AppError::new(ErrorCode::Network, "down")));
    assert!(is_offline_error(&unsupported()));
    assert!(is_offline_error(&turned_off()));
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
fn every_wtlive_call_of_the_disabled_client_is_unsupported_and_offline() {
    let client = DisabledClient;
    let followed = [follow(FollowKind::Author, "a1", "2026-09-01T00:00:00Z")];
    let for_you = ForYouStore::load(temp_dir("disabled-for-you").join(FOR_YOU_FILE));
    let outcomes = [
        client.search(&params()).map(|_| ()).unwrap_err(),
        post(&client, "1").map(|_| ()).unwrap_err(),
        following_new(&client, &followed, &[], &["a1".into()]).map(|_| ()).unwrap_err(),
        post_textures(&client, "1").map(|_| ()).unwrap_err(),
        client.vehicle_top("ussr_t_34_85").map(|_| ()).unwrap_err(),
        for_you_new(&client, &for_you, &["ussr_t_34_85".into()]).map(|_| ()).unwrap_err(),
    ];
    for e in outcomes {
        assert_eq!(e.code, ErrorCode::Unsupported, "{e:?}");
        assert_eq!(e.message, UNSUPPORTED_MESSAGE, "{e:?}");
        assert_eq!(net_status_of(&Err::<(), _>(e)), Some(NetStatus { online: false }));
    }
}

#[test]
fn finalize_try_is_local_and_never_reports_the_network() {
    let dir = temp_dir("finalize");
    std::fs::create_dir_all(&dir).unwrap();
    let store = LibraryStore::load(dir.join("library.json"));
    for keep in [true, false] {
        let e = keep_or_discard(&dir, &store, "1", keep, true).map(|_| ()).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound, "nothing is being tried");
        let result = Err::<(), _>(e);
        assert_eq!(net_status_after(WtLiveCall::FinalizeTry, &result), None);
    }
    assert_eq!(net_status_after(WtLiveCall::FinalizeTry, &Ok(())), None, "nor online");
    assert!(!WtLiveCall::FinalizeTry.reaches_wtlive());
    assert_eq!(
        net_status_after(WtLiveCall::FinalizeTry, &Err::<(), _>(unsupported())),
        None,
        "unsupported, yet not offline"
    );
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn every_other_wtlive_call_reports_its_outcome() {
    let calls = [
        WtLiveCall::Search,
        WtLiveCall::Post,
        WtLiveCall::FollowingNew,
        WtLiveCall::VehicleTop,
        WtLiveCall::ForYouNew,
        WtLiveCall::Install,
        WtLiveCall::Textures,
    ];
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
    let dir = temp_dir("blank");
    let store = LibraryStore::detached();
    assert_blank_id(post(&client, "  "));
    assert_blank_id(keep_or_discard(&dir, &store, " ", true, true));
    assert_blank_id(post_textures(&client, ""));
}

// ── The seam: what a client gets ────────────────────────────────────────────

/// A client that is "online": records what it's asked and answers empty results.
#[derive(Default)]
struct Recorder {
    posts: Mutex<Vec<String>>,
    follows: Mutex<Vec<Vec<FollowEntry>>>,
    tops: Mutex<Vec<String>>,
    for_you: Mutex<Vec<(Vec<String>, i64)>>,
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
        description: None,
    }
}

impl WtLiveClient for Recorder {
    fn ready(&self) -> AppResult<()> {
        Ok(())
    }
    fn search(&self, _params: &SearchParams) -> AppResult<SearchResult> {
        Ok(SearchResult { items: vec![], total: 0, took_ms: 1, has_more: false, total_exact: true })
    }
    fn post(&self, id: &str) -> AppResult<WtLiveSkin> {
        self.posts.lock().unwrap().push(id.to_owned());
        Ok(skin(id))
    }
    fn following_new(&self, follows: &[FollowEntry]) -> AppResult<Vec<WtLiveSkin>> {
        self.follows.lock().unwrap().push(follows.to_vec());
        Ok(vec![])
    }
    fn vehicle_top(&self, code: &str) -> AppResult<Vec<WtLiveSkin>> {
        self.tops.lock().unwrap().push(code.to_owned());
        Ok(vec![])
    }
    fn for_you_new(&self, vehicles: &[String], since: i64) -> AppResult<ForYouNew> {
        self.for_you.lock().unwrap().push((vehicles.to_vec(), since));
        Ok(ForYouNew { items: vec![], checked: vehicles.len() as u32 })
    }
    fn archive(&self, _id: &str, _progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf> {
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
fn for_you_new_hands_the_client_the_trimmed_codes_and_the_last_seen_time() {
    let dir = temp_dir("for-you-seam");
    let store = ForYouStore::load(dir.join(FOR_YOU_FILE));
    store.mark_seen_at("2026-09-01T10:00:00Z").unwrap();
    let client = Recorder::default();
    let asked: Vec<String> = [" ussr_t_34_85 ", "", "  ", "us_m18_hellcat"].iter().map(|v| (*v).to_owned()).collect();
    let new = for_you_new(&client, &store, &asked).unwrap();
    assert_eq!(new.checked, 4, "blanks stay in place");
    let since = parse_rfc3339("2026-09-01T10:00:00Z").unwrap();
    let expected: Vec<String> = ["ussr_t_34_85", "", "", "us_m18_hellcat"].iter().map(|v| (*v).to_owned()).collect();
    assert_eq!(*client.for_you.lock().unwrap(), vec![(expected, since)]);

    // Never marked seen: new since a week before the store was loaded.
    let fresh = ForYouStore::load(dir.join("other").join(FOR_YOU_FILE));
    let client = Recorder::default();
    for_you_new(&client, &fresh, &["ussr_t_34_85".into()]).unwrap();
    let since = client.for_you.lock().unwrap()[0].1;
    assert_eq!(Some(since), parse_rfc3339(&fresh.last_seen_at()));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_download_failure_reaches_textures_as_network() {
    let e = post_textures(&Recorder::default(), "1").unwrap_err();
    assert_eq!(e.code, ErrorCode::Network);
}

#[test]
fn managed_state_with_browsing_off_sends_nothing_and_writes_nothing() {
    let dir = temp_dir("state");
    let state = WtLive::load(&dir, Arc::new(|| false));
    let client = state.client();
    assert_unsupported(client.ready(), TURNED_OFF_MESSAGE);
    assert_unsupported(client.search(&params()), TURNED_OFF_MESSAGE);
    assert_unsupported(client.post("1"), TURNED_OFF_MESSAGE);
    assert_unsupported(client.following_new(&[]), TURNED_OFF_MESSAGE);
    assert_unsupported(client.vehicle_top("ussr_t_34_85"), TURNED_OFF_MESSAGE);
    assert_unsupported(for_you_new(client.as_ref(), state.for_you(), &[]), TURNED_OFF_MESSAGE);
    assert_unsupported(client.archive("1", &mut |_| {}), TURNED_OFF_MESSAGE);
    assert_eq!(state.following().path(), dir.join(FOLLOWING_FILE));
    assert_eq!(state.for_you().path(), dir.join(FOR_YOU_FILE));
    assert!(!state.for_you().is_read_only());
    assert!(state.following().list().is_empty());
    assert_eq!(state.storage().cache_bytes, 0);
    assert_eq!(state.storage().hidden_count, 0);
    assert!(!dir.exists(), "loading writes nothing");

    let custom = WtLive::with_client(Arc::new(Recorder::default()), dir.join("f.json"));
    assert!(custom.client().ready().is_ok(), "another client plugs in without touching the commands");
    assert_eq!(custom.for_you().path(), dir.join(FOR_YOU_FILE), "next to the Following list");
    assert!(!dir.exists(), "still nothing written");
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
