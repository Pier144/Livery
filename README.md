<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="">
</p>

# Livery

**A free skin manager for War Thunder on Windows.** Browse community skins from WT Live, install
them with one click, and keep your `UserSkins` folder tidy.

> **Unofficial tool, not affiliated with Gaijin Entertainment.** War Thunder and WT Live are
> Gaijin's. Every skin belongs to its author: Livery shows who made it and links to the original
> post.

## What it does

- **Explore WT Live**: search, filter by nation, type, class and vehicle, follow authors and
  vehicles, and see what's new from them.
- **Install with one click**, or **try a skin in the game first** and keep it only if you like it.
- **Install from files**: drop a ZIP, 7z or RAR (or a folder) on the window, or let Livery watch
  your Downloads folder. Packs with several skins install every skin, each for its own vehicle.
- **My Hangar**: every installed skin with its picture, grouped by vehicle. Turn skins on and off,
  rename them (the name you see in the game's customisation menu changes too), uninstall them, and
  undo any of it.
- **Collections**: sets of skins you can switch on together.
- **Checks** each skin for missing textures and problems in its `.blk` file.
- **Updates itself**: it tells you when a new version is out, and can install it for you.
- English and Italian.

## Install

1. Download `Livery_<version>_x64-setup.exe` from the
   [latest release](https://github.com/Pier144/Livery/releases/latest).
2. Run it. It installs for your Windows user only and doesn't need administrator rights.
3. **"Windows protected your PC"**: the installer isn't code-signed yet, so Microsoft SmartScreen
   doesn't know it. Choose **More info → Run anyway**. Every release lists the installer's SHA-256
   so you can check the file, and updates are verified with Livery's own signature before they
   run.
4. On first launch Livery finds your War Thunder install (Steam or standalone) and offers to add
   the skins already in `UserSkins` to your Hangar.

Needs Windows 10 or 11 (64-bit) with the WebView2 runtime, which Windows 11 already has.

**Updates:** Livery checks for a new version a few seconds after it opens and asks you. In
Settings → Updates you can check by hand, or let it download new versions in the background and
install them when you close it.

**Uninstall:** Windows Settings → Apps → Livery. The installer offers to delete Livery's own data;
your skins in the game's `UserSkins` folder stay where they are.

## Privacy

No account, no ads, no telemetry. Livery connects only to:

- **WT Live** (`live.warthunder.com` and its image server `cdn-live.warthunder.com`), when you
  browse, open or install skins. It asks politely: one request a second at most, cached for a day,
  and never anything from Gaijin's Marketplace. You can turn WT Live off in Settings → WT Live.
- **GitHub**, to check for and download Livery updates.

Your settings, library and collections stay on your PC. Skins go only into the game's `UserSkins`
folder; Livery doesn't change any other game file.

**Reading the game's files.** To recognise which vehicle a skin is for, Livery reads the vehicle
names from the game's own data files (read-only, on your PC; nothing is changed or sent anywhere).
If you prefer it didn't, turn off Settings → Game → "Read the vehicle list from the game": Livery
then uses a smaller built-in list and recognises fewer skins.

## Questions and problems

- **A skin doesn't show in the game:** in War Thunder open the vehicle's Customisation and press
  the refresh button, then pick the skin. Skins that Livery marks "Needs attention" are missing a
  texture or have a broken `.blk`; the card says which.
- **Something went wrong:** [open an issue](https://github.com/Pier144/Livery/issues) with what you
  did and what you saw. Settings → About has a "Report a problem" link.

## In italiano

Livery è un gestore di skin per War Thunder, gratuito e non ufficiale (non affiliato a Gaijin
Entertainment). Ti permette di:

- sfogliare le skin di WT Live, installarle con un clic o provarle prima nel gioco;
- installare skin da ZIP, 7z, RAR o cartelle;
- rinominare, disattivare e disinstallare le skin dall'Hangar, sempre con la possibilità di
  annullare.

Scarica l'installer dall'[ultima release](https://github.com/Pier144/Livery/releases/latest). Se
Windows mostra "Windows ha protetto il PC", scegli **Ulteriori informazioni → Esegui comunque**:
l'installer non è ancora firmato. Livery si aggiorna da solo. Si collega solo a WT Live e a GitHub,
non raccoglie dati e non ha account.

## License

Livery is free software under the [MIT licence](LICENSE). It includes open-source libraries and
fonts under their own licences: every one, with its full text, is listed in the app (Settings →
About → Licenses) and in `THIRD-PARTY-NOTICES.txt` attached to each release. RAR support uses the
freeware UnRAR library by Alexander Roshal, under its own licence.

**Developers:** see [docs/development.md](docs/development.md) to build and run Livery, and
[docs/release.md](docs/release.md) for releases.
