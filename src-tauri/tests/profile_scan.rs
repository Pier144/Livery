//! Cutting the lineup blocks out of `global.blk`: names at any depth, whole tokens only, names
//! and braces inside strings and comments ignored, unterminated and oversized blocks.

use livery_lib::game::profile::{find_block, ScanError, MAX_BLOCK_BYTES};

#[test]
fn finds_a_block_at_any_depth() {
    let text = "content{\n profile{\n  selectedAir{\n   current_model:t=\"us_m4_t26\"\n  }\n }\n}";
    assert_eq!(find_block(text, "selectedAir").unwrap(), Some("selectedAir{\n   current_model:t=\"us_m4_t26\"\n  }"));
}

#[test]
fn allows_whitespace_before_the_brace() {
    assert_eq!(find_block("a{ selectedAir \n { x:i=1 } }", "selectedAir").unwrap(), Some("selectedAir \n { x:i=1 }"));
}

#[test]
fn matches_whole_tokens_only() {
    assert_eq!(find_block("xselectedAir{a:i=1}", "selectedAir").unwrap(), None);
    assert_eq!(find_block("selectedAirx{a:i=1}", "selectedAir").unwrap(), None);
    assert_eq!(find_block("selectedAir:t=\"x\"", "selectedAir").unwrap(), None, "a param, not a block");
}

#[test]
fn ignores_names_and_braces_in_strings_and_comments() {
    let text = concat!(
        "a:t=\"selectedAir{\"\n",
        "b:t='} selectedAir{'\n",
        "c:t=\"\"\"selectedAir{ }\"\"\"\n",
        "c2:t='''selectedAir{ '''\n",
        "e:t=it's selectedAir-free\n",
        "d:t=\"~\" selectedAir{\"\n",
        "// selectedAir{\n",
        "/* selectedAir{ } */\n",
        "selectedAir{ name:t=\"}{\" // }\n /* } */ }",
    );
    assert_eq!(find_block(text, "selectedAir").unwrap(), Some("selectedAir{ name:t=\"}{\" // }\n /* } */ }"));
}

#[test]
fn returns_the_first_block_of_that_name() {
    let text = "a{ selectedAir{ n:i=1 } } selectedAir{ n:i=2 }";
    assert_eq!(find_block(text, "selectedAir").unwrap(), Some("selectedAir{ n:i=1 }"));
}

#[test]
fn keeps_non_ascii_text_around_the_block() {
    let text = "nome:t=\"Preselezione #1 è\"\nò{ selectedAir{ n:t=\"ü\" } }";
    assert_eq!(find_block(text, "selectedAir").unwrap(), Some("selectedAir{ n:t=\"ü\" }"));
}

#[test]
fn reports_an_unterminated_block() {
    assert_eq!(find_block("slotbar_presets{ a{ }", "slotbar_presets"), Err(ScanError::Unterminated));
    assert_eq!(find_block("slotbar_presets{ a:t=\"x", "slotbar_presets"), Err(ScanError::Unterminated));
    assert_eq!(find_block("slotbar_presets{ /* a", "slotbar_presets"), Err(ScanError::Unterminated));
    assert_eq!(find_block("slotbar_presets{ a:t=\"x~", "slotbar_presets"), Err(ScanError::Unterminated));
}

#[test]
fn caps_the_block_size() {
    let big = format!("slotbar_presets{{ a:t=\"{}\" }}", "x".repeat(MAX_BLOCK_BYTES));
    assert_eq!(find_block(&big, "slotbar_presets"), Err(ScanError::TooBig));
    let big = format!("slotbar_presets{{ a:t=\"x\"{} }}", "\n".repeat(MAX_BLOCK_BYTES));
    assert_eq!(find_block(&big, "slotbar_presets"), Err(ScanError::TooBig));
}

#[test]
fn a_block_just_under_the_cap_is_kept() {
    let head = "slotbar_presets{ a:t=\"";
    let tail = "\" }";
    let fill = "x".repeat(MAX_BLOCK_BYTES - head.len() - tail.len());
    let text = format!("{head}{fill}{tail}");
    assert_eq!(find_block(&text, "slotbar_presets").unwrap().map(str::len), Some(MAX_BLOCK_BYTES));
}

#[test]
fn a_missing_block_is_none() {
    assert_eq!(find_block("a{ b{ } }", "slotbar_presets").unwrap(), None);
    assert_eq!(find_block("", "slotbar_presets").unwrap(), None);
}
