//! A tiny HTTP/1.1 server on `127.0.0.1` for download tests: each path answers with bytes, a
//! redirect or a status; every connection closes after one response.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Clone)]
pub enum Route {
    /// 200 with these bytes and their `Content-Length`.
    Bytes(Vec<u8>),
    /// 200 with these bytes and no `Content-Length` (the body ends when the connection closes).
    Unsized(Vec<u8>),
    /// 200 with the first part, a pause, then the rest (with `Content-Length`).
    Slow(Vec<u8>, usize, Duration),
    /// 302 to this location.
    Redirect(String),
    /// This status with an empty body.
    Status(u16),
}

pub struct Server {
    pub port: u16,
    routes: Arc<Mutex<HashMap<String, Route>>>,
}

impl Server {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes: Arc<Mutex<HashMap<String, Route>>> = Arc::default();
        let served = Arc::clone(&routes);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let routes = Arc::clone(&served);
                thread::spawn(move || serve(stream, &routes));
            }
        });
        Self { port, routes }
    }

    pub fn route(&self, path: &str, route: Route) {
        self.routes.lock().unwrap().insert(path.to_owned(), route);
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

fn serve(mut stream: TcpStream, routes: &Mutex<HashMap<String, Route>>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head);
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
    let route = routes.lock().unwrap().get(&path).cloned().unwrap_or(Route::Status(404));
    let _ = match route {
        Route::Bytes(body) => {
            let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(header.as_bytes()).and_then(|()| stream.write_all(&body))
        }
        Route::Unsized(body) => {
            stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n").and_then(|()| stream.write_all(&body))
        }
        Route::Slow(body, first, pause) => {
            let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream
                .write_all(header.as_bytes())
                .and_then(|()| stream.write_all(&body[..first]))
                .and_then(|()| stream.flush())
                .map(|()| thread::sleep(pause))
                .and_then(|()| stream.write_all(&body[first..]))
        }
        Route::Redirect(location) => stream.write_all(
            format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        ),
        Route::Status(code) => stream
            .write_all(format!("HTTP/1.1 {code} Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()),
    };
    let _ = stream.flush();
}
