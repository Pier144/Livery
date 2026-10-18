# Releasing Livery

How the Windows installer is built, how to turn on code signing, and how a release goes out. The configuration lives in `src-tauri/tauri.conf.json` (`bundle`), `.github/workflows/release.yml` and `.github/workflows/ci.yml`.

> The repository lives at <https://github.com/Pier144/Livery>. Check the first CI run there before tagging a release.

## What gets built

`pnpm tauri build` produces one NSIS installer: `src-tauri/target/release/bundle/nsis/Livery_<version>_x64-setup.exe` (about 1.8 MB for 0.1.0).

| Setting (`bundle.windows.nsis`) | Value | Effect |
|---|---|---|
| `installMode` | `currentUser` | Per-user install into `%LOCALAPPDATA%\Livery`, no administrator prompt, registry entries under `HKCU`. |
| `languages` + `displayLanguageSelector` | English, Italian, German, Russian, French, Spanish, Polish, PortugueseBR, SimpChinese; `true` | The installer and uninstaller open with a language picker; the Windows language is preselected (English if it's none of them). Tauri ships its own strings for all but Polish. |
| `customLanguageFiles` | `{ "Polish": "nsis/Polish.nsh" }` | Polish texts for the pages Tauri adds (tauri-bundler 2.11 has no Polish file); NSIS's own Polish covers the rest. Keep its keys in step with Tauri's `English.nsh` when Tauri is updated. |
| `installerIcon` | `icons/icon.ico` | The app icon (the paint bucket on graphite) on the setup executable. |
| `compression` | `lzma` | Smallest installer. |
| `startMenuFolder` | `Livery` | Shortcut at `Start Menu\Programs\Livery\Livery.lnk`. |

Other behaviour worth knowing:

- **WebView2:** left at Tauri's default (`downloadBootstrapper`, silent). If the runtime is missing, which is rare on Windows 10 and doesn't happen on 11, the installer downloads it, so it needs a connection in that case.
- **Uninstall** removes the program and offers a "delete app data" checkbox (`%APPDATA%\app.livery.desktop`: settings, following, library indexes). It never touches the game folder, so skins in `UserSkins` and the backups in `.livery\backups` (next to `UserSkins`; inside it up to 0.5.1) stay.
- **Publisher:** not set, so Tauri uses the middle segment of the identifier: "livery", shown in Settings → Apps. It also names the registry key `HKCU\Software\livery\Livery`. Decide the publisher (and the identifier, `app.livery.desktop` today) **before the first public release**: changing either later splits upgrades from existing installs (the identifier also moves the app data folder).
- **Updater:** on (see "Updates" below). `createUpdaterArtifacts: true` makes `tauri build` also write `<installer>.sig`, so **every build needs the updater signing key** in `TAURI_SIGNING_PRIVATE_KEY`.

**Linux:** on Linux `tauri build` also reads `src-tauri/tauri.linux.conf.json`, which makes the bundle an AppImage (`bundle/appimage/Livery_<version>_amd64.AppImage` plus its `.sig`). It is the only Linux format for now: the updater can replace an AppImage, not a `.deb`. Build it on the oldest Ubuntu you support (CI: 22.04) so it runs on older glibc. Locally, without the signing key: `pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

### Build locally

```bash
pnpm install
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/livery-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build
```

`tauri build` runs `pnpm build` (tsc + vite), cargo `--release`, makensis, then signs the installer for the updater. Without the key it stops with an error after building; `pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'` builds an installer without the `.sig` (fine for a local try, not for a release).

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

### Getting a certificate (individual, open source)

Checked on 2026-10-15 without buying anything; prices and eligibility change, so confirm on each provider's site.

| Option | Fit for Livery | What to know |
|---|---|---|
| **Certum "Open Source Code Signing"** (Asseco, Poland) | The most likely fit: issued to individuals who maintain open-source projects, EU-based identity check. | Paid (yearly). The key lives on a Certum card/token or their SimplySign cloud, not in a `.pfx`, so it goes through way **B** (`signCommand` with signtool + their tool). The signer shown by Windows is your legal name, not "Pier144". |
| **SignPath Foundation** | **The chosen way** (2026-10-16): free for open-source projects, signs in CI. See way **C**. | Reviews the project first and expects every shipped component under an OSI licence. Since 2026-10-16 Livery ships no UnRAR code (RAR is decoded by the user's 7-Zip or WinRAR), so nothing proprietary is left in the build. The signer Windows shows is "SignPath Foundation". |
| **Azure Artifact Signing** (Microsoft; was Trusted Signing) | Cheapest per month and integrates with signtool (way **B**). | Identity validation for individuals was limited to some countries (US/Canada) when last checked: verify it's open in Italy. |
| Classic OV certificate (DigiCert, Sectigo resellers…) | Works with way **A** or **B**. | Most expensive for an individual; since 2023 keys must be on hardware tokens, so no plain `.pfx`. |

Any of them removes "Unknown publisher", but SmartScreen can still warn until the certificate builds reputation (downloads over time). EV certificates no longer skip that step. Until then the release notes explain "More info → Run anyway", and the updater's own minisign signature keeps updates safe either way.

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

### C. SignPath Foundation (free, open source)

SignPath signs files that a GitHub workflow uploads, outside the build, and only after a person approves each request on signpath.io. `release.yml` has this wired and **off** until the secret and variable below exist. With it on, the build runs in three parts:

1. `pnpm tauri build --ci` (without updater artifacts) builds `livery.exe` and a first installer; bundling writes the bundle type into the exe, so this has to happen before the exe is signed. The exe is uploaded and signed (configuration `exe`).
2. The signed exe goes back in place and `pnpm tauri bundle` builds the NSIS installer again around it, without the updater signature (the bundle type is already written, so the exe isn't changed: checked on 2026-10-16, same SHA-256 before and after); the installer is uploaded and signed (configuration `installer`).
3. `pnpm tauri signer sign` writes `<installer>.sig` for the **signed** installer (signing changes the file, so the updater signature must come last). The usual steps then write the checksum, `latest.json` and the draft release, and "Verify the SignPath signatures" checks both files.

Each release therefore waits for **two approvals** on signpath.io (the run waits up to an hour for each). The uninstaller inside the installer stays unsigned: Tauri signs it only while it builds the installer, which SignPath can't do.

**One-time setup, after SignPath Foundation accepts the project:**

1. In SignPath: add the predefined **GitHub.com** trusted build system and link it to the project; install the SignPath GitHub App on the repository. All team members (just you) need multi-factor authentication on GitHub and SignPath.
2. Create the project (slug `Livery`), a signing policy `release-signing` with the Foundation's certificate and you as approver, and two artifact configurations. SignPath's onboarding gives the final form; a starting point, with the metadata restriction the Foundation asks for:

   `exe`:
   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <pe-file product-name="Livery">
       <authenticode-sign/>
     </pe-file>
   </artifact-configuration>
   ```
   `installer`: the same, for `Livery_<version>_x64-setup.exe` (Tauri writes the product name into both files).
3. In GitHub → Settings → Secrets and variables → Actions: the **secret** `SIGNPATH_API_TOKEN` (a CI user with the submitter role) and the **variable** `SIGNPATH_ORGANIZATION_ID`. The slugs default to `Livery`, `release-signing`, `exe` and `installer`; set the variables `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_EXE_CONFIGURATION` or `SIGNPATH_INSTALLER_CONFIGURATION` only if you named them otherwise.
4. Run the release. "Check for SignPath" prints `SignPath: on`; approve the two requests on signpath.io when the run waits for them.

`signpath/github-action-submit-signing-request` is the only action not from `actions/*` (SignPath verifies the build's origin through it); it is pinned to the commit of its `v3.0` tag. A certificate of your own (way A) and SignPath can't both be on: the run stops if it finds both.

### Check a signed build

```powershell
Get-AuthenticodeSignature .\Livery_0.1.0_x64-setup.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
```

Also check `livery.exe` after installing. Both need `Status: Valid` and a timestamp.

## CI

`ci.yml` runs on every push and pull request. The `check` job, on `windows-latest`:

1. Node 24 + pnpm 10.32.1 through corepack, cached pnpm store, `pnpm install --frozen-lockfile`.
2. `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm build`.
3. Fails if `dist/` contains `mockCall|mockListen|livery.mock|mockDetectGame` or a file named `*mock*` (the dev mock backend must never ship).
4. Rust stable with clippy and rustfmt through rustup; cached cargo registry (keyed on `Cargo.lock`) and `src-tauri/target` (keyed on the rustc version and `Cargo.lock`); `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.

The `linux` job, on `ubuntu-22.04`, installs the WebKitGTK libraries, builds the frontend and runs `cargo clippy --all-targets -- -D warnings` and `cargo test` against the Linux side (rustfmt and the frontend checks run once, in the Windows job).

A push to a branch with an open pull request runs twice (once per event). Restrict `push` to `main` and tags if that gets noisy.

## Updates

Livery updates itself with `tauri-plugin-updater` (Rust side only, `src-tauri/src/update.rs`; Settings → Updates).

- **Feed:** `https://github.com/Pier144/Livery/releases/latest/download/latest.json` (`plugins.updater.endpoints`). GitHub's `latest` is the newest **published**, non-prerelease release, so drafts are never offered. `release.yml` writes `latest.json` with `scripts/updater-manifest.mjs`: version, notes link, date, and for `windows-x86_64` the installer's release URL and its signature. The `linux` job of `release.yml` runs after the Windows one: it downloads that `latest.json` from the draft, adds `linux-x86_64` (the AppImage) with the same script, and uploads it again with the AppImage, its `.sig`, `.sha256` and a fixed-name copy `Livery-x86_64.AppImage`. Re-running only the Windows job rewrites `latest.json` without the Linux entry: re-run the Linux job after it.
- **Signature:** every update is checked against the minisign public key in `plugins.updater.pubkey` before it runs. The private key is `~/.tauri/livery-updater.key` on the author's machine (no password) and the **`TAURI_SIGNING_PRIVATE_KEY`** repository secret (its file content; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` stays unset). **Back the key up.** If it's lost, installed copies can't verify any new version: they would need a manual reinstall of a build with a new public key. Never commit it.
- **Install:** the NSIS installer runs in passive mode (`plugins.updater.windows.installMode`): a small progress window, no questions, then Livery opens again on the new version.
- **Manual:** Settings → Updates → Check now → Install and restart.
- **At launch:** 3 s after Livery opens it checks once and, for a newer version, opens a popup (Install and restart / Later). Later hides it for that version until the next launch.
- **Automatic** (Settings → Updates → Install updates automatically, on by default): release builds check 15 s after launch and every 6 hours, download a newer version in the background (toast "Livery X is ready…") and install it when Livery closes, without reopening it. Debug builds (`pnpm tauri dev`) only check by hand, so a dev session never replaces the installed app.

## Cut a release

0. Re-read Gaijin's terms (https://legal.gaijin.net/termsofservice, /contribution, /contentrules, /community-guidelines-live-sandbox): if the dates changed since the last release, check what changed before releasing. Run `pnpm notices` if `Cargo.lock` changed (needs `cargo install cargo-about --locked --features cli`), so `public/licenses/rust.txt` lists the crates being shipped.
1. Bump the version in **three** places: `package.json`, `src-tauri/Cargo.toml` (then `cargo check --manifest-path src-tauri/Cargo.toml` to refresh `Cargo.lock`) and `src-tauri/tauri.conf.json`. The installer name and the tag check use `tauri.conf.json`.
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```
3. `release.yml` checks that the tag matches `v<tauri.conf.json version>`, builds (signing if configured) and creates a **draft** release `v0.2.0` with the installer, its `.sha256`, its updater `.sig`, `latest.json` and `THIRD-PARTY-NOTICES.txt`. The notes start with `.github/release-notes.md` (disclaimer, install/update and SmartScreen help, an empty "What's new") followed by GitHub's generated changelog.
4. Wait for CI to pass on the tagged commit, install the draft's installer on a clean Windows 11 VM (M6 acceptance: first run to first installed skin in under 2 minutes), fill in "What's new" for players, then publish the draft by hand. **Publishing is what ships the update:** from that moment every installed Livery finds it.

**Run it by hand** (Actions → Release → Run workflow): drafts `v<tauri.conf.json version>` on the selected branch's commit. The tag is created when you publish the draft. Re-running for the same version replaces the draft's files; a version that is already published fails with a message: bump it.

The workflow needs only `GITHUB_TOKEN` with `contents: write` (declared in the workflow). If the repository limits the default token to read-only, the explicit `permissions` block still grants it.

## Remote

`origin` is <https://github.com/Pier144/Livery> (`git push -u origin main`). Actions must be enabled for the repository, and the CI run on the commit you tag must be green before you tag it.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Installer | NSIS only, per user (`currentUser`), the app's nine languages with the language picker, lzma, Start menu folder "Livery", app icon on the installer. | No admin rights needed; the author is Italian; smallest file. |
| Signing placeholder | `certificateThumbprint: null`, `digestAlgorithm: "sha256"`, `timestampUrl: ""` in `tauri.conf.json`. CI signs through a `--config` overlay only when the secret exists. | Unsigned builds work everywhere today; turning signing on needs no change to the committed config. |
| Signing inside the build | Signing happens in `tauri build`, not on the finished installer. | The app exe and the uninstaller get signed too. |
| Draft releases only | CI never publishes; a person does, after the VM test. | Acceptance on a clean VM comes before users see it. |
| Official actions only | `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`, `actions/upload-artifact@v7`; the rest are shell steps with preinstalled tools (rustup, gh, pwsh). One exception, off until SignPath is set up: SignPath's own action, pinned to a commit (way C). | The author: no third-party actions. SignPath's origin check works only through its action. |
| Node 24, pnpm pinned | Node 24 because it still bundles corepack (Node 25+ doesn't); pnpm 10.32.1 pinned in both workflows (`PNPM_VERSION`). | `package.json` has no `packageManager` field; the pin keeps CI on the version that wrote the lockfile. Update both workflows when you upgrade pnpm locally. |
| Release caches | Restore-only for the pnpm store and cargo registry; the release build starts from a clean `target/`. | A release never writes caches, and its binaries don't depend on a cached build. |
| Updater | `tauri-plugin-updater`, Rust side only; feed = `latest.json` on the latest published GitHub release; passive NSIS install; automatic updates install on close. | Approved by the author on 2026-10-15. No JS plugin package or extra capability: the commands are Livery's own (`check_update`, `install_update`). |
