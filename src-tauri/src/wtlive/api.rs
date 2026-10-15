//! WT Live's JSON, read the way the site's own pages read it.
//!
//! - `POST /api/feed/get_regular/` (`content=camouflage`, `sort`, `page`, `searchString`) and
//!   `POST /api/feed/get_user/` (`user=<id>`) answer `{ status: "OK", data: { list: [post…] } }`,
//!   25 posts a page, with no total. An empty list is the end.
//! - `POST /api/posts/get/` (`lang_group=<id>`) answers the post itself, bare, or
//!   `{ status: "ERR" }` for a post that doesn't exist.
//! - `GET /api/user/get_possible/?nick=…` answers `{ status, data?: [{ id, nick, posts… }] }`.
//!
//! A post carries no vehicle and no category: both are guessed from its hashtags
//! ([`infer_vehicle`], [`infer_category`]) against the local vehicle catalog. Anything that
//! doesn't parse is `network` (WT Live changed its answers, so it counts as unreachable); one
//! post that doesn't parse is left out, not the whole page.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::{time, vehicles};
use crate::model::{Author, Category, Nation, PostDescription, Vehicle, VehicleType, WtLiveSkin};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, UNIX_EPOCH};

pub const SITE: &str = "https://live.warthunder.com";
pub const SITE_HOST: &str = "live.warthunder.com";
pub const CDN_HOST: &str = "cdn-live.warthunder.com";

/// Posts per feed page (WT Live's own page size; it can't be asked for more).
pub const FEED_PAGE_SIZE: usize = 25;

/// `network` message when WT Live answers something Livery can't read.
pub const UNREADABLE_ANSWER: &str = "WT Live answered in a way Livery can't read";

/// `network` message when WT Live answers `{ status: "ERR" }` to a listing.
pub const ERROR_ANSWER: &str = "WT Live answered with an error";

/// Longest skin name taken from a post's description.
const MAX_NAME_CHARS: usize = 80;

/// One post, mapped, with what local filters need.
#[derive(Debug, Clone, PartialEq)]
pub struct Post {
    pub skin: WtLiveSkin,
    /// Hashtags, lower-cased, in the order they appear.
    pub tags: Vec<String>,
    /// Unix seconds.
    pub created: i64,
    /// Nation when the catalog or a hashtag says it, else `None` (matches no nation filter).
    pub nation: Option<Nation>,
    /// Type when the catalog or a hashtag says it, else `None` (matches no type filter).
    pub vehicle_type: Option<VehicleType>,
}

/// An author `get_possible` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundUser {
    pub id: u64,
    pub nick: String,
    pub posts: u32,
}

#[derive(Deserialize)]
struct RawPost {
    lang_group: u64,
    #[serde(default)]
    language: Option<String>,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    created: i64,
    author: RawAuthor,
    #[serde(default)]
    likes: i64,
    #[serde(default)]
    downloads: i64,
    #[serde(default)]
    description: String,
    #[serde(default)]
    images: Vec<RawImage>,
    #[serde(default)]
    file: Option<RawFile>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    hidden: Option<bool>,
}

#[derive(Deserialize)]
struct RawAuthor {
    id: u64,
    nickname: String,
}

#[derive(Deserialize)]
struct RawImage {
    /// Feed: the small (`_lq`) picture.
    #[serde(default)]
    src: Option<String>,
    /// Post: the medium picture.
    #[serde(default)]
    mq: Option<RawImageSize>,
    #[serde(default)]
    orig: Option<RawImageSize>,
}

#[derive(Deserialize)]
struct RawImageSize {
    src: String,
}

#[derive(Deserialize)]
struct RawFile {
    #[serde(default)]
    name: String,
    link: String,
    #[serde(default)]
    size: u64,
}

fn unreadable(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Network, UNREADABLE_ANSWER).with_detail(detail.into())
}

fn json(bytes: &[u8]) -> AppResult<Value> {
    serde_json::from_slice(bytes).map_err(|e| unreadable(e.to_string()))
}

/// A feed page. `{ status: "ERR" }` is `network` ([`ERROR_ANSWER`]); posts that aren't
/// installable camouflages (no archive, hidden, another type) are left out.
pub fn parse_feed(bytes: &[u8]) -> AppResult<Vec<Post>> {
    let value = json(bytes)?;
    match value.get("status").and_then(Value::as_str) {
        Some("OK") => {}
        Some(_) => {
            let msg = value.get("msg").and_then(Value::as_str).unwrap_or_default();
            return Err(AppError::new(ErrorCode::Network, ERROR_ANSWER).with_detail(msg.to_owned()));
        }
        None => return Err(unreadable("feed answer without a status")),
    }
    // `data.list` is missing on an empty page now and then.
    let list = match value.get("data").and_then(|d| d.get("list")) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err(unreadable("feed list isn't a list")),
    };
    Ok(list.iter().filter_map(|item| from_value(item, false)).collect())
}

/// A post, or `None` when WT Live doesn't have it (`{ status: "ERR" }`) or it isn't an
/// installable camouflage.
pub fn parse_post(bytes: &[u8]) -> AppResult<Option<Post>> {
    let value = json(bytes)?;
    if value.get("status").and_then(Value::as_str) == Some("ERR") {
        return Ok(None);
    }
    if value.get("lang_group").is_none() {
        return Err(unreadable("post answer without lang_group"));
    }
    Ok(from_value(&value, true))
}

/// `get_possible`: the authors whose nickname starts with what was asked. No `data` → none.
pub fn parse_possible_users(bytes: &[u8]) -> AppResult<Vec<FoundUser>> {
    let value = json(bytes)?;
    if value.get("status").and_then(Value::as_str) != Some("OK") {
        return Err(AppError::new(ErrorCode::Network, ERROR_ANSWER));
    }
    let Some(Value::Array(list)) = value.get("data") else { return Ok(Vec::new()) };
    Ok(list
        .iter()
        .filter_map(|u| {
            let id = u.get("id")?.as_u64()?;
            let nick = u.get("nick")?.as_str()?.trim().to_owned();
            let posts = u.get("posts").and_then(Value::as_u64).unwrap_or(0);
            (!nick.is_empty()).then(|| FoundUser { id, nick, posts: u32::try_from(posts).unwrap_or(u32::MAX) })
        })
        .collect())
}

fn from_value(value: &Value, detail: bool) -> Option<Post> {
    match RawPost::deserialize(value) {
        Ok(raw) => to_post(raw, detail),
        Err(e) => {
            tracing::debug!(error = %e, "WT Live post left out: it doesn't parse");
            None
        }
    }
}

fn to_post(raw: RawPost, detail: bool) -> Option<Post> {
    if raw.kind != "camouflage" || raw.visible == Some(false) || raw.hidden == Some(true) {
        return None;
    }
    let file = raw.file?;
    let download_url = download_link(&file.link)?;
    let id = raw.lang_group.to_string();
    let author_name = raw.author.nickname.trim().to_owned();
    if author_name.is_empty() {
        return None;
    }
    let tags = hashtags(&raw.description);
    let name = skin_name(&raw.description, &file.name, &author_name);
    let guess = infer_vehicle(&tags, &name);
    let language = raw.language.filter(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphabetic()));
    let images = raw
        .images
        .iter()
        .filter_map(|image| {
            let wanted = if detail {
                image.mq.as_ref().map(|s| s.src.as_str()).or(image.src.as_deref())
            } else {
                image.src.as_deref().or(image.mq.as_ref().map(|s| s.src.as_str()))
            };
            wanted.or(image.orig.as_ref().map(|s| s.src.as_str())).and_then(cdn_url)
        })
        .collect();
    let created = raw.created.max(0);
    let skin = WtLiveSkin {
        name,
        vehicle: guess.vehicle,
        author: Author {
            id: raw.author.id.to_string(),
            name: author_name,
            url: format!("{SITE}/user/{}/", raw.author.id),
            skin_count: None,
        },
        category: infer_category(&tags),
        downloads: u64::try_from(raw.downloads).unwrap_or(0),
        likes: u64::try_from(raw.likes).unwrap_or(0),
        posted_at: time::rfc3339_utc(UNIX_EPOCH + Duration::from_secs(created.unsigned_abs())),
        size_bytes: file.size,
        images,
        post_url: format!("{SITE}/post/{id}/{}/", language.as_deref().unwrap_or("en")),
        download_url,
        files: None,
        is_new: None,
        description: detail.then(|| post_description(&raw.description, &tags)).flatten(),
        id,
    };
    Some(Post { skin, tags, created, nation: guess.nation, vehicle_type: guess.vehicle_type })
}

/// The post page's description with its hashtags; `None` when it has neither text, pictures nor tags.
fn post_description(html: &str, tags: &[String]) -> Option<PostDescription> {
    let mut description = super::text::post_description(html).unwrap_or_default();
    description.tags = tags.to_vec();
    (!description.paragraphs.is_empty() || !description.images.is_empty() || !description.tags.is_empty())
        .then_some(description)
}

/// `https://live.warthunder.com/dl/<hash>/`, the only download link Livery follows (it redirects
/// to the CDN). Anything else → `None`.
pub fn download_link(link: &str) -> Option<String> {
    let link = link.trim();
    let link = link.strip_prefix("//").map(|rest| format!("https://{rest}")).unwrap_or_else(|| link.to_owned());
    let rest = link.strip_prefix(&format!("{SITE}/dl/"))?;
    let hash = rest.strip_suffix('/').unwrap_or(rest);
    (!hash.is_empty() && hash.len() <= 128 && hash.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(link)
}

/// An image on WT Live's CDN, as `https://`; anything else (another host, plain http) → `None`.
pub fn cdn_url(src: &str) -> Option<String> {
    let src = src.trim();
    let url = match src.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => src.to_owned(),
    };
    let rest = url.strip_prefix("https://")?;
    let host = rest.split('/').next()?;
    (host == CDN_HOST && !url.contains(['"', '\'', '<', '>', ' ', '\\'])).then_some(url)
}

// ── Description text ────────────────────────────────────────────────────────

/// Hashtags of a description, lower-cased, deduplicated, in order: the `?q=%23tag` links the
/// site writes for each one.
pub fn hashtags(description: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for piece in description.split("?q=%23").skip(1) {
        let end = piece.find(['"', '&', '\'', ' ', '<']).unwrap_or(piece.len());
        let tag = percent_decode(&piece[..end]).to_lowercase();
        let tag = tag.trim().trim_start_matches('#').to_owned();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%' && i + 3 <= bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match (escaped, bytes[i]) {
            (Some(b), _) => {
                out.push(b);
                i += 3;
            }
            (None, b'+') => {
                out.push(b' ');
                i += 1;
            }
            (None, b) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Plain text of an HTML fragment: tags dropped (block tags and `<br>` leave a space, inline
/// ones like `<a>` or `<b>` nothing), the usual entities decoded.
pub fn html_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut tag: Option<String> = None;
    for c in html.chars() {
        match (&mut tag, c) {
            (None, '<') => tag = Some(String::new()),
            (Some(name), '>') => {
                let name = name.trim_start_matches('/').split([' ', '/']).next().unwrap_or("").to_ascii_lowercase();
                if matches!(name.as_str(), "p" | "br" | "div" | "li" | "ul" | "ol" | "h1" | "h2" | "h3" | "tr" | "td") {
                    text.push(' ');
                }
                tag = None;
            }
            (Some(name), c) => name.push(c),
            (None, c) => text.push(c),
        }
    }
    decode_entities(&text)
}

pub(crate) fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A post has no title: the first line of its description that isn't only hashtags, else the
/// archive's name, else "Camouflage by <author>".
pub fn skin_name(description: &str, file_name: &str, author: &str) -> String {
    let lines = description.split("</p>").flat_map(|p| p.split("<br"));
    for line in lines {
        let text = html_text(line);
        let words: Vec<&str> = text.split_whitespace().collect();
        // A line of hashtags only isn't a title; a title keeps the hashtags it contains.
        let plain: String = words.iter().filter(|w| !w.starts_with('#')).copied().collect();
        if plain.chars().filter(|c| c.is_alphanumeric()).count() >= 2 {
            let line = words.join(" ");
            return truncate(
                line.trim_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '-' | '|' | '/' | '>')),
            );
        }
    }
    let stem = file_name.rsplit_once('.').map_or(file_name, |(stem, _)| stem);
    let stem = stem.replace('_', " ");
    let stem = stem.split_whitespace().collect::<Vec<_>>().join(" ");
    if stem.chars().any(char::is_alphanumeric) {
        return truncate(&stem);
    }
    format!("Camouflage by {author}")
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX_NAME_CHARS {
        return s.to_owned();
    }
    let cut: String = s.chars().take(MAX_NAME_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

// ── What the hashtags say ───────────────────────────────────────────────────

/// Category from the hashtags: semi-historical, fictional, historical, camouflage, else other.
pub fn infer_category(tags: &[String]) -> Category {
    let has = |words: &[&str]| tags.iter().any(|t| words.contains(&squash(t).as_str()));
    if has(&["semihistorical", "semihistoric", "semihist"]) {
        Category::SemiHistorical
    } else if has(&["fictional", "fiction", "fantasy", "nonhistorical", "ahistorical", "unhistorical"]) {
        Category::Fictional
    } else if has(&["historical", "historic", "historicallyaccurate"]) {
        Category::Historical
    } else if has(&["camo", "camouflage", "camos", "camouflages"]) {
        Category::Camouflage
    } else {
        Category::Other
    }
}

/// What the hashtags say about the vehicle.
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleGuess {
    /// A catalog vehicle when a hashtag names one, else the unknown vehicle (empty code).
    pub vehicle: Vehicle,
    pub nation: Option<Nation>,
    pub vehicle_type: Option<VehicleType>,
}

const NATION_TAGS: [(&[&str], Nation); 10] = [
    (&["germany", "german", "germ", "ger", "wehrmacht", "luftwaffe", "bundeswehr"], Nation::Ger),
    (&["usa", "us", "american", "america", "usaf", "usmc", "usarmy"], Nation::Usa),
    (&["ussr", "soviet", "sovietunion", "russia", "russian", "vvs"], Nation::Ussr),
    (&["uk", "britain", "british", "gbr", "raf", "greatbritain"], Nation::Gbr),
    (&["japan", "japanese", "jpn", "ijn", "ija", "jsdf"], Nation::Jpn),
    (&["china", "chinese", "chn", "pla", "plaaf", "roc"], Nation::Chn),
    (&["italy", "italian", "ita", "regiaaeronautica"], Nation::Ita),
    (&["france", "french", "fra", "armeedelair"], Nation::Fra),
    (&["sweden", "swedish", "swe", "flygvapnet"], Nation::Swe),
    (&["israel", "israeli", "isr", "iaf", "idf"], Nation::Isr),
];

const TYPE_TAGS: [(&[&str], VehicleType); 4] = [
    (&["heli", "helicopter", "helicopters", "chopper"], VehicleType::Heli),
    (
        &["ship", "ships", "naval", "navy", "boat", "boats", "destroyer", "cruiser", "battleship", "fleet"],
        VehicleType::Naval,
    ),
    (
        &["tank", "tanks", "ground", "groundforces", "armor", "armour", "mbt", "spaa", "spg", "tankdestroyer", "ifv"],
        VehicleType::Ground,
    ),
    (
        &["aircraft", "plane", "planes", "air", "jet", "jets", "fighter", "bomber", "airplane", "aviation"],
        VehicleType::Air,
    ),
];

/// The vehicle a post is for: the first hashtag that names a catalog vehicle (its code, its
/// code without the nation prefix, or its name, compared without `_ - .` and spaces), else
/// words of the title that are exactly a vehicle's name ([`title_vehicle`]), else the unknown
/// vehicle with the nation and type the hashtags give, if any. When a hashtag names several
/// vehicles, the one of the nation the other hashtags give wins.
pub fn infer_vehicle(tags: &[String], title: &str) -> VehicleGuess {
    let squashed: Vec<String> = tags.iter().map(|t| squash(t)).collect();
    let nation =
        NATION_TAGS.iter().find(|(words, _)| squashed.iter().any(|t| words.contains(&t.as_str()))).map(|&(_, n)| n);
    let found = squashed.iter().find_map(|t| vehicles::by_hashtag(t, nation)).or_else(|| title_vehicle(title, nation));
    if let Some(vehicle) = found {
        return VehicleGuess {
            nation: Some(vehicle.nation).filter(|n| *n != Nation::Unknown),
            vehicle_type: Some(vehicle.vehicle_type),
            vehicle,
        };
    }
    let vehicle_type = TYPE_TAGS
        .iter()
        .find(|&&(words, ty)| {
            squashed.iter().any(|t| {
                words.contains(&t.as_str()) || (ty == VehicleType::Ground && t.len() > 4 && t.ends_with("tank"))
            })
        })
        .map(|&(_, t)| t);
    let mut vehicle = vehicles::unknown();
    if let Some(n) = nation {
        vehicle.nation = n;
    }
    if let Some(t) = vehicle_type {
        vehicle.vehicle_type = t;
    }
    VehicleGuess { vehicle, nation, vehicle_type }
}

/// A vehicle named by consecutive words of a post's title (`Historic skin: Bf 109G-2/trop`,
/// `T-26 No.531`), longest run first. To keep common words from matching, a run of one word
/// counts only when it holds a digit (`T-26`, not `Tiger`), and every key has 4 characters or
/// more.
pub fn title_vehicle(title: &str, nation: Option<Nation>) -> Option<Vehicle> {
    let words: Vec<&str> = title
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    ',' | ';' | ':' | '|' | '"' | '\u{201c}' | '\u{201d}' | '[' | ']' | '(' | ')' | '!' | '?'
                )
        })
        // A word is letters or digits (a lone `-` or `/` isn't one, and can't join two runs).
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .take(40)
        .collect();
    for len in (1..=4usize).rev() {
        for window in words.windows(len) {
            let key = squash(&window.concat());
            if key.chars().count() < 4 || (len == 1 && !key.chars().any(|c| c.is_ascii_digit())) {
                continue;
            }
            if let Some(vehicle) = vehicles::by_name(&key, nation) {
                return Some(vehicle);
            }
        }
    }
    None
}

/// Lower case without `_ - .`, spaces and other punctuation: `T-34-85` → `t3485`.
pub fn squash(s: &str) -> String {
    vehicles::squash(s)
}

/// The hashtags WT Live is searched with for a vehicle code (OR-ed by the site): the code, the
/// code without its nation prefix, both squashed, and the catalog name squashed.
pub fn vehicle_tags(code: &str) -> Vec<String> {
    let lower = code.trim().to_lowercase().replace(['-', '.', ' '], "_");
    let mut tags = vec![lower.clone()];
    if let Some(rest) = vehicles::without_nation(&lower) {
        tags.push(rest.to_owned());
        tags.push(squash(rest));
    }
    tags.push(squash(&lower));
    if let Some(vehicle) = vehicles::lookup(code) {
        tags.push(squash(&vehicle.name));
    }
    let mut out: Vec<String> = Vec::new();
    for tag in tags.into_iter().map(|t| clean_tag(&t)).filter(|t| t.chars().count() >= 2) {
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

/// Whether a post is for the vehicle `code`: same vehicle, or one of its hashtags is one
/// [`vehicle_tags`] gives (compared squashed).
pub fn is_for_vehicle(post: &Post, code: &str) -> bool {
    if !post.skin.vehicle.code.is_empty() {
        return post.skin.vehicle.code.eq_ignore_ascii_case(code.trim());
    }
    let wanted: Vec<String> = vehicle_tags(code).iter().map(|t| squash(t)).collect();
    post.tags.iter().any(|t| wanted.contains(&squash(t)))
}

/// What a search box query asks WT Live for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextQuery {
    /// `@name`: that author's posts.
    Author(String),
    /// Hashtags (OR-ed by the site).
    Tags(Vec<String>),
}

/// `@name` → an author; `#a #b` → those hashtags; plain words → one hashtag joined with `_` and
/// one without (WT Live's search matches hashtags only, never free text). `None` when nothing
/// usable is left.
pub fn text_query(q: &str) -> Option<TextQuery> {
    let q = q.trim();
    if let Some(name) = q.strip_prefix('@') {
        let name = name.trim();
        return (!name.is_empty()).then(|| TextQuery::Author(name.to_owned()));
    }
    let tags: Vec<String> = if q.contains('#') {
        q.split_whitespace().filter_map(|w| w.strip_prefix('#')).map(clean_tag).collect()
    } else {
        let words: Vec<String> = q.split_whitespace().map(clean_tag).filter(|w| !w.is_empty()).collect();
        match words.len() {
            0 => Vec::new(),
            1 => words,
            _ => vec![words.join("_"), words.concat()],
        }
    };
    let mut out: Vec<String> = Vec::new();
    for tag in tags.into_iter().filter(|t| !t.is_empty()) {
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    (!out.is_empty()).then_some(TextQuery::Tags(out))
}

/// A hashtag as WT Live writes it: lower case, letters, digits and `_` only.
fn clean_tag(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric() || *c == '_').flat_map(char::to_lowercase).collect()
}

/// `searchString` for hashtags: `#a #b`.
pub fn search_string(tags: &[String]) -> String {
    tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ")
}
