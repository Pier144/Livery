//! The real WT Live client over a fake transport: how searches map onto WT Live's feed, paging,
//! the filters Livery applies itself, the cache, hidden posts, authors, Following, posts and
//! downloads.

use livery_lib::error::{AppError, AppResult, ErrorCode};
use livery_lib::model::{Category, FollowEntry, FollowKind, Nation, SearchParams, VehicleType};
use livery_lib::wtlive::cache::DiskCache;
use livery_lib::wtlive::hidden::HiddenStore;
use livery_lib::wtlive::live::{
    Feed, LiveClient, FEED_PATH, MAX_DRY_PAGES, MAX_SEARCH_FEED_PAGES, PAGES_IN_ORDER, POST_GONE, POST_NOT_AN_ARCHIVE,
    POST_PATH, USERS_PATH, USER_FEED_PATH,
};
use livery_lib::wtlive::net::Transport;
use livery_lib::wtlive::{DownloadProgress, WtLiveClient, TURNED_OFF_MESSAGE};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// ── A fake WT Live ──────────────────────────────────────────────────────────

/// One fake post: id, author (id, nick), hashtags, created (unix secs).
#[derive(Clone)]
struct FakePost {
    id: u64,
    author: (u64, &'static str),
    tags: Vec<&'static str>,
    created: i64,
    name: String,
}

fn fake(id: u64, author: (u64, &'static str), tags: &[&'static str], created: i64) -> FakePost {
    FakePost { id, author, tags: tags.to_vec(), created, name: format!("Skin {id}") }
}

fn post_json(p: &FakePost) -> serde_json::Value {
    let tags: String = p
        .tags
        .iter()
        .map(|t| format!(r#"<a href="//live.warthunder.com/?q=%23{t}" class="WTL-Embed-Hashtag">#{t}</a> "#))
        .collect();
    serde_json::json!({
        "lang_group": p.id, "id": p.id + 1, "language": "en", "type": "camouflage", "created": p.created,
        "author": { "id": p.author.0, "nickname": p.author.1, "avatar": "" },
        "likes": 3, "downloads": 10,
        "description": format!("<p><b>{}</b></p><p>{tags}</p>", p.name),
        "images": [{ "id": 1, "src": format!("https://cdn-live.warthunder.com/uploads/{}_lq/a.jpg", p.id) }],
        "file": { "id": 9, "name": "skin.zip", "link": format!("https://live.warthunder.com/dl/{:040x}/", p.id), "type": "application/zip", "size": 22 }
    })
}

fn feed_json(posts: &[FakePost]) -> Vec<u8> {
    let list: Vec<serde_json::Value> = posts.iter().map(post_json).collect();
    serde_json::to_vec(&serde_json::json!({ "status": "OK", "data": { "list": list } })).unwrap()
}

type Responder = dyn Fn(&str, &HashMap<String, String>) -> AppResult<Vec<u8>> + Send + Sync;

/// Answers requests with `respond` and logs them as `path?k=v&…` (keys sorted).
struct FakeTransport {
    respond: Box<Responder>,
    log: Mutex<Vec<String>>,
    archive: Mutex<AppResult<Vec<u8>>>,
    downloads: Mutex<Vec<String>>,
}

impl FakeTransport {
    fn new(
        respond: impl Fn(&str, &HashMap<String, String>) -> AppResult<Vec<u8>> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            respond: Box::new(respond),
            log: Mutex::new(Vec::new()),
            archive: Mutex::new(Ok(zip_bytes())),
            downloads: Mutex::new(Vec::new()),
        })
    }

    fn requests(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn handle(&self, path: &str, pairs: &[(&str, String)]) -> AppResult<Vec<u8>> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect();
        let mut keys: Vec<&(&str, String)> = pairs.iter().collect();
        keys.sort_by_key(|(k, _)| *k);
        let query: Vec<String> = keys.iter().map(|(k, v)| format!("{k}={v}")).collect();
        self.log.lock().unwrap().push(format!("{path}?{}", query.join("&")));
        (self.respond)(path, &map)
    }
}

impl Transport for FakeTransport {
    fn post_form(&self, path: &str, form: &[(&str, String)]) -> AppResult<Vec<u8>> {
        self.handle(path, form)
    }
    fn get(&self, path: &str, query: &[(&str, String)]) -> AppResult<Vec<u8>> {
        self.handle(path, query)
    }
    fn download(
        &self,
        url: &str,
        _max: u64,
        out: &mut dyn Write,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> AppResult<u64> {
        self.downloads.lock().unwrap().push(url.to_owned());
        let bytes = self.archive.lock().unwrap().clone()?;
        out.write_all(&bytes[..bytes.len() / 2]).unwrap();
        progress((bytes.len() / 2) as u64, Some(bytes.len() as u64));
        out.write_all(&bytes[bytes.len() / 2..]).unwrap();
        progress(bytes.len() as u64, Some(bytes.len() as u64));
        Ok(bytes.len() as u64)
    }
}

fn zip_bytes() -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buffer);
    // A fixed date: the same bytes every time the test asks.
    let options = zip::write::SimpleFileOptions::default().last_modified_time(zip::DateTime::default());
    zip.start_file("Skin/su_27.blk", options).unwrap();
    zip.write_all(b"x{}").unwrap();
    zip.finish().unwrap();
    buffer.into_inner()
}

/// A temp folder for one test, removed on drop.
struct Env {
    dir: PathBuf,
    transport: Arc<FakeTransport>,
    enabled: Arc<AtomicBool>,
    hidden: Arc<HiddenStore>,
    cache: Arc<DiskCache>,
    client: LiveClient,
}

impl Env {
    fn new(name: &str, transport: Arc<FakeTransport>) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("livery-wtlive-live-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let enabled = Arc::new(AtomicBool::new(true));
        let hidden = Arc::new(HiddenStore::load(dir.join("hidden.json")));
        let cache = Arc::new(DiskCache::new(dir.join("cache")));
        let flag = Arc::clone(&enabled);
        let client = LiveClient::new(
            transport.clone(),
            Arc::clone(&cache),
            Arc::clone(&hidden),
            Arc::new(move || flag.load(Ordering::SeqCst)),
        );
        Self { dir, transport, enabled, hidden, cache, client }
    }

    /// Another client on the same cache and hidden list (a new session).
    fn second_client(&self) -> LiveClient {
        let flag = Arc::clone(&self.enabled);
        LiveClient::new(
            self.transport.clone(),
            Arc::clone(&self.cache),
            Arc::clone(&self.hidden),
            Arc::new(move || flag.load(Ordering::SeqCst)),
        )
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn params(json: serde_json::Value) -> SearchParams {
    let mut base = serde_json::json!({ "sort": "newest", "page": 0 });
    base.as_object_mut().unwrap().extend(json.as_object().unwrap().clone());
    serde_json::from_value(base).unwrap()
}

/// A catalogue of `pages` full pages of 25 posts (ids from 1000, newest first), then the end.
fn catalogue(pages: u32, tags: impl Fn(u64) -> Vec<&'static str> + Send + Sync + 'static) -> Arc<FakeTransport> {
    FakeTransport::new(move |path, form| {
        assert!(path == FEED_PATH || path == USER_FEED_PATH, "{path}");
        let page: u32 = form["page"].parse().unwrap();
        if page >= pages {
            return Ok(feed_json(&[]));
        }
        let posts: Vec<FakePost> = (0..25u64)
            .map(|i| {
                let id = 1000 + u64::from(page) * 25 + i;
                FakePost { tags: tags(id), ..fake(id, (7, "Seven"), &[], 2_000_000_000 - id as i64) }
            })
            .collect();
        Ok(feed_json(&posts))
    })
}

// ── Explore ─────────────────────────────────────────────────────────────────

#[test]
fn searches_map_onto_wt_live_sort_and_hashtags() {
    let env = Env::new("map", catalogue(1, |_| vec![]));
    env.client.search(&params(serde_json::json!({ "sort": "likes", "q": "Tiger II" }))).unwrap();
    env.client.search(&params(serde_json::json!({ "sort": "downloads", "vehicle": "ussr_t_34_85" }))).unwrap();
    env.client.search(&params(serde_json::json!({}))).unwrap();
    let log = env.transport.requests();
    assert_eq!(
        log[0],
        format!(
            "{FEED_PATH}?content=camouflage&featured=0&page=0&searchString=#tiger_ii #tigerii&sort=rating&subtype=all"
        )
    );
    assert!(log[1].contains("searchString=#ussr_t_34_85 #t_34_85 #t3485"), "{}", log[1]);
    assert!(log[1].contains("sort=downloads"));
    assert!(log
        .iter()
        .any(|l| l == &format!("{FEED_PATH}?content=camouflage&featured=0&page=0&sort=created&subtype=all")));
}

#[test]
fn pages_follow_wt_live_until_the_end() {
    let env = Env::new("paging", catalogue(3, |_| vec![]));
    let p = |page: u32| params(serde_json::json!({ "page": page }));
    let first = env.client.search(&p(0)).unwrap();
    assert_eq!(first.items.len(), 25);
    assert_eq!(first.items[0].id, "1000");
    assert_eq!((first.total, first.has_more, first.total_exact), (25, true, false));
    let second = env.client.search(&p(1)).unwrap();
    assert_eq!(second.items[0].id, "1025");
    assert_eq!(second.total, 50);
    let third = env.client.search(&p(2)).unwrap();
    assert_eq!((third.total, third.has_more), (75, true));
    let end = env.client.search(&p(3)).unwrap();
    assert!(end.items.is_empty());
    assert_eq!((end.total, end.has_more, end.total_exact), (75, false, true));
    let beyond = env.client.search(&p(9)).unwrap();
    assert!(beyond.items.is_empty());
    assert!(!beyond.has_more);
    // Every feed page was asked once: the rest came from the cache.
    assert_eq!(env.transport.requests().len(), 4);
}

#[test]
fn pages_are_asked_in_order() {
    let env = Env::new("deep", catalogue(5, |_| vec![]));
    let e = env.client.search(&params(serde_json::json!({ "page": 2 }))).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, PAGES_IN_ORDER));
    assert!(env.transport.requests().is_empty(), "nothing is fetched for it");
    for page in 0..3 {
        env.client.search(&params(serde_json::json!({ "page": page }))).unwrap();
    }
    let again = env.client.search(&params(serde_json::json!({ "page": 1 }))).unwrap();
    assert_eq!(again.items[0].id, "1025", "an earlier page can be asked again");
    assert_eq!(env.client.search(&params(serde_json::json!({ "page": 2 }))).unwrap().total, 75);
}

#[test]
fn a_search_reads_at_most_its_page_budget() {
    let env = Env::new("budget", catalogue(1_000, |_| vec![]));
    let mut page = 0;
    let last = loop {
        let result = env.client.search(&params(serde_json::json!({ "page": page }))).unwrap();
        if !result.has_more {
            break result;
        }
        page += 1;
    };
    assert_eq!(env.transport.requests().len(), MAX_SEARCH_FEED_PAGES as usize);
    assert!(!last.total_exact, "stopped before the end: the count is a lower bound");
    assert_eq!(last.total, u64::from(MAX_SEARCH_FEED_PAGES) * 25);
}

#[test]
fn filters_wt_live_cant_apply_are_applied_to_each_page() {
    // One post in five is German (by hashtag), one in five is Soviet and historical.
    let env = Env::new(
        "filters",
        catalogue(10, |id| match id % 5 {
            0 => vec!["germany", "tank"],
            1 => vec!["ussr", "historical", "t_34_85"],
            _ => vec!["camo"],
        }),
    );
    let german = env.client.search(&params(serde_json::json!({ "nation": "GER" }))).unwrap();
    assert!(german.items.iter().all(|s| s.vehicle.nation == Nation::Ger));
    assert_eq!(german.items.len(), 20, "it reads feed pages until it has 20");
    assert!(german.has_more);
    let ground = env.client.search(&params(serde_json::json!({ "type": "ground", "nation": "GER" }))).unwrap();
    assert!(ground.items.iter().all(|s| s.vehicle.vehicle_type == VehicleType::Ground));
    let historical = env.client.search(&params(serde_json::json!({ "category": "Historical" }))).unwrap();
    assert!(!historical.items.is_empty());
    assert!(historical.items.iter().all(|s| s.category == Category::Historical && s.vehicle.code == "ussr_t_34_85"));
    let class = env.client.search(&params(serde_json::json!({ "class": "medium tank" }))).unwrap();
    assert!(!class.items.is_empty(), "the catalog's class of the T-34-85");
    assert!(class.items.iter().all(|s| s.vehicle.class == "Medium tank"));
}

#[test]
fn a_filter_nothing_matches_stops_after_a_few_empty_pages() {
    let env = Env::new("dry", catalogue(100, |_| vec!["camo"]));
    let result = env.client.search(&params(serde_json::json!({ "nation": "JPN" }))).unwrap();
    assert!(result.items.is_empty());
    assert_eq!((result.has_more, result.total_exact), (false, false), "stopped, not at the end");
    assert_eq!(env.transport.requests().len(), MAX_DRY_PAGES as usize, "it doesn't walk the whole site");
}

#[test]
fn name_order_sorts_each_page_and_asks_for_newest() {
    let transport = FakeTransport::new(|_, _| {
        let mut posts = vec![fake(1, (7, "S"), &[], 3), fake(2, (7, "S"), &[], 2), fake(3, (7, "S"), &[], 1)];
        posts[0].name = "zebra".into();
        posts[1].name = "Alpha".into();
        posts[2].name = "mike".into();
        Ok(feed_json(&posts))
    });
    let env = Env::new("name", transport);
    let result = env.client.search(&params(serde_json::json!({ "sort": "name" }))).unwrap();
    let names: Vec<&str> = result.items.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Alpha", "mike", "zebra"]);
    assert!(env.transport.requests()[0].contains("sort=created"));
}

#[test]
fn hidden_posts_are_left_out() {
    let env = Env::new("hidden", catalogue(1, |_| vec![]));
    env.hidden.set("1003", true).unwrap();
    let result = env.client.search(&params(serde_json::json!({}))).unwrap();
    assert_eq!(result.items.len(), 24);
    assert!(result.items.iter().all(|s| s.id != "1003"));
    env.hidden.clear().unwrap();
    assert_eq!(env.hidden.count(), 0);
}

#[test]
fn answers_are_cached_across_sessions_until_cleared() {
    let env = Env::new("cache", catalogue(1, |_| vec![]));
    env.client.search(&params(serde_json::json!({}))).unwrap();
    env.second_client().search(&params(serde_json::json!({}))).unwrap();
    assert_eq!(env.transport.requests().len(), 1, "the second session reads the cache");
    assert!(env.cache.size() > 0);
    env.cache.clear();
    assert_eq!(env.cache.size(), 0);
    env.second_client().search(&params(serde_json::json!({}))).unwrap();
    assert_eq!(env.transport.requests().len(), 2);
}

#[test]
fn an_error_answer_is_not_cached() {
    let fail = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&fail);
    let transport = FakeTransport::new(move |_, _| {
        if flag.load(Ordering::SeqCst) {
            Ok(br#"{"status":"ERR","msg":"busy"}"#.to_vec())
        } else {
            Ok(feed_json(&[fake(1, (7, "S"), &[], 1)]))
        }
    });
    let env = Env::new("errcache", transport);
    let e = env.client.search(&params(serde_json::json!({}))).unwrap_err();
    assert_eq!(e.code, ErrorCode::Network);
    fail.store(false, Ordering::SeqCst);
    assert_eq!(env.client.search(&params(serde_json::json!({}))).unwrap().items.len(), 1);
}

#[test]
fn network_failures_are_network_errors() {
    let transport = FakeTransport::new(|_, _| Err(AppError::new(ErrorCode::Network, "WT Live can't be reached")));
    let env = Env::new("down", transport);
    assert_eq!(env.client.search(&params(serde_json::json!({}))).unwrap_err().code, ErrorCode::Network);
    assert_eq!(env.client.post("1").unwrap_err().code, ErrorCode::Network);
}

#[test]
fn authors_are_searched_by_their_feed() {
    let transport = FakeTransport::new(|path, form| {
        match path {
        USERS_PATH if form["nick"] != "fixture_author1" => Ok(br#"{"status":"OK"}"#.to_vec()),
        USERS_PATH => {
            Ok(br#"{"status":"OK","data":[{"id":100001,"nick":"Fixture_Author1","posts":3},{"id":5,"nick":"Fixture_Author10","posts":1}]}"#.to_vec())
        }
        USER_FEED_PATH => {
            assert_eq!(form["user"], "100001");
            Ok(feed_json(&[fake(1, (100_001, "Fixture_Author1"), &["germany"], 5), fake(2, (100_001, "Fixture_Author1"), &["t_34_85"], 4)]))
        }
        _ => Ok(feed_json(&[])),
    }
    });
    let env = Env::new("author", transport);
    let result = env.client.search(&params(serde_json::json!({ "q": "@fixture_author1" }))).unwrap();
    assert_eq!(result.items.len(), 2);
    // With a vehicle too: the author's feed, filtered by vehicle here.
    let t34 =
        env.client.search(&params(serde_json::json!({ "q": "@Fixture_Author1", "vehicle": "ussr_t_34_85" }))).unwrap();
    assert_eq!(t34.items.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["2"]);
    let lookups = env.transport.requests().iter().filter(|r| r.starts_with(USERS_PATH)).count();
    assert_eq!(lookups, 1, "the id is remembered");

    let none = env.client.search(&params(serde_json::json!({ "q": "@Nobody" })));
    assert!(none.unwrap().items.is_empty(), "an unknown author has no skins");
}

#[test]
fn a_vehicle_and_words_ask_for_the_vehicle_and_keep_the_words_here() {
    let transport = FakeTransport::new(|_, form| {
        assert!(form["searchString"].starts_with("#ussr_t_34_85"), "{}", form["searchString"]);
        Ok(feed_json(&[fake(1, (7, "S"), &["t_34_85", "winter"], 2), fake(2, (7, "S"), &["t_34_85"], 1)]))
    });
    let env = Env::new("vehicle-words", transport);
    let result = env.client.search(&params(serde_json::json!({ "vehicle": "ussr_t_34_85", "q": "#winter" }))).unwrap();
    assert_eq!(result.items.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["1"]);
}

#[test]
fn an_unusable_query_finds_nothing_without_asking() {
    let env = Env::new("unusable", catalogue(1, |_| vec![]));
    let result = env.client.search(&params(serde_json::json!({ "q": "!!!" }))).unwrap();
    assert!(result.items.is_empty() && !result.has_more && result.total_exact);
    assert!(env.transport.requests().is_empty());
}

// ── Posts ───────────────────────────────────────────────────────────────────

#[test]
fn posts_are_fetched_by_id_and_cached() {
    let transport = FakeTransport::new(|path, form| {
        assert_eq!(path, POST_PATH);
        match form["lang_group"].as_str() {
            "42" => Ok(serde_json::to_vec(&post_json(&fake(42, (7, "S"), &["su27"], 1))).unwrap()),
            _ => Ok(br#"{"status":"ERR"}"#.to_vec()),
        }
    });
    let env = Env::new("post", transport);
    let skin = env.client.post("42").unwrap();
    assert_eq!(skin.vehicle.code, "su_27");
    env.client.post(" 42 ").unwrap();
    assert_eq!(env.transport.requests().len(), 1, "cached");
    let gone = env.client.post("43").unwrap_err();
    assert_eq!((gone.code, gone.message.as_str()), (ErrorCode::NotFound, POST_GONE));
    env.client.post("43").unwrap_err();
    assert_eq!(env.transport.requests().len(), 3, "a missing post isn't cached");
    for bad in ["s1", "../1", "1 OR 1", ""] {
        assert_eq!(env.client.post(bad).unwrap_err().code, ErrorCode::NotFound, "{bad}");
    }
    assert_eq!(env.transport.requests().len(), 3, "ids that aren't numbers are never sent");
}

// ── Following ───────────────────────────────────────────────────────────────

#[test]
fn following_new_lists_newer_posts_newest_first() {
    let transport = FakeTransport::new(|path, form| match path {
        FEED_PATH => {
            assert!(form["searchString"].contains("#t_34_85"));
            assert_eq!(form["sort"], "created");
            Ok(feed_json(&[fake(10, (7, "S"), &["t_34_85"], 2_000), fake(11, (7, "S"), &["t_34_85"], 500)]))
        }
        USER_FEED_PATH => {
            assert_eq!(form["user"], "100001");
            Ok(feed_json(&[fake(20, (100_001, "A"), &[], 3_000), fake(10, (7, "S"), &["t_34_85"], 2_000)]))
        }
        _ => unreachable!(),
    });
    let env = Env::new("following", transport);
    let since = "1970-01-01T00:16:40Z"; // 1000 s
    let follows = [
        FollowEntry {
            kind: FollowKind::Vehicle,
            id: "ussr_t_34_85".into(),
            name: "T-34-85".into(),
            last_seen_at: since.into(),
        },
        FollowEntry { kind: FollowKind::Author, id: "100001".into(), name: "A".into(), last_seen_at: since.into() },
    ];
    let new = env.client.following_new(&follows).unwrap();
    assert_eq!(new.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["20", "10"], "newest first, once each");
    assert!(new.iter().all(|s| s.is_new == Some(true)));

    env.hidden.set("20", true).unwrap();
    let new = env.client.following_new(&follows).unwrap();
    assert_eq!(new.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["10"]);

    let before = env.transport.requests().len();
    assert!(env.client.following_new(&[]).unwrap().is_empty());
    assert_eq!(env.transport.requests().len(), before, "nothing followed: nothing asked");
}

// ── Browsing off ────────────────────────────────────────────────────────────

#[test]
fn browsing_off_sends_nothing() {
    let env = Env::new("off", catalogue(1, |_| vec![]));
    env.enabled.store(false, Ordering::SeqCst);
    for e in [
        env.client.ready().unwrap_err(),
        env.client.search(&params(serde_json::json!({}))).map(|_| ()).unwrap_err(),
        env.client.post("1").map(|_| ()).unwrap_err(),
        env.client.following_new(&[]).map(|_| ()).unwrap_err(),
        env.client.archive("1", &mut |_| {}).map(|_| ()).unwrap_err(),
    ] {
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, TURNED_OFF_MESSAGE));
    }
    assert!(env.transport.requests().is_empty());
    env.enabled.store(true, Ordering::SeqCst);
    assert!(env.client.ready().is_ok(), "read on every call");
}

// ── Downloads ───────────────────────────────────────────────────────────────

fn post_server() -> Arc<FakeTransport> {
    FakeTransport::new(|path, form| {
        assert_eq!(path, POST_PATH);
        let id: u64 = form["lang_group"].parse().unwrap();
        Ok(serde_json::to_vec(&post_json(&fake(id, (7, "S"), &["su27"], 1))).unwrap())
    })
}

#[test]
fn archives_are_downloaded_once_a_day() {
    let env = Env::new("download", post_server());
    let mut ticks: Vec<DownloadProgress> = Vec::new();
    let path = env.client.archive("42", &mut |p| ticks.push(p)).unwrap();
    assert_eq!(path.extension().unwrap(), "zip");
    assert!(path.starts_with(env.cache.dir()));
    assert_eq!(std::fs::read(&path).unwrap(), zip_bytes());
    assert_eq!(
        ticks.last().map(|t| (t.received, t.total)),
        Some((zip_bytes().len() as u64, Some(zip_bytes().len() as u64)))
    );
    assert_eq!(*env.transport.downloads.lock().unwrap(), [format!("https://live.warthunder.com/dl/{:040x}/", 42)]);
    let again = env.second_client().archive("42", &mut |_| {}).unwrap();
    assert_eq!(again, path);
    assert_eq!(env.transport.downloads.lock().unwrap().len(), 1, "kept for a day");
    assert!(no_partials(path.parent().unwrap()));
}

#[test]
fn a_download_that_isnt_an_archive_leaves_nothing() {
    let env = Env::new("not-archive", post_server());
    *env.transport.archive.lock().unwrap() = Ok(b"<html>login</html>".to_vec());
    let e = env.client.archive("42", &mut |_| {}).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, POST_NOT_AN_ARCHIVE));
    *env.transport.archive.lock().unwrap() = Err(AppError::new(ErrorCode::Network, "cut"));
    assert_eq!(env.client.archive("42", &mut |_| {}).unwrap_err().code, ErrorCode::Network);
    let archives = env.cache.dir().join("archives");
    assert!(std::fs::read_dir(&archives).map_or(true, |mut d| d.next().is_none()), "no file left behind");
}

fn no_partials(dir: &Path) -> bool {
    std::fs::read_dir(dir).unwrap().filter_map(Result::ok).all(|e| !e.file_name().to_string_lossy().contains(".part-"))
}

#[test]
fn feed_requests_carry_what_the_site_sends() {
    let feed = Feed::User { id: 5, sort: "created" };
    let env = Env::new("feed", catalogue(1, |_| vec![]));
    env.client.feed_page(&feed, 2).unwrap();
    assert_eq!(
        env.transport.requests()[0],
        format!("{USER_FEED_PATH}?content=camouflage&featured=0&page=2&sort=created&subtype=all&user=5")
    );
}
