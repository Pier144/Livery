//! The politeness rules of the WT Live transport, without a network: robots.txt, the rate
//! limit, backoff, the breaker, the hosts Livery talks to, and the user agent.

use livery_lib::wtlive::net::{
    backoff, form_encode, is_allowed_url, is_retryable, user_agent, Breaker, RateLimiter, Robots, BREAKER_AFTER,
    BREAKER_PAUSE, MAX_BACKOFF,
};
use std::time::{Duration, Instant};

#[test]
fn robots_answers_follow_rfc_9309() {
    assert_eq!(Robots::from_answer(Some(404), ""), Robots::AllowAll, "4xx: no rules");
    assert_eq!(Robots::from_answer(Some(403), ""), Robots::AllowAll);
    assert_eq!(Robots::from_answer(Some(429), ""), Robots::Unreachable, "slow down is not a green light");
    assert_eq!(Robots::from_answer(Some(503), ""), Robots::Unreachable, "5xx: complete disallow");
    assert_eq!(Robots::from_answer(None, ""), Robots::Unreachable, "network error: complete disallow");
    assert!(!Robots::Unreachable.allows("/api/feed/get_regular/"));
    assert!(Robots::AllowAll.allows("/api/feed/get_regular/"));
}

#[test]
fn robots_groups_and_longest_match() {
    let body = "\
# comment
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /api/
Allow: /api/feed/
Disallow: /dl/*.exe$
";
    let robots = Robots::from_answer(Some(200), body);
    assert!(!robots.allows("/api/posts/get/"));
    assert!(robots.allows("/api/feed/get_regular/"), "the longer Allow wins");
    assert!(robots.allows("/dl/abc/"));
    assert!(!robots.allows("/dl/x/setup.exe"));
    assert!(robots.allows("/dl/x/setup.exe.zip"), "$ anchors the end");
    assert!(robots.allows("/robots.txt"));

    // A group for Livery replaces the * group.
    let mine = "User-agent: *\nDisallow: /\n\nUser-agent: Livery\nDisallow: /api/posts/\n";
    let robots = Robots::parse(mine);
    assert!(robots.allows("/api/feed/get_regular/"));
    assert!(!robots.allows("/api/posts/get/"));

    // Several agents share one group; an empty Disallow allows everything.
    let shared = "User-agent: a\nUser-agent: *\nDisallow:\n";
    assert!(Robots::parse(shared).allows("/anything"));
    assert_eq!(Robots::parse("Sitemap: x\n"), Robots::AllowAll, "no group: no rules");
    // Equal length: Allow wins.
    let tie = "User-agent: *\nDisallow: /api\nAllow: /api\n";
    assert!(Robots::parse(tie).allows("/api/x"));
    // Disallow all.
    assert!(!Robots::parse("User-agent: *\nDisallow: /\n").allows("/api/feed/get_regular/"));
}

#[test]
fn one_request_per_second_for_the_whole_app() {
    let limiter = RateLimiter::new(Duration::from_secs(1));
    let t0 = Instant::now();
    assert_eq!(limiter.reserve(t0), t0, "the first goes at once");
    assert_eq!(limiter.reserve(t0), t0 + Duration::from_secs(1));
    assert_eq!(limiter.reserve(t0), t0 + Duration::from_secs(2), "slots queue up");
    let later = t0 + Duration::from_secs(10);
    assert_eq!(limiter.reserve(later), later, "an idle limiter doesn't make anyone wait");
    // WT Live asked to wait: nobody goes before then.
    let until = later + Duration::from_secs(90);
    limiter.defer(until);
    assert_eq!(limiter.reserve(later + Duration::from_secs(2)), until);
    limiter.defer(later);
    assert_eq!(limiter.reserve(later), until + Duration::from_secs(1), "deferring never brings slots closer");
}

#[test]
fn backoff_doubles_and_honours_retry_after() {
    assert_eq!(backoff(0, None), Duration::from_secs(2));
    assert_eq!(backoff(1, None), Duration::from_secs(4));
    assert_eq!(backoff(2, None), Duration::from_secs(8));
    assert_eq!(backoff(10, None), MAX_BACKOFF);
    assert_eq!(backoff(0, Some(Duration::from_secs(7))), Duration::from_secs(7));
    assert_eq!(backoff(0, Some(Duration::from_secs(3600))), MAX_BACKOFF, "capped");
    assert_eq!(backoff(0, Some(Duration::ZERO)), Duration::from_secs(1), "never hammers");
    assert!(is_retryable(429) && is_retryable(500) && is_retryable(503));
    assert!(!is_retryable(404) && !is_retryable(403) && !is_retryable(200));
}

#[test]
fn the_breaker_pauses_after_repeated_failures() {
    let mut breaker = Breaker::default();
    let t0 = Instant::now();
    for _ in 0..BREAKER_AFTER - 1 {
        breaker.record(false, t0);
        assert!(breaker.allows(t0));
    }
    breaker.record(true, t0);
    for _ in 0..BREAKER_AFTER - 1 {
        breaker.record(false, t0);
    }
    assert!(breaker.allows(t0), "a success resets the count");
    breaker.record(false, t0);
    assert!(!breaker.allows(t0 + Duration::from_secs(1)), "paused");
    assert!(breaker.allows(t0 + BREAKER_PAUSE + Duration::from_millis(1)), "and back after the pause");
    let mut asked = Breaker::default();
    asked.open_for(Duration::from_secs(600), t0);
    assert!(!asked.allows(t0 + Duration::from_secs(599)), "a long Retry-After stops every call");
    assert!(asked.allows(t0 + Duration::from_secs(601)));
}

#[test]
fn only_wt_live_hosts_over_https() {
    let ok = ["https://live.warthunder.com/dl/abc/", "https://cdn-live.warthunder.com/uploads/a/b.zip"];
    for url in ok {
        assert!(is_allowed_url(&reqwest::Url::parse(url).unwrap()), "{url}");
    }
    let refused = [
        "https://market.gaijin.net/",
        "http://live.warthunder.com/dl/abc/",
        "https://live.warthunder.com:8443/dl/abc/",
        "https://user:pw@live.warthunder.com/dl/abc/",
        "https://live.warthunder.com.evil.com/",
        "https://warthunder.com/",
    ];
    for url in refused {
        assert!(!is_allowed_url(&reqwest::Url::parse(url).unwrap()), "{url}");
    }
}

#[test]
fn forms_are_url_encoded() {
    let form = form_encode(&[("searchString", "#t_34 #танк".to_owned()), ("page", "0".to_owned())]);
    assert_eq!(form, "searchString=%23t_34+%23%D1%82%D0%B0%D0%BD%D0%BA&page=0");
    assert_eq!(form_encode(&[("a&b", "c=d".to_owned())]), "a%26b=c%3Dd");
}

#[test]
fn the_user_agent_is_honest() {
    let ua = user_agent();
    assert!(ua.starts_with(&format!("Livery/{} ", env!("CARGO_PKG_VERSION"))), "{ua}");
    assert!(ua.contains("https://github.com/Pier144/Livery"), "{ua}");
    assert!(!ua.contains("Mozilla"), "never pretends to be a browser");
}
