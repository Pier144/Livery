//! The real [`WtLiveClient`]: WT Live's JSON endpoints ([`super::api`]) through a polite
//! [`Transport`] ([`super::net`]), with the disk cache ([`super::cache`]) and the hidden posts
//! ([`super::hidden`]).
//!
//! # Explore
//! WT Live sorts and searches on its side (newest, downloads, rating; hashtags OR-ed; one
//! author's posts) and pages by 25 with no total. Livery maps the search onto that
//! ([`LiveClient::plan`]) and applies what WT Live can't do (nation, type, class, category, a
//! second criterion, hidden posts) to each page it fetches. A result page reads feed pages until
//! it holds [`RESULT_TARGET`] skins, or [`MAX_FEED_PAGES`] once it has one; after
//! [`MAX_DRY_PAGES`] feed pages in a row without a match the search ends there, and no search
//! reads more than [`MAX_SEARCH_FEED_PAGES`]. Where each result page starts is remembered per
//! search, so paging is stable; pages are asked in order. The total is a lower bound
//! (`totalExact` only once the end is reached). Name order sorts each page by name, since WT
//! Live can't sort by name.
//!
//! # For you
//! [`WtLiveClient::vehicle_top`] reads the first downloads page of one vehicle's feed.
//! [`WtLiveClient::for_you_new`] packs the lineup vehicles' hashtags into requests of at most
//! [`MAX_TAGS_PER_REQUEST`] ([`pack_tag_chunks`]: a vehicle is never split), reads the first
//! newest page of each, at most [`MAX_FOR_YOU_REQUESTS`] of them, and matches each post to the
//! first vehicle of its chunk it is for. Counts are a lower bound, as with Following.
//!
//! # Freshness
//! Listings are cached for [`LISTING_TTL`], posts for [`POST_TTL`], author look-ups, archives
//! and For you's most downloaded skins per vehicle ([`TOP_TTL`]) for a day ([`cache::MAX_AGE`]).
//! Nothing is fetched unless a command asks.

use super::api::{self, FoundUser, Post, TextQuery};
use super::cache::{self, DiskCache, PART_MARK};
use super::client::{turned_off, DownloadProgress, WtLiveClient};
use super::hidden::HiddenStore;
use super::net::Transport;
use crate::archive::source::{sniff, ArchiveKind};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::time;
use crate::model::{
    Category, FollowEntry, FollowKind, ForYouNew, ForYouSkin, Nation, SearchParams, SearchResult, SortOrder,
    VehicleType, WtLiveSkin,
};
use std::collections::{HashMap, HashSet};
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a listing page is reused.
pub const LISTING_TTL: Duration = Duration::from_secs(30 * 60);
/// How long For you reuses a vehicle's most downloaded skins: they change slowly, so a page is
/// kept for the cache's full day (`cache::MAX_AGE`) instead of [`LISTING_TTL`].
pub const TOP_TTL: Duration = cache::MAX_AGE;
/// How long a post is reused.
pub const POST_TTL: Duration = Duration::from_secs(6 * 3600);
/// Skins a result page aims for.
pub const RESULT_TARGET: usize = 20;
/// Feed pages one result page reads once it has at least one skin (each is a request unless
/// cached).
pub const MAX_FEED_PAGES: u32 = 4;
/// Feed pages in a row without a match after which a search stops (no more pages): a filter
/// WT Live can't apply must not walk the whole site.
pub const MAX_DRY_PAGES: u32 = 8;
/// Feed pages one search reads at most (1,000 posts): past it the search shows no more pages.
pub const MAX_SEARCH_FEED_PAGES: u32 = 40;

/// `invalidInput` message for a result page asked before the ones in front of it.
pub const PAGES_IN_ORDER: &str = "Ask for the pages of a search in order";
/// Followed entries checked per `following_new` (one request each, at most one a second).
pub const MAX_FOLLOWS_CHECKED: usize = 30;
/// Hashtags per `for_you_new` request (one `searchString`).
pub const MAX_TAGS_PER_REQUEST: usize = 40;
/// Requests per `for_you_new` call (one a second).
pub const MAX_FOR_YOU_REQUESTS: usize = 10;
/// Skins `vehicle_top` returns.
pub const VEHICLE_TOP: usize = 3;
/// Largest archive Livery downloads.
pub const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub const FEED_PATH: &str = "/api/feed/get_regular/";
pub const USER_FEED_PATH: &str = "/api/feed/get_user/";
pub const POST_PATH: &str = "/api/posts/get/";
pub const USERS_PATH: &str = "/api/user/get_possible/";

/// `notFound` message for a post WT Live doesn't have (or that isn't an installable skin).
pub const POST_GONE: &str = "This skin is no longer on WT Live";
/// `invalidInput` message for a download that isn't a ZIP, 7z or RAR archive.
pub const POST_NOT_AN_ARCHIVE: &str = "This post's file isn't a ZIP, 7z or RAR archive";

/// A feed WT Live can list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Feed {
    /// Every camouflage, or those with any of `tags`.
    Regular { sort: &'static str, tags: Vec<String> },
    /// One author's camouflages.
    User { id: u64, sort: &'static str },
}

impl Feed {
    fn key(&self) -> String {
        match self {
            Self::Regular { sort, tags } => format!("feed|{sort}|{}", tags.join(",")),
            Self::User { id, sort } => format!("user|{id}|{sort}"),
        }
    }

    fn request(&self, page: u32) -> (&'static str, Vec<(&'static str, String)>) {
        let mut form = vec![("content", "camouflage".to_owned())];
        let path = match self {
            Self::Regular { sort, tags } => {
                form.push(("sort", (*sort).to_owned()));
                if !tags.is_empty() {
                    form.push(("searchString", api::search_string(tags)));
                }
                FEED_PATH
            }
            Self::User { id, sort } => {
                form.push(("sort", (*sort).to_owned()));
                form.push(("user", id.to_string()));
                USER_FEED_PATH
            }
        };
        form.push(("page", page.to_string()));
        form.push(("featured", "0".to_owned()));
        form.push(("subtype", "all".to_owned()));
        (path, form)
    }
}

/// What WT Live can't filter: applied by Livery to each fetched post.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LocalFilter {
    pub nation: Option<Nation>,
    pub vehicle_type: Option<VehicleType>,
    pub class: Option<String>,
    pub category: Option<Category>,
    /// A vehicle code, when WT Live was asked for something else (an author).
    pub vehicle: Option<String>,
    /// Hashtags (any of them), when WT Live was asked for a vehicle.
    pub tags: Vec<String>,
}

impl LocalFilter {
    pub fn matches(&self, post: &Post) -> bool {
        self.nation.is_none_or_eq(post.nation)
            && self.vehicle_type.is_none_or_eq(post.vehicle_type)
            && self.class.as_ref().map_or(true, |c| post.skin.vehicle.class.eq_ignore_ascii_case(c))
            && self.category.map_or(true, |c| post.skin.category == c)
            && self.vehicle.as_ref().map_or(true, |code| api::is_for_vehicle(post, code))
            && (self.tags.is_empty() || {
                let wanted: Vec<String> = self.tags.iter().map(|t| api::squash(t)).collect();
                post.tags.iter().any(|t| wanted.contains(&api::squash(t)))
            })
    }
}

trait FilterField<T> {
    fn is_none_or_eq(&self, value: Option<T>) -> bool;
}

impl<T: PartialEq + Copy> FilterField<T> for Option<T> {
    /// No filter, or the post's value is known and equal.
    fn is_none_or_eq(&self, value: Option<T>) -> bool {
        self.map_or(true, |wanted| value == Some(wanted))
    }
}

/// How a search maps onto WT Live: a feed (`None`: nothing can match) and the local filter.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub feed: Option<Feed>,
    pub filter: LocalFilter,
    pub by_name: bool,
}

/// What is remembered of a result page already built.
#[derive(Debug, Clone)]
struct PageMeta {
    /// First feed page the next result page reads.
    next: u32,
    /// Results before this page.
    before: u64,
    /// The posts it showed.
    ids: Vec<String>,
    /// WT Live had nothing after it.
    end: bool,
    /// Livery stopped reading there (see [`PageRun::truncated`]).
    truncated: bool,
}

impl PageMeta {
    /// Results up to and including this page.
    fn after(&self) -> u64 {
        self.before + self.ids.len() as u64
    }
}

/// One result page, once built.
#[derive(Debug, Clone)]
struct PageRun {
    /// First feed page the next result page reads.
    next: u32,
    /// Results before this page.
    before: u64,
    items: Vec<WtLiveSkin>,
    /// WT Live had nothing after it.
    end: bool,
    /// Livery stopped reading before the end: [`MAX_DRY_PAGES`] without a match, or the search
    /// reached [`MAX_SEARCH_FEED_PAGES`]. No more pages, and the total isn't exact.
    truncated: bool,
}

impl PageRun {
    fn empty_after(last: &PageMeta) -> Self {
        Self { next: last.next, before: last.after(), items: Vec::new(), end: last.end, truncated: last.truncated }
    }
}

pub struct LiveClient {
    transport: Arc<dyn Transport>,
    cache: Arc<DiskCache>,
    hidden: Arc<HiddenStore>,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Feed key + filter → the result pages built so far (see the module doc).
    pages: Mutex<HashMap<String, Vec<PageMeta>>>,
    /// Lower-cased nickname → author id, from every post and look-up seen.
    authors: Mutex<HashMap<String, u64>>,
    /// One download at a time.
    downloading: Mutex<()>,
}

impl LiveClient {
    pub fn new(
        transport: Arc<dyn Transport>,
        cache: Arc<DiskCache>,
        hidden: Arc<HiddenStore>,
        enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self {
            transport,
            cache,
            hidden,
            enabled,
            pages: Mutex::new(HashMap::new()),
            authors: Mutex::new(HashMap::new()),
            downloading: Mutex::new(()),
        }
    }

    fn check_enabled(&self) -> AppResult<()> {
        if (self.enabled)() {
            Ok(())
        } else {
            Err(turned_off())
        }
    }

    /// `bytes` of a cached answer younger than `ttl`, else a fresh one (cached only when
    /// `valid` accepts it, so a garbled answer isn't kept).
    fn fetch(
        &self,
        key: &str,
        ttl: Duration,
        request: impl FnOnce() -> AppResult<Vec<u8>>,
        valid: impl Fn(&[u8]) -> bool,
    ) -> AppResult<Vec<u8>> {
        if let Some(bytes) = self.cache.get(key, ttl).filter(|b| valid(b)) {
            return Ok(bytes);
        }
        let bytes = request()?;
        if valid(&bytes) {
            self.cache.put(key, &bytes);
        }
        Ok(bytes)
    }

    /// One feed page, parsed: the installable posts and how many entries WT Live sent.
    pub fn feed_page(&self, feed: &Feed, page: u32) -> AppResult<(Vec<Post>, usize)> {
        self.feed_page_within(feed, page, LISTING_TTL)
    }

    /// [`Self::feed_page`], reusing a cached page younger than `ttl`.
    fn feed_page_within(&self, feed: &Feed, page: u32, ttl: Duration) -> AppResult<(Vec<Post>, usize)> {
        let (path, form) = feed.request(page);
        let key = format!("{}|{page}", feed.key());
        let bytes = self.fetch(&key, ttl, || self.transport.post_form(path, &form), |b| api::parse_feed(b).is_ok())?;
        let raw_len = raw_list_len(&bytes);
        let posts = api::parse_feed(&bytes)?;
        self.remember_authors(&posts);
        Ok((posts, raw_len))
    }

    fn remember_authors(&self, posts: &[Post]) {
        let mut authors = self.authors.lock().unwrap_or_else(|e| e.into_inner());
        if authors.len() > 10_000 {
            authors.clear();
        }
        for post in posts {
            if let Ok(id) = post.skin.author.id.parse::<u64>() {
                authors.insert(post.skin.author.name.to_lowercase(), id);
            }
        }
    }

    /// The id of the author called `name` (case-insensitive), from the posts seen or WT Live's
    /// user look-up. `None` when nobody has that name.
    pub fn author_id(&self, name: &str) -> AppResult<Option<u64>> {
        let lower = name.trim().to_lowercase();
        if lower.is_empty() {
            return Ok(None);
        }
        if let Some(&id) = self.authors.lock().unwrap_or_else(|e| e.into_inner()).get(&lower) {
            return Ok(Some(id));
        }
        let query = vec![("nick", name.trim().to_owned()), ("count", "10".to_owned())];
        let bytes = self.fetch(
            &format!("users|{lower}"),
            cache::MAX_AGE,
            || self.transport.get(USERS_PATH, &query),
            |b| api::parse_possible_users(b).is_ok(),
        )?;
        let found: Vec<FoundUser> = api::parse_possible_users(&bytes)?;
        let mut authors = self.authors.lock().unwrap_or_else(|e| e.into_inner());
        for user in &found {
            authors.insert(user.nick.to_lowercase(), user.id);
        }
        Ok(found.iter().find(|u| u.nick.to_lowercase() == lower).map(|u| u.id))
    }

    /// How `params` maps onto WT Live (see the module doc).
    pub fn plan(&self, params: &SearchParams) -> AppResult<Plan> {
        let sort = match params.sort {
            SortOrder::Downloads => "downloads",
            SortOrder::Likes => "rating",
            SortOrder::Newest | SortOrder::Name => "created",
        };
        let mut filter = LocalFilter {
            nation: params.nation.filter(|n| *n != Nation::Unknown),
            vehicle_type: params.vehicle_type,
            class: params.class.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned),
            category: params.category,
            ..LocalFilter::default()
        };
        let vehicle = params.vehicle.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
        let q = params.q.as_deref().map(str::trim).unwrap_or_default();
        let by_name = params.sort == SortOrder::Name;
        let text = if q.is_empty() {
            None
        } else {
            match api::text_query(q) {
                Some(text) => Some(text),
                // Something was typed but nothing in it can be searched.
                None => return Ok(Plan { feed: None, filter, by_name }),
            }
        };
        let vehicle_tags = vehicle.as_deref().map(api::vehicle_tags);
        let feed = match text {
            Some(TextQuery::Author(name)) => match self.author_id(&name)? {
                Some(id) => {
                    filter.vehicle = vehicle;
                    Some(Feed::User { id, sort })
                }
                None => None,
            },
            Some(TextQuery::Tags(tags)) => match vehicle_tags {
                Some(vt) => {
                    filter.tags = tags;
                    Some(Feed::Regular { sort, tags: vt })
                }
                None => Some(Feed::Regular { sort, tags }),
            },
            None => Some(Feed::Regular { sort, tags: vehicle_tags.unwrap_or_default() }),
        };
        Ok(Plan { feed, filter, by_name })
    }

    /// Builds the result page that starts at feed page `start`, leaving out posts the pages
    /// before it showed (WT Live's pages shift when someone posts meanwhile).
    fn run_page(
        &self,
        feed: &Feed,
        filter: &LocalFilter,
        start: u32,
        before: u64,
        shown: &HashSet<String>,
    ) -> AppResult<PageRun> {
        let mut items: Vec<WtLiveSkin> = Vec::new();
        let mut ids: HashSet<String> = HashSet::new();
        let mut next = start;
        let mut end = false;
        let mut truncated = false;
        let mut read = 0;
        let mut dry = 0;
        loop {
            if next >= MAX_SEARCH_FEED_PAGES {
                tracing::info!("WT Live search stopped at its page budget");
                truncated = true;
                break;
            }
            let (posts, raw_len) = self.feed_page(feed, next)?;
            next += 1;
            read += 1;
            if raw_len == 0 {
                end = true;
                break;
            }
            let before_page = items.len();
            for post in posts {
                let id = &post.skin.id;
                if !shown.contains(id) && !ids.contains(id) && !self.hidden.contains(id) && filter.matches(&post) {
                    ids.insert(id.clone());
                    items.push(post.skin);
                }
            }
            dry = if items.len() == before_page { dry + 1 } else { 0 };
            if items.len() >= RESULT_TARGET || (!items.is_empty() && read >= MAX_FEED_PAGES) {
                break;
            }
            if dry >= MAX_DRY_PAGES {
                tracing::info!(pages = dry, "WT Live search stopped: nothing matched for a while");
                truncated = true;
                break;
            }
        }
        Ok(PageRun { next, before, items, end, truncated })
    }

    /// Result page `page` of a search: built from where the page before it ended. Pages are
    /// asked in order (the grid loads them one after the other): a page further than the next
    /// one is `invalidInput`. A page past the end is empty, without a request.
    fn search_pages(&self, plan: &Plan, feed: &Feed, page: u32) -> AppResult<PageRun> {
        let key = format!("{}|{:?}", feed.key(), plan.filter);
        let page = page as usize;
        let mut known: Vec<PageMeta> = {
            let pages = self.pages.lock().unwrap_or_else(|e| e.into_inner());
            pages.get(&key).cloned().unwrap_or_default()
        };
        if let Some(last) = known.last().filter(|m| (m.end || m.truncated) && page >= known.len()) {
            return Ok(PageRun::empty_after(last));
        }
        if page > known.len() {
            return Err(AppError::new(ErrorCode::InvalidInput, PAGES_IN_ORDER).with_detail(page.to_string()));
        }
        let index = page;
        let result = {
            let (start, before) = match index {
                0 => (0, 0),
                i => (known[i - 1].next, known[i - 1].after()),
            };
            let shown: HashSet<String> = known[..index].iter().flat_map(|m| m.ids.iter().cloned()).collect();
            let run = self.run_page(feed, &plan.filter, start, before, &shown)?;
            // Pages after a rebuilt one started from its old end: they are built again when asked.
            known.truncate(index);
            known.push(PageMeta {
                next: run.next,
                before,
                ids: run.items.iter().map(|s| s.id.clone()).collect(),
                end: run.end,
                truncated: run.truncated,
            });
            run
        };
        let mut pages = self.pages.lock().unwrap_or_else(|e| e.into_inner());
        if pages.len() > 200 {
            pages.clear();
        }
        pages.insert(key, known);
        Ok(result)
    }

    /// Where a followed entry's new skins come from.
    fn follow_feed(&self, entry: &FollowEntry) -> AppResult<Option<Feed>> {
        Ok(match entry.kind {
            FollowKind::Vehicle => Some(Feed::Regular { sort: "created", tags: api::vehicle_tags(&entry.id) }),
            FollowKind::Author => match entry.id.trim().parse::<u64>() {
                Ok(id) => Some(Feed::User { id, sort: "created" }),
                Err(_) => self.author_id(&entry.name)?.map(|id| Feed::User { id, sort: "created" }),
            },
        })
    }
}

/// Groups consecutive vehicles (index, tags) into chunks of at most `max` tags without splitting
/// a vehicle; a vehicle with more than `max` tags gets a chunk of its own, cut to `max`. A tag
/// two vehicles share is sent once. A vehicle without tags (a blank code) opens no chunk: it
/// rides along with the chunk of the vehicle before it (the first chunk, for those in front),
/// so the chunks' members cover the list from its start. No vehicle with tags: no chunk.
pub fn pack_tag_chunks(tags: &[Vec<String>], max: usize) -> Vec<(Vec<usize>, Vec<String>)> {
    let mut chunks: Vec<(Vec<usize>, Vec<String>)> = Vec::new();
    // Blanks in front of the first vehicle with tags, held until its chunk opens.
    let mut leading: Vec<usize> = Vec::new();
    for (i, own) in tags.iter().enumerate() {
        if own.is_empty() {
            match chunks.last_mut() {
                Some((members, _)) => members.push(i),
                None => leading.push(i),
            }
            continue;
        }
        let fits = chunks.last().is_some_and(|(_, t)| t.len() + own.len() <= max);
        if !fits {
            chunks.push((std::mem::take(&mut leading), Vec::new()));
        }
        let (members, all) = chunks.last_mut().expect("pushed above");
        members.push(i);
        for tag in own {
            if all.len() >= max {
                break;
            }
            if !all.contains(tag) {
                all.push(tag.clone());
            }
        }
    }
    chunks
}

/// Entries in a feed answer's `data.list` (installable or not).
fn raw_list_len(bytes: &[u8]) -> usize {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("data").and_then(|d| d.get("list")).and_then(|l| l.as_array()).map(Vec::len))
        .unwrap_or(0)
}

/// A WT Live post id: the digits of its `lang_group`.
fn post_id(id: &str) -> AppResult<&str> {
    let id = id.trim();
    if id.is_empty() || id.len() > 18 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::new(ErrorCode::NotFound, POST_GONE).with_detail(id.to_owned()));
    }
    Ok(id)
}

impl WtLiveClient for LiveClient {
    fn ready(&self) -> AppResult<()> {
        self.check_enabled()
    }

    fn search(&self, params: &SearchParams) -> AppResult<SearchResult> {
        self.check_enabled()?;
        let started = Instant::now();
        let plan = self.plan(params)?;
        let Some(feed) = &plan.feed else {
            return Ok(SearchResult {
                items: Vec::new(),
                total: 0,
                took_ms: elapsed_ms(started),
                has_more: false,
                total_exact: true,
            });
        };
        let mut run = self.search_pages(&plan, feed, params.page)?;
        if plan.by_name {
            run.items.sort_by_key(|s| s.name.to_lowercase());
        }
        Ok(SearchResult {
            total: run.before + run.items.len() as u64,
            items: run.items,
            took_ms: elapsed_ms(started),
            has_more: !run.end && !run.truncated,
            total_exact: run.end && !run.truncated,
        })
    }

    fn post(&self, id: &str) -> AppResult<WtLiveSkin> {
        self.check_enabled()?;
        let id = post_id(id)?;
        let form = vec![("lang_group", id.to_owned()), ("language", "en".to_owned())];
        let bytes = self.fetch(
            &format!("post|{id}"),
            POST_TTL,
            || self.transport.post_form(POST_PATH, &form),
            |b| matches!(api::parse_post(b), Ok(Some(_))),
        )?;
        let post = api::parse_post(&bytes)?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, POST_GONE).with_detail(id.to_owned()))?;
        self.remember_authors(std::slice::from_ref(&post));
        Ok(post.skin)
    }

    fn following_new(&self, follows: &[FollowEntry]) -> AppResult<Vec<WtLiveSkin>> {
        self.check_enabled()?;
        let mut found: Vec<Post> = Vec::new();
        for entry in follows.iter().take(MAX_FOLLOWS_CHECKED) {
            let Some(since) = time::parse_rfc3339(&entry.last_seen_at) else { continue };
            let Some(feed) = self.follow_feed(entry)? else { continue };
            let (posts, _) = self.feed_page(&feed, 0)?;
            for post in posts {
                if post.created > since
                    && !self.hidden.contains(&post.skin.id)
                    && !found.iter().any(|p| p.skin.id == post.skin.id)
                {
                    found.push(post);
                }
            }
        }
        found.sort_by_key(|p| std::cmp::Reverse(p.created));
        Ok(found.into_iter().map(|p| WtLiveSkin { is_new: Some(true), ..p.skin }).collect())
    }

    fn vehicle_top(&self, code: &str) -> AppResult<Vec<WtLiveSkin>> {
        self.check_enabled()?;
        let code = code.trim();
        let tags = if code.is_empty() { Vec::new() } else { api::vehicle_tags(code) };
        if tags.is_empty() {
            // Nothing to search with ("", "a", "#"): without tags the feed is the global one.
            return Ok(Vec::new());
        }
        let feed = Feed::Regular { sort: "downloads", tags };
        let (posts, _) = self.feed_page_within(&feed, 0, TOP_TTL)?;
        Ok(posts
            .into_iter()
            .filter(|p| api::is_for_vehicle(p, code) && !self.hidden.contains(&p.skin.id))
            .take(VEHICLE_TOP)
            .map(|p| p.skin)
            .collect())
    }

    fn for_you_new(&self, vehicles: &[String], since: i64) -> AppResult<ForYouNew> {
        self.check_enabled()?;
        let tags: Vec<Vec<String>> =
            vehicles.iter().map(|v| if v.trim().is_empty() { Vec::new() } else { api::vehicle_tags(v) }).collect();
        let chunks = pack_tag_chunks(&tags, MAX_TAGS_PER_REQUEST);
        if chunks.is_empty() {
            // Nothing that can match anything (an empty list, or blanks only): nothing to ask.
            return Ok(ForYouNew { items: Vec::new(), checked: count_u32(vehicles.len()) });
        }
        let mut found: Vec<(i64, ForYouSkin)> = Vec::new();
        let mut checked = 0usize;
        for (n, (members, chunk_tags)) in chunks.into_iter().enumerate() {
            if n == MAX_FOR_YOU_REQUESTS {
                break;
            }
            let feed = Feed::Regular { sort: "created", tags: chunk_tags };
            let posts = match self.feed_page(&feed, 0) {
                Ok((posts, _)) => posts,
                Err(e) if n == 0 => return Err(e),
                // A partial answer is a success on purpose (online): `checked` stops before this
                // chunk, so the UI shows the rest as not checked rather than as nothing new.
                Err(e) => {
                    tracing::warn!(code = ?e.code, "For you: a later request failed, keeping what was found");
                    break;
                }
            };
            for post in posts {
                if post.created <= since
                    || self.hidden.contains(&post.skin.id)
                    || found.iter().any(|(_, f)| f.skin.id == post.skin.id)
                {
                    continue;
                }
                let matched =
                    members.iter().find(|&&i| !tags[i].is_empty() && api::is_for_vehicle(&post, &vehicles[i]));
                if let Some(&i) = matched {
                    let skin = WtLiveSkin { is_new: Some(true), ..post.skin };
                    found.push((post.created, ForYouSkin { vehicle: vehicles[i].trim().to_owned(), skin }));
                }
            }
            checked += members.len();
        }
        found.sort_by_key(|(created, _)| std::cmp::Reverse(*created));
        Ok(ForYouNew { items: found.into_iter().map(|(_, s)| s).collect(), checked: count_u32(checked) })
    }

    fn archive(&self, id: &str, progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf> {
        self.check_enabled()?;
        let id = post_id(id)?.to_owned();
        let _one_at_a_time = self.downloading.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(path) = self.cache.fresh_archive(&id) {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            progress(DownloadProgress { received: size, total: Some(size) });
            return Ok(path);
        }
        let skin = self.post(&id)?;
        let max = match skin.size_bytes {
            0 => MAX_ARCHIVE_BYTES,
            size => size.saturating_add(size / 10).saturating_add(1024 * 1024).min(MAX_ARCHIVE_BYTES),
        };
        let save = |e: std::io::Error| {
            AppError::new(ErrorCode::Io, "Could not save the skin's archive").with_detail(e.to_string())
        };
        let dir = self.cache.archives_dir().map_err(save)?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or_default();
        let part = dir.join(format!("{id}{PART_MARK}{nanos}"));
        let result = (|| -> AppResult<PathBuf> {
            let file = std::fs::File::create(&part).map_err(save)?;
            let mut out = BufWriter::new(file);
            self.transport.download(&skin.download_url, max, &mut out, &mut |received, total| {
                progress(DownloadProgress { received, total })
            })?;
            let file = out.into_inner().map_err(|e| save(e.into_error()))?;
            file.sync_all().map_err(save)?;
            drop(file);
            let ext = match sniff(&part).map_err(save)? {
                Some(ArchiveKind::Zip) => "zip",
                Some(ArchiveKind::SevenZ) => "7z",
                Some(ArchiveKind::Rar) => "rar",
                None => return Err(AppError::new(ErrorCode::InvalidInput, POST_NOT_AN_ARCHIVE).with_detail(id.clone())),
            };
            let path = dir.join(format!("{id}.{ext}"));
            std::fs::rename(&part, &path).map_err(save)?;
            Ok(path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        let path = result?;
        tracing::info!(post = %id, "WT Live archive downloaded");
        Ok(path)
    }
}

fn count_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
