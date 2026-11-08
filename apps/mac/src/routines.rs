//! Routines: every one, as the web's `Automations.tsx` lists them, and one's form. A row says
//! when it runs and when next; the form names it, says what each run does, when, where it runs and
//! which chat hears back, and offers Run, Pause, Archive and Delete.

use rune::{El, col, row, text};
use serde_json::{Value, json};

use crate::activity::{MONTHS, Pick, WEEK, clock_at, clock_of, plain, wall};
use crate::settings::{Then, button, card, field, num_at, off, problem, section, str_at};
use crate::theme::{META, META_STRONG, Palette};
use crate::{State, time};

/// Every routine, as the last `automations` frame brought them.
pub fn list(s: &State) -> &[Value] {
    s.automations.as_array().map_or(&[], Vec::as_slice)
}

fn find<'a>(s: &'a State, id: &str) -> Option<&'a Value> {
    list(s).iter().find(|a| str_at(a, "id") == id)
}

// Words for a schedule (`src/automations/cron-words.ts`).

const DAY_NAMES: [&str; 7] = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

fn num(field: &str) -> Option<u32> {
    field.parse().ok()
}

/// A cron's days field as the days it names, Sunday 0; `*` is every day.
fn days_of(field: &str) -> Option<Vec<u32>> {
    if field == "*" {
        return Some((0..7).collect());
    }
    let mut days = Vec::new();
    for part in field.split(',') {
        match part.split_once('-') {
            Some((a, b)) => days.extend(num(a)?..=num(b)?),
            None => days.push(num(part)?),
        }
    }
    let mut days: Vec<u32> = days.into_iter().map(|d| d % 7).collect();
    days.sort_unstable();
    days.dedup();
    Some(days)
}

fn days_words(days: &[u32]) -> String {
    match days {
        [0, 1, 2, 3, 4, 5, 6] => "Daily".into(),
        [1, 2, 3, 4, 5] => "Weekdays".into(),
        [0, 6] => "Weekends".into(),
        [d] => DAY_NAMES[*d as usize].into(),
        ds => ds.iter().map(|d| WEEK[*d as usize]).collect::<Vec<_>>().join(", "),
    }
}

/// "Every 15 min", "Hourly at :30", "Every 3 hours", "Weekdays · 9:00 AM", or the cron itself.
pub fn cron_words(cron: &str) -> String {
    let f: Vec<&str> = cron.split_whitespace().collect();
    let [minute, hour, dom, month, dow] = f[..] else { return cron.to_string() };
    if dom != "*" || month != "*" {
        return cron.to_string();
    }
    if let Some(n) = minute.strip_prefix("*/").and_then(num) {
        if hour == "*" && dow == "*" {
            return if n == 1 { "Every minute".into() } else { format!("Every {n} min") };
        }
    }
    if minute == "*" && hour == "*" && dow == "*" {
        return "Every minute".into();
    }
    let Some(m) = num(minute) else { return cron.to_string() };
    if hour == "*" {
        let Some(days) = days_of(dow) else { return cron.to_string() };
        let at = if m == 0 { String::new() } else { format!(" at :{m:02}") };
        let days = match days_words(&days).as_str() {
            "Daily" => String::new(),
            "Weekdays" => ", weekdays".into(),
            d => format!(", {d}"),
        };
        return format!("Hourly{at}{days}");
    }
    if let Some((_, step)) = hour.split_once('/') {
        if let Some(n) = num(step) {
            if dow == "*" {
                return format!("Every {n} hours");
            }
        }
        return cron.to_string();
    }
    let (Some(h), Some(days)) = (num(hour), days_of(dow)) else { return cron.to_string() };
    format!("{} · {}", days_words(&days), clock_of(h, m))
}

/// How often, for the timeline's note: the words before the clock, or none for a daily one.
pub fn often_of(cron: Option<&str>) -> String {
    let Some(cron) = cron else { return String::new() };
    let words = cron_words(cron);
    match words.split_once(" · ") {
        Some(("Daily", _)) => String::new(),
        Some((days, _)) => days.to_string(),
        None => words,
    }
}

/// "Nov 7, 9:00 AM".
fn when_words(ms: f64) -> String {
    let w = wall(ms);
    format!("{} {}, {}", MONTHS[w.month as usize], w.mday, clock_at(ms))
}

fn schedule_of(a: &Value) -> String {
    match a.get("cron").and_then(Value::as_str) {
        Some(cron) => cron_words(cron),
        None => match a.get("at").and_then(Value::as_f64) {
            Some(at) => format!("Once · {}", when_words(at)),
            None => "Once".into(),
        },
    }
}

fn next_of(a: &Value, now: f64) -> String {
    if str_at(a, "status") == "paused" {
        return "Paused".into();
    }
    let Some(next) = a.get("next_run").and_then(Value::as_f64) else { return "Not booked".into() };
    // How long until: `ago` reads backwards, so turn it around.
    match time::ago(now, next) {
        w if w == "now" => "due now".into(),
        w => format!("in {w}"),
    }
}

pub fn meta_of(a: &Value, now: f64) -> String {
    let mut parts = vec![schedule_of(a), next_of(a, now)];
    match str_at(a, "created_by") {
        "ky" => parts.push("by ky".into()),
        "dream" => parts.push("check-in".into()),
        _ => {}
    }
    parts.join(" · ")
}

fn last_run_words(a: &Value, now: f64) -> String {
    let Some(run) = a.get("last_run").filter(|r| !r.is_null()) else { return "Hasn't run yet".into() };
    match str_at(run, "status") {
        "queued" | "working" => "Running".into(),
        status => {
            let at = run.get("finished_at").and_then(Value::as_f64).unwrap_or_else(|| num_at(run, "updated_at"));
            let ago = time::ago(at, now);
            let ago = if ago == "now" { "just now".to_string() } else { format!("{ago} ago") };
            if status == "failed" { format!("Failed {ago}") } else { format!("Ran {ago}") }
        }
    }
}

// The list.


// The form.

const CHIPS: [(&str, &str); 6] = [("once", "Once"), ("hourly", "Hourly"), ("hours", "Every few hours"), ("daily", "Daily"), ("weekly", "Weekly"), ("cron", "Cron")];
const HOUR_STEPS: [u32; 6] = [2, 3, 4, 6, 8, 12];

/// The rhythm a cron reads as, for the form's chips: the chip, its minute, hour, step and days.
pub fn rhythm_of(cron: &str) -> (&'static str, u32, u32, u32, Vec<u32>) {
    let f: Vec<&str> = cron.split_whitespace().collect();
    let custom = ("cron", 0, 9, 3, vec![1, 2, 3, 4, 5]);
    let [minute, hour, "*", "*", dow] = f[..] else { return custom };
    if let Some(n) = minute.strip_prefix("*/").and_then(num) {
        return if hour == "*" && dow == "*" { ("minutes", 0, 0, n, vec![]) } else { custom };
    }
    let Some(m) = num(minute) else { return custom };
    let Some(days) = days_of(dow) else { return custom };
    if hour == "*" {
        return ("hourly", m, 0, 0, days);
    }
    if let Some((start, step)) = hour.split_once('/') {
        let start = match start {
            "*" => Some(0),
            s => s.strip_suffix("-23").and_then(num),
        };
        return match (start, num(step)) {
            (Some(h), Some(n)) if HOUR_STEPS.contains(&n) && dow == "*" => ("hours", m, h, n, days),
            _ => custom,
        };
    }
    let Some(h) = num(hour) else { return custom };
    let chip = if days.len() == 7 { "daily" } else { "weekly" };
    (chip, m, h, 3, days)
}

/// The cron a chip and its settings make.
pub fn cron_of(chip: &str, minute: u32, hour: u32, every: u32, days: &[u32]) -> Option<String> {
    let days_field = || match days {
        [] => None,
        [0, 1, 2, 3, 4, 5, 6] => Some("*".to_string()),
        [1, 2, 3, 4, 5] => Some("1-5".to_string()),
        ds => Some(ds.iter().map(u32::to_string).collect::<Vec<_>>().join(",")),
    };
    match chip {
        "hourly" => Some(format!("{minute} * * * {}", days_field()?)),
        "hours" if hour == 0 => Some(format!("{minute} */{every} * * *")),
        "hours" => Some(format!("{minute} {hour}-23/{every} * * *")),
        "daily" => Some(format!("{minute} {hour} * * *")),
        "weekly" => Some(format!("{minute} {hour} * * {}", days_field()?)),
        _ => None,
    }
}

/// "09:00" as hour and minute.
fn clock_typed(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m) = (num(h)?, num(m)?);
    (h < 24 && m < 60).then_some((h, m))
}

/// "2026-11-07 09:00", local time, as Unix milliseconds.
pub fn at_typed(s: &str) -> Option<f64> {
    let (date, clock) = s.trim().split_once(' ')?;
    let mut d = date.split('-');
    let (y, mo, da): (i32, i32, i32) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let (h, mi) = clock_typed(clock)?;
    // SAFETY: mktime reads and normalises the `tm` we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = y - 1900;
    tm.tm_mon = mo - 1;
    tm.tm_mday = da;
    tm.tm_hour = h as i32;
    tm.tm_min = mi as i32;
    tm.tm_isdst = -1;
    let secs = unsafe { libc::mktime(&mut tm) };
    (secs > 0).then(|| secs as f64 * 1000.0)
}

fn at_words(ms: f64) -> String {
    let w = wall(ms);
    format!("{}-{:02}-{:02} {:02}:{:02}", w.year, w.month + 1, w.mday, w.hour, w.minute)
}

impl State {
    /// Open a routine's form, or a new one, filled from the row.
    pub fn open_routine(&mut self, id: Option<&str>) {
        self.fields.retain(|k, _| !k.starts_with("routine:"));
        self.ticks.retain(|k| !k.starts_with("routine:"));
        self.picks.retain(|k, _| !k.starts_with("routine-"));
        self.problems.remove("routine");
        self.confirm = None;
        let row = id.and_then(|id| find(self, id)).cloned();
        let (title, prompt, cron, at, gate, machine, chat) = match &row {
            Some(a) => (
                str_at(a, "title").to_string(),
                str_at(a, "prompt").to_string(),
                a.get("cron").and_then(Value::as_str).map(str::to_string),
                a.get("at").and_then(Value::as_f64),
                str_at(a, "gate").to_string(),
                str_at(a, "machine").to_string(),
                str_at(a, "chat").to_string(),
            ),
            None => (String::new(), String::new(), Some("0 9 * * 1-5".into()), None, String::new(), String::new(), "main".into()),
        };
        let (mut chip, minute, hour, every, days) = cron.as_deref().map_or(("once", 0, 9, 3, vec![1, 2, 3, 4, 5]), rhythm_of);
        if chip == "minutes" {
            chip = "cron";
        }
        let next_hour = ((time::now_ms() / 3_600_000.0).floor() + 1.0) * 3_600_000.0;
        self.set_field("routine:title", &title);
        self.set_field("routine:prompt", &prompt);
        self.set_field("routine:cron", cron.as_deref().unwrap_or("0 9 * * 1-5"));
        self.set_field("routine:at", &at_words(at.unwrap_or(next_hour)));
        self.set_field("routine:clock", &format!("{hour:02}:{minute:02}"));
        self.set_field("routine:minute", &format!("{minute:02}"));
        self.set_field("routine:gate", &gate);
        self.picks.insert("routine-chip", chip.to_string());
        self.picks.insert("routine-every", every.to_string());
        self.picks.insert("routine-start", hour.to_string());
        self.picks.insert("routine-machine", machine);
        self.picks.insert("routine-chat", chat);
        for d in days {
            self.ticks.insert(format!("routine:day:{d}"));
        }
        self.activity.pick = Some(Pick::Routine(id.map(str::to_string)));
    }

    fn routine_days(&self) -> Vec<u32> {
        (0..7).filter(|d| self.ticks.contains(&format!("routine:day:{d}"))).collect()
    }

    /// The timing the form says: a cron, or a moment for a one-off; none while it's incomplete.
    fn routine_timing(&self) -> Option<(Option<String>, Option<f64>)> {
        let chip = self.picks.get("routine-chip").map_or("weekly", String::as_str);
        match chip {
            "once" => at_typed(&self.typed("routine:at")).map(|at| (None, Some(at))),
            "cron" => Some(self.typed("routine:cron")).filter(|c| !c.is_empty()).map(|c| (Some(c), None)),
            _ => {
                let (hour, minute) = match chip {
                    "hourly" | "hours" => (0, num(&self.typed("routine:minute"))?.min(59)),
                    _ => clock_typed(&self.typed("routine:clock"))?,
                };
                let every = self.picks.get("routine-every").and_then(|e| num(e)).unwrap_or(3);
                let start = if chip == "hours" { self.picks.get("routine-start").and_then(|e| num(e)).unwrap_or(0) } else { hour };
                cron_of(chip, minute, start, every, &self.routine_days()).map(|c| (Some(c), None))
            }
        }
    }

    pub fn save_routine(&mut self, id: Option<String>) {
        let Some((cron, at)) = self.routine_timing() else { return };
        let existing = id.as_deref().and_then(|id| find(self, id)).cloned().unwrap_or(Value::Null);
        let keep = |key: &str| existing.get(key).cloned().unwrap_or(Value::Null);
        let machine = self.picks.get("routine-machine").filter(|m| !m.is_empty()).cloned();
        let gate = Some(self.typed("routine:gate")).filter(|g| !g.is_empty());
        let mut draft = json!({
            "title": self.typed("routine:title"),
            "prompt": self.typed("routine:prompt"),
            "cron": cron,
            "at": at,
            // Where it runs moves with the form; a model and agent stay as they were, and go when
            // the place changes, since a machine's model is its agent's.
            "model": if machine.as_deref() == existing.get("machine").and_then(Value::as_str) { keep("model") } else { Value::Null },
            "machine": machine,
            "chat": self.picks.get("routine-chat").cloned().unwrap_or_else(|| "main".into()),
            "gate": gate,
        });
        if machine_unchanged(&existing, &draft) {
            draft["agent"] = keep("agent");
        }
        if let Some(owner) = existing.get("owner").and_then(Value::as_str) {
            draft["owner"] = json!(owner);
        }
        let mut fields = json!({ "draft": draft });
        if let Some(id) = id {
            fields["automation"] = json!(id);
        }
        self.ask("automation-save", fields, Then::Routine);
    }

    pub fn routine_action(&mut self, id: &str, action: &str) {
        self.tell("automation", json!({ "automation": id, "action": action }));
    }

    /// Back where the form came from.
    /// After a save: a routine stays shown; a new one, now in the list, leaves the pane to it.
    pub fn close_routine(&mut self) {
        if self.activity.pick == Some(Pick::Routine(None)) {
            self.activity.pick = None;
        }
    }
}

fn machine_unchanged(existing: &Value, draft: &Value) -> bool {
    !existing.is_null() && existing.get("machine") == draft.get("machine")
}

/// A label over what it sets, as the web's form rows.
fn labelled(label: &str, body: El, p: &Palette) -> El {
    col().w_full().gap(6.0).child(text(label.to_string()).font(META_STRONG).color(p.muted)).child(body)
}

fn chip(key: &str, label: &str, on: bool, pick: impl Fn(&mut State) + 'static, p: &Palette) -> El {
    let mut c = row()
        .key(key)
        .role("button")
        .label(label)
        .h(28.0)
        .px(12.0)
        .center()
        .radius(14.0)
        .border(1.0, if on { p.ink } else { p.line_strong })
        .child(text(label.to_string()).font(META).color(if on { p.ink } else { p.muted }).max_lines(1))
        .on_press(pick);
    if on {
        c = c.fill(p.selected);
    }
    c
}

pub fn form(s: &State, id: Option<&str>, p: &Palette) -> El {
    let now = time::now_ms();
    let existing = id.and_then(|id| find(s, id));
    let chip_now = s.picks.get("routine-chip").map_or("weekly", String::as_str);
    let mut page = col().w_full().gap(20.0);
    let heading = match existing {
        Some(a) => plain(str_at(a, "title")),
        None => "New routine".into(),
    };
    let sub = existing.map(|a| format!("{} · {}", meta_of(a, now), last_run_words(a, now))).unwrap_or_default();
    page = page.child(crate::settings::heading(&heading, &sub, p));

    let mut body = col().w_full().px(16.0).py(16.0).gap(16.0);
    body = body.child(labelled("Title", row().w_full().child(field(s, "routine:title", "Name it", p)), p));
    body = body.child(labelled("Prompt", row().w_full().child(field(s, "routine:prompt", "What each run does. It knows nothing else.", p)), p));

    // When.
    let mut chips = row().gap(6.0).flex_wrap();
    for (c, label) in CHIPS {
        chips = chips.child(chip(&format!("routine-chip:{c}"), label, chip_now == c, move |s: &mut State| {
            s.picks.insert("routine-chip", c.to_string());
        }, p));
    }
    let mut when = col().w_full().gap(10.0).child(chips);
    match chip_now {
        "once" => when = when.child(row().w_full().child(field(s, "routine:at", "2026-11-07 09:00", p))),
        "cron" => when = when.child(row().w_full().child(field(s, "routine:cron", "0 9 * * 1-5", p))),
        "hourly" => when = when.child(row().w_full().gap(10.0).center_y().child(text("At minute").font(META).color(p.muted)).child(row().w(90.0).child(field(s, "routine:minute", "00", p)))),
        "hours" => {
            let every = s.picks.get("routine-every").cloned().unwrap_or_else(|| "3".into());
            let mut steps = row().gap(6.0).flex_wrap().center_y().child(text("Every").font(META).color(p.muted));
            for n in HOUR_STEPS {
                let v = n.to_string();
                steps = steps.child(chip(&format!("routine-every:{n}"), &format!("{n}h"), every == v, move |s: &mut State| {
                    s.picks.insert("routine-every", v.clone());
                }, p));
            }
            when = when.child(steps).child(row().w_full().gap(10.0).center_y().child(text("At minute").font(META).color(p.muted)).child(row().w(90.0).child(field(s, "routine:minute", "00", p))));
        }
        _ => {
            when = when.child(row().w_full().gap(10.0).center_y().child(text("At").font(META).color(p.muted)).child(row().w(110.0).child(field(s, "routine:clock", "09:00", p))));
        }
    }
    if matches!(chip_now, "weekly" | "hourly") {
        let mut days = row().gap(6.0);
        for d in [1u32, 2, 3, 4, 5, 6, 0] {
            let key = format!("routine:day:{d}");
            let on = s.ticks.contains(&key);
            days = days.child(chip(&format!("routine-day:{d}"), WEEK[d as usize], on, move |s: &mut State| {
                if !s.ticks.remove(&key) {
                    s.ticks.insert(key.clone());
                }
            }, p));
        }
        when = when.child(days);
    }
    if let Some((Some(cron), _)) = s.routine_timing() {
        when = when.child(text(cron_words(&cron)).font(META).color(p.quiet));
    }
    body = body.child(labelled("When", when, p));

    // Where it runs.
    let machine = s.picks.get("routine-machine").cloned().unwrap_or_default();
    let mut places = row().gap(6.0).flex_wrap().child(chip("routine-machine:cloud", "The cloud", machine.is_empty(), |s: &mut State| {
        s.picks.insert("routine-machine", String::new());
    }, p));
    for m in s.machines.as_array().map_or(&[][..], Vec::as_slice).iter().filter(|m| m.get("cloud").is_none()) {
        let name = str_at(m, "name").to_string();
        let on = machine == name;
        let n2 = name.clone();
        places = places.child(chip(&format!("routine-machine:{name}"), &name, on, move |s: &mut State| {
            s.picks.insert("routine-machine", n2.clone());
        }, p));
    }
    body = body.child(labelled("Runs on", places, p));

    // Who hears back.
    let chat = s.picks.get("routine-chat").cloned().unwrap_or_else(|| "main".into());
    let mut chats = row().gap(6.0).flex_wrap().child(chip("routine-chat:main", "Main chat", chat == "main", |s: &mut State| {
        s.picks.insert("routine-chat", "main".into());
    }, p));
    for c in s.chats.iter().filter(|c| c.archived_at.is_none()).take(10) {
        let session = c.session.clone();
        let label = if c.title.is_empty() { session.clone() } else { c.title.clone() };
        let on = chat == session;
        chats = chats.child(chip(&format!("routine-chat:{session}"), &label, on, move |s: &mut State| {
            s.picks.insert("routine-chat", session.clone());
        }, p));
    }
    body = body.child(labelled("Reports to", chats, p));
    body = body.child(labelled(
        "Gate",
        col()
            .w_full()
            .gap(4.0)
            .child(row().w_full().child(field(s, "routine:gate", "Optional", p)))
            .child(text("Optional. An Executor program that returns what to act on, or null to skip the run.").font(META).color(p.quiet).wrap()),
        p,
    ));
    if let Some(a) = existing {
        let owner = str_at(a, "owner");
        let model = a.get("model").and_then(|m| m.get("modelId")).and_then(Value::as_str);
        let mut who = vec![format!("Runs as {}", if owner.is_empty() || owner == "ky" { "ky" } else { owner })];
        if let Some(model) = model {
            who.push(model.to_string());
        }
        if let Some(agent) = a.get("agent").and_then(Value::as_str) {
            who.push(agent.to_string());
        }
        body = body.child(text(who.join(" · ")).font(META).color(p.quiet));
        if let Some(note) = a.get("gate_note").and_then(Value::as_str) {
            body = body.child(text(format!("Gate: {note}")).font(META).color(p.quiet).wrap());
        }
    }

    let complete = !s.typed("routine:title").is_empty() && !s.typed("routine:prompt").is_empty() && s.routine_timing().is_some();
    let save_id = id.map(str::to_string);
    let busy = s.busy.contains("routine");
    let save = button("routine-save", if busy { "Saving…" } else if id.is_some() { "Save" } else { "Create" }, "primary", p);
    let save = if complete && !busy && s.online() { save.on_press(move |s: &mut State| s.save_routine(save_id.clone())) } else { off(save) };
    let mut actions = row().w_full().gap(8.0).center_y();
    if let Some(a) = existing {
        let id = str_at(a, "id").to_string();
        let status = str_at(a, "status");
        let act = |key: &str, label: &str, action: &'static str, tone: &str| {
            let id = id.clone();
            let b = button(&format!("routine-{key}"), label, tone, p);
            if s.online() { b.on_press(move |s: &mut State| s.routine_action(&id, action)) } else { off(b).help(crate::activity::OFFLINE_TITLE) }
        };
        let running = a.get("last_run").is_some_and(|r| matches!(str_at(r, "status"), "queued" | "working"));
        actions = actions.child(if running { act("stop", "Stop", "stop", "") } else { act("run", "Run", "run", "") });
        if status == "archived" {
            actions = actions.child(act("unarchive", "Unarchive", "unarchive", ""));
            let confirm = s.confirm.as_deref() == Some("routine-delete");
            actions = actions.child(if confirm {
                let id = id.clone();
                button("routine-delete-sure", "Delete for good", "danger", p).on_press(move |s: &mut State| {
                    s.routine_action(&id, "delete");
                    s.confirm = None;
                    s.close_routine();
                })
            } else {
                button("routine-delete", "Delete", "danger", p).on_press(|s: &mut State| s.confirm = Some("routine-delete".into()))
            });
        } else {
            actions = actions.child(if status == "paused" { act("resume", "Resume", "resume", "") } else { act("pause", "Pause", "pause", "") });
            actions = actions.child(act("archive", "Archive", "archive", "quiet"));
        }
    }
    actions = actions.child(el_grow()).child(save);
    let mut out = page.child(section("Routine", card(p).child(body), p)).child(actions);
    if let Some(why) = problem(s, "routine", p) {
        out = out.child(why);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crons_read_as_the_web_words_them() {
        assert_eq!(cron_words("*/15 * * * *"), "Every 15 min");
        assert_eq!(cron_words("30 * * * *"), "Hourly at :30");
        assert_eq!(cron_words("0 * * * 1-5"), "Hourly, weekdays");
        assert_eq!(cron_words("0 */3 * * *"), "Every 3 hours");
        assert_eq!(cron_words("0 9 * * 1-5"), "Weekdays · 9:00 AM");
        assert_eq!(cron_words("0 9 * * *"), "Daily · 9:00 AM");
        assert_eq!(cron_words("30 18 * * 0,6"), "Weekends · 6:30 PM");
        assert_eq!(cron_words("0 8 * * 1,3"), "Mon, Wed · 8:00 AM");
        assert_eq!(cron_words("0 8 1 * *"), "0 8 1 * *");
    }

    #[test]
    fn a_rhythm_makes_the_cron_it_was_read_from() {
        for cron in ["0 9 * * 1-5", "15 7 * * *", "0 * * * 1-5", "0 */3 * * *", "30 6-23/4 * * *", "0 8 * * 1,3"] {
            let (chip, m, h, n, days) = rhythm_of(cron);
            assert_eq!(cron_of(chip, m, h, n, &days).as_deref(), Some(cron), "{cron} as {chip}");
        }
    }
}

fn el_grow() -> El {
    rune::el().grow(1.0)
}
