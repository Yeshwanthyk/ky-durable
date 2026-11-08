//! Signing in to a ky behind Cloudflare Access, from the app, as `cloudflared access login` does
//! (cloudflared's `token/token.go`, `token/transfer.go`, `token/jwks.go`), so nobody installs cloudflared.
//!
//! 1. **Which Access app guards this ky.** A `HEAD` with `cf-access-metadata-request: true` makes
//!    Cloudflare's edge answer with a signed JWT naming the app's AUD and the team's auth domain. Its
//!    signature is checked against the team's keys, and its hostname against the address asked for,
//!    so a look-alike server can't send the sign-in elsewhere.
//! 2. **The browser signs in.** The app makes a throwaway key pair and opens
//!    `<ky>/cdn-cgi/access/cli?token=<public key>&aud=…`: the owner's own Access login page.
//! 3. **The token comes back sealed.** Meanwhile the app long-polls
//!    `login.cloudflareaccess.org/transfer/<public key>`; once the owner signs in, it answers with
//!    `{app_token, org_token}` sealed to that key (NaCl box), which only this process can open.
//! 4. **The Keychain keeps it**, under the ky's address. Only the user starts a sign-in (`browser`);
//!    everything else reads the saved token (`saved`) and says "signed out" when there's none.
//!    ky's server checks it on every request, so the
//!    app reads the expiry only to know when to ask again.
//!
//! Every ky made with `ky init` sits behind its owner's own Access, so this works for anyone's ky; the
//! address is the only thing the app asks for.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use crypto_box::aead::{Aead, OsRng};
use crypto_box::{PublicKey, SalsaBox, SecretKey};
use serde::Deserialize;

const KEYCHAIN_SERVICE: &str = "ky-mac";
const ACCESS_DOMAIN_SUFFIX: &str = ".cloudflareaccess.com";
const TRANSFER: &str = "https://login.cloudflareaccess.org/transfer/";
/// A sign-in left open in the browser gives up after about ten minutes, as cloudflared does.
const POLLS: usize = 10;
const POLL_TIMEOUT: Duration = Duration::from_secs(60);
/// Ask again a minute before the token runs out, not after the socket is refused.
const EXPIRY_MARGIN: u64 = 60;

/// The saved token for `base` while it is good. The socket and HTTP calls use only this: a browser
/// opens only when the user presses Sign in (`browser`).
pub fn saved(base: &str) -> Option<String> {
    let origin = origin(base).ok()?;
    keychain::get(&origin).filter(|t| !expired(t))
}

/// A browser sign-in on `base`'s Access page, kept in the Keychain. Runs until the user finishes
/// there (or about ten minutes pass).
pub fn browser(base: &str) -> Result<String, String> {
    let origin = origin(base)?;
    let app = app_info(&origin)?;
    let token = transfer(&origin, &app.aud)?;
    keychain::set(&origin, &token);
    Ok(token)
}

/// Forget the saved token for `base` (sign out).
pub fn forget(base: &str) {
    if let Ok(origin) = origin(base) {
        keychain::delete(&origin);
    }
}

/// `https://host` with no path, lower-case: the Keychain account and the Access app's address.
fn origin(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    let (scheme, rest) = base.split_once("://").ok_or_else(|| format!("{base} isn't an address (https://…)"))?;
    if scheme != "https" {
        return Err(format!("{base}: a deployed ky answers on https"));
    }
    let host = rest.split('/').next().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty() {
        return Err(format!("{base} has no host"));
    }
    Ok(format!("https://{host}"))
}

fn host_of(origin: &str) -> &str {
    origin.trim_start_matches("https://")
}

/// The metadata JWT's claims (cloudflared `metadataClaims`).
#[derive(Debug, Deserialize)]
struct AppInfo {
    #[serde(rename = "type")]
    kind: String,
    hostname: String,
    auth_domain: String,
    aud: String,
    iat: u64,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(7))
        .user_agent(concat!("ky-mac/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// Step 1: which Access app guards `origin`, checked against the team's keys.
fn app_info(origin: &str) -> Result<AppInfo, String> {
    let response = match agent()
        .head(origin)
        .set("cf-access-metadata-request", "true")
        .timeout(Duration::from_secs(7))
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(e) => return Err(format!("couldn't reach {origin}: {e}")),
    };
    let jwt = response
        .header("cf-access-metadata")
        .ok_or_else(|| format!("{origin} isn't behind Cloudflare Access"))?
        .to_string();

    // The unverified claims name the team, whose keys then check the signature.
    let unverified: AppInfo = claims(&jwt).ok_or("Access sent an unreadable app description")?;
    let team = unverified.auth_domain.to_ascii_lowercase();
    if !team.ends_with(ACCESS_DOMAIN_SUFFIX) || team.contains('/') {
        return Err(format!("Access named an unexpected sign-in domain ({team})"));
    }
    let info = verify(&jwt, &team)?;

    let now = now();
    if !info.hostname.eq_ignore_ascii_case(host_of(origin)) {
        return Err(format!("Access described {} when asked about {}", info.hostname, host_of(origin)));
    }
    if info.kind != "match" || info.aud.is_empty() {
        return Err("Access found no app for this address".into());
    }
    if info.iat + 24 * 3600 < now || info.iat > now + 300 {
        return Err("Access's app description is out of date; check this computer's clock".into());
    }
    Ok(info)
}

#[derive(Deserialize)]
struct Certs {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

fn verify(jwt: &str, team: &str) -> Result<AppInfo, String> {
    use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
    let kid = decode_header(jwt).ok().and_then(|h| h.kid).ok_or("Access's app description isn't signed")?;
    let certs = agent()
        .get(&format!("https://{team}/cdn-cgi/access/certs"))
        .timeout(Duration::from_secs(7))
        .call()
        .map_err(|e| format!("couldn't fetch {team}'s keys: {e}"))?
        .into_string()
        .map_err(|e| format!("couldn't fetch {team}'s keys: {e}"))?;
    let certs: Certs = serde_json::from_str(&certs).map_err(|e| format!("{team}'s keys didn't parse: {e}"))?;
    let key = certs.keys.iter().find(|k| k.kid == kid).ok_or("Access signed with a key its team doesn't list")?;
    let key = DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|e| e.to_string())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_aud = false;
    decode::<AppInfo>(jwt, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| format!("Access's app description failed its signature check: {e}"))
}

#[derive(Deserialize)]
struct Transferred {
    app_token: String,
}

/// Steps 2 and 3: the browser signs in; the token comes back sealed to a key only this process has.
fn transfer(origin: &str, aud: &str) -> Result<String, String> {
    let secret = SecretKey::generate(&mut OsRng);
    let public = URL_SAFE.encode(secret.public_key().as_bytes());

    // cloudflared's buildRequestURL: the token and aud ride on both the redirect and the cli URL.
    let redirect = format!("{origin}/?aud={}&token={}", enc(aud), enc(&public));
    let url = format!(
        "{origin}/cdn-cgi/access/cli?aud={}&edge_token_transfer=true&redirect_url={}&send_org_token=true&token={}",
        enc(aud),
        enc(&redirect),
        enc(&public)
    );
    std::process::Command::new("open").arg(&url).status().map_err(|e| format!("couldn't open the browser: {e}"))?;

    let poll = format!("{TRANSFER}{public}");
    for _ in 0..POLLS {
        match agent().get(&poll).timeout(POLL_TIMEOUT).call() {
            Ok(response) if response.status() == 200 => {
                let sender = response.header("service-public-key").ok_or("the sign-in came back without its key")?.to_string();
                let body = response.into_string().map_err(|e| e.to_string())?;
                let sealed = STANDARD.decode(body.trim()).map_err(|_| "the sign-in came back unreadable")?;
                let opened = open(&sealed, &sender, &secret)?;
                let tokens: Transferred = serde_json::from_slice(&opened).map_err(|_| "the sign-in came back unreadable")?;
                return Ok(tokens.app_token);
            }
            // Not signed in yet: the endpoint answers once the browser finishes.
            Ok(_) | Err(ureq::Error::Status(400..=499, _)) => {}
            Err(ureq::Error::Status(code, _)) => return Err(format!("Cloudflare's sign-in service answered {code}")),
            Err(ureq::Error::Transport(e)) if e.kind() == ureq::ErrorKind::Io => {} // the long poll timed out
            Err(e) => return Err(format!("Cloudflare's sign-in service: {e}")),
        }
    }
    Err("the browser sign-in didn't finish".into())
}

/// NaCl box: a 24-byte nonce, then the sealed bytes.
fn open(sealed: &[u8], sender: &str, secret: &SecretKey) -> Result<Vec<u8>, String> {
    if sealed.len() < 24 {
        return Err("the sign-in came back too short".into());
    }
    let sender = URL_SAFE.decode(sender).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()).ok_or("the sign-in's key is malformed")?;
    let (nonce, body) = sealed.split_at(24);
    SalsaBox::new(&PublicKey::from(sender), secret)
        .decrypt(nonce.into(), body)
        .map_err(|_| "the sign-in didn't open with this app's key".to_string())
}

fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A JWT's claims, unverified: for the expiry and to find the signer.
fn claims<T: for<'de> Deserialize<'de>>(jwt: &str) -> Option<T> {
    let payload = jwt.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()
}

fn expired(jwt: &str) -> bool {
    #[derive(Deserialize)]
    struct Exp {
        exp: u64,
    }
    claims::<Exp>(jwt).is_none_or(|c| c.exp <= now() + EXPIRY_MARGIN)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The login Keychain, one generic password per ky address.
mod keychain {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    use super::KEYCHAIN_SERVICE;

    pub fn get(origin: &str) -> Option<String> {
        get_generic_password(KEYCHAIN_SERVICE, origin).ok().and_then(|b| String::from_utf8(b).ok())
    }

    pub fn set(origin: &str, token: &str) {
        let _ = set_generic_password(KEYCHAIN_SERVICE, origin, token.as_bytes());
    }

    pub fn delete(origin: &str) {
        let _ = delete_generic_password(KEYCHAIN_SERVICE, origin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_becomes_its_origin() {
        assert_eq!(origin("https://Ky.Example.workers.dev/chat/3").unwrap(), "https://ky.example.workers.dev");
        assert!(origin("http://ky.example.com").is_err());
        assert!(origin("ky.example.com").is_err());
    }

    #[test]
    fn a_sealed_token_opens_with_this_apps_key_only() {
        let app = SecretKey::generate(&mut OsRng);
        let service = SecretKey::generate(&mut OsRng);
        let nonce = [7u8; 24];
        let sealed = SalsaBox::new(&app.public_key(), &service).encrypt((&nonce).into(), &b"{\"app_token\":\"a.b.c\"}"[..]).unwrap();
        let wire = [nonce.as_slice(), &sealed].concat();
        let sender = URL_SAFE.encode(service.public_key().as_bytes());

        let opened = open(&wire, &sender, &app).unwrap();
        assert_eq!(serde_json::from_slice::<Transferred>(&opened).unwrap().app_token, "a.b.c");
        assert!(open(&wire, &sender, &SecretKey::generate(&mut OsRng)).is_err());
    }

    #[test]
    fn a_token_near_its_expiry_counts_as_expired() {
        let jwt = |exp: u64| format!("h.{}.s", URL_SAFE_NO_PAD.encode(format!("{{\"exp\":{exp}}}")));
        assert!(!expired(&jwt(now() + 3600)));
        assert!(expired(&jwt(now() + 10)));
        assert!(expired("not-a-jwt"));
    }
}
