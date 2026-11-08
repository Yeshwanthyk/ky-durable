//! The first screen, and "Switch ky": three explicit steps, each the user's own press.
//!
//! 1. **A Cloudflare login.** The `cf` CLI's auth profiles on this Mac, by email; or a new one, which
//!    `cf auth create` signs in on Cloudflare's own page (`cloud.rs`).
//! 2. **A ky.** Each account the login reaches, with the kys deployed there.
//! 3. **Its Access sign-in.** Only when the Keychain has no good one: "Continue in browser" opens that
//!    ky's Cloudflare Access page (`signin::browser`). Nothing else opens a browser; a ky that turns
//!    the sign-in away later says so in the window and offers the same button.
//!
//! Recent kys and a typed address stay one press away, for a ky on someone else's Cloudflare.

use std::sync::mpsc::{Receiver, Sender, channel};

use rune::{El, ScrollSpec, TextEdit, TextStyle, col, el, row, text, text_input};
use rune_kit::{Kit, Spinner};

use crate::State;
use crate::cards::button_el;
use crate::cloud::{self, Holds, Profile};
use crate::kys::{self, Ky};
use crate::signin;
use crate::theme::{BODY, META, META_STRONG, Palette, RADIUS, TITLE};

#[derive(Default)]
pub enum Load<T> {
    #[default]
    Idle,
    Loading,
    Ready(T),
    Failed(String),
}

pub enum Msg {
    Profiles(Result<Vec<Profile>, String>),
    Holds(String, Result<Holds, String>),
    Created(String, Result<(), String>),
    Signed(u64, Ky, Result<(), String>),
}

pub struct Welcome {
    pub profiles: Load<Vec<Profile>>,
    /// The login picked: step 2.
    pub profile: Option<String>,
    /// The login picked last time, marked in the list.
    pub last_profile: Option<String>,
    pub holds: Load<Holds>,
    /// Adding a login: its name, and the `cf auth create` running (by name, pid).
    pub naming: bool,
    pub name: TextEdit,
    pub creating: Option<(String, u32)>,
    pub create_error: Option<String>,
    /// The ky picked whose Access sign-in is next: step 3.
    pub access: Option<Ky>,
    /// The browser sign-in running, by its run.
    pub signing: Option<(u64, String)>,
    pub sign_error: Option<String>,
    /// A login just added, to go on to once the list has it.
    added: Option<String>,
    runs: u64,
    pub by_address: bool,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
}

impl Default for Welcome {
    fn default() -> Welcome {
        let (tx, rx) = channel();
        Welcome {
            profiles: Load::Idle,
            profile: None,
            last_profile: None,
            holds: Load::Idle,
            naming: false,
            name: TextEdit::new(""),
            creating: None,
            create_error: None,
            access: None,
            signing: None,
            sign_error: None,
            added: None,
            runs: 0,
            by_address: false,
            tx,
            rx,
        }
    }
}

impl State {
    /// Show the welcome steps from the first: the logins, read fresh.
    pub fn welcome(&mut self) {
        self.kys = kys::recent();
        let w = &mut self.welcome;
        w.profile = None;
        w.holds = Load::Idle;
        w.access = None;
        w.signing = None;
        w.sign_error = None;
        w.last_profile = kys::profile();
        self.load_profiles();
    }

    pub fn load_profiles(&mut self) {
        self.welcome.profiles = Load::Loading;
        let (tx, wake) = (self.welcome.tx.clone(), self.wake.clone());
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Profiles(cloud::profiles()));
            wake();
        });
    }

    /// Step 2: the kys on `name`'s accounts.
    pub fn pick_profile(&mut self, name: &str) {
        let Load::Ready(all) = &self.welcome.profiles else { return };
        let Some(profile) = all.iter().find(|p| p.name == name).cloned() else { return };
        kys::use_profile(name);
        self.welcome.last_profile = Some(name.to_string());
        self.welcome.profile = Some(name.to_string());
        self.welcome.holds = Load::Loading;
        let (tx, wake) = (self.welcome.tx.clone(), self.wake.clone());
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Holds(profile.name.clone(), cloud::kys(&profile)));
            wake();
        });
    }

    pub fn back_to_logins(&mut self) {
        self.welcome.profile = None;
        self.welcome.holds = Load::Idle;
    }

    /// A new login (or a signed-out one again): Cloudflare's page in the browser, through `cf`.
    pub fn add_profile(&mut self, name: &str) {
        let name = name.trim().to_string();
        if !cloud::valid_name(&name) {
            self.welcome.create_error = Some("Name it with letters, digits, - or _ (like work).".into());
            return;
        }
        match cloud::create(&name) {
            Ok(child) => {
                self.welcome.creating = Some((name.clone(), child.id()));
                self.welcome.create_error = None;
                let (tx, wake) = (self.welcome.tx.clone(), self.wake.clone());
                std::thread::spawn(move || {
                    let _ = tx.send(Msg::Created(name, cloud::finished(child)));
                    wake();
                });
            }
            Err(why) => self.welcome.create_error = Some(why),
        }
    }

    pub fn cancel_profile(&mut self) {
        if let Some((_, pid)) = self.welcome.creating.take() {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
        self.welcome.naming = false;
    }

    /// Step 3, or straight in when the Keychain holds a good sign-in for it.
    pub fn choose(&mut self, ky: Ky) {
        if ky.url.starts_with("http://") || signin::saved(&ky.url).is_some() {
            self.open(ky);
        } else {
            self.welcome.access = Some(ky);
            self.welcome.sign_error = None;
        }
    }

    /// The address typed on the welcome screen.
    pub fn open_typed(&mut self) {
        match kys::parse(&self.address.text) {
            Some(ky) => {
                self.address.clear();
                self.address_error = None;
                self.choose(ky);
            }
            None => self.address_error = Some("That isn't an address. It looks like ky.you.workers.dev.".into()),
        }
    }

    /// The browser sign-in on `ky`'s Access page. The window's sockets find the new token themselves.
    pub fn sign_in(&mut self, ky: Ky) {
        self.welcome.runs += 1;
        let run = self.welcome.runs;
        self.welcome.signing = Some((run, ky.url.clone()));
        self.welcome.sign_error = None;
        let (tx, wake) = (self.welcome.tx.clone(), self.wake.clone());
        std::thread::spawn(move || {
            let done = signin::browser(&ky.url).map(|_| ());
            let _ = tx.send(Msg::Signed(run, ky, done));
            wake();
        });
    }

    /// The open ky's sign-in, again, from the window's "Signed out" bar.
    pub fn sign_in_again(&mut self) {
        if let Some(ky) = self.ky.clone() {
            self.sign_in(ky);
        }
    }

    pub fn cancel_sign_in(&mut self) {
        self.welcome.signing = None;
    }

    /// Whether a browser sign-in for `url` is running.
    pub fn signing_in(&self, url: &str) -> bool {
        self.welcome.signing.as_ref().is_some_and(|(_, u)| u == url)
    }

    /// Land what the welcome's threads found. True when something changed.
    pub fn welcome_poll(&mut self) -> bool {
        let mut changed = false;
        while let Ok(msg) = self.welcome.rx.try_recv() {
            changed = true;
            match msg {
                Msg::Profiles(found) => {
                    self.welcome.profiles = match found {
                        Ok(all) => Load::Ready(all),
                        Err(why) => Load::Failed(why),
                    };
                    // A login the user just added: on to its kys.
                    if let Some(name) = self.welcome.added.take() {
                        if matches!(&self.welcome.profiles, Load::Ready(all) if all.iter().any(|p| p.name == name && p.signed_in())) {
                            self.pick_profile(&name);
                        }
                    }
                }
                Msg::Holds(name, found) => {
                    if self.welcome.profile.as_deref() == Some(name.as_str()) {
                        self.welcome.holds = match found {
                            Ok(all) => Load::Ready(all),
                            Err(why) => Load::Failed(why),
                        };
                    }
                }
                Msg::Created(name, done) => {
                    // Cancelled: the kill ended it; nothing to say.
                    if self.welcome.creating.as_ref().is_none_or(|(n, _)| n != &name) {
                        continue;
                    }
                    self.welcome.creating = None;
                    match done {
                        Ok(()) => {
                            self.welcome.naming = false;
                            self.welcome.name.clear();
                            self.welcome.added = Some(name.clone());
                            self.welcome.last_profile = Some(name);
                            self.load_profiles();
                        }
                        Err(why) => self.welcome.create_error = Some(why),
                    }
                }
                Msg::Signed(run, ky, done) => {
                    if self.welcome.signing.as_ref().map(|(r, _)| *r) != Some(run) {
                        continue;
                    }
                    self.welcome.signing = None;
                    match done {
                        // In the window already, its sockets pick the sign-in up from the Keychain.
                        Ok(()) if self.ky.is_none() => {
                            self.welcome.access = None;
                            self.open(ky);
                        }
                        Ok(()) => {}
                        Err(why) => self.welcome.sign_error = Some(why),
                    }
                }
            }
        }
        changed
    }
}

/// The welcome screen: whichever step is next.
pub fn page(s: &State, k: &Kit, inset: f32, p: &Palette) -> El {
    let w = &s.welcome;
    let card = match (&w.access, &w.profile) {
        (Some(ky), _) => access(s, ky, k, p),
        (None, Some(name)) => kys_of(s, name, k, p),
        (None, None) => logins(s, k, p),
    };
    col()
        .w_full()
        .h_full()
        .fill(p.bg)
        .child(row().w_full().h(52.0).pl(12.0 + inset).window_drag())
        .child(
            col()
                .key("welcome-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: false })
                .child(row().w_full().justify_center().px(24.0).pt(48.0).pb(64.0).child(card)),
        )
}

fn card() -> El {
    col().key("welcome").w_full().max_w(460.0).gap(14.0)
}

fn title(words: &str, p: &Palette) -> El {
    text(words.to_string()).font(TextStyle::new(22.0, 600.0).lh(28.0)).color(p.ink)
}

fn say(words: &str, p: &Palette) -> El {
    text(words.to_string()).font(META).color(p.muted).wrap()
}

fn label(words: &str, p: &Palette) -> El {
    text(words.to_string()).font(META_STRONG).color(p.quiet).pt(8.0)
}

fn problem(words: &str, p: &Palette) -> El {
    text(words.to_string()).font(META).color(p.danger).wrap()
}

fn waiting(words: &str, k: &Kit, p: &Palette) -> El {
    row().gap(10.0).center_y().py(6.0).child(Spinner::new().size(14.0).build(k)).child(text(words.to_string()).font(META).color(p.muted))
}

fn back(key: &str, words: &str, p: &Palette) -> El {
    row()
        .key(key)
        .role("button")
        .label(words)
        .gap(4.0)
        .center_y()
        .child(text(format!("‹ {words}")).font(META_STRONG).color(p.muted))
}

/// A pressable row: what leads, its name and a line under it, and what trails.
fn choice(key: &str, lead: El, name: &str, sub: &str, trail: El, p: &Palette) -> El {
    row()
        .key(key)
        .role("button")
        .label(name)
        .w_full()
        .px(16.0)
        .py(12.0)
        .gap(12.0)
        .center_y()
        .radius(RADIUS)
        .fill(p.raised)
        .hover(p.hover)
        .child(lead)
        .child(
            col()
                .grow(1.0)
                .shrink()
                .child(text(name.to_string()).font(TITLE).color(p.ink).max_lines(1))
                .child(text(sub.to_string()).font(META).color(p.quiet).max_lines(1)),
        )
        .child(trail)
}

/// A login's round initial.
fn initial(email: &str, p: &Palette) -> El {
    let letter = email.chars().next().map_or("?".to_string(), |c| c.to_uppercase().to_string());
    el().size(28.0, 28.0).radius(14.0).fill(p.accent).center().child(text(letter).font(META_STRONG).color(p.accent_ink))
}

fn trail(words: &str, p: &Palette) -> El {
    text(words.to_string()).font(META_STRONG).color(p.muted)
}

/// Step 1.
fn logins(s: &State, k: &Kit, p: &Palette) -> El {
    let w = &s.welcome;
    let mut c = card()
        .child(title("Sign in to Cloudflare", p))
        .child(say("Pick the Cloudflare login your ky is on. These are the logins Cloudflare's cf CLI keeps on this Mac; each opens its own accounts.", p));
    match &w.profiles {
        Load::Idle | Load::Loading => c = c.child(waiting("Reading cf's logins…", k, p)),
        Load::Failed(why) if why == cloud::NO_CF => {
            c = c.child(
                col()
                    .w_full()
                    .gap(10.0)
                    .px(16.0).py(16.0)
                    .radius(RADIUS)
                    .fill(p.raised)
                    .child(text("ky signs in through Cloudflare's cf CLI, which isn't on this Mac. Install it in a terminal, then check again:").font(META).color(p.ink).wrap())
                    .child(text("npm install -g cf").font(BODY).color(p.ink).selectable(true).px(10.0).py(6.0).radius(6.0).fill(p.sunken))
                    .child(button_el("check-cf", "Check again", "", false, false, p).on_press(|s: &mut State| s.load_profiles())),
            );
        }
        Load::Failed(why) => {
            c = c.child(problem(why, p)).child(button_el("check-cf", "Check again", "", false, false, p).on_press(|s: &mut State| s.load_profiles()));
        }
        Load::Ready(all) => {
            let mut list = col().key("logins").w_full().gap(8.0);
            for profile in all {
                let name = profile.name.clone();
                let accounts = match profile.accounts.len() {
                    1 => profile.accounts[0].name.clone(),
                    n => format!("{n} accounts"),
                };
                let last = w.last_profile.as_deref() == Some(profile.name.as_str());
                list = list.child(if profile.signed_in() {
                    choice(
                        &format!("login:{name}"),
                        initial(&profile.email, p),
                        &profile.email,
                        &format!("cf profile {name} · {accounts}"),
                        trail(if last { "Last used  ›" } else { "›" }, p),
                        p,
                    )
                    .on_press(move |s: &mut State| s.pick_profile(&name))
                } else {
                    let busy = w.creating.as_ref().is_some_and(|(n, _)| n == &name);
                    choice(
                        &format!("login:{name}"),
                        initial(&name, p),
                        &name,
                        "Signed out",
                        if busy { Spinner::new().size(14.0).build(k) } else { trail("Sign in", p) },
                        p,
                    )
                    .on_press(move |s: &mut State| s.add_profile(&name))
                });
            }
            if all.is_empty() {
                list = list.child(say("cf has no logins on this Mac yet.", p));
            }
            c = c.child(list).child(adding(s, k, p));
        }
    }
    if let Some(why) = &w.create_error {
        c = c.child(problem(why, p));
    }
    if !s.kys.is_empty() {
        let mut recent = col().key("recent").w_full().gap(6.0).child(label("Recent", p));
        for ky in s.kys.iter().take(4) {
            let open = ky.clone();
            recent = recent.child(
                choice(&format!("ky:{}", ky.url), mark(p), &ky.name, &ky.url, trail("Open", p), p).on_press(move |s: &mut State| s.choose(open.clone())),
            );
        }
        c = c.child(recent);
    }
    c.child(by_address(s, p))
}

/// Adding a login: a link, then its name, then the wait while Cloudflare's page is open.
fn adding(s: &State, k: &Kit, p: &Palette) -> El {
    let w = &s.welcome;
    if let Some((name, _)) = &w.creating {
        return row()
            .w_full()
            .gap(10.0)
            .center_y()
            .child(waiting(&format!("Finish signing in to Cloudflare in your browser ({name})…"), k, p).grow(1.0).shrink())
            .child(button_el("cancel-login", "Cancel", "", false, false, p).on_press(|s: &mut State| s.cancel_profile()));
    }
    if !w.naming {
        return row()
            .key("add-login")
            .role("button")
            .label("Add a Cloudflare login")
            .w_full()
            .px(16.0)
            .py(12.0)
            .gap(12.0)
            .center_y()
            .radius(RADIUS)
            .border(1.0, p.line)
            .hover(p.hover)
            .child(text("+").font(TITLE).color(p.muted))
            .child(text("Add a Cloudflare login").font(META_STRONG).color(p.ink))
            .on_press(|s: &mut State| {
                s.welcome.naming = true;
                s.welcome.create_error = None;
            });
    }
    let field = text_input(&w.name, BODY)
        .key("login-name")
        .label("A name for this login")
        .placeholder("work", p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .py(10.0)
        .on_edit(|s: &mut State| &mut s.welcome.name)
        .on_submit(|s: &mut State, _| {
            let name = s.welcome.name.text.clone();
            s.add_profile(&name);
        });
    col()
        .w_full()
        .gap(8.0)
        .px(14.0).py(14.0)
        .radius(RADIUS)
        .border(1.0, p.line)
        .child(text("Name this login, then sign in on Cloudflare's page. You choose the email and account there.").font(META).color(p.muted).wrap())
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(row().grow(1.0).shrink().pl(12.0).radius(8.0).fill(p.surface).border(1.0, p.line_strong).child(field))
                .child(button_el("create-login", "Continue in browser", "primary", false, false, p).on_press(|s: &mut State| {
                    let name = s.welcome.name.text.clone();
                    s.add_profile(&name);
                }))
                .child(button_el("cancel-naming", "Cancel", "", false, false, p).on_press(|s: &mut State| s.cancel_profile())),
        )
}

/// Step 2.
fn kys_of(s: &State, name: &str, k: &Kit, p: &Palette) -> El {
    let w = &s.welcome;
    let email = match &w.profiles {
        Load::Ready(all) => all.iter().find(|p| p.name == name).map(|p| p.email.clone()).unwrap_or_default(),
        _ => String::new(),
    };
    let mut c = card()
        .child(back("back-logins", "Cloudflare logins", p).on_press(|s: &mut State| s.back_to_logins()))
        .child(title("Choose a ky", p))
        .child(say(&format!("{email} · cf profile {name}"), p));
    match &w.holds {
        Load::Idle | Load::Loading => c = c.child(waiting("Looking for kys on its accounts…", k, p)),
        Load::Failed(why) => {
            let again = name.to_string();
            c = c.child(problem(why, p)).child(button_el("retry-kys", "Try again", "", false, false, p).on_press(move |s: &mut State| s.pick_profile(&again)));
        }
        Load::Ready(holds) => {
            for (account, found) in holds {
                let mut group = col().key(&format!("account:{}", account.id)).w_full().gap(8.0).child(label(&account.name, p));
                match found {
                    Err(why) => group = group.child(problem(why, p)),
                    Ok(kys) if kys.is_empty() => group = group.child(say("No ky on this account yet. Run ky init in a terminal to make one.", p)),
                    Ok(kys) => {
                        for found in kys {
                            let ky = Ky { name: found.name.clone(), url: found.url.clone() };
                            let release = found.release.as_deref().map_or("›".to_string(), |r| format!("{r}  ›"));
                            group = group.child(
                                choice(&format!("ky:{}", found.url), mark(p), &found.name, &found.url, trail(&release, p), p)
                                    .on_press(move |s: &mut State| s.choose(ky.clone())),
                            );
                        }
                    }
                }
                c = c.child(group);
            }
            if holds.is_empty() {
                c = c.child(say("This login reaches no accounts.", p));
            }
        }
    }
    c
}

/// Step 3.
fn access(s: &State, ky: &Ky, k: &Kit, p: &Palette) -> El {
    let w = &s.welcome;
    let mut c = card()
        .child(back("back-kys", "Choose a ky", p).on_press(|s: &mut State| {
            s.welcome.access = None;
            s.welcome.signing = None;
        }))
        .child(row().gap(12.0).center_y().child(mark(p)).child(title(&format!("Sign in to {}", ky.name), p)))
        .child(say(
            &format!(
                "{} is behind Cloudflare Access. Your browser opens its sign-in page; once you're through, this Mac's Keychain keeps the sign-in and {} opens here.",
                ky.name, ky.name
            ),
            p,
        ))
        .child(text(ky.url.clone()).font(META).color(p.quiet).selectable(true));
    let go = ky.clone();
    c = c.child(if s.signing_in(&ky.url) {
        row()
            .w_full()
            .gap(10.0)
            .center_y()
            .child(waiting("Waiting for your browser…", k, p).grow(1.0).shrink())
            .child(button_el("cancel-signin", "Cancel", "", false, false, p).on_press(|s: &mut State| s.cancel_sign_in()))
    } else {
        row().child(button_el("continue-signin", "Continue in browser", "primary", false, false, p).on_press(move |s: &mut State| s.sign_in(go.clone())))
    });
    if let Some(why) = &w.sign_error {
        c = c.child(problem(why, p));
    }
    c
}

/// A typed address, for a ky on someone else's Cloudflare: a link until pressed.
fn by_address(s: &State, p: &Palette) -> El {
    if !s.welcome.by_address {
        return row()
            .key("by-address")
            .role("button")
            .label("Open a ky by its address")
            .pt(6.0)
            .child(text("Open a ky by its address").font(META_STRONG).color(p.muted))
            .on_press(|s: &mut State| s.welcome.by_address = true);
    }
    let address = text_input(&s.address, BODY)
        .key("address")
        .label("Your ky's address")
        .placeholder("ky.you.workers.dev", p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .py(10.0)
        .on_edit(|s: &mut State| &mut s.address)
        .on_submit(|s: &mut State, _| s.open_typed());
    let mut c = col()
        .w_full()
        .gap(8.0)
        .child(label("By address", p))
        .child(
            row()
                .key("address-field")
                .w_full()
                .pl(14.0)
                .pr(6.0)
                .gap(8.0)
                .center_y()
                .radius(RADIUS)
                .fill(p.surface)
                .border(1.0, p.line_strong)
                .child(address)
                .child(button_el("open-address", "Open", "primary", false, false, p).on_press(|s: &mut State| s.open_typed())),
        );
    if let Some(why) = &s.address_error {
        c = c.child(problem(why, p));
    }
    c
}

fn mark(p: &Palette) -> El {
    crate::shell::mark(p)
}
