//! Cards, as the web draws them (`src/ui/Blocks.tsx`, `src/ui/Charts.tsx`, `chat-content.css`): what
//! ky's `ui` tool shows (the call's arguments are the card), and the approvals that wait on the
//! user's tap (`src/ui/Approvals.tsx`).
//!
//! A card's questions (choices and fields) take taps while it is the chat's latest word, unanswered
//! and not yet sent. A lone single choice sends on its tap; a lone field has its own ✓; anything
//! else waits for Send. The answer goes as the user's words plus `card: {call, values, button?}`,
//! as the web's `submit` does.

use rune::{Color, El, LineCap, Shape, TextStyle, canvas, col, el, icon, row, text, text_input};
use rune_kit::MarkdownStyle;
use serde_json::Value;

use crate::State;
use crate::chat::{Row, ToolStatus};
use crate::theme::{BODY, META, META_STRONG, Palette, icons};
use crate::transcript::Turn;
use crate::wire::Approval;

const TITLE: TextStyle = TextStyle::new(16.0, 600.0).lh(22.0);
const QUESTION: TextStyle = TextStyle::new(14.5, 600.0).lh(20.0);
const SMALL: TextStyle = TextStyle::new(12.5, 400.0).lh(17.0);
const TINY: TextStyle = TextStyle::new(11.5, 400.0).lh(15.0);
const LABEL: TextStyle = TextStyle::new(11.5, 500.0).lh(15.0);
const CELL: TextStyle = TextStyle::new(13.0, 400.0).lh(18.0);
const STAT: TextStyle = TextStyle::new(20.0, 600.0).lh(23.0);
const BUTTON: TextStyle = TextStyle::new(13.0, 500.0).lh(18.0);
const LETTERS: &[u8] = b"ABCDEFGHIJKL";

/// One `ui` call's card.
pub struct Card {
    pub call: String,
    pub spec: Value,
    /// A later call with the same `id` replaced it.
    pub updated: bool,
}

/// The cards a turn showed, in order. A card with an `id` shows once, as its last call drew it.
pub fn of_turn(r: &Row) -> Vec<Card> {
    let mut cards: Vec<Card> = Vec::new();
    for tool in r.tools().filter(|t| t.name == "ui" && t.status != ToolStatus::Failed) {
        if !tool.args.get("blocks").is_some_and(Value::is_array) {
            continue;
        }
        let id = tool.args.get("id").and_then(Value::as_str);
        if let Some(id) = id {
            if let Some(i) = cards.iter().position(|c| c.spec.get("id").and_then(Value::as_str) == Some(id)) {
                cards.remove(i);
                cards.push(Card { call: tool.id.clone(), spec: tool.args.clone(), updated: true });
                continue;
            }
        }
        cards.push(Card { call: tool.id.clone(), spec: tool.args.clone(), updated: false });
    }
    cards
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// The card's questions, in order, nested ones too: (label, is a choice, multiple).
pub fn questions(spec: &Value) -> Vec<&Value> {
    fn walk<'a>(blocks: &'a [Value], out: &mut Vec<&'a Value>) {
        for b in blocks {
            match str_of(b, "type") {
                "choice" | "input" => out.push(b),
                "tabs" => arr(b, "tabs").iter().for_each(|t| walk(arr(t, "blocks"), out)),
                "columns" => arr(b, "columns").iter().for_each(|c| walk(c.as_array().map(Vec::as_slice).unwrap_or(&[]), out)),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(arr(spec, "blocks"), &mut out);
    out
}

#[cfg(test)]
fn lone_choice(qs: &[&Value]) -> bool {
    qs.len() == 1 && str_of(qs[0], "type") == "choice" && qs[0].get("multiple") != Some(&Value::Bool(true))
}

pub fn needs_send(qs: &[&Value]) -> bool {
    qs.len() > 1 || (qs.len() == 1 && str_of(qs[0], "type") == "choice" && qs[0].get("multiple") == Some(&Value::Bool(true)))
}

/// The words a card's answer sends: one question's values, or "label: values" lines.
pub fn compose(qs: &[&Value], values: &[Vec<String>]) -> String {
    let text = |i: usize| values.get(i).map(|v| v.join(", ").trim().to_string()).unwrap_or_default();
    if qs.len() == 1 {
        return text(0);
    }
    qs.iter().enumerate().filter(|(i, _)| !text(*i).is_empty()).map(|(i, q)| format!("{}: {}", str_of(q, "label"), text(i))).collect::<Vec<_>>().join("\n")
}

pub fn answered(qs: &[&Value], values: &[Vec<String>]) -> bool {
    !qs.is_empty() && (0..qs.len()).all(|i| values.get(i).is_some_and(|v| v.iter().any(|x| !x.trim().is_empty())))
}

/// The card's icon from its own name or its title's words, as the web picks it.
fn icon_of(spec: &Value) -> &'static rune::Icon {
    let name = format!("{} {}", str_of(spec, "icon"), str_of(spec, "title")).to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| name.contains(w));
    if has(&["mail", "gmail", "inbox"]) {
        &icons::MAIL
    } else if has(&["calendar", "event", "time", "clock"]) {
        &icons::CLOCK
    } else if has(&["github", "git", "branch", "code"]) {
        &icons::BRANCH
    } else if has(&["file", "doc", "drive", "sheet"]) {
        &icons::FILE
    } else if has(&["web", "site", "link", "browser"]) {
        &icons::GLOBE
    } else if has(&["plug", "app", "connect", "auth"]) {
        &icons::PLUG
    } else if has(&["task", "todo", "list"]) {
        &icons::LIST
    } else if has(&["chat", "message", "slack"]) {
        &icons::CHAT
    } else {
        &icons::SPARKLE
    }
}

/// What drawing a card needs beyond its spec.
struct Ctx<'a> {
    call: &'a str,
    session: &'a str,
    /// Takes taps.
    live: bool,
    /// Each question's values: the answer once recorded, else what is ticked so far.
    values: Vec<Vec<String>>,
    pressed: Option<String>,
    lone_field: bool,
    base: String,
    s: &'a State,
    md: &'a MarkdownStyle,
    p: &'a Palette,
}

pub fn card(c: &Card, t: &Turn, s: &State, md: &MarkdownStyle, p: &Palette) -> El {
    let conn = s.conns.iter().find(|x| x.session == t.session);
    let answer = conn.and_then(|x| x.chat.answers.get(&c.call));
    let sent = conn.is_some_and(|x| x.chat.sent_cards.contains(&c.call));
    let qs = questions(&c.spec);
    let values = match answer {
        Some(a) => a.values.clone(),
        None => s.card_values(&c.call, qs.len()),
    };
    let x = Ctx {
        call: &c.call,
        session: t.session,
        live: t.open && answer.is_none() && !sent,
        values,
        pressed: answer.and_then(|a| a.button.clone()),
        lone_field: qs.len() == 1 && str_of(qs[0], "type") == "input",
        base: s.ky.as_ref().map(|k| k.url.trim_end_matches('/').to_string()).unwrap_or_default(),
        s,
        md,
        p,
    };
    let mut x = x;
    if answer.is_none() {
        // A field's typing counts as its value, for Send's readiness and once the card is sent.
        x.values = x.values_with_fields(&qs);
    }
    let spec = &c.spec;
    let mut body = col().key(&format!("card:{}", c.call)).w_full().pt(18.0).px(18.0).pb(16.0).gap(14.0).radius(16.0).fill(p.surface).border(1.0, p.line);
    let title = str_of(spec, "title");
    if !title.is_empty() {
        let mut head = row()
            .w_full()
            .gap(10.0)
            .center_y()
            .child(el().size(28.0, 28.0).radius(9.0).fill(p.raised).center().child(icon(icon_of(spec), 15.0).color(p.muted)))
            .child(text(title.to_string()).font(TITLE).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0));
        let subtitle = str_of(spec, "subtitle");
        if !subtitle.is_empty() {
            head = head.child(text(subtitle.to_string()).font(TINY).color(p.quiet).max_lines(1));
        }
        body = body.child(head);
    }
    let mut q = 0;
    body = blocks(body, arr(spec, "blocks"), &x, &mut q, "b");
    if x.live && needs_send(&qs) {
        let ready = answered(&qs, &x.values);
        let (call, session) = (c.call.clone(), t.session.to_string());
        body = body.child(row().w_full().justify_end().child(button_el("send", "Send", "primary", !ready, false, p).on_press(move |s: &mut State| s.card_send(&session, &call, None))));
    }
    let note = str_of(spec, "note");
    if !note.is_empty() {
        body = body.child(text(note.to_string()).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(p.quiet).wrap());
    }
    if c.updated {
        return col().w_full().gap(6.0).child(row().gap(6.0).center_y().child(text("Updated").font(SMALL).color(p.quiet)).child(icon(&icons::REFRESH, 13.0).color(p.quiet))).child(body);
    }
    body
}

impl Ctx<'_> {
    /// The values with each field's typing in its place.
    fn values_with_fields(&self, qs: &[&Value]) -> Vec<Vec<String>> {
        let mut out = self.values.clone();
        out.resize(qs.len(), Vec::new());
        for (i, q) in qs.iter().enumerate() {
            if str_of(q, "type") == "input" {
                if let Some(f) = self.s.fields.get(&format!("{}:{i}", self.call)) {
                    out[i] = vec![f.text.clone()];
                }
            }
        }
        out
    }
}

/// Lay `list` into `into`; `q` counts questions so each knows its place in the answer.
fn blocks(mut into: El, list: &[Value], x: &Ctx, q: &mut usize, path: &str) -> El {
    for (i, b) in list.iter().enumerate() {
        let path = format!("{path}.{i}");
        if let Some(el) = block(b, x, q, &path) {
            into = into.child(el);
        }
    }
    into
}

fn label(b: &Value, p: &Palette) -> Option<El> {
    let l = str_of(b, "label");
    (!l.is_empty()).then(|| text(l.to_string()).font(LABEL).color(p.quiet).mb(8.0))
}

fn block(b: &Value, x: &Ctx, q: &mut usize, path: &str) -> Option<El> {
    let p = x.p;
    Some(match str_of(b, "type") {
        "text" => col().w_full().child(crate::transcript::md(x.s, str_of(b, "text").to_string()).selectable(true).render(x.md)),
        "list" => {
            let mut c = col().w_full();
            if let Some(l) = label(b, p) {
                c = c.child(l);
            }
            for (i, item) in arr(b, "items").iter().enumerate() {
                let mut it = col().w_full().gap(2.0).py(8.0);
                if i == 0 {
                    it = it.pt(0.0);
                } else {
                    it = it.border_sides([1.0, 0.0, 0.0, 0.0], p.line);
                }
                let mut top = row().w_full().gap(12.0).child(text(str_of(item, "title").to_string()).font(META_STRONG).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0));
                let meta = str_of(item, "meta");
                if !meta.is_empty() {
                    top = top.child(text(meta.to_string()).font(SMALL).color(p.quiet));
                }
                it = it.child(top);
                let detail = str_of(item, "detail");
                if !detail.is_empty() {
                    it = it.child(text(detail.to_string()).font(SMALL).color(p.muted).wrap());
                }
                c = c.child(it);
            }
            c
        }
        "facts" => arr(b, "rows").iter().fold(col().w_full().gap(6.0), |c, r| {
            c.child(
                row()
                    .w_full()
                    .gap(14.0)
                    .child(text(str_of(r, "label").to_string()).font(META).color(p.muted).w(120.0))
                    .child(text(value_text(r.get("value"))).font(META).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0).selectable(true)),
            )
        }),
        "status" => {
            let tone = str_of(b, "tone");
            let (glyph, color) = match tone {
                "success" => (&icons::CHECK_CIRCLE, p.success),
                "warning" => (&icons::ALERT, p.warning),
                "error" => (&icons::ALERT, p.danger),
                _ => (&icons::CIRCLE, p.muted),
            };
            row().w_full().gap(8.0).center_y().child(icon(glyph, 13.0).color(color)).child(text(str_of(b, "text").to_string()).font(META).color(color).wrap().shrink())
        }
        "stats" => {
            let mut grid = row().w_full().flex_wrap().gap(1.0).radius(8.0).clip_rounded(8.0).fill(p.line).border(1.0, p.line);
            for item in arr(b, "items") {
                let color = match str_of(item, "tone") {
                    "success" => p.success,
                    "warning" => p.warning,
                    "error" => p.danger,
                    _ => p.ink,
                };
                let mut value = row().gap(0.0).center_y();
                if let Some(n) = item.get("series").and_then(Value::as_u64) {
                    value = value.child(swatch(series(p, n.saturating_sub(1) as usize)));
                }
                value = value.child(text(value_text(item.get("value"))).font(STAT).color(color));
                grid = grid.child(col().grow(1.0).min_w(110.0).gap(2.0).px(11.0).py(9.0).fill(p.surface).child(value).child(text(str_of(item, "label").to_string()).font(TINY).color(p.quiet)));
            }
            grid
        }
        "chart" => chart(b, p),
        "table" => table(b, p),
        "tabs" => {
            let tabs = arr(b, "tabs");
            let key = format!("{}:{path}", x.call);
            let on = x.s.card_tabs.get(&key).copied().unwrap_or(0).min(tabs.len().saturating_sub(1));
            let mut strip = row().w_full().gap(2.0).border_sides([0.0, 0.0, 1.0, 0.0], p.line);
            for (i, t) in tabs.iter().enumerate() {
                let k = key.clone();
                let mut tab = col()
                    .key(&format!("card-tab:{key}:{i}"))
                    .role("tab")
                    .label(str_of(t, "label"))
                    .px(9.0)
                    .pt(4.0)
                    .child(text(str_of(t, "label").to_string()).font(SMALL).color(if i == on { p.ink } else { p.quiet }))
                    .child(el().h(2.0).w_full().mt(5.0).fill(if i == on { p.ink } else { Color::TRANSPARENT }))
                    .on_press(move |s: &mut State| s.card_tab(&k, i));
                if i != on {
                    tab = tab.hover(p.hover);
                }
                strip = strip.child(tab);
            }
            // Questions in the hidden tabs still count, so the shown tab's keep their places.
            let mut panel = col().w_full().gap(12.0);
            for (i, t) in tabs.iter().enumerate() {
                if i == on {
                    panel = blocks(panel, arr(t, "blocks"), x, q, &format!("{path}.t{i}"));
                } else {
                    *q += questions(&serde_json::json!({ "blocks": t.get("blocks") })).len();
                }
            }
            col().w_full().gap(12.0).child(strip).child(panel)
        }
        "columns" => {
            let mut r = row().w_full().flex_wrap().gap(20.0);
            for (i, c) in arr(b, "columns").iter().enumerate() {
                let inner = blocks(col().gap(12.0), c.as_array().map(Vec::as_slice).unwrap_or(&[]), x, q, &format!("{path}.c{i}"));
                r = r.child(inner.grow(1.0).min_w(240.0).shrink());
            }
            r
        }
        "image" | "audio" | "video" => media(b, x),
        "page" => page(b, x),
        "routine" => row()
            .w_full()
            .gap(10.0)
            .px(12.0)
            .py(10.0)
            .radius(8.0)
            .border(1.0, p.line)
            .fill(p.surface)
            .center_y()
            .child(icon(&icons::CLOCK, 14.0).color(p.muted))
            .child(text(format!("Routine {}", str_of(b, "routine"))).font(META).color(p.ink)),
        "choice" => {
            let at = *q;
            *q += 1;
            choice(b, at, x)
        }
        "input" => {
            let at = *q;
            *q += 1;
            field(b, at, x)
        }
        "buttons" => {
            let all = arr(b, "buttons");
            let mut r = row().w_full().flex_wrap().justify_end().gap(8.0);
            for (i, btn) in all.iter().enumerate() {
                let label = str_of(btn, "label").to_string();
                let url = str_of(btn, "url");
                if url.starts_with("http://") || url.starts_with("https://") {
                    let tone = btn.get("tone").and_then(Value::as_str).unwrap_or(if all.len() == 1 { "primary" } else { "default" });
                    let url = url.to_string();
                    r = r.child(
                        button_el(&format!("{}:btn{i}", x.call), &label, tone, false, false, p)
                            .child(icon(&icons::EXTERNAL, 12.0).color(if tone == "primary" { p.user_ink } else { p.muted }))
                            .on_press_tx(move |_: &mut State, tx| {
                                let _ = tx.open_url(&url);
                            }),
                    );
                    continue;
                }
                let reply = btn.get("reply").and_then(Value::as_str).unwrap_or(&label).to_string();
                let on = x.pressed.as_deref() == Some(reply.as_str());
                let mut el = button_el(&format!("{}:btn{i}", x.call), &label, str_of(btn, "tone"), !x.live && !on, on, p);
                if x.live {
                    let (call, session) = (x.call.to_string(), x.session.to_string());
                    el = el.on_press(move |s: &mut State| s.card_send(&session, &call, Some(reply.clone())));
                }
                r = r.child(el);
            }
            r
        }
        _ => return None,
    })
}

fn value_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// A pill button, as `.ui-button`: primary is ink, danger is outlined red.
pub fn button_el(key: &str, label: &str, tone: &str, disabled: bool, on: bool, p: &Palette) -> El {
    let (fill, ink, edge) = match tone {
        "primary" => (p.ink, p.user_ink, p.ink),
        "danger" => (p.surface, p.danger, p.danger),
        _ => (p.surface, p.ink, p.line_strong),
    };
    let (fill, ink, edge) = if on { (p.ink, p.user_ink, p.ink) } else { (fill, ink, edge) };
    let mut b = row()
        .key(&format!("button:{key}"))
        .role("button")
        .label(label)
        .min_h(36.0)
        .px(15.0)
        .gap(6.0)
        .center()
        .radius(18.0)
        .fill(fill)
        .border(1.0, edge)
        .child(text(label.to_string()).font(BUTTON).color(ink));
    if disabled {
        b = b.opacity(0.4);
    }
    b
}

fn choice(b: &Value, at: usize, x: &Ctx) -> El {
    let p = x.p;
    let multiple = b.get("multiple") == Some(&Value::Bool(true));
    let mut c = col().w_full().child(text(str_of(b, "label").to_string()).font(QUESTION).color(p.ink).wrap());
    let hint = match str_of(b, "hint") {
        "" if multiple => "Choose all that apply",
        h => h,
    };
    if !hint.is_empty() {
        c = c.child(text(hint.to_string()).font(SMALL).color(p.muted).mt(2.0).wrap());
    }
    let chosen = x.values.get(at).cloned().unwrap_or_default();
    let mut options = col().w_full().gap(6.0).mt(10.0);
    for (i, o) in arr(b, "options").iter().enumerate().take(12) {
        let label = str_of(o, "label").to_string();
        let on = chosen.contains(&label);
        let key_cell = if on {
            el().size(22.0, 22.0).radius(11.0).fill(p.ink).center().child(icon(&icons::CHECK, 12.0).color(p.user_ink))
        } else {
            el().size(22.0, 22.0).radius(11.0).fill(p.surface).border(1.0, p.line_strong).center().child(text((LETTERS[i] as char).to_string()).font(TextStyle::new(11.0, 600.0).lh(14.0)).color(p.muted))
        };
        let mut words = col().grow(1.0).shrink().min_w(0.0).child(text(label.clone()).font(META).color(p.ink).wrap());
        let detail = str_of(o, "detail");
        if !detail.is_empty() {
            words = words.child(text(detail.to_string()).font(SMALL).color(p.muted).wrap());
        }
        let mut opt = row()
            .key(&format!("option:{}:{at}:{i}", x.call))
            .role("button")
            .label(&label)
            .w_full()
            .min_h(44.0)
            .pl(10.0)
            .pr(12.0)
            .py(8.0)
            .gap(10.0)
            .center_y()
            .radius(12.0)
            .fill(if on { p.surface } else { p.sunken })
            .border(1.0, if on { p.ink } else { Color::TRANSPARENT })
            .child(key_cell)
            .child(words);
        if x.live {
            let (call, session) = (x.call.to_string(), x.session.to_string());
            opt = opt.hover(p.selected).on_press(move |s: &mut State| s.card_choose(&session, &call, at, &label, multiple));
        } else if !on {
            opt = opt.opacity(0.45);
        }
        options = options.child(opt);
    }
    c.child(options)
}

fn field(b: &Value, at: usize, x: &Ctx) -> El {
    let p = x.p;
    let mut c = col().w_full().child(text(str_of(b, "label").to_string()).font(QUESTION).color(p.ink).wrap());
    if !x.live {
        let typed = x.values.get(at).map(|v| v.join(", ")).unwrap_or_default();
        if !typed.is_empty() {
            c = c.child(text(typed).font(META).color(p.muted).mt(6.0).wrap());
        }
        return c;
    }
    let key = format!("{}:{at}", x.call);
    let edit = x.s.fields.get(&key).cloned().unwrap_or_else(|| rune::TextEdit::new(""));
    let placeholder = match str_of(b, "placeholder") {
        "" => "Type here",
        h => h,
    };
    let k = key.clone();
    let mut input = text_input(&edit, META)
        .key(&format!("field:{key}"))
        .label(str_of(b, "label"))
        .placeholder(placeholder, p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .px(12.0)
        .py(10.0)
        .radius(12.0)
        .fill(p.sunken)
        .on_edit(move |s: &mut State| s.card_field(&k));
    if b.get("multiline") == Some(&Value::Bool(true)) {
        input = input.min_h(72.0);
    }
    let mut r = row().w_full().gap(6.0).mt(8.0);
    if x.lone_field {
        let (call, session) = (x.call.to_string(), x.session.to_string());
        let (c2, s2) = (call.clone(), session.clone());
        input = input.on_submit(move |s: &mut State, _| s.card_send(&s2, &c2, None));
        let empty = edit.text.trim().is_empty();
        let mut done = el()
            .key(&format!("done:{key}"))
            .role("button")
            .label("Send answer")
            .w(44.0)
            .radius(12.0)
            .fill(p.ink)
            .center()
            .child(icon(&icons::CHECK, 14.0).color(p.user_ink))
            .on_press(move |s: &mut State| s.card_send(&session, &call, None));
        if empty {
            done = done.opacity(0.35);
        }
        r = r.child(input).child(done);
    } else {
        r = r.child(input);
    }
    c.child(r)
}

/// An image, a voice note or a video: what it is, its caption, and Open, in the browser signed in to ky.
fn media(b: &Value, x: &Ctx) -> El {
    let p = x.p;
    let src = str_of(b, "src");
    let url = if src.len() == 32 && src.bytes().all(|c| c.is_ascii_hexdigit()) { format!("{}/files/{src}", x.base) } else { src.to_string() };
    let kind = str_of(b, "type");
    let caption = match str_of(b, "caption") {
        "" => match kind {
            "image" => "Image",
            "audio" => "Voice note",
            _ => "Video",
        },
        c => c,
    };
    // An image shows itself, its caption under it; a press opens it full size (the web's `ImageBlock`).
    if kind == "image" {
        if let Some(bytes) = x.s.picture_bytes(src) {
            let shown = x.s.images.load(bytes.clone());
            let label = caption.to_string();
            let mut picture = el()
                .key(&format!("{}:image:{src}", x.call))
                .role("button")
                .label(&format!("Open {label}"))
                .w_full()
                .radius(10.0)
                .clip_rounded(10.0)
                .border(1.0, p.line)
                .on_press(move |s: &mut State| s.open_pictures(vec![bytes.clone()], 0, &label));
            picture = match shown.size() {
                Some([w, h]) if w > 0 && h > 0 => {
                    let k = (420.0 / h as f32).min(1.0);
                    picture.max_w(w as f32 * k).aspect_ratio(w as f32 / h as f32).pixels_fit(shown.pixels(), rune::SurfaceFit::Fill)
                }
                _ => picture.h(160.0).fill(p.sunken).pixels_fit(shown.pixels(), rune::SurfaceFit::Fill),
            };
            let mut figure = col().w_full().gap(6.0).child(picture);
            if !str_of(b, "caption").is_empty() {
                figure = figure.child(text(caption.to_string()).font(META).color(p.muted).wrap());
            }
            return figure;
        }
        if !x.s.picture_failed(src) {
            return el().key(&format!("{}:loading:{src}", x.call)).w_full().h(160.0).radius(10.0).fill(p.sunken);
        }
    }
    let glyph = if kind == "image" { &icons::FILE } else { &icons::PLAY };
    row()
        .w_full()
        .gap(10.0)
        .px(12.0)
        .py(10.0)
        .radius(10.0)
        .fill(p.sunken)
        .center_y()
        .child(icon(glyph, 15.0).color(p.muted))
        .child(text(caption.to_string()).font(META).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0))
        .child(open_button(&format!("{}:{src}", x.call), "Open", url, p))
}

/// A page ky built (`/s/<site>/`), live in the card as the web's iframe is (`crate::pages` lays a
/// web view over this space), and Open in the browser under it.
fn page(b: &Value, x: &Ctx) -> El {
    let p = x.p;
    let site = str_of(b, "site").to_string();
    let title = match str_of(b, "title") {
        "" => "Page",
        t => t,
    };
    let url = format!("{}/s/{site}/", x.base);
    let key = format!("{}:page:{site}", x.call);
    let height = x.s.pages.height(&key);
    let (session, base, embed) = (x.session.to_string(), x.base.clone(), url.clone());
    let place = el()
        .key(&key)
        .w_full()
        .h(height)
        .radius(12.0)
        .border(1.0, p.line)
        .fill(p.sunken)
        // Not `live_only`: with no live values on screen, Rune never clears the flag it sets, and the
        // window would draw every frame at rest.
        .on_drawn_layout(move |s: &mut State, _| {
            let source = || crate::pages::Source { url: embed.clone(), base: base.clone(), token: s.access_token() };
            s.pages.drawn(&key, &session, source, &s.wake, s.dark.get());
        });
    col()
        .w_full()
        .gap(6.0)
        .child(place)
        .child(row().w_full().justify_end().child(open_button(&format!("{}:page", x.call), &format!("Open {title}"), url, p)))
}

fn open_button(key: &str, label: &str, url: String, p: &Palette) -> El {
    button_el(key, label, "default", false, false, p).child(icon(&icons::EXTERNAL, 12.0).color(p.muted)).on_press_tx(move |_: &mut State, tx| {
        let _ = tx.open_url(&url);
    })
}

fn table(b: &Value, p: &Palette) -> El {
    let columns: Vec<String> = arr(b, "columns").iter().map(|c| value_text(Some(c))).collect();
    let rows: Vec<Vec<String>> = arr(b, "rows").iter().map(|r| r.as_array().map(|cells| cells.iter().map(|c| value_text(Some(c))).collect()).unwrap_or_default()).collect();
    let numeric = |cell: &str| {
        let t = cell.trim().trim_start_matches(['-', '+', '−']).trim_start_matches(['$', '€', '£', '¥']);
        let t = t.trim_end_matches(['%', 'k', 'K', 'm', 'M', 'b', 'B']).trim_end();
        !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',')
    };
    let right: Vec<bool> = (0..columns.len()).map(|i| !rows.is_empty() && rows.iter().all(|r| r.get(i).is_none_or(|c| numeric(c)))).collect();
    let cell = |content: String, i: usize, font: TextStyle, color: Color| {
        let t = text(content).font(font).color(color).wrap();
        let mut c = row().grow(1.0).min_w(0.0).pr(10.0);
        if right.get(i) == Some(&true) {
            c = c.justify_end();
        }
        c.child(t)
    };
    let mut t = col().w_full();
    if let Some(l) = label(b, p) {
        t = t.child(l);
    }
    let head = columns.iter().enumerate().fold(row().w_full().pb(6.0), |r, (i, c)| r.child(cell(c.clone(), i, LABEL, p.quiet)));
    t = t.child(head);
    for r in rows {
        let line = (0..columns.len()).fold(row().w_full().py(7.0).border_sides([1.0, 0.0, 0.0, 0.0], p.line), |line, i| line.child(cell(r.get(i).cloned().unwrap_or_default(), i, CELL, p.ink)));
        t = t.child(line);
    }
    t
}

fn series(p: &Palette, i: usize) -> Color {
    p.chart[i % 6]
}

fn swatch(color: Color) -> El {
    el().size(8.0, 8.0).radius(2.0).fill(color).mr(6.0)
}

fn number(v: f64, unit: &str) -> String {
    let rounded = (v * 10.0).round() / 10.0;
    let s = if rounded.fract() == 0.0 { format!("{}", rounded as i64) } else { format!("{rounded:.1}") };
    // Thousands, as Intl groups them.
    let (int, frac) = s.split_once('.').map_or((s.as_str(), None), |(a, b)| (a, Some(b)));
    let (sign, digits) = int.strip_prefix('-').map_or(("", int), |d| ("-", d));
    let mut grouped = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("{sign}{grouped}{}{unit}", frac.map(|f| format!(".{f}")).unwrap_or_default())
}

fn chart(b: &Value, p: &Palette) -> El {
    let unit = str_of(b, "unit");
    let x: Vec<String> = arr(b, "x").iter().map(|v| value_text(Some(v))).collect();
    let all: Vec<(String, Vec<f64>)> = arr(b, "series").iter().map(|s| (str_of(s, "name").to_string(), arr(s, "values").iter().map(|v| v.as_f64().unwrap_or(0.0)).collect())).collect();
    let kind = str_of(b, "kind");
    let mut c = col().w_full();
    if let Some(l) = label(b, p) {
        c = c.child(l);
    }
    c = c.child(match kind {
        "line" => line_chart(&x, &all, unit, p),
        "donut" => donut(&x, &all, unit, p),
        _ => bars(&x, &all, b.get("stacked") == Some(&Value::Bool(true)) && all.len() > 1, unit, p),
    });
    if kind != "donut" && all.len() > 1 {
        let legend = all.iter().enumerate().fold(row().w_full().flex_wrap().gap(14.0).mt(10.0), |r, (i, (name, _))| {
            r.child(row().center_y().child(swatch(series(p, i))).child(text(name.clone()).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(p.muted)))
        });
        c = c.child(legend);
    }
    c
}

fn bars(x: &[String], all: &[(String, Vec<f64>)], stacked: bool, unit: &str, p: &Palette) -> El {
    let at = |s: &Vec<f64>, i: usize| s.get(i).copied().unwrap_or(0.0).max(0.0);
    let max = (0..x.len())
        .map(|i| if stacked { all.iter().map(|(_, s)| at(s, i)).sum::<f64>() } else { all.iter().map(|(_, s)| at(s, i)).fold(0.0, f64::max) })
        .fold(0.0, f64::max)
        .max(f64::MIN_POSITIVE);
    let font = TextStyle::new(12.0, 400.0).lh(16.0);
    let bold = TextStyle::new(12.0, 500.0).lh(16.0);
    let track = |parts: Vec<(f64, Color)>, total: f64, height: f32| {
        let filled: f64 = parts.iter().map(|(v, _)| v).sum();
        let mut fill = row().h(height).grow(1.0).gap(2.0).radius(3.0).clip_rounded(3.0);
        for (v, color) in parts {
            if v > 0.0 {
                fill = fill.child(el().h_full().grow(v as f32).radius(2.0).fill(color));
            }
        }
        fill = fill.child(el().h_full().grow((max - filled).max(0.0) as f32));
        row().w_full().gap(8.0).center_y().child(fill).child(row().w(44.0).justify_end().child(text(number(total, unit)).font(bold).color(p.ink)))
    };
    let mut c = col().w_full().gap(7.0);
    for (i, label) in x.iter().enumerate() {
        let shown = if stacked {
            let parts: Vec<(f64, Color)> = all.iter().enumerate().map(|(k, (_, s))| (at(s, i), series(p, k))).collect();
            let total = parts.iter().map(|(v, _)| v).sum();
            track(parts, total, 12.0)
        } else if all.len() == 1 {
            track(vec![(at(&all[0].1, i), series(p, 0))], at(&all[0].1, i), 12.0)
        } else {
            all.iter().enumerate().fold(col().grow(1.0).gap(3.0), |g, (k, (_, s))| g.child(track(vec![(at(s, i), series(p, k))], at(s, i), 8.0)))
        };
        c = c.child(row().w_full().gap(10.0).center_y().child(row().w(96.0).child(text(label.clone()).font(font).color(p.muted).max_lines(1))).child(shown.grow(1.0).shrink().min_w(0.0)));
    }
    c
}

fn line_chart(x: &[String], all: &[(String, Vec<f64>)], unit: &str, p: &Palette) -> El {
    let values = all.iter().flat_map(|(_, s)| s.iter().copied());
    let (lo, hi) = values.fold((0.0f64, 0.0f64), |(lo, hi), v| (lo.min(v), hi.max(v)));
    let span = (hi - lo).max(f64::MIN_POSITIVE);
    let n = x.len().max(2);
    let mut shape = Shape::new().view_box(100.0, 100.0);
    for k in 1..4 {
        let y = 25.0 * k as f32;
        shape = shape.line([0.0, y], [100.0, y], 0.6, LineCap::Butt, p.line);
    }
    for (k, (_, s)) in all.iter().enumerate() {
        let points: Vec<[f32; 2]> = s.iter().enumerate().map(|(i, v)| [100.0 * i as f32 / (n - 1) as f32, 100.0 - (100.0 * (v - lo) / span) as f32]).collect();
        shape = shape.stroke(points, 1.6, series(p, k));
    }
    let axis = TextStyle::new(11.5, 400.0).lh(15.0);
    let picks = [0, x.len() / 2, x.len().saturating_sub(1)];
    let mut ticks = row().w_full().justify_between();
    for (j, i) in picks.iter().enumerate() {
        if j > 0 && picks[j - 1] == *i {
            continue;
        }
        ticks = ticks.child(text(x.get(*i).cloned().unwrap_or_default()).font(axis).color(p.quiet));
    }
    col()
        .w_full()
        .gap(4.0)
        .child(text(number(hi, unit)).font(axis).color(p.quiet))
        .child(canvas(shape).w_full().h(140.0).border_sides([0.0, 0.0, 1.0, 0.0], p.line_strong))
        .child(ticks)
}

fn donut(x: &[String], all: &[(String, Vec<f64>)], unit: &str, p: &Palette) -> El {
    let values: Vec<f64> = all.first().map(|(_, s)| s.iter().map(|v| v.max(0.0)).collect()).unwrap_or_default();
    let total: f64 = values.iter().sum::<f64>().max(f64::MIN_POSITIVE);
    // The web strokes r 15.915 at width 6 in a 42 box: a ring from 12.915 to 18.915. Filled as
    // short convex quads, so the ring has no joins to seam.
    let ring = |shape: Shape, from: f64, to: f64, color: Color| -> Shape {
        let steps = ((to - from) * 180.0).ceil().max(1.0) as usize;
        let at = |t: f64, r: f32| {
            let a = t * std::f64::consts::TAU - std::f64::consts::FRAC_PI_2;
            [21.0 + r * a.cos() as f32, 21.0 + r * a.sin() as f32]
        };
        (0..steps).fold(shape, |shape, i| {
            let a = from + (to - from) * i as f64 / steps as f64;
            let b = from + (to - from) * (i + 1) as f64 / steps as f64;
            // A hair of overlap, so neighbours' antialiased edges don't show a gap.
            let b2 = (b + 0.0008).min(to.max(b));
            shape.fill(vec![at(a, 18.915), at(b2, 18.915), at(b2, 12.915), at(a, 12.915)], color)
        })
    };
    let mut shape = ring(Shape::new().view_box(42.0, 42.0), 0.0, 1.0, p.raised);
    let mut start = 0.0;
    for (i, v) in values.iter().enumerate() {
        let part = v / total;
        if part > 0.0 {
            shape = ring(shape, start, start + part, series(p, i));
        }
        start += part;
    }
    let font = TextStyle::new(12.5, 400.0).lh(17.0);
    let legend = x.iter().enumerate().fold(col().grow(1.0).shrink().gap(6.0), |c, (i, label)| {
        let v = values.get(i).copied().unwrap_or(0.0);
        c.child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(swatch(series(p, i)))
                .child(text(label.clone()).font(font).color(p.muted).grow(1.0).shrink().max_lines(1))
                .child(text(number(v, unit)).font(TextStyle::new(12.5, 500.0).lh(17.0)).color(p.ink))
                .child(row().w(40.0).justify_end().child(text(format!("{}%", (100.0 * v / total).round())).font(font).color(p.quiet))),
        )
    });
    row().w_full().gap(16.0).center_y().child(canvas(shape).size(112.0, 112.0)).child(legend)
}

/// One approval, as the web draws it at the foot of its chat.
pub fn approval(a: &Approval, p: &Palette) -> El {
    let handoff = a.kind == "browser-handoff";
    let lapsed = a.lapsed_at.is_some();
    let title = match a.kind.as_str() {
        "executor" => "Approve this app action?",
        "webhook-action" => "Approve this, on a webhook's data?",
        "secret-request" => "Approve this call with a credential?",
        "browser-handoff" => "ky needs you in its browser",
        "browse-steps" => "Let ky act where you're signed in?",
        _ => "Approve this?",
    };
    let glyph = match a.kind.as_str() {
        "browser-handoff" | "browse-steps" => &icons::GLOBE,
        "secret-request" => &icons::KEY,
        _ => &icons::PLUG,
    };
    let mut head = row()
        .w_full()
        .gap(10.0)
        .center_y()
        .child(el().size(28.0, 28.0).radius(9.0).fill(p.raised).center().child(icon(glyph, 15.0).color(p.muted)))
        .child(text(title).font(TITLE).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0));
    if !a.subject.is_empty() {
        head = head.child(text(a.subject.clone()).font(TINY).color(p.quiet).max_lines(1).shrink());
    }
    let mut c = col().key(&format!("approval:{}", a.id)).w_full().pt(18.0).px(18.0).pb(16.0).gap(14.0).radius(16.0).fill(p.surface).border(1.0, p.line).shadow(4.0, 16.0, p.shadow).child(head);
    if !a.summary.is_empty() {
        c = c.child(text(a.summary.clone()).font(BODY).color(p.ink).wrap().selectable(true));
    }
    let note = if lapsed {
        "Expired · Nobody answered within 24 hours, so nothing was done. Ask ky again if it still matters."
    } else if handoff {
        "What you do there stays in the cloud browser. Once you're done, ky keeps this site's login in its Vault for whoever asked; Settings › Webhooks lists it to move or remove."
    } else {
        "Only your tap approves it: ky can't, and nobody else can."
    };
    if !lapsed {
        let id = a.id.clone();
        let mut actions = row().w_full().flex_wrap().justify_end().gap(8.0);
        if handoff {
            if let Some(link) = a.link.clone() {
                actions = actions.child(button_el(&format!("{id}:take"), "Take over", "default", false, false, p).child(icon(&icons::EXTERNAL, 12.0).color(p.muted)).on_press_tx(move |_: &mut State, tx| {
                    let _ = tx.open_url(&link);
                }));
            }
        }
        let (yes, no) = if handoff { ("I'm done", "I couldn't") } else { ("Approve", "Decline") };
        let (i1, i2) = (id.clone(), id.clone());
        actions = actions
            .child(button_el(&format!("{id}:no"), no, "danger", false, false, p).on_press(move |s: &mut State| s.decide(&i2, false)))
            .child(button_el(&format!("{id}:yes"), yes, "primary", false, false, p).on_press(move |s: &mut State| s.decide(&i1, true)));
        c = c.child(actions);
    }
    c.child(text(note).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(p.quiet).wrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_answer_reads_as_the_web_composes_it() {
        let spec = json!({"blocks": [{"type": "choice", "label": "Where", "options": [{"label": "Lisbon"}]}, {"type": "input", "label": "When"}]});
        let qs = questions(&spec);
        assert_eq!(compose(&qs, &[vec!["Lisbon".into()], vec!["March".into()]]), "Where: Lisbon\nWhen: March");
        assert!(needs_send(&qs));
        assert!(!answered(&qs, &[vec!["Lisbon".into()], vec![" ".into()]]));
        let one = json!({"blocks": [{"type": "choice", "label": "Pick", "multiple": true, "options": []}]});
        assert_eq!(compose(&questions(&one), &[vec!["a".into(), "b".into()]]), "a, b");
        assert!(needs_send(&questions(&one)));
        let lone = json!({"blocks": [{"type": "tabs", "tabs": [{"label": "A", "blocks": [{"type": "choice", "label": "Pick", "options": []}]}]}]});
        assert!(lone_choice(&questions(&lone)));
    }

    #[test]
    fn numbers_group_as_intl_does() {
        assert_eq!(number(1234567.0, ""), "1,234,567");
        assert_eq!(number(12.34, "%"), "12.3%");
        assert_eq!(number(-980.0, "ms"), "-980ms");
    }
}
