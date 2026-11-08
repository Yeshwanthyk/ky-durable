//! Finding a ky through the user's own Cloudflare login. The app keeps no Cloudflare login of its own:
//! it reads the auth profiles Cloudflare's `cf` CLI keeps on this Mac (`cf auth list`), lets the user
//! pick one, and signs in a new one with `cf auth create <name>`, which opens Cloudflare's own OAuth
//! page. With the picked profile's token it lists each account's Workers and keeps those `ky deploy`
//! tagged `ky` (`cli/deploy/contract.ts`), each at `<script>.<subdomain>.workers.dev`.
//!
//! Reads only: nothing here writes to Cloudflare. The token stays in memory; `cf` refreshes it.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

const API: &str = "https://api.cloudflare.com/client/v4";
/// `ky deploy`'s tags on a ky's Worker (`cli/deploy/contract.ts`).
const TAG: &str = "ky";
const RELEASE_TAG: &str = "ky-release-";

#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub name: String,
    /// Empty when the profile is signed out.
    pub email: String,
    pub accounts: Vec<Account>,
    token: Option<String>,
}

impl Profile {
    pub fn signed_in(&self) -> bool {
        self.token.is_some()
    }

    /// A login as a scene draws it.
    pub fn sample(name: &str, email: &str, accounts: &[(&str, &str)]) -> Profile {
        Profile {
            name: name.into(),
            email: email.into(),
            accounts: accounts.iter().map(|(id, name)| Account { id: (*id).into(), name: (*name).into() }).collect(),
            token: if email.is_empty() { None } else { Some("t".into()) },
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub id: String,
    pub name: String,
}

/// A ky on an account.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub name: String,
    pub url: String,
    /// The release it runs, from its `ky-release-<sha>` tag.
    pub release: Option<String>,
}

/// What one account holds: its kys, or why they couldn't be listed.
pub type Holds = Vec<(Account, Result<Vec<Found>, String>)>;

/// `cf`, wherever npm put it: an app opened from the Finder doesn't get the shell's PATH.
pub fn cf() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = &home {
        if let Ok(nodes) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut nodes: Vec<PathBuf> = nodes.flatten().map(|d| d.path().join("bin")).collect();
            nodes.sort();
            dirs.extend(nodes.into_iter().rev());
        }
        for d in [".volta/bin", ".bun/bin", ".npm-global/bin", ".local/bin", "Library/pnpm"] {
            dirs.push(home.join(d));
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs.into_iter().map(|d| d.join("cf")).find(|p| p.is_file())
}

fn command(cf: &PathBuf) -> Command {
    let mut c = Command::new(cf);
    // Without CLOUDFLARE_API_TOKEN, which cf would take as its login. Its own node first on PATH.
    c.env_remove("CLOUDFLARE_API_TOKEN");
    if let Some(bin) = cf.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(std::iter::once(bin.to_path_buf()).chain(std::env::split_paths(&path))).unwrap_or(path);
        c.env("PATH", joined);
    }
    c
}

/// `cf <args>`'s JSON answer.
fn ask(cf: &PathBuf, args: &[&str]) -> Result<Value, String> {
    let out = command(cf).args(args).stdin(Stdio::null()).output().map_err(|e| format!("couldn't run cf: {e}"))?;
    let said = String::from_utf8_lossy(&out.stdout);
    let start = said.find(['{', '[']).ok_or_else(|| last_line(&out.stderr).unwrap_or_else(|| "cf answered nothing".into()))?;
    serde_json::from_str(&said[start..]).map_err(|_| "cf answered something unreadable".into())
}

fn last_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes).lines().map(str::trim).filter(|l| !l.is_empty()).last().map(str::to_string)
}

/// Every cf profile on this Mac, with who it is and the accounts it reaches.
pub fn profiles() -> Result<Vec<Profile>, String> {
    let cf = cf().ok_or(NO_CF)?;
    #[derive(Deserialize)]
    struct Listed {
        name: String,
    }
    let listed: Vec<Listed> = serde_json::from_value(ask(&cf, &["auth", "list"])?).map_err(|_| "cf listed its profiles unreadably")?;
    let handles: Vec<_> = listed.into_iter().map(|l| {
        let cf = cf.clone();
        std::thread::spawn(move || whoami(&cf, &l.name))
    }).collect();
    Ok(handles.into_iter().filter_map(|h| h.join().ok()).collect())
}

pub const NO_CF: &str = "Cloudflare's cf CLI isn't on this Mac";

/// One profile, as `cf auth whoami` sees it (which also refreshes its token when it's run out).
fn whoami(cf: &PathBuf, name: &str) -> Profile {
    let signed_out = || Profile { name: name.to_string(), email: String::new(), accounts: Vec::new(), token: None };
    let Ok(v) = ask(cf, &["auth", "whoami", "--profile", name]) else { return signed_out() };
    if v.get("authenticated").and_then(Value::as_bool) != Some(true) || v.get("tokenValid").and_then(Value::as_bool) == Some(false) {
        return signed_out();
    }
    let Some(token) = v.get("authSource").and_then(Value::as_str).and_then(token_from) else { return signed_out() };
    let accounts = v
        .get("accounts")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .filter_map(|a| Some(Account { id: a.get("id")?.as_str()?.to_string(), name: a.get("name")?.as_str()?.to_string() }))
                .collect()
        })
        .unwrap_or_default();
    Profile { name: name.to_string(), email: v.get("email").and_then(Value::as_str).unwrap_or_default().to_string(), accounts, token: Some(token) }
}

/// The OAuth token in the file `cf auth whoami` names: `OAuth token from <file>.json`.
fn token_from(source: &str) -> Option<String> {
    let file = source.strip_prefix("OAuth token from ")?;
    if !file.ends_with(".json") {
        return None;
    }
    let v: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    v.get("oauth_token").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string)
}

/// The kys on each of the profile's accounts.
pub fn kys(profile: &Profile) -> Result<Holds, String> {
    let token = profile.token.clone().ok_or("This Cloudflare login is signed out")?;
    let handles: Vec<_> = profile
        .accounts
        .iter()
        .cloned()
        .map(|account| {
            let token = token.clone();
            std::thread::spawn(move || {
                let found = kys_on(&token, &account.id);
                (account, found)
            })
        })
        .collect();
    Ok(handles.into_iter().filter_map(|h| h.join().ok()).collect())
}

fn kys_on(token: &str, account: &str) -> Result<Vec<Found>, String> {
    #[derive(Deserialize)]
    struct Script {
        id: String,
        #[serde(default)]
        tags: Option<Vec<String>>,
    }
    let scripts: Vec<Script> = serde_json::from_value(get(token, &format!("/accounts/{account}/workers/scripts"))?)
        .map_err(|_| "Cloudflare listed the Workers unreadably")?;
    let ours: Vec<(String, Option<String>)> = scripts
        .into_iter()
        .filter_map(|s| {
            let tags = s.tags.unwrap_or_default();
            tags.iter().any(|t| t == TAG).then(|| (s.id, tags.iter().find_map(|t| t.strip_prefix(RELEASE_TAG)).map(str::to_string)))
        })
        .collect();
    if ours.is_empty() {
        return Ok(Vec::new());
    }
    let sub = get(token, &format!("/accounts/{account}/workers/subdomain"))?;
    let sub = sub.get("subdomain").and_then(Value::as_str).ok_or("This account has no workers.dev subdomain")?.to_string();
    Ok(ours
        .into_iter()
        .map(|(name, release)| Found { url: format!("https://{name}.{sub}.workers.dev"), name, release })
        .collect())
}

fn get(token: &str, path: &str) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(7))
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("ky-mac/", env!("CARGO_PKG_VERSION")))
        .build();
    let answer = match agent.get(&format!("{API}{path}")).set("Authorization", &format!("Bearer {token}")).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(403, _)) => return Err("This login can't read Workers here".into()),
        Err(ureq::Error::Status(code, _)) => return Err(format!("Cloudflare answered {code}")),
        Err(e) => return Err(format!("couldn't reach Cloudflare: {e}")),
    };
    let v: Value = answer.into_string().ok().and_then(|b| serde_json::from_str(&b).ok()).ok_or("Cloudflare answered unreadably")?;
    v.get("result").cloned().ok_or_else(|| "Cloudflare answered without a result".into())
}

/// A profile name cf takes: letters, digits, `-` and `_`.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `cf auth create <name>`: Cloudflare's sign-in page opens in the browser. Running until the user
/// finishes there; the caller waits on it (or kills it to cancel).
pub fn create(name: &str) -> Result<Child, String> {
    let cf = cf().ok_or(NO_CF)?;
    command(&cf)
        .args(["auth", "create", name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run cf: {e}"))
}

/// How `create` ended.
pub fn finished(child: Child) -> Result<(), String> {
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(last_line(&out.stderr).unwrap_or_else(|| "Cloudflare's sign-in didn't finish".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_name_is_plain() {
        assert!(valid_name("work"));
        assert!(valid_name("side_2"));
        assert!(!valid_name(""));
        assert!(!valid_name("my work"));
        assert!(!valid_name("../x"));
    }

    #[test]
    fn only_a_named_json_file_holds_a_token() {
        assert_eq!(token_from("API token from CLOUDFLARE_API_TOKEN"), None);
        assert_eq!(token_from("OAuth token from /nowhere/x.txt"), None);
    }
}

