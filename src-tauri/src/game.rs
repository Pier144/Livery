//! Game detection (M2): Steam `libraryfolders.vdf` (appid 236390), standalone launcher paths,
//! custom folder; validates the root (`UserSkins/` or `aces.exe`/`launcher.exe`), reads the version
//! and counts existing skins. Emits `game://detect` per source.
