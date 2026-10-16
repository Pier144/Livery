//! The RAR decoder Livery borrows: 7-Zip (`7z.exe`) or WinRAR's console `UnRAR.exe`, when one is
//! installed. Livery ships no RAR code of its own (RarLab's UnRAR source isn't open source), so a
//! RAR opens only on a PC that has one of them.
//!
//! The tool is only asked to print every file of the archive to its standard output, one after
//! the other in archive order, with no file names on the command line and nothing written to
//! disk. Livery has already listed and checked the archive itself ([`super::rar_headers`]), cuts
//! the stream into files by the sizes it read, writes every file itself, and checks that the
//! stream holds exactly those bytes and that the tool says the data was sound (its CRCs).
//!
//! The executable is looked up only where the installers put it (the registry, then Program
//! Files), never on `PATH` or in the current folder.

use super::rar_headers::RarFormat;
use super::unpack;
use crate::error::{AppError, AppResult, ErrorCode};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

/// `unsupported` message for a RAR when neither 7-Zip nor WinRAR is installed.
pub const RAR_NEEDS_TOOL: &str =
    "Opening RAR archives needs 7-Zip or WinRAR. Install one of them, or unpack the archive and add its folder";

/// Which program decodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RarToolKind {
    SevenZip,
    UnRar,
}

/// An installed decoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RarTool {
    pub kind: RarToolKind,
    pub exe: PathBuf,
}

impl RarTool {
    /// The decoder to use: 7-Zip when installed, else WinRAR's UnRAR. `None` when neither is.
    pub fn find() -> Option<Self> {
        Self::installed().into_iter().next()
    }

    /// Every decoder found, 7-Zip first (tests run each).
    pub fn installed() -> Vec<Self> {
        let mut found: Vec<Self> = Vec::new();
        let candidates = seven_zip_candidates()
            .into_iter()
            .map(|exe| Self { kind: RarToolKind::SevenZip, exe })
            .chain(unrar_candidates().into_iter().map(|exe| Self { kind: RarToolKind::UnRar, exe }));
        for tool in candidates {
            if tool.exe.is_file() && !found.iter().any(|f| f.kind == tool.kind) {
                found.push(tool);
            }
        }
        found
    }

    /// The program's name, for error details.
    pub fn name(&self) -> &'static str {
        match self.kind {
            RarToolKind::SevenZip => "7-Zip",
            RarToolKind::UnRar => "WinRAR",
        }
    }

    /// Starts printing every file of `archive` to a pipe.
    pub fn decode(&self, archive: &Path, format: RarFormat) -> AppResult<Decoder> {
        // An absolute path can't start with `-` or `@`, which both tools would read as a switch
        // or a list file.
        let archive = std::path::absolute(archive).map_err(|e| unpack::damaged(e.to_string()))?;
        let mut command = Command::new(&self.exe);
        match self.kind {
            // e: extract without folders; -so: to stdout; -sns-: no NTFS streams; -t: the format
            // Livery read, nothing else.
            RarToolKind::SevenZip => command.args([
                "e",
                "-so",
                "-y",
                "-bd",
                "-sns-",
                match format {
                    RarFormat::Rar4 => "-trar",
                    RarFormat::Rar5 => "-trar5",
                },
                "--",
            ]),
            // p: print to stdout; -inul: no messages; -p-: never ask for a password; -c-: no
            // comment; -cfg-: ignore rar.ini and the RAR environment variable.
            RarToolKind::UnRar => command.args(["p", "-inul", "-p-", "-c-", "-cfg-", "-y", "--"]),
        };
        command.arg(&archive).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: no console flashes up from the GUI app.
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().map_err(|e| {
            AppError::new(ErrorCode::Unsupported, RAR_NEEDS_TOOL).with_detail(format!("{}: {e}", self.name()))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| unpack::damaged("no output pipe"))?;
        Ok(Decoder { child: Some(child), stdout, name: self.name(), kind: self.kind })
    }
}

/// A running decoder: its output, read in archive order. Dropping it stops the program.
pub struct Decoder {
    child: Option<Child>,
    stdout: ChildStdout,
    name: &'static str,
    kind: RarToolKind,
}

impl Read for Decoder {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.stdout.read(buf)
    }
}

impl Decoder {
    /// After the last file: the output must end there and the program must report success.
    pub fn finish(mut self) -> AppResult<()> {
        let mut extra = [0u8; 1];
        let more = loop {
            match self.stdout.read(&mut extra) {
                Ok(n) => break n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(unpack::damaged(e.to_string())),
            }
        };
        if more != 0 {
            return Err(unpack::damaged(format!("{} printed more data than the archive lists", self.name)));
        }
        self.wait_ok()
    }

    /// The program's verdict once its output ended early (or [`Self::finish`] found it done):
    /// `Ok` only for a clean exit.
    pub fn wait_ok(&mut self) -> AppResult<()> {
        let Some(mut child) = self.child.take() else { return Ok(()) };
        let status = child.wait().map_err(|e| unpack::damaged(e.to_string()))?;
        let code = status.code();
        // 0 is success and 1 a warning that leaves the data sound, for both programs.
        if matches!(code, Some(0 | 1)) {
            return Ok(());
        }
        let detail =
            format!("{} exited with code {}", self.name, code.map_or_else(|| "none".to_owned(), |c| c.to_string()));
        Err(match (self.kind, code) {
            (RarToolKind::UnRar, Some(11)) => unpack::encrypted(detail),
            (_, Some(8)) => unpack::too_big(detail),
            _ => unpack::damaged(detail),
        })
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
fn seven_zip_candidates() -> Vec<PathBuf> {
    use winreg::{HKCU, HKLM};
    let mut out = Vec::new();
    for hive in [HKCU, HKLM] {
        let Ok(key) = hive.open_subkey(r"Software\7-Zip") else { continue };
        for value in ["Path64", "Path"] {
            if let Ok(dir) = key.get_value::<String, _>(value) {
                if !dir.trim().is_empty() {
                    out.push(Path::new(dir.trim()).join("7z.exe"));
                }
            }
        }
    }
    out.extend(program_files().into_iter().map(|pf| pf.join("7-Zip").join("7z.exe")));
    out
}

#[cfg(windows)]
fn unrar_candidates() -> Vec<PathBuf> {
    use winreg::{HKCU, HKLM};
    let mut out = Vec::new();
    for hive in [HKLM, HKCU] {
        let Ok(key) = hive.open_subkey(r"Software\WinRAR") else { continue };
        for value in ["exe64", "exe32"] {
            // The path of WinRAR.exe; UnRAR.exe sits next to it.
            if let Ok(exe) = key.get_value::<String, _>(value) {
                if let Some(dir) = Path::new(exe.trim()).parent().filter(|d| !d.as_os_str().is_empty()) {
                    out.push(dir.join("UnRAR.exe"));
                }
            }
        }
    }
    out.extend(program_files().into_iter().map(|pf| pf.join("WinRAR").join("UnRAR.exe")));
    out
}

#[cfg(windows)]
fn program_files() -> Vec<PathBuf> {
    ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .collect()
}

#[cfg(not(windows))]
fn seven_zip_candidates() -> Vec<PathBuf> {
    ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .flat_map(|dir| ["7z", "7zz"].map(|exe| Path::new(dir).join(exe)))
        .collect()
}

#[cfg(not(windows))]
fn unrar_candidates() -> Vec<PathBuf> {
    ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].iter().map(|dir| Path::new(dir).join("unrar")).collect()
}
