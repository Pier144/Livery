//! The CLI's argument parser. Pure: it reads `std::env::args_os()` (minus the program and
//! `--livery-cli`) and, for `project put -`, the standard input it is handed, and returns a typed
//! [`CliCommand`]. Everything it can check without the game or the page (ranges, files, folders)
//! is checked here, so a bad line fails before any window opens.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::AtelierProject;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf, Prefix};
use std::time::Duration;

pub const CLI_ARG: &str = "--livery-cli";

/// Every command line, as in the spec's table. Appended to each usage error.
const USAGE: &str = "Usage: livery --livery-cli <command>
  vehicles [--query <text>]
  vehicle-info <code>
  project new <name> <vehicle>
  project list
  project get <id>
  project put <file|->
  import-image <id> <file> [--cutout]
  place <id> --view <view> --at <x>,<y> [--part hull|turret|gun] [--width <m>] [--height <m>] [--depth <m>]
  render <id> --out <dir> [--views <list>] [--size <px>] [--grid] [--flat]
  apply <id>
A view is front, side, rear, top or orbit:<theta>,<phi>,<zoom>.";

const QUICK_VIEWS: [&str; 4] = ["front", "side", "rear", "top"];
const ZOOM_MIN: f64 = 0.15;
const ZOOM_MAX: f64 = 6.0;
/// The editor's polar clamp is a hair inside 0..π; the same bounds here keep a typed orbit legal.
const PHI_MIN: f64 = 0.01;
const PHI_MAX: f64 = std::f64::consts::PI - 0.01;
const SIZE_MIN: u32 = 256;
const SIZE_MAX: u32 = 2048;
const SIZE_DEFAULT: u32 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PartGroupArg {
    Hull,
    Turret,
    Gun,
}

/// A view as typed: a quick view name or an orbit. Checked here, turned into a camera by the page.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ViewArg {
    /// front | side | rear | top
    Quick {
        name: String,
    },
    Orbit {
        theta: f64,
        phi: f64,
        zoom: f64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum CliCommand {
    Vehicles {
        query: Option<String>,
    },
    VehicleInfo {
        vehicle: String,
    },
    ProjectNew {
        name: String,
        vehicle: String,
    },
    ProjectList,
    ProjectGet {
        id: String,
    },
    ProjectPut {
        project: AtelierProject,
    },
    ImportImage {
        id: String,
        file: PathBuf,
        cutout: bool,
    },
    Place {
        id: String,
        view: ViewArg,
        at: (f64, f64),
        part: Option<PartGroupArg>,
        width: Option<f64>,
        height: Option<f64>,
        depth: Option<f64>,
    },
    Render {
        id: String,
        out: PathBuf,
        views: Vec<ViewArg>,
        size: u32,
        grid: bool,
        flat: bool,
    },
    Apply {
        id: String,
    },
}

impl CliCommand {
    /// The job the page runs, for the commands that need the GPU; `None` for the ones Rust
    /// answers by itself. The shape is read by `src/cli/job.ts`: keep the two in step. The
    /// `--out` folder is never in it: files reach disk only through `cli_file`.
    pub fn page_job(&self) -> Option<serde_json::Value> {
        use serde_json::json;
        match self {
            CliCommand::ProjectPut { project } => Some(json!({ "command": "put", "project": project })),
            CliCommand::VehicleInfo { vehicle } => Some(json!({ "command": "vehicleInfo", "vehicle": vehicle })),
            CliCommand::Place { id, view, at, part, width, height, depth } => Some(json!({
                "command": "place",
                "id": id,
                "view": view,
                "at": [at.0, at.1],
                "part": part,
                "width": width,
                "height": height,
                "depth": depth,
            })),
            CliCommand::Render { id, views, size, grid, flat, .. } => Some(json!({
                "command": "render",
                "id": id,
                "views": views,
                "size": size,
                "grid": grid,
                "flat": flat,
            })),
            CliCommand::Apply { id } => Some(json!({ "command": "apply", "id": id })),
            CliCommand::Vehicles { .. }
            | CliCommand::ProjectNew { .. }
            | CliCommand::ProjectList
            | CliCommand::ProjectGet { .. }
            | CliCommand::ImportImage { .. } => None,
        }
    }

    /// How long the whole run may take before it ends with `timeout`. Apply bakes, encodes and
    /// installs every slot, so it gets longer.
    pub fn timeout(&self) -> Duration {
        match self {
            CliCommand::Apply { .. } => Duration::from_secs(300),
            _ => Duration::from_secs(120),
        }
    }
}

/// `args`: everything after `--livery-cli`. `stdin`: read only for `project put -`.
pub fn parse(args: &[OsString], stdin: &mut dyn std::io::Read) -> AppResult<CliCommand> {
    let mut words = Vec::with_capacity(args.len());
    for (i, arg) in args.iter().enumerate() {
        match arg.to_str() {
            Some(s) => words.push(s.to_owned()),
            None => return Err(bad(format!("argument {} ({}) is not valid UTF-8", i + 1, arg.to_string_lossy()))),
        }
    }
    let Some((command, rest)) = words.split_first() else {
        return Err(bad("missing command"));
    };
    match command.as_str() {
        "vehicles" => {
            let mut a = scan(rest, &["--query"], &[], 0)?;
            Ok(CliCommand::Vehicles { query: a.value("--query") })
        }
        "vehicle-info" => {
            let a = scan(rest, &[], &[], 1)?;
            Ok(CliCommand::VehicleInfo { vehicle: a.pos(0) })
        }
        "project" => parse_project(rest, stdin),
        "import-image" => {
            let a = scan(rest, &[], &["--cutout"], 2)?;
            let file = PathBuf::from(a.pos(1));
            if !file.is_file() {
                return Err(AppError::new(ErrorCode::NotFound, "Image file not found")
                    .with_detail(format!("{} is not an existing file", file.display())));
            }
            Ok(CliCommand::ImportImage { id: a.pos(0), file: plain(&file)?, cutout: a.switch("--cutout") })
        }
        "place" => {
            let mut a = scan(rest, &["--view", "--at", "--part", "--width", "--height", "--depth"], &[], 1)?;
            let view = a.value("--view").ok_or_else(|| bad("place needs --view"))?;
            let mut views = parse_views(&view)?;
            if views.len() != 1 {
                return Err(bad("--view takes exactly one view"));
            }
            let at = parse_at(&a.value("--at").ok_or_else(|| bad("place needs --at"))?)?;
            let part = a.value("--part").map(|p| parse_part(&p)).transpose()?;
            let width = a.value("--width").map(|v| parse_positive("--width", &v)).transpose()?;
            let height = a.value("--height").map(|v| parse_positive("--height", &v)).transpose()?;
            let depth = a.value("--depth").map(|v| parse_positive("--depth", &v)).transpose()?;
            Ok(CliCommand::Place { id: a.pos(0), view: views.remove(0), at, part, width, height, depth })
        }
        "render" => {
            let mut a = scan(rest, &["--out", "--views", "--size"], &["--grid", "--flat"], 1)?;
            let out = PathBuf::from(a.value("--out").ok_or_else(|| bad("render needs --out"))?);
            if !out.is_dir() {
                return Err(bad(format!("--out must be an existing folder ({})", out.display())));
            }
            let views = match a.value("--views") {
                Some(list) => parse_views(&list)?,
                None => QUICK_VIEWS.iter().map(|n| ViewArg::Quick { name: (*n).to_owned() }).collect(),
            };
            let size = match a.value("--size") {
                Some(s) => parse_size(&s)?,
                None => SIZE_DEFAULT,
            };
            Ok(CliCommand::Render {
                id: a.pos(0),
                out: plain(&out)?,
                views,
                size,
                grid: a.switch("--grid"),
                flat: a.switch("--flat"),
            })
        }
        "apply" => {
            let a = scan(rest, &[], &[], 1)?;
            Ok(CliCommand::Apply { id: a.pos(0) })
        }
        other => Err(bad(format!("unknown command {other}"))),
    }
}

fn parse_project(rest: &[String], stdin: &mut dyn std::io::Read) -> AppResult<CliCommand> {
    let Some((sub, rest)) = rest.split_first() else {
        return Err(bad("project needs new, list, get or put"));
    };
    match sub.as_str() {
        "new" => {
            let a = scan(rest, &[], &[], 2)?;
            Ok(CliCommand::ProjectNew { name: a.pos(0), vehicle: a.pos(1) })
        }
        "list" => {
            scan(rest, &[], &[], 0)?;
            Ok(CliCommand::ProjectList)
        }
        "get" => {
            let a = scan(rest, &[], &[], 1)?;
            Ok(CliCommand::ProjectGet { id: a.pos(0) })
        }
        "put" => {
            let a = scan(rest, &[], &[], 1)?;
            let source = a.pos(0);
            let bytes = if source == "-" {
                let mut buf = Vec::new();
                stdin.read_to_end(&mut buf)?;
                buf
            } else {
                if !Path::new(&source).is_file() {
                    return Err(AppError::new(ErrorCode::NotFound, "Project file not found")
                        .with_detail(format!("{source} is not an existing file")));
                }
                std::fs::read(&source).map_err(|e| {
                    let detail = format!("{source}: {e}");
                    AppError::from(e).with_detail(detail)
                })?
            };
            let project = serde_json::from_slice::<AtelierProject>(&bytes).map_err(|e| {
                AppError::new(ErrorCode::InvalidInput, "Not an Atelier project").with_detail(e.to_string())
            })?;
            Ok(CliCommand::ProjectPut { project })
        }
        other => Err(bad(format!("unknown project command {other}"))),
    }
}

/// Usage error: what is wrong, then every command line.
fn bad(why: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::InvalidInput, "Bad arguments").with_detail(format!("{why}\n{USAGE}"))
}

/// A command's arguments split into positionals, value flags and switches.
struct Scanned {
    positionals: Vec<String>,
    values: HashMap<&'static str, String>,
    switches: HashSet<&'static str>,
}

impl Scanned {
    /// The `i`th positional (the count was checked by [`scan`]).
    fn pos(&self, i: usize) -> String {
        self.positionals[i].clone()
    }

    fn value(&mut self, flag: &str) -> Option<String> {
        self.values.remove(flag)
    }

    fn switch(&self, flag: &str) -> bool {
        self.switches.contains(flag)
    }
}

/// Splits `args` by the flags the command knows. A flag is known, takes a value or not, and
/// appears once; positionals must be exactly `positionals` many. A lone `-` is a positional (the
/// stdin marker of `project put`).
fn scan(
    args: &[String],
    value_flags: &[&'static str],
    switch_flags: &[&'static str],
    positionals: usize,
) -> AppResult<Scanned> {
    let mut out = Scanned { positionals: Vec::new(), values: HashMap::new(), switches: HashSet::new() };
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        i += 1;
        if !arg.starts_with("--") {
            out.positionals.push(arg.to_owned());
        } else if let Some(&flag) = value_flags.iter().find(|f| **f == arg) {
            let Some(value) = args.get(i).filter(|v| !v.starts_with("--")) else {
                return Err(bad(format!("{flag} needs a value")));
            };
            i += 1;
            if out.values.insert(flag, value.clone()).is_some() {
                return Err(bad(format!("{flag} given twice")));
            }
        } else if let Some(&flag) = switch_flags.iter().find(|f| **f == arg) {
            if !out.switches.insert(flag) {
                return Err(bad(format!("{flag} given twice")));
            }
        } else {
            return Err(bad(format!("unknown flag {arg}")));
        }
    }
    if out.positionals.len() != positionals {
        return Err(bad(format!("expected {positionals} argument(s), got {}", out.positionals.len())));
    }
    Ok(out)
}

fn parse_finite(what: &str, s: &str) -> AppResult<f64> {
    match s.parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(n),
        _ => Err(bad(format!("{what}: {s} is not a number"))),
    }
}

fn parse_positive(flag: &str, s: &str) -> AppResult<f64> {
    let n = parse_finite(flag, s)?;
    if n > 0.0 {
        Ok(n)
    } else {
        Err(bad(format!("{flag} must be greater than 0")))
    }
}

fn parse_size(s: &str) -> AppResult<u32> {
    match s.parse::<u32>() {
        Ok(n) if (SIZE_MIN..=SIZE_MAX).contains(&n) => Ok(n),
        _ => Err(bad(format!("--size must be a whole number from {SIZE_MIN} to {SIZE_MAX}"))),
    }
}

fn parse_part(s: &str) -> AppResult<PartGroupArg> {
    match s {
        "hull" => Ok(PartGroupArg::Hull),
        "turret" => Ok(PartGroupArg::Turret),
        "gun" => Ok(PartGroupArg::Gun),
        _ => Err(bad("--part must be hull, turret or gun")),
    }
}

/// `x,y`, both fractions of the picture.
fn parse_at(s: &str) -> AppResult<(f64, f64)> {
    let parts: Vec<&str> = s.split(',').collect();
    let [x, y] = parts.as_slice() else {
        return Err(bad("--at takes x,y"));
    };
    let (x, y) = (parse_finite("--at", x)?, parse_finite("--at", y)?);
    if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err(bad("--at fractions must be between 0 and 1"));
    }
    Ok((x, y))
}

/// A comma list of views. An orbit's own commas are kept by joining each `orbit:` item with the
/// two items after it.
fn parse_views(list: &str) -> AppResult<Vec<ViewArg>> {
    let mut items = list.split(',');
    let mut views = Vec::new();
    while let Some(item) = items.next() {
        if let Some(theta) = item.strip_prefix("orbit:") {
            let (Some(phi), Some(zoom)) = (items.next(), items.next()) else {
                return Err(bad("an orbit view is orbit:<theta>,<phi>,<zoom>"));
            };
            let theta = parse_finite("orbit theta", theta)?;
            let phi = parse_finite("orbit phi", phi)?;
            let zoom = parse_finite("orbit zoom", zoom)?;
            // One turn either way is every camera; the bound also keeps the view's file name short.
            if !(-std::f64::consts::TAU..=std::f64::consts::TAU).contains(&theta) {
                return Err(bad("orbit theta must be from -2 pi to 2 pi radians"));
            }
            if !(PHI_MIN..=PHI_MAX).contains(&phi) {
                return Err(bad(format!(
                    "orbit phi must be from {PHI_MIN} to pi - {PHI_MIN} (about {PHI_MAX:.4}) radians"
                )));
            }
            if !(ZOOM_MIN..=ZOOM_MAX).contains(&zoom) {
                return Err(bad(format!("orbit zoom must be between {ZOOM_MIN} and {ZOOM_MAX}")));
            }
            views.push(ViewArg::Orbit { theta, phi, zoom });
        } else if QUICK_VIEWS.contains(&item) {
            views.push(ViewArg::Quick { name: item.to_owned() });
        } else {
            return Err(bad(format!("unknown view {item:?}")));
        }
    }
    Ok(views)
}

/// The absolute path without Windows' `\\?\` prefix when it only spells out a drive: the paths the
/// CLI prints are for agents and tools that don't all understand the verbatim form. Built from
/// the path's components, so a name that isn't valid Unicode survives. Other prefixes (UNC,
/// device paths) stay as they are.
fn plain(path: &Path) -> AppResult<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    let mut parts = canonical.components();
    if let Some(Component::Prefix(prefix)) = parts.next() {
        if let Prefix::VerbatimDisk(letter) = prefix.kind() {
            let mut out = PathBuf::from(format!("{}:", char::from(letter)));
            for part in parts {
                out.push(part.as_os_str());
            }
            return Ok(out);
        }
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use serde_json::json;

    fn os(v: &[&str]) -> Vec<OsString> {
        v.iter().map(OsString::from).collect()
    }

    fn p(v: &[&str]) -> AppResult<CliCommand> {
        parse(&os(v), &mut std::io::empty())
    }

    fn invalid(v: &[&str]) -> AppError {
        let e = p(v).expect_err("should be refused");
        assert_eq!(e.code, ErrorCode::InvalidInput, "{e}");
        e
    }

    const PROJECT: &[u8] = br#"{"version":1,"id":"p1","name":"n","vehicle":"v","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","slots":[],"layers":[]}"#;

    fn quick(name: &str) -> ViewArg {
        ViewArg::Quick { name: name.into() }
    }

    #[test]
    fn render_defaults() {
        let dir = TestDir::new("args-render");
        let out = dir.path().to_str().unwrap();
        let CliCommand::Render { views, size, grid, flat, out: stored, .. } =
            p(&["render", "abc", "--out", out]).unwrap()
        else {
            panic!()
        };
        assert_eq!(views, vec![quick("front"), quick("side"), quick("rear"), quick("top")]);
        assert_eq!(size, 1024);
        assert!(!grid && !flat);
        assert!(stored.is_absolute() && stored.is_dir());
        assert!(!stored.to_string_lossy().starts_with(r"\\?\"), "the verbatim prefix is dropped");
        #[cfg(windows)]
        assert!(
            matches!(stored.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_))),
            "a plain drive path"
        );
    }

    #[test]
    fn render_takes_every_flag() {
        let dir = TestDir::new("args-render-all");
        let out = dir.path().to_str().unwrap();
        let CliCommand::Render { views, size, grid, flat, .. } =
            p(&["render", "abc", "--grid", "--views", "top", "--out", out, "--flat", "--size", "512"]).unwrap()
        else {
            panic!()
        };
        assert_eq!(views, vec![quick("top")]);
        assert_eq!(size, 512);
        assert!(grid && flat);
    }

    #[test]
    fn orbit_views_keep_their_commas() {
        let dir = TestDir::new("args-orbit");
        let out = dir.path().to_str().unwrap();
        let CliCommand::Render { views, .. } =
            p(&["render", "a", "--out", out, "--views", "front,orbit:0.5,1.2,1,top"]).unwrap()
        else {
            panic!()
        };
        assert_eq!(views, vec![quick("front"), ViewArg::Orbit { theta: 0.5, phi: 1.2, zoom: 1.0 }, quick("top")]);
    }

    #[test]
    fn orbit_bounds_and_shape() {
        let dir = TestDir::new("args-orbit-bad");
        let out = dir.path().to_str().unwrap();
        for views in [
            "orbit:0.5,1.2",     // too few numbers
            "orbit:0.5,1.2,0.1", // zoom under 0.15
            "orbit:0.5,1.2,6.1", // zoom over 6
            "orbit:0.5,0,1",     // phi under the clamp
            "orbit:0.5,3.15,1",  // phi over the clamp
            "orbit:x,1,1",       // not a number
            "orbit:inf,1,1",     // not finite
            "orbit:NaN,1,1",     // not finite
            "orbit:6.3,1,1",     // theta past one turn
            "orbit:-6.3,1,1",    // theta past one turn
            "left",              // unknown quick view
            "front,,top",        // empty item
            "",                  // empty list
        ] {
            invalid(&["render", "a", "--out", out, "--views", views]);
        }
        // The edges themselves are fine.
        assert!(p(&["render", "a", "--out", out, "--views", "orbit:-6.28,0.01,0.15,orbit:6.28,3.13,6"]).is_ok());
    }

    #[test]
    fn at_out_of_range_says_so_in_the_detail() {
        // A single dash is a value, not a flag: the range check must be the one that refuses it.
        for at in ["-0.1,0.5", "0.5,1.1"] {
            let detail = invalid(&["place", "a", "--view", "front", "--at", at]).detail.unwrap();
            assert!(detail.contains("--at fractions must be between 0 and 1"), "{detail}");
        }
    }

    #[test]
    fn phi_bounds_are_named_exactly() {
        let dir = TestDir::new("args-phi");
        let out = dir.path().to_str().unwrap();
        let detail = invalid(&["render", "a", "--out", out, "--views", "orbit:0.5,0,1"]).detail.unwrap();
        assert!(detail.contains("from 0.01 to pi - 0.01 (about 3.1316) radians"), "{detail}");
    }

    #[test]
    fn size_bounds() {
        let dir = TestDir::new("args-size");
        let out = dir.path().to_str().unwrap();
        for size in ["255", "2049", "0", "-1", "big", "1.5"] {
            invalid(&["render", "a", "--out", out, "--size", size]);
        }
        assert!(p(&["render", "a", "--out", out, "--size", "256"]).is_ok());
        assert!(p(&["render", "a", "--out", out, "--size", "2048"]).is_ok());
    }

    #[test]
    fn render_out_must_be_an_existing_folder() {
        let dir = TestDir::new("args-out");
        invalid(&["render", "a"]);
        let missing = dir.path().join("nope");
        invalid(&["render", "a", "--out", missing.to_str().unwrap()]);
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        invalid(&["render", "a", "--out", file.to_str().unwrap()]);
    }

    #[test]
    fn place_with_everything() {
        let CliCommand::Place { id, view, at, part, width, height, depth } = p(&[
            "place",
            "a",
            "--view",
            "orbit:0.5,1.2,1",
            "--at",
            "0.25,0.75",
            "--part",
            "turret",
            "--width",
            "0.8",
            "--height",
            "1.5",
            "--depth",
            "0.1",
        ])
        .unwrap() else {
            panic!()
        };
        assert_eq!(id, "a");
        assert_eq!(view, ViewArg::Orbit { theta: 0.5, phi: 1.2, zoom: 1.0 });
        assert_eq!(at, (0.25, 0.75));
        assert_eq!(part, Some(PartGroupArg::Turret));
        assert_eq!((width, height, depth), (Some(0.8), Some(1.5), Some(0.1)));
    }

    #[test]
    fn place_defaults_leave_the_options_empty() {
        let CliCommand::Place { part, width, height, depth, at, .. } =
            p(&["place", "a", "--view", "front", "--at", "0,1"]).unwrap()
        else {
            panic!()
        };
        assert_eq!(at, (0.0, 1.0));
        assert_eq!((part, width, height, depth), (None, None, None, None));
    }

    #[test]
    fn place_refuses_bad_points_views_and_sizes() {
        invalid(&["place", "a", "--view", "front", "--at", "1.2,0.5"]);
        invalid(&["place", "a", "--view", "front", "--at", "0.5,-0.1"]);
        invalid(&["place", "a", "--view", "front", "--at", "0.5"]);
        invalid(&["place", "a", "--view", "front", "--at", "0.5,0.5,0.5"]);
        invalid(&["place", "a", "--view", "front", "--at", "a,b"]);
        invalid(&["place", "a", "--view", "front"]);
        invalid(&["place", "a", "--at", "0.5,0.5"]);
        invalid(&["place", "a", "--view", "front,top", "--at", "0.5,0.5"]);
        invalid(&["place", "a", "--view", "front", "--at", "0.5,0.5", "--part", "wheel"]);
        for flag in ["--width", "--height", "--depth"] {
            for value in ["0", "-1", "inf", "wide"] {
                invalid(&["place", "a", "--view", "front", "--at", "0.5,0.5", flag, value]);
            }
        }
    }

    #[test]
    fn put_reads_stdin() {
        let cmd = parse(&os(&["project", "put", "-"]), &mut &PROJECT[..]).unwrap();
        assert!(matches!(cmd, CliCommand::ProjectPut { project } if project.id == "p1"));
    }

    #[test]
    fn put_reads_a_file() {
        let dir = TestDir::new("args-put");
        let file = dir.path().join("p.json");
        std::fs::write(&file, PROJECT).unwrap();
        let cmd = p(&["project", "put", file.to_str().unwrap()]).unwrap();
        assert!(matches!(cmd, CliCommand::ProjectPut { project } if project.vehicle == "v"));
    }

    #[test]
    fn put_refuses_a_missing_file_and_a_non_project() {
        let dir = TestDir::new("args-put-bad");
        let missing = dir.path().join("none.json");
        assert_eq!(p(&["project", "put", missing.to_str().unwrap()]).unwrap_err().code, ErrorCode::NotFound);
        // A folder is not a project file.
        assert_eq!(p(&["project", "put", dir.path().to_str().unwrap()]).unwrap_err().code, ErrorCode::NotFound);
        let e = parse(&os(&["project", "put", "-"]), &mut &b"{\"hello\":1}"[..]).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert_eq!(e.message, "Not an Atelier project");
        assert!(e.detail.is_some());
        let e = parse(&os(&["project", "put", "-"]), &mut &b""[..]).unwrap_err();
        assert_eq!(e.message, "Not an Atelier project");
    }

    #[test]
    fn the_no_page_commands() {
        assert_eq!(p(&["vehicles"]).unwrap(), CliCommand::Vehicles { query: None });
        assert_eq!(p(&["vehicles", "--query", "jumbo"]).unwrap(), CliCommand::Vehicles { query: Some("jumbo".into()) });
        assert_eq!(p(&["vehicle-info", "us_m4a3e2"]).unwrap(), CliCommand::VehicleInfo { vehicle: "us_m4a3e2".into() });
        assert_eq!(
            p(&["project", "new", "My skin", "us_m4a3e2"]).unwrap(),
            CliCommand::ProjectNew { name: "My skin".into(), vehicle: "us_m4a3e2".into() }
        );
        assert_eq!(p(&["project", "list"]).unwrap(), CliCommand::ProjectList);
        assert_eq!(p(&["project", "get", "p1"]).unwrap(), CliCommand::ProjectGet { id: "p1".into() });
        assert_eq!(p(&["apply", "p1"]).unwrap(), CliCommand::Apply { id: "p1".into() });
    }

    #[test]
    fn import_image_needs_an_existing_file() {
        let dir = TestDir::new("args-import");
        let file = dir.path().join("decal.png");
        std::fs::write(&file, b"png").unwrap();
        let CliCommand::ImportImage { id, file: stored, cutout } =
            p(&["import-image", "p1", file.to_str().unwrap(), "--cutout"]).unwrap()
        else {
            panic!()
        };
        assert_eq!(id, "p1");
        assert!(cutout && stored.is_file() && stored.is_absolute());
        let CliCommand::ImportImage { cutout, .. } = p(&["import-image", "p1", file.to_str().unwrap()]).unwrap() else {
            panic!()
        };
        assert!(!cutout);
        let missing = dir.path().join("none.png");
        assert_eq!(p(&["import-image", "p1", missing.to_str().unwrap()]).unwrap_err().code, ErrorCode::NotFound);
        // A folder is not an image.
        assert_eq!(p(&["import-image", "p1", dir.path().to_str().unwrap()]).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn bad_lines_are_usage_errors_with_the_usage() {
        for line in [
            &[][..],
            &["frobnicate"],
            &["project"],
            &["project", "frobnicate"],
            &["project", "new", "only-a-name"],
            &["project", "new", "a", "b", "c"],
            &["project", "list", "extra"],
            &["project", "get"],
            &["vehicle-info"],
            &["vehicle-info", "a", "b"],
            &["apply"],
            &["vehicles", "--query"],
            &["vehicles", "--query", "--other"],
            &["vehicles", "--query", "a", "--query", "b"],
            &["vehicles", "--nope"],
            &["vehicles", "positional"],
            &["apply", "p1", "--nope"],
            &["import-image", "p1"],
        ] {
            let e = invalid(line);
            assert_eq!(e.message, "Bad arguments");
            assert!(e.detail.unwrap().contains("Usage: livery --livery-cli"), "{line:?}");
        }
    }

    #[test]
    fn repeated_flags_are_refused() {
        let dir = TestDir::new("args-repeat");
        let out = dir.path().to_str().unwrap();
        invalid(&["render", "a", "--out", out, "--grid", "--grid"]);
        invalid(&["render", "a", "--out", out, "--out", out]);
        invalid(&["place", "a", "--view", "front", "--view", "top", "--at", "0.5,0.5"]);
    }

    #[cfg(windows)]
    #[test]
    fn non_utf8_arguments_are_refused() {
        use std::os::windows::ffi::OsStringExt;
        let broken = OsString::from_wide(&[0x61, 0xD800, 0x62]);
        let e = parse(&[OsString::from("project"), OsString::from("get"), broken], &mut std::io::empty()).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert!(e.detail.unwrap().contains("argument 3"));
    }

    #[test]
    fn page_jobs_are_exactly_what_the_page_reads() {
        let dir = TestDir::new("args-jobs");
        let out = dir.path().to_str().unwrap();

        let put = parse(&os(&["project", "put", "-"]), &mut &PROJECT[..]).unwrap();
        let job = put.page_job().unwrap();
        assert_eq!(job["command"], "put");
        assert_eq!(job["project"]["id"], "p1");
        assert_eq!(job["project"]["createdAt"], "2026-01-01T00:00:00Z");

        assert_eq!(
            p(&["vehicle-info", "us_m4a3e2_sherman_jumbo"]).unwrap().page_job().unwrap(),
            json!({"command":"vehicleInfo","vehicle":"us_m4a3e2_sherman_jumbo"})
        );
        assert_eq!(
            p(&["place", "p1", "--view", "front", "--at", "0.5,0.4"]).unwrap().page_job().unwrap(),
            json!({"command":"place","id":"p1","view":{"kind":"quick","name":"front"},"at":[0.5,0.4],
                   "part":null,"width":null,"height":null,"depth":null})
        );
        assert_eq!(
            p(&[
                "place",
                "p1",
                "--view",
                "orbit:0.5,1.2,1",
                "--at",
                "0.1,0.9",
                "--part",
                "gun",
                "--width",
                "2",
                "--height",
                "3",
                "--depth",
                "0.25"
            ])
            .unwrap()
            .page_job()
            .unwrap(),
            json!({"command":"place","id":"p1","view":{"kind":"orbit","theta":0.5,"phi":1.2,"zoom":1.0},
                   "at":[0.1,0.9],"part":"gun","width":2.0,"height":3.0,"depth":0.25})
        );
        assert_eq!(
            p(&["render", "p1", "--out", out, "--views", "orbit:0.5,1.2,1", "--grid"]).unwrap().page_job().unwrap(),
            json!({"command":"render","id":"p1","views":[{"kind":"orbit","theta":0.5,"phi":1.2,"zoom":1.0}],
                   "size":1024,"grid":true,"flat":false})
        );
        assert_eq!(p(&["apply", "p1"]).unwrap().page_job().unwrap(), json!({"command":"apply","id":"p1"}));
        for line in [&["vehicles"][..], &["project", "new", "n", "v"], &["project", "list"], &["project", "get", "p1"]]
        {
            assert!(p(line).unwrap().page_job().is_none(), "{line:?}");
        }
        let file = dir.path().join("a.png");
        std::fs::write(&file, b"x").unwrap();
        assert!(p(&["import-image", "p1", file.to_str().unwrap()]).unwrap().page_job().is_none());
    }

    #[test]
    fn apply_gets_longer_than_the_rest() {
        assert_eq!(p(&["apply", "p1"]).unwrap().timeout(), Duration::from_secs(300));
        assert_eq!(p(&["project", "list"]).unwrap().timeout(), Duration::from_secs(120));
        assert_eq!(
            p(&["place", "p1", "--view", "top", "--at", "0.5,0.5"]).unwrap().timeout(),
            Duration::from_secs(120)
        );
    }
}
