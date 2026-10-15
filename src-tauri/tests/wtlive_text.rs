//! A post's description, from WT Live's HTML to text runs, links and pictures
//! (`tests/fixtures/wtlive/post_rich.json` has the structure of a real post, with made-up text).

use livery_lib::model::{PostDescription, PostRun};
use livery_lib::wtlive::api::parse_post;
use livery_lib::wtlive::text::{image_url, post_description, wtlive_link};
use std::path::PathBuf;

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wtlive").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn text(s: &str) -> PostRun {
    PostRun::Text { text: s.to_owned(), bold: false, italic: false }
}

fn bold(s: &str) -> PostRun {
    PostRun::Text { text: s.to_owned(), bold: true, italic: false }
}

#[test]
fn a_real_shaped_post_keeps_text_links_and_pictures_and_drops_hashtags() {
    let post = parse_post(&fixture("post_rich.json")).unwrap().unwrap();
    let d = post.skin.description.expect("the post page carries the description");
    assert_eq!(
        d.paragraphs,
        vec![
            vec![
                text("Leopard fixture camo"),
                PostRun::Break,
                text("Second line & more"),
                PostRun::Break,
                text("4k DDS")
            ],
            vec![
                text("My squadron: "),
                PostRun::Link {
                    text: "https://example.org".into(),
                    url: "https://live.warthunder.com/away/?enc=1&to=aHR0cHM6Ly9leGFtcGxlLm9yZw".into(),
                },
                text(" , come "),
                bold("say hi"),
                text(")))"),
            ],
        ]
    );
    assert_eq!(
        d.images,
        [
            "https://images-live.warthunder.com/aaa/111/0123456789abcdef_mq.jpeg",
            "https://images-live.warthunder.com/bbb/222/fedcba9876543210_mq.jpeg"
        ]
    );
    // The hashtags taken out of the text come along as tags.
    assert_eq!(post.tags, ["fixture", "tank"]);
    assert_eq!(d.tags, ["fixture", "tank"]);
}

#[test]
fn the_feed_leaves_the_description_out() {
    let posts = livery_lib::wtlive::api::parse_feed(&fixture("feed_page.json")).unwrap();
    assert!(posts.iter().all(|p| p.skin.description.is_none()));
}

#[test]
fn bold_and_italic_from_the_fixture_post() {
    let post = parse_post(&fixture("post.json")).unwrap().unwrap();
    let d = post.skin.description.unwrap();
    assert_eq!(d.paragraphs.len(), 2, "{:?}", d.paragraphs);
    assert!(matches!(&d.paragraphs[0][0], PostRun::Text { bold: true, .. }));
    assert_eq!(
        d.paragraphs[1],
        vec![PostRun::Text { text: "Fixture text, not from WT Live.".into(), bold: false, italic: true }]
    );
}

#[test]
fn links_off_wt_live_become_text() {
    let d = post_description(
        r#"<p>See <a href="https://evil.example/x">this page</a> and <a href="javascript:alert(1)">that</a>.</p>"#,
    )
    .unwrap();
    assert_eq!(d.paragraphs, vec![vec![text("See this page and that.")]]);
    let d = post_description(r#"<p><a href="//live.warthunder.com/user/42/">my posts</a></p>"#).unwrap();
    assert_eq!(
        d.paragraphs,
        vec![vec![PostRun::Link { text: "my posts".into(), url: "https://live.warthunder.com/user/42/".into() }]]
    );
}

#[test]
fn scripts_iframes_and_foreign_pictures_are_dropped() {
    let d = post_description(
        r#"<p>Hi<script>alert("x")</script><iframe src="https://video.example"></iframe><style>p{}</style> there</p><img src="https://evil.example/a.png"><img src="http://images-live.warthunder.com/a.png"><img onerror="x" src="//cdn-live.warthunder.com/uploads/a_mq/b.png">"#,
    )
    .unwrap();
    assert_eq!(d.paragraphs, vec![vec![text("Hi there")]]);
    assert_eq!(d.images, ["https://cdn-live.warthunder.com/uploads/a_mq/b.png"]);
}

#[test]
fn only_hashtags_or_nothing_is_none() {
    assert_eq!(post_description(""), None);
    assert_eq!(post_description("<p> </p><p><br /></p>"), None);
    assert_eq!(
        post_description(r#"<p><a class="WTL-Embed-Hashtag" href="//live.warthunder.com/?q=%23a">#a</a> </p>"#),
        None
    );
    assert_eq!(
        post_description(r#"<img src="https://images-live.warthunder.com/a.jpeg">"#),
        Some(PostDescription {
            paragraphs: vec![],
            tags: vec![],
            images: vec!["https://images-live.warthunder.com/a.jpeg".into()]
        })
    );
}

#[test]
fn broken_markup_stays_text_and_huge_text_is_cut() {
    let d = post_description("<p>a < b and 3 > 2 &amp; &bogus; <unclosed").unwrap();
    assert_eq!(d.paragraphs, vec![vec![text("a < b and 3 > 2 & &bogus; <unclosed")]]);
    let long = format!("<p>{}</p>", "x".repeat(20_000));
    let d = post_description(&long).unwrap();
    let PostRun::Text { text, .. } = &d.paragraphs[0][0] else { panic!() };
    assert!(text.chars().count() <= 12_001 && text.ends_with('…'));
}

#[test]
fn hosts() {
    assert_eq!(
        wtlive_link("//live.warthunder.com/post/1/en/").as_deref(),
        Some("https://live.warthunder.com/post/1/en/")
    );
    assert_eq!(wtlive_link("https://live.warthunder.com.evil.example/"), None);
    assert_eq!(wtlive_link("http://live.warthunder.com/"), None);
    assert_eq!(
        image_url("//images-live.warthunder.com/a.jpeg").as_deref(),
        Some("https://images-live.warthunder.com/a.jpeg")
    );
    assert_eq!(image_url("https://images-live.warthunder.com.evil/a.jpeg"), None);
}
