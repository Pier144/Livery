# Atelier CLI (for agents)

A command line over Livery's Atelier, so an agent (Claude) can make War Thunder skins with
exact numbers instead of driving the window by screenshots. It reuses the editor's own code: the
same model reader, Baker, decal placement and Apply to game, so a CLI project looks the same in
the app.

Debug builds only. Release builds don't parse `--livery-cli`, so users never see it. Messages are
English and not translated: this is not user interface.

Design: `docs/superpowers/specs/2026-10-19-atelier-cli-design.md`. Plan:
`docs/superpowers/plans/2026-10-19-atelier-cli.md`.

## Build

```bash
pnpm tauri build --debug --no-bundle
```

The result is `src-tauri/target/debug/livery.exe`, with the frontend embedded. `pnpm tauri dev`
overwrites that exe with a build that loads its pages from the Vite dev server. After any
`tauri dev`, rebuild with the command above. Otherwise the GPU commands fail after about 20 s with
"The agent CLI page didn't load".

## Rules

- **Livery must be closed.** The app and the CLI share a lock on the data folder
  (`<data>/livery.lock`). While the app is open, every command exits 3 with `appRunning`.
- **Try things on scratch data first.** Set `LIVERY_DATA_DIR` to a scratch folder whose
  `settings.json` points `gamePath` at a scratch game root, and keep `readGameData` and
  `atelierEnabled` true. A scratch game root needs:
  - an empty `launcher.exe`;
  - copies of the `*.vromfs.bin` files;
  - junctions (`mklink /J`) for `content` and `content.hq` to the real install, and nothing must
    ever write into them;
  - an empty `UserSkins`.
- **Install for real only when the author asks.** That means running without `LIVERY_DATA_DIR`:
  `apply` then writes into the real `UserSkins`, with a backup when it replaces an existing skin.
- **Kill a stuck run by PID.** Never use `taskkill /IM livery.exe`: it also closes the author's
  own Livery.
- There are no delete commands. The author deletes projects and skins in the app.

## Invocation and output

```bash
LIVERY_DATA_DIR=<scratch>/data src-tauri/target/debug/livery.exe --livery-cli <command> [args]
```

- **stdout** gets exactly one pretty-printed JSON document: the result, or an error
  `{ "code", "message", "detail"? }`. Logs go to stderr and to the log file. stderr also gets one
  harmless WebView2 line at exit (`Failed to unregister class Chrome_WidgetWin_0`).
- **Paths** in and out are absolute (a relative path is resolved against the working folder).

| Exit | Meaning |
|---|---|
| 0 | ok |
| 1 | `invalidInput`, `notFound`, `unsupported`, `noHit`: bad arguments or project, unknown id, refused vehicle, missing picture, background-removal files not downloaded, Atelier switched off in Settings |
| 2 | any other error, including `internal` (for example, the page failed) |
| 3 | `appRunning` |
| 4 | `timeout` (120 s, or 300 s for `apply`) |

**Timings:**
- `project` and `vehicles` commands: about 1 s.
- `render` and `place`: about 4 s.
- `apply`: about 10 s on the Jumbo.
- The first GPU run of a session adds about 4 s (shader cache).

## Model space

The vehicle sits in metres, with these axes:
- **+x** points to the nose. On the Jumbo x runs from -3.35 (rear) to 2.89 (front).
- **+y** is up.
- **z** runs across the vehicle. +z is the vehicle's right side, and the mirror axis is z
  (`mirrorAxis: 2`).

`vehicle-info` gives the bounds of every part.

## Commands

### `vehicles [--query <text>]`

Finds a vehicle code from the game's list (case-insensitive substring of the code or name). It is
empty when Settings → Game → Read data from the game is off.

```json
[{ "code": "us_m4a3e2_sherman_jumbo", "name": "M4A3E2", "nation": "USA", "type": "ground", "class": "Heavy tank", "rank": 3 }]
```

### `vehicle-info <code>`

Gives the model summary. No GPU is needed.
- `slots`: `texture`, `width`, `height`, `hq`, `paintableByDefault`, `body`.
- `parts`: `node`, `group` (`hull`, `turret` or `gun`), `slot`, `triangles`, `bounds`.
- Overall: `bounds`, `center`, `radius` and `mirrorAxis`.

On the Jumbo the hull (`@root`) spans x -3.05..2.89, y 0.33..1.96 and z ±1.33. The turret
(`bone_turret`) spans y 1.04..3.03.

### `project new <name> <vehicle>` · `project list` · `project get <id>`

- `new` reads the model and turns on the vehicle's own slots (body, turret, gun).
- `get` returns the whole `AtelierProject`, including `layers` and `installedSkinId`.
- `list` gives summaries only.

### `project put <file|->`

Saves a whole project document, read from a file or from stdin with `-`.
- The project must already exist (`project new` first) and keep its `vehicle`.
- The layers go through the editor's own check.
- A thumbnail is stored.

```json
{ "project": { "…": "as saved" }, "repaired": false, "sharedTexels": [], "missingPictures": [] }
```

- `repaired`: the check fixed or dropped something. Compare with what you sent.
- `sharedTexels`: ids of layers with Mirror on whose decal lands on texels that other triangles
  also use. The editor turns Mirror off there, so turn it off too, because the copy paints the
  same texels twice.
- `missingPictures`: `{ layer, assetId }` for pictures that can't be loaded. `render` and `apply`
  refuse such a project with `notFound`.

### `import-image <id> <file> [--cutout]`

Imports a picture into the project's assets and returns `{ "asset": { "id", "width", "height" } }`.

With `--cutout` it also removes the background (isnet-anime) into a second asset and returns
`cutout: { asset, crop }`. The cutout needs its files, downloaded once from the app (Settings →
Atelier); the CLI never downloads. Without them the command exits 1, and `detail` names the asset
that was already imported.

### `place <id> --view <view> --at <x>,<y> [--part hull|turret|gun] [--width m] [--height m] [--depth m]`

Casts a ray through a point of a view and returns a ready decal there. It is the same frame a
click in the editor makes: centred on the hit, facing out, with up = the view's screen up.

```json
{ "decal": { "center": [1.83, 1.658, -0.402], "normal": [0.669, 0.744, 0.0004], "up": [-0.744, 0.669, -0.0003],
             "width": 0.6, "height": 0.6, "depth": 0.06, "part": "all", "mirror": false },
  "group": "hull", "node": "@root" }
```

- `--at` takes fractions of the picture, from `0,0` (top left) to `1,1`. Read them off a
  `render --grid` of the same view at any size.
- `--part` limits the ray to that part group and becomes the decal's `part` (its paint stays on
  that group). Without it, `part` is `all`.
- Size defaults to 1 × 1 m, and depth to the editor's default for the width. Sizes are clamped
  like the editor's.
- Missing the vehicle gives `noHit` (exit 1).

### `render <id> --out <dir> [--views <list>] [--size <px>] [--grid] [--flat]`

Writes PNG pictures of the baked project (transparent background) into an existing folder.

```json
{ "views": [{ "view": "front", "file": "C:\\…\\front.png", "width": 1024, "height": 1024 }], "flat": [] }
```

- **Views:**
  - `front`, `side` (the left side, `-z`), `rear`, `top`;
  - or `orbit:<theta>,<phi>,<zoom>`: theta and phi in radians (phi from 0.01 to π−0.01, measured
    from straight above), zoom from 0.15 to 6 (1 = framed, smaller = closer).
  - The default is all four quick views.
  - `orbit:0.6,1.0,0.7` is a good three-quarter look at the front left.
- `--size`: 256 to 2048, default 1024.
- `--grid`: lines every 10 % with labels 1 to 9 (tenths) along the top and left. Use them for
  `place --at`.
- `--flat`: also writes each painted slot's texture at full size as `flat_<slot>.png`. This is
  what `apply` encodes, so it is good for checking UV placement.

### `apply <id>`

Applies the project to the game, as Apply to game does: it bakes at export size, writes the DDS
files, the blk and `preview.png` into `UserSkins/<vehicle>_<project name>`, and adds the library
entry.

```json
{ "skin": { "id": "s-…", "folder": "us_m4a3e2_sherman_jumbo_CLI test", "active": true, "…": "…" },
  "backupId": "b-…", "downscaled": false }
```

- `backupId` is set when an installed skin was replaced; the author can restore it in Livery.
- `downscaled` means a texture was reduced to fit the GPU.

## Layer JSON essentials

`src/atelier/project.ts` is the source of truth; read it for the full field lists and limits.
Layers run bottom to top:
- exactly one `base`, first;
- at most one `mask` (Protected areas), last;
- placed layers and one-level `folder`s in between.

Every layer has `id` (any unique string), `kind`, `name` (`""` = default label) and `visible`.

- **Base:** `{ kind: "base", mode: "solid" | "camo", colors: ["#rrggbb", …], scale, seed }`. Camo
  takes 2 to 4 colours and these optional fields:
  - `pattern`: `organic`, `digital`, `hex`, `splinter`, `triangles` or `stripes`;
  - `weights`: one share per colour, each at least 0.05, summing to 1;
  - `cellSize`: 0.25 to 4;
  - `angle`: degrees, for stripes;
  - `softness`: 0 to 1;
  - `wear`: 0 to 1.
- **Decal** (every placed layer has one): `center`, `normal` (unit), `up` (unit, perpendicular to
  the normal), `width` and `height` in metres, `depth` (the projection box's thickness along the
  normal), `part` and `mirror`.
- **image:** `assetId`, `decal`, `opacity` (0..1), `flipX`. Optional: `wear` and
  `repeat: { count, gap, direction: "row" | "column" }`.
- **text:** `text`, `font: { family, style }` (installed fonts), `color`, `outlineColor`,
  `outlineWidth`, `skew`, `decal`, `opacity`. `decal.height` is the text size, and
  `decal.width` should be height × the text's aspect (the editor keeps that in step; set a sensible
  width and check with `render`).
- **shape:** `shape` (`rect`, `ellipse`, `star`, `polygon`), `fill`, `outlineColor`,
  `outlineWidth`, `decal`, `opacity`, plus `corner`, `points` and `innerRatio` where they apply.
  `fill` is either `{ kind: "solid", color }` or
  `{ kind: "stripes", colors: [a, b], angle, stripeWidth }` (stripe width in metres, so a hazard
  band gets more stripes as it grows).
- **merged** and **folder:** see `project.ts`. It is easier to build these in the app.

## Working loop

1. `vehicles --query …` → `vehicle-info <code>` → `project new`.
2. `render --grid --out r1`, then look at the PNGs.
3. Write the Base with `project get` → edit → `project put`.
4. `import-image` the pictures, adding `--cutout` for photos or art on a background.
5. For each picture: `place --view … --at …` on a point read from the grid, with the size you
   want, then add the layer with that `decal` and `project put`.
6. `render` again (add an `orbit:` view and `--flat`), check, correct, repeat.
7. `apply` (on scratch data until the author asks for the real install).

## Pitfalls

- **Sloped and curved surfaces:** a decal is projected along its normal through a box `depth`
  thick. On domed roofs and sloped noses, raise `depth` to 0.5–0.75 m or parts of the picture
  fall off the surface. Pictures fade on faces steeper than about 50° to the decal.
- **The Jumbo:**
  - The hull side is a strip about 0.8 m high, so big pictures go on the glacis (front
    `--at` ≈ `0.56,0.57`).
  - The hull sides share texels, so Mirror on them paints both sides at once (`sharedTexels`).
- **Small parts in front of a plate:** a hit on a bracket, hook or light puts the decal in front
  of the plate, and the picture barely shows. Place on the plate itself, or pass `--part`.
- **Box spill:** a decal box can catch small bits of nearby geometry. Look at `--flat` for stray
  marks, and shrink `depth` or use `part`.
- **Other vehicles:** vehicles whose textures are their own on a shared model are refused
  (`unsupported`), and only ground vehicles are supported.
- **Arguments:** a positional argument that starts with `--` is read as a flag. Avoid project
  names like that.
