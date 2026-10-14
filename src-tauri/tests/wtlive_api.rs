//! WT Live's JSON, read from saved answers (`tests/fixtures/wtlive/`, captured from the live
//! endpoints on 2026-10-14 and anonymised: authors, titles and image paths are made up, the
//! structure is WT Live's).

use livery_lib::error::ErrorCode;
use livery_lib::model::{Category, Nation, VehicleType};
use livery_lib::wtlive::api::{
    cdn_url, download_link, hashtags, html_text, infer_category, infer_vehicle, parse_feed, parse_possible_users,
    parse_post, search_string, skin_name, squash, text_query, vehicle_tags, TextQuery, ERROR_ANSWER, UNREADABLE_ANSWER,
};
use std::path::PathBuf;

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wtlive").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn tags(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_feed_page_maps_every_installable_post() {
    let posts = parse_feed(&fixture("feed_page.json")).unwrap();
    // 7 entries: one has no file (not installable), one links its file off WT Live.
    let ids: Vec<&str> = posts.iter().map(|p| p.skin.id.as_str()).collect();
    assert_eq!(ids, ["1191507", "1191503", "1191499", "1191495", "1191494"]);

    let first = &posts[0];
    let skin = &first.skin;
    assert_eq!(skin.name, "F-4E Phantom II \u{201c}Sharkmouth\u{201d} #187: fixture squadron");
    assert_eq!(skin.author.id, "100001");
    assert_eq!(skin.author.name, "Fixture_Author1");
    assert_eq!(skin.author.url, "https://live.warthunder.com/user/100001/");
    assert_eq!(skin.post_url, "https://live.warthunder.com/post/1191507/en/");
    assert_eq!(skin.download_url, format!("https://live.warthunder.com/dl/{:040}/", 1));
    assert_eq!(skin.size_bytes, 34_574_792);
    assert_eq!(skin.posted_at, "2026-10-14T19:12:29Z");
    assert_eq!(skin.images, ["https://cdn-live.warthunder.com/uploads/aa/bb/01/img0_lq/shot0.jpg"]);
    assert_eq!(skin.category, Category::SemiHistorical);
    assert_eq!(skin.vehicle.code, "f_4e", "#f4e names the catalog's F-4E");
    assert_eq!(first.nation, Some(Nation::Usa), "the catalog's nation wins over #israel");
    assert_eq!(first.vehicle_type, Some(VehicleType::Air));
    assert_eq!(first.created, 1_792_005_149);
    assert!(first.tags.contains(&"autumn_camo_contest_1".to_owned()));
    assert_eq!(skin.files, None);
    assert_eq!(skin.is_new, None);
}

#[test]
fn unknown_vehicles_keep_what_the_hashtags_say() {
    let posts = parse_feed(&fixture("feed_page.json")).unwrap();
    let tu2 = posts.iter().find(|p| p.skin.id == "1191495").unwrap();
    assert_eq!(tu2.skin.vehicle.code, "", "no catalog vehicle is named");
    assert_eq!(tu2.skin.vehicle.name, "Unknown vehicle");
    assert_eq!(tu2.nation, None, "#hungary isn't a nation of the game");
    assert_eq!(tu2.skin.category, Category::SemiHistorical, "#semi_historical");

    let ariete = posts.iter().find(|p| p.skin.id == "1191503").unwrap();
    assert_eq!(ariete.skin.vehicle.code, "it_c1_ariete", "#c1_ariete is the code without its prefix");
    assert_eq!(ariete.skin.category, Category::Fictional);
    assert_eq!(ariete.skin.name, "Fixture text, not from WT Live.", "no bold title: the first line of text");

    let t34 = posts.iter().find(|p| p.skin.id == "1191494").unwrap();
    assert_eq!(t34.skin.vehicle.code, "ussr_t_34_85");
    assert_eq!(t34.skin.category, Category::Historical);
}

#[test]
fn names_decode_entities() {
    let posts = parse_feed(&fixture("feed_page.json")).unwrap();
    let names: Vec<&str> = posts.iter().map(|p| p.skin.name.as_str()).collect();
    assert!(names.contains(&"Line art & dots"), "{names:?}");
    assert!(names.contains(&"Tu-2S winter \"test\""), "{names:?}");
}

#[test]
fn a_post_answer_maps_the_medium_images() {
    let post = parse_post(&fixture("post.json")).unwrap().expect("the post exists");
    assert_eq!(post.skin.id, "1191507");
    assert!(!post.skin.images.is_empty());
    assert!(post.skin.images.iter().all(|i| i.starts_with("https://cdn-live.warthunder.com/") && i.contains("_mq/")));
}

#[test]
fn a_missing_post_is_none_and_garbage_is_network() {
    assert_eq!(parse_post(&fixture("post_err.json")).unwrap(), None);
    let e = parse_post(b"<html>").unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Network, UNREADABLE_ANSWER));
    let e = parse_post(br#"{"status":"OK"}"#).unwrap_err();
    assert_eq!(e.code, ErrorCode::Network);
}

#[test]
fn feed_errors_and_ends() {
    assert!(parse_feed(&fixture("feed_empty.json")).unwrap().is_empty());
    assert!(parse_feed(br#"{"status":"OK","data":{}}"#).unwrap().is_empty());
    assert!(parse_feed(br#"{"status":"OK"}"#).unwrap().is_empty());
    let e = parse_feed(&fixture("feed_err.json")).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Network, ERROR_ANSWER));
    assert_eq!(e.detail.as_deref(), Some("Something went wrong"));
    assert_eq!(parse_feed(b"not json").unwrap_err().code, ErrorCode::Network);
    assert_eq!(parse_feed(br#"{"data":{"list":[]}}"#).unwrap_err().code, ErrorCode::Network);
    // One broken post doesn't cost the page.
    let mixed = br#"{"status":"OK","data":{"list":[{"lang_group":"x"},{"nope":1}]}}"#;
    assert!(parse_feed(mixed).unwrap().is_empty());
}

#[test]
fn other_post_types_and_hidden_posts_are_left_out() {
    let mut value: serde_json::Value = serde_json::from_slice(&fixture("post.json")).unwrap();
    value["type"] = "image".into();
    assert_eq!(parse_post(&serde_json::to_vec(&value).unwrap()).unwrap(), None);
    value["type"] = "camouflage".into();
    value["hidden"] = true.into();
    assert_eq!(parse_post(&serde_json::to_vec(&value).unwrap()).unwrap(), None);
    value["hidden"] = false.into();
    value["likes"] = (-4).into();
    let post = parse_post(&serde_json::to_vec(&value).unwrap()).unwrap().unwrap();
    assert_eq!(post.skin.likes, 0, "negative ratings count as zero");
}

#[test]
fn user_look_up() {
    let users = parse_possible_users(&fixture("user_possible.json")).unwrap();
    assert_eq!(users.len(), 2);
    assert_eq!((users[0].id, users[0].nick.as_str(), users[0].posts), (100_001, "Fixture_Author1", 9));
    assert!(parse_possible_users(&fixture("user_possible_none.json")).unwrap().is_empty());
}

#[test]
fn only_wt_live_links_and_cdn_images() {
    assert_eq!(
        download_link("https://live.warthunder.com/dl/3afcade95afb/").as_deref(),
        Some("https://live.warthunder.com/dl/3afcade95afb/")
    );
    assert_eq!(download_link("//live.warthunder.com/dl/abc/").as_deref(), Some("https://live.warthunder.com/dl/abc/"));
    for bad in [
        "http://live.warthunder.com/dl/abc/",
        "https://live.warthunder.com.evil.com/dl/abc/",
        "https://live.warthunder.com/dl/../x/",
        "https://live.warthunder.com/dl/",
        "https://market.gaijin.net/dl/abc/",
        "https://live.warthunder.com/post/1/en/",
    ] {
        assert_eq!(download_link(bad), None, "{bad}");
    }
    assert_eq!(
        cdn_url("//cdn-live.warthunder.com/uploads/a.jpg").as_deref(),
        Some("https://cdn-live.warthunder.com/uploads/a.jpg")
    );
    for bad in [
        "https://market.gaijin.net/a.jpg",
        "http://cdn-live.warthunder.com/a.jpg",
        "https://cdn-live.warthunder.com.evil/a.jpg",
        "https://cdn-live.warthunder.com/a\".jpg",
        "javascript:alert(1)",
    ] {
        assert_eq!(cdn_url(bad), None, "{bad}");
    }
}

#[test]
fn hashtags_and_text() {
    let description = r#"<p><a href="//live.warthunder.com/?q=%23T_34_85" class="x">#T_34_85</a> <a href="//live.warthunder.com/?q=%23%D1%82%D0%B0%D0%BD%D0%BA">#танк</a> <a href="?q=%23t_34_85">dup</a></p>"#;
    assert_eq!(hashtags(description), ["t_34_85", "танк"]);
    assert_eq!(html_text("<b>A &amp; B</b>&nbsp;&#8220;C&#x201D; &bogus;"), "A & B \u{201c}C\u{201d} &bogus;");
    assert_eq!(html_text("<p>one</p><p>two<br/>three</p>"), " one  two three ");
    assert_eq!(skin_name(r#"<p><b>F-4E <a href="?q=%23187">#187</a>: IAF</b></p>"#, "x.zip", "Me"), "F-4E #187: IAF");
    assert_eq!(skin_name("<p>#only #tags</p><p><b>Real name</b></p>", "x.zip", "Me"), "Real name");
    assert_eq!(skin_name("<p>#only</p>", "my_skin_v2.zip", "Me"), "my skin v2");
    assert_eq!(skin_name("", "___.zip", "Me"), "Camouflage by Me");
    let long = format!("<p>{}</p>", "word ".repeat(40));
    let name = skin_name(&long, "x.zip", "Me");
    assert_eq!(name.chars().count(), 80);
    assert!(name.ends_with('…'));
}

#[test]
fn categories() {
    assert_eq!(infer_category(&tags(&["semi_historical", "historical"])), Category::SemiHistorical);
    assert_eq!(infer_category(&tags(&["fantasy"])), Category::Fictional);
    assert_eq!(infer_category(&tags(&["historical"])), Category::Historical);
    assert_eq!(infer_category(&tags(&["camo"])), Category::Camouflage);
    assert_eq!(infer_category(&tags(&["4k"])), Category::Other);
}

#[test]
fn vehicles_from_hashtags() {
    assert_eq!(infer_vehicle(&tags(&["tiger_ii_h"])).vehicle.code, "germ_pzkpfw_VI_ausf_b_tiger_IIH", "by name");
    assert_eq!(infer_vehicle(&tags(&["su27"])).vehicle.code, "su_27");
    let guess = infer_vehicle(&tags(&["germantank", "germany"]));
    assert_eq!(guess.vehicle.code, "");
    assert_eq!(guess.nation, Some(Nation::Ger));
    assert_eq!(guess.vehicle_type, Some(VehicleType::Ground), "…tank");
    assert_eq!(guess.vehicle.nation, Nation::Ger);
    let none = infer_vehicle(&tags(&["4k", "dds"]));
    assert_eq!((none.nation, none.vehicle_type), (None, None));
    let heli = infer_vehicle(&tags(&["helicopter", "uk"]));
    assert_eq!((heli.nation, heli.vehicle_type), (Some(Nation::Gbr), Some(VehicleType::Heli)));
}

#[test]
fn search_queries() {
    assert_eq!(text_query("@Fixture_Author1"), Some(TextQuery::Author("Fixture_Author1".into())));
    assert_eq!(text_query(" @ "), None);
    assert_eq!(text_query("#Tiger #t-34"), Some(TextQuery::Tags(tags(&["tiger", "t34"]))));
    assert_eq!(text_query("tiger"), Some(TextQuery::Tags(tags(&["tiger"]))));
    assert_eq!(text_query("Tiger II"), Some(TextQuery::Tags(tags(&["tiger_ii", "tigerii"]))));
    assert_eq!(text_query("!!!"), None);
    assert_eq!(search_string(&tags(&["a", "b_c"])), "#a #b_c");
    let t34 = vehicle_tags("ussr_t_34_85");
    assert!(t34.contains(&"t_34_85".to_owned()) && t34.contains(&"t3485".to_owned()), "{t34:?}");
    let bf = vehicle_tags("bf-109g-6");
    assert!(bf.contains(&"bf_109g_6".to_owned()) && bf.contains(&"bf109g6".to_owned()), "{bf:?}");
    assert_eq!(squash("T-34-85"), "t3485");
}
