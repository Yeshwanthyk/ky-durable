//! General, the web's first Settings page (`SettingsHome`): what's down at a glance, which ky this
//! window shows, and the cards of rows that lead to each page. And Appearance.

use rune::{El, col, el, row, text};

use super::{button, card, dot, heading, line, link, rows, section, segmented, state, str_at, tone, value, work};
use crate::link::Status;
use crate::theme::{ACCENTS, META, META_STRONG, Palette, ROW, ROW_STRONG};
use crate::{Appearance, Section, State, time};

/// One line of the Glance: the page it opens, its name, what it says, and its tone.
struct Glance {
    to: Section,
    detail: Option<String>,
    label: String,
    words: String,
    tone: &'static str,
}

/// Your computer and whether it's up, or how many machines are (`machineGlance`).
fn machine_glance(s: &State, now: f64) -> Glance {
    let machines = s.machines.as_array().map_or(&[][..], Vec::as_slice);
    let computers: Vec<_> = machines.iter().filter(|m| m.get("cloud").is_none_or(|c| c.is_null())).collect();
    let pool: Vec<_> = if computers.is_empty() { machines.iter().collect() } else { computers };
    let online: Vec<_> = pool.iter().filter(|m| m.get("online").and_then(|o| o.as_bool()) == Some(true)).collect();
    let named = if pool.len() == 1 { Some(pool[0]) } else if online.len() == 1 { Some(*online[0]) } else { None };
    if let Some(m) = named {
        let (tone, words) = work::status_word(m, now);
        let name = str_at(m, "name").to_string();
        return Glance { to: Section::Machines, detail: Some(name.clone()), label: name, words, tone };
    }
    if pool.is_empty() {
        return Glance { to: Section::Machines, detail: None, label: "Machines".into(), words: "None".into(), tone: "off" };
    }
    Glance {
        to: Section::Machines,
        detail: None,
        label: "Machines".into(),
        words: format!("{}/{}", online.len(), pool.len()),
        tone: if online.is_empty() { "offline" } else { "online" },
    }
}

fn main_glance(s: &State) -> Glance {
    let (detail, words) = if s.settings.providers.is_empty() {
        (None, "Loading…".to_string())
    } else {
        match s.settings.purposes.get("main") {
            Some(c) => (Some("main".to_string()), super::models::model_name(s, c, false)),
            None => (None, "Not set".to_string()),
        }
    };
    Glance { to: Section::Models, detail, label: "Main agent".into(), words, tone: "" }
}

fn missing(s: &State, id: &str) -> bool {
    super::list_at(&s.setup, "missing").iter().any(|m| str_at(m, "id") == id)
}

fn vibe_glance(s: &State) -> Glance {
    let (words, tone) = if s.settings.providers.is_empty() {
        ("Loading…", "off")
    } else {
        match s.settings.providers.iter().find(|p| p.id == "vibeproxy") {
            None => ("Not set up", "off"),
            Some(_) if missing(s, "vibeproxy") => ("Not set up", "off"),
            Some(p) if p.connected => ("Connected", "online"),
            Some(_) => ("Not connected", "offline"),
        }
    };
    Glance { to: Section::Providers, detail: None, label: "VibeProxy".into(), words: words.into(), tone }
}

fn open(to: Section, detail: Option<String>) -> impl Fn(&mut State) + 'static {
    move |s: &mut State| match &detail {
        Some(d) => s.open_detail(to, d),
        None => s.open_section(to),
    }
}

/// What matters first: a tile for each thing that's fine, side by side, and a row for each thing
/// that's down, with Fix.
fn glance(s: &State, p: &Palette) -> El {
    let lines = [machine_glance(s, time::now_ms()), main_glance(s), vibe_glance(s)];
    let mut out = col().key("glance").w_full().gap(10.0);
    let fine: Vec<&Glance> = lines.iter().filter(|l| l.tone != "offline" && (l.label != "VibeProxy" || l.tone == "online")).collect();
    if !fine.is_empty() {
        let mut tiles = row().w_full().radius(14.0).border(1.0, p.line).fill(p.surface).clip_rounded(14.0);
        for (i, l) in fine.iter().enumerate() {
            if i > 0 {
                tiles = tiles.child(el().w(1.0).h(58.0).fill(p.line));
            }
            let mut words = row().gap(6.0).center_y();
            if !l.tone.is_empty() {
                words = words.child(dot(tone(l.tone, p)));
            }
            tiles = tiles.child(
                col()
                    .key(&format!("glance:{}", l.label))
                    .role("button")
                    .label(&format!("{} {}", l.label, l.words))
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .px(16.0)
                    .py(12.0)
                    .gap(4.0)
                    .hover(p.hover)
                    .child(text(l.label.clone()).font(META).color(p.quiet).max_lines(1))
                    .child(words.child(text(l.words.clone()).font(ROW_STRONG).color(p.ink).max_lines(1)))
                    .on_press(open(l.to, l.detail.clone())),
            );
        }
        out = out.child(tiles);
    }
    for l in lines.iter().filter(|l| l.tone == "offline") {
        let (title, sub) = if l.label == "VibeProxy" {
            ("VibeProxy isn’t connected".to_string(), "Claude models are off until it is")
        } else if l.detail.is_none() {
            ("No machine is online".to_string(), "Work waits until one is back")
        } else {
            (format!("{} is offline", l.label), "Work on it waits until it’s back")
        };
        out = out.child(
            row()
                .key(&format!("glance-alert:{}", l.label))
                .role("button")
                .label(&title)
                .w_full()
                .px(16.0)
                .py(12.0)
                .gap(12.0)
                .center_y()
                .radius(14.0)
                .border(1.0, p.line)
                .fill(p.surface)
                .hover(p.hover)
                .child(dot(p.danger))
                .child(col().grow(1.0).shrink().min_w(0.0).gap(2.0).child(text(title).font(ROW_STRONG).color(p.ink)).child(text(sub).font(META).color(p.quiet)))
                .child(text("Fix").font(META_STRONG).color(p.ink))
                .on_press(open(l.to, l.detail.clone())),
        );
    }
    out
}

/// Which ky this window shows, and switching or signing out.
fn this_ky(s: &State, p: &Palette) -> El {
    let ky = s.ky.as_ref();
    let (words, t) = match s.main_status() {
        Status::Open { version } => (format!("Connected · {version}"), p.success),
        Status::Connecting => ("Connecting…".to_string(), p.quiet),
        Status::Down(why) => (format!("Offline · {why}"), p.danger),
        Status::SignedOut(why) => (format!("Signed out · {why}"), p.danger),
    };
    let card = rows(
        vec![
            line("Name", None, value(ky.map_or("—", |k| k.name.as_str()), p), p),
            line("Address", None, text(ky.map_or("—", |k| k.url.as_str()).to_string()).font(ROW).color(p.muted).selectable(true).max_lines(1), p),
            line("Connection", None, state(words, t, p), p),
        ],
        p,
    );
    let actions = row()
        .gap(8.0)
        .child(button("switch-ky", "Switch ky", "", p).on_press(|s: &mut State| s.switch()))
        .child(button("sign-out", "Sign out", "danger", p).on_press(|s: &mut State| s.sign_out()));
    section("This ky", col().w_full().gap(10.0).child(card).child(actions), p)
}

fn group_link(s: &State, to: Section, set: Option<String>, p: &Palette) -> El {
    let label = super::name(to);
    let _ = s;
    link(&format!("goes:{label}"), label, None, set, p).on_press(move |s: &mut State| s.open_section(to))
}

fn none_or(n: usize) -> String {
    if n == 0 { "None".into() } else { n.to_string() }
}

pub fn general(s: &State, p: &Palette) -> El {
    let machines = s.machines.as_array().map_or(&[][..], Vec::as_slice);
    let online = machines.iter().filter(|m| m.get("online").and_then(|o| o.as_bool()) == Some(true)).count();
    let providers = s.settings.providers.iter().filter(|pr| pr.connected && !missing(s, &pr.id)).count();
    let spend = s.views.get("spend").map(|v| super::money(v.get("today").map_or(0.0, |t| super::num_at(t, "costUsd"))));
    let proactive = s.views.get("proactivity").map(|v| if str_at(v, "level") == "on" { "On".to_string() } else { "Off".to_string() });
    let appearance = match s.appearance {
        Appearance::System => "System",
        Appearance::Light => "Light",
        Appearance::Dark => "Dark",
    };
    let repo = str_at(&s.setup, "repo");
    let groups = [
        vec![
            group_link(s, Section::Models, Some(s.settings.purposes.len().to_string()), p),
            group_link(s, Section::Providers, Some(none_or(providers)), p),
            group_link(s, Section::Tools, Some(s.tools.len().to_string()), p),
            group_link(s, Section::Spend, spend, p),
        ],
        vec![
            group_link(s, Section::Machines, Some(if machines.is_empty() { "None".into() } else { format!("{online}/{}", machines.len()) }), p),
            group_link(s, Section::Subscriptions, Some(none_or(s.subscriptions.iter().filter(|v| v.connected).count())), p),
        ],
        vec![group_link(s, Section::Proactivity, proactive, p), group_link(s, Section::Appearance, Some(appearance.into()), p)],
        vec![
            group_link(s, Section::Peers, None, p),
            group_link(s, Section::Mail, None, p),
            group_link(s, Section::Webhooks, None, p),
            group_link(s, Section::SelfEdits, Some(if repo.is_empty() { "Not set".into() } else { repo.to_string() }), p),
        ],
    ];
    let mut page = col().w_full().gap(22.0).child(heading("Settings", "", p)).child(glance(s, p)).child(this_ky(s, p));
    let mut cards = col().w_full().gap(14.0);
    for group in groups {
        cards = cards.child(rows(group, p));
    }
    page = page.child(cards);
    page
}

pub fn appearance(s: &State, p: &Palette) -> El {
    let current = match s.appearance {
        Appearance::System => "system",
        Appearance::Light => "light",
        Appearance::Dark => "dark",
    };
    let theme = segmented("theme", &[("system", "System"), ("light", "Light"), ("dark", "Dark")], current, p, |s, id| {
        s.set_appearance(match id {
            "light" => Appearance::Light,
            "dark" => Appearance::Dark,
            _ => Appearance::System,
        })
    });
    let dark = s.dark.get();
    let mut swatches = row().gap(10.0).center_y();
    for (i, (name, light_hex, dark_hex)) in ACCENTS.iter().enumerate() {
        let colour = if i == 0 { p.ink } else { rune::color::hex(if dark { dark_hex } else { light_hex }).unwrap_or(p.ink) };
        let on = s.accent == i;
        let mut ring = el()
            .key(&format!("accent:{name}"))
            .role("button")
            .label(*name)
            .size(30.0, 30.0)
            .radius(15.0)
            .center()
            .child(el().size(22.0, 22.0).radius(11.0).fill(colour))
            .on_press(move |s: &mut State| {
                s.accent = i;
                s.ui_rev += 1;
            });
        ring = if on { ring.border(2.0, p.ink) } else { ring.border(2.0, rune::Color { a: 0.0, ..p.ink }) };
        swatches = swatches.child(ring);
    }
    col()
        .w_full()
        .gap(22.0)
        .child(heading("Appearance", "How ky looks on this Mac.", p))
        .child(section("Theme", card(p).child(line("Theme", Some("System follows macOS"), theme, p)), p))
        .child(section(
            "Accent",
            card(p).child(line("Accent", Some(ACCENTS[s.accent].0), swatches, p)),
            p,
        ))
        .child(super::note("Your messages take the accent; cards, buttons and text stay ink.", p))
}
