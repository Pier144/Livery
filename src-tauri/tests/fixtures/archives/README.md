# RAR fixtures

RAR can't be written from Rust (the `unrar` crate only reads), so these few archives are committed.
ZIP and 7z fixtures are built by the tests themselves (`tests/archive_formats.rs`). All are RAR 5,
stored (`-m0`), made with WinRAR 7 on Windows; keep them tiny.

| File | What it holds | How it was made |
|---|---|---|
| `winter_tiger.rar` | `Winter Tiger\germ_pzkpfw_VI_ausf_b_tiger_IIH.blk` (73 B), `Winter Tiger\tiger_c.dds` (9 B) | `rar a -m0 -r winter_tiger.rar "Winter Tiger"` |
| `locked.rar` | the same files, data encrypted (names readable) | `rar a -m0 -r -p<password> locked.rar "Winter Tiger"` |
| `locked_headers.rar` | the same files, headers encrypted too (nothing readable without the password) | `rar a -m0 -r -hp<password> locked_headers.rar "Winter Tiger"` |
| `split.part1.rar`, `split.part2.rar` | `split\big.dds` (3000 B, spans both volumes) and `split\x.blk` | `rar a -m0 -r -v2k split.rar split` |
| `link.rar` | `Skin\su_27.blk`, `Skin\empty.txt` (0 B) and `Skin\hull_c.dds`, a Windows symbolic link to `..\secret.dds` | `mklink hull_c.dds ..\secret.dds` inside `Skin`, then `rar a -ol -r -m0 link.rar Skin` (`-ol` stores the link as a link) |

`rar` is `C:\Program Files\WinRAR\Rar.exe`; `UnRAR.exe lt <file>` shows the technical listing.
