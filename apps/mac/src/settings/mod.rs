//! Settings, as a tab: a macOS settings layout (pages down the left, the page on the right) holding
//! the web's Settings pages (`src/ui/Panel.tsx` and the files it draws from), in the web's cards,
//! words and order. General is the web's first page: what's down, and the rows that lead on.
//!
//! Frames bring most of it (`settings`, `subscriptions`, `tasks`, `executor`, `tools`, `setup`);
//! the rest is asked for when its page opens (`actions::load`).

pub(crate) mod actions;
mod connect;
mod home;
mod models;
mod people;
mod work;

pub use actions::Then;

use rune::{El, Icon, ScrollSpec, TextStyle, col, el, icon, row, text, text_input};

use crate::theme::{HEAD, META, META_STRONG, Palette, RADIUS, ROW, ROW_STRONG, icons};
use crate::{Section, State};

/// Settings' pages, for its sidebar and ⌘K: the page, its name, the words it answers to.
pub const PAGES: &[(Section, &str, &str)] = &[
    (Section::General, "General", "ky address account sign out switch status glance"),
    (Section::Models, "Models", "model main worker background fallback thinking"),
    (Section::Providers, "Providers", "provider api key vibeproxy anthropic openai"),
    (Section::Tools, "Tools", "tools catalog"),
    (Section::Executor, "Executor", "executor mcp apps approvals policy allow ask block"),
    (Section::Spend, "Spend", "spend cost money cap budget usd"),
    (Section::Machines, "Machines", "machines computer runner sandbox pair"),
    (Section::Subscriptions, "Subscriptions", "claude chatgpt github token"),
    (Section::Proactivity, "Proactivity", "proactivity looks schedule time zone notifications"),
    (Section::Appearance, "Appearance", "appearance theme dark light accent colour color"),
    (Section::Peers, "Peers", "peers invite pair"),
    (Section::Mail, "Mail", "mail email inbox"),
    (Section::Webhooks, "Webhooks", "webhooks inbound credentials browser logins cookies"),
    (Section::SelfEdits, "Self-edits", "self-edits repo github"),
];

/// The sidebar's groups, as the web's first page groups its cards.
const GROUPS: &[&[Section]] = &[
    &[Section::General],
    &[Section::Models, Section::Providers, Section::Tools, Section::Executor, Section::Spend],
    &[Section::Machines, Section::Subscriptions],
    &[Section::Proactivity, Section::Appearance],
    &[Section::Peers, Section::Mail, Section::Webhooks, Section::SelfEdits],
];

pub fn name(section: Section) -> &'static str {
    PAGES.iter().find(|(s, ..)| *s == section).map_or("Settings", |(_, n, _)| n)
}

fn glyph(section: Section) -> &'static Icon {
    match section {
        Section::General => &icons::GEAR,
        Section::Models => &icons::CHAT,
        Section::Providers => &icons::PLUG,
        Section::Tools => &icons::LIST,
        Section::Executor => &icons::BOLT,
        Section::Spend => &icons::WALLET,
        Section::Machines => &icons::MACHINE,
        Section::Subscriptions => &icons::GLOBE,
        Section::Proactivity => &icons::SPARKLE,
        Section::Appearance => &icons::SUN,
        Section::Peers => &icons::USER,
        Section::Mail => &icons::MAIL,
        Section::Webhooks => &icons::KEY,
        Section::SelfEdits => &icons::BRANCH,
    }
}

pub fn page(s: &State, p: &Palette) -> El {
    let mut nav = col().key("settings-nav").w(212.0).h_full().pt(16.0).px(10.0).gap(14.0).border_sides([0.0, 1.0, 0.0, 0.0], p.line).scroll(ScrollSpec { stick_bottom: false });
    for group in GROUPS {
        let mut items = col().w_full().gap(1.0);
        for &section in *group {
            let on = s.section == section;
            let label = name(section);
            let mut item = row()
                .key(&format!("section:{label}"))
                .role("button")
                .label(label)
                .w_full()
                .h(30.0)
                .px(10.0)
                .gap(9.0)
                .center_y()
                .radius(8.0)
                .hover(p.hover)
                .child(icon(glyph(section), 15.0).color(if on { p.ink } else { p.quiet }))
                .child(text(label).font(if on { ROW_STRONG } else { ROW }).color(if on { p.ink } else { p.muted }))
                .on_press(move |s: &mut State| s.open_section(section));
            if on {
                item = item.fill(p.selected);
            }
            items = items.child(item);
        }
        nav = nav.child(items);
    }
    let body = match (s.section, s.detail.as_deref()) {
        (Section::Models, Some(purpose)) => back(Section::Models, p).child(models::model(s, purpose, p)),
        (Section::Machines, Some(machine)) => back(Section::Machines, p).child(work::machine(s, machine, p)),
        (Section::General, _) => home::general(s, p),
        (Section::Models, None) => models::models(s, p),
        (Section::Providers, _) => models::providers(s, p),
        (Section::Tools, _) => connect::tools(s, p),
        (Section::Executor, _) => connect::executor(s, p),
        (Section::Spend, _) => work::spend(s, p),
        (Section::Machines, None) => work::machines(s, p),
        (Section::Subscriptions, _) => connect::subscriptions(s, p),
        (Section::Proactivity, _) => people::proactivity(s, p),
        (Section::Appearance, _) => home::appearance(s, p),
        (Section::Peers, _) => people::peers(s, p),
        (Section::Mail, _) => people::mail(s, p),
        (Section::Webhooks, _) => connect::webhooks(s, p),
        (Section::SelfEdits, _) => connect::self_edits(s, p),
    };
    let key = format!("settings-body:{:?}:{}", s.section, s.detail.as_deref().unwrap_or(""));
    let body = col().key(&key).w_full().grow(1.0).shrink().min_w(0.0).h_full().scroll(ScrollSpec { stick_bottom: false }).child(
        row().w_full().justify_center().px(32.0).pt(24.0).pb(48.0).child(col().w_full().max_w(600.0).gap(22.0).child(body)),
    );
    row().key("settings").w_full().grow(1.0).min_h(0.0).child(nav).child(body)
}

/// A page under a section: a back link to it, as the web's `page-back`.
fn back(to: Section, p: &Palette) -> El {
    let label = name(to);
    col().w_full().gap(14.0).child(
        row()
            .key("page-back")
            .role("button")
            .label(&format!("Back to {label}"))
            .gap(4.0)
            .center_y()
            .child(icon(&icons::CHEVRON_RIGHT, 13.0).color(p.muted).rotate(std::f32::consts::PI))
            .child(text(label).font(META_STRONG).color(p.muted))
            .on_press(move |s: &mut State| s.open_section(to)),
    )
}

// The web's settings parts.

pub(crate) const TITLE: TextStyle = TextStyle::new(20.0, 600.0).lh(26.0);

/// `PageHead`: the page's title and what it is for.
pub(crate) fn heading(title: &str, sub: &str, p: &Palette) -> El {
    let head = col().gap(4.0).child(text(title.to_string()).font(TITLE).color(p.ink));
    if sub.is_empty() { head } else { head.child(text(sub.to_string()).font(META).color(p.muted).wrap()) }
}

/// A section: its label over its card.
pub(crate) fn section(label: &str, body: El, p: &Palette) -> El {
    col().w_full().gap(8.0).child(text(label.to_string()).font(HEAD).color(p.quiet).px(4.0)).child(body)
}

pub(crate) fn card(p: &Palette) -> El {
    col().w_full().radius(RADIUS + 2.0).border(1.0, p.line).fill(p.surface).clip_rounded(RADIUS + 2.0)
}

/// A card of rows with a rule between each.
pub(crate) fn rows(items: Vec<El>, p: &Palette) -> El {
    let mut c = card(p);
    for (i, item) in items.into_iter().enumerate() {
        if i > 0 {
            c = c.child(divider(p));
        }
        c = c.child(item);
    }
    c
}

pub(crate) fn divider(p: &Palette) -> El {
    el().w_full().h(1.0).fill(p.line)
}

/// A row: its label (and a line under it), then whatever sits at its end.
pub(crate) fn line(label: &str, sub: Option<&str>, end: El, p: &Palette) -> El {
    let mut words = col().grow(1.0).shrink().min_w(0.0).gap(2.0).child(text(label.to_string()).font(ROW_STRONG).color(p.ink).wrap());
    if let Some(sub) = sub.filter(|s| !s.is_empty()) {
        words = words.child(text(sub.to_string()).font(META).color(p.quiet).wrap());
    }
    row().w_full().min_h(46.0).px(16.0).py(10.0).gap(12.0).center_y().child(words).child(end)
}

/// The quiet value at a row's end.
pub(crate) fn value(words: impl Into<String>, p: &Palette) -> El {
    text(words.into()).font(ROW).color(p.muted).max_lines(1)
}

/// `PageLink`: a row that opens a page, with what it's set to.
pub(crate) fn link(key: &str, label: &str, sub: Option<&str>, set: Option<String>, p: &Palette) -> El {
    let mut end = row().gap(8.0).center_y();
    if let Some(set) = set {
        end = end.child(value(set, p));
    }
    line(label, sub, end.child(icon(&icons::CHEVRON_RIGHT, 14.0).color(p.quiet)), p).key(key).role("button").label(label).hover(p.hover)
}

/// A state word with its dot (`.state[data-tone]`).
pub(crate) fn state(words: impl Into<String>, tone: rune::Color, p: &Palette) -> El {
    row().gap(6.0).center_y().child(dot(tone)).child(text(words.into()).font(ROW).color(p.muted).max_lines(1))
}

pub(crate) fn dot(tone: rune::Color) -> El {
    el().size(7.0, 7.0).radius(3.5).fill(tone)
}

/// The tones a dot takes: online, paused, waking, off, offline.
pub(crate) fn tone(word: &str, p: &Palette) -> rune::Color {
    match word {
        "online" => p.success,
        "paused" | "waking" => p.warning,
        "offline" | "failed" => p.danger,
        _ => p.quiet,
    }
}

/// A button, as the web's: `primary` filled ink, `danger` red words, otherwise outlined.
pub(crate) fn button(key: &str, label: &str, tone: &str, p: &Palette) -> El {
    let (fill, ink, edge) = match tone {
        "primary" => (p.ink, p.user_ink, p.ink),
        "danger" => (p.surface, p.danger, p.line_strong),
        "quiet" => (rune::Color { a: 0.0, ..p.surface }, p.muted, rune::Color { a: 0.0, ..p.surface }),
        _ => (p.surface, p.ink, p.line_strong),
    };
    row()
        .key(&format!("button:{key}"))
        .role("button")
        .label(label)
        .h(30.0)
        .px(13.0)
        .center()
        .radius(15.0)
        .fill(fill)
        .border(1.0, edge)
        .hover(p.hover)
        .child(text(label.to_string()).font(META_STRONG).color(ink))
}

/// A button that can't be pressed yet.
pub(crate) fn off(b: El) -> El {
    b.opacity(0.4).disabled(true)
}

/// `Segmented`: one of a few, the chosen one raised.
pub(crate) fn segmented(key: &str, options: &[(&'static str, &'static str)], current: &str, p: &Palette, pick: impl Fn(&mut State, &'static str) + Clone + 'static) -> El {
    let mut bar = row().key(&format!("seg:{key}")).padding(2.0).gap(2.0).radius(9.0).fill(p.sunken).border(1.0, p.line);
    for &(id, label) in options {
        let on = id == current;
        let pick = pick.clone();
        let mut b = row()
            .key(&format!("seg:{key}:{id}"))
            .role("button")
            .label(label)
            .h(26.0)
            .px(12.0)
            .center()
            .radius(7.0)
            .child(text(label).font(if on { META_STRONG } else { META }).color(if on { p.ink } else { p.muted }))
            .on_press(move |s: &mut State| pick(s, id));
        b = if on { b.fill(p.raised).shadow(1.0, 2.0, p.shadow) } else { b.hover(p.hover) };
        bar = bar.child(b);
    }
    bar
}

/// A text field bound to `s.fields[key]`, on the sunken ground the web's inputs use.
pub(crate) fn field(s: &State, key: &str, placeholder: &str, p: &Palette) -> El {
    let empty = rune::TextEdit::new("");
    let edit = s.fields.get(key).unwrap_or(&empty);
    let k = key.to_string();
    text_input(edit, ROW)
        .key(&format!("field:{key}"))
        .label(placeholder)
        .placeholder(placeholder, p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .px(12.0)
        .py(8.0)
        .radius(9.0)
        .fill(p.sunken)
        .border(1.0, p.line)
        .on_edit(move |s: &mut State| s.field(&k))
}

/// Why `key` was refused, in red, when it was.
pub(crate) fn problem(s: &State, key: &str, p: &Palette) -> Option<El> {
    s.problems.get(key).map(|why| text(why.clone()).font(META).color(p.danger).wrap().key(&format!("problem:{key}")))
}

/// `EmptyState`: a quiet line in a card.
pub(crate) fn empty(words: &str, p: &Palette) -> El {
    card(p).child(row().w_full().px(16.0).py(18.0).justify_center().child(text(words.to_string()).font(META).color(p.quiet).wrap()))
}

/// `card-note`: a quiet line under a card.
pub(crate) fn note(words: impl Into<String>, p: &Palette) -> El {
    text(words.into()).font(META).color(p.quiet).wrap().px(4.0)
}

/// Code to run or paste, with a Copy button (`CopyLine`).
pub(crate) fn copy_line(key: &str, words: &str, p: &Palette) -> El {
    let copied = words.to_string();
    row()
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(10.0)
        .center_y()
        .radius(9.0)
        .fill(p.sunken)
        .child(text(words.to_string()).font(rune::TextStyle::new(12.5, 400.0).lh(18.0).mono()).color(p.ink).selectable(true).wrap().grow(1.0).shrink().min_w(0.0))
        .child(button(&format!("copy:{key}"), "Copy", "", p).on_press(move |_: &mut State| actions::copy(&copied)))
}

/// A string at `path` in a JSON view.
pub(crate) fn str_at<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key).and_then(serde_json::Value::as_str).unwrap_or_default()
}

pub(crate) fn num_at(v: &serde_json::Value, key: &str) -> f64 {
    v.get(key).and_then(serde_json::Value::as_f64).unwrap_or_default()
}

pub(crate) fn list_at<'a>(v: &'a serde_json::Value, key: &str) -> &'a [serde_json::Value] {
    v.get(key).and_then(serde_json::Value::as_array).map_or(&[], Vec::as_slice)
}

pub(crate) fn plural(n: usize, one: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {one}s") }
}

/// The web's money: four places under a dollar, two above.
pub(crate) fn money(usd: f64) -> String {
    if usd > 0.0 && usd < 1.0 { format!("${usd:.4}") } else { format!("${usd:.2}") }
}

/// A clock time, `14:05`, from Unix milliseconds, in local time.
pub(crate) fn clock(ms: f64) -> String {
    let secs = (ms / 1000.0) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}
