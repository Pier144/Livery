//! The vehicle list read from the real War Thunder install (ignored: it reads the machine's
//! game files, read-only). `cargo test --test game_catalog_real -- --ignored --nocapture`.

use livery_lib::game::catalog::read_catalog;
use livery_lib::game::{detect, DetectInputs};
use livery_lib::model::{Nation, VehicleType};
use std::collections::BTreeMap;
use std::path::Path;

#[test]
#[ignore = "reads the real War Thunder install"]
fn reads_the_real_vehicle_list() {
    let detection = detect(&DetectInputs::from_system(None), |_| {});
    let Some(path) = detection.path else {
        println!("War Thunder not found");
        return;
    };
    let started = std::time::Instant::now();
    let catalog = read_catalog(Path::new(&path)).unwrap();
    println!(
        "{} vehicles, version {:?}, {} ms",
        catalog.vehicles.len(),
        catalog.version,
        started.elapsed().as_millis()
    );
    let mut by_class: BTreeMap<(String, String), usize> = BTreeMap::new();
    for v in &catalog.vehicles {
        *by_class.entry((format!("{:?}", v.vehicle_type), v.class.clone())).or_default() += 1;
    }
    for ((ty, class), n) in &by_class {
        println!("  {ty:6} {class:20} {n}");
    }
    for code in
        ["germ_leopard_2a6", "su_27", "it_c1_ariete", "f_4e", "germ_pzkpfw_VI_ausf_b_tiger_IIH", "uk_destroyer_daring"]
    {
        println!("  {code}: {:?}", catalog.vehicles.iter().find(|v| v.code.eq_ignore_ascii_case(code)));
    }
    assert!(catalog.vehicles.len() > 2000);
    let leopard = catalog.vehicles.iter().find(|v| v.code == "germ_leopard_2a6").unwrap();
    assert_eq!((leopard.nation, leopard.vehicle_type), (Nation::Ger, VehicleType::Ground));
    assert_eq!(leopard.name, "Leopard 2A6");
    assert!(catalog.vehicles.iter().all(|v| !v.name.is_empty() && v.nation != Nation::Unknown));
}
