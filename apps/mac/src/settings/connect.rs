//! What ky connects to: Tools, Executor, Subscriptions (Claude, ChatGPT, GitHub), Webhooks with
//! credentials and browser logins, and Self-edits. The web's `ToolsGroup`, `Executor.tsx`,
//! `Subscriptions.tsx`, `Inbound.tsx`, `BrowserLogins.tsx` and `SelfEdits`.

use rune::{El, col, el, icon, row, text};
use serde_json::{Value, json};

use super::{Then, button, card, copy_line, empty, field, heading, line, link, list_at, note, num_at, off, plural, problem, rows, section, segmented, state, str_at, value};
use crate::theme::{META, Palette, ROW, icons};
use crate::wire::Subscription;
use crate::{Section, State, time};

pub fn tools(s: &State, p: &Palette) -> El {
    let mut page = col().w_full().gap(22.0).child(heading("Tools", "What ky can use in a chat.", p));
    let host = str_at(&s.executor, "url");
    let set = if host.is_empty() { "Not connected".to_string() } else { host_of(host) };
    page = page.child(rows(vec![link("goes:Executor", "Executor", Some("Apps and their approvals"), Some(set), p).on_press(|s: &mut State| s.open_section(Section::Executor))], p));
    if s.tools.is_empty() {
        return page.child(section("What ky can use", empty("Loading…", p), p));
    }
    let items = s.tools.iter().map(|t| line(&t.name, Some(&t.description), row(), p)).collect();
    page.child(section("What ky can use", rows(items, p), p))
}

fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/').next().unwrap_or(rest).to_string()
}

pub fn executor(s: &State, p: &Palette) -> El {
    let mut page = col().w_full().gap(22.0).child(heading("Executor", "Apps ky reaches through Executor, and whether each tool asks first.", p));
    let url = str_at(&s.executor, "url").to_string();
    let editing = s.adding == Some("executor");
    if url.is_empty() || editing {
        let busy = s.busy.contains("executor");
        let typed_url = s.typed("executor:url");
        let connect = button("set-executor", if busy { "Testing…" } else { "Test and connect" }, "primary", p);
        let connect = if busy || typed_url.is_empty() || (url.is_empty() && s.typed("executor:token").is_empty()) {
            off(connect)
        } else {
            connect.on_press(|s: &mut State| {
                let (url, token) = (s.typed("executor:url"), s.typed("executor:token"));
                let mut fields = json!({ "url": url });
                if !token.is_empty() {
                    fields["token"] = json!(token);
                }
                s.ask("set-executor", fields, Then::Form("executor"));
            })
        };
        let mut actions = row().w_full().gap(8.0).justify_end();
        if editing {
            actions = actions.child(button("executor-cancel", "Cancel", "", p).on_press(|s: &mut State| s.adding = None));
        }
        let mut form = col()
            .w_full()
            .px(16.0)
            .py(14.0)
            .gap(10.0)
            .child(field(s, "executor:url", "https://mcp.executor.sh/mcp", p))
            .child(field(s, "executor:token", if editing { "Keep the current token" } else { "Paste it here" }, p).secure())
            .child(actions.child(connect));
        if let Some(why) = problem(s, "executor", p) {
            form = form.child(why);
        }
        page = page.child(section(if editing { "Edit Executor" } else { "Connect Executor" }, card(p).child(form), p));
    } else {
        let actions = row()
            .gap(8.0)
            .center_y()
            .child(button("executor-edit", "Edit", "", p).on_press(move |s: &mut State| {
                let url = str_at(&s.executor, "url").to_string();
                s.set_field("executor:url", &url);
                s.adding = Some("executor");
            }))
            .child(button("executor-remove", "Remove", "danger", p).on_press(|s: &mut State| {
                s.tell("remove-executor", json!({}));
                s.executor = json!({ "url": null, "policies": [] });
            }));
        page = page.child(section("Connection", card(p).child(line("Connected", Some(&url), actions, p)), p));
    }
    let policies = list_at(&s.executor, "policies");
    if !policies.is_empty() {
        let items = policies
            .iter()
            .map(|t| {
                let tool = str_at(t, "tool").to_string();
                let name = tool.clone();
                let bar = segmented(&format!("policy:{tool}"), &[("allow", "Allow"), ("ask", "Ask"), ("block", "Block")], str_at(t, "policy"), p, move |s, policy| {
                    s.ask("set-tool-policy", json!({ "tool": name, "policy": policy }), Then::Form("policy"));
                    if let Some(row) = s.executor.get_mut("policies").and_then(Value::as_array_mut).and_then(|ps| ps.iter_mut().find(|r| str_at(r, "tool") == name)) {
                        row["policy"] = json!(policy);
                    }
                });
                line(&tool, None, bar, p)
            })
            .collect();
        page = page.child(section("Approvals", rows(items, p), p));
        page = page.child(note("Allow approves only while you're in the chat; in a routine or a peer's question it asks you.", p));
    }
    page
}

fn subscription<'a>(s: &'a State, kind: &str) -> Option<&'a Subscription> {
    s.subscriptions.iter().find(|v| v.kind == kind)
}

/// The Claude token's expiry note (`expiry`).
fn expiry(at: f64) -> String {
    let days = ((at - time::now_ms()) / 86_400_000.0).floor() as i64;
    if days <= 0 {
        "Expired; make a new token".into()
    } else if days <= 14 {
        format!("Expires in {}; make a new token soon", plural(days as usize, "day"))
    } else {
        format!("Expires in {}", plural(days as usize, "day"))
    }
}

fn remove(kind: &'static str, p: &Palette) -> El {
    button(&format!("remove-subscription:{kind}"), "Remove", "danger", p).on_press(move |s: &mut State| {
        s.tell("remove-subscription", json!({ "kind": kind }));
        if let Some(v) = s.subscriptions.iter_mut().find(|v| v.kind == kind) {
            v.connected = false;
        }
    })
}

/// A row of a subscription that's set up: its note, On, and Remove.
fn connected(kind: &'static str, label: &str, sub: &str, on: bool, p: &Palette) -> El {
    let mut end = row().gap(12.0).center_y().child(remove(kind, p));
    if on {
        end = end.child(state("On", p.success, p));
    }
    line(label, Some(sub), end, p)
}

/// A row with a token to paste and a button.
fn token_form(s: &State, kind: &'static str, label: &str, sub: &str, placeholder: &str, go: El, p: &Palette) -> El {
    let mut form = col().w_full().child(line(label, Some(sub), row(), p)).child(row().w_full().px(16.0).pb(12.0).gap(10.0).center_y().child(field(s, &format!("{kind}:token"), placeholder, p).secure()).child(go));
    if let Some(why) = problem(s, kind, p) {
        form = form.child(why.px(16.0).pb(12.0));
    }
    form
}

pub fn subscriptions(s: &State, p: &Palette) -> El {
    let page = col().w_full().gap(22.0).child(heading("Subscriptions", "Your Claude and ChatGPT plans, for machine tasks, and GitHub, for the cloud machine.", p));
    if s.machines.as_array().is_none_or(Vec::is_empty) {
        return page.child(
            card(p).child(
                col()
                    .w_full()
                    .px(16.0)
                    .py(18.0)
                    .gap(10.0)
                    .center()
                    .child(text("Pair a machine first").font(META).color(p.quiet))
                    .child(button("go-machines", "Go to Machines", "", p).on_press(|s: &mut State| s.open_section(Section::Machines))),
            ),
        );
    }
    // Claude.
    let claude = subscription(s, "claude");
    let claude_row = match claude {
        Some(c) if c.connected => connected("claude", "Claude", &c.expires_at.map_or("Connected".into(), expiry), true, p),
        _ => {
            let busy = s.busy.contains("claude");
            let save = button("set-claude", "Save", "primary", p);
            let save = if busy || s.typed("claude:token").is_empty() {
                off(save)
            } else {
                save.on_press(|s: &mut State| {
                    let token = s.typed("claude:token");
                    s.ask("set-claude", json!({ "token": token }), Then::Form("claude"));
                })
            };
            token_form(s, "claude", "Claude", "Paste what claude setup-token prints", "sk-ant-oat…", save, p)
        }
    };
    // ChatGPT.
    let chatgpt = subscription(s, "chatgpt");
    let chatgpt_row = match chatgpt {
        Some(c) if c.connected => {
            let sub = c.error.clone().unwrap_or_else(|| "Signed in; ky renews it".into());
            connected("chatgpt", "ChatGPT", &sub, c.error.is_none(), p)
        }
        _ => {
            let code = s.views.get("chatgpt-code");
            let sign = button("chatgpt-login", if code.is_some() { "New code" } else { "Sign in" }, "", p).on_press(|s: &mut State| s.ask("chatgpt-login", json!({}), Then::ChatGpt));
            let mut block = col().w_full().child(line("ChatGPT", Some("Sign in with a code"), sign, p));
            if let Some(code) = code {
                let url = str_at(code, "verificationUrl").to_string();
                let before = super::clock(num_at(code, "_at") + 15.0 * 60_000.0);
                let open = url.clone();
                block = block.child(
                    col()
                        .w_full()
                        .px(16.0)
                        .pb(12.0)
                        .gap(8.0)
                        .child(copy_line("chatgpt-code", str_at(code, "userCode"), p))
                        .child(
                            row()
                                .gap(4.0)
                                .flex_wrap()
                                .child(text("Open").font(META).color(p.quiet))
                                .child(text(url.clone()).font(META).color(p.ink).key("chatgpt-url").role("link").label(&url).on_press(move |_: &mut State| {
                                    let _ = std::process::Command::new("open").arg(&open).spawn();
                                }))
                                .child(text(format!(", sign in to ChatGPT and enter this code before {before}.")).font(META).color(p.quiet)),
                        ),
                );
            }
            if let Some(why) = problem(s, "chatgpt", p) {
                block = block.child(why.px(16.0).pb(12.0));
            }
            block
        }
    };
    // GitHub.
    let github = subscription(s, "github");
    let github_row = match github {
        Some(g) if g.connected => connected("github", "GitHub", &format!("{}: {}", plural(g.repos.len(), "repo"), g.repos.join(", ")), true, p),
        _ => github_form(s, p),
    };
    page.child(rows(vec![claude_row, chatgpt_row, github_row], p))
}

fn github_form(s: &State, p: &Palette) -> El {
    let busy = s.busy.contains("github");
    let repos = s.views.get("github-repos").and_then(Value::as_array);
    let go = match repos {
        None => {
            let next = button("github-next", if busy { "Checking…" } else { "Next" }, "", p);
            if busy || s.typed("github:token").is_empty() {
                off(next)
            } else {
                next.on_press(|s: &mut State| {
                    let token = s.typed("github:token");
                    s.ask("github-repos", json!({ "token": token }), Then::Repos);
                })
            }
        }
        Some(_) => {
            let save = button("set-github", "Save", "primary", p);
            if busy || s.ticks.is_empty() {
                off(save)
            } else {
                save.on_press(|s: &mut State| {
                    let token = s.typed("github:token");
                    let mut picked: Vec<String> = s.ticks.iter().filter_map(|t| t.strip_prefix("repo:").map(str::to_string)).collect();
                    picked.sort();
                    s.ask("set-github", json!({ "token": token, "repos": picked }), Then::Form("github"));
                })
            }
        }
    };
    let mut form = token_form(s, "github", "GitHub", "Token with Contents, PRs and Actions", "github_pat_…", go, p);
    if let Some(repos) = repos {
        let mut list = col().w_full().px(16.0).pb(12.0).gap(2.0).child(text("Repos the cloud machine may use").font(META).color(p.quiet).pb(4.0));
        for repo in repos.iter().filter_map(Value::as_str) {
            let tick = format!("repo:{repo}");
            let on = s.ticks.contains(&tick);
            let mut boxed = el().size(16.0, 16.0).radius(4.0).border(1.0, if on { p.ink } else { p.line_strong }).center();
            if on {
                boxed = boxed.fill(p.ink).child(icon(&icons::CHECK, 11.0).color(p.user_ink));
            }
            list = list.child(
                row()
                    .key(&format!("tick:{repo}"))
                    .role("checkbox")
                    .label(repo)
                    .w_full()
                    .h(30.0)
                    .gap(10.0)
                    .center_y()
                    .child(boxed)
                    .child(text(repo.to_string()).font(ROW).color(p.ink))
                    .on_press(move |s: &mut State| {
                        if !s.ticks.remove(&tick) {
                            s.ticks.insert(tick.clone());
                        }
                        s.ui_rev += 1;
                    }),
            );
        }
        form = form.child(list);
    }
    form
}

pub fn webhooks(s: &State, p: &Palette) -> El {
    let now = time::now_ms();
    let new = button("new-hook", "New webhook", "", p).on_press(|s: &mut State| s.adding = Some("hook"));
    let head = row().w_full().gap(12.0).child(heading("Webhooks", "Addresses a service posts to, each into a chat; and the keys and logins ky keeps.", p).grow(1.0).shrink()).child(new);
    let mut page = col().w_full().gap(22.0).child(head);
    if let Some(made) = s.views.get("made-hook") {
        page = page.child(
            card(p).child(
                col()
                    .w_full()
                    .px(16.0)
                    .py(14.0)
                    .gap(10.0)
                    .child(text("Give this URL to the service that posts. It shows only now; rotate the hook for a new one.").font(META).color(p.muted).wrap())
                    .child(copy_line("hook-url", str_at(made, "url"), p))
                    .children(if str_at(made, "signing").is_empty() {
                        vec![]
                    } else {
                        vec![
                            text("Its signing secret, for an X-Hub-Signature-256 header, like GitHub's:").font(META).color(p.muted).wrap(),
                            copy_line("hook-signing", str_at(made, "signing"), p),
                        ]
                    })
                    .child(row().w_full().justify_end().child(button("hook-done", "Done", "primary", p).on_press(|s: &mut State| {
                        s.views.remove("made-hook");
                        s.ui_rev += 1;
                    }))),
            ),
        );
    }
    let view = s.views.get("hooks");
    let chats = view.map_or(&[][..], |v| list_at(v, "chats"));
    if s.adding == Some("hook") {
        page = page.child(section("Add a webhook", hook_form(s, chats, p), p));
    }
    let chat_title = |id: &str| chats.iter().find(|c| str_at(c, "session") == id).map_or("a chat".to_string(), |c| str_at(c, "title").to_string());
    let hooks = match view {
        None => empty(s.problems.get("hooks").map_or("Loading webhooks…", String::as_str), p),
        Some(v) if list_at(v, "hooks").is_empty() => empty("No webhooks yet", p),
        Some(v) => rows(
            list_at(v, "hooks")
                .iter()
                .map(|h| {
                    let id = str_at(h, "id").to_string();
                    let last = h.get("lastAt").and_then(Value::as_f64).map_or("nothing yet".to_string(), |at| format!("last {}", time::ago(at, now)));
                    let signed = if h.get("signed").and_then(Value::as_bool) == Some(true) { " · signed" } else { "" };
                    let sub = format!("Into {}{signed} · {last}", chat_title(str_at(h, "session")));
                    let (rotate, delete) = (id.clone(), id.clone());
                    let end = row()
                        .gap(8.0)
                        .child(button(&format!("rotate:{id}"), "Rotate", "", p).on_press(move |s: &mut State| {
                            s.http("POST", &format!("/api/inbound/hooks/{rotate}/rotate"), None, Then::Http { store: Some("made-hook"), form: "hooks" });
                        }))
                        .child(button(&format!("delete:{id}"), "Delete", "danger", p).on_press(move |s: &mut State| {
                            s.http("DELETE", &format!("/api/inbound/hooks/{delete}"), None, Then::Http { store: None, form: "hooks" });
                        }));
                    line(str_at(h, "label"), Some(&sub), end, p)
                })
                .collect(),
            p,
        ),
    };
    page = page.child(section("Webhooks", hooks, p));
    if let Some(why) = problem(s, "hooks", p).filter(|_| view.is_some()) {
        page = page.child(why);
    }
    // Credentials.
    let secrets = match s.views.get("secrets") {
        None => empty(s.problems.get("secrets").map_or("Loading…", String::as_str), p),
        Some(v) if list_at(v, "secrets").is_empty() => empty("None yet", p),
        Some(v) => rows(
            list_at(v, "secrets")
                .iter()
                .map(|c| {
                    let (owner, name) = (str_at(c, "owner").to_string(), str_at(c, "name").to_string());
                    let how = [str_at(c, "scheme"), str_at(c, "header")].into_iter().filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" · ");
                    let sub = format!("{} · {how}", owner_name(&owner));
                    let path = format!("/api/inbound/secrets/{owner}/{name}");
                    line(&name, Some(&sub), button(&format!("remove-secret:{owner}:{name}"), "Remove", "danger", p).on_press(move |s: &mut State| s.http("DELETE", &path, None, Then::Http { store: None, form: "secrets" })), p)
                })
                .collect(),
            p,
        ),
    };
    page = page.child(section("Credentials", secrets, p));
    // Browser logins.
    let logins = match s.views.get("logins") {
        None => empty(s.problems.get("logins").map_or("Loading…", String::as_str), p),
        Some(v) if list_at(v, "logins").is_empty() => empty("None yet", p),
        Some(v) => rows(
            list_at(v, "logins")
                .iter()
                .map(|l| {
                    let (owner, site) = (str_at(l, "owner").to_string(), str_at(l, "site").to_string());
                    let sub = format!("{}'s browser · {} · saved {}", owner_name(&owner), plural(num_at(l, "cookies") as usize, "cookie"), time::ago(num_at(l, "updatedAt"), now));
                    let path = format!("/api/browse/logins/{owner}/{site}");
                    line(&site, Some(&sub), button(&format!("remove-login:{owner}:{site}"), "Remove", "danger", p).on_press(move |s: &mut State| s.http("DELETE", &path, None, Then::Http { store: None, form: "logins" })), p)
                })
                .collect(),
            p,
        ),
    };
    page = page.child(section("Browser logins", logins, p));
    for key in ["secrets", "logins"] {
        if let Some(why) = problem(s, key, p).filter(|_| s.views.contains_key(key)) {
            page = page.child(why);
        }
    }
    page.child(note("Moving a key or a login to another owner is on ky on the web.", p))
}

/// The web's `ownerName`: ky's own, everyone's, or `@owner`.
fn owner_name(owner: &str) -> String {
    match owner {
        "" | "ky" => "ky".into(),
        "*" => "Shared with all".into(),
        o => format!("@{o}"),
    }
}

fn hook_form(s: &State, chats: &[Value], p: &Palette) -> El {
    let chosen = s.picks.get("hook-chat").cloned().or_else(|| chats.first().map(|c| str_at(c, "session").to_string())).unwrap_or_default();
    let mut chips = row().gap(6.0).flex_wrap();
    for c in chats.iter().take(12) {
        let session = str_at(c, "session").to_string();
        let on = session == chosen;
        let title = str_at(c, "title");
        let mut chip = row()
            .key(&format!("hook-chat:{session}"))
            .role("button")
            .label(title)
            .h(28.0)
            .px(12.0)
            .center()
            .radius(14.0)
            .border(1.0, if on { p.ink } else { p.line_strong })
            .child(text(title.to_string()).font(META).color(if on { p.ink } else { p.muted }).max_lines(1))
            .on_press(move |s: &mut State| {
                s.picks.insert("hook-chat", session.clone());
            });
        if on {
            chip = chip.fill(p.selected);
        }
        chips = chips.child(chip);
    }
    let signed = s.ticks.contains("hook:signed");
    let sign = segmented("hook-signed", &[("yes", "Yes"), ("no", "No")], if signed { "yes" } else { "no" }, p, |s, v| {
        if v == "yes" {
            s.ticks.insert("hook:signed".into());
        } else {
            s.ticks.remove("hook:signed");
        }
        s.ui_rev += 1;
    });
    let busy = s.busy.contains("hook");
    let add = button("make-hook", "Add", "primary", p);
    let add = if busy || s.typed("hook:name").is_empty() || chosen.is_empty() {
        off(add)
    } else {
        add.on_press(move |s: &mut State| {
            let body = json!({ "session": chosen, "label": s.typed("hook:name"), "signed": s.ticks.contains("hook:signed") });
            s.set_field("hook:name", "");
            s.http("POST", "/api/inbound/hooks", Some(body), Then::Http { store: Some("made-hook"), form: "hook" });
        })
    };
    let mut form = col()
        .w_full()
        .px(16.0)
        .py(14.0)
        .gap(12.0)
        .child(field(s, "hook:name", "e.g. GitHub pushes", p))
        .child(col().gap(6.0).child(text("Chat").font(META).color(p.quiet)).child(if chats.is_empty() { text("No chats yet").font(META).color(p.quiet) } else { chips }))
        .child(row().w_full().gap(10.0).center_y().child(text("Signed with a secret").font(ROW).color(p.ink).grow(1.0)).child(sign))
        .child(row().w_full().gap(8.0).justify_end().child(button("hook-cancel", "Cancel", "", p).on_press(|s: &mut State| s.adding = None)).child(add));
    if let Some(why) = problem(s, "hook", p) {
        form = form.child(why);
    }
    card(p).child(form)
}

pub fn self_edits(s: &State, p: &Palette) -> El {
    let page = col().w_full().gap(22.0).child(heading("Self-edits", "The repo ky changes when you ask it to change itself.", p));
    if s.setup.is_null() {
        return page.child(empty("Loading…", p));
    }
    let repo = str_at(&s.setup, "repo");
    let url = str_at(&s.setup, "url");
    let busy = s.busy.contains("repo");
    let typed = s.typed("repo:repo");
    let save = button("set-repo", "Save", "primary", p);
    let save = if busy || typed.is_empty() || typed == repo || !typed.contains('/') {
        off(save)
    } else {
        save.on_press(|s: &mut State| {
            let repo = s.typed("repo:repo");
            s.ask("set-repo", json!({ "repo": repo }), Then::Form("repo"));
        })
    };
    let mut repo_row = col()
        .w_full()
        .child(line("Repo", Some(if repo.is_empty() { "Not set" } else { repo }), row(), p))
        .child(row().w_full().px(16.0).pb(12.0).gap(10.0).center_y().child(field(s, "repo:repo", if repo.is_empty() { "owner/name" } else { repo }, p)).child(save));
    if let Some(why) = problem(s, "repo", p) {
        repo_row = repo_row.child(why.px(16.0).pb(12.0));
    }
    let address = line("Address", None, if url.is_empty() { value("Set with the repo", p) } else { text(url.to_string()).font(ROW).color(p.muted).selectable(true).max_lines(1) }, p);
    page.child(rows(vec![repo_row, address], p))
}
