//! An assistant turn as the web's thread draws it (`src/ui/Thread.tsx`, `src/chat-kit/ToolRow.tsx`,
//! `src/chat-kit/chat.css`): a "Worked for 12s · 5 steps" line over the work log (tool rows,
//! commentary, thoughts), the answer, then the cards the turn showed. While the turn runs the log
//! stays open; once done it folds behind the Worked line.
//!
//! Each tool reads as a phrase from `describe` (the web's `turns.ts` table): "Read src/a.ts",
//! "Ran npm test", "Called Executor · Send mail". A run of reads, lists and searches folds into one
//! "Explored 3 files, 2 searches" row.

use rune::{El, TextStyle, col, el, icon, row, text};
use rune_kit::{Markdown, MarkdownStyle};
use serde_json::Value;

use crate::State;
use crate::chat::{End, Item, Row, Tool, ToolStatus};
use crate::theme::{META, Palette, icons};

pub const ROW_TEXT: TextStyle = TextStyle::new(12.5, 400.0).lh(18.0);
const ROW_STRONG: TextStyle = TextStyle::new(12.5, 500.0).lh(18.0);
const MONO: TextStyle = TextStyle::new(11.5, 400.0).lh(17.0).mono();
const LOG_TEXT: TextStyle = TextStyle::new(13.5, 400.0).lh(21.6);
const THOUGHT: TextStyle = TextStyle::new(12.5, 400.0).lh(18.75).italic();

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Category {
    Inspect,
    Change,
    Run,
    Research,
    Agent,
    Other,
}

/// A tool call as a row reads it: its category, an imperative summary, and what it was given.
pub struct Described {
    pub category: Category,
    pub summary: String,
    pub input: String,
}

fn s<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

fn or<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.is_empty() { b } else { a }
}

fn short(value: &str) -> String {
    if value.chars().count() > 80 { format!("{}…", value.chars().take(79).collect::<String>()) } else { value.to_string() }
}

fn first_line(value: &str) -> &str {
    value.trim().lines().next().unwrap_or("")
}

fn capital(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

fn pretty(args: &Value) -> String {
    if args.is_null() { "{}".into() } else { serde_json::to_string_pretty(args).unwrap_or_default() }
}

/// The web's `describe` (`src/ui/turns.ts`).
pub fn describe(name: &str, args: &Value) -> Described {
    let path = or(or(s(args, "path"), s(args, "file_path")), s(args, "dir"));
    let d = |category, summary: String, input: String| Described { category, summary, input };
    match name {
        "read" => d(Category::Inspect, format!("Read {path}"), String::new()),
        "ls" => d(Category::Inspect, format!("List {}", or(path, "/workspace")), String::new()),
        "find" | "grep" => d(Category::Inspect, format!("Search {}", short(or(or(s(args, "pattern"), s(args, "query")), path))), String::new()),
        "write" => d(Category::Change, format!("Write {path}"), String::new()),
        "edit" => d(Category::Change, format!("Edit {path}"), String::new()),
        "delete" => d(Category::Change, format!("Delete {path}"), String::new()),
        "exec" => {
            let source = or(or(s(args, "code"), s(args, "command")), s(args, "source"));
            let summary = short(first_line(source));
            d(Category::Run, if summary.is_empty() { "exec".into() } else { summary }, source.to_string())
        }
        "executor_skills" => d(Category::Research, format!("Read {}", or(or(s(args, "app"), s(args, "name")), "skills")), pretty(args)),
        "executor_execute" | "executor_resume" => {
            let what = short(first_line(or(s(args, "description"), s(args, "code"))));
            let input = if s(args, "code").is_empty() { pretty(args) } else { s(args, "code").to_string() };
            d(Category::Research, format!("Executor · {}", or(&what, name)), input)
        }
        "subagent" | "machine" => {
            let who = or(or(s(args, "name"), s(args, "machine")), s(args, "task"));
            let verb = match s(args, "action") {
                "spawn" | "run" => "Start",
                "send" => "Message",
                "stop" => "Stop",
                _ => "List",
            };
            let title = s(args, "title");
            let target = [who, title].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ");
            let target = if target.is_empty() { name.to_string() } else { target };
            let summary = if verb == "Stop" { format!("Stopped {target}") } else { format!("{verb} {target}") };
            d(Category::Agent, summary, or(s(args, "message"), s(args, "prompt")).to_string())
        }
        "skill_view" => d(Category::Research, format!("Read skill {}", s(args, "name")), pretty(args)),
        "soul_edit" => match s(args, "action") {
            "view" | "history" => d(Category::Research, "Read SOUL.md".into(), String::new()),
            action => d(Category::Change, format!("{} SOUL.md", capital(action)), or(or(s(args, "body"), s(args, "new")), &pretty(args)).to_string()),
        },
        "skill_manage" => d(
            Category::Change,
            format!("{} skill {}", capital(s(args, "action")), s(args, "name")),
            or(or(s(args, "body"), s(args, "new")), &pretty(args)).to_string(),
        ),
        _ if name.starts_with("memory_") => {
            d(Category::Other, format!("{} memory", capital(&name[7..])), or(or(s(args, "text"), s(args, "query")), &pretty(args)).to_string())
        }
        _ => d(Category::Other, name.to_string(), pretty(args)),
    }
}

const TENSES: &[(&str, &str, &str)] = &[
    ("Read", "Reading", "Read"),
    ("Search", "Searching", "Searched"),
    ("List", "Listing", "Listed"),
    ("Edit", "Editing", "Edited"),
    ("Delete", "Deleting", "Deleted"),
    ("Write", "Writing", "Wrote"),
    ("Start", "Starting", "Started"),
    ("Message", "Messaging", "Messaged"),
];

/// A row's words: the summary's verb in the tool's tense, then its target.
pub fn phrase(status: ToolStatus, d: &Described) -> (String, String, bool) {
    let tense = |running: &str, done: &str| match status {
        ToolStatus::Failed => "Failed".to_string(),
        ToolStatus::Running => running.to_string(),
        ToolStatus::Done => done.to_string(),
    };
    if d.category == Category::Run {
        return (tense("Running", "Ran"), d.summary.clone(), true);
    }
    if d.category == Category::Research && d.summary.contains(" · ") {
        return (tense("Calling", "Called"), d.summary.clone(), false);
    }
    let (first, rest) = d.summary.split_once(' ').unwrap_or((&d.summary, ""));
    match TENSES.iter().find(|(verb, ..)| *verb == first) {
        Some((_, running, done)) => {
            let verb = if status == ToolStatus::Running { running } else { done };
            (verb.to_string(), rest.to_string(), !["Search", "Start", "Message"].contains(&first))
        }
        None => (d.summary.clone(), String::new(), false),
    }
}

/// Markdown as the chat shows it: its pictures fetched from ky or the web, each opening the lightbox.
pub fn md(s: &State, source: impl Into<String>) -> Markdown {
    let source: String = source.into();
    let found: std::collections::HashMap<String, (rune::Image, std::sync::Arc<[u8]>)> = crate::remote::markdown_sources(&source)
        .into_iter()
        .filter_map(|src| {
            let bytes = s.picture_bytes(&src)?;
            Some((src, (s.images.load(bytes.clone()), bytes)))
        })
        .collect();
    let all: Vec<std::sync::Arc<[u8]>> = found.values().map(|(_, b)| b.clone()).collect();
    let lookup = found.clone();
    Markdown::new(source)
        .images(move |src| lookup.get(src).map(|(image, _)| image.clone()))
        .image_frame(move |e, frame| {
            let Some((_, bytes)) = found.get(frame.src) else { return e };
            let at = all.iter().position(|b| std::sync::Arc::ptr_eq(b, bytes)).unwrap_or(0);
            let all = all.clone();
            e.role("button").on_press(move |s: &mut State| s.open_pictures(all.clone(), at, "Image"))
        })
}

/// "12s", "3m 4s", "1h 2m": the web's `duration`.
pub fn duration(ms: f64) -> String {
    let seconds = (ms / 1000.0).round().max(0.0) as u64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {}s", seconds % 60);
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

/// A tool's status as the row shows it: a call with no result is cut off once the turn is over.
fn status_of(tool: &Tool, live: bool) -> ToolStatus {
    if tool.status == ToolStatus::Running && !live { ToolStatus::Failed } else { tool.status }
}

/// What an assistant row draws.
pub struct Turn<'a> {
    pub r: &'a Row,
    pub session: &'a str,
    /// This turn's cards take taps: it is the chat's latest and ky isn't busy.
    pub open: bool,
}

/// One assistant turn: the Worked line and its log, the answer, and its cards.
pub fn assistant(t: &Turn, s: &State, markdown: &MarkdownStyle, p: &Palette) -> El {
    let r = t.r;
    let shown: Vec<&Item> = r.items.iter().filter(|i| !matches!(i, Item::Tool(tool) if tool.name == "ui")).collect();
    // The answer is the turn's last text (the web's `split`). While the turn streams it's the answer
    // from its first token, so it doesn't restyle when the turn ends; once a tool call or thinking
    // follows it, it was commentary and joins the log. An error after it doesn't take it.
    let answer_at = shown.iter().rposition(|i| matches!(i, Item::Text { .. })).filter(|&at| {
        let Item::Text { last, .. } = shown[at] else { return false };
        let followed = shown[at + 1..].iter().any(|i| matches!(i, Item::Tool(_) | Item::Thinking(_)));
        *last || !r.live || !followed
    });
    // A finished turn's errors leave the log, so they show when it folds.
    let errors: Vec<&String> = if r.live { Vec::new() } else { shown.iter().filter_map(|i| if let Item::Notice(why) = i { Some(why) } else { None }).collect() };
    let log: Vec<&Item> = shown
        .iter()
        .enumerate()
        .filter(|(i, item)| Some(*i) != answer_at && (r.live || !matches!(item, Item::Notice(_))))
        .map(|(_, item)| *item)
        .collect();
    let mut c = col().w_full().gap(8.0);
    if !log.is_empty() {
        let key = format!("log:{}:{}", t.session, r.key);
        let expanded = r.live || s.open.contains(&key);
        if !r.live {
            c = c.child(worked(r, &log, &key, expanded, p));
        }
        if expanded {
            c = c.child(worklog(&log, r, t.session, s, p));
        }
    }
    for why in errors {
        c = c.child(error_notice(why, p));
    }
    if let Some(Item::Text { text, .. }) = answer_at.map(|i| shown[i]) {
        c = c.child(md(s, text.clone()).streaming(r.live).selectable(true).render(markdown));
    }
    for card in crate::cards::of_turn(r) {
        c = c.child(crate::cards::card(&card, t, s, markdown, p));
    }
    let answer = answer_at.and_then(|i| if let Item::Text { text, .. } = shown[i] { Some(text.as_str()) } else { None });
    if r.live {
        c = c.child(working_line(r, &log, answer.is_some(), t.session, s, p));
    } else {
        c = c.child(turn_end(r, answer, t.session, p));
    }
    c
}

/// While ky works: its bloub, what it's at, for how long, and the steps so far (the web's `WorkingLine`).
fn working_line(r: &Row, log: &[&Item], writing: bool, session: &str, s: &State, p: &Palette) -> El {
    let running = log.last().is_some_and(|i| matches!(i, Item::Tool(t) if t.status == ToolStatus::Running));
    let phase = if running { None } else if writing { Some("Writing") } else { Some("Thinking") };
    let steps = log.iter().filter(|i| matches!(i, Item::Tool(_))).count();
    let mut line = row()
        .gap(8.0)
        .center_y()
        .pt(4.0)
        .child(crate::bloub::of(s, crate::bloub::KY, &format!("working:{session}"), 20.0, crate::bloub::Mood::Working, false, p));
    if let Some(phase) = phase {
        line = line.child(text(phase).font(LOG_TEXT).color(p.muted));
    }
    if let Some(a) = r.started {
        line = line.child(text(duration(crate::time::now_ms() - a)).font(LOG_TEXT).color(p.quiet));
    }
    if steps > 0 {
        line = line.child(text(format!("{steps} {}", if steps == 1 { "step" } else { "steps" })).font(LOG_TEXT).color(p.quiet));
    }
    line
}

/// Under a finished turn: whether it was interrupted or failed, then Copy (the web's `TurnEnd`).
fn turn_end(r: &Row, answer: Option<&str>, session: &str, p: &Palette) -> El {
    // A turn cut off mid-tool was interrupted, though its last message didn't say so.
    let end = if r.end == End::Done && r.tools().any(|t| t.status == ToolStatus::Running) { End::Aborted } else { r.end };
    let mut line = row().gap(6.0).center_y().min_h(24.0);
    match end {
        End::Aborted => {
            line = line.child(
                row()
                    .h(20.0)
                    .px(7.0)
                    .gap(5.0)
                    .center_y()
                    .radius(10.0)
                    .fill(p.hover)
                    .child(icon(&icons::STOP, 9.0).color(p.quiet))
                    .child(text("Interrupted").font(LOG_TEXT).color(p.quiet)),
            )
        }
        End::Failed => {
            line = line.child(icon(&icons::ALERT, 13.0).color(p.danger)).child(text("Turn failed").font(LOG_TEXT).color(p.danger))
        }
        End::Done => {}
    }
    if let Some(answer) = answer {
        let answer = answer.to_string();
        line = line.child(
            row()
                .key(&format!("copy:{session}:{}", r.key))
                .role("button")
                .label("Copy answer")
                .size(24.0, 24.0)
                .ml(if end == End::Done { -6.0 } else { 0.0 })
                .center()
                .radius(6.0)
                .hover(p.hover)
                .child(icon(&icons::COPY, 13.0).color(p.quiet))
                .on_press(move |_: &mut State| crate::settings::actions::copy(&answer)),
        );
    }
    line
}

/// "Worked for 12s · 5 steps", a toggle for the log.
fn worked(r: &Row, log: &[&Item], key: &str, expanded: bool, p: &Palette) -> El {
    let steps = log.iter().filter(|i| matches!(i, Item::Tool(_))).count();
    let aborted = r.end != End::Done || r.tools().any(|t| t.status == ToolStatus::Running);
    let mut line = row().gap(0.0).child(text(if aborted { "Ran" } else { "Worked" }).font(ROW_TEXT).color(p.quiet));
    if let (Some(a), Some(b)) = (r.started, r.ended) {
        line = line.child(text(" for ").font(ROW_TEXT).color(p.quiet)).child(text(duration(b - a)).font(ROW_STRONG).color(p.muted));
    }
    if steps > 0 {
        line = line.child(text(format!(" · {steps} {}", if steps == 1 { "step" } else { "steps" })).font(ROW_TEXT).color(p.quiet));
    }
    let key = key.to_string();
    row()
        .key(&format!("worked:{key}"))
        .role("button")
        .label(if expanded { "Hide the work" } else { "Show the work" })
        .h(24.0)
        .ml(-6.0)
        .px(6.0)
        .gap(6.0)
        .center_y()
        .radius(6.0)
        .hover(p.hover)
        .child(line)
        .child(icon(if expanded { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet))
        .on_press(move |s: &mut State| s.toggle(&key))
}

/// The log: tool rows (a run of reads and searches as one Explored row), commentary and thoughts,
/// hung on one vertical rule.
fn worklog(log: &[&Item], r: &Row, session: &str, s: &State, p: &Palette) -> El {
    let mut out = col().w_full().gap(if r.live { 4.0 } else { 2.0 }).pl(2.0);
    let mut i = 0;
    while i < log.len() {
        match log[i] {
            Item::Tool(tool) => {
                // A run of inspections that didn't fail folds into one row.
                let mut j = i;
                while j < log.len() {
                    match log[j] {
                        Item::Tool(t) if describe(&t.name, &t.args).category == Category::Inspect && status_of(t, r.live) != ToolStatus::Failed => j += 1,
                        _ => break,
                    }
                }
                if j - i > 1 {
                    let tools: Vec<&Tool> = log[i..j].iter().filter_map(|item| if let Item::Tool(t) = item { Some(t) } else { None }).collect();
                    out = out.child(explored(&tools, r, session, s, p));
                    i = j;
                    continue;
                }
                out = out.child(tool_row(tool, r.live, session, s, p));
            }
            Item::Text { text: words, .. } => out = out.child(col().w_full().pl(22.0).py(4.0).child(text(words.trim().to_string()).font(LOG_TEXT).color(p.muted).wrap().selectable(true))),
            Item::Thinking(thought) => {
                let key = format!("thought:{session}:{}:{i}", r.key);
                let full = s.open.contains(&key);
                let mut line = text(thought.trim().replace("**", "")).font(THOUGHT).color(p.quiet).wrap();
                if !full {
                    line = line.max_lines(2);
                }
                out = out.child(
                    col().key(&format!("thought-row:{key}")).role("button").label("Thought").w_full().pl(22.0).py(2.0).child(line).on_press(move |s: &mut State| s.toggle(&key)),
                )
            }
            Item::Notice(why) => out = out.child(row().w_full().pl(22.0).py(4.0).child(text(why.clone()).font(LOG_TEXT).color(p.danger).wrap())),
        }
        i += 1;
    }
    // The rule the steps hang on, from the first dot to the last.
    el().w_full()
        .child(el().pin(Some(8.5), Some(13.0), None, Some(13.0)).w(1.0).fill(p.line_strong))
        .child(out)
}

fn dot(status: ToolStatus, p: &Palette) -> El {
    let tone = match status {
        ToolStatus::Running => p.ink,
        ToolStatus::Failed => p.danger,
        ToolStatus::Done => p.quiet,
    };
    // The page's ground behind the dot, so the log's rule passes behind it.
    el().size(14.0, 14.0).center().child(el().size(9.0, 9.0).radius(4.5).fill(p.bg).center().child(el().size(5.0, 5.0).radius(2.5).fill(tone)))
}

/// One tool: dot, verb, target, and a chevron that opens its input and output.
fn tool_row(tool: &Tool, live: bool, session: &str, s: &State, p: &Palette) -> El {
    let status = status_of(tool, live);
    let d = describe(&tool.name, &tool.args);
    let (verb, target, mono) = phrase(status, &d);
    let what = format!("{verb} {target}");
    let output = tool.output.trim_end_matches('\n').to_string();
    let has_body = !d.input.is_empty() || !output.is_empty();
    let key = format!("tool:{session}:{}", tool.id);
    let expanded = has_body && s.open.contains(&key);
    let mut line = row()
        .key(&format!("tool-row:{key}"))
        .w_full()
        .h(26.0)
        .ml(-6.0)
        .px(6.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .child(dot(status, p))
        .child(text(verb).font(ROW_TEXT).color(match status {
            ToolStatus::Running => p.ink,
            ToolStatus::Failed => p.danger,
            ToolStatus::Done => p.quiet,
        }));
    if !target.is_empty() {
        line = line.child(text(target).font(if mono { MONO } else { ROW_TEXT }).color(p.muted).max_lines(1).shrink().min_w(0.0));
    }
    if let Some(ms) = tool.ms.filter(|ms| *ms >= 1000.0) {
        line = line.child(text(duration(ms)).font(ROW_TEXT).color(p.quiet));
    }
    let help = if d.input.is_empty() { d.summary.clone() } else { d.input.clone() };
    line = line.help(help);
    if has_body {
        let k = key.clone();
        line = line
            .role("button")
            .label("Show the call")
            .hover(p.hover)
            .child(el().grow(1.0))
            .child(icon(if expanded { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet))
            .on_press(move |s: &mut State| s.toggle(&k));
    }
    let mut c = col().w_full().child(line);
    // An avatar tool's options, drawn, so the user picks by looking.
    let offered = crate::bloub::previews(&tool.output);
    if !offered.is_empty() {
        c = c.child(crate::bloub::options(s, &offered, &tool.id, p));
    }
    // What it saw, such as a browser screenshot, shows under its row without opening it.
    if !tool.images.is_empty() {
        let mut strip = row().w_full().gap(6.0).flex_wrap().pl(22.0).pt(4.0).pb(8.0);
        for (i, bytes) in tool.images.iter().enumerate() {
            let shown = s.images.load(bytes.clone());
            let all = tool.images.clone();
            let label = format!("Image {} from {what}", i + 1).trim().to_string();
            let mut tile = el()
                .key(&format!("{key}:image:{i}"))
                .role("button")
                .label(&format!("Open {label}"))
                .radius(8.0)
                .clip_rounded(8.0)
                .border(1.0, p.line)
                .on_press(move |s: &mut State| s.open_pictures(all.clone(), i, &label));
            tile = match shown.size() {
                Some([w, h]) if w > 0 && h > 0 => {
                    let k = (360.0 / w as f32).min(240.0 / h as f32).min(1.0);
                    tile.size(w as f32 * k, h as f32 * k).pixels_fit(shown.pixels(), rune::SurfaceFit::Fill)
                }
                _ => tile.size(160.0, 100.0).fill(p.sunken).pixels_fit(shown.pixels(), rune::SurfaceFit::Fill),
            };
            strip = strip.child(tile);
        }
        c = c.child(strip);
    }
    if expanded {
        let mut body = col().w_full().pl(22.0).pt(2.0).pb(6.0).gap(6.0);
        if !d.input.is_empty() {
            let shown = if d.category == Category::Run { format!("$ {}", d.input) } else { d.input.clone() };
            body = body.child(pre(shown, p.ink, p));
        }
        if !output.is_empty() {
            body = body.child(pre(output, p.muted, p));
        }
        c = c.child(body);
    }
    c
}

/// A body's block of code or output: mono, on the sunken fill, at most 280 points tall.
fn pre(content: String, ink: rune::Color, p: &Palette) -> El {
    let content = if content.len() > 8000 { format!("{}…", &content[..content.floor_char_boundary(8000)]) } else { content };
    col()
        .w_full()
        .max_h(280.0)
        .clip_rounded(8.0)
        .radius(8.0)
        .fill(p.sunken)
        .px(10.0)
        .py(8.0)
        .scroll(rune::ScrollSpec { stick_bottom: false })
        .child(text(content).font(MONO).color(ink).wrap().selectable(true))
}

/// "Explored 3 files, 2 searches, 1 listing", opening to the rows it folds.
fn explored(tools: &[&Tool], r: &Row, session: &str, s: &State, p: &Palette) -> El {
    let count = |verb: &str| tools.iter().filter(|t| describe(&t.name, &t.args).summary.starts_with(verb)).count();
    let plural = |n: usize, one: &str, many: &str| if n == 1 { format!("1 {one}") } else { format!("{n} {many}") };
    let parts: Vec<String> = [(count("Read "), "file", "files"), (count("Search "), "search", "searches"), (count("List "), "listing", "listings")]
        .into_iter()
        .filter(|(n, ..)| *n > 0)
        .map(|(n, one, many)| plural(n, one, many))
        .collect();
    let running = r.live && tools.iter().any(|t| t.status == ToolStatus::Running);
    let key = format!("explore:{session}:{}", tools[0].id);
    let expanded = s.open.contains(&key);
    let k = key.clone();
    let line = row()
        .key(&format!("explore-row:{key}"))
        .role("button")
        .label("Show what ky explored")
        .w_full()
        .h(26.0)
        .ml(-6.0)
        .px(6.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .hover(p.hover)
        .child(dot(if running { ToolStatus::Running } else { ToolStatus::Done }, p))
        .child(text(if running { "Exploring" } else { "Explored" }).font(ROW_TEXT).color(if running { p.ink } else { p.quiet }))
        .child(text(parts.join(", ")).font(ROW_TEXT).color(p.muted).max_lines(1).shrink().min_w(0.0))
        .child(el().grow(1.0))
        .child(icon(if expanded { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet))
        .on_press(move |s: &mut State| s.toggle(&k));
    let mut c = col().w_full().child(line);
    if expanded {
        let mut inner = col().w_full().pl(16.0);
        for tool in tools {
            inner = inner.child(tool_row(tool, r.live, session, s, p));
        }
        c = c.child(inner);
    }
    c
}

/// "ky summarized the chat above", opening to the summary; or "Context reset".
pub fn divider(r: &Row, session: &str, s: &State, markdown: &MarkdownStyle, p: &Palette) -> El {
    let rule = || el().h(1.0).grow(1.0).fill(p.line);
    if r.text.is_empty() {
        return row().w_full().gap(12.0).center_y().child(rule()).child(text("Context reset").font(META).color(p.quiet)).child(rule());
    }
    let key = format!("summary:{session}:{}", r.key);
    let expanded = s.open.contains(&key);
    let k = key.clone();
    let mut c = col().w_full().gap(10.0).child(
        row()
            .key(&format!("divider:{key}"))
            .role("button")
            .label("Show the summary")
            .w_full()
            .gap(12.0)
            .center_y()
            .child(rule())
            .child(row().gap(4.0).center_y().child(text("ky summarized the chat above").font(META).color(p.quiet)).child(icon(if expanded { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet)))
            .child(rule())
            .on_press(move |s: &mut State| s.toggle(&k)),
    );
    if expanded {
        c = c.child(col().w_full().px(14.0).py(10.0).radius(10.0).fill(p.sunken).child(md(s, r.text.clone()).selectable(true).render(markdown)));
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn said(name: &str, args: Value, status: ToolStatus) -> (String, String) {
        let (verb, target, _) = phrase(status, &describe(name, &args));
        (verb, target)
    }

    #[test]
    fn rows_read_as_the_web_phrases_them() {
        assert_eq!(said("read", json!({"path": "src/a.ts"}), ToolStatus::Done), ("Read".into(), "src/a.ts".into()));
        assert_eq!(said("grep", json!({"pattern": "TODO"}), ToolStatus::Running), ("Searching".into(), "TODO".into()));
        assert_eq!(said("exec", json!({"command": "npm test\nmore"}), ToolStatus::Done), ("Ran".into(), "npm test".into()));
        assert_eq!(said("executor_execute", json!({"description": "Send mail"}), ToolStatus::Done), ("Called".into(), "Executor · Send mail".into()));
        assert_eq!(said("subagent", json!({"action": "spawn", "name": "scout"}), ToolStatus::Done), ("Started".into(), "scout".into()));
        assert_eq!(said("write", json!({"path": "x"}), ToolStatus::Failed), ("Wrote".into(), "x".into()));
        assert_eq!(said("exec", json!({"command": "ls"}), ToolStatus::Failed), ("Failed".into(), "ls".into()));
        assert_eq!(said("memory_search", json!({"query": "q"}), ToolStatus::Done), ("Searched".into(), "memory".into()));
        assert_eq!(said("weird", json!({}), ToolStatus::Done), ("weird".into(), "".into()));
    }

    #[test]
    fn durations_read_as_the_web_writes_them() {
        assert_eq!(duration(12_400.0), "12s");
        assert_eq!(duration(184_000.0), "3m 4s");
        assert_eq!(duration(3_720_000.0), "1h 2m");
    }
}

/// Whether a turn shows bloubs an avatar tool offered: it redraws while they move.
pub fn has_bloubs(r: &Row) -> bool {
    r.tools().any(|t| t.output.contains("```bloubs"))
}

/// A turn's error, in a tinted box under its log (the web's `Notice` tone error).
fn error_notice(why: &str, p: &Palette) -> El {
    row()
        .w_full()
        .gap(8.0)
        .px(10.0)
        .py(8.0)
        .radius(8.0)
        .fill(p.danger.alpha(0.08))
        .child(icon(&icons::ALERT, 13.0).color(p.danger).mt(2.0))
        .child(text(why.to_string()).font(ROW_TEXT).color(p.danger).wrap().grow(1.0).shrink().min_w(0.0))
}

/// A specialist's head: its bloub and @name, then whatever follows on the right.
fn speaker(id: &str, key: &str, mood: crate::bloub::Mood, s: &State, p: &Palette) -> El {
    row()
        .gap(8.0)
        .center_y()
        .min_h(28.0)
        .child(crate::bloub::of(s, id, key, 22.0, mood, mood == crate::bloub::Mood::Idle, p))
        .child(text(format!("@{id}")).font(crate::theme::META_STRONG).color(p.ink))
}

/// A specialist's reply in a group chat, in its own box under ky's turn (the web's `SpecialistReply`).
pub fn specialist(r: &Row, session: &str, s: &State, markdown: &MarkdownStyle, p: &Palette) -> El {
    let id = r.from.as_ref().map_or("specialist", |f| f.name.as_str());
    let failed = r.end == End::Failed;
    let mood = if failed { crate::bloub::Mood::Failed } else { crate::bloub::Mood::Idle };
    let mut head = speaker(id, &format!("reply:{session}:{}", r.key), mood, s, p).w_full();
    if !failed {
        let words = r.text.clone();
        head = head.child(el().grow(1.0)).child(
            row()
                .key(&format!("copy:{session}:{}", r.key))
                .role("button")
                .label(&format!("Copy @{id}'s reply"))
                .size(24.0, 24.0)
                .mr(-6.0)
                .center()
                .radius(6.0)
                .hover(p.hover)
                .child(icon(&icons::COPY, 13.0).color(p.quiet))
                .on_press(move |_: &mut State| crate::settings::actions::copy(&words)),
        );
    }
    let body = if failed {
        text(r.text.clone()).font(LOG_TEXT).color(p.danger).wrap().selectable(true)
    } else {
        md(s, r.text.clone()).selectable(true).render(markdown)
    };
    col().w_full().gap(6.0).pt(10.0).px(14.0).pb(4.0).radius(16.0).border(1.0, p.line).fill(p.sunken).child(head).child(body)
}

/// A specialist the newest message went to, still replying.
pub fn replying(id: &str, session: &str, s: &State, p: &Palette) -> El {
    row()
        .w_full()
        .gap(10.0)
        .center_y()
        .py(9.0)
        .px(14.0)
        .radius(16.0)
        .border(1.0, p.line)
        .fill(p.sunken)
        .child(speaker(id, &format!("replying:{session}:{id}"), crate::bloub::Mood::Working, s, p))
        .child(text("Replying").font(crate::theme::META).color(p.muted))
}
