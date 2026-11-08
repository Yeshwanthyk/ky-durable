//! The kys this app opened before, and the Cloudflare login (a `cf` profile) the user picked last.
//! New kys are found through that login (`cloud.rs`) or typed in; nothing names a ky in code.
//!
//! The app's own list lives in `~/Library/Application Support/ky-mac/kys.json`: addresses only. Tokens
//! live in the Keychain (`signin.rs`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ky {
    /// What the list shows: the Worker's name, or the address's host.
    pub name: String,
    /// `https://host`, or the local stack's `http://127.0.0.1:port`.
    pub url: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    kys: Vec<Ky>,
    #[serde(default)]
    last: Option<String>,
    /// The `cf` profile picked last.
    #[serde(default)]
    profile: Option<String>,
}

/// The kys this app opened before, last opened first.
pub fn recent() -> Vec<Ky> {
    let saved = load();
    let mut all = saved.kys;
    if let Some(last) = &saved.last {
        if let Some(at) = all.iter().position(|k| same(&k.url, last)) {
            let k = all.remove(at);
            all.insert(0, k);
        }
    }
    all
}

/// The `cf` profile picked last.
pub fn profile() -> Option<String> {
    load().profile
}

pub fn use_profile(name: &str) {
    let mut saved = load();
    saved.profile = Some(name.to_string());
    store(&saved);
}

/// The ky opened last, to open again at launch.
pub fn last() -> Option<Ky> {
    let saved = load();
    let url = saved.last?;
    Some(saved.kys.into_iter().find(|k| same(&k.url, &url)).unwrap_or_else(|| Ky { name: name_of(&url), url }))
}

/// Remember `ky` and open it next launch.
pub fn opened(ky: &Ky) {
    let mut saved = load();
    if !saved.kys.iter().any(|k| same(&k.url, &ky.url)) {
        saved.kys.push(ky.clone());
    }
    saved.last = Some(ky.url.clone());
    store(&saved);
}

/// Stop opening `url` at launch (signing out leaves it in the list).
pub fn forget_last() {
    let mut saved = load();
    saved.last = None;
    store(&saved);
}

/// A typed address as a ky: `squarey.example.workers.dev` or `https://…/chat` → `https://host`.
pub fn parse(typed: &str) -> Option<Ky> {
    let typed = typed.trim().trim_end_matches('/');
    if typed.is_empty() || typed.contains(char::is_whitespace) {
        return None;
    }
    let with_scheme = if typed.contains("://") { typed.to_string() } else { format!("https://{typed}") };
    let (scheme, rest) = with_scheme.split_once("://")?;
    let host = rest.split('/').next()?.to_ascii_lowercase();
    if !matches!(scheme, "https" | "http") || !host.contains(['.', ':']) {
        return None;
    }
    let url = format!("{scheme}://{host}");
    Some(Ky { name: name_of(&url), url })
}

/// The first label of the host: `squarey` for `https://squarey.someone.workers.dev`.
fn name_of(url: &str) -> String {
    let host = url.split("://").nth(1).unwrap_or(url);
    host.split(['.', ':']).next().unwrap_or(host).to_string()
}

fn same(a: &str, b: &str) -> bool {
    a.trim_end_matches('/').eq_ignore_ascii_case(b.trim_end_matches('/'))
}

fn saved_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/ky-mac/kys.json"))
}

fn load() -> Saved {
    saved_path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn store(saved: &Saved) {
    let Some(path) = saved_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(saved) {
        let _ = std::fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_address_becomes_a_ky() {
        assert_eq!(parse("ky.someone.workers.dev").unwrap().url, "https://ky.someone.workers.dev");
        assert_eq!(parse("https://Ky.Someone.workers.dev/chat/2").unwrap(), Ky { name: "ky".into(), url: "https://ky.someone.workers.dev".into() });
        assert_eq!(parse("http://127.0.0.1:8790").unwrap().url, "http://127.0.0.1:8790");
        assert!(parse("").is_none());
        assert!(parse("not an address").is_none());
        assert!(parse("ftp://x.y").is_none());
    }
}
