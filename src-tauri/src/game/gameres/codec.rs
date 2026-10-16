//! Block codec of the game packs: the IGenLoad block (`u32 L`, tag in the top two bits, size in
//! the low 30) and the compressions it names, plus the bare Oodle streams of texture packs.
//!
//! Oodle is read with the pure-Rust `oozextract` crate; Livery never loads game code. Every
//! output size is checked against a limit before anything is allocated.
//!
//! `oozextract` `assert!`s on damaged data instead of returning an error (about one damaged
//! block in eight), and Livery's release profile aborts on panic. So the decoder never runs in
//! the app's own process: [`oodle`] hands each stream to a worker, a second copy of the Livery
//! executable started with [`OODLE_WORKER_ARG`] (`main.rs` calls [`worker_main`] before anything
//! else). A damaged pack kills the worker, never the app, and the next request starts a new one.

use super::bad;
use super::bytes::Reader;
use crate::error::{AppError, AppResult, ErrorCode};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Largest unpacked block of vertex data accepted.
pub const MAX_VERTEX_DATA: usize = 256 * 1024 * 1024;
/// Largest unpacked texture level accepted.
pub const MAX_TEXTURE_LEVEL: usize = 128 * 1024 * 1024;

/// Compression of an IGenLoad block (`u32 L`: tag = L >> 30, size = L & 0x3FFF_FFFF).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tag {
    None,
    Zstd,
    Oodle,
}

impl Tag {
    fn from_bits(bits: u32) -> AppResult<Self> {
        match bits {
            0 => Ok(Tag::None),
            1 => Ok(Tag::Zstd),
            2 => Ok(Tag::Oodle),
            other => Err(bad(format!("block compression {other}"))),
        }
    }
}

/// Reads one block at `cur`'s position and returns the unpacked bytes. OODLE: `u32 rawSize` then
/// `size - 4` bytes of stream; ZSTD: one frame of `size` bytes; NONE: `size` raw bytes. `max`
/// bounds the unpacked size.
pub fn read_block(cur: &mut Reader, max: usize) -> AppResult<Vec<u8>> {
    let head = cur.u32()?;
    let tag = Tag::from_bits(head >> 30)?;
    let size = (head & 0x3FFF_FFFF) as usize;
    let payload = cur.take(size)?;
    match tag {
        Tag::None => {
            if size > max {
                return Err(bad(format!("block of {size} bytes over the {max} limit")));
            }
            Ok(payload.to_vec())
        }
        Tag::Zstd => zstd(payload, max),
        Tag::Oodle => {
            let (raw, stream) = payload.split_first_chunk::<4>().ok_or_else(|| bad("Oodle block without a size"))?;
            oodle(stream, u32::from_le_bytes(*raw) as usize, max)
        }
    }
}

// ── Oodle: the in-process decoder (worker only) ─────────────────────────────

/// Output bytes per Oodle block (each starts with its own header).
const OODLE_BLOCK: usize = 0x40000;

/// Decodes a bare Oodle stream in this process: the header walk, then `oozextract`. It panics on
/// some damaged streams, so it must only run inside the worker process ([`serve_requests`]);
/// everything else goes through [`oodle`] / [`oodle_with`]. Fails unless the stream unpacks to
/// exactly `raw_len` bytes; `raw_len > max` is rejected before allocating.
#[doc(hidden)]
pub fn decode_in_process(src: &[u8], raw_len: usize, max: usize) -> AppResult<Vec<u8>> {
    if raw_len > max {
        return Err(bad(format!("Oodle stream unpacks to {raw_len} bytes, over the {max} limit")));
    }
    check_kraken_family(src, raw_len)?;
    let mut out = vec![0u8; raw_len];
    let written =
        oozextract::Extractor::new().read_from_slice(src, &mut out).map_err(|e| bad(format!("oodle: {e}")))?;
    if written != raw_len {
        return Err(bad(format!("Oodle stream unpacked {written} of {raw_len} bytes")));
    }
    Ok(out)
}

/// Walks the block and quantum headers of an Oodle stream that unpacks to `raw_len` bytes and
/// rejects anything but the Kraken family (Kraken, Mermaid, Leviathan), which is all the game
/// uses. `oozextract` also decodes BitKnit and LZNA; keeping them out limits what reaches the
/// decoder (those two panic on damaged input far more often than the rest).
///
/// The layout is the one `oozextract` parses, so the walk and the decoder agree on where every
/// block ends. Per block of 256 KiB of output:
///
/// ```text
/// byte 0   low nibble 0xC (magic), bits 4-5 zero, bit 6 uncompressed, bit 7 restart decoder
/// byte 1   low 7 bits decoder type (6 Kraken, 0xA Mermaid, 0xC Leviathan), bit 7 checksums
/// then     uncompressed: the block's bytes; else a 3-byte big-endian quantum header:
///          size = v & 0x3FFFF; size != 0x3FFFF: `size + 1` compressed bytes follow;
///          else v >> 18 == 1: one byte (memset); anything else is invalid
/// ```
///
/// Checksummed streams are refused too: `oozextract` doesn't read their checksum bytes.
pub fn check_kraken_family(src: &[u8], raw_len: usize) -> AppResult<()> {
    let mut cur = Reader::new(src);
    let mut written = 0;
    while written < raw_len {
        let (b1, b2) = (cur.u8()?, cur.u8()?);
        if b1 & 0xF != 0xC || (b1 >> 4) & 3 != 0 {
            return Err(bad(format!("oodle block header {b1:02X} {b2:02X}")));
        }
        match b2 & 0x7F {
            0x6 | 0xA | 0xC => {}
            other => return Err(bad(format!("oodle decoder {other:#X} isn't Kraken, Mermaid or Leviathan"))),
        }
        if b2 & 0x80 != 0 {
            return Err(bad("oodle stream with checksums"));
        }
        let block = (raw_len - written).min(OODLE_BLOCK);
        if b1 & 0x40 != 0 {
            cur.skip(block)?;
        } else {
            let quantum = u32::from_be_bytes([0, cur.u8()?, cur.u8()?, cur.u8()?]);
            match quantum & 0x3FFFF {
                0x3FFFF if quantum >> 18 == 1 => cur.skip(1)?,
                0x3FFFF => return Err(bad(format!("oodle quantum header {quantum:#X}"))),
                size => cur.skip(size as usize + 1)?,
            }
        }
        written += block;
    }
    Ok(())
}

// ── Oodle: the worker protocol ──────────────────────────────────────────────

/// First argument of the executable when it runs as the Oodle worker.
pub const OODLE_WORKER_ARG: &str = "--livery-oodle-worker";

/// How long a request may take before the worker is killed.
pub const WORKER_TIMEOUT: Duration = Duration::from_secs(10);

/// Longest error text the worker sends back.
const MAX_ERROR: usize = 4096;

/// Windows: no console window for the worker.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The request the worker reads: `u32 raw_len`, `u32 src_len`, the stream (little-endian).
fn request_frame(src: &[u8], raw_len: u32) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + src.len());
    frame.extend_from_slice(&raw_len.to_le_bytes());
    frame.extend_from_slice(&(src.len() as u32).to_le_bytes());
    frame.extend_from_slice(src);
    frame
}

/// The answer the worker writes: `u8 status` (0 ok, 1 error), `u32 len`, the bytes (the decoded
/// stream, or the error's detail as UTF-8).
fn write_response(out: &mut impl Write, status: u8, bytes: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(5 + bytes.len());
    frame.push(status);
    frame.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    frame.extend_from_slice(bytes);
    out.write_all(&frame)?;
    out.flush()
}

fn read_response(input: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    input.read_exact(&mut head)?;
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_VERTEX_DATA {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "response over the limit"));
    }
    let mut bytes = vec![0u8; len];
    input.read_exact(&mut bytes)?;
    Ok((head[0], bytes))
}

/// Fills `buf`; `false` when the input ended before the first byte (a clean end).
fn read_exact_or_eof(input: &mut impl Read, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match input.read(&mut buf[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// The worker's loop: reads requests from `input` until it ends and answers each on `output`.
/// A request over [`MAX_VERTEX_DATA`] (compressed or unpacked) is refused; an oversized
/// compressed part can't be skipped, so that one ends the loop. Panics in the decoder end the
/// process, which is the point: the caller sees the pipe break.
pub fn serve_requests(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    loop {
        let mut head = [0u8; 8];
        if !read_exact_or_eof(input, &mut head)? {
            return Ok(());
        }
        let raw_len = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let src_len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
        if src_len > MAX_VERTEX_DATA {
            write_response(output, 1, b"request over the limit")?;
            return Ok(());
        }
        let mut src = vec![0u8; src_len];
        input.read_exact(&mut src)?;
        match decode_in_process(&src, raw_len, MAX_VERTEX_DATA) {
            Ok(bytes) => write_response(output, 0, &bytes)?,
            Err(e) => {
                let text = e.detail.unwrap_or(e.message);
                write_response(output, 1, &text.as_bytes()[..text.len().min(MAX_ERROR)])?;
            }
        }
    }
}

/// Entry point of the worker process (`main.rs` calls it first thing when the executable is
/// started with [`OODLE_WORKER_ARG`]): serves requests on stdin and stdout until stdin ends.
pub fn worker_main() {
    let (stdin, stdout) = (io::stdin(), io::stdout());
    let _ = serve_requests(&mut io::BufReader::new(stdin.lock()), &mut stdout.lock());
}

// ── Oodle: the caller side ──────────────────────────────────────────────────

/// What one request came to.
enum Outcome {
    Reply(u8, Vec<u8>),
    /// The worker exited or the pipe broke.
    Died,
    TimedOut,
}

/// A running worker process and the two threads that feed and drain its pipes. Every request
/// goes through the threads, so a worker that stops reading or answering can't block the caller
/// past its deadline. Dropping it kills the process.
struct Live {
    child: Child,
    requests: Sender<Vec<u8>>,
    responses: Receiver<Option<(u8, Vec<u8>)>>,
}

impl Live {
    fn start(exe: &Path) -> io::Result<Self> {
        let mut command = Command::new(exe);
        command.arg(OODLE_WORKER_ARG).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("worker pipes missing"));
        };
        let (requests, request_rx) = mpsc::channel::<Vec<u8>>();
        let (response_tx, responses) = mpsc::channel();
        // Built before the threads exist so `Drop` reaps the child if one can't start.
        let live = Self { child, requests, responses };
        std::thread::Builder::new().name("oodle-writer".into()).spawn(move || {
            for frame in request_rx {
                if stdin.write_all(&frame).and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        })?;
        std::thread::Builder::new().name("oodle-reader".into()).spawn(move || loop {
            match read_response(&mut stdout) {
                Ok(reply) => {
                    if response_tx.send(Some(reply)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = response_tx.send(None);
                    break;
                }
            }
        })?;
        Ok(live)
    }

    /// Sends one request and waits for its answer, at most `timeout`.
    fn exchange(&mut self, frame: Vec<u8>, timeout: Duration) -> Outcome {
        if self.requests.send(frame).is_err() {
            return Outcome::Died;
        }
        match self.responses.recv_timeout(timeout) {
            Ok(Some((status, bytes))) => Outcome::Reply(status, bytes),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => Outcome::Died,
            Err(RecvTimeoutError::Timeout) => Outcome::TimedOut,
        }
    }

    /// Whether the process is still running.
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A handle on an Oodle worker process, reused for several requests (a model load decodes about
/// four streams). The process starts with the first request. When it dies (a damaged stream made
/// `oozextract` panic and abort it), times out, or breaks the pipe, the request fails with
/// "oodle stream damaged" / "oodle stream timed out" and the next request starts a new one.
pub struct OodleWorker {
    exe: PathBuf,
    timeout: Duration,
    live: Option<Live>,
}

impl OodleWorker {
    /// A handle for the worker `exe` (the Livery executable; see [`worker_main`]). Nothing runs
    /// until the first [`decode`](Self::decode).
    pub fn new(exe: impl Into<PathBuf>) -> Self {
        Self { exe: exe.into(), timeout: WORKER_TIMEOUT, live: None }
    }

    /// Sets the per-request deadline (default [`WORKER_TIMEOUT`]).
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    /// The process id of the running worker, if one is running.
    pub fn pid(&self) -> Option<u32> {
        self.live.as_ref().map(|live| live.child.id())
    }

    /// Decodes `src` (a bare Oodle stream) to exactly `raw_len` bytes in the worker. The worker
    /// refuses streams over [`MAX_VERTEX_DATA`]; callers with a lower limit use [`oodle_with`].
    pub fn decode(&mut self, src: &[u8], raw_len: usize) -> AppResult<Vec<u8>> {
        if raw_len > MAX_VERTEX_DATA || src.len() > MAX_VERTEX_DATA {
            return Err(bad(format!("Oodle stream of {} bytes unpacking to {raw_len} is over the limit", src.len())));
        }
        if self.live.as_mut().is_some_and(|live| !live.alive()) {
            self.live = None;
        }
        let live = match &mut self.live {
            Some(live) => live,
            None => self.live.insert(Live::start(&self.exe).map_err(|e| {
                AppError::new(ErrorCode::Io, super::MODEL_UNREADABLE)
                    .with_detail(format!("Oodle worker {}: {e}", self.exe.display()))
            })?),
        };
        let outcome = live.exchange(request_frame(src, raw_len as u32), self.timeout);
        match outcome {
            Outcome::Reply(0, bytes) if bytes.len() == raw_len => Ok(bytes),
            Outcome::Reply(1, text) => Err(bad(String::from_utf8_lossy(&text).into_owned())),
            Outcome::Reply(status, bytes) => {
                self.live = None;
                Err(bad(format!("Oodle worker answered {status} with {} bytes for {raw_len}", bytes.len())))
            }
            Outcome::Died => {
                self.live = None;
                tracing::warn!("the Oodle worker died on a stream of {} bytes ({raw_len} out)", src.len());
                Err(bad("oodle stream damaged"))
            }
            Outcome::TimedOut => {
                self.live = None;
                tracing::warn!("the Oodle worker timed out on a stream of {} bytes ({raw_len} out)", src.len());
                Err(bad("oodle stream timed out"))
            }
        }
    }
}

/// [`OodleWorker::decode`] for a caller whose limit is `max`: `raw_len > max` is rejected before
/// anything is sent.
pub fn oodle_with(worker: &mut OodleWorker, src: &[u8], raw_len: usize, max: usize) -> AppResult<Vec<u8>> {
    if raw_len > max {
        return Err(bad(format!("Oodle stream unpacks to {raw_len} bytes, over the {max} limit")));
    }
    worker.decode(src, raw_len)
}

static WORKER_EXE: OnceLock<PathBuf> = OnceLock::new();
static WORKER: Mutex<Option<OodleWorker>> = Mutex::new(None);

/// Sets the executable [`oodle`] starts as its worker, for tests (the test binary can't be the
/// worker; use `env!("CARGO_BIN_EXE_livery")`). The first call wins; it must come before the
/// first [`oodle`] call. The app never calls it: the default is the running executable.
pub fn set_worker_exe(exe: impl Into<PathBuf>) {
    let _ = WORKER_EXE.set(exe.into());
}

/// A bare Oodle stream of known unpacked length (DxP2 textures and vertex blocks), decoded by
/// the process-wide worker: one lazily started [`OodleWorker`] behind a mutex, so concurrent
/// callers take turns (a request lasts milliseconds, at most [`WORKER_TIMEOUT`]). It lives to
/// the end of the process; when Livery exits (or dies) the worker's stdin closes and it quits.
/// Fails unless the stream unpacks to exactly `raw_len` bytes; `raw_len > max` is rejected
/// before anything is sent.
pub fn oodle(src: &[u8], raw_len: usize, max: usize) -> AppResult<Vec<u8>> {
    if raw_len > max {
        return Err(bad(format!("Oodle stream unpacks to {raw_len} bytes, over the {max} limit")));
    }
    let mut guard = WORKER.lock().unwrap_or_else(|e| e.into_inner());
    let worker = match guard.as_mut() {
        Some(worker) => worker,
        None => {
            let exe = match WORKER_EXE.get() {
                Some(exe) => exe.clone(),
                None => std::env::current_exe().map_err(|e| {
                    AppError::new(ErrorCode::Io, super::MODEL_UNREADABLE).with_detail(format!("current exe: {e}"))
                })?,
            };
            guard.insert(OodleWorker::new(exe))
        }
    };
    worker.decode(src, raw_len)
}

// ── zstd ────────────────────────────────────────────────────────────────────

/// One zstd frame, at most `max` bytes.
pub fn zstd(src: &[u8], max: usize) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    zstd::stream::read::Decoder::new(src)
        .and_then(|d| d.take((max as u64).saturating_add(1)).read_to_end(&mut out))
        .map_err(|e| bad(format!("zstd: {e}")))?;
    if out.len() > max {
        return Err(bad(format!("zstd frame unpacks to more than {max} bytes")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stream every decoder agrees on: one uncompressed block (`0xCC 0x0C`, then the bytes).
    fn stored(data: &[u8]) -> Vec<u8> {
        let mut out = vec![0xCC, 0x0C];
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn request_and_response_frames_have_the_documented_layout() {
        assert_eq!(request_frame(&[9, 8, 7], 1000), [0xE8, 3, 0, 0, 3, 0, 0, 0, 9, 8, 7]);
        let mut out = Vec::new();
        write_response(&mut out, 1, b"no").unwrap();
        assert_eq!(out, [1, 2, 0, 0, 0, b'n', b'o']);
        assert_eq!(read_response(&mut &out[..]).unwrap(), (1, b"no".to_vec()));
        assert!(read_response(&mut &out[..4]).is_err(), "cut inside the header");
        assert!(read_response(&mut &out[..6]).is_err(), "cut inside the bytes");
        let over = [0, 0xFF, 0xFF, 0xFF, 0xFF];
        assert!(read_response(&mut &over[..]).is_err(), "a length over the limit");
    }

    #[test]
    fn the_server_loop_answers_each_request_and_ends_with_its_input() {
        let data = b"hello oodle".to_vec();
        let mut input = request_frame(&stored(&data), data.len() as u32);
        input.extend(request_frame(&[0x8C, 0x0B, 0, 0, 0], 100)); // BitKnit: refused by the header walk
        input.extend(request_frame(&stored(&data), data.len() as u32));
        let mut output = Vec::new();
        serve_requests(&mut &input[..], &mut output).unwrap();
        let mut reader = &output[..];
        assert_eq!(read_response(&mut reader).unwrap(), (0, data.clone()));
        let (status, text) = read_response(&mut reader).unwrap();
        assert_eq!(status, 1);
        assert!(String::from_utf8(text).unwrap().starts_with("oodle decoder"));
        assert_eq!(read_response(&mut reader).unwrap(), (0, data));
        assert!(reader.is_empty());
    }

    #[test]
    fn the_server_loop_refuses_limits_and_stops_on_a_cut_request() {
        // A length over the limit is answered (the stream is still read), the loop goes on.
        let mut input = request_frame(&[], MAX_VERTEX_DATA as u32 + 1);
        input.extend(request_frame(&stored(b"x"), 1));
        let mut output = Vec::new();
        serve_requests(&mut &input[..], &mut output).unwrap();
        let mut reader = &output[..];
        let (status, text) = read_response(&mut reader).unwrap();
        assert_eq!((status, String::from_utf8(text).unwrap().contains("limit")), (1, true));
        assert_eq!(read_response(&mut reader).unwrap(), (0, b"x".to_vec()));
        // A compressed part over the limit can't be skipped: answered once, then the loop ends.
        let mut huge = [0u8; 8];
        huge[4..].copy_from_slice(&(MAX_VERTEX_DATA as u32 + 1).to_le_bytes());
        let mut output = Vec::new();
        serve_requests(&mut &huge[..], &mut output).unwrap();
        assert_eq!(read_response(&mut &output[..]).unwrap().0, 1);
        // A request cut short is an io error; an empty input is a clean end.
        assert!(serve_requests(&mut &request_frame(&[1, 2, 3], 5)[..9], &mut Vec::new()).is_err());
        assert!(serve_requests(&mut &[1u8, 2, 3][..], &mut Vec::new()).is_err());
        serve_requests(&mut &[][..], &mut Vec::new()).unwrap();
    }
}
