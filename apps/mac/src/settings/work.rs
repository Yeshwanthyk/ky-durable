//! Machines (your computers and sandboxes, pairing one), a machine's page, and Spend: the web's
//! `MachineList`, `MachinePage` and `Spend`.

use rune::{El, col, icon, row, text};
use serde_json::{Value, json};

use super::{Then, button, card, copy_line, dot, empty, field, heading, line, list_at, money, num_at, off, plural, problem, rows, section, segmented, state, str_at, tone, value};
use crate::theme::{META, Palette, ROW, icons};
use crate::{Section, State, time};

/// A machine's dot and status words (`machineStatus`).
pub fn status_word(m: &Value, now: f64) -> (&'static str, String) {
    let active = num_at(m, "active") as usize;
    if let Some(cloud) = m.get("cloud").and_then(Value::as_str) {
        let (tone, word, none) = match cloud {
            "waking" => ("waking", "Waking", "starting up"),
            "running" => ("online", "Running", "idle"),
            _ => ("off", "Asleep", "wakes when it's sent a task"),
        };
        return (tone, format!("{word} · {}", if active == 0 { none.to_string() } else { plural(active, "task") }));
    }
    if m.get("online").and_then(Value::as_bool) != Some(true) {
        let waiting = if active > 0 { format!(" · {active} waiting") } else { String::new() };
        return ("offline", format!("Offline · last seen {}{waiting}", time::ago(num_at(m, "seenAt"), now)));
    }
    let (tone, word) = match str_at(m, "state") {
        "paused" => ("paused", "Paused"),
        "off" => ("off", "Off"),
        _ => ("online", "Online"),
    };
    (tone, format!("{word} · {}", if active == 0 { "idle".to_string() } else { format!("{} running", plural(active, "task")) }))
}

fn machines_of(s: &State) -> &[Value] {
    s.machines.as_array().map_or(&[], Vec::as_slice)
}

pub fn machines(s: &State, p: &Palette) -> El {
    let now = time::now_ms();
    let add = button("add-machine", "Add a machine", "", p).on_press(|s: &mut State| s.http("POST", "/api/runners/codes", None, Then::Http { store: Some("pairing"), form: "pairing" }));
    let head = row().w_full().gap(12.0).child(heading("Machines", "Where ky's work runs: your computers, and sandboxes in the cloud.", p).grow(1.0).shrink()).child(add);
    let mut page = col().w_full().gap(22.0).child(head);
    if let Some(code) = s.views.get("pairing") {
        let base = s.ky.as_ref().map_or(String::new(), |k| k.url.clone());
        let expires = num_at(code, "expiresAt");
        page = page.child(if expires <= now {
            empty("That code expired. Make a new one.", p)
        } else {
            card(p).child(
                col()
                    .w_full()
                    .px(16.0)
                    .py(14.0)
                    .gap(10.0)
                    .child(copy_line("pairing", &format!("ky runner add {base} {}", str_at(code, "code")), p))
                    .child(text(format!("Run this on the computer before {}. It works once.", super::clock(expires))).font(META).color(p.quiet)),
            )
        });
    }
    if let Some(why) = problem(s, "pairing", p) {
        page = page.child(why);
    }
    let list = machines_of(s);
    if list.is_empty() {
        return page.child(empty("No machines yet", p));
    }
    let (clouds, computers): (Vec<&Value>, Vec<&Value>) = list.iter().partition(|m| m.get("sandbox").is_some_and(|x| !x.is_null()) || m.get("cloud").is_some_and(|x| !x.is_null()));
    for (label, group) in [("Computers", computers), ("Sandboxes", clouds)] {
        if group.is_empty() {
            continue;
        }
        let items = group
            .iter()
            .map(|m| {
                let name = str_at(m, "name").to_string();
                let (t, words) = status_word(m, now);
                let note = str_at(m, "note");
                let sub = if note.is_empty() { words } else { format!("{words} · {note}") };
                let n = name.clone();
                row()
                    .key(&format!("machine:{name}"))
                    .role("button")
                    .label(&name)
                    .w_full()
                    .px(16.0)
                    .py(11.0)
                    .gap(12.0)
                    .center_y()
                    .hover(p.hover)
                    .child(dot(tone(t, p)))
                    .child(col().grow(1.0).shrink().min_w(0.0).gap(2.0).child(text(name).font(crate::theme::ROW_STRONG).color(p.ink)).child(text(sub).font(META).color(p.quiet).max_lines(1)))
                    .child(icon(&icons::CHEVRON_RIGHT, 14.0).color(p.quiet))
                    .on_press(move |s: &mut State| s.open_detail(Section::Machines, &n))
            })
            .collect();
        page = page.child(section(label, rows(items, p), p));
    }
    page.child(super::note("Sandboxes are added and deleted from ky on the web.", p))
}

impl State {
    /// Change a machine: what the web's `set-machine` sends; the next `tasks` frame confirms it.
    fn set_machine(&mut self, machine: &str, change: Value) {
        let mut fields = json!({ "machine": machine });
        if let (Some(out), Value::Object(change)) = (fields.as_object_mut(), &change) {
            out.extend(change.clone());
            if let Some(m) = self.machines.as_array_mut().and_then(|ms| ms.iter_mut().find(|m| str_at(m, "name") == machine)) {
                if let Some(m) = m.as_object_mut() {
                    m.extend(change.clone());
                }
            }
        }
        if let Value::Object(f) = fields {
            let mut f = f;
            f.remove("type");
            self.tell("set-machine", Value::Object(f));
        }
        self.ui_rev += 1;
    }
}

pub fn machine(s: &State, name: &str, p: &Palette) -> El {
    let Some(m) = machines_of(s).iter().find(|m| str_at(m, "name") == name) else {
        return empty("ky doesn't know that machine any more.", p);
    };
    let now = time::now_ms();
    let (t, words) = status_word(m, now);
    let cloud = m.get("cloud").is_some_and(|c| !c.is_null());
    let facts = m.get("facts").filter(|f| !f.is_null());
    let kind = if cloud { "A sandbox in the cloud" } else { "One of your computers" };
    let mut page = col().w_full().gap(22.0).child(heading(name, kind, p));
    let mut status = vec![line("Status", None, state(words, tone(t, p), p), p)];
    let reason = str_at(m, "reason");
    if !reason.is_empty() {
        status.push(line("Why", Some(reason), row(), p));
    }
    page = page.child(rows(status, p));
    if !cloud {
        let machine = name.to_string();
        let takes = segmented("takes", &[("on", "On"), ("paused", "Paused"), ("off", "Off")], str_at(m, "state"), p, move |s, state| s.set_machine(&machine, json!({ "state": state })));
        let machine = name.to_string();
        let login = segmented("login", &[("own", "This computer's"), ("ky", "From Subscriptions")], str_at(m, "login"), p, move |s, login| s.set_machine(&machine, json!({ "login": login })));
        let hint = if str_at(m, "login") == "ky" { "Its tasks use the Claude and ChatGPT you added to Subscriptions" } else { "Its tasks use whoever is signed in on it" };
        page = page.child(section(
            "Work",
            rows(vec![line("Takes tasks", Some("Whether ky gives it work"), takes, p), line("Claude & Codex login", Some(hint), login, p)], p),
            p,
        ));
    }
    // What it's for.
    let machine = name.to_string();
    let typed = s.typed(&format!("note:{name}"));
    let save = button("save-note", "Save", "", p);
    let save = if typed.is_empty() || typed == str_at(m, "note") { off(save) } else { save.on_press(move |s: &mut State| {
        let note = s.typed(&format!("note:{machine}"));
        s.set_machine(&machine, json!({ "note": note }));
    }) };
    page = page.child(section(
        "What it's for (optional)",
        card(p).child(row().w_full().px(16.0).py(12.0).gap(10.0).center_y().child(field(s, &format!("note:{name}"), if str_at(m, "note").is_empty() { "e.g. work laptop, has Chrome" } else { str_at(m, "note") }, p)).child(save)),
        p,
    ));
    if let Some(f) = facts {
        let mut items = vec![line("System", None, value(str_at(f, "os"), p), p)];
        items.push(line("Chrome", None, value(if f.get("chrome").and_then(Value::as_bool) == Some(true) { "Yes" } else { "No" }, p), p));
        for (id, label) in [("claude", "Claude Code"), ("codex", "Codex")] {
            let a = f.get("agents").and_then(|a| a.get(id));
            let words = match a {
                Some(a) if a.get("signedIn").and_then(Value::as_bool) == Some(true) => "Signed in",
                Some(a) if a.get("installed").and_then(Value::as_bool) == Some(true) => "Installed, signed out",
                _ => "Not installed",
            };
            items.push(line(label, None, value(words, p), p));
        }
        let repos: Vec<&str> = list_at(f, "repos").iter().filter_map(Value::as_str).collect();
        items.push(line("Repos", Some(&if repos.is_empty() { "None".to_string() } else { repos.join(", ") }), row(), p));
        page = page.child(section("What it has", rows(items, p), p));
    }
    if !cloud {
        if m.get("online").and_then(Value::as_bool) != Some(true) {
            page = page.child(section("Start it there with", copy_line("runner-run", "ky runner run", p), p));
        }
        let ask = format!("unpair:{name}");
        let confirming = s.confirm.as_deref() == Some(ask.as_str());
        let machine = name.to_string();
        let mut unpair = row().gap(8.0).center_y();
        if confirming {
            unpair = unpair
                .child(text(format!("Unpair {name}? It stops taking tasks until you pair it again.")).font(META).color(p.muted).wrap().grow(1.0).shrink())
                .child(button("unpair-cancel", "Cancel", "", p).on_press(|s: &mut State| s.confirm = None))
                .child(button("unpair-yes", "Unpair", "danger", p).on_press(move |s: &mut State| {
                    s.http("DELETE", &format!("/api/runners/{machine}"), None, Then::Http { store: None, form: "unpair" });
                }));
        } else {
            unpair = unpair.child(button("unpair", "Unpair this computer", "danger", p).on_press(move |s: &mut State| s.confirm = Some(ask.clone())));
        }
        page = page.child(unpair);
        if let Some(why) = problem(s, "unpair", p) {
            page = page.child(why);
        }
    }
    page
}

/// Spend's source names (`Spend.tsx`).
const SOURCES: &[(&str, &str)] = &[
    ("chat", "Chat"),
    ("subagent", "Subagents"),
    ("automation", "Automations"),
    ("look", "Looks"),
    ("dream", "Dreams"),
    ("episode", "Episodes"),
    ("skill-review", "Skill reviews"),
    ("mail", "Mail"),
    ("peer", "Peers"),
    ("machine-task", "Machine tasks"),
    ("call", "Titles, routing and summaries"),
    ("other", "Other"),
];

fn calls(t: &Value) -> String {
    plural(num_at(t, "calls") as usize, "call")
}

pub fn spend(s: &State, p: &Palette) -> El {
    let page = col().w_full().gap(22.0).child(heading("Spend", "What ky's models cost, and a cap on a day.", p));
    let Some(v) = s.views.get("spend") else {
        return page.child(empty(s.problems.get("spend").map_or("Loading…", String::as_str), p));
    };
    let capped = v.get("capped").and_then(Value::as_bool) == Some(true);
    let today = v.get("today").cloned().unwrap_or_default();
    let month = v.get("month").cloned().unwrap_or_default();
    let today_value = text(money(num_at(&today, "costUsd"))).font(ROW).color(if capped { p.warning } else { p.ink });
    let totals = rows(vec![line("Today", Some(&calls(&today)), today_value, p), line("This month", Some(&calls(&month)), value(money(num_at(&month, "costUsd")), p), p)], p);
    let mut page = page.child(section("Totals", totals, p));
    // Today by source.
    let mut by: Vec<(&str, f64, f64)> = Vec::new();
    for l in list_at(v, "lines") {
        let source = SOURCES.iter().find(|(id, _)| *id == str_at(l, "source")).map_or("Other", |(_, n)| n);
        match by.iter_mut().find(|(n, ..)| *n == source) {
            Some(e) => {
                e.1 += num_at(l, "costUsd");
                e.2 += num_at(l, "calls");
            }
            None => by.push((source, num_at(l, "costUsd"), num_at(l, "calls"))),
        }
    }
    by.sort_by(|a, b| b.1.total_cmp(&a.1));
    page = page.child(section(
        "Today by purpose",
        if by.is_empty() { empty("Nothing yet today", p) } else { rows(by.iter().map(|(n, usd, c)| line(n, Some(&plural(*c as usize, "call")), value(money(*usd), p), p)).collect(), p) },
        p,
    ));
    // The cap.
    let cap = v.get("capUsd").and_then(Value::as_f64);
    let sub = match (cap, capped) {
        (None, _) => "Off, in USD",
        (Some(_), true) => "Reached: work waits",
        (Some(_), false) => "In USD",
    };
    let typed = s.typed("cap:usd");
    let set = button("set-cap", "Set cap", "primary", p);
    let set = match typed.trim_start_matches('$').parse::<f64>() {
        Ok(usd) if usd >= 0.0 => set.on_press(move |s: &mut State| {
            s.set_field("cap:usd", "");
            s.ask("set-spend-cap", json!({ "usd": usd }), Then::Store("spend"));
        }),
        _ => off(set),
    };
    let mut end = row().gap(8.0).center_y().child(super::field(s, "cap:usd", &cap.map_or("None".to_string(), money), p).w(110.0).min_w(110.0).grow(0.0));
    if cap.is_some() {
        end = end.child(button("clear-cap", "Clear", "", p).on_press(|s: &mut State| s.ask("set-spend-cap", json!({ "usd": null }), Then::Store("spend"))));
    }
    page = page.child(section("Cap", card(p).child(line("Daily cap", Some(sub), end.child(set), p)), p));
    if let Some(why) = s.problems.get("spend") {
        page = page.child(text(why.clone()).font(META).color(p.danger).wrap());
    }
    let held = list_at(v, "held");
    if !held.is_empty() {
        page = page.child(section("Held today", rows(held.iter().map(|h| line(&format!("{} held", str_at(h, "work")), Some(str_at(h, "why")), row(), p)).collect(), p), p));
    }
    page
}

#[cfg(test)]
mod tests {
    use super::status_word;
    use serde_json::json;

    #[test]
    fn machine_words_match_the_web() {
        let now = 10_000_000.0;
        assert_eq!(status_word(&json!({ "online": true, "state": "on", "active": 0 }), now), ("online", "Online · idle".into()));
        assert_eq!(status_word(&json!({ "online": true, "state": "paused", "active": 2 }), now), ("paused", "Paused · 2 tasks running".into()));
        assert_eq!(status_word(&json!({ "online": false, "active": 1, "seenAt": now - 3.0 * 3_600_000.0 }), now), ("offline", "Offline · last seen 3h · 1 waiting".into()));
        assert_eq!(status_word(&json!({ "cloud": "asleep", "active": 0 }), now), ("off", "Asleep · wakes when it's sent a task".into()));
        assert_eq!(status_word(&json!({ "cloud": "running", "active": 1 }), now), ("online", "Running · 1 task".into()));
    }
}
