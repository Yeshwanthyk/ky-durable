//! The window, drawn as the web app's thread draws (`src/ui/Thread.tsx`, `src/chat-kit/chat.css`):
//! a top bar with ky and what it's doing, the thread at the web's width, and the floating composer.
//! Colours, type and sizes come from `theme.rs`, which mirrors the web's tokens.
//!
//! Perf rules this file keeps (Rune's "Fast apps" and "Smooth scrolling"):
//! - The transcript is `virtual_rows`: a commit builds only the rows near the viewport.
//! - Each row is `memo`'d by (key, revision, dark): a streamed delta rebuilds the live row alone.
//! - `virtual_rows_version` is the chat's layout revision, so a commit doesn't ask every row for
//!   its key unless rows were added, removed or rekeyed.
//! - No hover handlers that set state; scrolling never commits.

use rune::{Cx, El, GrowthSpec, ScrollSpec, col, el, memo, row, text, text_input};
use rune_kit::MarkdownStyle;

use crate::chat::{Role, Row};
use crate::link::Status;
use crate::{Conn, State, Tab, settings, shell};
use crate::theme::{self, BODY, META, META_STRONG, Palette, RADIUS, THREAD_WIDTH, TITLE};

/// The thread's side gutter, inside the window.
const GUTTER: f32 = 24.0;
/// The thread's text column: the web's 704 less its 20 of padding each side.
const CONTENT: f32 = THREAD_WIDTH - 40.0;

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let dark = match s.appearance {
        crate::Appearance::System => cx.system_dark(),
        crate::Appearance::Light => false,
        crate::Appearance::Dark => true,
    };
    s.dark.set(dark);
    s.blobs.begin(cx.is_reduced_motion());
    let p = theme::accented(theme::palette(dark), s.accent, dark);
    let k = if dark { &s.kit_dark } else { &s.kit_light };
    if s.ky.is_none() {
        s.pages.show(None);
        return crate::welcome::page(s, k, cx.titlebar_inset(), &p);
    }
    let mut layer = Vec::new();
    let page = match s.current() {
        None => shell::nothing_open(&p),
        Some(Tab::Settings) => settings::page(s, &p),
        Some(Tab::Activity) => crate::activity::page(s, k, &p, &mut layer),
        Some(Tab::Chat(_)) => match s.conn() {
            Some(conn) => chat_page(s, conn, dark, &p),
            None => shell::nothing_open(&p),
        },
    };
    let main = col().key("main").grow(1.0).shrink().min_w(0.0).h_full().fill(p.bg).child(shell::tab_bar(s, cx, k, &p, &mut layer)).child(page).child(shell::activity_pill(s, &p)).on_layout(|s: &mut State, r| s.main_w = r[2]);
    let mut window = row().w_full().h_full().fill(p.bg);
    if s.sidebar {
        window = window.child(shell::sidebar(s, cx, &p));
    }
    crate::palette::view(s, &p, &mut layer);
    crate::palette::shortcuts(s, &p, &mut layer);
    crate::palette::rename(s, &p, &mut layer);
    crate::media::lightbox(s, &p, &mut layer);
    // Pages are native views over the window: they show only for the chat in view, under nothing.
    let chat_shown = match s.current() {
        Some(Tab::Chat(_)) if layer.is_empty() => s.conn().map(|c| c.session.as_str()),
        _ => None,
    };
    s.pages.show(chat_shown);
    rune_kit::root(window.child(main), layer)
}

/// A chat: its transcript at the web's width, and the composer floating under it. Keys carry the
/// session, so each tab keeps its own scroll.
fn chat_page(s: &State, conn: &Conn, dark: bool, p: &Palette) -> El {
    let session = conn.session.clone();
    let rows = col()
        .key(&format!("rows:{session}"))
        .w_full()
        .pt(12.0)
        .pb(44.0)
        .growth(GrowthSpec::default())
        .virtual_rows(
            conn.chat.rows.len(),
            96.0,
            {
                let session = session.clone();
                move |s: &State, i| s.conns.iter().find(|c| c.session == session).map_or_else(|| i.to_string().into(), |c| c.chat.rows[i].key.as_str().into())
            },
            {
                let session = session.clone();
                let p = *p;
                move |s: &State, i| {
                    let Some(conn) = s.conns.iter().find(|c| c.session == session) else { return el() };
                    let r = &conn.chat.rows[i];
                    let markdown = if dark { &s.markdown_dark } else { &s.markdown_light };
                    // A card takes taps only in the chat's last turn, while ky isn't working.
                    let open = i + 1 == conn.chat.rows.len() && !conn.chat.running;
                    // A turn with a bloub on it redraws each frame the bloub moves.
                    let moving = if r.live || crate::transcript::has_bloubs(r) { s.blobs.frame } else { 0 };
                    memo(&format!("{session}:{}", r.key), (r.rev, dark, s.ui_rev, open, s.cards_rev(r), moving, s.remote.arrived(), s.pages.rev()), || turn(r, &session, open, s, markdown, &p))
                }
            },
        )
        .virtual_rows_version(conn.chat.layout_rev);
    let mut page = col().key(&format!("chat-page:{session}")).w_full().grow(1.0).min_h(0.0);
    match (conn.live(), &conn.status) {
        (true, Status::Down(why)) => {
            page = page.child(
                row()
                    .w_full()
                    .justify_center()
                    .py(6.0)
                    .fill(p.sunken)
                    .child(text(format!("Offline · {why}")).font(META).color(p.danger).max_lines(1)),
            );
        }
        (_, Status::SignedOut(why)) => page = page.child(signed_out(s, why, p)),
        _ => {}
    }
    if conn.chat.rows.is_empty() {
        page = page.child(
            col()
                .w_full()
                .grow(1.0)
                .center()
                .gap(6.0)
                .child(text(s.title_of(&session)).font(TITLE).color(p.muted))
                .child(text(if session == crate::link::MAIN { "Say something to ky." } else { "A side chat. It remembers what the main chat does." }).font(META).color(p.quiet)),
        );
    } else {
        let viewport = session.clone();
        page = page.child(
            col()
                .key(&crate::pages::Pages::transcript_key(&session))
                .w_full()
                .grow(1.0)
                .shrink()
                .scroll(ScrollSpec { stick_bottom: true })
                .scroll_edge_fade(24.0)
                // Not `live_only` (see `cards::page`): it would keep the window drawing at rest.
                .on_drawn_layout(move |s: &mut State, _| s.pages.viewport(&viewport, &s.wake))
                .child(earlier(conn, p))
                .child(rows)
                .child(replying(s, conn, p)),
        );
    }
    let waiting: Vec<_> = s.approvals.iter().filter(|a| a.chat == session || (a.chat.is_empty() && session == crate::link::MAIN)).collect();
    if !waiting.is_empty() {
        let mut dock = col().key(&format!("approvals:{session}")).w_full().max_w(THREAD_WIDTH).gap(10.0).max_h(420.0).scroll(ScrollSpec { stick_bottom: false });
        for a in waiting {
            dock = dock.child(crate::cards::approval(a, p));
        }
        page = page.child(row().w_full().justify_center().px(GUTTER).pt(8.0).child(dock));
    }
    page.child(composer(s, conn, p)).on_drop_files(|s: &mut State, paths: &[std::path::PathBuf], _| s.attach_paths(paths))
}

/// The specialists the newest message went to that haven't replied yet, under the thread.
fn replying(s: &State, conn: &Conn, p: &Palette) -> El {
    let mut out = col().key(&format!("replying:{}", conn.session)).w_full().items_center().px(GUTTER);
    let waiting = conn.chat.waiting();
    if !waiting.is_empty() {
        let mut list = col().w_full().max_w(CONTENT).gap(8.0).pb(44.0);
        for id in waiting {
            list = list.child(crate::transcript::replying(&id, &conn.session, s, p));
        }
        out = out.child(list);
    }
    out
}

/// "Earlier turns" over a chat whose start a compaction left out: it pages the chat before in, and
/// stays while there's more.
fn earlier(conn: &Conn, p: &Palette) -> El {
    if conn.chat.before.is_none() {
        return el();
    }
    let label = match conn.chat.paging {
        crate::chat::Paging::Loading => "Loading earlier turns…",
        crate::chat::Paging::Failed => "Couldn't load earlier turns. Click to try again",
        crate::chat::Paging::Idle => "Earlier turns",
    };
    let session = conn.session.clone();
    row().w_full().justify_center().px(GUTTER).pt(10.0).child(
        row()
            .key(&format!("earlier:{session}"))
            .role("button")
            .label(label)
            .h(30.0)
            .px(14.0)
            .gap(6.0)
            .center_y()
            .radius(15.0)
            .border(1.0, p.line)
            .hover(p.hover)
            .child(rune::icon(&crate::theme::icons::CHEVRON_UP, 12.0).color(p.muted))
            .child(text(label).font(META).color(p.muted))
            .on_press(move |s: &mut State| s.load_earlier(&session)),
    )
}

/// The bar over a chat whose ky wants its sign-in again: the one press that opens a browser.
fn signed_out(s: &State, why: &str, p: &Palette) -> El {
    let name = s.ky.as_ref().map_or("ky", |k| k.name.as_str());
    let url = s.ky.as_ref().map_or("", |k| k.url.as_str());
    let action = if s.signing_in(url) {
        row()
            .gap(8.0)
            .center_y()
            .child(text("Waiting for your browser…").font(META).color(p.muted))
            .child(crate::cards::button_el("cancel-signin", "Cancel", "", false, false, p).on_press(|s: &mut State| s.cancel_sign_in()))
    } else {
        crate::cards::button_el("signin-again", "Sign in", "primary", false, false, p).on_press(|s: &mut State| s.sign_in_again())
    };
    let mut bar = row()
        .key("signed-out")
        .w_full()
        .justify_center()
        .gap(12.0)
        .center_y()
        .px(GUTTER)
        .py(8.0)
        .fill(p.sunken)
        .child(text(format!("Signed out of {name} · {why}")).font(META).color(p.ink).max_lines(1).shrink())
        .child(action);
    if let Some(problem) = &s.welcome.sign_error {
        bar = bar.child(text(problem.clone()).font(META).color(p.danger).max_lines(1).shrink());
    }
    bar
}

/// One turn, at the thread's width. Built only when its revision (or what the user opened) changes.
fn turn(r: &Row, session: &str, open: bool, s: &State, markdown: &MarkdownStyle, p: &Palette) -> El {
    let body = match (r.role, &r.from) {
        (Role::User, Some(from)) => report(&from.kind, &from.name, &r.text, s, markdown, p),
        (Role::User, None) => {
            let mut mine = col().w_full().gap(6.0);
            if !r.images.is_empty() {
                mine = mine.child(crate::media::sent(s, &r.key, &r.images, p));
            }
            if !r.text.trim().is_empty() {
                mine = mine.child(
                    row().w_full().justify_end().child(
                        col()
                            .max_w(576.0f32.min(CONTENT * 0.85))
                            .px(15.0)
                            .py(9.0)
                            .radius(20.0)
                            .fill(p.accent)
                            .child(text(r.text.clone()).font(BODY).color(p.accent_ink).wrap().selectable(true)),
                    ),
                );
            }
            mine
        }
        (Role::Assistant, _) => crate::transcript::assistant(&crate::transcript::Turn { r, session, open }, s, markdown, p),
        (Role::Divider, _) => crate::transcript::divider(r, session, s, markdown, p),
        (Role::Specialist, _) => crate::transcript::specialist(r, session, s, markdown, p),
    };
    // The web's spacing: a message sits 12 above its reply, and turns 32 apart.
    let (above, below) = match (r.role, &r.from) {
        (Role::User, None) => (16.0, 6.0),
        (Role::Assistant, _) => (6.0, 16.0),
        (Role::Specialist, _) => (4.0, 12.0),
        _ => (16.0, 16.0),
    };
    row()
        .w_full()
        .justify_center()
        .px(GUTTER)
        .child(col().w_full().max_w(CONTENT).pt(above).pb(below).child(body))
        .streaming(r.live)
}

/// A row ky wrote as the user: "Report from machine webmac", or a routine's result in a card.
fn report(kind: &str, name: &str, body: &str, s: &State, markdown: &MarkdownStyle, p: &Palette) -> El {
    let (lead, card) = match kind {
        "automation" => ("Ran routine", true),
        "ky" => ("Posted by", false),
        _ => ("Report from", false),
    };
    let shown_name = if kind == "ky" || kind == "automation" { name.to_string() } else { format!("{kind} {name}") };
    let mut header = row().gap(6.0).center_y();
    // A specialist signs with its bloub, as a chat shows a member.
    if kind == "specialist" {
        header = header.child(crate::bloub::of(s, name, &format!("report:{name}"), 22.0, crate::bloub::Mood::Idle, true, p));
    }
    let header = header
        .child(text(lead).font(META).color(p.quiet))
        .child(text(shown_name).font(META_STRONG).color(p.muted));
    let content = crate::transcript::md(s, body.to_string()).selectable(true).render(markdown);
    let content = if card {
        col().max_w(THREAD_WIDTH * 0.6).px(14.0).py(10.0).radius(RADIUS).border(1.0, p.line_strong).fill(p.surface).child(content)
    } else {
        col().w_full().child(content)
    };
    col().w_full().gap(10.0).child(header).child(content)
}

/// The web's floating composer: a rounded field over the thread, Stop while ky works.
fn composer(s: &State, conn: &Conn, p: &Palette) -> El {
    let input = text_input(&conn.draft, BODY)
        .key("composer")
        .label("Message ky")
        .placeholder("Message ky", p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .py(14.0)
        .on_edit(|s: &mut State| s.draft_mut())
        .on_submit(|s: &mut State, tx| s.send(tx))
        // A pasted image (a screenshot copied, an image from a page) attaches; text pastes as text.
        .on_input_paste(|s: &mut State, content: &rune::ClipboardContent, _| match content.image() {
            Some(image) => {
                s.attach_bytes("Pasted image", image.png().to_vec());
                true
            }
            None => false,
        });
    let attach = el()
        .key("attach")
        .role("button")
        .label("Attach images")
        .size(34.0, 34.0)
        .radius(17.0)
        .hover(p.hover)
        .center()
        .child(rune::icon(&crate::theme::icons::PAPERCLIP, 16.0).color(p.muted))
        .on_press_tx(|s: &mut State, tx| s.pick_images(tx));
    let action = if conn.chat.running {
        Some(
            round_button("stop", "Stop", p)
                .child(el().size(10.0, 10.0).radius(2.0).fill(p.user_ink))
                .on_press(|s: &mut State| s.stop()),
        )
    } else if !conn.draft.text.trim().is_empty() || (!conn.images.is_empty() && conn.preparing == 0) {
        Some(round_button("send", "Send", p).child(text("↑").font(TITLE).color(p.user_ink)).on_press_tx(|s: &mut State, tx| s.send(tx)))
    } else {
        None
    };
    let mut field = row()
        .key("composer-field")
        .w_full()
        .max_w(THREAD_WIDTH)
        .min_h(52.0)
        .pl(8.0)
        .pr(8.0)
        .gap(6.0)
        .center_y()
        .child(attach)
        .child(input);
    if let Some(action) = action {
        field = field.child(action);
    }
    let mut boxed = col()
        .key("composer-box")
        .w_full()
        .max_w(THREAD_WIDTH)
        .radius(26.0)
        .fill(p.surface)
        .border(1.0, p.line_strong)
        .shadow(6.0, 20.0, p.shadow);
    if !conn.images.is_empty() || conn.preparing > 0 {
        boxed = boxed.child(crate::media::pending(s, &conn.images, conn.preparing, p));
    }
    boxed = boxed.child(field);
    let mut dock = col().key("composer-dock").w_full().items_center().px(GUTTER).pt(4.0).pb(16.0).gap(6.0);
    if let Some(tray) = crate::queue::tray(conn, p) {
        dock = dock.child(row().w_full().max_w(THREAD_WIDTH).child(tray));
    }
    if let Some(why) = &conn.image_error {
        dock = dock.child(row().w_full().max_w(THREAD_WIDTH).px(16.0).child(text(why.clone()).font(META).color(p.danger)));
    }
    dock.child(boxed)
}

fn round_button(key: &str, label: &str, p: &Palette) -> El {
    el().key(key).role("button").label(label).size(34.0, 34.0).radius(17.0).fill(p.user_bubble).center()
}

/// The welcome steps, as `step` shows them: the logins, adding one, a login's kys, a ky's sign-in,
/// and that sign-in waiting on the browser.
fn welcome_scene(s: &mut State, step: u8) {
    use crate::cloud::{Account, Found, Profile};
    use crate::kys::Ky;
    use crate::welcome::Load;
    s.ky = None;
    s.kys = vec![Ky { name: "squarey".into(), url: "https://squarey.someone.workers.dev".into() }];
    let personal = Account { id: "a1".into(), name: "Someone's Account".into() };
    let team = Account { id: "a2".into(), name: "Studio".into() };
    s.welcome.profiles = Load::Ready(vec![
        Profile::sample("default", "someone@example.com", &[("a1", "Someone's Account"), ("a2", "Studio")]),
        Profile::sample("work", "", &[]),
    ]);
    s.welcome.last_profile = Some("default".into());
    if step == 1 {
        s.welcome.naming = true;
        s.welcome.name = rune::TextEdit::new("side");
    }
    if step >= 2 {
        s.welcome.profile = Some("default".into());
        let ky = |name: &str, release: &str| Found { name: name.into(), url: format!("https://{name}.someone.workers.dev"), release: Some(release.into()) };
        s.welcome.holds = Load::Ready(vec![(personal, Ok(vec![ky("squarey", "670999e"), ky("oblongy", "a47ea54"), ky("ky-trial", "0f455b6")])), (team, Ok(vec![]))]);
    }
    if step >= 3 {
        s.welcome.access = Some(Ky { name: "oblongy".into(), url: "https://oblongy.someone.workers.dev".into() });
    }
    if step == 4 {
        s.welcome.signing = Some((1, "https://oblongy.someone.workers.dev".into()));
    }
}

/// Headless scenes, built from synthetic events and frames (no network):
/// `--scene long|streaming|empty|desktop|archived|settings|models`.
pub const SCENES: &[(&str, fn(&mut State))] = &[
    ("long", long),
    ("diagram", |s| crate::chat::fixtures::diagram_chat(main_chat(s))),
    ("images", images_scene),
    ("queue", |s| {
        streaming(s);
        let chat = &mut s.conns[0].chat;
        chat.queue("Also check the hotel's cancellation policy", Vec::new(), "q1");
        chat.queue("And book the Thursday dinner for six", Vec::new(), "q2");
        chat.outbox[0].submission = Some(41);
        chat.outbox[1].submission = Some(42);
        chat.inbox = vec![41, 42, 43];
    }),
    ("lightbox", |s| {
        images_scene(s);
        let row = s.conns[0].chat.rows.iter().find(|r| r.images.len() == 3).expect("three images");
        let images = row.images.clone();
        for i in &images {
            let _ = s.images.load(i.clone()).wait();
        }
        s.open_lightbox(images, 1);
    }),
    ("streaming", streaming),
    ("activity", activity_scene),
    ("activity-light", |s| {
        activity_scene(s);
        s.appearance = crate::Appearance::Light;
    }),
    ("activity-night", |s| {
        activity_scene(s);
        s.activity.view = crate::activity::View::Dreams;
    }),
    ("activity-sheet", |s| {
        activity_scene(s);
        s.activity.pick = Some(crate::activity::Pick::Task("t-deploy".into()));
        s.activity.steps.insert("t-deploy".into(), sample_steps());
    }),
    ("activity-sheet-done", |s| {
        activity_scene(s);
        s.activity.pick = Some(crate::activity::Pick::Task("t-flights".into()));
    }),
    ("activity-history", |s| {
        activity_scene(s);
        s.activity.view = crate::activity::View::History;
    }),
    ("activity-menu", |s| {
        activity_scene(s);
        s.activity.pick = Some(crate::activity::Pick::Task("t-flights".into()));
        s.activity.menu = Some(("t-flights".into(), rune::PointerPress { x: 700.0, y: 470.0 }));
    }),
    ("welcome", |s| welcome_scene(s, 0)),
    ("welcome-add", |s| welcome_scene(s, 1)),
    ("welcome-kys", |s| welcome_scene(s, 2)),
    ("welcome-access", |s| welcome_scene(s, 3)),
    ("welcome-waiting", |s| welcome_scene(s, 4)),
    ("chat-signed-out", |s| {
        streaming(s);
        s.conns[0].status = Status::SignedOut("ky turned the sign-in away".into());
    }),
    ("chat-pill", |s| {
        activity_scene(s);
        s.active = 0;
    }),
    ("chat-pill-narrow", |s| {
        activity_scene(s);
        s.active = 0;
        // What the main pane reports at 900 points wide, which a single snapped frame hasn't yet.
        s.main_w = 900.0 - crate::theme::SIDEBAR_WIDTH;
    }),
    ("routines", |s| {
        activity_scene(s);
        s.activity.view = crate::activity::View::Routines;
    }),
    ("routine-form", |s| {
        activity_scene(s);
        s.activity.view = crate::activity::View::Routines;
        s.open_routine(Some("a-brief"));
    }),
    ("routine-new", |s| {
        activity_scene(s);
        s.activity.view = crate::activity::View::Routines;
        s.open_routine(None);
        s.picks.insert("routine-chip", "hours".into());
    }),
    ("empty", |s| offline(s)),
    ("desktop", desktop),
    ("archived", archived),
    ("settings", settings_scene),
    ("models", models_scene),
    ("settings-models", |s| settings_at(s, crate::Section::Models, None)),
    ("settings-providers", |s| settings_at(s, crate::Section::Providers, None)),
    ("settings-tools", |s| settings_at(s, crate::Section::Tools, None)),
    ("settings-executor", |s| settings_at(s, crate::Section::Executor, None)),
    ("settings-spend", |s| settings_at(s, crate::Section::Spend, None)),
    ("settings-machines", |s| settings_at(s, crate::Section::Machines, None)),
    ("settings-machine", |s| settings_at(s, crate::Section::Machines, Some("studio"))),
    ("settings-subscriptions", |s| settings_at(s, crate::Section::Subscriptions, None)),
    ("settings-proactivity", |s| settings_at(s, crate::Section::Proactivity, None)),
    ("settings-appearance", |s| {
        settings_at(s, crate::Section::Appearance, None);
        s.accent = 1;
    }),
    ("settings-peers", |s| settings_at(s, crate::Section::Peers, None)),
    ("settings-mail", |s| settings_at(s, crate::Section::Mail, None)),
    ("settings-webhooks", |s| settings_at(s, crate::Section::Webhooks, None)),
    ("settings-self-edits", |s| settings_at(s, crate::Section::SelfEdits, None)),
    ("settings-light", |s| {
        settings_at(s, crate::Section::General, None);
        s.appearance = crate::Appearance::Light;
    }),
    ("work", work),
    ("work-light", |s| {
        work(s);
        s.appearance = crate::Appearance::Light;
    }),
    ("cards", cards_scene),
    ("palette", |s| {
        desktop(s);
        s.open_palette();
    }),
    ("palette-light", |s| {
        desktop(s);
        s.appearance = crate::Appearance::Light;
        s.open_palette();
    }),
    ("shortcuts", |s| {
        desktop(s);
        s.shortcuts = true;
    }),
    ("rename", |s| {
        desktop(s);
        let session = s.chats.iter().find(|c| c.archived_at.is_none()).map(|c| c.session.clone()).unwrap_or_default();
        s.start_rename(&session);
    }),
    ("no-sidebar", |s| {
        work(s);
        s.sidebar = false;
    }),
];

/// An offline window on a ky called "ky": the main chat open, nothing else. Scenes and
/// `KY_OFFLINE` setup both start here; running it twice changes nothing.
pub fn offline(s: &mut State) {
    if s.ky.is_none() {
        s.ky = Some(crate::kys::Ky { name: "squarey".into(), url: "https://squarey.example.workers.dev".into() });
    }
    if !s.conns.iter().any(|c| c.session == crate::link::MAIN) {
        s.conns.insert(0, Conn::offline(crate::link::MAIN));
    }
    if s.tabs.is_empty() {
        s.tabs = vec![Tab::Chat(crate::link::MAIN.into())];
        s.active = 0;
    }
}

fn main_chat(s: &mut State) -> &mut crate::chat::Chat {
    offline(s);
    &mut s.conns.iter_mut().find(|c| c.session == crate::link::MAIN).expect("the main chat").chat
}

/// A working turn, a card, a question waiting on a choice, and two approvals.
fn work(s: &mut State) {
    crate::chat::fixtures::work_chat(main_chat(s));
    // The first turn's log open, its failed run open under it, as a user would leave them.
    for key in ["log:1:e3", "tool:1:c4"] {
        s.open.insert(key.into());
    }
    let approval = |id: &str, kind: &str, subject: &str, summary: &str| crate::wire::Approval {
        id: id.into(),
        kind: kind.into(),
        subject: subject.into(),
        summary: summary.into(),
        chat: crate::link::MAIN.into(),
        created_at: 0.0,
        lapsed_at: None,
        link: (kind == "browser-handoff").then(|| "https://example.com/live".into()),
    };
    s.approvals = vec![
        approval("a1", "executor", "Gmail", "Send \"Offsite dinner, Thursday\" to 8 people from yesh@…"),
        approval("a2", "browser-handoff", "opentable.com", "Sign in to OpenTable so ky can book the table."),
    ];
}

fn cards_scene(s: &mut State) {
    crate::chat::fixtures::cards_chat(main_chat(s));
}

/// Sent images in the thread, and two waiting in the composer with one turned away.
fn images_scene(s: &mut State) {
    crate::chat::fixtures::image_chat(main_chat(s));
    let conn = &mut s.conns[0];
    for (id, (w, h, hue)) in [(640, 480, 0.4), (480, 640, 0.75)].into_iter().enumerate() {
        let bytes: std::sync::Arc<[u8]> = crate::chat::fixtures::picture(w, h, hue).into();
        conn.images.push(crate::media::Picked { id: id as u64 + 1, name: format!("IMG_00{}.png", id + 1), mime: "image/png".into(), data: crate::media::encode(&bytes), bytes });
    }
    conn.image_error = Some("notes.pdf isn't an image ky can read.".into());
    conn.draft = rune::TextEdit::new("And these two?");
    let all: Vec<_> = s.conns[0].chat.rows.iter().flat_map(|r| r.images.clone()).chain(s.conns[0].images.iter().map(|i| i.bytes.clone())).collect();
    for bytes in all {
        let _ = s.images.load(bytes).wait();
    }
}

fn long(s: &mut State) {
    crate::chat::fixtures::long_chat(main_chat(s), 400);
}

fn streaming(s: &mut State) {
    let chat = main_chat(s);
    crate::chat::fixtures::long_chat(chat, 40);
    crate::chat::fixtures::streaming_turn(chat);
}

/// A day of side chats, three of them open as tabs, one streaming.
fn desktop(s: &mut State) {
    use crate::wire::ChatRow;
    crate::chat::fixtures::long_chat(main_chat(s), 30);
    let now = crate::time::now_ms();
    let hour = 3_600_000.0;
    let chat = |session: &str, title: &str, ago: f64, archived: bool| ChatRow {
        session: session.into(),
        title: title.into(),
        updated_at: now - ago,
        archived_at: archived.then_some(now - ago / 2.0),
    };
    s.chats = vec![
        chat("s1", "Trip to Lisbon in March", 0.2 * hour, false),
        chat("s2", "Why the deploy hung on the image pin", 1.5 * hour, false),
        chat("s3", "Rune tab strip notes", 3.0 * hour, false),
        chat("s4", "Groceries for the week", 26.0 * hour, false),
        chat("s5", "Draft reply to the landlord", 30.0 * hour, false),
        chat("s6", "Reading list: distributed systems", 4.0 * 24.0 * hour, false),
        chat("s7", "Old: tax receipts", 20.0 * 24.0 * hour, true),
        chat("s8", "Old: bike repair", 40.0 * 24.0 * hour, true),
    ];
    for session in ["s2", "s3"] {
        s.open_chat(session);
    }
    s.select(1);
    let conn = s.conns.iter_mut().find(|c| c.session == "s2").expect("s2 open");
    crate::chat::fixtures::long_chat(&mut conn.chat, 12);
    crate::chat::fixtures::streaming_turn(&mut conn.chat);
    sample_settings(s);
}

/// Activity as a day leaves it: two tasks running, today's finished ones and routine runs, the
/// ones still to come, last night's dream and earlier days.
fn activity_scene(s: &mut State) {
    use serde_json::json;
    desktop(s);
    let now = crate::time::now_ms();
    let (min, hour, day) = (60_000.0, 3_600_000.0, 86_400_000.0);
    // Today's hours, kept inside today whatever the clock says.
    let midnight = now - {
        let w = crate::activity::wall(now);
        (w.hour as f64) * hour + (w.minute as f64) * min
    };
    let today = |h: f64| (midnight + h * hour).min(now - min);
    let task = |id: &str, title: &str, status: &str, worker: &str, kind: &str, start: f64, end: Option<f64>, steps: serde_json::Value| {
        json!({ "id": id, "title": title, "status": status, "worker": worker, "kind": kind, "source": "chat", "session": format!("sub-{id}"),
                "started_at": start, "finished_at": end, "updated_at": end.unwrap_or(now), "steps": steps,
                "turns": if end.is_some() { json!(6) } else { json!(null) }, "cost_usd": if end.is_some() { json!(0.0412) } else { json!(null) },
                "summary": if status == "done" { "Found **three** fares under £180. The 07:05 TAP flight on the 14th is cheapest and refundable.\n\n- TAP 07:05 · £142\n- easyJet 09:40 · £156\n- BA 13:15 · £179" } else if status == "failed" { "The test suite failed on `ky doctor`: the image pin was older than main." } else { "" } })
    };
    s.tasks = json!([
        task("t-deploy", "Check why the deploy hung on the image pin", "working", "studio", "machine", now - 6.0 * min, None,
             json!([{ "text": "Read `container/image.digest`", "at": now - 5.0 * min }, { "text": "Running `scripts/image/last.sh`", "at": now - 40_000.0 }])),
        task("t-reading", "Summarise the distributed systems reading list", "queued", "subagent", "cloud", now - min, None, json!([])),
        task("t-flights", "Find flights to Lisbon in March", "done", "subagent", "cloud", today(9.2), Some(today(9.4)), json!([{ "text": "Searched fares", "at": today(9.3) }])),
        task("t-landlord", "Draft the reply to the landlord", "done", "subagent", "cloud", today(9.3), Some(today(9.45)), json!([])),
        task("t-tests", "Run the web tests on studio", "failed", "studio", "machine", today(10.0), Some(today(10.2)), json!([])),
        task("t-receipts", "File last month's receipts", "done", "subagent", "cloud", now - day - 2.0 * hour, Some(now - day - 1.9 * hour), json!([])),
        task("t-bike", "Book the bike repair", "done", "subagent", "cloud", now - day - 3.0 * hour, Some(now - day - 2.8 * hour), json!([])),
        task("t-rust", "Read this week in Rust", "stopped", "subagent", "cloud", now - day - 4.0 * hour, Some(now - day - 3.9 * hour), json!([])),
        task("t-old", "Tidy the notes repo", "done", "mini", "machine", now - 3.0 * day, Some(now - 3.0 * day + hour), json!([])),
    ]);
    s.automations = json!([
        { "id": "a-brief", "title": "Morning brief", "prompt": "Read my calendar and mail and tell me what matters today.", "cron": "0 8 * * 1-5", "at": null,
          "status": "active", "next_run": now + day, "chat": "main", "machine": null, "model": null, "agent": null, "gate": null, "owner": "ky", "created_by": "user",
          "last_run": { "status": "done", "finished_at": today(8.05), "summary": "Two meetings, one bill due Friday." } },
        { "id": "a-prs", "title": "Review open PRs", "prompt": "Look at open PRs on yesh/ky and say which need me.", "cron": "30 */3 * * *", "at": null,
          "status": "active", "next_run": now + 2.0 * hour, "chat": "s2", "machine": "studio", "model": null, "agent": "claude", "gate": null, "owner": "ky", "created_by": "ky",
          "last_run": { "status": "working" } },
        { "id": "a-rent", "title": "Rent reminder", "prompt": "Remind me rent is due.", "cron": null, "at": now + 6.0 * day,
          "status": "active", "next_run": now + 6.0 * day, "chat": "main", "machine": null, "model": null, "agent": null, "gate": null, "owner": "ky", "created_by": "dream", "last_run": null },
        { "id": "a-gym", "title": "Gym check-in", "prompt": "Ask if I went.", "cron": "0 19 * * 1,3,5", "at": null,
          "status": "paused", "next_run": null, "chat": "main", "machine": null, "model": null, "agent": null, "gate": null, "owner": "ky", "created_by": "user", "last_run": null },
        { "id": "a-old", "title": "Weekly expenses", "prompt": "Sum the week's spend.", "cron": "0 18 * * 0", "at": null,
          "status": "archived", "next_run": null, "chat": "main", "machine": null, "model": null, "agent": null, "gate": null, "owner": "ky", "created_by": "user", "last_run": null },
    ]);
    // One to come later today, when there's still a later today.
    if crate::activity::wall(now).hour < 22 {
        if let Some(list) = s.automations.as_array_mut() {
            list.push(json!({ "id": "a-water", "title": "Water the plants", "prompt": "Remind me.", "cron": null, "at": now + 40.0 * min,
                "status": "active", "next_run": now + 40.0 * min, "chat": "main", "machine": null, "model": null, "agent": null, "gate": null, "owner": "ky", "created_by": "user", "last_run": null }));
        }
    }
    s.views.insert("dream-ledger", json!([
        { "id": 1, "at": now - 7.0 * hour, "kind": "memory", "action": "note", "target": "", "before": "Prefers window seats on short flights", "reason": null, "undone_at": null },
        { "id": 2, "at": now - 7.0 * hour, "kind": "skill", "action": "edit", "target": "deploy-check", "reason": "Pin the newest release's image before a hand deploy", "undone_at": null },
        { "id": 3, "at": now - 7.0 * hour, "kind": "skill", "action": "archive", "target": "old-image-pin", "absorbed_into": "deploy-check", "reason": "Same steps, now in one place", "undone_at": null },
        { "id": 4, "at": now - 7.0 * hour, "kind": "memory", "action": "forget", "target": "", "before": "Lives in Leeds", "reason": "Moved to London in October", "undone_at": now - hour },
    ]));
    s.open_activity();
}

fn sample_steps() -> Vec<serde_json::Value> {
    use serde_json::json;
    let now = crate::time::now_ms();
    vec![
        json!({ "seq": 1, "call": null, "at": now - 330_000.0, "ended_at": null, "state": "done", "text": "I'll start with the pin the deploy used.", "detail": null }),
        json!({ "seq": 2, "call": "c1", "at": now - 300_000.0, "ended_at": now - 290_000.0, "state": "done", "text": "Read `container/image.digest`", "detail": null }),
        json!({ "seq": 3, "call": "c2", "at": now - 280_000.0, "ended_at": now - 200_000.0, "state": "failed", "text": "Ran `pnpm ky doctor squarey`", "detail": null }),
        json!({ "seq": 4, "call": null, "at": now - 190_000.0, "ended_at": null, "state": "done", "text": "Doctor can't reach the Worker from here; checking the release instead.", "detail": null }),
        json!({ "seq": 5, "call": "c3", "at": now - 40_000.0, "ended_at": null, "state": "running", "text": "Running `scripts/image/last.sh`", "detail": null }),
    ]
}

fn archived(s: &mut State) {
    desktop(s);
    s.show_archived = true;
}

fn settings_scene(s: &mut State) {
    desktop(s);
    s.open_settings();
}

fn models_scene(s: &mut State) {
    desktop(s);
    s.open_settings();
    s.section = crate::Section::Models;
    s.detail = Some("main".into());
}

fn sample_settings(s: &mut State) {
    use crate::wire::{ModelChoice, ModelOption, Provider, Subscription};
    let model = |id: &str, name: &str, featured: bool| ModelOption {
        model_id: id.into(),
        name: name.into(),
        featured,
        levels: vec!["off".into(), "low".into(), "medium".into(), "high".into()],
        cost: Some(crate::wire::Cost { input: 3.0, output: 15.0 }),
    };
    s.settings.providers = vec![
        Provider {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            connected: true,
            needs: None,
            failure: None,
            kind: "api-key".into(),
            models: vec![model("claude-opus-5-5", "Claude Opus 5.5", true), model("claude-sonnet-5-5", "Claude Sonnet 5.5", true), model("claude-haiku-5-5", "Claude Haiku 5.5", false)],
        },
        Provider { id: "openai".into(), name: "OpenAI".into(), connected: false, needs: Some("an API key".into()), failure: None, kind: "api-key".into(), models: vec![] },
    ];
    let choice = |id: &str, level: &str| ModelChoice { provider: "anthropic".into(), model_id: id.into(), thinking_level: level.into() };
    s.settings.purposes = [
        ("main".to_string(), choice("claude-opus-5-5", "medium")),
        ("worker".to_string(), choice("claude-sonnet-5-5", "low")),
        ("background".to_string(), choice("claude-haiku-5-5", "off")),
        ("fallback".to_string(), choice("claude-sonnet-5-5", "off")),
    ]
    .into_iter()
    .collect();
    let now = crate::time::now_ms();
    s.subscriptions = vec![
        Subscription { kind: "claude".into(), connected: true, expires_at: Some(now + 40.0 * 86_400_000.0), error: None, repos: vec![] },
        Subscription { kind: "github".into(), connected: true, expires_at: None, error: None, repos: vec!["yesh/ky".into(), "yesh/notes".into()] },
    ];
    sample_views(s, now);
}

/// What Settings' pages show, as ky's frames and answers bring it.
fn sample_views(s: &mut State, now: f64) {
    use serde_json::json;
    let (min, hour, day) = (60_000.0, 3_600_000.0, 86_400_000.0);
    s.settings.vendors = vec![
        crate::wire::Vendor { id: "anthropic".into(), name: "Anthropic".into() },
        crate::wire::Vendor { id: "openai".into(), name: "OpenAI".into() },
        crate::wire::Vendor { id: "google".into(), name: "Google".into() },
        crate::wire::Vendor { id: "openrouter".into(), name: "OpenRouter".into() },
    ];
    s.machines = json!([
        { "name": "studio", "online": true, "state": "on", "active": 2, "login": "own", "note": "work laptop, has Chrome", "seenAt": now,
          "facts": { "os": "macOS 26.1", "chrome": true, "repos": ["yesh/ky", "yesh/notes"], "agents": { "claude": { "installed": true, "signedIn": true }, "codex": { "installed": true, "signedIn": false } } } },
        { "name": "mini", "online": false, "state": "on", "active": 1, "login": "ky", "note": "", "seenAt": now - 3.0 * hour },
        { "name": "cloud", "cloud": "asleep", "active": 0, "sandbox": "cloud" },
    ]);
    s.executor = json!({ "url": "https://mcp.executor.sh/mcp", "policies": [
        { "tool": "gmail.send", "policy": "ask" }, { "tool": "calendar.create_event", "policy": "allow" }, { "tool": "github.merge_pull_request", "policy": "block" },
    ] });
    s.setup = json!({ "repo": "yesh/ky", "url": "https://ky.example.workers.dev", "missing": [] });
    s.tools = [("read", "Read a file"), ("bash", "Run a command on a machine"), ("browse", "Drive a browser"), ("remember", "Keep something for later"), ("schedule", "Make a routine")]
        .iter()
        .map(|(n, d)| crate::wire::ToolInfo { name: n.to_string(), description: d.to_string() })
        .collect();
    let views = [
        ("spend", json!({ "capUsd": 5.0, "capped": false, "today": { "costUsd": 1.8423, "calls": 64 }, "month": { "costUsd": 38.12, "calls": 1802 },
            "lines": [ { "source": "chat", "costUsd": 1.21, "calls": 22 }, { "source": "subagent", "costUsd": 0.41, "calls": 9 }, { "source": "look", "costUsd": 0.12, "calls": 4 }, { "source": "call", "costUsd": 0.1023, "calls": 29 } ],
            "held": [] })),
        ("proactivity", json!({ "level": "on", "looks": ["08:30", "13:00", "18:30"], "rightAway": 3 })),
        ("zone", json!({ "on": true, "zone": "Europe/London", "pinned": false, "detected": "Europe/London" })),
        ("verdicts", json!({ "verdicts": [], "useful": 7, "judged": 9 })),
        ("peers", json!([
            { "name": "benky", "address": "https://benky.example.workers.dev", "state": "on" },
            { "name": "anaky", "address": "https://anaky.example.workers.dev", "state": "unreachable", "detail": "It answered 522." },
        ])),
        ("mail", json!({ "address": "ky@example.com", "allowed": ["ana@example.com"],
            "held": [ { "id": "m1", "direction": "out", "party": "landlord@example.com", "partyName": "Landlord", "subject": "Re: the boiler", "preview": "Thanks, Tuesday works.", "state": "held", "note": "", "at": now - 20.0 * min } ],
            "recent": [
                { "id": "m2", "direction": "in", "party": "news@example.com", "partyName": "Weekly digest", "subject": "This week in Rust", "preview": "Nothing to act on.", "state": "triaged", "note": "", "at": now - 2.0 * hour },
                { "id": "m3", "direction": "out", "party": "ana@example.com", "partyName": "Ana", "subject": "Lisbon dates", "preview": "", "state": "sent", "note": "", "at": now - day },
            ] })),
        ("hooks", json!({ "chats": [ { "session": "s2", "title": "Why the deploy hung on the image pin" }, { "session": "s3", "title": "Rune tab strip notes" } ],
            "hooks": [ { "id": "h1", "session": "s2", "label": "GitHub pushes", "signed": true, "createdAt": now - 9.0 * day, "lastAt": now - 40.0 * min },
                       { "id": "h2", "session": "s3", "label": "Uptime alerts", "signed": false, "createdAt": now - day, "lastAt": null } ] })),
        ("secrets", json!({ "owners": [], "secrets": [ { "name": "linear", "owner": "*", "scheme": "Bearer", "header": "Authorization", "updatedAt": now - 3.0 * day } ] })),
        ("logins", json!({ "owners": [], "logins": [ { "owner": "ky", "site": "github.com", "cookies": 14, "updatedAt": now - 2.0 * day } ] })),
    ];
    for (k, v) in views {
        s.views.insert(k, v);
    }
}

fn settings_at(s: &mut State, section: crate::Section, detail: Option<&str>) {
    desktop(s);
    s.open_settings();
    s.section = section;
    s.detail = detail.map(str::to_string);
}
