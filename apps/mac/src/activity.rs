//! Activity, as a tab, laid out as a Mac app's split view: a toolbar switches between Today,
//! Routines, Dreams and History; the list on the left holds what that view has, by section; the pane
//! on the right shows what's selected (a task's steps and summary, a routine's form, a dream's
//! change with Undo). Rows have a context menu, and the keys in `keys` drive it all. Words and
//! commands are the web's (`src/ui/Panel.tsx` Activity, `Automations.tsx`, `LastNight.tsx`).
//!
//! The `tasks` and `automations` frames bring the rows; the steps and the dream's ledger are asked.

use std::collections::HashMap;

use rune::{El, PointerPress, ScrollSpec, col, el, icon, row, text};
use rune_kit::{Kit, Markdown, MenuItem, Spinner, context_menu};
use serde_json::{Value, json};

use crate::settings::{Then, button, field, list_at, num_at, off, problem, segmented, str_at};
use crate::theme::{HEAD, META, META_STRONG, Palette, ROW, ROW_STRONG, SMALL, icons};
use crate::{State, routines, time};

/// What the tab shows.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum View {
    #[default]
    Today,
    Routines,
    Dreams,
    History,
}

pub const VIEWS: [(View, &str, &str); 4] =
    [(View::Today, "today", "Today"), (View::Routines, "routines", "Routines"), (View::Dreams, "dreams", "Dreams"), (View::History, "history", "History")];

/// What the right pane shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Pick {
    Task(String),
    /// A routine's form, by id, or a new one.
    Routine(Option<String>),
    /// A dream's change, by its ledger id.
    Change(i64),
}

/// What Activity holds between frames.
#[derive(Default)]
pub struct Activity {
    pub view: View,
    /// What's selected; none shows the list's first.
    pub pick: Option<Pick>,
    /// Each task's log, as `task-steps` answered.
    pub steps: HashMap<String, Vec<Value>>,
    /// How many past days History shows.
    pub days: usize,
    /// A ledger entry being undone, and why ky refused one.
    pub undoing: Option<i64>,
    pub refusals: HashMap<i64, String>,
    /// The row whose context menu is open, and where.
    pub menu: Option<(String, PointerPress)>,
}

const RECENT_DAYS: usize = 7;
/// How long a working task may say nothing before its row says it went quiet.
const QUIET_MS: f64 = 3.0 * 60_000.0;
pub const OFFLINE_TITLE: &str = "Offline · works once ky reconnects";
const LIST_W: f32 = 320.0;

impl State {
    /// Ask for what Activity shows that no frame brings: the latest dream's changes.
    pub fn load_activity(&mut self) {
        self.ask("dream-ledger", json!({}), Then::Store("dream-ledger"));
        if let Some(Pick::Task(task)) = self.activity.pick.clone() {
            self.ask("task-steps", json!({ "task": task }), Then::Steps(task));
        }
    }

    pub fn open_task(&mut self, task: &str) {
        self.activity.pick = Some(Pick::Task(task.to_string()));
        self.ask("task-steps", json!({ "task": task }), Then::Steps(task.to_string()));
    }

    pub fn stop_task(&mut self, task: &str) {
        self.tell("stop-task", json!({ "task": task }));
    }

    pub fn stop_all(&mut self) {
        self.tell("stop-all", json!({}));
    }

    pub fn undo_dream(&mut self, entry: i64) {
        self.activity.undoing = Some(entry);
        self.activity.refusals.remove(&entry);
        self.ask("dream-undo", json!({ "entry": entry }), Then::Undo(entry));
    }

    /// Whether the main chat's socket is open: stops and routine actions wait for no connection.
    pub fn online(&self) -> bool {
        matches!(self.main_status(), crate::link::Status::Open { .. })
    }

    pub fn show_view(&mut self, view: View) {
        if self.activity.view != view {
            self.activity.view = view;
            self.activity.pick = None;
            self.activity.menu = None;
        }
    }

    /// Select a list entry: a task asks for its steps, a routine fills its form.
    pub fn pick(&mut self, pick: Pick) {
        self.activity.menu = None;
        match &pick {
            Pick::Task(id) => self.open_task(&id.clone()),
            Pick::Routine(id) => self.open_routine(id.clone().as_deref()),
            Pick::Change(_) => self.activity.pick = Some(pick),
        }
    }

    /// ↑ and ↓: the entry before or after the selected one.
    pub fn step_pick(&mut self, by: i32) {
        let picks: Vec<Pick> = sections(self, time::now_ms()).into_iter().flat_map(|(_, items)| items.into_iter().map(|i| i.pick())).collect();
        if picks.is_empty() {
            return;
        }
        let at = selected(self).and_then(|cur| picks.iter().position(|p| *p == cur));
        let next = match at {
            Some(i) => (i as i32 + by).clamp(0, picks.len() as i32 - 1) as usize,
            None => 0,
        };
        self.pick(picks[next].clone());
    }

    /// The selected task, when one is.
    fn picked_task(&self) -> Option<Task<'_>> {
        let Some(Pick::Task(id)) = selected(self) else { return None };
        self.tasks.as_array()?.iter().map(Task).find(|t| t.id() == id)
    }

    /// ⌘.: stop the selected task.
    pub fn stop_picked(&mut self) {
        if let Some(id) = self.picked_task().filter(Task::live).map(|t| t.id().to_string()) {
            if self.online() {
                self.stop_task(&id);
            }
        }
    }

    /// ⌘O: the selected task's chat.
    pub fn open_picked_chat(&mut self) {
        if let Some(session) = self.picked_task().and_then(|t| t.session()).map(str::to_string) {
            self.open_chat(&session);
        }
    }

    /// ⌘R: the selected task's routine, run again; or the selected routine, run now.
    pub fn run_picked(&mut self) {
        let routine = match selected(self) {
            Some(Pick::Routine(Some(id))) => Some(id),
            Some(Pick::Task(_)) => self.picked_task().and_then(|t| t.routine()).map(str::to_string),
            _ => None,
        };
        if let Some(id) = routine.filter(|_| self.online()) {
            self.routine_action(&id, "run");
        }
    }
}

// Tasks.

/// A `TaskRow` (`src/automations/contract.ts`), read where it's used.
#[derive(Clone, Copy)]
pub struct Task<'a>(pub &'a Value);

impl<'a> Task<'a> {
    pub fn id(&self) -> &'a str {
        str_at(self.0, "id")
    }
    pub fn status(&self) -> &'a str {
        str_at(self.0, "status")
    }
    pub fn title(&self) -> String {
        plain(str_at(self.0, "title"))
    }
    pub fn worker(&self) -> &'a str {
        str_at(self.0, "worker")
    }
    pub fn kind(&self) -> &'a str {
        str_at(self.0, "kind")
    }
    pub fn live(&self) -> bool {
        matches!(self.status(), "queued" | "working")
    }
    pub fn updated(&self) -> f64 {
        num_at(self.0, "updated_at")
    }
    fn at(&self, key: &str) -> Option<f64> {
        self.0.get(key).and_then(Value::as_f64)
    }
    /// The routine this is a fire of (`automation:<id>`), or none for work a chat handed out.
    pub fn routine(&self) -> Option<&'a str> {
        str_at(self.0, "source").strip_prefix("automation:")
    }
    pub fn session(&self) -> Option<&'a str> {
        self.0.get("session").and_then(Value::as_str).filter(|_| self.kind() == "cloud")
    }
    fn steps(&self) -> &'a [Value] {
        list_at(self.0, "steps")
    }
    /// The newest step's words, while it's live.
    fn current_step(&self) -> Option<String> {
        if !self.live() {
            return None;
        }
        self.steps().last().map(|s| plain(str_at(s, "text"))).filter(|t| !t.is_empty())
    }
    /// How long it ran: to now while live, to its finish once over.
    pub fn elapsed(&self, now: f64) -> Option<String> {
        let start = self.at("started_at")?;
        Some(duration(self.at("finished_at").unwrap_or(now) - start))
    }
    /// "Machine offline", or "Quiet for 4m" once a working task has said nothing a while.
    fn quiet(&self, machines: &Value, now: f64) -> Option<String> {
        if self.status() != "working" {
            return None;
        }
        let gone = self.kind() == "machine"
            && machines.as_array().is_some_and(|ms| ms.iter().any(|m| str_at(m, "name") == self.worker() && m.get("online").and_then(Value::as_bool) != Some(true)));
        if gone {
            return Some("Machine offline".into());
        }
        let heard = self.steps().last().map(|s| num_at(s, "at")).or_else(|| self.at("started_at")).unwrap_or_else(|| self.updated());
        let silent = now - heard;
        (silent >= QUIET_MS).then(|| format!("Quiet for {}m", (silent / 60_000.0).floor()))
    }
    /// Time, turns and cost, each its own part.
    fn spend(&self, now: f64) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(e) = self.elapsed(now) {
            out.push(e);
        }
        if let Some(t) = self.0.get("turns").and_then(Value::as_u64) {
            out.push(if t == 1 { "1 turn".into() } else { format!("{t} turns") });
        }
        if let Some(c) = self.0.get("cost_usd").and_then(Value::as_f64).filter(|c| *c > 0.0) {
            out.push(if c < 0.01 { format!("${c:.3}") } else { format!("${c:.2}") });
        }
        out
    }
}

/// Every task, newest first.
pub fn tasks(s: &State) -> Vec<Task<'_>> {
    let mut out: Vec<Task> = s.tasks.as_array().map_or(&[][..], Vec::as_slice).iter().map(Task).collect();
    out.sort_by(|a, b| b.updated().total_cmp(&a.updated()));
    out
}

/// "34s", "1m 5s", "2h 3m" (`src/ui/duration.ts`).
pub fn duration(ms: f64) -> String {
    let seconds = (ms / 1000.0).round().max(0.0) as i64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {}s", seconds % 60);
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

/// Markdown down to its words: no emphasis marks, links as their text, code as itself.
pub fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' | '_' | '`' | '#' => {}
            '[' => {
                let mut inner = String::new();
                for d in chars.by_ref() {
                    if d == ']' {
                        break;
                    }
                    inner.push(d);
                }
                if chars.peek() == Some(&'(') {
                    for d in chars.by_ref() {
                        if d == ')' {
                            break;
                        }
                    }
                }
                out.push_str(&inner);
            }
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

// Local wall-clock time.

pub struct Wall {
    pub day: i64,
    pub year: i32,
    pub month: u32,
    pub mday: u32,
    pub wday: u32,
    pub hour: u32,
    pub minute: u32,
}

pub fn wall(ms: f64) -> Wall {
    let secs = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: localtime_r writes into the `tm` we own and reads only `secs`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    Wall {
        day: (secs as i64 + tm.tm_gmtoff).div_euclid(86_400),
        year: tm.tm_year + 1900,
        month: tm.tm_mon as u32,
        mday: tm.tm_mday as u32,
        wday: tm.tm_wday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
    }
}

pub fn same_day(a: f64, b: f64) -> bool {
    wall(a).day == wall(b).day
}

/// "9:00 AM".
pub fn clock_of(hour: u32, minute: u32) -> String {
    let h = match hour % 12 {
        0 => 12,
        h => h,
    };
    format!("{h}:{minute:02} {}", if hour < 12 { "AM" } else { "PM" })
}

pub fn clock_at(ms: f64) -> String {
    let w = wall(ms);
    clock_of(w.hour, w.minute)
}

pub const WEEK: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
pub const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Sat, Nov 7".
fn date_of(ms: f64) -> String {
    let w = wall(ms);
    format!("{}, {} {}", WEEK[w.wday as usize], MONTHS[w.month as usize], w.mday)
}

// Last night.

/// A change in words, its glyph, the line under it, and the word the tally counts it under.
fn describe(row: &Value) -> (String, &'static rune::Icon, Option<String>, String) {
    let (kind, action, target) = (str_at(row, "kind"), str_at(row, "action"), str_at(row, "target"));
    let reason = row.get("reason").and_then(Value::as_str).map(str::to_string);
    let before = row.get("before").and_then(Value::as_str).map(|b| format!("“{b}”"));
    if kind == "memory" && action == "note" {
        return ("Noted a memory".into(), &icons::THOUGHT, before.or(reason), "noted".into());
    }
    if kind == "memory" {
        return ("Forgot a memory summary".into(), &icons::THOUGHT, before.or(reason), "forgot".into());
    }
    if let Some(into) = row.get("absorbed_into").and_then(Value::as_str) {
        return (format!("Merged {target} into {into}"), &icons::COMPRESS, reason, "merged".into());
    }
    let (verb, glyph): (&str, &'static rune::Icon) = match action {
        "create" => ("Made", &icons::PLUS),
        "edit" => ("Rewrote", &icons::PENCIL),
        "patch" => ("Edited", &icons::PENCIL),
        "archive" => ("Archived", &icons::ARCHIVE),
        "restore" => ("Restored", &icons::UNARCHIVE),
        "revert" => ("Reverted", &icons::REFRESH),
        other => return (format!("{other} {target}"), &icons::LIST, reason, "changed".into()),
    };
    (format!("{verb} {target}"), glyph, reason, verb.to_lowercase())
}

/// "2 noted · 1 merged · 1 rewrote", in the order each first happened.
pub fn tally(rows: &[Value]) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for r in rows {
        let word = describe(r).3;
        match counts.iter_mut().find(|(w, _)| *w == word) {
            Some((_, n)) => *n += 1,
            None => counts.push((word, 1)),
        }
    }
    counts.iter().map(|(w, n)| format!("{n} {w}")).collect::<Vec<_>>().join(" · ")
}


// The list.

/// One entry in the list, and what selecting it shows.
pub enum Item<'a> {
    Task(Task<'a>),
    /// A routine still to come today, at its next run.
    Next(&'a Value, f64),
    Routine(&'a Value),
    Change(&'a Value),
}

impl Item<'_> {
    pub fn pick(&self) -> Pick {
        match self {
            Item::Task(t) => Pick::Task(t.id().to_string()),
            Item::Next(a, _) | Item::Routine(a) => Pick::Routine(Some(str_at(a, "id").to_string())),
            Item::Change(r) => Pick::Change(r.get("id").and_then(Value::as_i64).unwrap_or_default()),
        }
    }
    fn title(&self) -> String {
        match self {
            Item::Task(t) => t.title(),
            Item::Next(a, _) | Item::Routine(a) => plain(str_at(a, "title")),
            Item::Change(r) => describe(r).0,
        }
    }
}

fn filter_of(s: &State) -> String {
    s.typed("activity:filter").trim().to_lowercase()
}

/// The view's sections, in order, as the filter leaves them.
pub fn sections(s: &State, now: f64) -> Vec<(String, Vec<Item<'_>>)> {
    let all = tasks(s);
    let mut out: Vec<(String, Vec<Item>)> = Vec::new();
    match s.activity.view {
        View::Today => {
            let live: Vec<Item> = all.iter().filter(|t| t.live()).map(|t| Item::Task(*t)).collect();
            let done: Vec<Item> = all.iter().filter(|t| !t.live() && same_day(t.updated(), now)).map(|t| Item::Task(*t)).collect();
            let mut next: Vec<Item> = routines::list(s)
                .iter()
                .filter(|a| str_at(a, "status") == "active")
                .filter_map(|a| a.get("next_run").and_then(Value::as_f64).filter(|w| same_day(*w, now)).map(|w| Item::Next(a, w)))
                .collect();
            next.sort_by(|a, b| match (a, b) {
                (Item::Next(_, x), Item::Next(_, y)) => x.total_cmp(y),
                _ => std::cmp::Ordering::Equal,
            });
            out.push((format!("Running · {}", live.len()), live));
            out.push(("Coming up".into(), next));
            out.push(("Finished today".into(), done));
        }
        View::Routines => {
            let mut live: Vec<&Value> = routines::list(s).iter().filter(|a| str_at(a, "status") != "archived").collect();
            live.sort_by(|a, b| {
                let at = |a: &Value| a.get("next_run").and_then(Value::as_f64).unwrap_or(f64::MAX);
                at(a).total_cmp(&at(b))
            });
            let archived: Vec<Item> = routines::list(s).iter().filter(|a| str_at(a, "status") == "archived").map(Item::Routine).collect();
            out.push((format!("Routines · {}", live.len()), live.into_iter().map(Item::Routine).collect()));
            out.push((format!("Archived · {}", archived.len()), archived));
        }
        View::Dreams => {
            if let Some(rows) = s.views.get("dream-ledger").and_then(Value::as_array).filter(|r| !r.is_empty()) {
                let when = time::day(rows.last().map_or(now, |r| num_at(r, "at")), now);
                let heading = if when == "Today" || when == "Yesterday" { "Last night".to_string() } else { format!("Last dream · {when}") };
                out.push((format!("{heading} · {}", tally(rows)), rows.iter().map(Item::Change).collect()));
            }
        }
        View::History => {
            for t in all.iter().filter(|t| !t.live() && !same_day(t.updated(), now)) {
                let label = time::day(t.updated(), now);
                match out.iter_mut().find(|(l, _)| *l == label) {
                    Some((_, list)) => list.push(Item::Task(*t)),
                    None => out.push((label, vec![Item::Task(*t)])),
                }
            }
            out.truncate(s.activity.days.max(RECENT_DAYS));
        }
    }
    let needle = filter_of(s);
    if !needle.is_empty() {
        for (_, items) in &mut out {
            items.retain(|i| i.title().to_lowercase().contains(&needle));
        }
    }
    out
}

/// What the pane shows: the pick, or the list's first.
pub fn selected(s: &State) -> Option<Pick> {
    s.activity.pick.clone().or_else(|| sections(s, time::now_ms()).into_iter().flat_map(|(_, i)| i).next().map(|i| i.pick()))
}

// The page.

pub fn page(s: &State, k: &Kit, p: &Palette, layer: &mut Vec<El>) -> El {
    let now = time::now_ms();
    let pick = selected(s);
    let list = list_pane(s, &pick, now, k, p, layer);
    let detail = detail_pane(s, &pick, now, k, p);
    col()
        .key("activity")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(toolbar(s, p))
        .child(row().w_full().grow(1.0).min_h(0.0).child(list).child(detail))
        .child(footer(s, p))
}

fn toolbar(s: &State, p: &Palette) -> El {
    let current = VIEWS.iter().find(|(v, ..)| *v == s.activity.view).map_or("today", |(_, id, _)| *id);
    let options: Vec<(&'static str, &'static str)> = VIEWS.iter().map(|(_, id, label)| (*id, *label)).collect();
    let switch = segmented("activity-view", &options, current, p, |s, id| {
        if let Some((v, ..)) = VIEWS.iter().find(|(_, i, _)| *i == id) {
            s.show_view(*v);
        }
    });
    let mut bar = row()
        .key("activity-toolbar")
        .w_full()
        .h(52.0)
        .px(16.0)
        .gap(10.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .child(switch)
        .child(el().grow(1.0));
    match s.activity.view {
        View::Today => {
            let live = tasks(s).iter().filter(|t| t.live()).count();
            if live > 0 {
                let b = button("stop-all", &format!("Stop all {live}"), "", p);
                bar = bar.child(if s.online() { b.help("Stop every running task (⇧⌘.)").on_press(|s: &mut State| s.stop_all()) } else { off(b).help(OFFLINE_TITLE) });
            }
        }
        View::Routines => {
            let on = s.check_ins;
            let check_ins = segmented("check-ins", &[("on", "On"), ("off", "Off")], if on { "on" } else { "off" }, p, |s, v| {
                s.check_ins = v == "on";
                s.tell("set-check-ins", json!({ "on": v == "on" }));
            });
            bar = bar
                .child(
                    row()
                        .gap(6.0)
                        .center_y()
                        .help("ky looks again on the day at things you asked about with a date ahead, and tells you only what's new")
                        .child(text("Check-ins").font(META).color(p.muted))
                        .child(check_ins),
                )
                .child(button("routine-new", "New routine", "primary", p).on_press(|s: &mut State| s.pick(Pick::Routine(None))));
        }
        _ => {}
    }
    bar.child(row().w(200.0).child(field(s, "activity:filter", "Filter", p)))
}

fn footer(s: &State, p: &Palette) -> El {
    let hint = match s.activity.view {
        View::Today | View::History => "↑↓ select · ⌘. stop · ⇧⌘. stop all · ⌘O open chat · ⌘R run again · right-click for more · ⌥⌘1–4 views",
        View::Routines => "↑↓ select · ⌘R run now · ⌥⌘1–4 views",
        View::Dreams => "↑↓ select · ⌥⌘1–4 views",
    };
    row()
        .key("activity-footer")
        .w_full()
        .h(28.0)
        .px(16.0)
        .center_y()
        .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
        .child(text(hint).font(SMALL).color(p.quiet).max_lines(1))
}

fn list_pane(s: &State, pick: &Option<Pick>, now: f64, k: &Kit, p: &Palette, layer: &mut Vec<El>) -> El {
    let secs = sections(s, now);
    let mut list = col().w_full().px(8.0).pt(4.0).pb(16.0).gap(1.0);
    let filtered = !filter_of(s).is_empty();
    let nothing = secs.iter().all(|(_, i)| i.is_empty());
    for (label, items) in &secs {
        // An empty section only says so on Today, where "nothing running" is news.
        if items.is_empty() && (s.activity.view != View::Today || filtered) {
            continue;
        }
        list = list.child(text(label.clone()).font(HEAD).color(p.quiet).px(10.0).pt(14.0).pb(4.0).max_lines(1));
        if items.is_empty() {
            list = list.child(text(if label.starts_with("Running") { "Nothing running" } else { "Nothing yet" }).font(META).color(p.quiet).px(10.0).py(6.0));
        }
        for item in items {
            let on = pick.as_ref() == Some(&item.pick());
            list = list.child(list_row(s, item, on, now, k, p, layer));
        }
    }
    if nothing && (filtered || s.activity.view != View::Today) {
        let words = if filtered {
            "Nothing matches."
        } else {
            match s.activity.view {
                View::Routines => "No routines yet.",
                View::Dreams => "No dream has changed anything yet.",
                _ => "Nothing earlier.",
            }
        };
        list = list.child(text(words).font(META).color(p.quiet).px(10.0).py(18.0));
    }
    if s.activity.view == View::History && !filtered {
        let days = tasks(s).iter().filter(|t| !t.live() && !same_day(t.updated(), now)).map(|t| time::day(t.updated(), now)).collect::<std::collections::BTreeSet<_>>().len();
        let hidden = days.saturating_sub(s.activity.days.max(RECENT_DAYS));
        if hidden > 0 {
            list = list.child(
                row()
                    .key("days-more")
                    .role("button")
                    .label("Show earlier")
                    .h(34.0)
                    .px(10.0)
                    .gap(8.0)
                    .center_y()
                    .radius(8.0)
                    .hover(p.hover)
                    .child(text("Show earlier").font(META_STRONG).color(p.ink))
                    .child(text(format!("{hidden} more {}", if hidden == 1 { "day" } else { "days" })).font(META).color(p.quiet))
                    .on_press(|s: &mut State| s.activity.days = s.activity.days.max(RECENT_DAYS) + RECENT_DAYS),
            );
        }
    }
    col()
        .key(&format!("activity-list:{:?}", s.activity.view))
        .w(LIST_W)
        .h_full()
        .fill(p.sidebar)
        .border_sides([0.0, 1.0, 0.0, 0.0], p.line)
        .scroll(ScrollSpec { stick_bottom: false })
        .child(list)
}

/// The colour a run's dot takes.
pub fn tone_of(status: &str, p: &Palette) -> rune::Color {
    match status {
        "done" => p.success,
        "failed" => p.danger,
        "stopped" => p.quiet,
        "working" | "queued" => p.accent,
        _ => p.line_strong,
    }
}

fn ring(tone: rune::Color) -> El {
    el().size(8.0, 8.0).radius(4.0).border(1.5, tone)
}

/// A list row: its glyph, title and the line under it, and a time at the end.
fn list_row(s: &State, item: &Item, on: bool, now: f64, k: &Kit, p: &Palette, layer: &mut Vec<El>) -> El {
    let title = item.title();
    let (lead, sub, sub_tone, end): (El, String, rune::Color, String) = match item {
        Item::Task(t) => {
            let lead = match t.status() {
                "working" => Spinner::new().size(12.0).build(k),
                "queued" => ring(p.accent),
                st => crate::settings::dot(tone_of(st, p)),
            };
            let (sub, tone) = match (t.quiet(&s.machines, now), t.current_step()) {
                (Some(q), _) => (q, p.warning),
                (None, Some(step)) => (step, p.muted),
                (None, None) => {
                    let mut parts = Vec::new();
                    match t.status() {
                        "failed" => parts.push("Failed".to_string()),
                        "stopped" => parts.push("Stopped".to_string()),
                        "queued" => parts.push("Queued".to_string()),
                        _ => {}
                    }
                    if !t.worker().starts_with("automation-") {
                        parts.push(t.worker().to_string());
                    }
                    (parts.join(" · "), if t.status() == "failed" { p.danger } else { p.quiet })
                }
            };
            let end = if t.live() { t.elapsed(now).unwrap_or_default() } else { clock_at(t.updated()) };
            (lead, sub, tone, end)
        }
        Item::Next(a, at) => {
            let often = routines::often_of(a.get("cron").and_then(Value::as_str));
            (ring(p.line_strong), often, p.quiet, clock_at(*at))
        }
        Item::Routine(a) => {
            let glyph = if str_at(a, "status") == "paused" { &icons::PAUSE } else { &icons::CLOCK };
            let tone = match a.get("last_run").filter(|r| !r.is_null()).map(|r| str_at(r, "status")) {
                Some("failed") => p.danger,
                Some("queued" | "working") => p.accent,
                _ => p.muted,
            };
            (icon(glyph, 14.0).color(tone), routines::meta_of(a, now), p.quiet, String::new())
        }
        Item::Change(r) => {
            let (_, glyph, sub, _) = describe(r);
            let undone = r.get("undone_at").is_some_and(|u| !u.is_null());
            (icon(glyph, 14.0).color(p.muted), sub.unwrap_or_default(), p.quiet, if undone { "Undone".into() } else { String::new() })
        }
    };
    let dim = matches!(item, Item::Next(..));
    let mut words = col().grow(1.0).shrink().min_w(0.0).gap(1.0).child(text(title.clone()).font(ROW_STRONG).color(if dim { p.muted } else { p.ink }).max_lines(1));
    if !sub.is_empty() {
        words = words.child(text(sub).font(META).color(sub_tone).max_lines(1));
    }
    let pick = item.pick();
    let key = match &pick {
        Pick::Task(id) => format!("task:{id}"),
        Pick::Routine(id) => format!("routine:{}:{}", if dim { "next" } else { "all" }, id.as_deref().unwrap_or("new")),
        Pick::Change(id) => format!("change:{id}"),
    };
    let mut r = row()
        .key(&key)
        .role("button")
        .label(&title)
        .w_full()
        .min_h(48.0)
        .px(10.0)
        .py(7.0)
        .gap(10.0)
        .center_y()
        .radius(8.0)
        .child(row().w(16.0).justify_center().child(lead))
        .child(words);
    if !end.is_empty() {
        r = r.child(text(end).font(SMALL).color(p.quiet));
    }
    r = if on { r.fill(p.selected) } else { r.hover(p.hover) };
    let chosen = pick.clone();
    r = r.on_press(move |s: &mut State| s.pick(chosen.clone()));
    let Item::Task(t) = item else { return r };
    let id = t.id().to_string();
    let menu_id = id.clone();
    r = r.on_secondary_press(move |s: &mut State, at, _| {
        s.pick(Pick::Task(menu_id.clone()));
        s.activity.menu = Some((menu_id.clone(), at));
    });
    let point = s.activity.menu.as_ref().filter(|(m, _)| *m == id).map(|(_, at)| *at);
    if point.is_none() {
        return r;
    }
    let mut menu = context_menu(format!("task-menu:{id}"), r, point).on_close(|s: &mut State| s.activity.menu = None);
    if t.live() {
        let i = id.clone();
        menu = menu.item(MenuItem::new(if t.status() == "queued" { "Cancel" } else { "Stop" }).icon(&icons::STOP).shortcut("⌘.").disabled(!s.online()).on_select(move |s: &mut State| {
            s.activity.menu = None;
            s.stop_task(&i);
        }));
    }
    if let Some(session) = t.session() {
        let session = session.to_string();
        menu = menu.item(MenuItem::new("Open chat").icon(&icons::CHAT).shortcut("⌘O").on_select(move |s: &mut State| {
            s.activity.menu = None;
            s.open_chat(&session);
        }));
    }
    if let Some(routine) = t.routine() {
        let routine = routine.to_string();
        menu = menu.item(MenuItem::new("Run again").icon(&icons::PLAY).shortcut("⌘R").disabled(!s.online() || t.live()).on_select(move |s: &mut State| {
            s.activity.menu = None;
            s.routine_action(&routine, "run");
        }));
    }
    let summary = str_at(t.0, "summary").to_string();
    let log = step_log(s, *t);
    menu = menu
        .separator()
        .item(MenuItem::new("Copy summary").icon(&icons::FILE).disabled(summary.is_empty()).on_select(move |s: &mut State| {
            s.activity.menu = None;
            crate::settings::actions::copy(&summary);
        }))
        .item(MenuItem::new("Copy step log").icon(&icons::LIST).disabled(log.is_empty()).on_select(move |s: &mut State| {
            s.activity.menu = None;
            crate::settings::actions::copy(&log);
        }));
    menu.build(k, layer)
}

/// A task's steps, a line each: ✓ done, ✗ failed, … running, and notes indented.
fn step_log(s: &State, t: Task) -> String {
    entries(s, t).iter().map(|(words, state, _)| {
        let mark = match *state {
            "note" => "   ",
            "running" => "…  ",
            "failed" => "✗  ",
            "stopped" => "○  ",
            _ => "✓  ",
        };
        format!("{mark}{}", plain(words))
    }).collect::<Vec<_>>().join("\n")
}

// The detail pane.

fn detail_pane(s: &State, pick: &Option<Pick>, now: f64, k: &Kit, p: &Palette) -> El {
    let (key, body) = match pick {
        Some(Pick::Task(id)) => match tasks(s).into_iter().find(|t| t.id() == id) {
            Some(t) => (format!("detail:task:{id}"), task_detail(s, t, now, k, p)),
            None => ("detail:none".into(), placeholder("This task is gone.", p)),
        },
        Some(Pick::Routine(id)) => (format!("detail:routine:{}", id.as_deref().unwrap_or("new")), routines::form(s, id.as_deref(), p)),
        Some(Pick::Change(id)) => match dream_rows(s).iter().find(|r| r.get("id").and_then(Value::as_i64) == Some(*id)) {
            Some(r) => (format!("detail:change:{id}"), change_detail(s, r, p)),
            None => ("detail:none".into(), placeholder("This change is gone.", p)),
        },
        None => ("detail:none".into(), placeholder(match s.activity.view {
            View::Today => "Nothing ran today. Tasks and routine runs show here as they go.",
            View::Routines => "No routines yet. New routine makes one.",
            View::Dreams => "Each night ky dreams over the day's chats. What it changes shows here, with Undo.",
            View::History => "Nothing earlier.",
        }, p)),
    };
    col()
        .key(&key)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h_full()
        .scroll(ScrollSpec { stick_bottom: false })
        .child(row().w_full().justify_center().px(32.0).pt(24.0).pb(40.0).child(col().w_full().max_w(720.0).gap(18.0).child(body)))
}

fn placeholder(words: &str, p: &Palette) -> El {
    row().w_full().pt(120.0).justify_center().child(text(words.to_string()).font(ROW).color(p.quiet).wrap().max_w(380.0))
}

fn dream_rows(s: &State) -> &[Value] {
    s.views.get("dream-ledger").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// The steps as shown: the asked log, else the row's own; each with its words, state and key.
fn entries<'a>(s: &'a State, t: Task<'a>) -> Vec<(String, &'static str, String)> {
    match s.activity.steps.get(t.id()).filter(|l| !l.is_empty()) {
        Some(log) => log
            .iter()
            .map(|st| {
                let state = if st.get("call").is_none_or(Value::is_null) {
                    "note"
                } else {
                    match str_at(st, "state") {
                        "running" if t.live() => "running",
                        "running" => "stopped",
                        "failed" => "failed",
                        _ => "done",
                    }
                };
                (str_at(st, "text").to_string(), state, format!("{}", num_at(st, "seq")))
            })
            .collect(),
        None => {
            let steps = t.steps();
            steps
                .iter()
                .enumerate()
                .map(|(i, st)| (str_at(st, "text").to_string(), if t.live() && i + 1 == steps.len() { "running" } else { "done" }, format!("row:{i}")))
                .collect()
        }
    }
}

/// A task: its title and how it stands, what can be done to it, each step with its glyph and the
/// agent's words between, then what it reported.
fn task_detail(s: &State, t: Task, now: f64, k: &Kit, p: &Palette) -> El {
    let status = match t.status() {
        "queued" => "Queued",
        "working" => "Working",
        "done" => "Done",
        "failed" => "Failed",
        "stopped" => "Stopped",
        other => other,
    };
    let mut sub = vec![t.worker().to_string(), status.to_string()];
    sub.extend(t.spend(now));
    if !t.live() {
        sub.push(format!("{} {}", date_of(t.updated()), clock_at(t.updated())));
    }
    let mut tools = row().gap(8.0).center_y().flex_wrap();
    if t.live() {
        let id = t.id().to_string();
        let b = button("detail-stop", if t.status() == "queued" { "Cancel" } else { "Stop" }, "danger", p);
        tools = tools.child(if s.online() { b.help("⌘.").on_press(move |s: &mut State| s.stop_task(&id)) } else { off(b).help(OFFLINE_TITLE) });
    }
    if let Some(session) = t.session() {
        let session = session.to_string();
        tools = tools.child(button("open-chat", "Open chat", "", p).help("⌘O").on_press(move |s: &mut State| s.open_chat(&session)));
    }
    if let Some(routine) = t.routine() {
        let routine = routine.to_string();
        let b = button("run-again", "Run again", "", p);
        tools = tools.child(if s.online() && !t.live() { b.help("⌘R").on_press(move |s: &mut State| s.routine_action(&routine, "run")) } else { off(b) });
        let r2 = t.routine().unwrap_or_default().to_string();
        tools = tools.child(button("open-routine", "Routine", "", p).on_press(move |s: &mut State| {
            s.show_view(View::Routines);
            s.pick(Pick::Routine(Some(r2.clone())));
        }));
    }
    let summary = str_at(t.0, "summary").to_string();
    if !summary.is_empty() {
        let copied = summary.clone();
        tools = tools.child(button("copy-summary", "Copy summary", "", p).on_press(move |_: &mut State| crate::settings::actions::copy(&copied)));
    }
    let header = col()
        .w_full()
        .gap(10.0)
        .pb(14.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .child(
            row()
                .w_full()
                .gap(10.0)
                .center_y()
                .child(crate::settings::dot(tone_of(t.status(), p)))
                .child(text(t.title()).font(crate::settings::TITLE).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0)),
        )
        .child(text(sub.join(" · ")).font(META).color(p.quiet).wrap())
        .child(tools);

    let mut body = col().w_full().gap(10.0);
    let list = entries(s, t);
    if list.is_empty() && !t.live() {
        body = body.child(text("No steps recorded").font(META).color(p.quiet));
    } else if list.is_empty() && t.status() == "queued" {
        body = body.child(text("Waiting to start").font(META).color(p.quiet));
    }
    for (words, state, key) in &list {
        if *state == "note" {
            body = body.child(text(plain(words)).key(&format!("note:{key}")).font(ROW).color(p.muted).wrap().pl(30.0));
            continue;
        }
        let glyph: El = match *state {
            "running" => Spinner::new().size(14.0).build(k),
            "failed" => icon(&icons::ALERT, 16.0).color(p.danger),
            "stopped" => icon(&icons::CIRCLE, 16.0).color(p.quiet),
            _ => icon(&icons::CHECK_CIRCLE, 16.0).color(p.success),
        };
        body = body.child(
            row()
                .key(&format!("step:{key}"))
                .w_full()
                .gap(12.0)
                .child(row().w(18.0).pt(1.0).child(glyph))
                .child(text(words.replace('`', "")).font(ROW).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0)),
        );
    }
    let newest_running = list.last().is_some_and(|(_, st, _)| *st == "running");
    if t.live() && !newest_running {
        body = body.child(row().gap(12.0).center_y().child(Spinner::new().size(14.0).build(k)).child(text("Thinking").font(ROW).color(p.quiet)));
    }
    if !t.live() && !summary.is_empty() {
        let markdown = if s.dark.get() { &s.markdown_dark } else { &s.markdown_light };
        let edge = if t.status() == "failed" { p.danger } else { p.line };
        body = body.child(
            col()
                .key("task-result")
                .w_full()
                .mt(8.0)
                .px(16.0)
                .py(12.0)
                .radius(10.0)
                .fill(p.sunken)
                .border(1.0, edge)
                .child(Markdown::new(summary).selectable(true).render(markdown)),
        );
    }
    if let Some(why) = problem(s, "task-steps", p) {
        body = body.child(why);
    }
    col().w_full().gap(16.0).child(header).child(body)
}

/// A dream's change: what it did, why, and Undo.
fn change_detail(s: &State, r: &Value, p: &Palette) -> El {
    let (title, glyph, sub, _) = describe(r);
    let id = r.get("id").and_then(Value::as_i64).unwrap_or_default();
    let undone = r.get("undone_at").is_some_and(|u| !u.is_null());
    let at = num_at(r, "at");
    let mut head = col()
        .w_full()
        .gap(8.0)
        .pb(14.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .child(row().gap(10.0).center_y().child(icon(glyph, 18.0).color(p.muted)).child(text(title.clone()).font(crate::settings::TITLE).color(if undone { p.quiet } else { p.ink }).wrap()));
    if at > 0.0 {
        head = head.child(text(format!("{} · {} {}", str_at(r, "kind"), date_of(at), clock_at(at))).font(META).color(p.quiet));
    }
    let end = if undone {
        text("Undone").font(META_STRONG).color(p.quiet)
    } else {
        let b = button(&format!("undo:{id}"), "Undo", "", p).label(&format!("Undo: {title}"));
        if s.activity.undoing == Some(id) { off(b) } else { b.on_press(move |s: &mut State| s.undo_dream(id)) }
    };
    head = head.child(row().child(end));
    let mut body = col().w_full().gap(10.0);
    if let Some(sub) = sub {
        body = body.child(text(sub).font(ROW).color(p.ink).wrap());
    }
    if let Some(why) = r.get("reason").and_then(Value::as_str).filter(|w| !w.is_empty()) {
        body = body.child(text(format!("Why: {why}")).font(META).color(p.muted).wrap());
    }
    if let Some(why) = s.activity.refusals.get(&id) {
        body = body.child(text(why.clone()).font(META).color(p.danger).wrap());
    }
    col().w_full().gap(16.0).child(head).child(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_and_words_read_as_the_web_writes_them() {
        assert_eq!(duration(34_000.0), "34s");
        assert_eq!(duration(65_000.0), "1m 5s");
        assert_eq!(duration(7_380_000.0), "2h 3m");
        assert_eq!(clock_of(9, 0), "9:00 AM");
        assert_eq!(clock_of(0, 5), "12:05 AM");
        assert_eq!(clock_of(14, 30), "2:30 PM");
        assert_eq!(plain("**Fix** the [deploy](https://x) `pin`"), "Fix the deploy pin");
    }

    #[test]
    fn a_night_tallies_by_kind_in_order() {
        let rows = vec![
            json!({ "kind": "memory", "action": "note", "target": "", "before": "x" }),
            json!({ "kind": "skill", "action": "edit", "target": "deploy" }),
            json!({ "kind": "memory", "action": "note", "target": "" }),
            json!({ "kind": "skill", "action": "edit", "target": "a", "absorbed_into": "b" }),
        ];
        assert_eq!(tally(&rows), "2 noted · 1 rewrote · 1 merged");
    }
}
