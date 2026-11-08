//! Models (each purpose's model), a purpose's Model page (its model and thinking), and Providers
//! (what's connected, removing a key, adding one): the web's `ModelPickers`, `ModelPage`,
//! `Providers` and `AddKey`.

use rune::{El, col, icon, row, text};
use serde_json::json;

use super::{button, card, divider, empty, field, heading, line, link, off, plural, problem, rows, section, segmented, state, value};
use crate::theme::{META, Palette, ROW, icons};
use crate::wire::{ModelChoice, ModelOption};
use crate::{Section, State};

/// The web's `PURPOSE_TEXT`.
pub const PURPOSES: &[(&str, &str, &str)] = &[
    ("main", "Main agent", "Talks to you, and dreams, looks and reviews for you"),
    ("worker", "Worker", "Subagents, specialists and automations"),
    ("background", "Background", "Titles and memory summaries. Small and quick is best"),
    ("fallback", "Fallback", "Answers when a provider is down"),
];

/// The web's `LEVELS`.
const LEVELS: &[(&str, &str)] =
    &[("off", "Off"), ("minimal", "Minimal"), ("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra high"), ("max", "Max")];

fn level_name(level: &str) -> &'static str {
    LEVELS.iter().find(|(id, _)| *id == level).map_or("Off", |(_, n)| n)
}

fn option<'a>(s: &'a State, c: &ModelChoice) -> Option<&'a ModelOption> {
    s.settings.providers.iter().find(|pr| pr.id == c.provider)?.models.iter().find(|m| m.model_id == c.model_id)
}

/// A choice's model by name, and its thinking when `level` and it thinks.
pub fn model_name(s: &State, c: &ModelChoice, level: bool) -> String {
    let name = option(s, c).map_or(c.model_id.clone(), |m| m.name.clone());
    match c.thinking_level.as_str() {
        "" | "off" => name,
        _ if !level => name,
        l => format!("{name} · {}", level_name(l)),
    }
}

pub fn models(s: &State, p: &Palette) -> El {
    let page = col().w_full().gap(22.0).child(heading("Models", "Which model does each kind of work.", p));
    if s.settings.providers.is_empty() {
        return page.child(empty("Loading models…", p));
    }
    if !s.settings.providers.iter().any(|pr| pr.connected) {
        return page.child(empty("No model provider is on", p));
    }
    let items = PURPOSES
        .iter()
        .map(|&(purpose, label, sub)| {
            let set = s.settings.purposes.get(purpose).map_or("Not set".to_string(), |c| model_name(s, c, true));
            link(&format!("purpose:{purpose}"), label, Some(sub), Some(set), p).on_press(move |s: &mut State| s.open_detail(Section::Models, purpose))
        })
        .collect();
    let mut page = page.child(rows(items, p));
    if let Some(why) = &s.notice {
        page = page.child(text(why.clone()).font(META).color(p.danger).wrap());
    }
    page
}

/// A purpose's page: its model, featured first with the rest behind Show all, and its thinking.
pub fn model(s: &State, purpose: &str, p: &Palette) -> El {
    let Some(&(purpose, title, sub)) = PURPOSES.iter().find(|(id, ..)| *id == purpose) else { return empty("No such purpose", p) };
    let current = s.settings.purposes.get(purpose);
    let mut list = card(p).key(&format!("choices:{purpose}"));
    let mut hidden = 0;
    let mut first = true;
    for provider in s.settings.providers.iter().filter(|pr| pr.connected) {
        let mut models: Vec<_> = provider.models.iter().collect();
        models.sort_by_key(|m| !m.featured);
        for m in models {
            let chosen = current.is_some_and(|c| c.provider == provider.id && c.model_id == m.model_id);
            if !m.featured && !chosen && !s.all_models {
                hidden += 1;
                continue;
            }
            if !first {
                list = list.child(divider(p));
            }
            first = false;
            let price = m.cost.map(|c| format!("{} · ${} / ${} per M", provider.name, trim(c.input), trim(c.output))).unwrap_or_else(|| provider.name.clone());
            let (provider_id, model_id) = (provider.id.clone(), m.model_id.clone());
            let mut end = row().w(18.0).justify_end();
            if chosen {
                end = end.child(icon(&icons::CHECK, 15.0).color(p.ink));
            }
            list = list.child(
                line(&m.name, Some(&price), end, p)
                    .key(&format!("model:{purpose}:{}:{}", provider.id, m.model_id))
                    .role("button")
                    .label(&format!("Use {}", m.name))
                    .hover(p.hover)
                    .on_press(move |s: &mut State| s.set_model(purpose, &provider_id, &model_id)),
            );
        }
    }
    let more = if s.all_models {
        Some("Show fewer models".to_string())
    } else if hidden > 0 {
        Some(format!("Show all models ({hidden} more)"))
    } else {
        None
    };
    if let Some(more) = more {
        list = list.child(divider(p)).child(
            row()
                .key("show-all-models")
                .role("button")
                .label(&more)
                .w_full()
                .h(40.0)
                .px(16.0)
                .center_y()
                .hover(p.hover)
                .child(text(more).font(ROW).color(p.muted))
                .on_press(|s: &mut State| {
                    s.all_models = !s.all_models;
                    s.ui_rev += 1;
                }),
        );
    }
    let mut page = col().w_full().gap(22.0).child(heading(title, sub, p)).child(section("Model", list, p));
    // Thinking, when the chosen model has two levels or more.
    if let Some(c) = current {
        let levels: Vec<&'static str> = option(s, c).map_or(Vec::new(), |m| m.levels.iter().filter_map(|l| LEVELS.iter().find(|(id, _)| id == l).map(|(id, _)| *id)).collect());
        if levels.len() >= 2 {
            let options: Vec<(&'static str, &'static str)> = levels.iter().map(|l| (*l, level_name(l))).collect();
            let level = if c.thinking_level.is_empty() { "off" } else { c.thinking_level.as_str() };
            let bar = segmented(&format!("thinking:{purpose}"), &options, level, p, move |s, level| s.set_thinking(purpose, level));
            page = page.child(section("Thinking", card(p).child(row().w_full().px(16.0).py(12.0).child(bar)), p));
        }
    }
    page
}

fn trim(n: f64) -> String {
    let s = format!("{n:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

impl State {
    pub fn set_thinking(&mut self, purpose: &str, level: &str) {
        let Some(c) = self.settings.purposes.get(purpose).cloned() else { return };
        if let Some(main) = self.main_conn() {
            main.send(crate::wire::set_model(purpose, &c.provider, &c.model_id, level));
        }
        self.settings.purposes.insert(purpose.to_string(), ModelChoice { thinking_level: level.to_string(), ..c });
    }
}

/// Providers: each set-up one and how it stands, the ones not set up, and adding a key.
pub fn providers(s: &State, p: &Palette) -> El {
    let mut page = col().w_full().gap(22.0).child(heading("Providers", "Where ky's models come from.", p));
    if s.settings.providers.is_empty() {
        return page.child(empty("Loading providers…", p));
    }
    let missing = |id: &str| super::list_at(&s.setup, "missing").iter().any(|m| super::str_at(m, "id") == id);
    let (set_up, not): (Vec<_>, Vec<_>) = s.settings.providers.iter().partition(|pr| !missing(&pr.id) && (pr.connected || pr.needs.is_none()));
    if !set_up.is_empty() {
        let items = set_up
            .iter()
            .map(|pr| {
                let sub = if !pr.connected {
                    format!("Needs {}", pr.needs.as_deref().unwrap_or("a key"))
                } else if let Some(f) = &pr.failure {
                    format!("Last error: {f}")
                } else {
                    plural(pr.models.len(), "model")
                };
                let mut end = row().gap(12.0).center_y();
                if pr.kind == "api-key" {
                    let id = pr.id.clone();
                    end = end.child(button(&format!("remove-key:{}", pr.id), "Remove", "danger", p).label(&format!("Remove the {} key", pr.name)).on_press(move |s: &mut State| {
                        s.tell("remove-key", json!({ "provider": id }));
                    }));
                }
                end = end.child(state(if pr.connected { "On" } else { "Off" }, if pr.connected { p.success } else { p.quiet }, p));
                line(&pr.name, Some(&sub), end, p)
            })
            .collect();
        page = page.child(section("Connected", rows(items, p), p));
    }
    if !not.is_empty() {
        let items = not.iter().map(|pr| line(&pr.name, Some(&format!("Needs {}", pr.needs.as_deref().unwrap_or("a key"))), value("Off", p), p)).collect();
        page = page.child(section("Not set up", rows(items, p), p));
    }
    page.child(section("Add an API key", add_key(s, p), p))
}

fn add_key(s: &State, p: &Palette) -> El {
    let vendor = s.picks.get("vendor").cloned().or_else(|| s.settings.vendors.first().map(|v| v.id.clone())).unwrap_or_default();
    let mut vendors = row().gap(6.0).flex_wrap();
    for v in &s.settings.vendors {
        let on = v.id == vendor;
        let id = v.id.clone();
        let mut chip = row()
            .key(&format!("vendor:{}", v.id))
            .role("button")
            .label(&v.name)
            .h(28.0)
            .px(12.0)
            .center()
            .radius(14.0)
            .border(1.0, if on { p.ink } else { p.line_strong })
            .child(text(v.name.clone()).font(META).color(if on { p.ink } else { p.muted }))
            .on_press(move |s: &mut State| {
                s.picks.insert("vendor", id.clone());
            });
        if on {
            chip = chip.fill(p.selected);
        }
        vendors = vendors.child(chip);
    }
    let busy = s.busy.contains("key");
    let key = s.typed("key:key");
    let save = button("add-key", if busy { "Testing…" } else { "Test and save" }, "primary", p);
    let save = if busy || key.is_empty() || vendor.is_empty() {
        off(save)
    } else {
        save.on_press(move |s: &mut State| {
            let (vendor, key) = (vendor.clone(), s.typed("key:key"));
            s.ask("add-key", json!({ "vendor": vendor, "key": key }), super::Then::Form("key"));
        })
    };
    let mut form = col()
        .w_full()
        .px(16.0)
        .py(14.0)
        .gap(12.0)
        .child(vendors)
        .child(field(s, "key:key", "Paste it here", p).secure())
        .child(row().w_full().gap(10.0).center_y().child(row().gap(6.0).center_y().grow(1.0).child(icon(&icons::KEY, 13.0).color(p.quiet)).child(text("Stored in Vault").font(META).color(p.quiet))).child(save));
    if let Some(why) = problem(s, "key", p) {
        form = form.child(why);
    }
    card(p).child(form)
}
