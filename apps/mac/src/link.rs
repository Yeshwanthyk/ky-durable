//! The socket to ky, on its own thread. It owns the connection: it connects, reconnects with backoff,
//! keeps the socket alive, and decodes every frame here, so the UI thread gets typed events and
//! never parses JSON. Each batch it hands over wakes the window once.
//!
//! What the UI sends goes through `Outbox`; a send waits in the queue while the socket is down and
//! goes out once it is up again. A snapshot after every reconnect replaces the window's state.

use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message as WsMessage, WebSocket};

use crate::signin;
use crate::wire::{self, Event, Frame};

/// Where ky is and how to sign in.
#[derive(Clone, Debug)]
pub struct Config {
    /// `http(s)://host[:port]`.
    pub base: String,
    /// A Cloudflare Access token: the `CF_Authorization` cookie's value. When unset and ky isn't on
    /// this computer, the one the user's last sign-in saved in the Keychain (`signin::saved`).
    pub token: Option<String>,
    /// The chat to follow; `1` is the main chat.
    pub session: String,
    /// Hand over what every socket hears alike (the chat list, settings, subscriptions). One socket,
    /// the main chat's, does; the others drop those frames here.
    pub shared: bool,
}

impl Config {
    /// The main chat on `base`. `KY_TOKEN` signs in only to the address `KY_URL` names (the local
    /// stack's FakeAccess token, from `scripts/dev`); anything else signs in through Access.
    pub fn for_ky(base: &str) -> Config {
        let pinned = std::env::var("KY_URL").is_ok_and(|url| url.trim_end_matches('/') == base.trim_end_matches('/'));
        Config {
            base: base.to_string(),
            token: std::env::var("KY_TOKEN").ok().filter(|t| pinned && !t.is_empty()),
            session: MAIN.into(),
            shared: true,
        }
    }

    /// The same ky, another chat: a side chat's socket.
    pub fn side(&self, session: &str) -> Config {
        Config { session: session.to_string(), shared: false, ..self.clone() }
    }

    /// ky on this computer (the local stack) needs no cloudflared.
    pub fn local(&self) -> bool {
        self.base.contains("://127.0.0.1") || self.base.contains("://localhost")
    }

    fn socket_url(&self) -> String {
        let ws = self.base.replacen("http", "ws", 1);
        format!("{}/agents/pi-agent/me?session={}", ws.trim_end_matches('/'), self.session)
    }
}

/// The main chat's session (`ROOT_SESSION`).
pub const MAIN: &str = "1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Connecting,
    Open { version: String },
    /// Down, retrying in a moment; why, for the title bar's tooltip.
    Down(String),
    /// No good sign-in: the user signs in (the window offers it); the socket waits for the Keychain.
    SignedOut(String),
}

/// What the socket thread hands the UI thread.
pub enum Inbound {
    Status(Status),
    Events(Vec<Event>),
    Chats(Vec<wire::ChatRow>),
    Settings(wire::SettingsView),
    Subscriptions(Vec<wire::Subscription>),
    Approvals(Vec<wire::Approval>),
    Tools(Vec<wire::ToolInfo>),
    Executor(serde_json::Value),
    Setup(serde_json::Value),
    Tasks(serde_json::Value, serde_json::Value),
    Automations(serde_json::Value, bool),
    Avatars(serde_json::Value),
    /// A command's answer, by the id it was sent with: its result, or why it failed.
    Answer(String, Result<serde_json::Value, String>),
}

pub type Outbox = Sender<String>;

/// Start the socket thread. `wake` is Rune's waker: it runs `poll` on the UI thread.
pub fn start(config: Config, wake: impl Fn() + Send + 'static) -> (Outbox, Receiver<Inbound>) {
    let (out_tx, out_rx) = mpsc::channel::<String>();
    let (in_tx, in_rx) = mpsc::channel::<Inbound>();
    thread::Builder::new()
        .name("ky-socket".into())
        .spawn(move || run(config, out_rx, in_tx, wake))
        .expect("spawn the socket thread");
    (out_tx, in_rx)
}

/// How long a read waits before the thread looks at the outbox: the send latency floor.
const READ_SLICE: Duration = Duration::from_millis(15);
/// The socket's read buffer: it grows for a bigger frame.
const READ_BUFFER: usize = 8 << 10;
const FRAME: Duration = Duration::from_micros(8_333);
const KEEPALIVE: Duration = Duration::from_secs(25);
const BACKOFF_MAX: Duration = Duration::from_secs(8);

fn run(config: Config, outbox: Receiver<String>, inbound: Sender<Inbound>, wake: impl Fn()) {
    let send = |message: Inbound| {
        if let Inbound::Status(status) = &message {
            trace(&format!("{status:?}"));
        }
        if inbound.send(message).is_ok() {
            wake();
        }
    };
    let mut backoff = Duration::from_millis(250);
    let mut queued: Vec<String> = Vec::new();
    let mut token = config.token.clone();
    // The saved token ky last turned away, not to be tried again.
    let mut refused: Option<String> = None;
    loop {
        if token.is_none() && !config.local() {
            match signin::saved(&config.base).filter(|t| Some(t) != refused.as_ref()) {
                Some(t) => token = Some(t),
                None => {
                    let why = if refused.is_some() { "ky turned the sign-in away" } else { "not signed in" };
                    send(Inbound::Status(Status::SignedOut(why.into())));
                    if !wait(&outbox, &mut queued, SIGNED_OUT_POLL) {
                        return;
                    }
                    continue;
                }
            }
        }
        send(Inbound::Status(Status::Connecting));
        match connect(&config, token.as_deref()) {
            Ok(mut socket) => {
                trace("socket open");
                backoff = Duration::from_millis(250);
                let why = serve(&mut socket, &outbox, &mut queued, config.shared, &send);
                let _ = socket.close(None);
                match why {
                    Stop::Quit => return,
                    Stop::Lost(why) => send(Inbound::Status(Status::Down(why))),
                }
            }
            Err(Refused::SignIn(_)) if config.token.is_none() && !config.local() => {
                // The token expired or was revoked: wait for the user to sign in again.
                refused = token.take();
                continue;
            }
            Err(Refused::SignIn(why) | Refused::Other(why)) => send(Inbound::Status(Status::Down(why))),
        }
        if !wait(&outbox, &mut queued, backoff) {
            return;
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// How often a signed-out socket looks for the Keychain's new token.
const SIGNED_OUT_POLL: Duration = Duration::from_secs(2);

/// Wait `pause`, keeping what the user sent while the socket was down. False once the window let go.
fn wait(outbox: &Receiver<String>, queued: &mut Vec<String>, pause: Duration) -> bool {
    loop {
        match outbox.try_recv() {
            Ok(text) => queued.push(text),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => return false,
        }
    }
    thread::sleep(pause);
    true
}

enum Stop {
    Quit,
    Lost(String),
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

enum Refused {
    /// Access turned the token away (or redirected to its login page).
    SignIn(String),
    Other(String),
}

impl From<String> for Refused {
    fn from(why: String) -> Refused {
        Refused::Other(why)
    }
}

fn connect(config: &Config, token: Option<&str>) -> Result<Socket, Refused> {
    let mut request = config.socket_url().into_client_request().map_err(|e| e.to_string())?;
    if let Some(token) = token {
        let headers = request.headers_mut();
        headers.insert("Cookie", HeaderValue::from_str(&format!("CF_Authorization={token}")).map_err(|e| e.to_string())?);
        headers.insert("cf-access-token", HeaderValue::from_str(token).map_err(|e| e.to_string())?);
    }
    // A read buffer sized for ky's frames, not tungstenite's 128 KiB default: it zeroes the whole
    // buffer before each read, and this thread reads every READ_SLICE to look at the outbox.
    let ws = tungstenite::protocol::WebSocketConfig::default().read_buffer_size(READ_BUFFER);
    let (socket, _) = tungstenite::client::connect_with_config(request, Some(ws), 3).map_err(|e| match e {
        tungstenite::Error::Http(response) => {
            let code = response.status().as_u16();
            let why = format!("ky answered {code}: sign in again");
            if matches!(code, 302 | 401 | 403) { Refused::SignIn(why) } else { Refused::Other(format!("ky answered {code}")) }
        }
        e => Refused::Other(e.to_string()),
    })?;
    let tcp = match socket.get_ref() {
        MaybeTlsStream::Plain(tcp) => tcp,
        MaybeTlsStream::Rustls(tls) => tls.get_ref(),
        _ => return Err(Refused::Other("unexpected stream".into())),
    };
    tcp.set_nodelay(true).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(READ_SLICE)).map_err(|e| e.to_string())?;
    Ok(socket)
}

fn serve(socket: &mut Socket, outbox: &Receiver<String>, queued: &mut Vec<String>, shared: bool, send: &impl Fn(Inbound)) -> Stop {
    let mut last_traffic = Instant::now();
    let mut open = false;
    loop {
        // Out: what waited, then anything new.
        if open {
            for text in queued.drain(..) {
                if let Err(e) = socket.send(WsMessage::text(text)) {
                    return Stop::Lost(e.to_string());
                }
            }
            loop {
                match outbox.try_recv() {
                    Ok(text) => {
                        if let Err(e) = socket.send(WsMessage::text(text)) {
                            return Stop::Lost(e.to_string());
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return Stop::Quit,
                }
            }
        }
        if last_traffic.elapsed() > KEEPALIVE {
            if let Err(e) = socket.send(WsMessage::text(wire::PING)) {
                return Stop::Lost(e.to_string());
            }
            last_traffic = Instant::now();
        }
        // In: every frame that's ready, decoded here, handed over as one batch.
        let mut events = Vec::new();
        let batch_started = Instant::now();
        loop {
            // A steady stream still lands every frame: hand over at least once per 120 Hz frame.
            if !events.is_empty() && batch_started.elapsed() >= FRAME {
                break;
            }
            match socket.read() {
                Ok(WsMessage::Text(text)) => {
                    last_traffic = Instant::now();
                    trace(&format!("frame {}", &text[..text.floor_char_boundary(160)]));
                    match wire::decode(&text) {
                        Some(Frame::Hello { version, tools }) => {
                            open = true;
                            send(Inbound::Status(Status::Open { version }));
                            if shared {
                                send(Inbound::Tools(tools));
                            }
                        }
                        Some(Frame::Approvals { approvals }) if shared => send(Inbound::Approvals(approvals)),
                        Some(Frame::Tools { tools }) if shared => send(Inbound::Tools(tools)),
                        Some(Frame::Executor { executor }) if shared => send(Inbound::Executor(executor)),
                        Some(Frame::Setup { setup }) if shared => send(Inbound::Setup(setup)),
                        Some(Frame::Tasks { tasks, machines }) if shared => send(Inbound::Tasks(tasks, machines)),
                        Some(Frame::Automations { automations, check_ins }) if shared => send(Inbound::Automations(automations, check_ins)),
                        Some(Frame::Avatars { avatars }) if shared => send(Inbound::Avatars(avatars)),
                        Some(Frame::Events { events: batch, .. }) => events.extend(batch),
                        Some(Frame::Chats { chats }) if shared => send(Inbound::Chats(chats)),
                        Some(Frame::Settings { settings }) if shared => send(Inbound::Settings(settings)),
                        Some(Frame::Subscriptions { subscriptions }) if shared => send(Inbound::Subscriptions(subscriptions)),
                        Some(Frame::Result { id, result }) => send(Inbound::Answer(id, Ok(result))),
                        Some(Frame::Error { id: Some(id), message }) => send(Inbound::Answer(id, Err(message))),
                        Some(_) => {}
                        None if text.starts_with('{') => {
                            // A frame the app should read that didn't decode: the protocol moved.
                            let head = &text[..text.len().min(120)];
                            if head.contains(r#""type":"events""#) || head.contains(r#""type":"hello""#) {
                                trace(&format!("undecoded frame: {head}"));
                                eprintln!("ky-mac: a frame didn't decode; rerecord fixtures/ and update wire.rs: {head}");
                            }
                        }
                        None => {}
                    }
                    // A long backlog lands in slices, so the window draws while it catches up.
                    if events.len() >= 256 {
                        break;
                    }
                }
                Ok(WsMessage::Close(frame)) => return Stop::Lost(frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "closed".into())),
                Ok(_) => last_traffic = Instant::now(),
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
                Err(e) => return Stop::Lost(e.to_string()),
            }
        }
        if !events.is_empty() {
            send(Inbound::Events(events));
        }
    }
}

/// `KY_TRACE=<file>`: the socket's statuses and the head of every frame, appended to that file. A
/// file, because Rune's headless runs keep stderr to themselves.
fn trace(line: &str) {
    use std::io::Write;
    static FILE: std::sync::OnceLock<Option<std::sync::Mutex<std::fs::File>>> = std::sync::OnceLock::new();
    let file = FILE.get_or_init(|| {
        let path = std::env::var_os("KY_TRACE")?;
        std::fs::OpenOptions::new().create(true).append(true).open(path).ok().map(std::sync::Mutex::new)
    });
    if let Some(file) = file {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "{:.3} {line}", std::time::UNIX_EPOCH.elapsed().map(|d| d.as_secs_f64()).unwrap_or(0.0));
        }
    }
}
