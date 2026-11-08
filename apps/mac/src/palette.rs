//! ⌘K, as the web's `CommandPalette.tsx` and `commands.ts` draw and fill it: a search field over
//! the chats, then ky's own pages and switches. Every word typed has to start a word of the label,
//! keywords or group. A command that has a key shows it at the right, so the palette doubles as
//! the list of shortcuts; ⌘/ shows them all at once.

use rune::{El, Key, KeyEvent, ScrollSpec, TextEdit, Tx, col, el, icon, row, text, text_input};

use crate::link::MAIN;
use crate::theme::{BODY, META, Palette, ROW, SMALL, TITLE, icons};
use crate::{Appearance, Section, State, time};

/// The palette while it's open: what's typed and which result is picked.
pub struct Finder {
    pub query: TextEdit,
    pub index: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    NewChat,
    Open(String),
    Settings(Option<Section>),
    Activity,
    Routines,
    Sidebar,
    Appearance(Appearance),
    Shortcuts,
    Archived,
    Rename(String),
    Archive(String),
}

#[derive(Clone, Debug)]
pub struct Command {
    pub id: String,
    pub group: &'static str,
    pub label: String,
    /// At the right: when a chat last moved, or a command's key.
    pub hint: String,
    pub keywords: &'static str,
    pub act: Act,
}

fn command(id: &str, group: &'static str, label: &str, hint: &str, keywords: &'static str, act: Act) -> Command {
    Command { id: id.into(), group, label: label.into(), hint: hint.into(), keywords, act }
}

/// The window's shortcuts, for ⌘/ and the palette's hints: keys, then what they do.
pub const SHORTCUTS: &[(&str, &str)] = &[
    ("⌘K", "Search chats and commands"),
    ("⌘T", "New side chat"),
    ("⌘N", "New side chat"),
    ("⌘W", "Close tab"),
    ("⌘1 … ⌘8", "Go to a tab"),
    ("⌘9", "Go to the last tab"),
    ("⇧⌘[  ⇧⌘]", "Tab before, tab after"),
    ("⌃⌘S", "Show or hide the sidebar"),
    ("⌘\\", "Show or hide the sidebar"),
    ("⇧⌘L", "Light or dark appearance"),
    ("⇧⌘A", "Activity"),
    ("⌘,", "Settings"),
    ("⌘/", "Keyboard shortcuts"),
    ("↩", "Send"),
    ("⇧↩", "New line"),
    ("esc", "Close the palette or a sheet"),
];

/// The chats first (new, main, every side chat newest first), then ky's pages and switches.
pub fn commands(s: &State) -> Vec<Command> {
    let now = time::now_ms();
    let open = s.current_session();
    let mut out = vec![
        command("new", "Chats", "New side chat", "⌘T", "create start", Act::NewChat),
        command("main", "Chats", "Main chat", if open.as_deref() == Some(MAIN) { "Open" } else { "" }, "", Act::Open(MAIN.into())),
    ];
    let mut chats: Vec<_> = s.chats.iter().filter(|c| c.archived_at.is_none()).collect();
    chats.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
    for c in chats {
        let hint = if open.as_deref() == Some(c.session.as_str()) { "Open".to_string() } else { time::ago(c.updated_at, now) };
        let label = if c.title.trim().is_empty() { "New chat" } else { c.title.as_str() };
        out.push(Command { id: format!("chat-{}", c.session), group: "Chats", label: label.into(), hint, keywords: "side", act: Act::Open(c.session.clone()) });
    }
    let archived = s.chats.iter().filter(|c| c.archived_at.is_some()).count();
    if archived > 0 {
        out.push(command("archived", "Chats", if s.show_archived { "Hide archived chats" } else { "Show archived chats" }, &archived.to_string(), "archive unarchive restore", Act::Archived));
    }
    if let Some(session) = open.as_deref().filter(|s| *s != MAIN) {
        out.push(command("rename", "Chats", "Rename this chat", "", "title name", Act::Rename(session.to_string())));
        out.push(command("archive", "Chats", "Archive this chat", "", "close hide remove", Act::Archive(session.to_string())));
    }
    out.push(command("activity", "ky", "Activity", "⇧⌘A", "tasks routines automations today running stop dream last night", Act::Activity));
    out.push(command("routines", "ky", "Routines", "", "automations schedule cron check-ins", Act::Routines));
    out.push(command("settings", "ky", "Settings", "⌘,", "models providers preferences", Act::Settings(None)));
    for (section, label, keywords) in crate::settings::PAGES {
        out.push(Command { id: format!("settings-{label}"), group: "Settings", label: format!("Settings › {label}"), hint: String::new(), keywords, act: Act::Settings(Some(*section)) });
    }
    out.push(command("sidebar", "ky", if s.sidebar { "Hide sidebar" } else { "Show sidebar" }, "⌃⌘S", "close open toggle collapse chats", Act::Sidebar));
    let dark = s.dark.get();
    out.push(command("theme", "ky", if dark { "Light appearance" } else { "Dark appearance" }, "⇧⌘L", "theme mode toggle", Act::Appearance(if dark { Appearance::Light } else { Appearance::Dark })));
    if s.appearance != Appearance::System {
        out.push(command("theme-system", "ky", "Match macOS appearance", "", "theme mode system auto", Act::Appearance(Appearance::System)));
    }
    out.push(command("shortcuts", "ky", "Keyboard shortcuts", "⌘/", "keys keymap help hotkeys", Act::Shortcuts));
    out
}

/// Every word typed starts a word of the label, keywords or group: "si c" finds "Side chat".
pub fn matches(c: &Command, query: &str) -> bool {
    let hay = format!("{} {} {}", c.label, c.keywords, c.group).to_lowercase();
    let words: Vec<&str> = hay.split(|ch: char| ch.is_whitespace() || "·:/-›".contains(ch)).filter(|w| !w.is_empty()).collect();
    query.to_lowercase().split_whitespace().all(|part| words.iter().any(|w| w.starts_with(part)))
}

pub fn shown(s: &State) -> Vec<Command> {
    let query = s.finder.as_ref().map(|f| f.query.text.clone()).unwrap_or_default();
    commands(s).into_iter().filter(|c| matches(c, &query)).collect()
}

impl State {
    pub fn open_palette(&mut self) {
        self.shortcuts = false;
        self.finder = match self.finder {
            Some(_) => None,
            None => Some(Finder { query: TextEdit::new(""), index: 0 }),
        };
    }

    pub fn run(&mut self, act: Act) {
        self.finder = None;
        match act {
            Act::NewChat => self.new_chat(),
            Act::Open(session) => self.open_chat(&session),
            Act::Settings(section) => {
                self.open_settings();
                if let Some(section) = section {
                    self.open_section(section);
                }
            }
            Act::Activity => self.open_activity(),
            Act::Routines => {
                self.open_activity();
                self.activity.view = crate::activity::View::Routines;
            }
            Act::Sidebar => self.sidebar = !self.sidebar,
            Act::Appearance(a) => self.set_appearance(a),
            Act::Shortcuts => self.shortcuts = true,
            Act::Rename(session) => self.start_rename(&session),
            Act::Archive(session) => self.archive(&session, true),
            Act::Archived => {
                self.sidebar = true;
                self.show_archived = !self.show_archived;
            }
        }
    }

    pub fn set_appearance(&mut self, a: Appearance) {
        self.appearance = a;
        self.ui_rev += 1;
    }

    /// Arrows move the pick, Return runs it; Escape is the modal's.
    fn palette_key(&mut self, ev: &KeyEvent, tx: &mut Tx) -> bool {
        let n = shown(self).len().max(1);
        let Some(f) = self.finder.as_mut() else { return false };
        let at = f.index.min(n - 1);
        match ev.key {
            Key::Down => f.index = (at + 1) % n,
            Key::Up => f.index = (at + n - 1) % n,
            Key::Enter => {
                if let Some(c) = shown(self).into_iter().nth(at) {
                    self.run(c.act);
                }
                return true;
            }
            _ => return false,
        }
        let index = self.finder.as_ref().map_or(0, |f| f.index);
        if let Some(c) = shown(self).get(index) {
            tx.scroll_into_view(format!("palette-item:{}", c.id));
        }
        true
    }
}

/// The palette over the window, as the web's: a scrim, the panel high on the page.
pub fn view(s: &State, p: &Palette, layer: &mut Vec<El>) {
    let Some(f) = &s.finder else { return };
    let results = shown(s);
    let active = f.index.min(results.len().saturating_sub(1));
    let input = text_input(&f.query, BODY.lh(22.0))
        .key("palette-input")
        .label("Search chats and commands")
        .placeholder("Search chats and commands", p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .on_edit(|s: &mut State| {
            let f = s.finder.get_or_insert_with(|| Finder { query: TextEdit::new(""), index: 0 });
            f.index = 0;
            &mut f.query
        })
        .on_input_key(|s: &mut State, ev, tx| s.palette_key(ev, tx));
    let search = row()
        .key("palette-search")
        .w_full()
        .h(60.0)
        .pl(20.0)
        .pr(16.0)
        .gap(12.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .child(icon(&icons::SEARCH, 18.0).color(p.quiet))
        .child(input)
        .child(keycap("esc", p));
    let mut list = col().key("palette-list").w_full().padding(6.0);
    if results.is_empty() {
        list = list.child(row().w_full().py(18.0).center().child(text(format!("Nothing matches “{}”.", f.query.text)).font(META).color(p.quiet)));
    }
    for (at, c) in results.iter().enumerate() {
        if at > 0 && results[at - 1].group != c.group {
            list = list.child(row().w_full().px(10.0).py(6.0).child(el().grow(1.0).h(1.0).fill(p.line)));
        }
        let act = c.act.clone();
        let mut item = row()
            .key(&format!("palette-item:{}", c.id))
            .role("option")
            .label(&c.label)
            .w_full()
            .h(34.0)
            .px(10.0)
            .gap(12.0)
            .center_y()
            .radius(10.0)
            .hover(p.hover)
            .child(text(c.label.clone()).font(ROW).color(p.ink).max_lines(1).grow(1.0).shrink())
            .on_press(move |s: &mut State| s.run(act.clone()));
        if at == active {
            item = item.fill(p.selected);
        }
        if !c.hint.is_empty() {
            item = item.child(text(c.hint.clone()).font(SMALL).color(p.quiet));
        }
        list = list.child(item);
    }
    let panel = col()
        .key("palette")
        .role("dialog")
        .label("Commands")
        .w_full()
        .max_w(640.0)
        .max_h(440.0)
        .radius(18.0)
        .clip_rounded(18.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(12.0, 32.0, p.shadow)
        .child(search)
        .child(col().key("palette-scroll").w_full().shrink().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(list))
        .modal(true, |s: &mut State| s.finder = None);
    layer.push(el().key("palette-scrim").absolute(0.0, 0.0).w_full().h_full().fill(p.scrim).a11y_hidden());
    layer.push(col().key("palette-layer").absolute(0.0, 0.0).w_full().h_full().px(16.0).pt(96.0).items_center().child(panel));
}

/// ⌘/: every shortcut, in a sheet.
pub fn shortcuts(s: &State, p: &Palette, layer: &mut Vec<El>) {
    if !s.shortcuts {
        return;
    }
    let mut list = col().w_full().px(20.0).pb(16.0).gap(2.0);
    for (keys, what) in SHORTCUTS {
        list = list.child(
            row()
                .w_full()
                .h(30.0)
                .center_y()
                .child(text(*what).font(ROW).color(p.ink).grow(1.0))
                .child(keys_el(keys, p)),
        );
    }
    let panel = col()
        .key("shortcuts")
        .role("dialog")
        .label("Keyboard shortcuts")
        .w_full()
        .max_w(440.0)
        .radius(18.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(12.0, 32.0, p.shadow)
        .child(
            row()
                .w_full()
                .px(20.0)
                .pt(18.0)
                .pb(10.0)
                .center_y()
                .child(text("Keyboard shortcuts").font(TITLE).color(p.ink).grow(1.0))
                .child(crate::shell::icon_button("shortcuts-close", &icons::CLOSE, "Close", p).on_press(|s: &mut State| s.shortcuts = false)),
        )
        .child(list)
        .modal(true, |s: &mut State| s.shortcuts = false);
    layer.push(el().key("shortcuts-scrim").absolute(0.0, 0.0).w_full().h_full().fill(p.scrim).a11y_hidden());
    layer.push(col().key("shortcuts-layer").absolute(0.0, 0.0).w_full().h_full().padding(16.0).center().child(panel));
}

/// The rename sheet: the chat's name, selected, Return saves and Escape leaves it.
pub fn rename(s: &State, p: &Palette, layer: &mut Vec<El>) {
    let Some((_, edit)) = &s.renaming else { return };
    let field = text_input(edit, BODY)
        .key("rename-input")
        .label("Chat name")
        .color(p.ink)
        .w_full()
        .px(12.0)
        .py(8.0)
        .radius(10.0)
        .fill(p.sunken)
        .border(1.0, p.line_strong)
        .on_edit(|s: &mut State| &mut s.renaming.get_or_insert_with(|| (String::new(), TextEdit::new(""))).1)
        .on_submit(|s: &mut State, _| s.finish_rename(true));
    let button = |key: &str, label: &str, primary: bool, save: bool| {
        row()
            .key(key)
            .role("button")
            .label(label)
            .h(32.0)
            .px(14.0)
            .radius(16.0)
            .center()
            .fill(if primary { p.user_bubble } else { p.raised })
            .child(text(label.to_string()).font(ROW).color(if primary { p.user_ink } else { p.ink }))
            .on_press(move |s: &mut State| s.finish_rename(save))
    };
    let panel = col()
        .key("rename")
        .role("dialog")
        .label("Rename chat")
        .w_full()
        .max_w(400.0)
        .padding(20.0)
        .gap(14.0)
        .radius(18.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(12.0, 32.0, p.shadow)
        .child(text("Rename chat").font(TITLE).color(p.ink))
        .child(field)
        .child(row().w_full().gap(8.0).child(el().grow(1.0)).child(button("rename-cancel", "Cancel", false, false)).child(button("rename-save", "Save", true, true)))
        .modal(true, |s: &mut State| s.finish_rename(false));
    layer.push(el().key("rename-scrim").absolute(0.0, 0.0).w_full().h_full().fill(p.scrim).a11y_hidden());
    layer.push(col().key("rename-layer").absolute(0.0, 0.0).w_full().h_full().padding(16.0).center().child(panel));
}

/// "⇧⌘[  ⇧⌘]" as keycaps, one per run of keys.
fn keys_el(keys: &str, p: &Palette) -> El {
    let mut r = row().gap(4.0).center_y();
    for part in keys.split("  ") {
        r = r.child(keycap(part, p));
    }
    r
}

pub fn keycap(label: &str, p: &Palette) -> El {
    el().px(6.0).h(18.0).radius(6.0).fill(p.raised).center().child(text(label.to_string()).font(SMALL).color(p.quiet))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_match_as_the_web_matches_them() {
        let c = command("new", "Chats", "New side chat", "", "create start", Act::NewChat);
        assert!(matches(&c, "si c"));
        assert!(matches(&c, "CREATE"));
        assert!(matches(&c, ""));
        assert!(!matches(&c, "ide"));
        let page = command("m", "Settings", "Settings › Models", "", "", Act::Settings(None));
        assert!(matches(&page, "set mod"));
    }
}
