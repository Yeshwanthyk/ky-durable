//! ky's socket protocol, as far as the Mac app reads it: `src/protocol.ts` (frames) and pi-durable's
//! `harness/events.d.ts` (agent events). Everything else the Worker sends decodes to `Other` and is
//! dropped on the socket thread, so the UI thread never sees it.
//!
//! The shapes are checked against frames recorded from the local stack (`fixtures/*.jsonl`, made by
//! `scripts/record-frames.ts`); rerecord them when the protocol changes.

use serde::Deserialize;

/// Server → client.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Frame {
    Hello {
        version: String,
        #[serde(default)]
        tools: Vec<ToolInfo>,
    },
    Events { events: Vec<Event> },
    /// Every side chat, archived ones too (`src/chats/contract.ts` ChatRow).
    Chats { chats: Vec<ChatRow> },
    /// Settings › Models: the providers and the model each purpose runs on (`src/settings/contract.ts`).
    Settings { settings: SettingsView },
    Subscriptions { subscriptions: Vec<Subscription> },
    /// What waits on the user's tap: an app action, a credential, a browser hand-off (`src/approvals`).
    Approvals { approvals: Vec<Approval> },
    /// The tools ky's model can call, for Settings › Tools.
    Tools { tools: Vec<ToolInfo> },
    /// Executor's address and each tool's policy, for Settings › Executor.
    Executor { executor: serde_json::Value },
    /// What isn't set up yet, and the repo self-edits go to.
    Setup { setup: serde_json::Value },
    /// Cloud tasks, machines and files.
    Tasks {
        #[serde(default)]
        tasks: serde_json::Value,
        #[serde(default)]
        machines: serde_json::Value,
    },
    /// Every routine, and whether the nightly dream books check-ins (`AutomationInfo`, Activity).
    Automations {
        #[serde(default)]
        automations: serde_json::Value,
        #[serde(default, rename = "checkIns")]
        check_ins: bool,
    },
    /// The bloubs ky and its specialists wear, by "ky" or a specialist's id (`src/avatars/contract.ts`).
    Avatars { #[serde(default)] avatars: serde_json::Value },
    /// The answer to a command sent with an `id`.
    Result { id: String, #[serde(default)] result: serde_json::Value },
    Error { #[serde(default)] id: Option<String>, message: String },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatRow {
    pub session: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub updated_at: f64,
    #[serde(default)]
    pub archived_at: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct SettingsView {
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// By purpose: `main`, `worker`, `background`, `fallback`.
    #[serde(default)]
    pub purposes: std::collections::BTreeMap<String, ModelChoice>,
    /// The vendors an API key can be added for.
    #[serde(default)]
    pub vendors: Vec<Vendor>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Vendor {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Provider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub needs: Option<String>,
    /// Why its breaker last opened.
    #[serde(default)]
    pub failure: Option<String>,
    /// `api-key` providers' keys can be removed.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub models: Vec<ModelOption>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub model_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub featured: bool,
    #[serde(default)]
    pub levels: Vec<String>,
    /// Dollars per million tokens in and out.
    #[serde(default)]
    pub cost: Option<Cost>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Cost {
    pub input: f64,
    pub output: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub provider: String,
    pub model_id: String,
    #[serde(default)]
    pub thinking_level: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub kind: String,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub expires_at: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
    /// GitHub's: the repos the cloud machine may use.
    #[serde(default)]
    pub repos: Vec<String>,
}

/// pi's agent events for one session. A `snapshot` replaces everything the client holds.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Snapshot {
        entries: Vec<Entry>,
        #[serde(default)]
        generation: Option<Generation>,
        #[serde(default)]
        run: Option<serde::de::IgnoredAny>,
        #[serde(default)]
        inbox: Vec<InboxItem>,
    },
    /// What pi holds queued for the chat's next step, from any window.
    InboxUpdate { items: Vec<InboxItem> },
    /// pi's word on one submitted message: queued, placed, answered, or dropped.
    Submission { record: SubmissionRecord },
    RunStart,
    RunEnd,
    MessageStart { message: Message },
    MessageUpdate { changes: Vec<Change> },
    MessageEnd { entry: Entry },
    EntryAppended { entry: Entry },
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
    },
    /// A running tool's output so far: replaced (`set`), or trimmed at the front and added to.
    ToolExecutionUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(default)]
        output: Option<ToolOutput>,
    },
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct ToolOutput {
    #[serde(default)]
    pub set: Option<String>,
    #[serde(default)]
    pub append: Option<String>,
    #[serde(default, rename = "trimStart")]
    pub trim_start: Option<usize>,
}

/// One message waiting in pi's inbox.
#[derive(Debug, Deserialize)]
pub struct InboxItem {
    pub id: u64,
    #[serde(default)]
    pub mode: String,
}

#[derive(Debug, Deserialize)]
pub struct SubmissionRecord {
    #[serde(rename = "type", default)]
    pub kind: String,
    pub id: u64,
    #[serde(rename = "requestId", default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Generation {
    #[serde(default)]
    pub message: Option<Message>,
}

/// A durable entry: `model` holds the messages it gave the model; display-only entries have none.
#[derive(Debug, Deserialize)]
pub struct Entry {
    pub id: u64,
    pub kind: String,
    #[serde(default)]
    pub model: Vec<Message>,
    /// A display entry's record, such as a card's answer (`ky.card-answer`).
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    /// Where the model's context starts, on a snapshot's first entry: the chat before it pages in
    /// with `earlier` (`src/earlier.ts`).
    #[serde(default)]
    pub head: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: Content,
    /// Unix milliseconds.
    #[serde(default)]
    pub timestamp: Option<f64>,
    /// A tool result's call, and whether the tool failed.
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    /// An assistant message's: `toolUse` when it ends on calls, `aborted`, `error`, `stop`.
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

/// A user message's content is a string or parts; an assistant's is always blocks.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

impl Default for Content {
    fn default() -> Self {
        Content::Blocks(Vec::new())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Text { text: String },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    /// An image the user sent, inline: base64, no `data:` prefix.
    Image {
        #[serde(default)]
        data: String,
        #[serde(default, rename = "mimeType")]
        mime_type: String,
    },
    ToolCall {
        #[serde(default)]
        id: String,
        name: String,
        #[serde(default)]
        arguments: serde_json::Value,
    },
    #[serde(other)]
    Other,
}

/// One change to the in-flight assistant message.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Change {
    TextStart {
        #[serde(rename = "contentIndex")]
        index: usize,
        block: Block,
    },
    ThinkingStart {
        #[serde(rename = "contentIndex")]
        index: usize,
        block: Block,
    },
    ToolcallStart {
        #[serde(rename = "contentIndex")]
        index: usize,
        block: Block,
    },
    TextDelta {
        #[serde(rename = "contentIndex")]
        index: usize,
        delta: String,
    },
    ThinkingDelta {
        #[serde(rename = "contentIndex")]
        index: usize,
        delta: String,
    },
    Block {
        #[serde(rename = "contentIndex")]
        index: usize,
        block: Block,
    },
    Message { message: Message },
    #[serde(other)]
    Other,
}

/// Decode one socket text. `None` for the keepalive's `pong` and for anything that isn't a frame.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub chat: String,
    #[serde(default)]
    pub created_at: f64,
    #[serde(default)]
    pub lapsed_at: Option<f64>,
    #[serde(default)]
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

pub fn decode(text: &str) -> Option<Frame> {
    if !text.starts_with('{') {
        return None;
    }
    serde_json::from_str(text).ok()
}

/// Client → server.
pub fn submit(text: &str, operation_id: &str) -> String {
    submit_with(text, &[], operation_id)
}

/// A message with images: `input` is the web's parts, each image then the words; with none it
/// stays the words alone (`use-pi-session.ts` `messageInput`).
pub fn submit_with(text: &str, images: &[(String, String)], operation_id: &str) -> String {
    let input = if images.is_empty() {
        serde_json::Value::from(text)
    } else {
        let mut parts: Vec<serde_json::Value> = images.iter().map(|(mime, data)| serde_json::json!({ "type": "image", "data": data, "mimeType": mime })).collect();
        if !text.is_empty() {
            parts.push(serde_json::json!({ "type": "text", "text": text }));
        }
        serde_json::Value::Array(parts)
    };
    serde_json::json!({ "type": "submit", "input": input, "operationId": operation_id, "whenBusy": "followUp" }).to_string()
}

/// The answer to a card: the words, and which card and choices they came from.
pub fn submit_card(text: &str, operation_id: &str, call: &str, values: &[Vec<String>], button: Option<&str>) -> String {
    let mut card = serde_json::json!({ "call": call, "values": values });
    if let Some(button) = button {
        card["button"] = button.into();
    }
    serde_json::json!({ "type": "submit", "input": text, "operationId": operation_id, "whenBusy": "followUp", "card": card }).to_string()
}

pub fn approval_decide(id: &str, approval: &str, accept: bool) -> String {
    serde_json::json!({ "type": "approval-decide", "id": id, "approval": approval, "action": if accept { "accept" } else { "decline" } }).to_string()
}

/// Any command by its `type`, with an `id` its answer comes back under, and its fields.
pub fn command(kind: &str, id: &str, fields: serde_json::Value) -> String {
    let mut message = serde_json::json!({ "type": kind, "id": id });
    if let (Some(out), serde_json::Value::Object(fields)) = (message.as_object_mut(), fields) {
        out.extend(fields);
    }
    message.to_string()
}

pub fn abort() -> String {
    r#"{"type":"abort"}"#.to_string()
}

/// Start a side chat; the `result` is `{ session }`.
pub fn new_chat(id: &str) -> String {
    serde_json::json!({ "type": "new-chat", "id": id }).to_string()
}

pub fn rename_chat(session: &str, title: &str) -> String {
    serde_json::json!({ "type": "rename-chat", "session": session, "title": title }).to_string()
}

pub fn archive_chat(session: &str, archived: bool) -> String {
    serde_json::json!({ "type": "archive-chat", "session": session, "archived": archived }).to_string()
}

pub fn set_model(purpose: &str, provider: &str, model_id: &str, thinking_level: &str) -> String {
    serde_json::json!({
        "type": "set-model",
        "purpose": purpose,
        "choice": { "provider": provider, "modelId": model_id, "thinkingLevel": thinking_level }
    })
    .to_string()
}

pub const PING: &str = "ping";
