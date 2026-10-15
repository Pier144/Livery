//! A post's description, from WT Live's HTML to plain data the Skin detail can show.
//!
//! WT Live sends the author's text as a small HTML fragment: `<p>` paragraphs, `<br>` breaks,
//! `<b>`/`<i>`, hashtag links (`class="WTL-Embed-Hashtag"`), links to other sites through WT
//! Live's own `/away/` page (`WTL-Embed-ForeignLink`) and pictures embedded in the text
//! (`WTL-Embed-Image`, hosted on `images-live.warthunder.com`). The frontend never renders HTML
//! from WT Live: this module keeps only text runs, links that stay on WT Live (the `/away/` page
//! warns before leaving), and pictures on WT Live's own image hosts. Hashtags are taken out of the
//! text (the post already lists them as tags). Everything else (scripts, iframes, styles, other
//! attributes) is dropped.

use super::api::{cdn_url, decode_entities, SITE_HOST};
use crate::model::{PostDescription, PostRun};

/// Where the pictures embedded in a description live (besides the CDN of uploaded pictures).
pub const IMAGES_HOST: &str = "images-live.warthunder.com";

/// Longest text kept from one description (characters), so a huge post can't bloat the answer.
const MAX_TEXT_CHARS: usize = 12_000;
/// Most paragraphs and embedded pictures kept.
const MAX_PARAGRAPHS: usize = 200;
const MAX_IMAGES: usize = 40;

/// The description as paragraphs of runs, plus its embedded pictures (`tags` stays empty: the
/// caller has them). `None` when no text is left once hashtags and pictures are taken out and
/// there is no picture either.
pub fn post_description(html: &str) -> Option<PostDescription> {
    let mut b = Builder::default();
    let mut rest = html;
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            b.text(rest);
            break;
        };
        b.text(&rest[..lt]);
        rest = &rest[lt..];
        // A tag starts with a letter, `/` or `!`; any other `<` is text ("a < b").
        if !rest[1..].starts_with(|c: char| c.is_ascii_alphabetic() || c == '/' || c == '!') {
            b.text("<");
            rest = &rest[1..];
            continue;
        }
        // A `<` that never closes is text.
        let Some(gt) = rest.find('>') else {
            b.text(rest);
            break;
        };
        let tag = &rest[1..gt];
        rest = &rest[gt + 1..];
        // Raw-text elements: skip up to their end tag.
        let name = tag_name(tag);
        if !tag.starts_with('/')
            && matches!(name.as_str(), "script" | "style" | "iframe" | "noscript" | "template" | "svg")
        {
            let close = format!("</{name}");
            rest = match rest.to_ascii_lowercase().find(&close) {
                Some(at) => rest[at..].find('>').map_or("", |gt| &rest[at + gt + 1..]),
                None => "",
            };
            continue;
        }
        b.tag(tag, &name);
    }
    b.finish()
}

/// Lower-case element name of a tag's inside (`/p` → `p`, `br /` → `br`, `!-- x --` → `!--`).
fn tag_name(tag: &str) -> String {
    let tag = tag.trim_start_matches('/');
    tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_ascii_lowercase()
}

/// An attribute's value (entities decoded), quoted with `"` or `'` or bare.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(name) {
        let start = from + at;
        from = start + name.len();
        // Whole attribute names only (`src`, not `data-src`).
        let before = lower[..start].chars().next_back();
        if !before.is_some_and(char::is_whitespace) {
            continue;
        }
        let after = lower[from..].trim_start();
        let Some(value) = after.strip_prefix('=') else { continue };
        let offset = tag.len() - value.len();
        let raw = tag[offset..].trim_start();
        let value = match raw.chars().next() {
            Some(q @ ('"' | '\'')) => raw[1..].split(q).next().unwrap_or(""),
            _ => raw.split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or(""),
        };
        return Some(decode_entities(value));
    }
    None
}

/// `//host/…` → `https://host/…`.
fn absolute(url: &str) -> String {
    let url = url.trim();
    match url.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_owned(),
    }
}

/// A link Livery may open: an https page on WT Live itself (posts, authors, the `/away/` page in
/// front of other sites), with no credentials or port. Anything else → `None` (shown as text).
pub fn wtlive_link(href: &str) -> Option<String> {
    let url = absolute(href);
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    (host == SITE_HOST && !url.contains(['"', '\'', '<', '>', ' ', '\\'])).then_some(url)
}

/// A picture on WT Live's CDN or on its image host for embedded pictures, as `https://`.
pub fn image_url(src: &str) -> Option<String> {
    if let Some(url) = cdn_url(src) {
        return Some(url);
    }
    let url = absolute(src);
    let rest = url.strip_prefix("https://")?;
    let host = rest.split('/').next()?;
    (host == IMAGES_HOST && !url.contains(['"', '\'', '<', '>', ' ', '\\'])).then_some(url)
}

/// An open `<a>`: where it goes and what kind it is.
struct Anchor {
    href: Option<String>,
    hashtag: bool,
    /// `WTL-Embed-Image`: the link wraps an embedded picture.
    image: bool,
    /// An `<img>` inside it was kept.
    got_image: bool,
    text: String,
}

#[derive(Default)]
struct Builder {
    paragraphs: Vec<Vec<PostRun>>,
    current: Vec<PostRun>,
    images: Vec<String>,
    anchor: Option<Anchor>,
    bold: u32,
    italic: u32,
    chars: usize,
}

impl Builder {
    fn full(&self) -> bool {
        self.chars >= MAX_TEXT_CHARS
    }

    fn text(&mut self, raw: &str) {
        if raw.is_empty() {
            return;
        }
        let decoded = decode_entities(raw);
        if let Some(anchor) = &mut self.anchor {
            anchor.text.push_str(&decoded);
            return;
        }
        self.push_text(&decoded);
    }

    fn push_text(&mut self, text: &str) {
        let text = collapse(text, self.at_line_start());
        if text.is_empty() || self.full() {
            return;
        }
        let text = self.budget(text);
        let (bold, italic) = (self.bold > 0, self.italic > 0);
        // Runs with the same style join up.
        if let Some(PostRun::Text { text: last, bold: b, italic: i }) = self.current.last_mut() {
            if *b == bold && *i == italic {
                last.push_str(&text);
                return;
            }
        }
        self.current.push(PostRun::Text { text, bold, italic });
    }

    /// Cuts `text` to what is left of the budget.
    fn budget(&mut self, text: String) -> String {
        let left = MAX_TEXT_CHARS - self.chars;
        let count = text.chars().count();
        self.chars += count.min(left);
        if count <= left {
            text
        } else {
            let mut cut: String = text.chars().take(left).collect();
            cut.push('…');
            cut
        }
    }

    fn at_line_start(&self) -> bool {
        match self.current.last() {
            None | Some(PostRun::Break) => true,
            Some(PostRun::Text { text, .. }) => text.ends_with(' '),
            Some(PostRun::Link { .. }) => false,
        }
    }

    fn tag(&mut self, tag: &str, name: &str) {
        let closing = tag.starts_with('/');
        match (name, closing) {
            ("p" | "div" | "li" | "ul" | "ol" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "tr", _) => {
                self.paragraph()
            }
            ("br", _) => self.line_break(),
            ("b" | "strong", false) => self.bold += 1,
            ("b" | "strong", true) => self.bold = self.bold.saturating_sub(1),
            ("i" | "em", false) => self.italic += 1,
            ("i" | "em", true) => self.italic = self.italic.saturating_sub(1),
            ("a", false) => {
                self.close_anchor();
                let href = attr(tag, "href");
                let class = attr(tag, "class").unwrap_or_default();
                let hashtag =
                    class.contains("WTL-Embed-Hashtag") || href.as_deref().is_some_and(|h| h.contains("?q=%23"));
                let image = class.contains("WTL-Embed-Image");
                self.anchor = Some(Anchor { href, hashtag, image, got_image: false, text: String::new() });
            }
            ("a", true) => self.close_anchor(),
            ("img", false) => {
                if let Some(src) = attr(tag, "src").as_deref().and_then(image_url) {
                    self.image(src);
                    if let Some(anchor) = &mut self.anchor {
                        anchor.got_image = true;
                    }
                }
            }
            _ => {}
        }
    }

    fn image(&mut self, src: String) {
        if self.images.len() < MAX_IMAGES && !self.images.contains(&src) {
            self.images.push(src);
        }
    }

    fn close_anchor(&mut self) {
        let Some(anchor) = self.anchor.take() else { return };
        if anchor.hashtag {
            return;
        }
        let text = collapse(&anchor.text, false);
        let text = text.trim();
        if anchor.image || (anchor.got_image && text.is_empty()) {
            // An embedded picture whose <img> wasn't usable: the link itself may point at it.
            if !anchor.got_image {
                if let Some(src) = anchor.href.as_deref().and_then(image_url) {
                    self.image(src);
                }
            }
            return;
        }
        let url = anchor.href.as_deref().and_then(wtlive_link);
        match url {
            Some(url) if !self.full() => {
                let label = if text.is_empty() { url.clone() } else { text.to_owned() };
                let label = self.budget(label);
                self.current.push(PostRun::Link { text: label, url });
            }
            _ => self.push_text(text),
        }
    }

    fn line_break(&mut self) {
        self.close_anchor();
        trim_end(&mut self.current);
        // No break at a paragraph's start, nor two in a row.
        if matches!(self.current.last(), None | Some(PostRun::Break)) {
            return;
        }
        self.current.push(PostRun::Break);
    }

    fn paragraph(&mut self) {
        self.close_anchor();
        let mut runs = std::mem::take(&mut self.current);
        trim_end(&mut runs);
        while matches!(runs.last(), Some(PostRun::Break)) {
            runs.pop();
            trim_end(&mut runs);
        }
        if !runs.is_empty() && self.paragraphs.len() < MAX_PARAGRAPHS {
            self.paragraphs.push(runs);
        }
    }

    fn finish(mut self) -> Option<PostDescription> {
        self.paragraph();
        (!self.paragraphs.is_empty() || !self.images.is_empty()).then_some(PostDescription {
            paragraphs: self.paragraphs,
            tags: Vec::new(),
            images: self.images,
        })
    }
}

/// Whitespace runs (newlines from the HTML source included) become one space; a leading one
/// goes when the line already starts or ends with a space.
fn collapse(text: &str, drop_leading: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = drop_leading;
    for c in text.chars() {
        if c.is_whitespace() {
            if !space {
                out.push(' ');
                space = true;
            }
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

/// Drops trailing spaces of the last text run (and the run itself when nothing is left).
fn trim_end(runs: &mut Vec<PostRun>) {
    while let Some(PostRun::Text { text, .. }) = runs.last_mut() {
        let len = text.trim_end().len();
        text.truncate(len);
        if !text.is_empty() {
            break;
        }
        runs.pop();
    }
}
