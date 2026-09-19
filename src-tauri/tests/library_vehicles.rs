//! Vehicle resolution: the embedded catalog (case-insensitive), the prefix heuristic for
//! unknown codes, and folder names of skins without a `.blk`.

use livery_lib::library::vehicles::{self, from_folder_name, lookup, resolve, UNKNOWN_NAME};
use livery_lib::model::{Nation, VehicleType};

#[test]
fn catalog_is_embedded_and_parses() {
    assert!(!vehicles::all().is_empty(), "src/data/vehicles.json must parse into Vehicle");
    for v in vehicles::all() {
        assert_eq!(lookup(&v.code).as_ref(), Some(v), "{}", v.code);
    }
}

#[test]
fn catalog_codes_match_case_insensitively() {
    let tiger = resolve("GERM_PZKPFW_VI_AUSF_B_TIGER_IIH");
    assert_eq!(tiger.code, "germ_pzkpfw_VI_ausf_b_tiger_IIH", "the catalog spelling wins");
    assert_eq!(tiger.name, "Tiger II (H)");
    assert_eq!(tiger.nation, Nation::Ger);
    assert_eq!(tiger.vehicle_type, VehicleType::Ground);

    let t34 = resolve(" ussr_t_34_85 ");
    assert_eq!((t34.name.as_str(), t34.nation, t34.class.as_str()), ("T-34-85", Nation::Ussr, "Medium tank"));

    let jet = resolve("F_4E");
    assert_eq!((jet.nation, jet.vehicle_type), (Nation::Usa, VehicleType::Air));
}

#[test]
fn unknown_codes_use_the_prefix_heuristic() {
    let cases = [
        ("germ_panther_d", Nation::Ger, VehicleType::Ground),
        ("us_m4a3e8_sherman", Nation::Usa, VehicleType::Ground),
        ("ussr_is_2_1944", Nation::Ussr, VehicleType::Ground),
        ("uk_centurion_mk_10", Nation::Gbr, VehicleType::Ground),
        ("jp_type_90", Nation::Jpn, VehicleType::Ground),
        ("cn_ztz_99a", Nation::Chn, VehicleType::Ground),
        ("it_centauro_120", Nation::Ita, VehicleType::Ground),
        ("fr_amx_30b2", Nation::Fra, VehicleType::Ground),
        ("sw_strv_122a", Nation::Swe, VehicleType::Ground),
        ("il_merkava_mk_4m", Nation::Isr, VehicleType::Ground),
        ("Germ_Tiger_E", Nation::Ger, VehicleType::Ground),
        ("germ_destroyer_z20", Nation::Ger, VehicleType::Naval),
        ("us_pt_boat_103", Nation::Usa, VehicleType::Naval),
        ("uk_cruiser_belfast", Nation::Gbr, VehicleType::Naval),
        ("jp_battleship_yamato", Nation::Jpn, VehicleType::Naval),
        ("ussr_submarine_s_56", Nation::Ussr, VehicleType::Naval),
        ("bf-109f-4", Nation::Unknown, VehicleType::Air),
        ("p-51d-30_usaaf_korea", Nation::Unknown, VehicleType::Air),
        ("usa_thing", Nation::Unknown, VehicleType::Air),
    ];
    for (code, nation, vehicle_type) in cases {
        let v = resolve(code);
        assert_eq!((v.nation, v.vehicle_type), (nation, vehicle_type), "{code}");
        assert_eq!(v.code, code);
        assert_eq!(v.name, code, "the name falls back to the code");
        assert_eq!(v.class, "");
        assert_eq!(v.rank, None);
    }
}

#[test]
fn empty_code_is_the_unknown_vehicle() {
    let v = resolve("  ");
    assert_eq!(v, vehicles::unknown());
    assert_eq!((v.code.as_str(), v.name.as_str()), ("", UNKNOWN_NAME));
    assert_eq!((v.nation, v.vehicle_type), (Nation::Unknown, VehicleType::Air));
}

#[test]
fn folder_names_resolve_only_when_they_are_codes() {
    // Template folders carry the code after the prefix.
    assert_eq!(from_folder_name("template_ussr_t_34_85").name, "T-34-85");
    assert_eq!(from_folder_name("Template_bf-109f-4").code, "bf-109f-4");
    assert_eq!(from_folder_name("template_germ_maus").nation, Nation::Ger);
    // A bare catalog code or a nation-prefixed code also counts.
    assert_eq!(from_folder_name("su_27").name, "Su-27");
    assert_eq!(from_folder_name("uk_challenger_2").nation, Nation::Gbr);
    // Free-form names and empty codes are unknown.
    for folder in ["Berlin 1945", "My Test Camo", "bf-109f-4", "template_", "template_My Camo"] {
        assert_eq!(from_folder_name(folder), vehicles::unknown(), "{folder}");
    }
}
