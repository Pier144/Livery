//! Talking to WT Live over HTTPS, politely:
//!
//! - one honest user agent ([`user_agent`]): the app, its version and the repository;
//! - at most one request per second to WT Live, for the whole app ([`RateLimiter`]);
//! - `429` and `5xx` are retried after a pause that doubles (or what `Retry-After` asks), and the
//!   whole app waits that long; a `Retry-After` longer than [`MAX_BACKOFF`] stops every request
//!   for that long (in seconds; an HTTP date counts as absent); after [`BREAKER_AFTER`] calls in
//!   a row that couldn't reach WT Live (robots.txt included) Livery stops asking for
//!   [`BREAKER_PAUSE`] ([`Breaker`]);
//! - `robots.txt` is read before the first request and again after 24 h, and obeyed: a `4xx`
//!   means no rules, a `5xx` or a network error means stop (RFC 9309 §2.3.1.3–4, [`Robots`]);
//! - only `https://live.warthunder.com` and, for downloads, the redirect to
//!   `https://cdn-live.warthunder.com`: any other host (`market.gaijin.net` included) is never
//!   contacted, not even through a redirect.
//!
//! [`Transport`] is the seam: [`HttpTransport`] is the real one, tests serve fixtures.

use super::api::{CDN_HOST, SITE, SITE_HOST};
use crate::error::{AppError, AppResult, ErrorCode};
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Time between two requests to WT Live.
pub const REQUEST_INTERVAL: Duration = Duration::from_secs(1);
/// Attempts per request when WT Live answers `429` or `5xx`.
pub const MAX_ATTEMPTS: u32 = 3;
/// Longest pause between two attempts.
pub const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Failed calls in a row after which Livery stops asking.
pub const BREAKER_AFTER: u32 = 3;
/// How long Livery stops asking after [`BREAKER_AFTER`] failures.
pub const BREAKER_PAUSE: Duration = Duration::from_secs(120);
/// How long a `robots.txt` answer is trusted (RFC 9309 §2.4).
pub const ROBOTS_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
/// Timeout of an API call (connect to last byte).
pub const API_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout of a download (connect to last byte).
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Longest API answer read (a feed page is ~70 KB).
pub const MAX_API_BYTES: u64 = 8 * 1024 * 1024;

/// `network` message while Livery has stopped asking after repeated failures.
pub const PAUSED_MESSAGE: &str = "WT Live isn't answering; Livery will try again in a couple of minutes";
/// `network` message for a request that failed (DNS, timeout, refused, an HTTP error).
pub const UNREACHABLE_MESSAGE: &str = "WT Live can't be reached";
/// `unsupported` message when robots.txt asks tools not to read a page.
pub const ROBOTS_MESSAGE: &str = "WT Live's robots.txt asks tools like Livery not to read this page";
/// `network` message for a download larger than the post said or than Livery accepts.
pub const TOO_LARGE_MESSAGE: &str = "The skin's archive is larger than expected";

/// `Livery/<version> (+https://github.com/Pier144/Livery)`.
pub fn user_agent() -> String {
    format!("Livery/{} (+https://github.com/Pier144/Livery)", env!("CARGO_PKG_VERSION"))
}

/// The requests Livery makes to WT Live.
pub trait Transport: Send + Sync {
    /// `POST <SITE><path>` with a form body; the answer's bytes.
    fn post_form(&self, path: &str, form: &[(&str, String)]) -> AppResult<Vec<u8>>;
    /// `GET <SITE><path>?<query>`; the answer's bytes.
    fn get(&self, path: &str, query: &[(&str, String)]) -> AppResult<Vec<u8>>;
    /// Downloads `url` (a `/dl/` link, see `api::download_link`) into `out`, refusing more than
    /// `max_bytes`; `progress(received, total)` as bytes arrive. Returns the bytes written.
    fn download(
        &self,
        url: &str,
        max_bytes: u64,
        out: &mut dyn Write,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> AppResult<u64>;
}

// ── Politeness, as plain state machines (tested without a network) ──────────

/// One request per [`REQUEST_INTERVAL`] for the whole app: callers reserve the next free slot
/// and sleep until it.
#[derive(Debug)]
pub struct RateLimiter {
    interval: Duration,
    next: Mutex<Option<Instant>>,
}

impl RateLimiter {
    pub fn new(interval: Duration) -> Self {
        Self { interval, next: Mutex::new(None) }
    }

    /// Reserves the next slot at or after `now` and returns when it starts.
    pub fn reserve(&self, now: Instant) -> Instant {
        let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
        let start = next.map_or(now, |n| n.max(now));
        *next = Some(start + self.interval);
        start
    }

    /// No slot starts before `until` (WT Live asked to wait).
    pub fn defer(&self, until: Instant) {
        let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
        *next = Some(next.map_or(until, |n| n.max(until)));
    }

    /// Sleeps until this caller's slot.
    pub fn wait(&self) {
        let start = self.reserve(Instant::now());
        let now = Instant::now();
        if start > now {
            std::thread::sleep(start - now);
        }
    }
}

/// Pause before attempt `attempt + 1` (`attempt` counts from 0): what `Retry-After` asks, else
/// 2 s doubling, between 1 s and [`MAX_BACKOFF`].
pub fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let doubling = Duration::from_secs(2u64.saturating_pow(attempt.saturating_add(1)));
    retry_after.unwrap_or(doubling).clamp(Duration::from_secs(1), MAX_BACKOFF)
}

/// Whether an HTTP status is worth another attempt.
pub fn is_retryable(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

/// Stops calls for [`BREAKER_PAUSE`] after [`BREAKER_AFTER`] failed calls in a row.
#[derive(Debug, Default)]
pub struct Breaker {
    failures: u32,
    open_until: Option<Instant>,
}

impl Breaker {
    /// Whether a call may go out at `now`.
    pub fn allows(&mut self, now: Instant) -> bool {
        match self.open_until {
            Some(until) if now < until => false,
            Some(_) => {
                self.open_until = None;
                true
            }
            None => true,
        }
    }

    /// Stops calls for `pause` from `now` (a long `Retry-After`), or longer if already stopped.
    pub fn open_for(&mut self, pause: Duration, now: Instant) {
        let until = now + pause;
        self.open_until = Some(self.open_until.map_or(until, |u| u.max(until)));
    }

    pub fn record(&mut self, ok: bool, now: Instant) {
        if ok {
            self.failures = 0;
            return;
        }
        self.failures += 1;
        if self.failures >= BREAKER_AFTER {
            self.failures = 0;
            self.open_until = Some(now + BREAKER_PAUSE);
            tracing::warn!("WT Live failed {BREAKER_AFTER} times in a row; pausing requests");
        }
    }
}

/// What `robots.txt` says, for Livery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Robots {
    /// No rules (a `4xx`, or a file with no group for Livery or `*`).
    AllowAll,
    /// A `5xx` or a network error: assume complete disallow (RFC 9309 §2.3.1.4).
    Unreachable,
    /// The rules of the group that applies to Livery.
    Rules(Vec<Rule>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub allow: bool,
    pub pattern: String,
}

/// Product token Livery looks for in `User-agent:` lines.
pub const ROBOTS_TOKEN: &str = "livery";

impl Robots {
    /// From the answer to `GET /robots.txt`: `None` status = network error.
    pub fn from_answer(status: Option<u16>, body: &str) -> Self {
        match status {
            Some(200..=299) => Self::parse(body),
            // 429 says "slow down", not "no rules": treat it as unreachable.
            Some(429) | None => Self::Unreachable,
            Some(400..=499) => Self::AllowAll,
            Some(_) => Self::Unreachable,
        }
    }

    /// The group for [`ROBOTS_TOKEN`], else the `*` groups; their `Allow` / `Disallow` lines.
    pub fn parse(body: &str) -> Self {
        let mut mine: Vec<Rule> = Vec::new();
        let mut star: Vec<Rule> = Vec::new();
        let mut found_mine = false;
        let mut found_star = false;
        // Agents of the group being read, and whether its rules started (a new User-agent line
        // after rules starts a new group).
        let mut agents: Vec<String> = Vec::new();
        let mut in_rules = false;
        for line in body.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            let Some((key, value)) = line.split_once(':') else { continue };
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            match key.as_str() {
                "user-agent" => {
                    if in_rules {
                        agents.clear();
                        in_rules = false;
                    }
                    let agent = value.to_ascii_lowercase();
                    found_mine |= agent == ROBOTS_TOKEN;
                    found_star |= agent == "*";
                    agents.push(agent);
                }
                "allow" | "disallow" => {
                    in_rules = true;
                    if value.is_empty() {
                        continue;
                    }
                    let rule = Rule { allow: key == "allow", pattern: value.to_owned() };
                    if agents.iter().any(|a| a == ROBOTS_TOKEN) {
                        mine.push(rule.clone());
                    }
                    if agents.iter().any(|a| a == "*") {
                        star.push(rule);
                    }
                }
                _ => {}
            }
        }
        match (found_mine, found_star) {
            (true, _) => Self::Rules(mine),
            (false, true) => Self::Rules(star),
            _ => Self::AllowAll,
        }
    }

    /// Whether Livery may fetch `path` (with its query): the longest matching rule wins, `Allow`
    /// on a tie; no match → allowed.
    pub fn allows(&self, path: &str) -> bool {
        match self {
            Self::AllowAll => true,
            Self::Unreachable => false,
            Self::Rules(rules) => {
                let best = rules
                    .iter()
                    .filter(|r| pattern_matches(&r.pattern, path))
                    .max_by_key(|r| (r.pattern.len(), r.allow));
                best.map_or(true, |r| r.allow)
            }
        }
    }
}

/// RFC 9309 matching: `*` is any run of characters, a final `$` anchors the end; otherwise a
/// pattern matches every path it is a prefix of.
fn pattern_matches(pattern: &str, path: &str) -> bool {
    let (body, anchored) = match pattern.strip_suffix('$') {
        Some(body) => (body, true),
        None => (pattern, false),
    };
    let mut p: Vec<char> = body.chars().collect();
    if !anchored {
        p.push('*');
    }
    let s: Vec<char> = path.chars().collect();
    let (mut i, mut j) = (0, 0);
    let mut star: Option<usize> = None;
    let mut mark = 0;
    while i < s.len() {
        if j < p.len() && p[j] != '*' && p[j] == s[i] {
            i += 1;
            j += 1;
        } else if j < p.len() && p[j] == '*' {
            star = Some(j);
            mark = i;
            j += 1;
        } else if let Some(at) = star {
            j = at + 1;
            mark += 1;
            i = mark;
        } else {
            return false;
        }
    }
    while j < p.len() && p[j] == '*' {
        j += 1;
    }
    j == p.len()
}

/// `application/x-www-form-urlencoded` of `pairs` (also a query string).
pub fn form_encode(pairs: &[(&str, String)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", encode_component(k), encode_component(v))).collect::<Vec<_>>().join("&")
}

fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Whether a URL is one Livery may contact: `https` on WT Live or its CDN, default port.
pub fn is_allowed_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host_str(), Some(SITE_HOST) | Some(CDN_HOST))
}

// ── The real transport ──────────────────────────────────────────────────────

struct RobotsCheck {
    robots: Robots,
    at: Instant,
}

/// [`Transport`] over `reqwest` (blocking; called from blocking threads only).
pub struct HttpTransport {
    /// Built on first use, on a blocking thread (building or dropping a blocking client inside
    /// the async runtime panics).
    client: OnceLock<Result<reqwest::blocking::Client, String>>,
    limiter: RateLimiter,
    breaker: Mutex<Breaker>,
    robots: Mutex<Option<RobotsCheck>>,
}

impl Default for HttpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport {
    pub fn new() -> Self {
        Self {
            client: OnceLock::new(),
            limiter: RateLimiter::new(REQUEST_INTERVAL),
            breaker: Mutex::new(Breaker::default()),
            robots: Mutex::new(None),
        }
    }

    fn client(&self) -> AppResult<&reqwest::blocking::Client> {
        let built = self.client.get_or_init(|| {
            let policy = reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 3 {
                    attempt.error("too many redirects")
                } else if is_allowed_url(attempt.url()) {
                    attempt.follow()
                } else {
                    // Never follow WT Live anywhere else (the Marketplace above all).
                    let host = attempt.url().host_str().unwrap_or("?").to_owned();
                    attempt.error(format!("redirect to {host} refused"))
                }
            });
            reqwest::blocking::Client::builder()
                .user_agent(user_agent())
                .https_only(true)
                .redirect(policy)
                .connect_timeout(Duration::from_secs(10))
                .timeout(API_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        });
        built
            .as_ref()
            .map_err(|e| AppError::new(ErrorCode::Internal, "The HTTP client can't start").with_detail(e.clone()))
    }

    fn breaker(&self) -> std::sync::MutexGuard<'_, Breaker> {
        self.breaker.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs one call: the breaker, robots.txt, the rate limit and the retries.
    fn call(
        &self,
        path: &str,
        request: &dyn Fn(&reqwest::blocking::Client) -> reqwest::blocking::RequestBuilder,
    ) -> AppResult<reqwest::blocking::Response> {
        if !self.breaker().allows(Instant::now()) {
            return Err(AppError::new(ErrorCode::Network, PAUSED_MESSAGE));
        }
        let result = self.check_robots(path).and_then(|()| self.send_with_retries(request));
        // Only "can't be reached" counts: robots.txt saying no, or a long Retry-After that
        // already paused requests, isn't a failure to count again.
        let failed = result.as_ref().is_err_and(|e| e.code == ErrorCode::Network && e.message != PAUSED_MESSAGE);
        self.breaker().record(!failed, Instant::now());
        result
    }

    fn send_with_retries(
        &self,
        request: &dyn Fn(&reqwest::blocking::Client) -> reqwest::blocking::RequestBuilder,
    ) -> AppResult<reqwest::blocking::Response> {
        let client = self.client()?;
        let mut attempt = 0;
        loop {
            self.limiter.wait();
            let response = request(client)
                .send()
                .map_err(|e| AppError::new(ErrorCode::Network, UNREACHABLE_MESSAGE).with_detail(without_url(&e)))?;
            let status = response.status().as_u16();
            if response.status().is_success() {
                return Ok(response);
            }
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            if let Some(wait) = retry_after.filter(|w| *w > MAX_BACKOFF) {
                // A long Retry-After is obeyed by the whole app: nothing is sent until it's over.
                let now = Instant::now();
                self.limiter.defer(now + wait);
                self.breaker().open_for(wait, now);
                tracing::warn!(status, ?wait, "WT Live asked Livery to wait; requests paused");
                return Err(AppError::new(ErrorCode::Network, PAUSED_MESSAGE).with_detail(format!("HTTP {status}")));
            }
            if is_retryable(status) && attempt + 1 < MAX_ATTEMPTS {
                let pause = backoff(attempt, retry_after);
                tracing::info!(status, ?pause, "WT Live asked to slow down or failed; retrying");
                // Every other request waits too (the next slot is after the pause).
                self.limiter.defer(Instant::now() + pause);
                attempt += 1;
                continue;
            }
            return Err(AppError::new(ErrorCode::Network, UNREACHABLE_MESSAGE).with_detail(format!("HTTP {status}")));
        }
    }

    /// Reads robots.txt when it's unknown or older than a day, then checks `path`.
    fn check_robots(&self, path: &str) -> AppResult<()> {
        let mut cached = self.robots.lock().unwrap_or_else(|e| e.into_inner());
        let stale = cached.as_ref().map_or(true, |c| c.at.elapsed() > ROBOTS_MAX_AGE);
        if stale {
            let robots = self.fetch_robots();
            tracing::info!(?robots, "WT Live robots.txt read");
            *cached = Some(RobotsCheck { robots, at: Instant::now() });
        }
        let robots = &cached.as_ref().expect("robots.txt was just read").robots;
        match robots {
            Robots::Unreachable => {
                // Ask again next time rather than for a whole day.
                *cached = None;
                Err(AppError::new(ErrorCode::Network, UNREACHABLE_MESSAGE).with_detail("robots.txt can't be read"))
            }
            robots if !robots.allows(path) => {
                Err(AppError::new(ErrorCode::Unsupported, ROBOTS_MESSAGE).with_detail(path.to_owned()))
            }
            _ => Ok(()),
        }
    }

    fn fetch_robots(&self) -> Robots {
        let Ok(client) = self.client() else { return Robots::Unreachable };
        self.limiter.wait();
        match client.get(format!("{SITE}/robots.txt")).send() {
            Ok(response) => {
                let status = response.status().as_u16();
                let mut body = String::new();
                if response.status().is_success() {
                    let _ = response.take(512 * 1024).read_to_string(&mut body);
                }
                Robots::from_answer(Some(status), &body)
            }
            Err(e) => {
                tracing::info!(error = %without_url(&e), "robots.txt can't be read");
                Robots::from_answer(None, "")
            }
        }
    }
}

/// A reqwest error's text without the URL (it can carry a query).
fn without_url(e: &reqwest::Error) -> String {
    let mut text = e.to_string();
    if let Some(url) = e.url() {
        text = text.replace(url.as_str(), "<url>");
    }
    if e.is_timeout() {
        format!("timeout: {text}")
    } else {
        text
    }
}

/// Reads at most `max` bytes of `reader`; more is `network` ([`TOO_LARGE_MESSAGE`]).
fn read_capped(reader: impl Read, max: u64) -> AppResult<Vec<u8>> {
    let mut body = Vec::new();
    reader
        .take(max + 1)
        .read_to_end(&mut body)
        .map_err(|e| AppError::new(ErrorCode::Network, UNREACHABLE_MESSAGE).with_detail(e.to_string()))?;
    if body.len() as u64 > max {
        return Err(AppError::new(ErrorCode::Network, TOO_LARGE_MESSAGE).with_detail("API answer too large"));
    }
    Ok(body)
}

impl Transport for HttpTransport {
    fn post_form(&self, path: &str, form: &[(&str, String)]) -> AppResult<Vec<u8>> {
        let url = format!("{SITE}{path}");
        let body = form_encode(form);
        let response = self.call(path, &|client| {
            client
                .post(&url)
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded; charset=UTF-8")
                .header(reqwest::header::ACCEPT, "application/json")
                .body(body.clone())
        })?;
        read_capped(response, MAX_API_BYTES)
    }

    fn get(&self, path: &str, query: &[(&str, String)]) -> AppResult<Vec<u8>> {
        let url =
            if query.is_empty() { format!("{SITE}{path}") } else { format!("{SITE}{path}?{}", form_encode(query)) };
        let response =
            self.call(path, &|client| client.get(&url).header(reqwest::header::ACCEPT, "application/json"))?;
        read_capped(response, MAX_API_BYTES)
    }

    fn download(
        &self,
        url: &str,
        max_bytes: u64,
        out: &mut dyn Write,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> AppResult<u64> {
        let parsed = reqwest::Url::parse(url).map_err(|e| {
            AppError::new(ErrorCode::InvalidInput, "Not a WT Live download link").with_detail(e.to_string())
        })?;
        if !is_allowed_url(&parsed) || parsed.host_str() != Some(SITE_HOST) {
            return Err(AppError::new(ErrorCode::InvalidInput, "Not a WT Live download link"));
        }
        let path = parsed.path().to_owned();
        let mut response = self.call(&path, &|client| client.get(parsed.clone()).timeout(DOWNLOAD_TIMEOUT))?;
        if !is_allowed_url(response.url()) {
            return Err(AppError::new(ErrorCode::Network, UNREACHABLE_MESSAGE).with_detail("download left WT Live"));
        }
        let total = response.content_length();
        if total.is_some_and(|t| t > max_bytes) {
            return Err(AppError::new(ErrorCode::Network, TOO_LARGE_MESSAGE)
                .with_detail(format!("{} bytes, at most {max_bytes}", total.unwrap_or(0))));
        }
        let mut received: u64 = 0;
        let mut buffer = vec![0u8; 64 * 1024];
        progress(0, total);
        loop {
            let n = response
                .read(&mut buffer)
                .map_err(|e| AppError::new(ErrorCode::Network, UNREACHABLE_MESSAGE).with_detail(e.to_string()))?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > max_bytes {
                return Err(AppError::new(ErrorCode::Network, TOO_LARGE_MESSAGE)
                    .with_detail(format!("more than {max_bytes} bytes")));
            }
            out.write_all(&buffer[..n]).map_err(|e| {
                AppError::new(ErrorCode::Io, "Could not save the skin's archive").with_detail(e.to_string())
            })?;
            progress(received, total);
        }
        if total.is_some_and(|t| t != received) {
            return Err(AppError::new(ErrorCode::Network, UNREACHABLE_MESSAGE)
                .with_detail(format!("download cut short: {received} of {} bytes", total.unwrap_or(0))));
        }
        Ok(received)
    }
}
