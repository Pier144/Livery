//! The real WT Live client over a fake transport: how searches map onto WT Live's feed, paging,
//! the filters Livery applies itself, the cache, hidden posts, authors, Following, For you, posts
//! and downloads.

use livery_lib::error::{AppError, AppResult, ErrorCode};
use livery_lib::model::{Category, FollowEntry, FollowKind, Nation, SearchParams, VehicleType};
use livery_lib::wtlive::api;
use livery_lib::wtlive::cache::DiskCache;
use livery_lib::wtlive::hidden::HiddenStore;
use livery_lib::wtlive::live::{
    pack_tag_chunks, Feed, LiveClient, FEED_PATH, MAX_DRY_PAGES, MAX_FOR_YOU_REQUESTS, MAX_SEARCH_FEED_PAGES,
    MAX_TAGS_PER_REQUEST, PAGES_IN_ORDER, POST_GONE, POST_NOT_AN_ARCHIVE, POST_PATH, USERS_PATH, USER_FEED_PATH,
    VEHICLE_TOP,
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

// ── For you ─────────────────────────────────────────────────────────────────

#[test]
fn vehicle_top_keeps_three_for_the_vehicle() {
    let transport = FakeTransport::new(|path, _| {
        assert_eq!(path, FEED_PATH);
        Ok(feed_json(&[
            fake(1, (7, "S"), &["t_34_85"], 6),
            fake(2, (7, "S"), &["tiger"], 5),
            fake(3, (7, "S"), &["t_34_85"], 4),
            fake(4, (7, "S"), &["t_34_85"], 3),
            fake(5, (7, "S"), &["t_34_85"], 2),
            fake(6, (7, "S"), &["t_34_85"], 1),
        ]))
    });
    let env = Env::new("top", transport);
    let top = env.client.vehicle_top("ussr_t_34_85").unwrap();
    assert_eq!(top.len(), VEHICLE_TOP);
    assert_eq!(top.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["1", "3", "4"]);
    assert!(top.iter().all(|s| s.vehicle.code == "ussr_t_34_85"));
    let log = env.transport.requests();
    assert_eq!(log.len(), 1);
    assert!(log[0].contains("sort=downloads"), "{}", log[0]);
    assert!(log[0].contains("page=0"), "{}", log[0]);
    assert!(log[0].contains("searchString=#ussr_t_34_85 #t_34_85"), "{}", log[0]);

    env.hidden.set("3", true).unwrap();
    let top = env.client.vehicle_top(" ussr_t_34_85 ").unwrap();
    assert_eq!(top.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["1", "4", "5"], "the next one fills in");
    assert_eq!(env.transport.requests().len(), 1, "the feed page is cached");

    assert!(env.client.vehicle_top("  ").unwrap().is_empty());
    assert_eq!(env.transport.requests().len(), 1, "a blank code asks nothing");
}

/// Makes every cached feed page `by` older.
fn age_cached_pages(env: &Env, by: std::time::Duration) {
    let pages = env.dir.join("cache").join("pages");
    for entry in std::fs::read_dir(pages).unwrap().filter_map(Result::ok) {
        let file = std::fs::File::options().write(true).open(entry.path()).unwrap();
        file.set_modified(std::time::SystemTime::now() - by).unwrap();
    }
}

#[test]
fn vehicle_top_reuses_its_page_for_a_day() {
    let transport = FakeTransport::new(|_, _| Ok(feed_json(&[fake(1, (7, "S"), &["t_34_85"], 1)])));
    let env = Env::new("top-day", transport);
    assert_eq!(env.client.vehicle_top("ussr_t_34_85").unwrap().len(), 1);
    assert_eq!(env.transport.requests().len(), 1);

    // Two hours later, in a new session: the most downloaded skins change slowly, nothing is asked.
    age_cached_pages(&env, std::time::Duration::from_secs(2 * 3600));
    assert_eq!(env.second_client().vehicle_top("ussr_t_34_85").unwrap().len(), 1);
    assert_eq!(env.transport.requests().len(), 1);

    // Past a day the page is asked again.
    age_cached_pages(&env, std::time::Duration::from_secs(25 * 3600));
    assert_eq!(env.second_client().vehicle_top("ussr_t_34_85").unwrap().len(), 1);
    assert_eq!(env.transport.requests().len(), 2);
}

#[test]
fn vehicle_top_keeps_a_post_carrying_the_vehicles_hashtag_whatever_it_was_matched_to() {
    // A pack for several vehicles is matched to the first one it names (the Su-27 here), and a
    // national copy's skins to the original; a hashtag of the asked vehicle still counts, as in
    // Explore filtered by that vehicle.
    let transport = FakeTransport::new(|_, _| {
        Ok(feed_json(&[
            fake(1, (7, "S"), &["su_27", "t_34_85"], 3),
            fake(2, (7, "S"), &["su_27"], 2),
            fake(3, (7, "S"), &["t3485"], 1),
        ]))
    });
    let env = Env::new("top-pack", transport);
    let top = env.client.vehicle_top("ussr_t_34_85").unwrap();
    assert_eq!(top.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["1", "3"]);
}

#[test]
fn vehicle_top_of_a_code_without_tags_asks_nothing() {
    let env = Env::new("top-no-tags", catalogue(1, |_| vec![]));
    for code in ["a", "#", " x ", "!?"] {
        assert!(api::vehicle_tags(code).is_empty(), "{code}: {:?}", api::vehicle_tags(code));
        assert!(env.client.vehicle_top(code).unwrap().is_empty(), "{code}");
    }
    assert!(env.transport.requests().is_empty(), "never the global downloads feed");
}

fn tags(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}{i}")).collect()
}

fn members(chunks: &[(Vec<usize>, Vec<String>)]) -> Vec<Vec<usize>> {
    chunks.iter().map(|(m, _)| m.clone()).collect()
}

#[test]
fn pack_tag_chunks_never_splits_a_vehicle() {
    let chunks = pack_tag_chunks(&[tags("a", 30), tags("b", 15), tags("c", 5)], 40);
    assert_eq!(members(&chunks), [vec![0], vec![1, 2]]);
    assert_eq!(chunks[0].1, tags("a", 30));
    assert_eq!(chunks[1].1, [tags("b", 15), tags("c", 5)].concat());

    // Too many tags for one request: a chunk of its own, cut to the limit.
    let chunks = pack_tag_chunks(&[tags("a", 10), tags("big", 45), tags("c", 5)], 40);
    assert_eq!(members(&chunks), [vec![0], vec![1], vec![2]]);
    assert_eq!(chunks[1].1, tags("big", 40));

    // Tags two vehicles share are sent once.
    let chunks = pack_tag_chunks(&[vec!["x".into(), "y".into()], vec!["y".into(), "z".into()]], 40);
    assert_eq!(chunks, [(vec![0, 1], vec!["x".to_owned(), "y".into(), "z".into()])]);
}

#[test]
fn pack_tag_chunks_keeps_blanks_with_a_chunk() {
    // A vehicle without tags opens no chunk and rides along with one, leading ones included.
    let chunks = pack_tag_chunks(&[vec![], tags("a", 30), vec![], tags("b", 15), vec![]], 40);
    assert_eq!(members(&chunks), [vec![0, 1, 2], vec![3, 4]]);
    assert!(pack_tag_chunks(&[vec![], vec![]], 40).is_empty());
    assert!(pack_tag_chunks(&[], 40).is_empty());
}

#[test]
fn for_you_new_matches_each_post_to_a_vehicle() {
    let transport = FakeTransport::new(|path, form| {
        assert_eq!(path, FEED_PATH);
        assert_eq!(form["sort"], "created");
        assert_eq!(form["page"], "0");
        assert!(form["searchString"].contains("#t_34_85"), "{}", form["searchString"]);
        assert!(form["searchString"].contains("#zz_alpha"), "{}", form["searchString"]);
        Ok(feed_json(&[
            fake(1, (7, "S"), &["zz_alpha"], 3_000),
            fake(2, (7, "S"), &["t_34_85"], 2_500),
            fake(3, (7, "S"), &["t_34_85"], 2_000),
            fake(1, (7, "S"), &["zz_alpha"], 3_000),
            fake(4, (7, "S"), &["zz_alpha"], 1_500),
            fake(5, (7, "S"), &["t_34_85"], 900),
            fake(6, (7, "S"), &["camo"], 2_800),
        ]))
    });
    let env = Env::new("for-you", transport);
    env.hidden.set("3", true).unwrap();
    let vehicles = vec!["ussr_t_34_85".to_owned(), "zz_alpha".to_owned()];
    let new = env.client.for_you_new(&vehicles, 1_000).unwrap();
    let found: Vec<(&str, &str)> = new.items.iter().map(|f| (f.vehicle.as_str(), f.skin.id.as_str())).collect();
    // 3 is hidden, 5 is older than `since`, 6 is for neither vehicle, 1 comes once.
    assert_eq!(found, [("zz_alpha", "1"), ("ussr_t_34_85", "2"), ("zz_alpha", "4")], "newest first, once each");
    assert!(new.items.iter().all(|f| f.skin.is_new == Some(true)));
    assert_eq!(new.checked, 2);
    assert_eq!(env.transport.requests().len(), 1, "both vehicles in one request");
}

#[test]
fn a_post_for_two_vehicles_of_a_chunk_goes_to_the_first_in_list_order() {
    // Neither code is in the catalog: the post matches both by its hashtags.
    let transport = FakeTransport::new(|_, _| Ok(feed_json(&[fake(1, (7, "S"), &["zz_alpha", "zz_beta"], 2_000)])));
    let env = Env::new("for-you-two", transport);
    for vehicles in [["zz_beta", "zz_alpha"], ["zz_alpha", "zz_beta"]] {
        let vehicles: Vec<String> = vehicles.iter().map(|v| (*v).to_owned()).collect();
        let new = env.client.for_you_new(&vehicles, 1_000).unwrap();
        let found: Vec<(&str, &str)> = new.items.iter().map(|f| (f.vehicle.as_str(), f.skin.id.as_str())).collect();
        assert_eq!(found, [(vehicles[0].as_str(), "1")], "{vehicles:?}");
    }
}

#[test]
fn a_post_in_two_chunks_answers_comes_once() {
    // Ten vehicles of four tags fill the first request; the eleventh opens a second one. WT Live
    // answers the same post to both.
    let transport = FakeTransport::new(|_, _| Ok(feed_json(&[fake(1, (7, "S"), &["ussr_zz_c0", "zz_d0"], 2_000)])));
    let env = Env::new("for-you-twice", transport);
    let mut vehicles: Vec<String> = (0..10).map(|n| format!("ussr_zz_c{n}")).collect();
    vehicles.push("ussr_zz_d0".to_owned());
    let new = env.client.for_you_new(&vehicles, 1_000).unwrap();
    assert_eq!(env.transport.requests().len(), 2, "two chunks");
    assert_eq!(new.checked, 11);
    let found: Vec<(&str, &str)> = new.items.iter().map(|f| (f.vehicle.as_str(), f.skin.id.as_str())).collect();
    assert_eq!(found, [("ussr_zz_c0", "1")], "once, for the vehicle of the first chunk");
}

#[test]
fn for_you_new_caps_requests() {
    let env = Env::new("for-you-cap", FakeTransport::new(|_, _| Ok(feed_json(&[]))));
    let vehicles: Vec<String> = (0..150).map(|n| format!("ussr_zz_a{n}")).collect();
    for v in &vehicles {
        assert_eq!(api::vehicle_tags(v).len(), 4, "{v}: {:?}", api::vehicle_tags(v));
    }
    let new = env.client.for_you_new(&vehicles, 0).unwrap();
    assert_eq!(env.transport.requests().len(), MAX_FOR_YOU_REQUESTS);
    assert_eq!(new.checked as usize, MAX_FOR_YOU_REQUESTS * (MAX_TAGS_PER_REQUEST / 4));
    assert!((new.checked as usize) < vehicles.len());
    assert!(env.transport.requests().iter().all(|r| r.contains("searchString=#")));
}

#[test]
fn for_you_new_never_asks_the_global_feed_for_blanks() {
    let transport = FakeTransport::new(|_, form| {
        assert!(form.contains_key("searchString"), "never the global feed");
        Ok(feed_json(&[fake(1, (7, "S"), &["t_34_85"], 2_000)]))
    });
    let env = Env::new("for-you-blank", transport);
    let vehicles: Vec<String> = ["", "ussr_t_34_85", "  "].iter().map(|v| (*v).to_owned()).collect();
    let new = env.client.for_you_new(&vehicles, 1_000).unwrap();
    assert_eq!(new.checked, 3, "blanks count with the chunk they ride along with");
    assert_eq!(new.items.iter().map(|f| f.vehicle.as_str()).collect::<Vec<_>>(), ["ussr_t_34_85"]);
    assert_eq!(env.transport.requests().len(), 1);

    let only_blanks = env.client.for_you_new(&[" ".to_owned(), String::new()], 1_000).unwrap();
    assert!(only_blanks.items.is_empty());
    assert_eq!(only_blanks.checked, 2, "nothing to check is all checked");
    assert_eq!(env.transport.requests().len(), 1, "nothing asked");
}

#[test]
fn for_you_new_keeps_what_it_has_when_a_later_chunk_fails() {
    // The chunk holding the T-34-85 answers; any other chunk fails.
    let transport = FakeTransport::new(|_, form| {
        if form["searchString"].contains("#ussr_t_34_85") {
            Ok(feed_json(&[fake(1, (7, "S"), &["t_34_85"], 2_000)]))
        } else {
            Err(AppError::new(ErrorCode::Network, "WT Live can't be reached"))
        }
    });
    let env = Env::new("for-you-fail", transport);
    let failing: Vec<String> = (0..20).map(|n| format!("ussr_zz_b{n}")).collect();
    let vehicles = [vec!["ussr_t_34_85".to_owned()], failing.clone()].concat();
    let new = env.client.for_you_new(&vehicles, 1_000).unwrap();
    assert_eq!(new.items.iter().map(|f| f.skin.id.as_str()).collect::<Vec<_>>(), ["1"]);
    let first_chunk = 1 + (MAX_TAGS_PER_REQUEST - api::vehicle_tags("ussr_t_34_85").len()) / 4;
    assert_eq!(new.checked as usize, first_chunk, "stops before the chunk that failed");
    assert_eq!(env.transport.requests().len(), 2, "no request after the failure");

    let e = env.client.for_you_new(&failing, 1_000).unwrap_err();
    assert_eq!(e.code, ErrorCode::Network, "the first request failing is the call's error");
}

#[test]
fn for_you_new_of_nothing_asks_nothing() {
    let env = Env::new("for-you-none", catalogue(1, |_| vec![]));
    let new = env.client.for_you_new(&[], 0).unwrap();
    assert!(new.items.is_empty());
    assert_eq!(new.checked, 0);
    assert!(env.transport.requests().is_empty());
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
        env.client.vehicle_top("ussr_t_34_85").map(|_| ()).unwrap_err(),
        env.client.for_you_new(&["ussr_t_34_85".to_owned()], 0).map(|_| ()).unwrap_err(),
        env.client.for_you_new(&[], 0).map(|_| ()).unwrap_err(),
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
