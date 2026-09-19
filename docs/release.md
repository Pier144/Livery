# Releasing Livery

How the Windows installer is built, how to turn on code signing, and how a release goes out. The configuration lives in `src-tauri/tauri.conf.json` (`bundle`), `.github/workflows/release.yml` and `.github/workflows/ci.yml`.

> **No remote yet.** The repository has no git remote, so neither workflow has ever run. Everything below works once the repo is pushed to GitHub (see [First push](#first-push)). Until then, build the installer locally.

## What gets built

`pnpm tauri build` produces one NSIS installer: `src-tauri/target/release/bundle/nsis/Livery_<version>_x64-setup.exe` (about 1.8 MB for 0.1.0).

| Setting (`bundle.windows.nsis`) | Value | Effect |
|---|---|---|
| `installMode` | `currentUser` | Per-user install into `%LOCALAPPDATA%\Livery`, no administrator prompt, registry entries under `HKCU`. |
| `languages` + `displayLanguageSelector` | `["English", "Italian"]`, `true` | The installer and uninstaller open with a language picker; the Windows language is preselected (English if it's neither). Tauri ships its own strings for both. |
| `installerIcon` | `icons/icon.ico` | The app icon (amber dot on graphite) on the setup executable. |
| `compression` | `lzma` | Smallest installer. |
| `startMenuFolder` | `Livery` | Shortcut at `Start Menu\Programs\Livery\Livery.lnk`. |

Other behaviour worth knowing:

- **WebView2:** left at Tauri's default (`downloadBootstrapper`, silent). If the runtime is missing, which is rare on Windows 10 and doesn't happen on 11, the installer downloads it, so it needs a connection in that case.
- **Uninstall** removes the program and offers a "delete app data" checkbox (`%APPDATA%\app.livery.desktop`: settings, following, library indexes). It never touches the game folder, so skins in `UserSkins` and the backups in `UserSkins\.livery\backups` stay.
- **Publisher:** not set, so Tauri uses the middle segment of the identifier: "livery", shown in Settings → Apps. It also names the registry key `HKCU\Software\livery\Livery`. Decide the publisher (and the identifier, see DESIGN_NOTES "App identifier") **before the first public release**: changing either later splits upgrades from existing installs (the identifier also moves the app data folder).
- **Updater:** off. There is no `tauri-plugin-updater` and `createUpdaterArtifacts` stays at its default (`false`). It needs the plugin approval, an updater signing key and a public endpoint (HANDOFF.md, "Pending dependency approvals").

### Build locally

```bash
pnpm install
pnpm tauri build            # pnpm build (tsc + vite), cargo --release, then makensis
```

The first bundle downloads NSIS into `%LOCALAPPDATA%\tauri\NSIS` (Tauri CLI does this by itself). Try the installer on a clean Windows 11 VM, not on your dev machine: it registers an uninstaller and Start menu entries.

## Code signing

Unsigned installers work, but SmartScreen warns "Windows protected your PC" until the file builds reputation. Signing is **prepared but off**:

```json
"windows": {
  "certificateThumbprint": null,
  "digestAlgorithm": "sha256",
  "timestampUrl": "",
  ...
}
```

Tauri signs only when `certificateThumbprint` or `signCommand` is set. When it signs, it signs `livery.exe`, the uninstaller and the setup executable, so signing has to happen **inside** `tauri build`: signing only the finished installer would leave the app itself unsigned.

**`timestampUrl` must become a real URL when you turn signing on.** Tauri passes it to signtool as is, and an empty string makes signtool fail. Use your certificate provider's RFC 3161 server with `"tsp": true` (signtool `/tr` + `/td sha256`); `http://timestamp.digicert.com` works for any certificate.

There are two ways to sign. Pick the one your certificate allows.

### A. A certificate file (.pfx), by thumbprint

For a certificate you hold as a `.pfx` with its private key. Since June 2023 new OV and EV certificates must keep the key on hardware or in a cloud HSM, so a new certificate usually can't be exported this way; then use B.

**In CI (already wired, off until the secret exists).** `release.yml` has a placeholder that runs only when the `WINDOWS_CERTIFICATE` secret is set: it imports the `.pfx` into the runner's `Cert:\CurrentUser\My`, writes a config overlay with its thumbprint, `digestAlgorithm: sha256`, the timestamp URL and `tsp: true`, and builds with `pnpm tauri build --config <overlay>`. A later step checks the installer's Authenticode signature against that thumbprint. Nothing in `tauri.conf.json` changes.

1. In GitHub → Settings → Secrets and variables → Actions, add two **repository secrets**:
   - `WINDOWS_CERTIFICATE`: the `.pfx` as base64. In PowerShell:
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\path\livery.pfx')) | Set-Clipboard`
   - `WINDOWS_CERTIFICATE_PASSWORD`: the `.pfx` password.
2. Optional **repository variable** `WINDOWS_TIMESTAMP_URL` (defaults to `http://timestamp.digicert.com`).
3. Run the release. The "Check for a signing certificate" step prints `Signing: on`.

The secrets reach only the two steps that need them, never the whole job, so dependency build scripts can't read them. Never commit a `.pfx`, its password or its base64 to the repo.

**Locally.** Import the `.pfx` into your user store (double-click it, or `Import-PfxCertificate -CertStoreLocation Cert:\CurrentUser\My`), read its thumbprint (`Get-ChildItem Cert:\CurrentUser\My`), then build with an overlay file kept **outside** the repo:

```json
{ "bundle": { "windows": {
  "certificateThumbprint": "<40 hex characters>",
  "timestampUrl": "http://timestamp.digicert.com",
  "tsp": true
} } }
```

```bash
pnpm tauri build --config C:/keys/livery-signing.json
```

Committing the thumbprint to `tauri.conf.json` instead is harmless (it isn't a secret), but then every build, CI included, fails on machines without that certificate.

### B. A cloud or hardware key, with `signCommand`

For Microsoft's cloud signing service (Trusted Signing, now Artifact Signing), SSL.com eSigner, DigiCert KeyLocker, a USB token and the like. `bundle.windows.signCommand` replaces signtool's defaults with any command; Tauri runs it once per file and substitutes `%1` with the file path. For example, signtool with a vendor's signing library (take the library, metadata file and timestamp server from the vendor's docs):

```json
"signCommand": {
  "cmd": "signtool.exe",
  "args": ["sign", "/v", "/fd", "sha256", "/tr", "<timestamp url>", "/td", "sha256",
           "/dlib", "<vendor dlib path>", "/dmdf", "<metadata.json>", "%1"]
}
```

What to change for B:
1. Put `signCommand` in the CI overlay (or in `tauri.conf.json` if every build should sign) and leave `certificateThumbprint` null.
2. In `release.yml`, replace the "Import the signing certificate" step with one that installs the vendor tool and writes that overlay. The vendor credentials become repository secrets passed as `env:` to that step and to "Build the installer" only (Tauri runs the command during the build). Install the tool with its own installer or CLI: the project uses official `actions/*` only, no third-party actions.
3. Update "Verify the signature" (it compares the signer with an imported thumbprint).

### Check a signed build

```powershell
Get-AuthenticodeSignature .\Livery_0.1.0_x64-setup.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
```

Also check `livery.exe` after installing. Both need `Status: Valid` and a timestamp.

## CI

`ci.yml` runs on every push and pull request, on `windows-latest`:

1. Node 24 + pnpm 10.32.1 through corepack, cached pnpm store, `pnpm install --frozen-lockfile`.
2. `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm build`.
3. Fails if `dist/` contains `mockCall|mockListen|livery.mock|mockDetectGame` or a file named `*mock*` (the dev mock backend must never ship).
4. Rust stable with clippy and rustfmt through rustup; cached cargo registry (keyed on `Cargo.lock`) and `src-tauri/target` (keyed on the rustc version and `Cargo.lock`); `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.

A push to a branch with an open pull request runs twice (once per event). Restrict `push` to `main` and tags if that gets noisy.

## Cut a release

1. Bump the version in **three** places: `package.json`, `src-tauri/Cargo.toml` (then `cargo check --manifest-path src-tauri/Cargo.toml` to refresh `Cargo.lock`) and `src-tauri/tauri.conf.json`. The installer name and the tag check use `tauri.conf.json`.
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```
3. `release.yml` checks that the tag matches `v<tauri.conf.json version>`, builds (signing if configured) and creates a **draft** release `v0.2.0` with the installer and its `.sha256`, with GitHub's generated notes.
4. Wait for CI to pass on the tagged commit, install the draft's installer on a clean Windows 11 VM (M6 acceptance: first run to first installed skin in under 2 minutes), edit the notes, then publish the draft by hand.

**Run it by hand** (Actions → Release → Run workflow): drafts `v<tauri.conf.json version>` on the selected branch's commit. The tag is created when you publish the draft. Re-running for the same version replaces the draft's files; a version that is already published fails with a message: bump it.

The workflow needs only `GITHUB_TOKEN` with `contents: write` (declared in the workflow). If the repository limits the default token to read-only, the explicit `permissions` block still grants it.

## First push

```bash
gh repo create <owner>/livery --private --source . --remote origin   # or create it on github.com
git push -u origin main
```

Then check that Actions are enabled for the repository, and that the first CI run is green before tagging.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Installer | NSIS only, per user (`currentUser`), English + Italian with the language picker, lzma, Start menu folder "Livery", app icon on the installer. | No admin rights needed; the author is Italian; smallest file. |
| Signing placeholder | `certificateThumbprint: null`, `digestAlgorithm: "sha256"`, `timestampUrl: ""` in `tauri.conf.json`. CI signs through a `--config` overlay only when the secret exists. | Unsigned builds work everywhere today; turning signing on needs no change to the committed config. |
| Signing inside the build | Signing happens in `tauri build`, not on the finished installer. | The app exe and the uninstaller get signed too. |
| Draft releases only | CI never publishes; a person does, after the VM test. | Acceptance on a clean VM (BUILD_PLAN M6) comes before users see it. |
| Official actions only | `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`; the rest are shell steps with preinstalled tools (rustup, gh, pwsh). | CLAUDE.md / author: no third-party actions. |
| Node 24, pnpm pinned | Node 24 because it still bundles corepack (Node 25+ doesn't); pnpm 10.32.1 pinned in both workflows (`PNPM_VERSION`). | `package.json` has no `packageManager` field; the pin keeps CI on the version that wrote the lockfile. Update both workflows when you upgrade pnpm locally. |
| Release caches | Restore-only for the pnpm store and cargo registry; the release build starts from a clean `target/`. | A release never writes caches, and its binaries don't depend on a cached build. |
| Updater | Not enabled. | Plugin not approved; it also needs a key and an endpoint. |
