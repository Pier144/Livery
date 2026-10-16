//! Lineups from the `slotbar_presets` and `selectedAir` blocks: game nation order, the active
//! preset, preset strings (names with `|`, short strings, codes), the current vehicle's nation.

use livery_lib::game::profile::parse_lineups;
use livery_lib::library::blk::parse;
use livery_lib::model::{Nation, NationLineups, Preset};

type Parsed = (Option<String>, Option<Nation>, Vec<NationLineups>);

/// Parses `presets` (a `slotbar_presets{…}` block) and `selected_air` (a `selectedAir{…}`
/// block) the way `read_lineups` does.
fn lineups(presets: &str, selected_air: Option<&str>) -> Parsed {
    let presets = parse(presets).unwrap().block("slotbar_presets").unwrap().clone();
    let selected_air = selected_air.map(|text| parse(text).unwrap().block("selectedAir").unwrap().clone());
    parse_lineups(&presets, selected_air.as_ref())
}

fn preset(name: &str, active: bool, vehicles: &[&str]) -> Preset {
    Preset { name: name.to_owned(), active, vehicles: vehicles.iter().map(|v| (*v).to_owned()).collect() }
}

fn nations(parsed: &Parsed) -> Vec<Nation> {
    parsed.2.iter().map(|n| n.nation).collect()
}

const TWO_NATIONS: &str = r#"slotbar_presets{
  presetsVersion:i=1
  country_britain{
    preset:t="3|11,12|uk_a13_mk2,uk_crusader_mk_2|Preselezione #1|tank_mode|"
  }
  country_usa{
    preset:t="5|1,2|us_m2a4,us_m3_stuart|Early|tank_mode|"
    preset:t="5|1,2,3|us_m4_t26,us_m18_hellcat,us_t1e1_90|Mid tier|tank_mode|7,8"
    preset:t="5|4|d_371,p-47d|Air|air_mode|"
    selected:i=1
  }
}"#;

#[test]
fn nations_come_in_game_order_with_the_selected_preset_active() {
    let parsed = lineups(TWO_NATIONS, None);
    assert_eq!(nations(&parsed), [Nation::Usa, Nation::Gbr], "USA before Britain, whatever the file order");
    assert_eq!(
        parsed.2[0].presets,
        [
            preset("Early", false, &["us_m2a4", "us_m3_stuart"]),
            preset("Mid tier", true, &["us_m4_t26", "us_m18_hellcat", "us_t1e1_90"]),
            preset("Air", false, &["d_371", "p-47d"]),
        ]
    );
    assert_eq!(parsed.2[1].presets, [preset("Preselezione #1", true, &["uk_a13_mk2", "uk_crusader_mk_2"])]);
}

#[test]
fn a_bad_selected_index_falls_back_to_the_first_preset() {
    for selected in ["selected:i=7", "selected:i=-1", "selected:t=\"x\""] {
        let text =
            format!("slotbar_presets{{ country_usa{{ preset:t=\"5|1|a|A|m|\" preset:t=\"5|1|b|B|m|\" {selected} }} }}");
        let parsed = lineups(&text, None);
        let active: Vec<bool> = parsed.2[0].presets.iter().map(|p| p.active).collect();
        assert_eq!(active, [true, false], "{selected}");
    }
}

#[test]
fn short_preset_strings_are_skipped_without_shifting_the_active_one() {
    let text = r#"slotbar_presets{
      country_usa{
        preset:t="5|1|broken"
        preset:t="5|1|a|A|m|"
        preset:t="5|1|b|B|m|"
        selected:i=2
      }
      country_germany{
        preset:t="5|1||Empty|m|"
        preset:t="5|1| , |Blank codes|m|"
        preset:t="short"
      }
    }"#;
    let parsed = lineups(text, None);
    assert_eq!(nations(&parsed), [Nation::Usa], "a nation with no usable preset is left out");
    assert_eq!(parsed.2[0].presets, [preset("A", false, &["a"]), preset("B", true, &["b"])]);
}

#[test]
fn a_selected_preset_without_vehicles_leaves_none_active() {
    let text = r#"slotbar_presets{ country_usa{ preset:t="5|1|a|A|m|" preset:t="5|1||B|m|" selected:i=1 } }"#;
    let parsed = lineups(text, None);
    assert_eq!(parsed.2[0].presets, [preset("A", false, &["a"])]);
}

#[test]
fn a_name_may_contain_the_separator() {
    let text = r#"slotbar_presets{ country_usa{ preset:t="5|5,6|a,b|My | lineup|tank_mode|" } }"#;
    let parsed = lineups(text, None);
    assert_eq!(parsed.2[0].presets, [preset("My | lineup", true, &["a", "b"])]);
}

#[test]
fn names_are_trimmed_and_may_be_empty() {
    let text = r#"slotbar_presets{ country_usa{ preset:t="5|1|a|  Night  |m|" preset:t="5|1|b||m|" } }"#;
    let parsed = lineups(text, None);
    assert_eq!(parsed.2[0].presets, [preset("Night", true, &["a"]), preset("", false, &["b"])]);
}

#[test]
fn codes_are_trimmed_with_empty_and_duplicate_ones_dropped() {
    let text = r#"slotbar_presets{ country_usa{ preset:t="5|5|a,,a, b |N|m|" } }"#;
    let parsed = lineups(text, None);
    assert_eq!(parsed.2[0].presets, [preset("N", true, &["a", "b"])]);
}

#[test]
fn unknown_countries_are_skipped() {
    let text = r#"slotbar_presets{
      country_atlantis{ preset:t="5|1|a|A|m|" }
      country_sweden{ preset:t="5|1|sw_strv_m42|S|m|" }
    }"#;
    let parsed = lineups(text, None);
    assert_eq!(nations(&parsed), [Nation::Swe]);
}

#[test]
fn aircraft_codes_without_a_prefix_are_kept_as_written() {
    let text = r#"slotbar_presets{ country_ussr{ preset:t="5|1|yak-7b,la-5fn,d_371|Air|m|" } }"#;
    let parsed = lineups(text, None);
    assert_eq!(parsed.2[0].presets[0].vehicles, ["yak-7b", "la-5fn", "d_371"]);
}

#[test]
fn the_current_nation_comes_from_the_selected_air_key() {
    let selected_air = r#"selectedAir{
      current_model:t="d_371"
      usa:t="us_m4_t26"
      france:t="d_371"
    }"#;
    let parsed = lineups(TWO_NATIONS, Some(selected_air));
    assert_eq!(parsed.0.as_deref(), Some("d_371"));
    assert_eq!(parsed.1, Some(Nation::Fra), "the key wins even though d_371 is only in a USA preset");
}

#[test]
fn the_current_nation_falls_back_to_the_first_preset_holding_the_vehicle() {
    let presets = r#"slotbar_presets{
      country_britain{ preset:t="5|1|us_m4_t26|Lend-lease|m|" }
      country_usa{ preset:t="5|1|us_m2a4|A|m|" preset:t="5|1|us_m4_t26|B|m|" }
    }"#;
    let selected_air = r#"selectedAir{ current_model:t="us_m4_t26" usa:t="us_m2a4" current_skin:t="us_m4_t26" }"#;
    let parsed = lineups(presets, Some(selected_air));
    assert_eq!(parsed.0.as_deref(), Some("us_m4_t26"));
    assert_eq!(parsed.1, Some(Nation::Usa), "game order: USA before Britain");
}

#[test]
fn a_current_vehicle_found_nowhere_has_no_nation() {
    let selected_air = r#"selectedAir{ current_model:t="it_m13_40" atlantis:t="it_m13_40" }"#;
    let parsed = lineups(TWO_NATIONS, Some(selected_air));
    assert_eq!(parsed.0.as_deref(), Some("it_m13_40"));
    assert_eq!(parsed.1, None);
}

#[test]
fn without_selected_air_there_is_no_current_vehicle() {
    let parsed = lineups(TWO_NATIONS, None);
    assert_eq!((parsed.0, parsed.1), (None, None));
    let parsed = lineups(TWO_NATIONS, Some(r#"selectedAir{ current_model:t="  " usa:t="" }"#));
    assert_eq!((parsed.0, parsed.1), (None, None), "a blank current_model counts as none");
}
