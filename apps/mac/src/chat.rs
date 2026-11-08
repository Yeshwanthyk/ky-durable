//! The main chat as the window shows it: rows of user and assistant turns, plus the assistant turn
//! still arriving. The UI thread owns it; `apply` folds one agent event in and says whether
//! anything visible changed, so `poll` can let an idle window rest.
//!
//! Every row has a key that never changes once it is on screen, and a revision that changes when
//! its text does. The view memoizes each row by (key, revision), so a streamed delta rebuilds one
//! row, never the transcript.

use std::collections::HashMap;

use serde_json::Value;

use crate::wire::{Block, Change, Content, Entry, Event, Message};

/// How a finished turn ended, from its last message's `stopReason` (the web's `TurnState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum End {
    #[default]
    Done,
    Aborted,
    Failed,
}

impl End {
    fn of(stop: Option<&str>) -> End {
        match stop {
            Some("aborted") => End::Aborted,
            Some("error") => End::Failed,
            _ => End::Done,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    /// Where the model's context starts again: a compaction's summary, or a reset.
    Divider,
    /// A specialist's reply in a group chat (`ky.specialist-reply`): `from` names it, `end` is Failed
    /// when it couldn't answer, and `text` is what it said or why not.
    Specialist,
}

/// One thing an assistant turn did, in order, as the web's `turns.ts` reads a turn.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// Words. `last` is false for commentary before a tool call, so only an answer leaves the log.
    Text { text: String, last: bool },
    Thinking(String),
    Tool(Tool),
    /// A message's error, shown in the log.
    Notice(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
    pub status: ToolStatus,
    /// The result's text parts.
    pub output: String,
    /// Call to result.
    pub ms: Option<f64>,
    at: Option<f64>,
    /// What it saw, such as a browser screenshot: its result's images.
    pub images: Vec<std::sync::Arc<[u8]>>,
}

#[derive(Debug, Clone)]
pub struct Row {
    pub key: String,
    pub role: Role,
    /// The user's words; an assistant's text items, joined; a divider's summary.
    pub text: String,
    /// What an assistant turn did, in order.
    pub items: Vec<Item>,
    /// When the turn began (its question) and its last message: "Worked for 12s".
    pub started: Option<f64>,
    pub ended: Option<f64>,
    /// Bumped on every change to what the row shows.
    pub rev: u64,
    /// Still arriving.
    pub live: bool,
    /// The entry it became, once it is durable.
    pub entry: Option<u64>,
    /// A user-role row ky wrote, not the user: a helper's or machine's report, an automation's
    /// result, a post. Who it is from; the window shows it as a report, not the user's bubble.
    pub from: Option<Reporter>,
    /// The images a user message carried, as sent.
    pub images: Vec<std::sync::Arc<[u8]>>,
    /// How the turn ended: its last message's stop.
    pub end: End,
    /// The specialists a user message went to (`ky.to-specialists`), whose replies it waits on.
    pub to: Vec<String>,
    /// ky posted it unasked (`ky.look`): a turn of its own, which no later step joins.
    pub posted: bool,
}

impl Row {
    fn new(key: String, role: Role, text: String) -> Row {
        Row { key, role, text, items: Vec::new(), started: None, ended: None, rev: 0, live: false, entry: None, from: None, images: Vec::new(), end: End::Done, to: Vec::new(), posted: false }
    }

    /// The tools it called, by name, in order.
    pub fn tools(&self) -> impl Iterator<Item = &Tool> {
        self.items.iter().filter_map(|i| if let Item::Tool(t) = i { Some(t) } else { None })
    }

    fn set_items(&mut self, items: Vec<Item>) {
        if self.items != items {
            self.text = texts(&items);
            self.items = items;
            self.rev += 1;
        }
    }
}

/// Who wrote a report row: its kind (`machine`, `automation`, `subagent`, `ky`…) and name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reporter {
    pub kind: String,
    pub name: String,
}

/// How the user answered a card (`ky.card-answer`): each question's values, or the button.
#[derive(Debug, Clone, PartialEq)]
pub struct CardAnswer {
    pub values: Vec<Vec<String>>,
    pub button: Option<String>,
}

#[derive(Default)]
pub struct Chat {
    pub rows: Vec<Row>,
    /// The assistant message in flight, as blocks, so deltas land by `contentIndex`.
    blocks: Vec<Block>,
    live_at: Option<f64>,
    /// What the run's finished messages did, shown above the one in flight.
    turn_items: Vec<Item>,
    pub running: bool,
    /// Bumps when rows are added, removed or rekeyed: the virtual list's key version.
    pub layout_rev: u64,
    next_key: u64,
    /// When the user last spoke: the next turn's start.
    asked_at: Option<f64>,
    /// Each answered card, by its `ui` call.
    pub answers: HashMap<String, CardAnswer>,
    /// Cards sent from this window and not yet recorded.
    pub sent_cards: std::collections::HashSet<String>,
    /// What pi holds queued for the next step, by submission id, from any window.
    pub inbox: Vec<u64>,
    /// Messages sent from this window while ky ran, waiting in the queue above the composer.
    pub outbox: Vec<Outgoing>,
    /// Queued messages pi gave back without being asked (Stop does), for the composer to take in.
    pub returned: Vec<Outgoing>,
    /// The entry the chat before what's shown ends at, while there's more to page in (`src/view.ts`
    /// `before`); none when the whole chat is here.
    pub before: Option<u64>,
    /// Where the snapshot's context starts: a reconnect to the same one keeps the pages read.
    boundary: Option<u64>,
    /// The pages read so far, oldest first, to land again under a reconnect's snapshot.
    earlier: Vec<serde_json::Value>,
    pub paging: Paging,
}

/// The "Earlier turns" button's state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Paging {
    #[default]
    Idle,
    Loading,
    Failed,
}

fn number(v: &serde_json::Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// A message sent while ky ran (`src/outbox.ts` Outgoing): waiting for pi's next step.
#[derive(Clone)]
pub struct Outgoing {
    pub operation: String,
    pub text: String,
    pub images: Vec<crate::media::Picked>,
    /// pi's submission id once it queued it.
    pub submission: Option<u64>,
    /// Being taken back by the user, to edit or delete.
    pub taking: bool,
}

impl Outgoing {
    /// What a queue row says: the words, and how many images ride along.
    pub fn summary(&self) -> String {
        let pictures = match self.images.len() {
            0 => String::new(),
            1 => "1 image".into(),
            n => format!("{n} images"),
        };
        [self.text.trim().to_string(), pictures].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ")
    }
}

impl Chat {
    /// A page of the chat before `before` (the `earlier` ask's answer), landed above what's shown.
    /// A page for a cursor the chat has moved past (a new compaction) is dropped.
    pub fn prepend(&mut self, asked: u64, page: Result<serde_json::Value, String>) -> bool {
        if self.before != Some(asked) {
            return false;
        }
        let page = match page {
            Ok(page) => page,
            Err(_) => {
                self.paging = Paging::Failed;
                return true;
            }
        };
        let raw: Vec<serde_json::Value> = page.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        let more = page.get("more").and_then(|m| m.as_bool()).unwrap_or(false);
        let entries: Vec<Entry> = raw.iter().filter_map(|e| serde_json::from_value(e.clone()).ok()).collect();
        let oldest = entries.first().map(|e| e.id);
        let known: std::collections::HashSet<u64> = self.rows.iter().filter_map(|r| r.entry).collect();
        let later = std::mem::take(&mut self.rows);
        let asked_at = self.asked_at.take();
        for entry in entries {
            if !known.contains(&entry.id) {
                self.land(entry, false);
            }
        }
        self.rows.extend(later);
        self.asked_at = asked_at;
        self.earlier.splice(0..0, raw);
        self.before = if more { oldest } else { None };
        self.paging = Paging::Idle;
        self.layout_rev += 1;
        true
    }

    /// Fold one event in; true when the window should draw again.
    pub fn apply(&mut self, event: Event) -> bool {
        match event {
            Event::Snapshot { entries, generation, inbox, .. } => {
                self.rows.clear();
                self.blocks.clear();
                self.turn_items.clear();
                self.answers.clear();
                self.asked_at = None;
                self.paging = Paging::Idle;
                // The same context as before (a reconnect) keeps what the user paged back to; a new
                // one starts paging at its head.
                let boundary = entries.first().and_then(|e| e.head.as_ref()).and_then(number);
                let first = entries.first().map(|e| e.id);
                if boundary != self.boundary || boundary.is_none() {
                    self.earlier.clear();
                    self.before = boundary.filter(|b| *b > 1);
                    self.boundary = boundary;
                }
                let shown: std::collections::HashSet<u64> = entries.iter().map(|e| e.id).collect();
                for raw in self.earlier.clone() {
                    if let Ok(entry) = serde_json::from_value::<Entry>(raw) {
                        if !shown.contains(&entry.id) && first.is_none_or(|f| entry.id < f) {
                            self.land(entry, false);
                        }
                    }
                }
                for entry in entries {
                    self.land(entry, false);
                }
                if let Some(message) = generation.and_then(|g| g.message) {
                    self.start_live(&message);
                }
                self.running = self.rows.last().is_some_and(|r| r.live);
                self.layout_rev += 1;
                self.set_inbox(inbox.iter().map(|i| i.id).collect());
                true
            }
            Event::InboxUpdate { items } => {
                self.set_inbox(items.iter().filter(|i| i.mode != "write").map(|i| i.id).collect());
                true
            }
            Event::Submission { record } => {
                if record.kind != "input" {
                    return false;
                }
                let Some(op) = record.request_id else { return false };
                let Some(at) = self.outbox.iter().position(|o| o.operation == op) else { return false };
                if record.status == "queued" {
                    self.outbox[at].submission = Some(record.id);
                    return true;
                }
                let item = self.outbox.remove(at);
                // Withdrawn while queued and the user didn't ask: back to the composer, never dropped.
                if record.status == "unanswered" && record.reason.as_deref() == Some("aborted") && item.submission.is_some() && !item.taking {
                    self.returned.push(item);
                }
                true
            }
            Event::RunStart => {
                self.running = true;
                true
            }
            Event::RunEnd => {
                self.running = false;
                self.turn_items.clear();
                if let Some(row) = self.rows.last_mut().filter(|r| r.live) {
                    row.live = false;
                    row.rev += 1;
                }
                true
            }
            Event::MessageStart { message } if message.role == "assistant" => {
                self.start_live(&message);
                true
            }
            Event::MessageUpdate { changes } => {
                let mut changed = false;
                for change in changes {
                    changed |= self.change(change);
                }
                if changed {
                    self.refresh_live();
                }
                changed
            }
            Event::MessageEnd { entry } | Event::EntryAppended { entry } => self.land(entry, true),
            Event::ToolExecutionUpdate { tool_call_id, output: Some(out) } => {
                // What a running tool has printed so far shows in its row until its result lands.
                let update = |tool: &mut Tool| {
                    if let Some(set) = &out.set {
                        tool.output = set.clone();
                    } else {
                        let cut = out.trim_start.unwrap_or(0);
                        let from = tool.output.char_indices().nth(cut).map_or(tool.output.len(), |(i, _)| i);
                        tool.output = format!("{}{}", &tool.output[from..], out.append.as_deref().unwrap_or_default());
                    }
                };
                let mut changed = false;
                for item in self.turn_items.iter_mut() {
                    if let Item::Tool(t) = item {
                        if t.id == tool_call_id && t.status == ToolStatus::Running {
                            update(t);
                            changed = true;
                        }
                    }
                }
                if changed {
                    self.refresh_live();
                }
                changed
            }
            _ => false,
        }
    }

    /// The user sent `text`: show it at once, keyed by its operation, until its entry lands.
    pub fn sent(&mut self, text: &str, operation_id: &str) {
        self.sent_with(text, Vec::new(), operation_id);
    }

    /// Sent while ky runs: it waits in the queue, and shows in the thread once pi places it.
    pub fn queue(&mut self, text: &str, images: Vec<crate::media::Picked>, operation_id: &str) {
        self.outbox.push(Outgoing { operation: operation_id.to_string(), text: text.to_string(), images, submission: None, taking: false });
    }

    /// Keep only the queued messages pi still holds (and those not yet queued).
    fn set_inbox(&mut self, ids: Vec<u64>) {
        self.outbox.retain(|o| o.submission.is_none_or(|s| ids.contains(&s)));
        self.inbox = ids;
    }

    /// Queued from elsewhere: in pi's inbox, not sent from this window.
    pub fn queued_elsewhere(&self) -> usize {
        self.inbox.iter().filter(|id| !self.outbox.iter().any(|o| o.submission == Some(**id))).count()
    }

    pub fn sent_with(&mut self, text: &str, images: Vec<std::sync::Arc<[u8]>>, operation_id: &str) {
        let mut row = Row::new(format!("o{operation_id}"), Role::User, text.to_string());
        row.images = images;
        row.started = Some(crate::time::now_ms());
        self.asked_at = row.started;
        self.rows.push(row);
        self.layout_rev += 1;
    }

    fn start_live(&mut self, message: &Message) {
        self.blocks = match &message.content {
            Content::Blocks(blocks) => blocks.clone(),
            Content::Text(text) => vec![Block::Text { text: text.clone() }],
        };
        self.live_at = message.timestamp;
        // A new message in the same run continues the live row (a turn after tool calls).
        if !self.rows.last().is_some_and(|r| r.live && r.role == Role::Assistant) {
            let key = self.key();
            let mut row = Row::new(key, Role::Assistant, String::new());
            row.live = true;
            row.started = self.asked_at.or(message.timestamp);
            self.rows.push(row);
            self.layout_rev += 1;
        }
        self.refresh_live();
    }

    fn change(&mut self, change: Change) -> bool {
        match change {
            Change::TextStart { index, block } | Change::ThinkingStart { index, block } | Change::ToolcallStart { index, block } | Change::Block { index, block } => {
                self.put(index, block);
                true
            }
            Change::TextDelta { index, delta } => {
                if let Some(Block::Text { text }) = self.blocks.get_mut(index) {
                    text.push_str(&delta);
                } else {
                    self.put(index, Block::Text { text: delta });
                }
                true
            }
            Change::ThinkingDelta { index, delta } => {
                if let Some(Block::Thinking { thinking }) = self.blocks.get_mut(index) {
                    thinking.push_str(&delta);
                } else {
                    self.put(index, Block::Thinking { thinking: delta });
                }
                true
            }
            Change::Message { message } => {
                if let Content::Blocks(blocks) = message.content {
                    self.blocks = blocks;
                }
                true
            }
            Change::Other => false,
        }
    }

    fn put(&mut self, index: usize, block: Block) {
        if self.blocks.len() <= index {
            self.blocks.resize(index + 1, Block::Other);
        }
        self.blocks[index] = block;
    }

    /// Rewrite the live row from the in-flight blocks, after what earlier messages of the turn did.
    fn refresh_live(&mut self) {
        let Some(row) = self.rows.last_mut().filter(|r| r.live) else { return };
        let mut items = self.turn_items.clone();
        items.extend(items_of(&self.blocks, self.live_at, true, None));
        row.set_items(items);
    }

    /// One durable entry, from a snapshot or as it lands. `streamed`: the run may have shown it live.
    fn land(&mut self, entry: Entry, streamed: bool) -> bool {
        match entry.kind.as_str() {
            "pi.compaction" | "pi.reset" => {
                let summary = if entry.kind == "pi.reset" { String::new() } else { entry.model.first().map(|m| summary_of(&plain(&m.content))).unwrap_or_default() };
                let mut row = Row::new(format!("e{}", entry.id), Role::Divider, summary);
                row.entry = Some(entry.id);
                self.rows.push(row);
                self.layout_rev += 1;
                return true;
            }
            "ky.card-answer" => {
                let Some(data) = entry.data else { return false };
                let Some(call) = data.get("call").and_then(|c| c.as_str()) else { return false };
                let values = serde_json::from_value(data.get("values").cloned().unwrap_or_default()).unwrap_or_default();
                let button = data.get("button").and_then(|b| b.as_str()).map(str::to_string);
                self.sent_cards.remove(call);
                self.answers.insert(call.to_string(), CardAnswer { values, button });
                self.touch_call(call);
                return true;
            }
            "ky.specialist-reply" => {
                let Some(data) = entry.data else { return false };
                let Some(specialist) = data.get("specialist").and_then(Value::as_str) else { return false };
                let mut row = Row::new(format!("e{}", entry.id), Role::Specialist, data.get("text").and_then(Value::as_str).unwrap_or_default().to_string());
                row.from = Some(Reporter { kind: "specialist".into(), name: specialist.to_string() });
                row.end = if data.get("failed").and_then(Value::as_bool) == Some(true) { End::Failed } else { End::Done };
                row.entry = Some(entry.id);
                row.started = entry.model.first().and_then(|m| m.timestamp);
                self.push_beside_live(row);
                return true;
            }
            "ky.look" => {
                // A post: its cards as the `ui` calls they were, then its words, as a turn of its own.
                let Some(data) = entry.data else { return false };
                let cards: Vec<Value> = data.get("cards").and_then(Value::as_str).and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default();
                let mut items: Vec<Item> = cards
                    .into_iter()
                    .enumerate()
                    .map(|(i, args)| Item::Tool(Tool { id: format!("{}:card{i}", entry.id), name: "ui".into(), args, status: ToolStatus::Done, output: String::new(), ms: None, at: None, images: Vec::new() }))
                    .collect();
                let words = data.get("text").and_then(Value::as_str).unwrap_or_default();
                if !words.trim().is_empty() {
                    items.push(Item::Text { text: words.to_string(), last: true });
                }
                if items.is_empty() {
                    return false;
                }
                let at = entry.model.first().and_then(|m| m.timestamp);
                let mut row = Row::new(format!("e{}", entry.id), Role::Assistant, String::new());
                row.entry = Some(entry.id);
                row.started = at;
                row.ended = at;
                row.posted = true;
                row.set_items(items);
                self.push_beside_live(row);
                return true;
            }
            _ => {}
        }
        let to: Vec<String> = if entry.kind == "ky.to-specialists" {
            entry.data.as_ref().and_then(|d| d.get("to")).and_then(|t| serde_json::from_value(t.clone()).ok()).unwrap_or_default()
        } else {
            Vec::new()
        };
        let Some(message) = entry.model.into_iter().next() else { return false };
        match message.role.as_str() {
            "user" => {
                let text = users_words(&plain(&message.content));
                self.asked_at = message.timestamp.or(self.asked_at);
                // The row `sent` showed becomes this entry and keeps its key, so it doesn't remount.
                if streamed {
                    if let Some(row) = self.rows.iter_mut().rev().find(|r| r.role == Role::User && r.entry.is_none() && r.text == text) {
                        row.entry = Some(entry.id);
                        return false;
                    }
                }
                let (from, body) = match report(&text) {
                    Some((from, body)) => (Some(from), body),
                    None => (None, text),
                };
                let images = images_of(&message.content);
                if body.trim().is_empty() && from.is_none() && images.is_empty() {
                    return false;
                }
                let mut row = Row::new(format!("e{}", entry.id), Role::User, body);
                row.from = from;
                row.images = images;
                row.to = to;
                row.entry = Some(entry.id);
                row.started = message.timestamp;
                self.rows.push(row);
                self.layout_rev += 1;
                true
            }
            "assistant" => {
                let end = End::of(message.stop_reason.as_deref());
                let mut items = items_of(blocks(&message.content), message.timestamp, false, message.stop_reason.as_deref());
                if let Some(error) = message.error_message.filter(|e| !e.trim().is_empty()) {
                    items.push(Item::Notice(error));
                }
                if streamed && self.rows.last().is_some_and(|r| r.live && r.role == Role::Assistant) {
                    // A turn with tool calls ends one message per step: the next step shows under it.
                    self.turn_items.extend(items);
                    self.blocks.clear();
                    self.refresh_live();
                    let running = self.running;
                    let row = self.rows.last_mut().expect("checked above");
                    row.entry = Some(entry.id);
                    row.ended = message.timestamp.or(row.ended);
                    row.end = end;
                    if !running {
                        row.live = false;
                        row.rev += 1;
                    }
                    return true;
                }
                // One turn's steps are one row, as they were while it streamed.
                match self.rows.last_mut() {
                    Some(last) if last.role == Role::Assistant && !last.live && !last.posted => {
                        let mut all = last.items.clone();
                        all.extend(items);
                        last.set_items(all);
                        last.ended = message.timestamp.or(last.ended);
                        last.end = end;
                        true
                    }
                    _ => {
                        if items.is_empty() {
                            return false;
                        }
                        let mut row = Row::new(format!("e{}", entry.id), Role::Assistant, String::new());
                        row.entry = Some(entry.id);
                        row.started = self.asked_at.or(message.timestamp);
                        row.ended = message.timestamp;
                        row.end = end;
                        row.set_items(items);
                        self.rows.push(row);
                        self.layout_rev += 1;
                        true
                    }
                }
            }
            "toolResult" => {
                let Some(call) = message.tool_call_id.clone() else { return false };
                let output = plain(&message.content);
                let images = images_of(&message.content);
                let settle = |tool: &mut Tool| {
                    tool.status = if message.is_error { ToolStatus::Failed } else { ToolStatus::Done };
                    tool.output = output.clone();
                    tool.images = images.clone();
                    tool.ms = match (tool.at, message.timestamp) {
                        (Some(a), Some(b)) => Some(b - a),
                        _ => None,
                    };
                };
                for item in &mut self.turn_items {
                    if let Item::Tool(tool) = item {
                        if tool.id == call {
                            settle(tool);
                        }
                    }
                }
                for row in self.rows.iter_mut().rev().filter(|r| r.role == Role::Assistant).take(4) {
                    let mut hit = false;
                    for item in &mut row.items {
                        if let Item::Tool(tool) = item {
                            if tool.id == call {
                                settle(tool);
                                hit = true;
                            }
                        }
                    }
                    if hit {
                        row.ended = message.timestamp.or(row.ended);
                        row.rev += 1;
                        return true;
                    }
                }
                false
            }
            _ => false,
        }
    }

    /// The row holding `call` shows again (its card was answered).
    fn touch_call(&mut self, call: &str) {
        if let Some(row) = self.rows.iter_mut().rev().find(|r| r.tools().any(|t| t.id == call)) {
            row.rev += 1;
        }
    }

    /// The `ui` call `call`, in whichever row holds it.
    pub fn tool(&self, call: &str) -> Option<&Tool> {
        self.rows.iter().rev().flat_map(|r| r.tools()).find(|t| t.id == call)
    }

    /// A card answered from this window: its taps stop until ky records the answer.
    pub fn card_sent(&mut self, call: &str) {
        self.sent_cards.insert(call.to_string());
        self.touch_call(call);
    }

    fn key(&mut self) -> String {
        self.next_key += 1;
        format!("l{}", self.next_key)
    }
}

/// What one assistant message's blocks show. `streaming`: none of its text is final yet.
fn items_of(blocks: &[Block], at: Option<f64>, streaming: bool, stop: Option<&str>) -> Vec<Item> {
    let mut items = Vec::new();
    for block in blocks {
        match block {
            Block::Text { text } if !text.trim().is_empty() => items.push(Item::Text { text: text.clone(), last: !streaming && stop != Some("toolUse") }),
            Block::Thinking { thinking } if !thinking.trim().is_empty() => items.push(Item::Thinking(thinking.clone())),
            Block::ToolCall { id, name, arguments } => items.push(Item::Tool(Tool {
                id: id.clone(),
                name: name.clone(),
                args: arguments.clone(),
                status: ToolStatus::Running,
                output: String::new(),
                ms: None,
                at,
                images: Vec::new(),
            })),
            _ => {}
        }
    }
    items
}

fn texts(items: &[Item]) -> String {
    let parts: Vec<&str> = items.iter().filter_map(|i| if let Item::Text { text, .. } = i { Some(text.as_str()) } else { None }).collect();
    parts.join("\n\n")
}

/// The summary inside a compaction's text, without pi's framing.
fn summary_of(text: &str) -> String {
    let body = match (text.find("<summary>"), text.rfind("</summary>")) {
        (Some(open), Some(close)) if close > open => &text[open + 9..close],
        (Some(open), _) => &text[open + 9..],
        _ => text,
    };
    body.trim().to_string()
}

/// What reports ky writes into the chat as user messages start with, as the web app reads them
/// (`src/ui/turns.ts` `REPORT`): `[machine webmac, task m-1 "…" finished, …] body`.
const REPORTERS: &[&str] = &["subagent", "machine", "specialist", "discussion", "automation", "check-in", "peer", "chat"];

/// A report's sender and body, or `None` for what the user wrote.
/// The user's words as they wrote them: without the `[for @a, @b]` a group chat's message carries
/// for its specialists, or the note a late message carries for the model (`late.ts`).
fn users_words(text: &str) -> String {
    let mut words = text;
    if let Some(rest) = words.strip_prefix("[for @") {
        if let Some(close) = rest.find(']') {
            if rest[..close].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | ',' | ' ' | '@')) {
                words = rest[close + 1..].strip_prefix(' ').unwrap_or(&rest[close + 1..]);
            }
        }
    }
    let trimmed = words.trim_end();
    if trimmed.ends_with("</ky-late>") {
        if let Some(open) = trimmed.rfind("<ky-late>") {
            return trimmed[..open].trim_end().to_string();
        }
    }
    words.to_string()
}

impl Chat {
    /// A row that lands on its own (a specialist's reply, a post) while a run may be live: it goes
    /// above the live turn, which stays last, so the run's next step still finds it.
    fn push_beside_live(&mut self, row: Row) {
        match self.rows.last() {
            Some(last) if last.live => {
                let at = self.rows.len() - 1;
                self.rows.insert(at, row);
            }
            _ => self.rows.push(row),
        }
        self.layout_rev += 1;
    }

    /// Who the newest message to specialists still waits on: those with no reply under it yet.
    pub fn waiting(&self) -> Vec<String> {
        let Some(at) = self.rows.iter().rposition(|r| !r.to.is_empty()) else { return Vec::new() };
        let replied: Vec<&str> = self.rows[at..].iter().filter(|r| r.role == Role::Specialist).filter_map(|r| r.from.as_ref().map(|f| f.name.as_str())).collect();
        self.rows[at].to.iter().filter(|id| !replied.contains(&id.as_str())).cloned().collect()
    }
}

fn report(text: &str) -> Option<(Reporter, String)> {
    let rest = text.strip_prefix('[')?;
    if let Some(posted) = rest.strip_prefix("ky posted") {
        let close = posted.find(']')?;
        let body = posted[close + 1..].trim();
        let body = if posted.starts_with(" cards") { "Posted cards." } else { body };
        return Some((Reporter { kind: "ky".into(), name: "ky".into() }, body.to_string()));
    }
    let (kind, after) = rest.split_once(' ')?;
    if !REPORTERS.contains(&kind) {
        return None;
    }
    let name: String = if let Some(quoted) = after.strip_prefix('"') {
        quoted.split('"').next()?.to_string()
    } else {
        after.split([',', ']', ' ']).next()?.to_string()
    };
    let close = after.find(']')?;
    let header = &after[..close];
    let mut body = after[close + 1..].trim().to_string();
    if body.is_empty() {
        if let Some((_, why)) = header.split_once(" failed: ") {
            body = why.to_string();
        }
    }
    Some((Reporter { kind: kind.into(), name }, body))
}

fn blocks(content: &Content) -> &[Block] {
    match content {
        Content::Blocks(blocks) => blocks,
        Content::Text(_) => &[],
    }
}

/// The images in a user message, decoded.
fn images_of(content: &Content) -> Vec<std::sync::Arc<[u8]>> {
    match content {
        Content::Text(_) => Vec::new(),
        Content::Blocks(blocks) => blocks.iter().filter_map(|b| if let Block::Image { data, .. } = b { crate::media::decode(data) } else { None }).collect(),
    }
}

fn plain(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Blocks(blocks) => {
            let parts: Vec<&str> = blocks.iter().filter_map(|b| if let Block::Text { text } = b { Some(text.as_str()) } else { None }).collect();
            parts.join("\n")
        }
    }
}

/// Synthetic chats for headless scenes and benches. They go through `apply`, the path live events take.
pub mod fixtures {
    use super::Chat;
    use crate::wire::Event;

    const ANSWER: &str = "Here is what I found.\n\n- The **socket thread** decodes every frame, so the UI thread never parses JSON.\n- Each row is memoized by key and revision.\n\n```rust\nfn poll(state: &mut State) -> bool {\n    state.chat.apply(event)\n}\n```\n\nThat keeps a long chat cheap: only rows near the viewport are built.";

    fn event(json: serde_json::Value) -> Event {
        serde_json::from_value(json).expect("a fixture event")
    }

    /// `turns` question/answer pairs, as one snapshot.
    pub fn long_chat(chat: &mut Chat, turns: u64) {
        let mut entries = Vec::new();
        for i in 0..turns {
            entries.push(serde_json::json!({"id": i * 2 + 1, "kind": "pi.user", "model": [{"role": "user", "content": format!("Question {i}: how does the app stay fast with a long chat?")}]}));
            entries.push(serde_json::json!({"id": i * 2 + 2, "kind": "pi.assistant", "model": [{"role": "assistant", "content": [
                {"type": "toolCall", "id": format!("t{i}"), "name": if i % 3 == 0 { "read" } else { "search" }},
                {"type": "text", "text": format!("**Turn {i}.** {ANSWER}")}
            ]}]}));
        }
        chat.apply(event(serde_json::json!({"type": "snapshot", "entries": entries})));
    }

    /// A run in progress with a partly streamed answer, as `streaming` shows it.
    pub fn streaming_turn(chat: &mut Chat) {
        chat.sent("Explain how streaming stays smooth.", "scene");
        chat.apply(event(serde_json::json!({"type": "run_start"})));
        chat.apply(event(serde_json::json!({"type": "message_start", "message": {"role": "assistant", "content": []}})));
        for word in ANSWER.split_inclusive(' ').take(30) {
            stream(chat, word);
        }
    }

    /// Builds a snapshot's entries, a message at a time, `t` seconds into the day.
    struct Log {
        entries: Vec<serde_json::Value>,
        t: f64,
    }

    impl Log {
        fn new() -> Log {
            Log { entries: Vec::new(), t: 1_762_500_000_000.0 }
        }
        fn push(&mut self, kind: &str, message: serde_json::Value, after: f64) {
            self.t += after * 1000.0;
            let mut message = message;
            message["timestamp"] = self.t.into();
            let id = self.entries.len() as u64 + 1;
            self.entries.push(serde_json::json!({"id": id, "kind": kind, "model": [message]}));
        }
        fn user(&mut self, text: &str) {
            self.push("pi.user", serde_json::json!({"role": "user", "content": text}), 4.0);
        }
        fn step(&mut self, content: serde_json::Value, after: f64) {
            self.push("pi.assistant", serde_json::json!({"role": "assistant", "content": content, "stopReason": "toolUse"}), after);
        }
        fn answer(&mut self, content: serde_json::Value, after: f64) {
            self.push("pi.assistant", serde_json::json!({"role": "assistant", "content": content, "stopReason": "stop"}), after);
        }
        fn result(&mut self, call: &str, name: &str, output: &str, error: bool, after: f64) {
            self.push("pi.toolResult", serde_json::json!({"role": "toolResult", "toolCallId": call, "toolName": name, "content": [{"type": "text", "text": output}], "isError": error}), after);
        }
        fn raw(&mut self, entry: serde_json::Value) {
            let mut entry = entry;
            entry["id"] = (self.entries.len() as u64 + 1).into();
            self.entries.push(entry);
        }
        fn land(self, chat: &mut Chat) {
            chat.apply(event(serde_json::json!({"type": "snapshot", "entries": self.entries})));
        }
    }

    /// A reply with a diagram (the web draws these with pele) and a chart.
    pub fn diagram_chat(chat: &mut Chat) {
        use serde_json::json;
        let mut log = Log::new();
        log.user("Draw how a message gets from the Mac app to the model.");
        log.answer(json!([{"type": "text", "text": "Here's the path a message takes:\n\n```mermaid\nflowchart LR\n  A[Mac app] -->|submit| B(Worker)\n  B --> C{Busy?}\n  C -->|no| D[Model]\n  C -->|yes| E[Queue]\n  E --> D\n```\n\nAnd where the time goes:\n\n```mermaid\npie title A turn\n  \"Model\" : 72\n  \"Tools\" : 21\n  \"Network\" : 7\n```"}]), 6.0);
        log.land(chat);
    }

    /// A picture for scenes: a soft gradient with a sun and hills, as PNG.
    pub fn picture(w: u32, h: u32, hue: f32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            let sky = [0.55 + 0.4 * hue, 0.7 - 0.2 * fy, 0.95 - 0.3 * hue];
            let sun = ((fx - 0.7).powi(2) + (fy - 0.3).powi(2)).sqrt() < 0.12;
            let hill = fy > 0.62 + 0.08 * (fx * 9.0 + hue * 4.0).sin();
            let c = if sun { [1.0, 0.86, 0.45] } else if hill { [0.2 + 0.3 * hue, 0.45 - 0.1 * fy, 0.3] } else { sky };
            image::Rgb(c.map(|v| (v.clamp(0.0, 1.0) * 255.0) as u8))
        });
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).expect("png");
        out.into_inner()
    }

    /// Messages with images, as ky stores them: image parts, then the words.
    pub fn image_chat(chat: &mut Chat) {
        use serde_json::json;
        let part = |w, h, hue| json!({"type": "image", "mimeType": "image/png", "data": crate::media::encode(&picture(w, h, hue))});
        let mut log = Log::new();
        log.push("pi.user", json!({"role": "user", "content": [part(640, 420, 0.1), {"type": "text", "text": "What's this place? Took it on the walk this morning."}]}), 4.0);
        log.answer(json!([{"type": "text", "text": "Rolling green hills under a clear sky, with the sun low on the right. It looks like late morning in open countryside."}]), 5.0);
        log.push("pi.user", json!({"role": "user", "content": [part(400, 400, 0.2), part(400, 300, 0.6), part(300, 400, 0.9), {"type": "text", "text": "Which of these three would print best?"}]}), 30.0);
        log.answer(json!([{"type": "text", "text": "The second: its horizon sits on a third and the sun has room to breathe."}]), 6.0);
        log.land(chat);
    }

    fn call(id: &str, name: &str, args: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"type": "toolCall", "id": id, "name": name, "arguments": args})
    }

    /// A working day: a summary divider, a turn that read, searched, ran and called an app (one
    /// failure among them), its answer with a card, and a question still waiting on a choice.
    pub fn work_chat(chat: &mut Chat) {
        use serde_json::json;
        let mut log = Log::new();
        log.raw(json!({"kind": "pi.compaction", "model": [{"role": "user", "content": "<summary>\nThe user is planning a team offsite in Lisbon for March. Budget agreed at **€18k**. Flights booked for six; hotel still open.\n</summary>"}]}));
        log.user("Why is the nightly export failing? Fix it if it's simple.");
        log.step(json!([
            {"type": "thinking", "thinking": "The export runs from a routine. Look at its last run, then the script it calls, before touching anything."},
            {"type": "text", "text": "I'll look at the last run first."},
            call("c1", "read", json!({"path": "scripts/export.ts"})),
            call("c2", "grep", json!({"pattern": "EXPORT_BUCKET", "path": "scripts"})),
            call("c3", "find", json!({"pattern": "*.export.json"}))
        ]), 2.0);
        log.result("c1", "read", "import { put } from \"./r2\";\nexport async function run() {\n  const bucket = process.env.EXPORT_BUCKET;\n  ...", false, 0.4);
        log.result("c2", "grep", "scripts/export.ts:3:  const bucket = process.env.EXPORT_BUCKET;", false, 0.2);
        log.result("c3", "find", "fixtures/a.export.json", false, 0.2);
        log.step(json!([
            {"type": "text", "text": "The bucket comes from an env var. Running it to see the error."},
            call("c4", "exec", json!({"command": "node scripts/export.ts --dry-run"}))
        ]), 3.0);
        log.result("c4", "exec", "Error: EXPORT_BUCKET is not set\n    at run (scripts/export.ts:4:11)\nexit 1", true, 6.5);
        log.step(json!([
            call("c5", "edit", json!({"path": "scripts/export.ts"})),
            call("c6", "executor_execute", json!({"description": "Post in #ops"}))
        ]), 4.0);
        log.result("c5", "edit", "Applied 1 edit.", false, 0.3);
        log.result("c6", "executor_execute", "Posted.", false, 1.8);
        log.answer(json!([
            {"type": "text", "text": "The export lost its bucket name when the routine moved to the cloud machine: `EXPORT_BUCKET` was set on your laptop only.\n\nI made the script fall back to `ky-exports` and said so in **#ops**. Tonight's run should pass."},
            call("c7", "ui", json!({"title": "Nightly export", "subtitle": "last 7 nights", "icon": "file", "blocks": [
                {"type": "status", "tone": "success", "text": "Fixed: falls back to ky-exports"},
                {"type": "stats", "items": [{"label": "Rows", "value": "48,210"}, {"label": "Failed nights", "value": 3, "tone": "error"}, {"label": "Run time", "value": "2m 14s"}]},
                {"type": "chart", "kind": "bars", "label": "Rows exported", "x": ["Mon", "Tue", "Wed", "Thu", "Fri"], "series": [{"name": "Rows", "values": [9100, 9800, 0, 0, 0]}]},
                {"type": "buttons", "buttons": [{"label": "Open the routine", "url": "https://example.com/routines/export"}]}
            ]}))
        ]), 5.0);
        log.result("c7", "ui", "Shown.", false, 0.1);
        log.user("Where should the offsite dinner be?");
        log.step(json!([
            {"type": "text", "text": "Three places can seat eight on a Thursday."},
            call("c8", "web_search", json!({"query": "Lisbon restaurant private room 8 people"}))
        ]), 3.0);
        log.result("c8", "web_search", "…", false, 2.2);
        log.answer(json!([
            {"type": "text", "text": "All three take a booking for eight on Thursday the 12th."},
            call("c9", "ui", json!({"title": "Offsite dinner", "icon": "calendar", "blocks": [
                {"type": "choice", "label": "Where should I book?", "options": [
                    {"label": "Prado", "detail": "Seasonal Portuguese · €65 a head"},
                    {"label": "Taberna da Rua das Flores", "detail": "Small plates, loud · €40 a head"},
                    {"label": "Belcanto", "detail": "Tasting menu · €235 a head"}
                ]}
            ]}))
        ]), 4.0);
        log.result("c9", "ui", "Shown.", false, 0.1);
        log.land(chat);
    }

    /// One turn per card shape: charts, a table, tabs, facts and a list, a page, and a form.
    pub fn cards_chat(chat: &mut Chat) {
        use serde_json::json;
        let mut log = Log::new();
        log.user("How did spend go this month?");
        log.answer(json!([
            {"type": "text", "text": "Spend is under the cap. Most of it went to the main chat's model."},
            call("k1", "ui", json!({"title": "Spend, November", "blocks": [
                {"type": "stats", "items": [{"label": "Spent", "value": "$41.20", "series": 1}, {"label": "Cap", "value": "$80", "series": 2}, {"label": "Days left", "value": 23}]},
                {"type": "columns", "columns": [
                    [{"type": "chart", "kind": "line", "label": "Per day", "x": ["Nov 1", "Nov 2", "Nov 3", "Nov 4", "Nov 5", "Nov 6", "Nov 7"], "series": [{"name": "Main chat", "values": [3.1, 5.2, 4.4, 8.9, 6.0, 7.5, 6.1]}, {"name": "Routines", "values": [1.0, 1.2, 0.8, 1.6, 1.1, 0.9, 1.3]}]}],
                    [{"type": "chart", "kind": "donut", "label": "By purpose", "x": ["Main chat", "Routines", "Dreams", "Mail"], "series": [{"name": "Spend", "values": [29.4, 7.9, 2.6, 1.3]}]}]
                ]},
                {"type": "chart", "kind": "bars", "label": "By model", "stacked": true, "x": ["opus", "sonnet", "haiku"], "series": [{"name": "Input", "values": [18, 6, 1]}, {"name": "Output", "values": [11, 4, 1.2]}]},
                {"type": "table", "label": "Top chats", "columns": ["Chat", "Turns", "Spend"], "rows": [["Main chat", 212, "$24.10"], ["Offsite planning", 41, "$6.80"], ["Export fix", 9, "$1.40"]]}
            ]}))
        ]), 6.0);
        log.result("k1", "ui", "Shown.", false, 0.1);
        log.user("What's on this week?");
        log.answer(json!([
            call("k2", "ui", json!({"title": "This week", "icon": "calendar", "blocks": [
                {"type": "tabs", "tabs": [
                    {"label": "Meetings", "blocks": [{"type": "list", "items": [
                        {"title": "Design review", "meta": "Mon 10:00", "detail": "With Ana and Rui"},
                        {"title": "1:1 with Sam", "meta": "Tue 14:30"},
                        {"title": "Offsite planning", "meta": "Thu 16:00", "detail": "Book the dinner before this"}
                    ]}]},
                    {"label": "Deadlines", "blocks": [{"type": "facts", "rows": [{"label": "Tax filing", "value": "Fri"}, {"label": "Lease renewal", "value": "Nov 30"}]}]}
                ]},
                {"type": "page", "site": "week-plan", "title": "Week plan"},
                {"type": "status", "tone": "warning", "text": "Two meetings overlap on Thursday."}
            ]}))
        ]), 5.0);
        log.result("k2", "ui", "Shown.", false, 0.1);
        log.user("Draft the invite for the offsite.");
        log.answer(json!([
            {"type": "text", "text": "Two things before I send it."},
            call("k3", "ui", json!({"title": "Offsite invite", "icon": "mail", "blocks": [
                {"type": "choice", "label": "Who gets it?", "multiple": true, "options": [{"label": "Design"}, {"label": "Engineering"}, {"label": "Leadership"}]},
                {"type": "input", "label": "Anything to add?", "placeholder": "A line for the top of the email"}
            ], "note": "Nothing is sent until you press Send."}))
        ]), 5.0);
        log.result("k3", "ui", "Shown.", false, 0.1);
        log.land(chat);
    }

    /// One text delta to the message in flight.
    pub fn stream(chat: &mut Chat, delta: &str) {
        chat.apply(event(serde_json::json!({"type": "message_update", "changes": [{"type": "text_delta", "contentIndex": 0, "delta": delta}]})));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{Frame, decode};

    #[test]
    fn earlier_turns_page_in_above_until_the_chat_starts() {
        use serde_json::json;
        let user = |id: u64, text: &str| json!({"id": id, "kind": "pi.user", "model": [{"role": "user", "content": text}]});
        let mut chat = Chat::default();
        let mut first = user(50, "after the compaction");
        first["head"] = json!(50);
        chat.apply(ev(json!({"type": "snapshot", "entries": [first]})));
        assert_eq!(chat.before, Some(50));
        // A page for a cursor the chat moved past is dropped.
        assert!(!chat.prepend(7, Ok(json!({"entries": [user(3, "stale")], "more": false}))));
        assert!(chat.prepend(50, Ok(json!({"entries": [user(10, "older"), user(20, "old")], "more": true}))));
        let texts: Vec<&str> = chat.rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["older", "old", "after the compaction"]);
        assert_eq!(chat.before, Some(10));
        chat.prepend(10, Ok(json!({"entries": [user(1, "first")], "more": false})));
        assert_eq!(chat.rows[0].text, "first");
        assert_eq!(chat.before, None);
        // A reconnect to the same context keeps what was paged in.
        let mut again = user(50, "after the compaction");
        again["head"] = json!(50);
        chat.apply(ev(json!({"type": "snapshot", "entries": [again]})));
        assert_eq!(chat.rows.len(), 4);
        assert_eq!(chat.before, None);
    }

    #[test]
    fn a_group_chat_reads_as_the_web_shows_it() {
        use serde_json::json;
        let mut chat = Chat::default();
        chat.apply(ev(json!({"type": "snapshot", "entries": [
            {"id": 1, "kind": "ky.to-specialists", "data": {"to": ["writer", "researcher"]}, "model": [{"role": "user", "content": "[for @writer, @researcher] draft it\n\n<ky-late>(written 5 min ago while offline, delivered now)</ky-late>"}]},
            {"id": 2, "kind": "pi.assistant", "model": [{"role": "assistant", "content": [{"type": "text", "text": "Asked them."}], "stopReason": "stop"}]},
            {"id": 3, "kind": "ky.specialist-reply", "data": {"specialist": "writer", "text": "Here's a draft.", "failed": false}, "model": [{"role": "user", "content": "[@writer replied to the user] Here's a draft."}]},
            {"id": 4, "kind": "ky.look", "data": {"text": "Your flight moved."}, "model": [{"role": "user", "content": "[ky posted to the user, unasked] Your flight moved."}]},
            {"id": 5, "kind": "pi.assistant", "model": [{"role": "assistant", "content": [{"type": "text", "text": "Later."}], "stopReason": "aborted"}]}
        ]})));
        let rows: Vec<(Role, &str)> = chat.rows.iter().map(|r| (r.role, r.text.as_str())).collect();
        assert_eq!(rows[0], (Role::User, "draft it"));
        assert_eq!(chat.rows[0].to, ["writer", "researcher"]);
        assert_eq!(rows[2], (Role::Specialist, "Here's a draft."));
        assert_eq!(chat.waiting(), ["researcher"]);
        // The post is a turn of its own, and what ky says after it isn't folded in.
        assert!(chat.rows[3].posted && chat.rows[3].role == Role::Assistant);
        assert_eq!(chat.rows.len(), 5);
        assert_eq!(chat.rows[4].end, End::Aborted);
    }

    fn ev(json: serde_json::Value) -> Event {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_queued_message_waits_then_goes_in_or_comes_back() {
        let mut chat = Chat::default();
        chat.queue("first", Vec::new(), "a");
        chat.queue("second", Vec::new(), "b");
        chat.apply(ev(serde_json::json!({"type": "submission", "record": {"type": "input", "id": 7, "requestId": "a", "status": "queued"}})));
        chat.apply(ev(serde_json::json!({"type": "submission", "record": {"type": "input", "id": 8, "requestId": "b", "status": "queued"}})));
        chat.apply(ev(serde_json::json!({"type": "inbox_update", "items": [{"id": 7, "mode": "followUp"}, {"id": 8, "mode": "followUp"}, {"id": 9, "mode": "followUp"}]})));
        assert_eq!(chat.queued_elsewhere(), 1);
        // Placed: it leaves the queue; the thread shows it from its entry.
        chat.apply(ev(serde_json::json!({"type": "submission", "record": {"type": "input", "id": 7, "requestId": "a", "status": "placed", "entry": 3}})));
        assert_eq!(chat.outbox.iter().map(|o| o.text.as_str()).collect::<Vec<_>>(), ["second"]);
        // Stop withdraws it: back to the composer, never dropped.
        chat.apply(ev(serde_json::json!({"type": "submission", "record": {"type": "input", "id": 8, "requestId": "b", "status": "unanswered", "reason": "aborted"}})));
        assert!(chat.outbox.is_empty());
        assert_eq!(chat.returned.iter().map(|o| o.text.as_str()).collect::<Vec<_>>(), ["second"]);
    }

    fn replay(path: &str) -> Chat {
        let mut chat = Chat::default();
        let fixture = std::fs::read_to_string(path).unwrap();
        for line in fixture.lines() {
            if let Some(Frame::Events { events, .. }) = decode(line) {
                for event in events {
                    chat.apply(event);
                }
            }
        }
        chat
    }

    #[test]
    fn the_recorded_turn_shows_the_question_then_the_answer() {
        let chat = replay("fixtures/main-chat.jsonl");
        let shown: Vec<(Role, &str)> = chat.rows.iter().map(|r| (r.role, r.text.as_str())).collect();
        assert_eq!(
            shown,
            vec![
                (Role::User, "Say hello in two short paragraphs, with one bullet list."),
                (Role::Assistant, "echo: Say hello in two short paragraphs, with one bullet list."),
            ]
        );
        assert!(!chat.running);
        assert!(chat.rows.iter().all(|r| !r.live));
    }

    #[test]
    fn every_recorded_frame_the_app_reads_decodes() {
        let fixture = std::fs::read_to_string("fixtures/main-chat.jsonl").unwrap();
        for line in fixture.lines().filter(|l| l.starts_with('{')) {
            let head: serde_json::Value = serde_json::from_str(line).unwrap();
            let kind = head["type"].as_str().unwrap();
            if kind == "hello" || kind == "events" {
                assert!(serde_json::from_str::<Frame>(line).is_ok(), "{kind} frame failed to decode: {}", &line[..line.len().min(300)]);
            }
        }
    }

    #[test]
    fn deltas_grow_one_row_and_keep_its_key() {
        let mut chat = Chat::default();
        let event = |json: &str| serde_json::from_str::<Event>(json).unwrap();
        chat.apply(event(r#"{"type":"run_start","inputs":[1]}"#));
        chat.apply(event(r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#));
        let key = chat.rows[0].key.clone();
        let layout = chat.layout_rev;
        chat.apply(event(r#"{"type":"message_update","usage":{},"changes":[{"type":"text_start","contentIndex":0,"block":{"type":"text","text":""}}]}"#));
        for word in ["Hel", "lo ", "**there**"] {
            let rev = chat.rows[0].rev;
            assert!(chat.apply(event(&format!(r#"{{"type":"message_update","usage":{{}},"changes":[{{"type":"text_delta","contentIndex":0,"delta":"{word}"}}]}}"#))));
            assert!(chat.rows[0].rev > rev);
        }
        assert_eq!(chat.rows[0].text, "Hello **there**");
        assert_eq!(chat.layout_rev, layout, "a delta changes no row's key");
        chat.apply(event(r#"{"type":"message_end","entry":{"id":9,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Hello **there**"}]}]}}"#));
        chat.apply(event(r#"{"type":"run_end","inputs":[1]}"#));
        assert_eq!(chat.rows.len(), 1);
        assert_eq!(chat.rows[0].key, key, "the live row becomes the entry without a remount");
        assert!(!chat.rows[0].live);
    }

    #[test]
    fn a_sent_message_keeps_its_key_when_its_entry_lands() {
        let mut chat = Chat::default();
        chat.sent("hi", "op1");
        let event = serde_json::from_str::<Event>(r#"{"type":"message_end","entry":{"id":7,"kind":"pi.user","model":[{"role":"user","content":"hi"}]}}"#).unwrap();
        chat.apply(event);
        assert_eq!(chat.rows.len(), 1);
        assert_eq!(chat.rows[0].key, "oop1");
        assert_eq!(chat.rows[0].entry, Some(7));
    }

    fn who(kind: &str, name: &str) -> Reporter {
        Reporter { kind: kind.into(), name: name.into() }
    }

    #[test]
    fn reports_ky_wrote_are_notes_not_the_users_words() {
        assert_eq!(
            report(r#"[machine webmac, task m-224 "Rebuild" failed, no reply needed] fake did it"#),
            Some((who("machine", "webmac"), "fake did it".into()))
        );
        assert_eq!(report(r#"[automation "Inbox digest" result: tell the user] **12 new**"#), Some((who("automation", "Inbox digest"), "**12 new**".into())));
        assert_eq!(report(r#"[ky posted cards to the user, unasked] [{"id":1}]"#), Some((who("ky", "ky"), "Posted cards.".into())));
        assert_eq!(report("[draft] my own words"), None);
        assert_eq!(report("plain"), None);
    }

    #[test]
    fn a_snapshot_replaces_what_was_there() {
        let mut chat = Chat::default();
        chat.sent("stale", "op");
        let snapshot = serde_json::from_str::<Event>(
            r#"{"type":"snapshot","entries":[{"id":3,"kind":"pi.user","model":[{"role":"user","content":"fresh"}]}],"tools":[],"nestedTools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}"#,
        )
        .unwrap();
        chat.apply(snapshot);
        assert_eq!(chat.rows.len(), 1);
        assert_eq!(chat.rows[0].text, "fresh");
        assert_eq!(chat.rows[0].key, "e3");
    }
}
