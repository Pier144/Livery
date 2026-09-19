//! Collections (M3): named sets of hangar skins, stored in the library index. Activating one
//! makes exactly its skins active (their folders in `UserSkins`) and every other hangar skin
//! inactive (folders in `.livery/inactive`); Try in game skins stay where they are; nothing is
//! deleted.
//!
//! Plain functions over the store (plus `UserSkins` for `activate`); the commands below only
//! gather their inputs.

use super::index::{new_id_with, Library, LibraryStore};
use super::ops::{self, move_skins};
use super::{current_store, purge_expired, purge_in, required_store, time, GameLibrary};
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{Collection, CollectionsState, HangarSkin};
use std::collections::HashSet;
use std::path::Path;
use tauri::AppHandle;

fn not_found(id: &str) -> AppError {
    AppError::new(ErrorCode::NotFound, "Collection not found").with_detail(id)
}

/// A collection name: trimmed and not empty.
fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, "A collection needs a name"));
    }
    Ok(name.to_owned())
}

/// A description: trimmed; empty means none.
fn clean_description(description: &str) -> Option<String> {
    Some(description.trim()).filter(|d| !d.is_empty()).map(str::to_owned)
}

/// Every collection plus the one activated last.
pub fn list(store: &LibraryStore) -> CollectionsState {
    store.snapshot().collections_state()
}

/// A new, empty collection, appended to the list.
pub fn create(store: &LibraryStore, name: &str, description: Option<&str>) -> AppResult<Collection> {
    let collection = Collection {
        id: new_id_with("c"),
        name: clean_name(name)?,
        description: description.and_then(clean_description),
        skin_ids: Vec::new(),
        created_at: time::now_rfc3339(),
    };
    store.transact(|library, _| {
        library.collections.push(collection.clone());
        Ok(())
    })?;
    Ok(collection)
}

/// Renames and/or re-describes a collection: `None` leaves a field as it is, an empty
/// description clears it, a blank name is `invalidInput`.
pub fn update(store: &LibraryStore, id: &str, name: Option<&str>, description: Option<&str>) -> AppResult<Collection> {
    let name = name.map(clean_name).transpose()?;
    store.transact(|library, _| {
        let pos = library.collection_position(id).ok_or_else(|| not_found(id))?;
        let collection = &mut library.collections[pos];
        if let Some(name) = name {
            collection.name = name;
        }
        if let Some(description) = description {
            collection.description = clean_description(description);
        }
        Ok(collection.clone())
    })
}

/// Deletes a collection (its skins stay installed); clears the active collection if it was
/// this one.
pub fn delete(store: &LibraryStore, id: &str) -> AppResult<CollectionsState> {
    store.transact(|library, _| {
        let pos = library.collection_position(id).ok_or_else(|| not_found(id))?;
        library.collections.remove(pos);
        if library.active_collection_id.as_deref() == Some(id) {
            library.active_collection_id = None;
        }
        Ok(library.collections_state())
    })
}

/// Undo for `delete`: appends the collection as it was (same id). `conflict` if the id exists.
pub fn restore(store: &LibraryStore, collection: Collection) -> AppResult<CollectionsState> {
    if collection.id.trim().is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, "A collection needs an id"));
    }
    let mut seen = HashSet::new();
    let collection = Collection {
        name: clean_name(&collection.name)?,
        skin_ids: collection.skin_ids.into_iter().filter(|id| seen.insert(id.clone())).collect(),
        ..collection
    };
    store.transact(|library, _| {
        if library.collection_position(&collection.id).is_some() {
            return Err(AppError::new(ErrorCode::Conflict, "This collection already exists").with_detail(collection.id));
        }
        library.collections.push(collection);
        // Members that are gone for good meanwhile (purged, pruned) don't come back.
        library.drop_dangling_members();
        Ok(library.collections_state())
    })
}

/// Adds and removes members in one change: `add` appends skins not yet in it, in order, ignoring
/// ids that aren't in the index; `remove` takes ids out (it wins over `add`).
pub fn set_skins(store: &LibraryStore, id: &str, add: &[String], remove: &[String]) -> AppResult<Collection> {
    store.transact(|library, _| {
        let pos = library.collection_position(id).ok_or_else(|| not_found(id))?;
        let indexed: HashSet<&str> = library.skins.iter().map(|s| s.id.as_str()).collect();
        let removed: HashSet<&str> = remove.iter().map(String::as_str).collect();
        let collection = &mut library.collections[pos];
        let mut members: HashSet<String> = collection.skin_ids.iter().cloned().collect();
        for skin_id in ops::dedupe(add) {
            if indexed.contains(skin_id) && members.insert(skin_id.to_owned()) {
                collection.skin_ids.push(skin_id.to_owned());
            }
        }
        collection.skin_ids.retain(|skin_id| !removed.contains(skin_id.as_str()));
        Ok(collection.clone())
    })
}

/// Makes exactly the collection's skins active and every other hangar skin inactive, moving
/// folders as needed, and remembers the collection as the active one. A skin being tried in game
/// (`temporary`) stays where it is, member or not: it isn't in My Hangar, and Keep or Discard
/// decides what happens to it. Returns the whole index; skins that can't move are reported like
/// `set_active` does (the others still move).
pub fn activate(user_skins: &Path, store: &LibraryStore, id: &str) -> AppResult<Vec<HangarSkin>> {
    let (index, report) = store.transact(|library, journal| {
        let pos = library.collection_position(id).ok_or_else(|| not_found(id))?;
        let members: HashSet<String> = library.collections[pos].skin_ids.iter().cloned().collect();
        let report =
            move_skins(user_skins, library, journal, |skin| (!skin.temporary).then(|| members.contains(&skin.id)));
        library.active_collection_id = Some(id.to_owned());
        Ok((library.skins.clone(), report))
    })?;
    tracing::info!(active = index.iter().filter(|s| s.active).count(), "collection activated");
    report.into_result(index)
}

// ── Commands ────────────────────────────────────────────────────────────────
// Collections belong to the saved game folder's index: with none saved the list is empty and
// changes are `invalidInput` ("No game folder set").

#[tauri::command]
pub async fn collections_list(app: AppHandle) -> AppResult<CollectionsState> {
    blocking(move || {
        purge_expired(&app, &[]);
        Ok(current_store(&app).map_or_else(|| Library::default().collections_state(), |store| list(&store)))
    })
    .await
}

#[tauri::command]
pub async fn collections_create(app: AppHandle, name: String, description: Option<String>) -> AppResult<Collection> {
    blocking(move || {
        purge_expired(&app, &[]);
        let store = required_store(&app)?;
        create(&store, &name, description.as_deref())
    })
    .await
}

/// Renames and/or re-describes a collection (`None` = unchanged, empty description = cleared).
#[tauri::command]
pub async fn collections_update(
    app: AppHandle,
    id: String,
    name: Option<String>,
    description: Option<String>,
) -> AppResult<Collection> {
    blocking(move || {
        purge_expired(&app, &[]);
        let store = required_store(&app)?;
        update(&store, &id, name.as_deref(), description.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn collections_delete(app: AppHandle, id: String) -> AppResult<CollectionsState> {
    blocking(move || {
        purge_expired(&app, &[]);
        let store = required_store(&app)?;
        delete(&store, &id)
    })
    .await
}

/// Undo for `collections_delete`: puts the collection back as it was (same id).
#[tauri::command]
pub async fn collections_restore(app: AppHandle, collection: Collection) -> AppResult<CollectionsState> {
    blocking(move || {
        purge_expired(&app, &[]);
        let store = required_store(&app)?;
        restore(&store, collection)
    })
    .await
}

/// Adds and removes members in one call; unknown skin ids are ignored.
#[tauri::command]
pub async fn collections_set_skins(
    app: AppHandle,
    id: String,
    add: Vec<String>,
    remove: Vec<String>,
) -> AppResult<Collection> {
    blocking(move || {
        purge_expired(&app, &[]);
        let store = required_store(&app)?;
        set_skins(&store, &id, &add, &remove)
    })
    .await
}

/// Activates exactly the collection's skins and deactivates every other hangar skin (Try in
/// game skins stay where they are).
#[tauri::command]
pub async fn activate_collection(app: AppHandle, id: String) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let library = GameLibrary::current(&app)?;
        purge_in(&library, &[]);
        activate(&library.user_skins, &library.store, &id)
    })
    .await
}
