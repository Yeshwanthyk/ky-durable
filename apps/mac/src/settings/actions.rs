//! What Settings asks ky and does with the answers. Most pages ask over the main chat's socket
//! (`ask`: a command with an id, its `result` routed back here by `poll`); Webhooks, credentials,
//! browser logins and machine pairing are plain HTTP on ky's address (`http`), as the web's are,
//! each on its own thread with the Access token.

use std::time::Duration;

use serde_json::{Value, json};

use crate::{Section, State, signin, time, wire};

/// What an answer is for.
#[derive(Debug, Clone)]
pub enum Then {
    /// A view to keep under this name (`spend`, `peers`…); a `{refused}` answer is its problem.
    Store(&'static str),
    /// A form's save: a refusal shows under the form; success clears its fields, closes it and
    /// asks the page again.
    Form(&'static str),
    /// `github-repos`: the repos a token reaches, to pick from.
    Repos,
    /// `chatgpt-login`: the code to enter, then polling until the sign-in is done.
    ChatGpt,
    ChatGptPoll(String),
    /// Time to poll again.
    ChatGptTick(String),
    /// An HTTP call: keep its answer under `store` if any, else (a change) ask the page again.
    Http { store: Option<&'static str>, form: &'static str },
    /// A queued message taken back, to edit or not.
    Withdraw { session: String, operation: String, edit: bool },
    /// `task-steps`: a task's log, for its sheet.
    Steps(String),
    /// `dream-undo`: a refusal shows on its row; either way the ledger is asked again.
    Undo(i64),
    /// `automation-save`: back to the list, or why ky refused it under the form.
    Routine,
    /// `earlier`: a page of a chat before entry `before`.
    Earlier { session: String, before: u64 },
}

/// How often a ChatGPT sign-in is asked after, and how long its code lasts (`Subscriptions.tsx`).
const POLL: Duration = Duration::from_secs(3);
const CODE_MS: f64 = 15.0 * 60_000.0;

impl State {
    /// Show `section`, as its sidebar row or ⌘K does, and ask ky for what it shows.
    pub fn open_section(&mut self, section: Section) {
        self.section = section;
        self.detail = None;
        self.adding = None;
        self.confirm = None;
        self.load(section);
    }

    /// A page under a section: a purpose's model page, a machine's page.
    pub fn open_detail(&mut self, section: Section, detail: &str) {
        self.open_section(section);
        self.detail = Some(detail.to_string());
    }

    /// Ask for what `section` shows that no frame brings.
    pub fn load(&mut self, section: Section) {
        match section {
            Section::General => {
                self.ask("spend", json!({}), Then::Store("spend"));
                self.ask("proactivity", json!({}), Then::Store("proactivity"));
            }
            Section::Spend => self.ask("spend", json!({}), Then::Store("spend")),
            Section::Proactivity => {
                self.ask("proactivity", json!({}), Then::Store("proactivity"));
                self.ask("zone", json!({}), Then::Store("zone"));
                self.ask("post-verdicts", json!({}), Then::Store("verdicts"));
            }
            Section::Peers => self.ask("peer-list", json!({}), Then::Store("peers")),
            Section::Mail => self.ask("mail-view", json!({}), Then::Store("mail")),
            Section::Webhooks => {
                self.http("GET", "/api/inbound/hooks", None, Then::Http { store: Some("hooks"), form: "hooks" });
                self.http("GET", "/api/inbound/secrets", None, Then::Http { store: Some("secrets"), form: "secrets" });
                self.http("GET", "/api/browse/logins", None, Then::Http { store: Some("logins"), form: "logins" });
            }
            _ => {}
        }
    }

    /// A command ky answers, by `kind`, with `fields`.
    pub fn ask(&mut self, kind: &str, fields: Value, then: Then) {
        if !self.main_conn().is_some_and(|m| m.live()) {
            return;
        }
        self.sent += 1;
        let id = format!("mac-ask-{}", self.sent);
        if let Some(main) = self.main_conn() {
            main.send(wire::command(kind, &id, fields));
        }
        if let Then::Form(form) | Then::Http { form, .. } = &then {
            self.busy.insert(form);
        }
        if let Then::Routine = then {
            self.busy.insert("routine");
        }
        if let Then::Repos = then {
            self.busy.insert("github");
        }
        self.asks.insert(id, then);
    }

    /// A command ky doesn't answer; the next frame shows what it changed.
    pub fn tell(&mut self, kind: &str, fields: Value) {
        self.sent += 1;
        let id = format!("mac-tell-{}", self.sent);
        if let Some(main) = self.main_conn() {
            main.send(wire::command(kind, &id, fields));
        }
    }

    /// An HTTP call on ky's address, signed in as the socket is.
    pub fn http(&mut self, method: &'static str, path: &str, body: Option<Value>, then: Then) {
        let (Some(config), Some(waker)) = (&self.config, &self.waker) else { return };
        if let Then::Http { form, .. } = &then {
            self.busy.insert(form);
        }
        let (config, waker, out) = (config.clone(), waker.clone(), self.http.0.clone());
        let url = format!("{}{path}", config.base.trim_end_matches('/'));
        std::thread::spawn(move || {
            let token = match (&config.token, config.local()) {
                (Some(t), _) => Ok(Some(t.clone())),
                (None, true) => Ok(None),
                (None, false) => signin::saved(&config.base).map(Some).ok_or_else(|| "Signed out: sign in again".to_string()),
            };
            let answer = token.and_then(|token| request(method, &url, token.as_deref(), body));
            if out.send((then, answer)).is_ok() {
                waker();
            }
        });
    }

    /// Land an answer.
    pub fn answer(&mut self, then: Then, answer: Result<Value, String>) {
        let refused = |v: &Value| v.get("refused").and_then(Value::as_str).map(str::to_string);
        match then {
            Then::Withdraw { session, operation, edit } => self.withdrawn(&session, &operation, edit, answer),
            Then::Earlier { session, before } => {
                if let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) {
                    conn.chat.prepend(before, answer);
                }
            }
            Then::Steps(task) => match answer {
                Ok(Value::Array(steps)) => {
                    self.problems.remove("task-steps");
                    self.activity.steps.insert(task, steps);
                }
                Ok(v) => {
                    if let Some(why) = refused(&v) {
                        self.problems.insert("task-steps", why);
                    }
                }
                Err(why) => {
                    self.problems.insert("task-steps", why);
                }
            },
            Then::Undo(entry) => {
                self.activity.undoing = None;
                match answer.map(|v| refused(&v).or_else(|| v.get("error").and_then(Value::as_str).map(str::to_string))) {
                    Ok(None) => {
                        self.activity.refusals.remove(&entry);
                    }
                    Ok(Some(why)) | Err(why) => {
                        self.activity.refusals.insert(entry, why);
                    }
                }
                self.ask("dream-ledger", json!({}), Then::Store("dream-ledger"));
            }
            Then::Routine => {
                self.busy.remove("routine");
                match answer.map(|v| refused(&v)) {
                    Ok(None) => {
                        self.problems.remove("routine");
                        self.close_routine();
                    }
                    Ok(Some(why)) | Err(why) => {
                        self.problems.insert("routine", why);
                    }
                }
            }
            Then::Store(key) => match answer {
                Ok(v) if refused(&v).is_some() => {
                    self.problems.insert(key, refused(&v).unwrap_or_default());
                }
                Ok(mut v) => {
                    if let Value::Object(o) = &mut v {
                        o.insert("_at".into(), json!(time::now_ms()));
                    }
                    self.views.insert(key, v);
                    self.problems.remove(key);
                }
                Err(why) => {
                    self.problems.insert(key, why);
                }
            },
            Then::Form(form) => {
                self.busy.remove(form);
                match answer.map(|v| refused(&v)) {
                    Ok(None) => {
                        self.problems.remove(form);
                        self.fields.retain(|k, _| !k.starts_with(&format!("{form}:")));
                        if self.adding == Some(form) {
                            self.adding = None;
                        }
                        self.confirm = None;
                        self.load(self.section);
                    }
                    Ok(Some(why)) | Err(why) => {
                        self.problems.insert(form, why);
                    }
                }
            }
            Then::Repos => {
                self.busy.remove("github");
                match answer {
                    Ok(v) if refused(&v).is_some() => {
                        self.problems.insert("github", refused(&v).unwrap_or_default());
                    }
                    Ok(v) => {
                        let repos = v.get("repos").cloned().unwrap_or(json!([]));
                        if repos.as_array().is_none_or(Vec::is_empty) {
                            self.problems.insert("github", "The token reaches no repos: give it some on GitHub.".into());
                        } else {
                            self.problems.remove("github");
                            self.views.insert("github-repos", repos);
                        }
                    }
                    Err(why) => {
                        self.problems.insert("github", why);
                    }
                }
            }
            Then::ChatGpt => match answer {
                Ok(v) if refused(&v).is_some() => {
                    self.problems.insert("chatgpt", refused(&v).unwrap_or_default());
                }
                Ok(mut v) => {
                    let login = v.get("loginId").and_then(Value::as_str).unwrap_or_default().to_string();
                    if let Value::Object(o) = &mut v {
                        o.insert("_at".into(), json!(time::now_ms()));
                    }
                    self.problems.remove("chatgpt");
                    self.views.insert("chatgpt-code", v);
                    self.ask("chatgpt-poll", json!({ "login": login }), Then::ChatGptPoll(login));
                }
                Err(why) => {
                    self.problems.insert("chatgpt", why);
                }
            },
            Then::ChatGptPoll(login) => match answer {
                Ok(Value::String(s)) if s == "pending" => self.later(POLL, Then::ChatGptTick(login)),
                Ok(Value::String(s)) if s == "done" => {
                    self.views.remove("chatgpt-code");
                }
                Ok(v) => {
                    self.views.remove("chatgpt-code");
                    self.problems.insert("chatgpt", v.get("error").and_then(Value::as_str).unwrap_or("ChatGPT didn't sign in.").to_string());
                }
                Err(why) => {
                    self.problems.insert("chatgpt", why);
                }
            },
            Then::ChatGptTick(login) => {
                let code = self.views.get("chatgpt-code");
                let current = code.and_then(|c| c.get("loginId")).and_then(Value::as_str) == Some(login.as_str());
                let fresh = code.and_then(|c| c.get("_at")).and_then(Value::as_f64).is_some_and(|at| time::now_ms() - at < CODE_MS);
                if current && fresh {
                    self.ask("chatgpt-poll", json!({ "login": login }), Then::ChatGptPoll(login));
                }
            }
            Then::Http { store, form } => {
                self.busy.remove(form);
                match answer {
                    Ok(mut v) => {
                        self.problems.remove(form);
                        match store {
                            Some(key) => {
                                if let Value::Object(o) = &mut v {
                                    o.insert("_at".into(), json!(time::now_ms()));
                                }
                                self.views.insert(key, v);
                            }
                            None => {
                                self.fields.retain(|k, _| !k.starts_with(&format!("{form}:")));
                                self.confirm = None;
                                self.load(self.section);
                            }
                        }
                        if store == Some("made-hook") {
                            self.adding = None;
                            self.load(self.section);
                        }
                    }
                    Err(why) => {
                        self.problems.insert(form, why);
                    }
                }
            }
        }
        self.ui_rev += 1;
    }

    /// Land `then` after `wait`, through the HTTP channel so it wakes the window.
    fn later(&self, wait: Duration, then: Then) {
        let Some(waker) = self.waker.clone() else { return };
        let out = self.http.0.clone();
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            if out.send((then, Ok(Value::Null))).is_ok() {
                waker();
            }
        });
    }

    /// A Settings text field, for its `on_edit`.
    pub fn field(&mut self, key: &str) -> &mut rune::TextEdit {
        self.fields.entry(key.to_string()).or_insert_with(|| rune::TextEdit::new(""))
    }

    /// What's typed in a Settings field, trimmed.
    pub fn typed(&self, key: &str) -> String {
        self.fields.get(key).map(|f| f.text.trim().to_string()).unwrap_or_default()
    }

    pub fn set_field(&mut self, key: &str, text: &str) {
        self.fields.insert(key.to_string(), rune::TextEdit::new(text));
    }
}

fn request(method: &str, url: &str, token: Option<&str>, body: Option<Value>) -> Result<Value, String> {
    let mut call = ureq::request(method, url).timeout(Duration::from_secs(20));
    if let Some(token) = token {
        call = call.set("Cookie", &format!("CF_Authorization={token}")).set("cf-access-token", token);
    }
    let answer = match body {
        Some(body) => call.set("Content-Type", "application/json").send_string(&body.to_string()),
        None => call.call(),
    };
    match answer {
        Ok(response) => {
            let text = response.into_string().map_err(|e| e.to_string())?;
            Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
        }
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(if text.trim().is_empty() || text.starts_with('<') { format!("ky answered {code}.") } else { text })
        }
        Err(e) => Err(format!("Not connected: {e}")),
    }
}

/// Put `text` on the clipboard.
pub fn copy(text: &str) {
    use std::io::Write;
    if let Ok(mut child) = std::process::Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
    }
}
