//! Reads big frames over wss with the app's 15 ms read slice, as link.rs does:
//! `cargo run --example tls_probe -- wss://echo.websocket.org/ 200000`.
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;
fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("a wss url");
    let size: usize = args.next().map(|s| s.parse().unwrap()).unwrap_or(200_000);
    let (mut ws, _) = tungstenite::connect(url.as_str()).unwrap();
    if let MaybeTlsStream::Rustls(tls) = ws.get_ref() {
        tls.get_ref().set_read_timeout(Some(Duration::from_millis(15))).unwrap();
    }
    let _ = ws.read(); // the server's greeting
    let body = "x".repeat(size);
    ws.send(Message::text(format!("{{\"type\":\"hello\",\"pad\":\"{body}\"}}"))).unwrap();
    let t = Instant::now();
    let mut timeouts = 0;
    loop {
        match ws.read() {
            Ok(Message::Text(s)) => { println!("got {} bytes after {:?}, {timeouts} timeouts", s.len(), t.elapsed()); break; }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                timeouts += 1;
                if t.elapsed() > Duration::from_secs(10) { println!("stuck: {timeouts} timeouts, nothing after 10 s"); break; }
            }
            Err(e) => { println!("error {e}"); break; }
        }
    }
}
