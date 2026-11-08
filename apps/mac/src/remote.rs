//! Pictures a chat shows from elsewhere: ky's own files (`/files/<id>`, signed in as the socket is),
//! https images, and `data:` URLs. Fetched once each on a thread; the window redraws when one lands.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::State;

enum Got {
    Loading,
    Ready(Arc<[u8]>),
    Failed,
}

#[derive(Default)]
pub struct Remote {
    got: Arc<Mutex<HashMap<String, Got>>>,
    /// Bumps as each picture lands: a memoized turn that shows pictures keys on it.
    arrived: Arc<AtomicU64>,
}

/// The largest picture fetched: 25 MB.
const MAX_BYTES: u64 = 25 << 20;

impl Remote {
    pub fn arrived(&self) -> u64 {
        self.arrived.load(Ordering::Relaxed)
    }
}

/// A saved file's id reads from ky's own `/files` (the web's `fileUrl`).
pub fn file_url(src: &str) -> String {
    if src.len() == 32 && src.bytes().all(|c| c.is_ascii_hexdigit()) { format!("/files/{src}") } else { src.to_string() }
}

impl State {
    /// The picture at `src` (a file id, a `/files/…` path, an https URL or a `data:` URL): its bytes
    /// once they're here; until then it's fetched, and `None`.
    pub fn picture_bytes(&self, src: &str) -> Option<Arc<[u8]>> {
        let src = file_url(src);
        if let Some(data) = src.strip_prefix("data:") {
            let (_, b64) = data.split_once(";base64,")?;
            return crate::media::decode(b64);
        }
        let mut got = self.remote.got.lock().ok()?;
        match got.get(&src) {
            Some(Got::Ready(bytes)) => return Some(bytes.clone()),
            Some(_) => return None,
            None => {}
        }
        let (config, waker) = (self.config.clone()?, self.waker.clone()?);
        let url = if src.starts_with('/') { format!("{}{src}", config.base.trim_end_matches('/')) } else if src.starts_with("https://") { src.clone() } else { return None };
        // ky's token goes only to ky.
        let ours = url.starts_with(config.base.trim_end_matches('/'));
        got.insert(src.clone(), Got::Loading);
        let (store, arrived) = (self.remote.got.clone(), self.remote.arrived.clone());
        std::thread::spawn(move || {
            let token = if ours { token_for(&config) } else { None };
            let fetched = fetch(&url, token.as_deref());
            if let Ok(mut got) = store.lock() {
                got.insert(src, fetched.map_or(Got::Failed, Got::Ready));
            }
            arrived.fetch_add(1, Ordering::Relaxed);
            waker();
        });
        None
    }

    /// The Access token ky's own pages and files go with: the configured one, else the last sign-in's
    /// (none for a ky on this computer).
    pub fn access_token(&self) -> Option<String> {
        token_for(self.config.as_ref()?)
    }

    /// The picture at `src`, decoding, or `None` while it's fetched (or when it couldn't be).
    pub fn picture(&self, src: &str) -> Option<rune::Image> {
        self.picture_bytes(src).map(|bytes| self.images.load(bytes))
    }

    /// Whether `src` couldn't be fetched.
    pub fn picture_failed(&self, src: &str) -> bool {
        self.remote.got.lock().is_ok_and(|got| matches!(got.get(&file_url(src)), Some(Got::Failed)))
    }
}

fn token_for(config: &crate::link::Config) -> Option<String> {
    match (&config.token, config.local()) {
        (Some(t), _) => Some(t.clone()),
        (None, true) => None,
        (None, false) => crate::signin::saved(&config.base),
    }
}

fn fetch(url: &str, token: Option<&str>) -> Option<Arc<[u8]>> {
    use std::io::Read;
    let mut call = ureq::get(url).timeout(Duration::from_secs(30));
    if let Some(token) = token {
        call = call.set("Cookie", &format!("CF_Authorization={token}")).set("cf-access-token", token);
    }
    let answer = call.call().ok()?;
    let mut bytes = Vec::new();
    answer.into_reader().take(MAX_BYTES).read_to_end(&mut bytes).ok()?;
    (!bytes.is_empty()).then(|| bytes.into())
}

/// The image sources a markdown text names (`![alt](src)`), so its pictures can be looked up first.
pub fn markdown_sources(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("![") {
        rest = &rest[at + 2..];
        let Some(close) = rest.find("](") else { break };
        let after = &rest[close + 2..];
        let Some(end) = after.find(')') else { break };
        let src = after[..end].split_whitespace().next().unwrap_or_default().trim_matches(['<', '>']);
        if !src.is_empty() {
            out.push(src.to_string());
        }
        rest = &after[end..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_names_its_pictures() {
        assert_eq!(markdown_sources("a ![x](/files/abc \"t\") b ![](https://e.com/i.png)"), ["/files/abc", "https://e.com/i.png"]);
        assert_eq!(file_url("0123456789abcdef0123456789abcdef"), "/files/0123456789abcdef0123456789abcdef");
    }
}
