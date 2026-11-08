//! The window's frame, as a Mac app lays it out and the web app draws it: the chat list in a
//! sidebar on the left (`src/ui/Sidebar.tsx`), the open chats as tabs along the top, the page under
//! them. Every chat ky has is in the sidebar; only the ones the user opens get a tab, and the tabs
//! drag to reorder and close.

use rune::{Cx, El, ScrollSpec, Tx, col, el, icon, row, text};
use rune_kit::Kit;
use rune_kit::shell::{TabItem, TabItemStatus, TabOrientation, TabReorder, TabStrip};

use crate::link::{MAIN, Status};
use crate::theme::{BAR, HEAD, META, META_STRONG, Palette, RADIUS, ROW, ROW_STRONG, SIDEBAR_WIDTH, SMALL, TITLE, icons};
use crate::wire::ChatRow;
use crate::{State, Tab, time};

/// The traffic lights' room when the sidebar is hidden and the tabs start at the window's edge.
const LIGHTS: f32 = 78.0;

/// The chat list: New chat, the main chat, side chats by day, the archived ones folded away, and
/// ky's name and Settings at the foot.
pub fn sidebar(s: &State, cx: &Cx<State>, p: &Palette) -> El {
    let now = time::now_ms();
    let head = row()
        .key("sidebar-head")
        .w_full()
        .h(BAR)
        .pl(cx.titlebar_inset().max(LIGHTS))
        .pr(8.0)
        .center_y()
        .window_drag()
        .child(el().grow(1.0))
        .child(icon_button("hide-sidebar", &icons::SIDEBAR, "Hide sidebar (⌃⌘S)", p).on_press(|s: &mut State| s.sidebar = false));

    let new_chat = row()
        .key("new-chat")
        .role("button")
        .label("New chat")
        .help("New side chat (⌘T)")
        .w_full()
        .h(34.0)
        .gap(8.0)
        .center()
        .radius(RADIUS)
        .border(1.0, p.line)
        .hover(p.hover)
        .child(icon(&icons::COMPOSE, 15.0).color(if s.creating() { p.quiet } else { p.ink }))
        .child(text("New chat").font(ROW_STRONG).color(if s.creating() { p.quiet } else { p.ink }))
        .on_press(|s: &mut State| s.new_chat());

    let search = row()
        .key("sidebar-search")
        .role("button")
        .label("Search chats and commands")
        .help("Search chats and commands (⌘K)")
        .w_full()
        .h(36.0)
        .pl(10.0)
        .pr(8.0)
        .gap(8.0)
        .center_y()
        .radius(RADIUS)
        .fill(p.surface)
        .border(1.0, p.line)
        .hover(p.hover)
        .child(icon(&icons::SEARCH, 15.0).color(p.quiet))
        .child(text("Search").font(ROW).color(p.quiet).grow(1.0))
        .child(crate::palette::keycap("⌘K", p))
        .on_press(|s: &mut State| s.open_palette());

    let main = chat_item(s, MAIN, "Main chat", None, false, p);


    let (archived, active): (Vec<&ChatRow>, Vec<&ChatRow>) = {
        let mut sorted: Vec<&ChatRow> = s.chats.iter().collect();
        sorted.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
        sorted.into_iter().partition(|c| c.archived_at.is_some())
    };

    let mut list = col().key("chat-list").w_full().gap(1.0);
    if active.is_empty() {
        list = list.child(
            text("Start one for a tangent. It remembers what the main chat does.")
                .font(META)
                .color(p.quiet)
                .wrap()
                .px(10.0)
                .py(8.0),
        );
    }
    let mut day = String::new();
    for chat in &active {
        let label = time::day(chat.updated_at, now);
        if label != day {
            list = list.child(text(label.clone()).key(&format!("day:{label}")).font(HEAD).color(p.quiet).px(10.0).pt(14.0).pb(4.0));
            day = label;
        }
        list = list.child(chat_item(s, &chat.session, &s.title_of(&chat.session), Some(ago(chat, now)), false, p));
    }
    if !archived.is_empty() {
        let fold = row()
            .key("archived-toggle")
            .role("button")
            .label(if s.show_archived { "Hide archived chats" } else { "Show archived chats" })
            .w_full()
            .h(30.0)
            .mt(14.0)
            .pl(10.0)
            .pr(8.0)
            .gap(6.0)
            .center_y()
            .radius(RADIUS)
            .hover(p.hover)
            .child(text("Archived").font(HEAD).color(p.quiet))
            .child(text(archived.len().to_string()).font(HEAD).color(p.quiet))
            .child(el().grow(1.0))
            .child(icon(if s.show_archived { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 14.0).color(p.quiet))
            .on_press(|s: &mut State| s.show_archived = !s.show_archived);
        list = list.child(fold);
        if s.show_archived {
            for chat in &archived {
                list = list.child(chat_item(s, &chat.session, &s.title_of(&chat.session), Some(ago(chat, now)), true, p));
            }
        }
    }
    let scroll = col().key("sidebar-scroll").w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(16.0).child(list);

    let ky = s.ky.as_ref();
    let foot = row()
        .key("sidebar-foot")
        .w_full()
        .h(44.0)
        .gap(4.0)
        .center_y()
        .child(
            row()
                .key("ky-name")
                .role("button")
                .label("Switch ky")
                .help(ky.map_or(String::new(), |k| format!("{} · switch ky", k.url)))
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .h(36.0)
                .px(8.0)
                .gap(8.0)
                .center_y()
                .radius(RADIUS)
                .hover(p.hover)
                .child({
                    let mood = if s.conns.first().is_some_and(|c| c.chat.running) { crate::bloub::Mood::Working } else { crate::bloub::Mood::Idle };
                    crate::bloub::of(s, crate::bloub::KY, "sidebar-ky", 22.0, mood, false, p)
                })
                .child(text(ky.map_or("ky", |k| k.name.as_str()).to_string()).font(TITLE).color(p.ink).max_lines(1))
                .child(status_dot(&s.main_status(), p))
                .on_press(|s: &mut State| s.switch()),
        )
        .child(icon_button("open-settings", &icons::GEAR, "Settings (⌘,)", p).on_press(|s: &mut State| s.open_settings()));

    col()
        .key("sidebar")
        .w(SIDEBAR_WIDTH)
        .h_full()
        .fill(p.sidebar)
        .border_sides([0.0, 1.0, 0.0, 0.0], p.line)
        .child(head)
        .child(col().w_full().grow(1.0).shrink().min_h(0.0).px(10.0).gap(2.0).child(search.mb(4.0)).child(new_chat.mb(4.0)).child(main).child(rule(p)).child(scroll))
        .child(col().w_full().px(10.0).pb(6.0).child(rule(p)).child(foot))
}

/// One chat in the list: its title and age, and on hover the button that archives it (or brings
/// it back). The one the active tab shows is selected.
fn chat_item(s: &State, session: &str, title: &str, age: Option<String>, archived: bool, p: &Palette) -> El {
    let selected = s.is_open(session);
    let untitled = title == "New chat";
    let tabbed = s.tabs.contains(&Tab::Chat(session.to_string()));
    let open = session.to_string();
    let mut item = row()
        .key(&format!("row:{session}"))
        .role("button")
        .label(&format!("Open {title}"))
        .w_full()
        .h(36.0)
        .pl(10.0)
        .pr(6.0)
        .gap(8.0)
        .center_y()
        .radius(RADIUS)
        .hover_group()
        .hover(p.hover)
        .child(
            text(title.to_string())
                .font(ROW)
                .color(if selected { p.ink } else if untitled || archived { p.quiet } else { p.muted })
                .max_lines(1)
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        )
        // At once, as a Mac app switches what it shows: an animated commit would crossfade both chats'
        // pages, every element of each, and draw the window for most of a second.
        .on_press_tx(move |s: &mut State, tx| {
            s.open_chat(&open);
            tx.instant();
        });
    if selected {
        item = item.fill(p.selected);
    }
    // A dot for a chat open in a tab that isn't showing, as a browser marks a background tab.
    if tabbed && !selected {
        item = item.child(el().size(5.0, 5.0).radius(2.5).fill(p.quiet).help("Open in a tab"));
    }
    if session == MAIN {
        return item;
    }
    if let Some(age) = age {
        item = item.child(text(age).font(SMALL).color(p.quiet).group_opacity(1.0, 0.0));
    }
    let target = session.to_string();
    let (glyph, label) = if archived { (&icons::UNARCHIVE, "Unarchive") } else { (&icons::ARCHIVE, "Archive") };
    let action = icon_button(&format!("archive:{session}"), glyph, label, p)
        .size(26.0, 26.0)
        .group_opacity(0.0, 1.0)
        .on_press(move |s: &mut State| s.archive(&target, !archived));
    let target = session.to_string();
    let rename = icon_button(&format!("rename:{session}"), &icons::PENCIL, "Rename", p)
        .size(26.0, 26.0)
        .group_opacity(0.0, 1.0)
        .on_press(move |s: &mut State| s.start_rename(&target));
    item.child(row().ml(-58.0).child(rename).child(action))
}

fn ago(chat: &ChatRow, now: f64) -> String {
    time::ago(chat.updated_at, now)
}

/// The tab strip across the top, the window's drag band. Each tab is a chat the user opened (or
/// Settings); dragging one moves it, and closing it leaves the chat in the sidebar.
pub fn tab_bar(s: &State, cx: &Cx<State>, k: &Kit, p: &Palette, layer: &mut Vec<El>) -> El {
    let items: Vec<TabItem<'_, State>> = s
        .tabs
        .iter()
        .map(|tab| match tab {
            Tab::Chat(session) => {
                let running = s.conns.iter().any(|c| &c.session == session && c.chat.running);
                let down = s.conns.iter().any(|c| &c.session == session && c.live() && matches!(c.status, Status::Down(_) | Status::SignedOut(_)));
                let status = if running {
                    Some(TabItemStatus::Busy)
                } else if down {
                    Some(TabItemStatus::Failed)
                } else {
                    None
                };
                TabItem::new(tab_id(tab), s.title_of(session)).icon(&icons::CHAT).status(status)
            }
            Tab::Settings => TabItem::new(tab_id(tab), "Settings").icon(&icons::GEAR),
            Tab::Activity => TabItem::new(tab_id(tab), "Activity").icon(&icons::PULSE),
        })
        .collect();
    let active = s.current().map(tab_id);
    let plus = icon_button("new-tab", &icons::PLUS, "New chat (⌘T)", p).on_press(|s: &mut State| s.new_chat());
    let strip = TabStrip::new("tabs", TabOrientation::Horizontal)
        .tabs(items)
        .active(active.as_deref())
        .viewport_width(cx.layout_size("tabs").map(|z| z[0]))
        .drag_state(&s.drag, |s: &mut State| &mut s.drag)
        .fill(p.bg)
        .close_icon(&icons::CLOSE)
        .trailing_action(plus)
        .label("Open chats")
        .on_select(|s: &mut State, id: &str, tx: &mut Tx| {
            if let Some(i) = s.tabs.iter().position(|t| tab_id(t) == id) {
                s.select(i);
                // At once (see `chat_item`).
                tx.instant();
            }
        })
        .on_close(|s: &mut State, id: &str, _: &mut Tx| {
            if let Some(i) = s.tabs.iter().position(|t| tab_id(t) == id) {
                s.close_tab(i);
            }
        })
        .on_reorder(|s: &mut State, r: TabReorder, _: &mut Tx| s.move_tab(r.from, r.to))
        .build_layered(k, layer);
    let mut bar = row().key("tab-bar").w_full().h(BAR).pr(12.0).gap(6.0).center_y().fill(p.bg).border_sides([0.0, 0.0, 1.0, 0.0], p.line).window_drag();
    bar = if s.sidebar {
        bar.pl(8.0)
    } else {
        bar.pl(cx.titlebar_inset().max(LIGHTS))
            .child(icon_button("show-sidebar", &icons::SIDEBAR, "Show sidebar (⌃⌘S)", p).on_press(|s: &mut State| s.sidebar = true))
    };
    bar.child(strip)
}

pub fn tab_id(tab: &Tab) -> String {
    match tab {
        Tab::Chat(session) => format!("chat:{session}"),
        Tab::Settings => "settings".into(),
        Tab::Activity => "activity".into(),
    }
}

/// No tab open: what the window does next.
pub fn nothing_open(p: &Palette) -> El {
    col()
        .key("nothing-open")
        .w_full()
        .grow(1.0)
        .center()
        .gap(6.0)
        .child(text("No chat open").font(TITLE).color(p.muted))
        .child(text("Pick one in the sidebar, or start one with ⌘T.").font(META).color(p.quiet))
}

pub fn icon_button(key: &str, glyph: &'static rune::Icon, label: &str, p: &Palette) -> El {
    el().key(key)
        .role("button")
        .label(label)
        .help(label)
        .size(30.0, 30.0)
        .radius(8.0)
        .center()
        .hover(p.hover)
        .child(icon(glyph, 16.0).color(p.quiet))
}

fn rule(p: &Palette) -> El {
    el().w_full().h(1.0).my(8.0).fill(p.line)
}

/// The main chat's link: nothing while open, amber while connecting, red while down.
fn status_dot(status: &Status, p: &Palette) -> El {
    let (color, why) = match status {
        Status::Open { version } => (p.success, format!("Connected · {version}")),
        Status::Connecting => (p.quiet, "Connecting…".to_string()),
        Status::Down(why) => (p.danger, format!("Offline · {why}")),
        Status::SignedOut(why) => (p.danger, format!("Signed out · {why}")),
    };
    el().size(6.0, 6.0).radius(3.0).fill(color).help(why)
}

/// ky's avatar at title size: a rounded ink square with one eye, as the web draws it small.
pub fn mark(p: &Palette) -> El {
    el().size(22.0, 22.0)
        .radius(6.0)
        .fill(p.user_bubble)
        .center()
        .child(el().size(4.0, 7.0).radius(2.0).fill(p.user_ink).ml(3.0).mb(2.0))
}

/// Activity's corner pill, pinned to the main pane's bottom right: what runs now and what failed
/// today. It opens Activity, and on Activity it takes you back where you were.
pub fn activity_pill(s: &State, p: &Palette) -> El {
    let now = crate::time::now_ms();
    let all = crate::activity::tasks(s);
    let live = all.iter().filter(|t| t.live()).count();
    let failed = all.iter().filter(|t| t.status() == "failed" && crate::activity::same_day(t.updated(), now)).count();
    let on = matches!(s.current(), Some(Tab::Activity));
    let mut words = Vec::new();
    if live > 0 {
        words.push(format!("{live} running"));
    }
    if failed > 0 {
        words.push(format!("{failed} failed"));
    }
    let label = if on { "Back".to_string() } else if words.is_empty() { "Activity".to_string() } else { words.join(", ") };
    let mut pill = row()
        .key("activity-pill")
        .role("button")
        .label(&label)
        .help(if on { "Back to where you were (⇧⌘A)" } else { "Activity (⇧⌘A)" })
        .h(30.0)
        .px(11.0)
        .gap(7.0)
        .center_y()
        .radius(15.0)
        .fill(if on { p.selected } else { p.raised })
        .border(1.0, p.line_strong)
        .shadow(4.0, 14.0, p.shadow)
        .hover(p.hover)
        .child(icon(&icons::PULSE, 14.0).color(if live > 0 { p.accent } else { p.muted }));
    if on {
        pill = pill.child(text("Back").font(META_STRONG).color(p.ink));
    } else {
        if live > 0 {
            pill = pill.child(text(live.to_string()).font(META_STRONG).color(p.accent));
        }
        if failed > 0 {
            pill = pill.child(crate::settings::dot(p.danger)).child(text(failed.to_string()).font(META_STRONG).color(p.danger));
        }
    }
    // Beside the composer when there's room for it; over it, on the transcript's edge, when not.
    let crowded = matches!(s.current(), Some(Tab::Chat(_))) && s.main_w > 0.0 && s.main_w < crate::theme::THREAD_WIDTH + 2.0 * 130.0;
    pill.pin(None, None, Some(16.0), Some(if crowded { 96.0 } else { 14.0 })).on_press(|s: &mut State| s.toggle_activity())
}
