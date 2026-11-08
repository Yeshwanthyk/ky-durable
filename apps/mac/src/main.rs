//! ky for macOS, drawn with Rune. A desktop window on your ky: the chats in a sidebar (the main
//! chat, side chats by day, archived ones folded away), the open ones as tabs, and Settings. At
//! first launch it asks which ky: one ky's CLI deployed from this computer, or an address you type.
//! It signs in through that ky's Cloudflare Access (`signin.rs`).
//!
//!   cargo run --release                                     # choose a ky
//!   KY_URL=http://127.0.0.1:8790 KY_TOKEN=<token> cargo run  # the local stack (scripts/dev)
//!
//! Headless, with no network (`KY_OFFLINE=1`): `--snap out.png --scene long`, `--script … --trace …`.
//! See apps/mac/README.md.

mod activity;
mod bloub;
mod pages;
mod remote;
mod cards;
mod chat;
mod cloud;
mod kys;
mod link;
mod media;
mod os;
mod palette;
mod queue;
mod routines;
mod settings;
mod shell;
mod signin;
mod theme;
mod time;
mod transcript;
mod view;
mod welcome;
mod wire;

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::Receiver;

use rune::{AppSpec, Key, KeyEvent, TextEdit, Tx, Waker};
use rune_kit::shell::TabDragState;

use chat::Chat;
use kys::Ky;
use link::{Config, Inbound, MAIN, Outbox, Status};
use wire::{Approval, ChatRow, SettingsView, Subscription, ToolInfo};

/// One chat this window follows: its socket, what it holds, and the draft typed into it. The main
/// chat's is always open (it also brings the chat list and settings); a side chat's lives while
/// its tab does.
pub struct Conn {
    pub session: String,
    pub chat: Chat,
    pub status: Status,
    pub draft: TextEdit,
    /// Images attached to the draft, those still being made small enough, and why one wasn't taken.
    pub images: Vec<media::Picked>,
    pub preparing: usize,
    pub image_error: Option<String>,
    /// Steer now pressed with this many queued; the head says so until the queue changes.
    pub steering: Option<usize>,
    outbox: Option<Outbox>,
    inbound: Option<Receiver<Inbound>>,
}

impl Conn {
    fn offline(session: &str) -> Conn {
        Conn {
            session: session.to_string(),
            chat: Chat::default(),
            status: Status::Down("offline".into()),
            draft: TextEdit::new(""),
            images: Vec::new(),
            preparing: 0,
            image_error: None,
            steering: None,
            outbox: None,
            inbound: None,
        }
    }

    fn start(config: Config, waker: &Waker) -> Conn {
        let waker = waker.clone();
        let session = config.session.clone();
        let (outbox, inbound) = link::start(config, move || waker());
        Conn { outbox: Some(outbox), inbound: Some(inbound), status: Status::Connecting, ..Conn::offline(&session) }
    }

    /// A queued message back in the composer: its words before what's typed, its images too.
    pub fn restore(&mut self, back: chat::Outgoing) {
        let typed = self.draft.text.trim().to_string();
        let text = if typed.is_empty() { back.text } else { format!("{}\n\n{typed}", back.text) };
        self.draft = TextEdit::new(&text);
        let room = media::MAX_IMAGES.saturating_sub(self.images.len());
        self.images.extend(back.images.into_iter().take(room));
    }

    /// A socket follows this chat (headless scenes have none).
    pub fn live(&self) -> bool {
        self.outbox.is_some()
    }

    pub(crate) fn send(&self, text: String) {
        if let Some(outbox) = &self.outbox {
            let _ = outbox.send(text);
        }
    }
}

/// What a tab shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tab {
    Chat(String),
    Activity,
    Settings,
}

/// Light, dark, or as macOS is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    System,
    Light,
    Dark,
}

/// Settings' pages, as the sidebar of a macOS settings window lists them: the web's Settings pages
/// (`src/ui/use-panel.ts` SettingsPage), General being its first page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    General,
    Models,
    Providers,
    Tools,
    Executor,
    Spend,
    Machines,
    Subscriptions,
    Proactivity,
    Appearance,
    Peers,
    Mail,
    Webhooks,
    SelfEdits,
}

pub struct State {
    /// The ky this window shows; none while the user chooses one.
    pub ky: Option<Ky>,
    /// The kys to choose from.
    pub kys: Vec<Ky>,
    /// The address typed on the choose-a-ky screen, and why it wasn't taken.
    pub address: TextEdit,
    pub address_error: Option<String>,
    /// The welcome screen's steps: a Cloudflare login, a ky, its sign-in.
    pub welcome: welcome::Welcome,
    waker: Option<Waker>,
    config: Option<Config>,
    /// The main chat's first, then each open side chat's.
    pub conns: Vec<Conn>,
    pub tabs: Vec<Tab>,
    /// Which tab shows; meaningless while there are none.
    pub active: usize,
    /// The tab Activity was opened from, where the pill and ⇧⌘A go back to.
    pub activity_from: Option<Tab>,
    /// The main pane's width as last laid out: the corner pill rises over the composer when the
    /// pane leaves no room beside it.
    pub main_w: f32,
    /// A tab being dragged along the strip.
    pub drag: TabDragState,
    /// Every side chat ky has, archived ones too, as its last `chats` frame said.
    pub chats: Vec<ChatRow>,
    pub settings: SettingsView,
    pub subscriptions: Vec<Subscription>,
    pub sidebar: bool,
    pub show_archived: bool,
    pub section: Section,
    /// A page under the section: a purpose's model page, a machine's page.
    pub detail: Option<String>,
    /// What Settings asked ky or fetched, by name (`settings::actions`): `spend`, `peers`, `mail`…
    pub views: HashMap<&'static str, serde_json::Value>,
    /// Asks waiting on their answer, by id, and what to do with it.
    pub(crate) asks: HashMap<String, settings::Then>,
    /// Why a form or list was refused, by its name; cleared when it next succeeds.
    pub problems: HashMap<&'static str, String>,
    /// Forms waiting on ky.
    pub busy: HashSet<&'static str>,
    /// The form open on a page (`invite`, `pair`, `hook`, `executor`…), and the thing a confirm is for.
    pub adding: Option<&'static str>,
    pub confirm: Option<String>,
    /// Picks on Settings' forms: the vendor for a key, GitHub's repos, a webhook's chat.
    pub picks: HashMap<&'static str, String>,
    pub ticks: HashSet<String>,
    /// Every model, not only the featured, on a model page.
    pub all_models: bool,
    /// Appearance › Accent: an index into `theme::ACCENTS`; 0 is ink.
    pub accent: usize,
    /// HTTP answers from Settings' fetches, which run on their own threads.
    http: (std::sync::mpsc::Sender<(settings::Then, Result<serde_json::Value, String>)>, Receiver<(settings::Then, Result<serde_json::Value, String>)>),
    /// A `new-chat` waiting on its session, by the id it went with.
    pending_new: Option<String>,
    /// The last thing ky refused, shown until the next action.
    pub notice: Option<String>,
    pub(crate) sent: u64,
    pub markdown_dark: rune_kit::MarkdownStyle,
    pub markdown_light: rune_kit::MarkdownStyle,
    pub kit_dark: rune_kit::Kit,
    pub kit_light: rune_kit::Kit,
    /// What the user opened: a turn's log, a tool's output, a thought, a summary. By key.
    pub open: HashSet<String>,
    pub appearance: Appearance,
    /// Bumps when anything rows draw from outside their own data changes (`open`, a card's draft).
    pub ui_rev: u64,
    /// A card's choices ticked so far, by its call: each question's values.
    pub card_values: HashMap<String, Vec<Vec<String>>>,
    /// A card's shown tab, by call and block path.
    pub card_tabs: HashMap<String, usize>,
    /// Text fields other than the composer (a card's inputs, Settings' forms), by key.
    pub fields: HashMap<String, TextEdit>,
    /// Bumps when a card's draft changes (a tick, a tab, typing), by its call: its row's memo key.
    pub card_rev: HashMap<String, u64>,
    /// The approvals waiting on the user, every chat's.
    pub approvals: Vec<Approval>,
    /// The tools ky's model has, as `hello` and `tools` frames list them.
    pub tools: Vec<ToolInfo>,
    /// Executor's connections, the setup checklist, routines and machines, as ky last sent them.
    pub executor: serde_json::Value,
    pub setup: serde_json::Value,
    pub tasks: serde_json::Value,
    pub machines: serde_json::Value,
    /// Every routine (`automations` frame), and whether the dream books check-ins.
    pub automations: serde_json::Value,
    pub check_ins: bool,
    /// What the Activity tab shows and has asked for.
    pub activity: activity::Activity,
    /// ⌘K while it's open.
    pub finder: Option<palette::Finder>,
    /// ⌘/'s sheet of shortcuts.
    pub shortcuts: bool,
    /// The side chat being renamed, and the name typed so far.
    pub renaming: Option<(String, TextEdit)>,
    /// Whether the last frame drew dark, as `appearance` and macOS decided it.
    pub dark: std::cell::Cell<bool>,
    /// Every image the window draws, decoded off the UI thread.
    pub images: rune::ImageCache,
    /// Wakes the window from a worker thread; forwards to the app's waker once `setup` has it.
    wake: Waker,
    wake_slot: std::sync::Arc<std::sync::Mutex<Option<Waker>>>,
    /// Images made ready to send, by the chat they're for.
    media: (std::sync::mpsc::Sender<(String, Result<media::Picked, String>)>, Receiver<(String, Result<media::Picked, String>)>),
    picked: u64,
    pub lightbox: Option<media::Lightbox>,
    /// The bloubs ky and its specialists wear, and the motion of each one on screen.
    pub blobs: bloub::Blobs,
    /// Pictures fetched from ky and the web for the chat.
    pub remote: remote::Remote,
    /// The pages ky built, live in the chat over their cards.
    pub pages: pages::Pages,
}

impl State {
    fn new() -> State {
        let wake_slot: std::sync::Arc<std::sync::Mutex<Option<Waker>>> = Default::default();
        let slot = wake_slot.clone();
        let wake: Waker = std::sync::Arc::new(move || {
            if let Some(w) = slot.lock().ok().and_then(|w| w.clone()) {
                w();
            }
        });
        State {
            images: rune::ImageCache::new(wake.clone()),
            wake: wake.clone(),
            wake_slot,
            media: std::sync::mpsc::channel(),
            picked: 0,
            lightbox: None,
            blobs: bloub::Blobs::new(wake.clone()),
            remote: remote::Remote::default(),
            pages: pages::Pages::default(),
            ky: None,
            kys: Vec::new(),
            address: TextEdit::new(""),
            address_error: None,
            welcome: welcome::Welcome::default(),
            waker: None,
            config: None,
            conns: Vec::new(),
            tabs: Vec::new(),
            active: 0,
            activity_from: None,
            main_w: 0.0,
            drag: TabDragState::default(),
            chats: Vec::new(),
            settings: SettingsView::default(),
            subscriptions: Vec::new(),
            sidebar: true,
            show_archived: false,
            section: Section::General,
            detail: None,
            views: HashMap::new(),
            asks: HashMap::new(),
            problems: HashMap::new(),
            busy: HashSet::new(),
            adding: None,
            confirm: None,
            picks: HashMap::new(),
            ticks: HashSet::new(),
            all_models: false,
            accent: 0,
            http: std::sync::mpsc::channel(),
            pending_new: None,
            notice: None,
            sent: 0,
            markdown_dark: theme::markdown(true),
            markdown_light: theme::markdown(false),
            kit_dark: theme::kit(true),
            kit_light: theme::kit(false),
            open: HashSet::new(),
            appearance: Appearance::System,
            finder: None,
            shortcuts: false,
            renaming: None,
            dark: std::cell::Cell::new(true),
            ui_rev: 0,
            card_values: HashMap::new(),
            card_tabs: HashMap::new(),
            fields: HashMap::new(),
            card_rev: HashMap::new(),
            approvals: Vec::new(),
            tools: Vec::new(),
            executor: serde_json::Value::Null,
            setup: serde_json::Value::Null,
            tasks: serde_json::Value::Null,
            automations: serde_json::Value::Null,
            check_ins: true,
            activity: activity::Activity::default(),
            machines: serde_json::Value::Null,
        }
    }

    /// Open or close whatever `key` names.
    pub fn toggle(&mut self, key: &str) {
        if !self.open.remove(key) {
            self.open.insert(key.to_string());
        }
        self.ui_rev += 1;
    }

    // Cards and approvals.

    /// What `call`'s card has ticked so far, one list per question.
    pub fn card_values(&self, call: &str, questions: usize) -> Vec<Vec<String>> {
        let mut v = self.card_values.get(call).cloned().unwrap_or_default();
        v.resize(questions, Vec::new());
        v
    }

    pub fn card_tab(&mut self, key: &str, tab: usize) {
        self.card_tabs.insert(key.to_string(), tab);
        if let Some((call, _)) = key.split_once(':') {
            self.touch_card(call);
        }
    }

    pub fn touch_card(&mut self, call: &str) {
        *self.card_rev.entry(call.to_string()).or_default() += 1;
    }

    /// A card's text field, for its `on_edit`: the row it sits in draws again.
    pub fn card_field(&mut self, key: &str) -> &mut TextEdit {
        if let Some((call, _)) = key.split_once(':') {
            self.touch_card(call);
        }
        self.fields.entry(key.to_string()).or_insert_with(|| TextEdit::new(""))
    }

    /// What a row's cards have drafted, as one number for its memo key.
    pub fn cards_rev(&self, r: &chat::Row) -> u64 {
        r.tools().filter(|t| t.name == "ui").filter_map(|t| self.card_rev.get(&t.id)).sum()
    }

    /// An option tapped: a lone single choice sends at once; otherwise it ticks.
    pub fn card_choose(&mut self, session: &str, call: &str, at: usize, label: &str, multiple: bool) {
        let Some(spec) = self.card_spec(session, call) else { return };
        let qs = cards::questions(&spec);
        let mut values = self.card_values(call, qs.len());
        let Some(slot) = values.get_mut(at) else { return };
        if multiple {
            match slot.iter().position(|v| v == label) {
                Some(i) => {
                    slot.remove(i);
                }
                None => slot.push(label.to_string()),
            }
        } else {
            *slot = vec![label.to_string()];
        }
        self.card_values.insert(call.to_string(), values);
        self.touch_card(call);
        if !multiple && qs.len() == 1 {
            self.card_send(session, call, None);
        }
    }

    fn card_spec(&self, session: &str, call: &str) -> Option<serde_json::Value> {
        self.conns.iter().find(|c| c.session == session)?.chat.tool(call).map(|t| t.args.clone())
    }

    /// Answer `call`'s card: a button's reply, or every question's values.
    pub fn card_send(&mut self, session: &str, call: &str, button: Option<String>) {
        let Some(spec) = self.card_spec(session, call) else { return };
        let qs = cards::questions(&spec);
        let mut values = self.card_values(call, qs.len());
        for (i, q) in qs.iter().enumerate() {
            if q.get("type").and_then(|t| t.as_str()) == Some("input") {
                if let Some(f) = self.fields.get(&format!("{call}:{i}")) {
                    values[i] = vec![f.text.trim().to_string()];
                }
            }
        }
        let text = match &button {
            Some(reply) => reply.clone(),
            None if cards::answered(&qs, &values) => cards::compose(&qs, &values),
            None => return,
        };
        self.sent += 1;
        let operation = format!("mac-{}-{}", std::process::id(), self.sent);
        let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) else { return };
        conn.send(wire::submit_card(&text, &operation, call, &values, button.as_deref()));
        conn.chat.card_sent(call);
        conn.chat.sent(&text, &operation);
        self.touch_card(call);
    }

    /// Approve or decline an approval; the next `approvals` frame drops it.
    pub fn decide(&mut self, id: &str, accept: bool) {
        self.sent += 1;
        let request = format!("mac-approval-{}", self.sent);
        if let Some(main) = self.main_conn() {
            main.send(wire::approval_decide(&request, id, accept));
        }
        self.approvals.retain(|a| a.id != id);
        self.ui_rev += 1;
    }

    // Tabs and chats.

    /// The session the active tab shows, if it's a chat.
    pub fn current_session(&self) -> Option<String> {
        match self.current()? {
            Tab::Chat(session) => Some(session.clone()),
            Tab::Settings | Tab::Activity => None,
        }
    }

    pub fn current(&self) -> Option<&Tab> {
        self.tabs.get(self.active)
    }

    /// The chat the active tab shows.
    pub fn conn(&self) -> Option<&Conn> {
        match self.current()? {
            Tab::Chat(session) => self.conns.iter().find(|c| &c.session == session),
            Tab::Settings | Tab::Activity => None,
        }
    }

    fn conn_mut(&mut self) -> Option<&mut Conn> {
        let Some(Tab::Chat(session)) = self.tabs.get(self.active).cloned() else { return None };
        self.conns.iter_mut().find(|c| c.session == session)
    }

    fn main_conn(&self) -> Option<&Conn> {
        self.conns.iter().find(|c| c.session == MAIN)
    }

    pub fn title_of(&self, session: &str) -> String {
        if session == MAIN {
            return "Main chat".into();
        }
        match self.chats.iter().find(|c| c.session == session) {
            Some(chat) if !chat.title.trim().is_empty() => chat.title.clone(),
            _ => "New chat".into(),
        }
    }

    pub fn is_open(&self, session: &str) -> bool {
        self.current() == Some(&Tab::Chat(session.to_string()))
    }

    /// Show `session` in a tab: its own if it has one, a new one after the active tab if not.
    pub fn open_chat(&mut self, session: &str) {
        self.notice = None;
        if let Some(i) = self.tabs.iter().position(|t| t == &Tab::Chat(session.to_string())) {
            self.active = i;
            return;
        }
        if !self.conns.iter().any(|c| c.session == session) {
            let conn = match (&self.config, &self.waker) {
                (Some(config), Some(waker)) => Conn::start(config.side(session), waker),
                _ => Conn::offline(session),
            };
            self.conns.push(conn);
        }
        let at = if self.tabs.is_empty() { 0 } else { (self.active + 1).min(self.tabs.len()) };
        self.tabs.insert(at, Tab::Chat(session.to_string()));
        self.active = at;
    }

    /// Ask ky for a side chat; its tab opens when the answer comes (`poll`).
    pub fn new_chat(&mut self) {
        self.notice = None;
        if self.pending_new.is_some() {
            return;
        }
        self.sent += 1;
        let id = format!("mac-new-{}", self.sent);
        if let Some(main) = self.main_conn() {
            main.send(wire::new_chat(&id));
            self.pending_new = Some(id);
        }
    }

    pub fn close_tab(&mut self, i: usize) {
        if i >= self.tabs.len() {
            return;
        }
        if let Tab::Chat(session) = self.tabs.remove(i) {
            // The main chat's socket stays: it brings the chat list. A side chat's closes with its tab.
            if session != MAIN {
                self.conns.retain(|c| c.session != session);
            }
        }
        if self.active > i || self.active >= self.tabs.len() {
            self.active = self.active.saturating_sub(1);
        }
    }

    /// A tab dragged from `from` to `to`; the same tab stays active.
    pub fn move_tab(&mut self, from: usize, to: usize) {
        if from >= self.tabs.len() || to >= self.tabs.len() || from == to {
            return;
        }
        let active = self.tabs.get(self.active).cloned();
        let tab = self.tabs.remove(from);
        self.tabs.insert(to, tab);
        if let Some(active) = active {
            self.active = self.tabs.iter().position(|t| t == &active).unwrap_or(0);
        }
    }

    /// A new chat asked for and not yet answered.
    pub fn creating(&self) -> bool {
        self.pending_new.is_some()
    }

    pub fn select(&mut self, i: usize) {
        if i < self.tabs.len() {
            self.active = i;
        }
    }

    /// Archive a side chat (its tab closes), or bring one back.
    pub fn archive(&mut self, session: &str, archived: bool) {
        if session == MAIN {
            return;
        }
        if let Some(main) = self.main_conn() {
            main.send(wire::archive_chat(session, archived));
        }
        // Show it moved now; the next `chats` frame confirms it.
        if let Some(chat) = self.chats.iter_mut().find(|c| c.session == session) {
            chat.archived_at = archived.then(time::now_ms);
        }
        if archived {
            if let Some(i) = self.tabs.iter().position(|t| t == &Tab::Chat(session.to_string())) {
                self.close_tab(i);
            }
        }
    }

    pub fn start_rename(&mut self, session: &str) {
        if session == MAIN {
            return;
        }
        self.finder = None;
        let mut edit = TextEdit::new(&self.title_of(session));
        let end = edit.text.len();
        edit.set_selection(0, end);
        self.renaming = Some((session.to_string(), edit));
    }

    /// Save the typed name, as the web's rename field does: blank or unchanged saves nothing.
    pub fn finish_rename(&mut self, save: bool) {
        let Some((session, edit)) = self.renaming.take() else { return };
        let title = edit.text.trim().to_string();
        if !save || title.is_empty() || title == self.title_of(&session) {
            return;
        }
        if let Some(main) = self.main_conn() {
            main.send(wire::rename_chat(&session, &title));
        }
        // Show it now; the next `chats` frame confirms it.
        if let Some(chat) = self.chats.iter_mut().find(|c| c.session == session) {
            chat.title = title;
        }
    }

    /// Open Activity, or, on it, close it and go back to the tab it was opened from.
    pub fn toggle_activity(&mut self) {
        let Some(i) = self.tabs.iter().position(|t| t == &Tab::Activity).filter(|i| *i == self.active) else {
            return self.open_activity();
        };
        let back = self.activity_from.take();
        self.close_tab(i);
        if let Some(j) = back.and_then(|b| self.tabs.iter().position(|t| *t == b)) {
            self.active = j;
        }
    }

    pub fn open_activity(&mut self) {
        if let Some(t) = self.tabs.get(self.active).filter(|t| **t != Tab::Activity) {
            self.activity_from = Some(t.clone());
        }
        match self.tabs.iter().position(|t| t == &Tab::Activity) {
            Some(i) => self.active = i,
            None => {
                self.tabs.push(Tab::Activity);
                self.active = self.tabs.len() - 1;
            }
        }
        self.load_activity();
    }

    pub fn open_settings(&mut self) {
        match self.tabs.iter().position(|t| t == &Tab::Settings) {
            Some(i) => self.active = i,
            None => {
                self.tabs.push(Tab::Settings);
                self.active = self.tabs.len() - 1;
            }
        }
        self.load(self.section);
    }

    /// Run `purpose` on `model` of `provider`, keeping its thinking level where the model has it.
    pub fn set_model(&mut self, purpose: &str, provider: &str, model: &str) {
        let levels = self
            .settings
            .providers
            .iter()
            .find(|p| p.id == provider)
            .and_then(|p| p.models.iter().find(|m| m.model_id == model))
            .map(|m| m.levels.clone())
            .unwrap_or_default();
        let current = self.settings.purposes.get(purpose).map(|c| c.thinking_level.clone()).unwrap_or_default();
        let level = if levels.contains(&current) || levels.is_empty() { current } else { levels[levels.len() / 2].clone() };
        let level = if level.is_empty() { "off".to_string() } else { level };
        if let Some(main) = self.main_conn() {
            main.send(wire::set_model(purpose, provider, model, &level));
        }
        self.settings.purposes.insert(
            purpose.to_string(),
            wire::ModelChoice { provider: provider.into(), model_id: model.into(), thinking_level: level },
        );
    }

    // The composer.

    pub fn draft(&self) -> Option<&TextEdit> {
        self.conn().map(|c| &c.draft)
    }

    pub fn draft_mut(&mut self) -> &mut TextEdit {
        // Text fields route edits here only while a chat tab shows, so a conn is there.
        let i = match self.tabs.get(self.active) {
            Some(Tab::Chat(session)) => self.conns.iter().position(|c| &c.session == session),
            _ => None,
        };
        match i {
            Some(i) => &mut self.conns[i].draft,
            None => &mut self.address,
        }
    }

    pub fn send(&mut self, tx: &mut Tx) {
        self.sent += 1;
        let operation = format!("mac-{}-{}", std::process::id(), self.sent);
        let Some(conn) = self.conn_mut() else { return };
        let text = conn.draft.text.trim().to_string();
        if text.is_empty() && conn.images.is_empty() {
            return;
        }
        if conn.preparing > 0 {
            return;
        }
        let images: Vec<media::Picked> = std::mem::take(&mut conn.images);
        let parts: Vec<(String, String)> = images.iter().map(|i| (i.mime.clone(), i.data.clone())).collect();
        conn.send(wire::submit_with(&text, &parts, &operation));
        if conn.chat.running {
            conn.chat.queue(&text, images, &operation);
        } else {
            conn.chat.sent_with(&text, images.into_iter().map(|i| i.bytes).collect(), &operation);
        }
        conn.image_error = None;
        conn.draft.clear();
        let key = format!("transcript:{}", conn.session);
        tx.scroll_to_bottom(key);
    }

    pub fn stop(&mut self) {
        if let Some(conn) = self.conn() {
            conn.send(wire::abort());
        }
    }

    // Which ky.

    /// Open `ky` with its main chat in the first tab, closing whatever this window had open.
    pub fn open(&mut self, ky: Ky) {
        self.close();
        kys::opened(&ky);
        if let Some(waker) = &self.waker {
            let config = Config::for_ky(&ky.url);
            self.conns.push(Conn::start(config.clone(), waker));
            self.config = Some(config);
        }
        self.tabs = vec![Tab::Chat(MAIN.into())];
        self.active = 0;
        self.ky = Some(ky);
    }

    /// Back to the choose-a-ky screen.
    pub fn switch(&mut self) {
        self.close();
        self.welcome();
    }

    /// Forget this ky's sign-in, and don't open it at launch.
    pub fn sign_out(&mut self) {
        if let Some(ky) = &self.ky {
            signin::forget(&ky.url);
        }
        kys::forget_last();
        self.switch();
    }

    /// Dropping each outbox ends its socket thread.
    fn close(&mut self) {
        self.conns.clear();
        self.tabs.clear();
        self.active = 0;
        self.drag = TabDragState::default();
        self.chats.clear();
        self.settings = SettingsView::default();
        self.subscriptions.clear();
        self.pending_new = None;
        self.notice = None;
        self.views.clear();
        self.asks.clear();
        self.problems.clear();
        self.busy.clear();
        self.executor = serde_json::Value::Null;
        self.setup = serde_json::Value::Null;
        self.machines = serde_json::Value::Null;
        self.config = None;
        self.ky = None;
        // Its pages' web views go with it.
        self.pages.clear();
    }

    /// The main chat's link, which is ky's: it brings the chat list and settings.
    pub fn main_status(&self) -> Status {
        self.main_conn().map_or(Status::Connecting, |c| c.status.clone())
    }
}

fn setup(state: &mut State, waker: Waker) {
    if let Ok(mut slot) = state.wake_slot.lock() {
        *slot = Some(waker.clone());
    }
    if std::env::var_os("KY_OFFLINE").is_some() {
        // Scenes: the chat they built, no socket; a welcome scene stays on its welcome step.
        if matches!(state.welcome.profiles, welcome::Load::Idle) {
            view::offline(state);
        }
        return;
    }
    state.waker = Some(waker);
    let pinned = std::env::var("KY_URL").ok().and_then(|url| kys::parse(&url));
    match pinned.or_else(kys::last) {
        // Signed in already (or the local stack): straight in. Otherwise its sign-in step, by press.
        Some(ky) if ky.url.starts_with("http://") || signin::saved(&ky.url).is_some() => state.open(ky),
        Some(ky) => {
            state.welcome();
            state.welcome.access = Some(ky);
        }
        None => state.welcome(),
    }
}

/// Land what the socket threads decoded. True only when something visible changed, so an idle
/// window draws nothing.
fn poll(state: &mut State, clock: f64, tx: &mut Tx) -> bool {
    let mut changed = state.welcome_poll() | state.pages.wants_frame();
    // Bloubs on screen move every frame.
    if state.blobs.step(clock) {
        tx.wake_after(std::time::Duration::ZERO);
        changed = true;
    }
    let mut answers = Vec::new();
    for conn in &mut state.conns {
        let Some(inbound) = &conn.inbound else { continue };
        while let Ok(message) = inbound.try_recv() {
            match message {
                Inbound::Status(status) => {
                    changed |= conn.status != status;
                    conn.status = status;
                }
                Inbound::Events(events) => {
                    for event in events {
                        changed |= conn.chat.apply(event);
                    }
                }
                Inbound::Chats(chats) => {
                    changed |= state.chats != chats;
                    state.chats = chats;
                }
                Inbound::Settings(settings) => {
                    changed |= state.settings != settings;
                    state.settings = settings;
                }
                Inbound::Subscriptions(subscriptions) => {
                    changed |= state.subscriptions != subscriptions;
                    state.subscriptions = subscriptions;
                }
                Inbound::Approvals(approvals) => {
                    changed |= state.approvals != approvals;
                    state.approvals = approvals;
                    state.ui_rev += 1;
                }
                Inbound::Tools(tools) => state.tools = tools,
                Inbound::Executor(executor) => {
                    changed |= state.executor != executor;
                    state.executor = executor;
                }
                Inbound::Setup(setup) => {
                    changed |= state.setup != setup;
                    state.setup = setup;
                }
                Inbound::Automations(automations, check_ins) => {
                    changed |= state.automations != automations || state.check_ins != check_ins;
                    state.automations = automations;
                    state.check_ins = check_ins;
                }
                Inbound::Tasks(tasks, machines) => {
                    os::finished(&state.tasks, &tasks);
                    os::badge(tasks.as_array().map_or(0, |t| t.iter().filter(|t| matches!(t["status"].as_str(), Some("queued" | "working"))).count()));
                    changed |= state.tasks != tasks || state.machines != machines;
                    state.tasks = tasks;
                    state.machines = machines;
                }
                Inbound::Avatars(avatars) => {
                    let saved = bloub::saved(&avatars);
                    changed |= state.blobs.saved != saved;
                    state.blobs.saved = saved;
                    state.ui_rev += 1;
                }
                Inbound::Answer(id, answer) => answers.push((id, answer)),
            }
        }
    }
    // What Stop gave back goes into the composer, ahead of what's typed there.
    for conn in &mut state.conns {
        for back in std::mem::take(&mut conn.chat.returned) {
            conn.restore(back);
            changed = true;
        }
    }
    changed |= state.land_images();
    while let Ok((then, answer)) = state.http.1.try_recv() {
        state.answer(then, answer);
        changed = true;
    }
    for (id, answer) in answers {
        if let Some(then) = state.asks.remove(&id) {
            state.answer(then, answer);
            changed = true;
            continue;
        }
        if state.pending_new.as_deref() != Some(id.as_str()) {
            if let Err(why) = answer {
                state.notice = Some(why);
                changed = true;
            }
            continue;
        }
        state.pending_new = None;
        changed = true;
        match answer.map(|v| v.get("session").and_then(|s| s.as_str()).map(str::to_string)) {
            Ok(Some(session)) => state.open_chat(&session),
            Ok(None) => state.notice = Some("ky didn't say which chat it started.".into()),
            Err(why) => state.notice = Some(why),
        }
    }
    changed
}

/// The window's shortcuts, as a Mac app's (`palette::SHORTCUTS` lists them for ⌘/): ⌘K the
/// palette, ⌘T/⌘N new chat, ⌘W close tab, ⌘1–9 a tab, ⇧⌘[ and ⇧⌘] the tab before and after,
/// ⌘, Settings, ⌃⌘S or ⌘\ the sidebar, ⇧⌘L light or dark, ⌘/ the shortcuts.
fn keys(state: &mut State, ev: &KeyEvent, tx: &mut Tx) -> bool {
    // The lightbox has the keys while it's open: ← → step, Esc closes.
    if state.lightbox.is_some() {
        match ev.key {
            Key::Escape => state.lightbox = None,
            Key::Left => state.step_lightbox(-1),
            Key::Right => state.step_lightbox(1),
            _ => return false,
        }
        return true;
    }
    if state.ky.is_none() {
        return false;
    }
    if matches!(state.current(), Some(Tab::Activity)) && activity_keys(state, ev, tx) {
        return true;
    }
    if !ev.mods.cmd {
        return false;
    }
    let Key::Command(c) = ev.key else { return false };
    if c != 'k' && (state.finder.is_some() || state.shortcuts || state.renaming.is_some()) {
        return false;
    }
    match c {
        'k' => state.open_palette(),
        '/' | '?' => state.shortcuts = !state.shortcuts,
        't' | 'n' => state.new_chat(),
        'w' if state.tabs.is_empty() => tx.close_window(),
        'w' => state.close_tab(state.active),
        ',' => state.open_settings(),
        'a' | 'A' if ev.mods.shift => state.toggle_activity(),
        's' if ev.mods.ctrl => state.sidebar = !state.sidebar,
        '\\' => state.sidebar = !state.sidebar,
        'l' if ev.mods.shift => state.set_appearance(if state.dark.get() { Appearance::Light } else { Appearance::Dark }),
        '[' | '{' if ev.mods.shift => state.select((state.active + state.tabs.len().max(1) - 1) % state.tabs.len().max(1)),
        ']' | '}' if ev.mods.shift => state.select((state.active + 1) % state.tabs.len().max(1)),
        '9' => state.select(state.tabs.len().saturating_sub(1)),
        '1'..='8' => state.select(c as usize - '1' as usize),
        _ => return false,
    }
    if matches!(c, '[' | '{' | ']' | '}' | '1'..='9') {
        tx.instant();
    }
    true
}

/// Activity's keys: ↑ ↓ through the list while no field has focus, ⌘. stop, ⇧⌘. stop all,
/// ⌘O the chat, ⌘R run again, ⌥⌘1–4 the views, Esc closes a context menu.
fn activity_keys(state: &mut State, ev: &KeyEvent, tx: &mut Tx) -> bool {
    use activity::{VIEWS, View};
    let free = tx.focused().is_none();
    match ev.key {
        Key::Escape if state.activity.menu.is_some() => state.activity.menu = None,
        Key::Up if free && !ev.mods.cmd => state.step_pick(-1),
        Key::Down if free && !ev.mods.cmd => state.step_pick(1),
        Key::Command(c) if ev.mods.cmd => match c {
            '.' | '>' if ev.mods.shift => {
                if state.online() {
                    state.stop_all();
                }
            }
            '.' => state.stop_picked(),
            'o' => state.open_picked_chat(),
            'r' => state.run_picked(),
            // ⌥ turns the digits into ¡ ™ £ ¢ on a US layout; either reads as the digit.
            '1' | '2' | '3' | '4' | '¡' | '™' | '£' | '¢' if ev.mods.alt => {
                let i = "1234".find(c).or_else(|| ['¡', '™', '£', '¢'].iter().position(|g| *g == c)).unwrap_or(0);
                let view: View = VIEWS[i].0;
                state.show_view(view);
            }
            _ => return false,
        },
        _ => return false,
    }
    true
}

fn main() {
    // TLS for a deployed ky (wss): one crypto provider for the whole process.
    let _ = rustls::crypto::ring::default_provider().install_default();
    rune::prewarm_gpu();
    let spec = AppSpec::<State> {
        min_size: Some((640.0, 480.0)),
        families: (theme::SANS, "ui-monospace"),
        scenes: view::SCENES,
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(keys),
        ..AppSpec::new("ky", (1180.0, 820.0), State::new, view::view)
    };
    // Pages (WebKit views over their cards) move in the frame that draws their cards.
    let mut app = rune::App::new(spec).compositor(Native);
    // Under strobe (perf/mac.bench.ts), one line once the chat it opens on has drawn its history: the
    // launch case's end. With KY_PAGES_PROBE, how far each page sits from its card, every frame.
    let (strobe, probe) = (std::env::var_os("KY_READY_LINE").is_some(), std::env::var_os("KY_PAGES_PROBE").is_some());
    if strobe || probe {
        let mut ready = false;
        app = app.on_frame_drawn(move |rt: &rune::Runtime<State>| {
            if probe {
                rt.state.pages.probe(|key| rt.presented(key).map(|(r, _)| r));
            }
            if strobe && !ready && rt.state.conn().is_some_and(|c| !c.chat.rows.is_empty())
                && rt.state.current_session().is_some_and(|s| rt.presented(&format!("rows:{s}")).is_some())
            {
                ready = true;
                use std::io::Write;
                let mut out = std::io::stdout();
                let _ = writeln!(out, r#"{{"strobe":"state","name":"ready"}}"#);
                let _ = out.flush();
            }
        });
    }
    app.run();
}

/// Rune's own frame, then the native views laid over it put where this frame draws their
/// places: a view moved here commits with the frame (in one transaction during a live resize).
struct Native;

impl rune::Compositor<State> for Native {
    fn render(&mut self, f: &mut rune::Frame<'_, State>) {
        f.draw_ui();
        let rt = &*f.rt;
        rt.state.pages.place(|key| rt.presented(key).map(|(r, _)| r));
    }
}
