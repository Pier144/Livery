//! What Livery keeps of WT Live on disk: the cache (a day at most, clearable) and the hidden
//! posts (persisted, tolerant of a bad file).

use livery_lib::error::ErrorCode;
use livery_lib::wtlive::cache::{DiskCache, MAX_AGE};
use livery_lib::wtlive::hidden::HiddenStore;
use livery_lib::wtlive::MISSING_SKIN_ID;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

fn temp_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("livery-wtlive-storage-{name}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn age(path: &std::path::Path, by: Duration) {
    let file = fs::File::options().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - by).unwrap();
}

#[test]
fn the_cache_keeps_answers_for_their_freshness_and_never_more_than_a_day() {
    let dir = temp_dir("cache");
    let cache = DiskCache::new(dir.join("cache"));
    assert_eq!(cache.get("k", Duration::from_secs(60)), None);
    cache.put("k", b"{\"a\":1}\nwith a newline");
    assert_eq!(cache.get("k", Duration::from_secs(60)).as_deref(), Some(&b"{\"a\":1}\nwith a newline"[..]));
    assert_eq!(cache.get("other", Duration::from_secs(60)), None);
    let page = fs::read_dir(dir.join("cache/pages")).unwrap().next().unwrap().unwrap().path();
    age(&page, Duration::from_secs(120));
    assert_eq!(cache.get("k", Duration::from_secs(60)), None, "older than asked");
    assert!(cache.get("k", Duration::from_secs(3600)).is_some());
    age(&page, MAX_AGE + Duration::from_secs(1));
    assert_eq!(cache.get("k", Duration::from_secs(u64::MAX / 2)), None, "never older than a day");
    assert_eq!(cache.purge_expired(), 1);
    assert_eq!(cache.size(), 0);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn archives_and_half_downloads() {
    let dir = temp_dir("archives");
    let cache = DiskCache::new(dir.join("cache"));
    let archives = cache.archives_dir().unwrap();
    fs::write(archives.join("42.zip"), b"PK").unwrap();
    fs::write(archives.join("43.part-1"), b"PK").unwrap();
    assert_eq!(cache.fresh_archive("42"), Some(archives.join("42.zip")));
    assert_eq!(cache.fresh_archive("43"), None);
    assert_eq!(cache.size(), 4);
    assert_eq!(cache.purge_expired(), 1, "a half download from a past session goes");
    age(&archives.join("42.zip"), MAX_AGE + Duration::from_secs(1));
    assert_eq!(cache.fresh_archive("42"), None);
    cache.clear();
    assert_eq!(cache.size(), 0);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn hidden_posts_persist() {
    let dir = temp_dir("hidden");
    let path = dir.join("wtlive-hidden.json");
    let store = HiddenStore::load(path.clone());
    store.set(" 42 ", true).unwrap();
    store.set("43", true).unwrap();
    store.set("43", false).unwrap();
    assert!(store.contains("42") && !store.contains("43"));
    let reloaded = HiddenStore::load(path.clone());
    assert_eq!(reloaded.count(), 1);
    assert!(reloaded.contains("42"));
    let e = reloaded.set("  ", true).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, MISSING_SKIN_ID));
    reloaded.clear().unwrap();
    assert_eq!(HiddenStore::load(path.clone()).count(), 0);

    fs::write(&path, "{ not json").unwrap();
    assert_eq!(HiddenStore::load(path.clone()).count(), 0);
    assert!(path.with_extension("json.bad").exists(), "a corrupt file is set aside");
    fs::write(&path, r#"{ "version": 9, "ids": ["1", 2, null, ""] }"#).unwrap();
    assert_eq!(HiddenStore::load(path).count(), 2, "numbers count, junk doesn't");
    fs::remove_dir_all(dir).ok();
}
