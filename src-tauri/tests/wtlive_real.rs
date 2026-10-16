//! Against the real WT Live (ignored by default: they send about a dozen requests, one a second).
//! Run by hand after a change to the client, or when WT Live may have changed its answers:
//! `cargo test --test wtlive_real -- --ignored --nocapture` (add `for_you` for For you only).

use livery_lib::library::index::LibraryStore;
use livery_lib::model::{FollowEntry, FollowKind, InstallMode, SearchParams, Settings};
use livery_lib::wtlive::cache::DiskCache;
use livery_lib::wtlive::hidden::HiddenStore;
use livery_lib::wtlive::install::{self, Ctx, Installing};
use livery_lib::wtlive::net::HttpTransport;
use livery_lib::wtlive::{LiveClient, WtLiveClient};
use std::sync::Arc;

fn params(json: serde_json::Value) -> SearchParams {
    serde_json::from_value(json).unwrap()
}

#[test]
#[ignore = "reaches the real WT Live"]
fn the_real_wt_live_answers_and_a_skin_installs() {
    let dir = std::env::temp_dir().join(format!("livery-wtlive-real-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("UserSkins")).unwrap();
    let cache = Arc::new(DiskCache::new(dir.join("cache")));
    let hidden = Arc::new(HiddenStore::load(dir.join("hidden.json")));
    let client = LiveClient::new(Arc::new(HttpTransport::new()), cache, hidden, Arc::new(|| true));

    let newest = client.search(&params(serde_json::json!({ "sort": "newest", "page": 0 }))).unwrap();
    println!("newest: {} skins, has more: {}, {} ms", newest.items.len(), newest.has_more, newest.took_ms);
    for skin in newest.items.iter().take(5) {
        println!(
            "  {} · {:?} · by {} · {} · {} images · {} bytes",
            skin.name,
            skin.vehicle.code,
            skin.author.name,
            skin.posted_at,
            skin.images.len(),
            skin.size_bytes
        );
    }
    assert!(newest.items.len() >= 10 && newest.has_more);

    let first = &newest.items[0];
    let post = client.post(&first.id).unwrap();
    println!("post {}: {} images, download {}", post.id, post.images.len(), post.download_url);
    assert_eq!(post.id, first.id);

    let by_vehicle =
        client.search(&params(serde_json::json!({ "sort": "downloads", "page": 0, "vehicle": "f_4e" }))).unwrap();
    println!("f_4e by downloads: {} skins", by_vehicle.items.len());
    assert!(!by_vehicle.items.is_empty());

    let author = client
        .search(&params(serde_json::json!({ "sort": "newest", "page": 0, "q": format!("@{}", first.author.name) })))
        .unwrap();
    println!("@{}: {} skins", first.author.name, author.items.len());
    assert!(author.items.iter().any(|s| s.id == first.id));

    let week_ago = livery_lib::library::time::format_unix_secs(first_created(&newest) - 7 * 24 * 3600);
    let follows = [FollowEntry {
        kind: FollowKind::Author,
        id: first.author.id.clone(),
        name: first.author.name.clone(),
        last_seen_at: week_ago,
    }];
    let new = client.following_new(&follows).unwrap();
    println!("following new: {}", new.len());
    assert!(!new.is_empty());

    // The smallest archive on the page, installed into a scratch UserSkins.
    let smallest = newest.items.iter().filter(|s| s.size_bytes > 0).min_by_key(|s| s.size_bytes).unwrap();
    println!("installing {} ({} bytes)", smallest.name, smallest.size_bytes);
    let user_skins = dir.join("UserSkins");
    let store = LibraryStore::load(dir.join("library.json"));
    let settings = Settings::default();
    let ctx = Ctx { user_skins: &user_skins, library: &store, settings: &settings, client: &client };
    let installing = Installing::default();
    let job = install::prepare(&ctx, &installing, &smallest.id, InstallMode::Normal, None).unwrap();
    let mut steps = Vec::new();
    match install::run(&ctx, &job, &mut |p| steps.push((p.step, p.pct))) {
        Ok(skin) => {
            let skin = skin.unwrap();
            println!("installed as {} ({}), vehicle {}", skin.folder, skin.name, skin.vehicle.code);
            assert!(user_skins.join(&skin.folder).is_dir());
        }
        // Some posts hold no skin the game can use (no .blk): that is the post, not the client.
        Err(e) => println!("install failed: {e}"),
    }
    println!("steps: {:?}", steps.iter().map(|(s, p)| format!("{s:?} {p}")).collect::<Vec<_>>());
    let _ = std::fs::remove_dir_all(&dir);
}

fn first_created(result: &livery_lib::model::SearchResult) -> i64 {
    livery_lib::library::time::parse_rfc3339(&result.items[0].posted_at).unwrap()
}

#[test]
#[ignore = "reaches the real WT Live"]
fn for_you_on_the_real_wt_live() {
    let dir = std::env::temp_dir().join(format!("livery-wtlive-real-for-you-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.join("cache")));
    let hidden = Arc::new(HiddenStore::load(dir.join("hidden.json")));
    let client = LiveClient::new(Arc::new(HttpTransport::new()), cache, hidden, Arc::new(|| true));

    // Two vehicles in one request (one chunk): the site ORs their hashtags.
    let vehicles = vec!["us_m18_hellcat".to_owned(), "ussr_t_34_85".to_owned()];
    let now = livery_lib::library::time::unix_secs(std::time::SystemTime::now());
    let new = client.for_you_new(&vehicles, now - 30 * 24 * 3600).unwrap();
    println!("for you new: {} skins, {} vehicles checked", new.items.len(), new.checked);
    for found in new.items.iter().take(10) {
        println!("  {} · {} · {}", found.vehicle, found.skin.name, found.skin.posted_at);
    }
    assert_eq!(new.checked, 2);
    assert!(new.items.iter().all(|f| vehicles.contains(&f.vehicle)));

    let top = client.vehicle_top("ussr_t_34_85").unwrap();
    println!("T-34-85 top: {:?}", top.iter().map(|s| (&s.name, s.downloads)).collect::<Vec<_>>());
    assert!(top.len() <= 3);
    // Matched by its code, or by a hashtag when the post's vehicle isn't in the built-in list.
    assert!(top.iter().all(|s| s.vehicle.code.is_empty() || s.vehicle.code == "ussr_t_34_85"));
    let _ = std::fs::remove_dir_all(&dir);
}
