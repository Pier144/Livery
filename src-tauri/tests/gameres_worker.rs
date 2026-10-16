//! The Oodle worker process: framing and reuse, errors that come back from the worker, a
//! crashing stream (the worker dies, the caller gets an error, the next request starts a new
//! worker), the deadline, and the limits. The worker is the `livery` executable itself.
//!
//! Streams here are ones every decoder agrees on without entropy coding (there is no open Oodle
//! encoder): a stored block (`0xCC 0x0C` + the bytes) and a memset block.

use livery_lib::error::ErrorCode;
use livery_lib::game::gameres::codec::{oodle_with, OodleWorker, MAX_VERTEX_DATA};
use std::time::Duration;

const BLOCK: usize = 0x40000;

fn worker() -> OodleWorker {
    OodleWorker::new(env!("CARGO_BIN_EXE_livery"))
}

/// One stored block of `data` (at most 256 KiB).
fn stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0xCC, 0x0C];
    out.extend_from_slice(data);
    out
}

/// Synthetic bytes found by fuzzing (not from the game): they pass the header walk and make
/// oozextract's tANS/Huffman code `assert!`, which ends the worker process.
#[rustfmt::skip]
const CRASHER: [u8; 33] = [
    0x8C, 0x0C, 0x00, 0x00, 0x1B, 0x10, 0x24, 0x6C, 0x00, 0x08, 0x4C, 0x58, 0x9C, 0x19, 0xBD, 0x6E, 0x4A,
    0xB0, 0xDD, 0x2E, 0x02, 0x64, 0x4E, 0xEC, 0x3F, 0xE7, 0xCE, 0x69, 0x2F, 0xA3, 0x3C, 0xE6, 0xBD,
];
const CRASHER_RAW: usize = 2553;

/// A BitKnit block: the header walk refuses it.
const BITKNIT: [u8; 8] = [0x8C, 0x0B, 0x00, 0x00, 0x02, 1, 2, 3];

#[test]
fn requests_round_trip_through_one_reused_worker() {
    let mut w = worker();
    assert_eq!(w.pid(), None, "nothing runs before the first request");
    let small = b"hello worker".to_vec();
    assert_eq!(w.decode(&stored(&small), small.len()).unwrap(), small);
    let pid = w.pid().expect("the worker started");

    // A full block, and two blocks (the second a short one): framing for larger payloads.
    let full: Vec<u8> = (0..BLOCK).map(|i| (i % 251) as u8).collect();
    assert_eq!(w.decode(&stored(&full), BLOCK).unwrap(), full);
    let mut two = stored(&full);
    two.extend(stored(&[9; 10]));
    let want: Vec<u8> = full.iter().copied().chain([9; 10]).collect();
    assert_eq!(w.decode(&two, BLOCK + 10).unwrap(), want);
    // A memset block: a 5-byte request for 1000 bytes back.
    assert_eq!(w.decode(&[0x8C, 0x0C, 0x07, 0xFF, 0xFF, 0x55], 1000).unwrap(), vec![0x55; 1000]);
    assert_eq!(w.decode(&[], 0).unwrap(), Vec::<u8>::new());
    assert_eq!(w.pid(), Some(pid), "the same process served all of them");
}

#[test]
fn errors_come_back_from_the_worker_and_leave_it_running() {
    let mut w = worker();
    w.decode(&stored(b"abc"), 3).unwrap();
    let pid = w.pid();
    let e = w.decode(&BITKNIT, 1000).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert!(e.detail.unwrap().starts_with("oodle decoder 0xB"), "the header walk's own message");
    // Cut short: three bytes for a four byte block.
    assert!(w.decode(&stored(b"abc"), 4).unwrap_err().detail.unwrap().contains("past the end"));
    assert_eq!(w.decode(&stored(b"abc"), 3).unwrap(), b"abc");
    assert_eq!(w.pid(), pid, "a refused stream doesn't cost the worker");
}

#[test]
fn a_crashing_stream_is_an_error_and_the_next_request_starts_a_new_worker() {
    let mut w = worker();
    w.decode(&stored(b"abc"), 3).unwrap();
    let before = w.pid().unwrap();

    let e = w.decode(&CRASHER, CRASHER_RAW).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert_eq!(e.detail.as_deref(), Some("oodle stream damaged"));
    assert_eq!(w.pid(), None, "the dead worker is dropped");

    // The next request is answered by a new process: first a refusal from its header walk,
    // then a decode.
    let e = w.decode(&BITKNIT, 1000).unwrap_err();
    assert!(e.detail.unwrap().starts_with("oodle decoder"));
    let after = w.pid().expect("a new worker started");
    assert_ne!(after, before);
    assert_eq!(w.decode(&stored(b"xyz"), 3).unwrap(), b"xyz");
    assert_eq!(w.pid(), Some(after));
}

#[test]
fn a_request_that_misses_its_deadline_kills_the_worker() {
    let mut w = worker();
    // A zero deadline: the answer can't be there yet (the process has to start first).
    w.set_timeout(Duration::ZERO);
    let e = w.decode(&stored(b"abc"), 3).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert_eq!(e.detail.as_deref(), Some("oodle stream timed out"));
    assert_eq!(w.pid(), None, "the worker was killed");
    // The handle is fine afterwards.
    w.set_timeout(Duration::from_secs(10));
    assert_eq!(w.decode(&stored(b"abc"), 3).unwrap(), b"abc");
}

#[test]
fn limits_are_checked_before_anything_is_sent() {
    let mut w = worker();
    assert_eq!(w.decode(&[], MAX_VERTEX_DATA + 1).unwrap_err().code, ErrorCode::Parse);
    let e = oodle_with(&mut w, &stored(b"abc"), 2000, 1000).unwrap_err();
    assert!(e.detail.unwrap().contains("over the 1000 limit"));
    assert_eq!(oodle_with(&mut w, &stored(b"abc"), 3, 1000).unwrap(), b"abc");
    // The first two never started a process; the third did.
    assert!(w.pid().is_some());
    let mut idle = worker();
    assert!(idle.decode(&[], MAX_VERTEX_DATA + 1).is_err());
    assert_eq!(idle.pid(), None);
}

#[test]
fn a_missing_executable_is_an_io_error_and_retried_next_time() {
    let mut w = OodleWorker::new("Z:/no/such/livery.exe");
    for _ in 0..2 {
        let e = w.decode(&stored(b"abc"), 3).unwrap_err();
        assert_eq!(e.code, ErrorCode::Io);
        assert!(e.detail.unwrap().contains("Oodle worker"));
        assert_eq!(w.pid(), None);
    }
}

// ── The worker's own exits ──────────────────────────────────────────────────

/// Starts the worker by hand (stdin and stdout piped) and reads its "ready" frame.
fn raw_worker(idle_ms: Option<&str>) -> std::process::Child {
    use std::io::Read;
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_livery"));
    command.arg("--livery-oodle-worker").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
    if let Some(ms) = idle_ms {
        command.env("LIVERY_OODLE_WORKER_IDLE_MS", ms);
    }
    let mut child = command.spawn().unwrap();
    let mut ready = [0u8; 5];
    child.stdout.as_mut().unwrap().read_exact(&mut ready).unwrap();
    assert_eq!(ready, [2, 0, 0, 0, 0], "the worker announces itself first");
    child
}

#[test]
fn a_panic_in_the_decoder_exits_quietly_with_code_70() {
    use std::io::Write;
    let mut child = raw_worker(None);
    let mut request = Vec::new();
    request.extend_from_slice(&(CRASHER_RAW as u32).to_le_bytes());
    request.extend_from_slice(&(CRASHER.len() as u32).to_le_bytes());
    request.extend_from_slice(&CRASHER);
    child.stdin.as_mut().unwrap().write_all(&request).unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(70));
}

#[test]
fn an_idle_worker_quits_with_code_72() {
    let mut child = raw_worker(Some("200"));
    // `wait` closes stdin, which would end the worker cleanly; keep the pipe open instead.
    let _stdin = child.stdin.take();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(72), "no request for the idle limit");
}

#[test]
fn a_worker_that_quit_idle_is_replaced_without_an_error() {
    let mut w = worker().idle_limit_for_tests(300);
    assert_eq!(w.decode(&stored(b"abc"), 3).unwrap(), b"abc");
    let first = w.pid().unwrap();
    // Long enough for the worker to quit on its own.
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(w.decode(&stored(b"def"), 3).unwrap(), b"def", "no error for a worker that had quit idle");
    let second = w.pid().unwrap();
    assert_ne!(first, second);
}

#[test]
fn a_request_that_races_the_idle_exit_still_succeeds() {
    // The worker quits 60 ms after its last request; the next one comes about then, so now and
    // then it goes to a process that is exiting. Every request must still be answered.
    let mut w = worker().idle_limit_for_tests(60);
    for i in 0..40u64 {
        let data = [i as u8; 4];
        assert_eq!(w.decode(&stored(&data), 4).unwrap(), data, "request {i}");
        std::thread::sleep(Duration::from_millis(30 + (i % 7) * 10));
    }
}
