//! The CLI commands Rust answers by itself (no page, no GPU), and the checks that run before a
//! page job starts. They call the app's own `#[tauri::command]` functions, so they go through the
//! same checks (Atelier on, reading the game's data on) and give the same errors as the editor.

use super::args::CliCommand;
use super::output::CliError;
use crate::atelier;
use crate::error::{AppError, ErrorCode};
use crate::model::{AtelierProject, Vehicle};
use serde_json::{json, Value};
use tauri::AppHandle;

/// Runs a command that needs no page (`CliCommand::page_job` is `None`).
pub async fn run_rust(app: &AppHandle, command: &CliCommand) -> Result<Value, CliError> {
    let app = app.clone();
    match command {
        CliCommand::Vehicles { query } => {
            let list = crate::game::game_vehicles(app).await?;
            to_json(&filter_vehicles(list, query.as_deref()))
        }
        CliCommand::ProjectNew { name, vehicle } => {
            to_json(&atelier::atelier_project_create(app, name.clone(), vehicle.clone()).await?)
        }
        CliCommand::ProjectList => to_json(&atelier::atelier_projects(app).await?),
        CliCommand::ProjectGet { id } => to_json(&atelier::atelier_project_get(app, id.clone()).await?),
        CliCommand::ImportImage { id, file, cutout } => {
            let asset =
                atelier::atelier_import_image(app.clone(), id.clone(), file.to_string_lossy().into_owned()).await?;
            let mut answer = json!({ "asset": asset });
            if *cutout {
                let result = atelier::atelier_cutout(app, id.clone(), asset.id.clone()).await.map_err(|e| {
                    // The picture is in the project already: say which one, so it can be reused.
                    let e = CliError::from(e);
                    let imported = format!("imported as asset {}", asset.id);
                    let detail = match e.detail.clone() {
                        Some(d) => format!("{d}; {imported}"),
                        None => imported,
                    };
                    e.with_detail(detail)
                })?;
                answer["cutout"] = serde_json::to_value(result).map_err(internal)?;
            }
            Ok(answer)
        }
        CliCommand::VehicleInfo { .. }
        | CliCommand::ProjectPut { .. }
        | CliCommand::Place { .. }
        | CliCommand::Render { .. }
        | CliCommand::Apply { .. } => Err(CliError::new("internal", "Not a command Rust answers by itself")),
    }
}

/// What a page job needs from Rust before the window opens: `put` may only overwrite a stored
/// project of the same vehicle; `apply` needs the game's vehicle list loaded (CLI mode doesn't
/// preload it), so the library entry gets the vehicle's real name.
pub async fn before_page(app: &AppHandle, command: &CliCommand) -> Result<(), CliError> {
    match command {
        CliCommand::ProjectPut { project } => {
            let stored = atelier::atelier_project_get(app.clone(), project.id.clone()).await?;
            check_put(&stored, project)
        }
        CliCommand::Apply { .. } => {
            let app = app.clone();
            crate::blocking(move || {
                crate::game::current_vehicles(&app);
                Ok(())
            })
            .await?;
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `project put` replaces a project's layers and settings, never what it is for.
fn check_put(stored: &AtelierProject, incoming: &AtelierProject) -> Result<(), CliError> {
    if stored.vehicle != incoming.vehicle {
        return Err(CliError::new("invalidInput", "The project's vehicle can't change")
            .with_detail(format!("stored {}, given {}", stored.vehicle, incoming.vehicle)));
    }
    Ok(())
}

/// `vehicles --query`: a case-insensitive substring of the code or the English name.
fn filter_vehicles(list: Vec<Vehicle>, query: Option<&str>) -> Vec<Vehicle> {
    let Some(query) = query.map(str::to_lowercase).filter(|q| !q.is_empty()) else { return list };
    list.into_iter()
        .filter(|v| v.code.to_lowercase().contains(&query) || v.name.to_lowercase().contains(&query))
        .collect()
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<Value, CliError> {
    serde_json::to_value(value).map_err(internal)
}

fn internal(e: serde_json::Error) -> CliError {
    AppError::new(ErrorCode::Internal, "The answer can't be written as JSON").with_detail(e.to_string()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Nation, VehicleType};

    fn vehicle(code: &str, name: &str) -> Vehicle {
        Vehicle {
            code: code.into(),
            name: name.into(),
            nation: Nation::Usa,
            vehicle_type: VehicleType::Ground,
            class: "medium".into(),
            rank: None,
        }
    }

    fn codes(list: &[Vehicle]) -> Vec<&str> {
        list.iter().map(|v| v.code.as_str()).collect()
    }

    #[test]
    fn vehicles_match_code_or_name_ignoring_case() {
        let list = vec![
            vehicle("us_m4a3e2_sherman_jumbo", "M4A3E2"),
            vehicle("us_m4a3e2_76w_sherman_jumbo", "M4A3E2 (76) W"),
            vehicle("germ_pzkpfw_vi_ausf_e_tiger", "Tiger H1"),
        ];
        assert_eq!(
            codes(&filter_vehicles(list.clone(), Some("JUMBO"))),
            ["us_m4a3e2_sherman_jumbo", "us_m4a3e2_76w_sherman_jumbo"]
        );
        assert_eq!(codes(&filter_vehicles(list.clone(), Some("tiger h"))), ["germ_pzkpfw_vi_ausf_e_tiger"]);
        assert!(filter_vehicles(list.clone(), Some("panther")).is_empty());
        assert_eq!(filter_vehicles(list.clone(), None).len(), 3);
        assert_eq!(filter_vehicles(list, Some("")).len(), 3);
    }

    fn project(vehicle: &str) -> AtelierProject {
        serde_json::from_value(json!({
            "version": 1,
            "id": "p1",
            "name": "Test",
            "vehicle": vehicle,
            "createdAt": "2026-10-19T00:00:00Z",
            "updatedAt": "2026-10-19T00:00:00Z",
            "slots": [],
            "layers": [],
        }))
        .unwrap()
    }

    #[test]
    fn put_keeps_the_vehicle() {
        assert!(check_put(&project("us_m4a3e2_sherman_jumbo"), &project("us_m4a3e2_sherman_jumbo")).is_ok());
        let e = check_put(&project("us_m4a3e2_sherman_jumbo"), &project("germ_pzkpfw_vi_ausf_e_tiger")).unwrap_err();
        assert_eq!(e.code, "invalidInput");
        assert_eq!(e.exit_code(), 1);
    }
}
