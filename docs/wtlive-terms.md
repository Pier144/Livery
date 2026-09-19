# WT Live: what the terms say, and how Livery behaves

Checked on **2026-09-19** against the live pages, by four readers plus a skeptic who re-opened
every source. **This is not legal advice**: it is what the documents say, with the quotes and the
URLs, so the decision can be made with the texts in view. Re-check before the first public
release, and whenever Gaijin updates its terms.

## 1. Machine-readable rules: none

| Check | Result |
|---|---|
| `https://live.warthunder.com/robots.txt` | **404** (verified twice, two clients) |
| `https://cdn-live.warthunder.com/robots.txt` | 404 |
| `https://live.warthunder.com/sitemap.xml` | 404 |
| `<meta name="robots">` on listing and post pages | absent (only charset, Content-Language, content-type, Open Graph) |
| `X-Robots-Tag` header | absent on every response observed, including the `/dl/` redirect |
| `Crawl-delay` | declared nowhere |
| `https://warthunder.com/robots.txt` | exists, but it is **another origin** and its 20 sitemaps contain zero `live.warthunder.com` URLs |

RFC 9309 §2.3.1.3: *"If a server status code indicates that the robots.txt file is unavailable to
the crawler, then the crawler MAY access any resources on the server."* §2.3.1.4 says the
opposite for network or 5xx errors: *"the crawler MUST assume complete disallow"* — our client
must tell the two cases apart. §2.4: a cached robots.txt should not be used for more than 24 h.

## 2. Downloading a skin is expressly licensed

Contribution Agreement §2.2 (last updated 2025-06-02, <https://legal.gaijin.net/en/contribution>):

> You grant all Users of the Game(s) a non-exclusive, worldwide, free, perpetual license to
> reproduce the User-Generated Content on their devices and use it in connection with the
> Game(s). You agree not to charge any fees or require any payment (voluntary or mandatory) from
> other Users of the Game(s) or using the User-Generated Content in a paid context.

§1.6 names `live.warthunder.com` in the definition of User-Generated Content. So downloading an
archive and installing it into the user's `UserSkins` is authorised **by the skin's author**, and
the official wiki describes that same flow. It also means Livery must stay free: charging other
players for this content, or putting it in a paid context, is what §2.2 forbids.

## 3. The only explicit anti-crawler ban is the Marketplace

Trade Policy §7.1: *"By using or accessing the Gaijin Marketplace, the User agrees not to engage
in or promote any of the following actions: […] Use automated tools such as robots, crawlers,
bots, scrapers, or any other means to access, collect data, or gather content for any purpose"*.
The scope is in the sentence itself. **Livery must never touch `market.gaijin.net`
automatically**, not even for an image.

## 4. In the Terms of Service, "scrape" appears once, about AI

§4.3.5 forbids to *"use, access, copy, scrape, extract, collect, reproduce, process, analyze…"*
but only *"for training, developing, testing, improving, fine-tuning, validating or operating any
artificial intelligence, machine learning…"*. Counted in the current text (last updated
2026-08-17): `scrape` 1, `crawl` 0, `robot` 0. The archived 2025-06-02 version has zero
occurrences of `scrape`, `database creation` and `artificial intelligence`: that clause is new,
and Gaijin chose to bind it to AI.

## 5. The broad clauses that could still cover it

Terms of Service (2026-08-17), which apply to WT Live because §1.1 defines *"Website(s)"* as
including subdomains:

- §4.3.1 — *"use any part of the Service(s) for anything other than its intended purpose"*.
  "Intended purpose" is never defined (one occurrence in the whole document).
- §4.3.2 — *"copy, distribute, resell, rent, lease, reproduce, modify, adapt, sublicense,
  publicly display…"*, with no personal-use or caching exception for the Website(s).
- §8.1.3 — *"collecting information through the Service(s) not explicitly permitted under the
  Terms and Conditions"*, with §8.2 (*"This list is non-exhaustive"*) and §8.3 (*"at its sole
  discretion"*).

The bot and third-party-tool clauses live in the EULA and are anchored to **the Game**: §3.2.3
(*"automate gameplay"*), §3.2.8 (connections *"to the Game(s)"*), §3.2.9 (data *"from the
Game(s)"* not meant to be public). WT Live's own community guidelines and rules page say nothing
about automation: zero occurrences of scrape, crawl, robot, automat, bot, API.

**Verdict: a grey area.** The download is expressly licensed; reading the pages to list skins is
forbidden by no text and permitted by no text, and the broad clauses above are discretionary.

## 6. What the site actually serves

WT Live pages are JavaScript shells: the camouflages listing is ~24 KB and contains no posts, and
a post page carries only Open Graph tags. The content comes from the site's own JSON endpoints
(`POST /api/feed/get_regular/`, `/api/posts/get/`, …), which answer anonymously. So
"fetch the page and parse the HTML", as `design_handoff_livery/DATA_MODEL.md` assumes, returns no
skins today. Notes for whoever implements it:

- `/api/posts/get/` answers with a bare JSON object, not the feed's `{status, data}` envelope.
- `/api/posts/get_post/` and `/api/feed/get_unlogged/` are 404 today although the site's JS still
  names them: **the endpoints rotate without deprecation**, so parsing goes behind a trait and a
  failure degrades to the offline state.
- The portal's search works by **hashtag**: free text returns nothing, `#tiger` returns results.
- `/dl/<hash>/` answers 302 to `cdn-live.warthunder.com`, with no authentication and no visible
  expiring token.

## 7. How Livery behaves (the posture we chose)

1. Use the JSON endpoints rather than a headless browser: one ~50 KB call instead of a full page
   render plus its assets — the lightest option for Gaijin's servers.
2. One honest, stable user agent with the app name, its version and the repository URL. Never
   pretend to be a browser.
3. At most 1 request per second, exponential backoff on 429 and 5xx, and a clean stop after
   repeated failures. No rate limit is published, and Cloudflare sits in front.
4. **Only on the user's action.** No prefetch, no background polling, no sync at startup.
5. A 24 h local cache with a visible way to clear it (`Cache-Control: no-cache, private` means
   there is nothing to revalidate against). It must not become a permanent archive.
6. Re-read `live.warthunder.com/robots.txt` at most every 24 h and obey it if it ever appears —
   4xx means no restriction, 5xx or a network error means stop (RFC 9309 §2.3.1.4).
7. Author name and a link to the original post on every skin: §4.4 says Gaijin claims no
   ownership of user content, so the rights are the author's and attribution is not a courtesy.
8. A switch that turns WT Live browsing off, and a way to hide or remove a single entry, for the
   day the terms change or an author asks.
9. Never any automated request to `market.gaijin.net`.
10. The app stays free, with no paid tier for WT Live content (§2.2 above).
11. Naming: "Livery" is fine. "War Thunder" as a name, logo, icon, repository or domain is not
    (Content Creators policy §1.1.7, *"whether for profit or not"*); a functional description is.

## 8. Left to the author

- Accepting the discretionary risk of §4.3.1 / §4.3.2 / §8.1.3, which no reading of the documents
  can remove.
- Whether to ask Gaijin before the public release (`legal@gaijin.net` for UGC questions). It
  removes the ambiguity, but an explicit question can produce an explicit "no" where there is
  silence today.
- Any future monetisation, which must be weighed against Contribution Agreement §2.2.
