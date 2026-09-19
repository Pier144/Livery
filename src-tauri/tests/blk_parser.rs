//! DAGOR BLK text parser: fixture skins, every value type, syntax corners, error positions,
//! and garbage input (never a panic).

use livery_lib::error::ErrorCode;
use livery_lib::library::blk::{parse, parse_bytes, BlkError, Block, Value, MAX_NESTING};
use livery_lib::AppError;
use std::path::PathBuf;

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("blk").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn parse_fixture(name: &str) -> Result<Block, BlkError> {
    parse_bytes(&fixture(name))
}

fn names(block: &Block) -> Vec<&str> {
    block.blocks.iter().map(|(n, _)| n.as_str()).collect()
}

fn str_value(s: &str) -> Value {
    Value::Str(s.to_owned())
}

// ── Fixtures ────────────────────────────────────────────────────────────────

#[test]
fn template_skin_keeps_order_and_values() {
    let root = parse_fixture("template_skin.blk").unwrap();
    assert_eq!(root.params, vec![("name".to_owned(), str_value("user"))]);
    assert_eq!(names(&root), ["replace_tex", "replace_tex", "set_tex"]);

    let replaced: Vec<(&str, &str)> =
        root.blocks_named("replace_tex").map(|b| (b.str_param("from").unwrap(), b.str_param("to").unwrap())).collect();
    assert_eq!(replaced, [("t_34_85_body_c*", "t_34_85_body_c_uv*"), ("t_34_85_turret_c*", "t_34_85_turret_c_uv.tga")]);

    let set = root.block("set_tex").unwrap();
    let keys: Vec<&str> = set.params.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(keys, ["from", "to", "param"]);
    assert_eq!(set.str_param("param"), Some("camo_skin_tex"));
}

#[test]
fn comments_semicolons_single_quotes_and_one_line_blocks() {
    let root = parse_fixture("comments_semicolons.blk").unwrap();
    assert_eq!(root.str_param("name"), Some("Winter \"whitewash\""));
    assert_eq!(names(&root), ["replace_tex", "replace_tex", "set_tex", "empty", "nested"]);

    let targets: Vec<&str> = root.blocks_named("replace_tex").map(|b| b.str_param("to").unwrap()).collect();
    assert_eq!(targets, ["hull_c_snow.dds", "turret_c_snow"]);

    // `~` escapes: `~"` is a quote and `~~` a tilde.
    assert_eq!(root.block("set_tex").unwrap().str_param("to"), Some("camo \"alpine\" ~1.dds"));
    assert!(root.block("empty").unwrap().is_empty());

    let deeper = root.block("nested").and_then(|b| b.block("inner")).and_then(|b| b.block("deeper")).unwrap();
    assert_eq!(deeper.param("flag"), Some(&Value::Bool(true)));
}

#[test]
fn unknown_root_block_is_kept() {
    let root = parse_fixture("unknown_block.blk").unwrap();
    assert_eq!(names(&root), ["replace_tex", "camo_params"]);
    let camo = root.block("camo_params").unwrap();
    assert_eq!(camo.params, vec![("scale".to_owned(), Value::Real(1.5)), ("rotation".to_owned(), Value::Real(0.0))]);
}

#[test]
fn every_value_type() {
    let root = parse_fixture("all_types.blk").unwrap();
    let get = |name: &str| root.param(name).unwrap_or_else(|| panic!("missing {name}")).clone();
    assert_eq!(get("str"), str_value("text"));
    assert_eq!(get("int"), Value::Int(-42));
    assert_eq!(get("hex"), Value::Int(31));
    assert_eq!(get("big"), Value::Int64(9_000_000_000));
    assert_eq!(get("real"), Value::Real(150.0));
    assert_eq!(get("flag"), Value::Bool(false));
    assert_eq!(get("p2"), Value::Point2([1.0, 2.5]));
    assert_eq!(get("p3"), Value::Point3([1.0, 2.0, 3.0]));
    assert_eq!(get("p4"), Value::Point4([0.0, 0.0, 0.0, 1.0]));
    assert_eq!(get("ip2"), Value::IPoint2([640, 480]));
    assert_eq!(get("ip3"), Value::IPoint3([-1, 0, 1]));
    assert_eq!(get("color"), Value::Color([255, 128, 0, 255]));
    assert_eq!(get("color4"), Value::Color([10, 20, 30, 40]));
    assert_eq!(get("tm"), Value::Matrix("[[1, 0, 0] [0, 1, 0] [0, 0, 1] [0, 0, 0]]".into()));
    assert_eq!(get("custom"), Value::Raw { ty: "q8".into(), text: "whatever".into() });
    assert_eq!(get("untyped"), Value::Raw { ty: String::new(), text: "loose".into() });
    assert_eq!(get("untyped").as_str(), Some("loose"));
    assert_eq!(get("quoted name"), str_value("ok"));
    assert_eq!(root.includes, ["common/other.blk"]);
    assert_eq!(names(&root), ["@override:tank"]);
    assert_eq!(root.block("@override:tank").unwrap().param("x"), Some(&Value::Int(1)));
}

#[test]
fn bom_and_include_directive() {
    let root = parse_fixture("bom_include.blk").unwrap();
    assert_eq!(root.includes, ["#/develop/skins/base.blk"]);
    assert_eq!(root.str_param("name"), Some("bom"));
    assert_eq!(root.block("replace_tex").unwrap().str_param("to"), Some("b*"));
}

#[test]
fn unterminated_string_points_at_the_opening_quote() {
    let e = parse_fixture("malformed_unterminated.blk").unwrap_err();
    assert_eq!((e.line, e.column), (3, 8), "{e}");
    assert!(e.message.contains("never closed"), "{e}");
}

#[test]
fn unclosed_block_points_at_its_name() {
    let e = parse_fixture("malformed_unclosed.blk").unwrap_err();
    assert_eq!((e.line, e.column), (1, 1), "{e}");
    assert!(e.message.contains("'replace_tex'"), "{e}");
}

// ── Syntax ──────────────────────────────────────────────────────────────────

#[test]
fn empty_and_comment_only_input() {
    assert_eq!(parse("").unwrap(), Block::default());
    assert_eq!(parse("\u{feff}").unwrap(), Block::default());
    assert_eq!(parse("  // nothing\n/* at\nall */ ;;\n").unwrap(), Block::default());
}

#[test]
fn crlf_line_endings() {
    let root = parse("name:t=\"x\"\r\nreplace_tex{\r\n  to:t=\"a*\"\r\n}\r\n").unwrap();
    assert_eq!(root.str_param("name"), Some("x"));
    assert_eq!(root.block("replace_tex").unwrap().str_param("to"), Some("a*"));
}

#[test]
fn spaces_around_colon_and_equals_and_several_params_per_line() {
    let root = parse("a : t = \"x\"   b:i=2;c:t='y' d:t=\"z\"").unwrap();
    let keys: Vec<&str> = root.params.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(keys, ["a", "b", "c", "d"]);
    assert_eq!(root.param("b"), Some(&Value::Int(2)));
}

#[test]
fn bare_values_end_at_newline_semicolon_brace_or_comment() {
    let e = parse("a:t=plain text  // note\nb:i=5}").unwrap_err();
    assert!(e.message.contains("unexpected '}'"), "stray brace: {e}");
    assert_eq!(parse("a:t=plain text  // note").unwrap().str_param("a"), Some("plain text"));

    let root = parse("blk{a:t=bare;b:r=2.5}c:t=x /* c */\nd:b=on").unwrap();
    let inner = root.block("blk").unwrap();
    assert_eq!(inner.param("a"), Some(&str_value("bare")));
    assert_eq!(inner.param("b"), Some(&Value::Real(2.5)));
    assert_eq!(root.param("c"), Some(&str_value("x")));
    assert_eq!(root.param("d"), Some(&Value::Bool(true)));
}

#[test]
fn escapes_and_literal_backslashes() {
    let root = parse(r#"a:t="line~nnext~ttab~rcr" b:t="C:\skins\new" c:t='it~'s' d:t="caffè ~é""#).unwrap();
    assert_eq!(root.str_param("a"), Some("line\nnext\ttab\rcr"));
    assert_eq!(root.str_param("b"), Some(r"C:\skins\new"));
    assert_eq!(root.str_param("c"), Some("it's"));
    assert_eq!(root.str_param("d"), Some("caffè é"));
}

#[test]
fn triple_quoted_strings_span_lines() {
    let root = parse("text:t=\"\"\"\nfirst\nsecond \"quoted\"\n\"\"\"\nafter:i=1").unwrap();
    assert_eq!(root.str_param("text"), Some("first\nsecond \"quoted\"\n"));
    assert_eq!(root.param("after"), Some(&Value::Int(1)));
}

#[test]
fn repeated_names_keep_file_order() {
    let root = parse("x:i=1\nx:i=2\nb{}\nx:i=3\nb{y:i=1}").unwrap();
    let xs: Vec<&Value> = root.params_named("x").collect();
    assert_eq!(xs, [&Value::Int(1), &Value::Int(2), &Value::Int(3)]);
    assert_eq!(root.blocks_named("b").count(), 2);
    assert!(root.block("b").unwrap().is_empty(), "first match wins");
}

#[test]
fn include_is_only_a_directive_before_a_target() {
    let root = parse("include 'a.blk'\ninclude b.blk // bare\ninclude:t=\"param\"\ninclude{ k:i=1 }").unwrap();
    assert_eq!(root.includes, ["a.blk", "b.blk"]);
    assert_eq!(root.str_param("include"), Some("param"));
    assert_eq!(names(&root), ["include"]);
}

#[test]
fn nesting_is_capped() {
    let nested = |depth: usize| format!("{}{}", "a{".repeat(depth), "}".repeat(depth));
    let mut block = &parse(&nested(MAX_NESTING)).unwrap();
    let mut levels = 0;
    while let Some(inner) = block.block("a") {
        block = inner;
        levels += 1;
    }
    assert_eq!(levels, MAX_NESTING);

    let e = parse(&nested(MAX_NESTING + 1)).unwrap_err();
    assert_eq!((e.line, e.column), (1, 2 * MAX_NESTING + 1), "{e}");
    // Far deeper input fails the same way, without exhausting the stack.
    assert!(parse(&"a{".repeat(1_000_000)).is_err());
}

// ── Errors ──────────────────────────────────────────────────────────────────

fn error(text: &str) -> BlkError {
    parse(text).expect_err(text)
}

#[test]
fn syntax_errors_carry_line_and_column() {
    let cases: [(&str, (usize, usize), &str); 11] = [
        ("}", (1, 1), "unexpected '}'"),
        ("a{\n}\n}", (3, 1), "unexpected '}'"),
        ("name", (1, 5), "expected '{', ':' or '='"),
        ("a:=\"x\"", (1, 3), "expected a type"),
        ("a:t \"x\"", (1, 5), "expected '='"),
        ("a:i=abc", (1, 5), "not a valid int"),
        ("\n  a:b=maybe", (2, 7), "not a valid bool"),
        ("a:p3=1,2", (1, 6), "not a valid p3"),
        ("a:c=256,0,0", (1, 5), "not a valid color"),
        ("/* open", (1, 1), "comment '/*' is never closed"),
        ("x:i=1\n = 2", (2, 2), "expected a name"),
    ];
    for (text, (line, column), message) in cases {
        let e = error(text);
        assert_eq!((e.line, e.column), (line, column), "{text:?} → {e}");
        assert!(e.message.contains(message), "{text:?} → {e}");
    }
}

#[test]
fn columns_count_characters_not_bytes() {
    // "é" and "ü" are two bytes each in UTF-8.
    let e = error("n:t=\"éü\" x:i=é");
    assert_eq!((e.line, e.column), (1, 14), "{e}");
}

#[test]
fn integer_ranges_are_checked() {
    assert_eq!(parse("a:i=2147483647").unwrap().param("a"), Some(&Value::Int(i32::MAX)));
    assert!(parse("a:i=2147483648").is_err());
    assert_eq!(parse("a:i64=-9223372036854775808").unwrap().param("a"), Some(&Value::Int64(i64::MIN)));
    assert!(parse("a:r=inf").is_err(), "only plain numbers are reals");
}

#[test]
fn binary_and_utf16_files_are_rejected() {
    let e = parse_bytes(b"\x00BBF\x03\x00\x01").unwrap_err();
    assert!(e.message.contains("binary"), "{e}");
    let e = parse_bytes(b"\xff\xfen\x00a\x00").unwrap_err();
    assert!(e.message.contains("UTF-16"), "{e}");
}

#[test]
fn invalid_utf8_is_replaced_not_fatal() {
    // A Windows-1251 comment (Cyrillic) in an otherwise ASCII file.
    let root = parse_bytes(b"// \xca\xe0\xec\xf3\xf4\xeb\xff\xe6\nto:t=\"camo\"").unwrap();
    assert_eq!(root.str_param("to"), Some("camo"));
}

#[test]
fn maps_to_a_parse_app_error() {
    let e: AppError = error("a:t=\"x").into();
    assert_eq!(e.code, ErrorCode::Parse);
    assert_eq!(e.detail.as_deref(), Some("line 1, column 5: string is never closed"));
}

#[test]
fn garbage_never_panics() {
    // Tiny xorshift generator: deterministic, no dependency.
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    const ALPHABET: &[u8] = b"ab_:=;{}\"'~/*\n\r\t .,-0123456789[]@itrbpcm\xc3\xa9";
    for round in 0..20_000 {
        let len = (next() % 64) as usize;
        let bytes: Vec<u8> = if round % 2 == 0 {
            (0..len).map(|_| ALPHABET[(next() % ALPHABET.len() as u64) as usize]).collect()
        } else {
            (0..len).map(|_| (next() & 0xff) as u8).collect()
        };
        // Either result is fine; reaching the next iteration is the test.
        let _ = parse_bytes(&bytes);
        let _ = parse(&String::from_utf8_lossy(&bytes));
    }
}
