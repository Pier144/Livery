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
use crate::game::zstd_frame::read_frame;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

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
///
/// For tests only (and the worker): the app never calls it.
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
///
/// Public only so the integration tests can call it; the app goes through [`oodle`].
#[doc(hidden)]
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

/// How long a request may take (from the moment it is sent) before the caller kills the worker.
pub const WORKER_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a new worker may take to announce itself (cold start, antivirus scans).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// The worker's own watchdog: it exits when a decode runs longer than this (the caller has
/// given up by then, but a caller that exited or died can't kill it)...
const WORKER_DECODE_LIMIT: Duration = Duration::from_secs(WORKER_TIMEOUT.as_secs() + 5);
/// ...or when no request has come for this long, so no idle `livery.exe` stays around. The
/// caller notices (exit code [`EXIT_IDLE`]) and starts a new worker for its next request.
const WORKER_IDLE_LIMIT: Duration = Duration::from_secs(60);

/// Environment variable that overrides [`WORKER_IDLE_LIMIT`], in milliseconds. Read only in
/// worker mode, and set only by tests (through [`OodleWorker::idle_limit_for_tests`]).
const IDLE_ENV: &str = "LIVERY_OODLE_WORKER_IDLE_MS";

/// Exit codes of the worker: a panic in the decoder, a decode over the limit, an idle shutdown.
const EXIT_PANIC: i32 = 70;
const EXIT_HUNG: i32 = 71;
const EXIT_IDLE: i32 = 72;

/// Response status: the decoded bytes / an error text / the worker is ready (sent once, first).
const STATUS_OK: u8 = 0;
const STATUS_ERROR: u8 = 1;
const STATUS_READY: u8 = 2;

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

/// What the worker's watchdog watches: times in milliseconds since the worker started, plus one
/// so that 0 can mean "not decoding".
struct Activity {
    base: Instant,
    /// When the current decode began; 0 while idle.
    decoding_since: AtomicU64,
    /// The last time a request arrived or an answer went out.
    last: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self { base: Instant::now(), decoding_since: AtomicU64::new(0), last: AtomicU64::new(1) }
    }

    fn now(&self) -> u64 {
        self.base.elapsed().as_millis() as u64 + 1
    }

    fn touch(&self) {
        self.last.store(self.now(), Ordering::Relaxed);
    }

    fn begin_decode(&self) {
        let now = self.now();
        self.decoding_since.store(now, Ordering::Relaxed);
        self.last.store(now, Ordering::Relaxed);
    }

    fn end_decode(&self) {
        self.decoding_since.store(0, Ordering::Relaxed);
        self.touch();
    }

    fn verdict(&self, decode_limit: Duration, idle_limit: Duration) -> Option<i32> {
        watchdog_verdict(
            self.now(),
            self.decoding_since.load(Ordering::Relaxed),
            self.last.load(Ordering::Relaxed),
            decode_limit.as_millis() as u64,
            idle_limit.as_millis() as u64,
        )
    }
}

/// The watchdog's decision: the exit code to leave with, if any. A decode that has run longer
/// than `decode_limit_ms` is [`EXIT_HUNG`]; with nothing decoding, `idle_limit_ms` without a
/// request is [`EXIT_IDLE`]. Times are milliseconds on one clock; `decoding_since` is 0 when idle.
fn watchdog_verdict(
    now: u64,
    decoding_since: u64,
    last_activity: u64,
    decode_limit_ms: u64,
    idle_limit_ms: u64,
) -> Option<i32> {
    if decoding_since != 0 {
        return (now.saturating_sub(decoding_since) > decode_limit_ms).then_some(EXIT_HUNG);
    }
    (now.saturating_sub(last_activity) > idle_limit_ms).then_some(EXIT_IDLE)
}

/// The worker's loop: reads requests from `input` until it ends and answers each on `output`.
/// A request over [`MAX_VERTEX_DATA`] (compressed or unpacked) is refused; an oversized
/// compressed part can't be skipped, so that one ends the loop. Panics in the decoder end the
/// process, which is the point: the caller sees the pipe break.
pub fn serve_requests(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    serve_watched(input, output, &Activity::new())
}

fn serve_watched(input: &mut impl Read, output: &mut impl Write, activity: &Activity) -> io::Result<()> {
    loop {
        let mut head = [0u8; 8];
        if !read_exact_or_eof(input, &mut head)? {
            return Ok(());
        }
        activity.touch();
        let raw_len = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let src_len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
        if src_len > MAX_VERTEX_DATA {
            write_response(output, STATUS_ERROR, b"request over the limit")?;
            return Ok(());
        }
        let mut src = vec![0u8; src_len];
        input.read_exact(&mut src)?;
        activity.begin_decode();
        let result = decode_in_process(&src, raw_len, MAX_VERTEX_DATA);
        activity.end_decode();
        match result {
            Ok(bytes) => write_response(output, STATUS_OK, &bytes)?,
            Err(e) => {
                let text = e.detail.unwrap_or(e.message);
                write_response(output, STATUS_ERROR, &text.as_bytes()[..text.len().min(MAX_ERROR)])?;
            }
        }
        activity.touch();
    }
}

/// Entry point of the worker process (`main.rs` calls it first thing when the executable is
/// started with [`OODLE_WORKER_ARG`]): announces itself, then serves requests on stdin and stdout
/// until stdin ends.
///
/// - A panic in the decoder exits at once with code 70 (no crash dialog, no error report).
/// - A watchdog thread exits with 71 when a decode runs 15 s (the caller's deadline is 10 s, and
///   a caller that has itself exited never closes the pipe), and with 72 after 60 s without a
///   request, so no idle `livery.exe` lingers in the Task Manager or blocks the installer. The
///   idle limit can be set (in milliseconds) with `LIVERY_OODLE_WORKER_IDLE_MS`, which only
///   tests use.
pub fn worker_main() {
    std::panic::set_hook(Box::new(|_| std::process::exit(EXIT_PANIC)));
    let idle = std::env::var(IDLE_ENV)
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
        .map_or(WORKER_IDLE_LIMIT, Duration::from_millis);
    let activity = Arc::new(Activity::new());
    let watched = Arc::clone(&activity);
    // Short limits (tests) are checked more often; the real ones every half second.
    let tick = (idle / 4).clamp(Duration::from_millis(10), Duration::from_millis(500));
    let watchdog = std::thread::Builder::new().name("oodle-watchdog".into()).spawn(move || loop {
        std::thread::sleep(tick);
        if let Some(code) = watched.verdict(WORKER_DECODE_LIMIT, idle) {
            std::process::exit(code);
        }
    });
    if watchdog.is_err() {
        return;
    }
    let (stdin, stdout) = (io::stdin(), io::stdout());
    let mut output = stdout.lock();
    if write_response(&mut output, STATUS_READY, &[]).is_err() {
        return;
    }
    let _ = serve_watched(&mut io::BufReader::new(stdin.lock()), &mut output, &activity);
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
    /// Starts the worker and waits (at most [`STARTUP_TIMEOUT`]) for it to announce itself, so a
    /// slow start (antivirus, a cold disk) never counts against a request's deadline.
    fn start(exe: &Path, idle_ms: Option<u64>) -> io::Result<Self> {
        let mut command = Command::new(exe);
        command.arg(OODLE_WORKER_ARG).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(ms) = idle_ms {
            command.env(IDLE_ENV, ms.to_string());
        }
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
        match live.responses.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Some((STATUS_READY, bytes))) if bytes.is_empty() => Ok(live),
            Ok(_) | Err(RecvTimeoutError::Disconnected) => Err(io::Error::other("the worker didn't announce itself")),
            Err(RecvTimeoutError::Timeout) => {
                Err(io::Error::new(io::ErrorKind::TimedOut, "the worker didn't start in time"))
            }
        }
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

    /// How the process ended: it gets a moment to finish exiting (the pipe closes a little before
    /// the process is gone), then it is killed if it is somehow still there.
    fn reap(&mut self) -> Option<ExitStatus> {
        for _ in 0..60 {
            match self.child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => return None,
            }
        }
        let _ = self.child.kill();
        self.child.wait().ok()
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
///
/// A worker that quit on its own because it sat idle (exit code 72) is not an error: the handle
/// starts a new one, and when the request had already gone to the old process (it quit in the
/// same instant) the request is sent again, once.
pub struct OodleWorker {
    exe: PathBuf,
    timeout: Duration,
    idle_ms: Option<u64>,
    live: Option<Live>,
}

impl OodleWorker {
    /// A handle for the worker `exe` (the Livery executable; see [`worker_main`]). Nothing runs
    /// until the first [`decode`](Self::decode).
    pub fn new(exe: impl Into<PathBuf>) -> Self {
        Self { exe: exe.into(), timeout: WORKER_TIMEOUT, idle_ms: None, live: None }
    }

    /// Sets the per-request deadline (default [`WORKER_TIMEOUT`]). It starts when the request is
    /// sent, after the worker has announced itself. The worker's own watchdog gives up on a
    /// decode after [`WORKER_TIMEOUT`] + 5 s whatever this says.
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    /// Makes workers started from now on quit after `ms` milliseconds without a request (the
    /// default is 60 s). For tests only.
    #[doc(hidden)]
    pub fn idle_limit_for_tests(mut self, ms: u64) -> Self {
        self.idle_ms = Some(ms);
        self
    }

    /// The process id of the running worker, if one is running.
    pub fn pid(&self) -> Option<u32> {
        self.live.as_ref().map(|live| live.child.id())
    }

    /// Makes sure a worker is running: `true` when one already was, `false` when this started it.
    fn ensure_live(&mut self) -> AppResult<bool> {
        if self.live.as_mut().is_some_and(|live| !live.alive()) {
            self.live = None;
        }
        if self.live.is_some() {
            return Ok(true);
        }
        let live = Live::start(&self.exe, self.idle_ms).map_err(|e| {
            AppError::new(ErrorCode::Io, super::MODEL_UNREADABLE)
                .with_detail(format!("Oodle worker {}: {e}", self.exe.display()))
        })?;
        self.live = Some(live);
        Ok(false)
    }

    /// Decodes `src` (a bare Oodle stream) to exactly `raw_len` bytes in the worker. The worker
    /// refuses streams over [`MAX_VERTEX_DATA`]; callers with a lower limit use [`oodle_with`].
    pub fn decode(&mut self, src: &[u8], raw_len: usize) -> AppResult<Vec<u8>> {
        if raw_len > MAX_VERTEX_DATA || src.len() > MAX_VERTEX_DATA {
            return Err(bad(format!("Oodle stream of {} bytes unpacking to {raw_len} is over the limit", src.len())));
        }
        let mut retried = false;
        loop {
            let reused = self.ensure_live()?;
            let Some(live) = self.live.as_mut() else { return Err(bad("oodle worker missing")) };
            let outcome = live.exchange(request_frame(src, raw_len as u32), self.timeout);
            match outcome {
                Outcome::Reply(STATUS_OK, bytes) if bytes.len() == raw_len => return Ok(bytes),
                Outcome::Reply(STATUS_ERROR, text) => return Err(bad(String::from_utf8_lossy(&text).into_owned())),
                Outcome::Reply(status, bytes) => {
                    self.live = None;
                    return Err(bad(format!(
                        "Oodle worker answered {status} with {} bytes for {raw_len}",
                        bytes.len()
                    )));
                }
                Outcome::Died => {
                    let status = self.live.take().and_then(|mut live| live.reap());
                    // A worker that had been idle quit just as the request went out: not a damaged
                    // stream. Ask a new one, once.
                    if reused && !retried && status.and_then(|s| s.code()) == Some(EXIT_IDLE) {
                        retried = true;
                        continue;
                    }
                    tracing::warn!(
                        "the Oodle worker died ({}) on a stream of {} bytes ({raw_len} out)",
                        describe(status),
                        src.len()
                    );
                    return Err(bad("oodle stream damaged"));
                }
                Outcome::TimedOut => {
                    self.live = None;
                    tracing::warn!("the Oodle worker timed out on a stream of {} bytes ({raw_len} out)", src.len());
                    return Err(bad("oodle stream timed out"));
                }
            }
        }
    }
}

/// An exit status for the log.
fn describe(status: Option<ExitStatus>) -> String {
    match status {
        Some(status) => status.to_string(),
        None => "exit status unknown".into(),
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
///
/// For tests only.
#[doc(hidden)]
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

/// The first zstd frame of `src` (bytes after it are ignored), at most `max` bytes.
pub fn zstd(src: &[u8], max: usize) -> AppResult<Vec<u8>> {
    read_frame(src, None, max as u64).map_err(|e| bad(format!("zstd: {e}")))
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
    fn the_watchdog_exits_on_a_long_decode_or_a_long_idle_and_otherwise_waits() {
        let (decode, idle) = (15_000, 60_000);
        // Decoding: only the decode limit counts, however long ago the last request came.
        assert_eq!(watchdog_verdict(20_000, 6_000, 6_000, decode, idle), None, "14 s into a decode");
        assert_eq!(watchdog_verdict(21_000, 6_000, 6_000, decode, idle), None, "exactly 15 s in");
        assert_eq!(watchdog_verdict(21_001, 6_000, 6_000, decode, idle), Some(EXIT_HUNG), "15 s and a ms in");
        assert_eq!(watchdog_verdict(500_000, 499_000, 1, decode, idle), None, "a decode that just began");
        // Idle (decoding_since 0): only the idle limit counts.
        assert_eq!(watchdog_verdict(61_000, 0, 1_001, decode, idle), None, "60 s idle exactly");
        assert_eq!(watchdog_verdict(61_002, 0, 1_001, decode, idle), Some(EXIT_IDLE));
        assert_eq!(watchdog_verdict(5, 0, 1, decode, idle), None, "just started");
        // A clock that reads before the last activity doesn't underflow.
        assert_eq!(watchdog_verdict(3, 9, 9, decode, idle), None);
        assert_eq!(watchdog_verdict(3, 0, 9, decode, idle), None);
    }

    #[test]
    fn activity_follows_a_request_through_the_server_loop() {
        let activity = Activity::new();
        assert_eq!(activity.decoding_since.load(Ordering::Relaxed), 0);
        let data = b"abc".to_vec();
        let input = request_frame(&stored(&data), 3);
        let mut output = Vec::new();
        serve_watched(&mut &input[..], &mut output, &activity).unwrap();
        // Back to idle once the answer has gone out, with the activity time moved on.
        assert_eq!(activity.decoding_since.load(Ordering::Relaxed), 0);
        assert!(activity.last.load(Ordering::Relaxed) >= 1);
        assert_eq!(activity.verdict(Duration::from_secs(15), Duration::from_secs(60)), None);
        activity.begin_decode();
        assert!(activity.decoding_since.load(Ordering::Relaxed) > 0);
        activity.end_decode();
        assert_eq!(activity.decoding_since.load(Ordering::Relaxed), 0);
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
