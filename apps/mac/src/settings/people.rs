//! Who ky talks to, and when: Proactivity (messaging you first, its look times and zone, how many
//! posts a day notify), Peers (other people's kys) and Mail. The web's `Proactivity.tsx`,
//! `Peers.tsx` and `Mail.tsx`.

use rune::{El, col, icon, row, text};
use serde_json::{Value, json};

use super::{Then, button, card, copy_line, dot, empty, field, heading, line, list_at, note, num_at, off, problem, rows, section, segmented, state, str_at, tone, value};
use crate::theme::{META, Palette, ROW, icons};
use crate::{State, time};

const LOOK_TIMES: usize = 4;
const RIGHT_AWAY_MOST: i64 = 24;

pub fn proactivity(s: &State, p: &Palette) -> El {
    let page = col().w_full().gap(22.0).child(heading("Proactivity", "Whether ky messages you first, when it looks, and what notifies you.", p));
    let Some(v) = s.views.get("proactivity") else {
        return page.child(empty(s.problems.get("proactivity").map_or("Loading…", String::as_str), p));
    };
    let level = segmented("proactivity", &[("on", "On"), ("off", "Off")], str_at(v, "level"), p, |s, level| {
        s.ask("set-proactivity", json!({ "level": level }), Then::Store("proactivity"));
        if let Some(v) = s.views.get_mut("proactivity") {
            v["level"] = json!(level);
        }
    });
    let sub = if str_at(v, "level") == "on" { "When you're needed" } else { "Only when you write" };
    let useful = match s.views.get("verdicts") {
        Some(u) if num_at(u, "judged") > 0.0 => format!("{:.0}%", 100.0 * num_at(u, "useful") / num_at(u, "judged")),
        Some(_) => "None rated yet".into(),
        None => "…".into(),
    };
    let unasked = rows(vec![line("Messages you first", Some(sub), level, p), line("Useful", Some("Rated, last 30 days"), value(useful, p), p)], p);
    let mut page = page.child(section("Unasked", unasked, p));
    // Schedule.
    let looks: Vec<String> = list_at(v, "looks").iter().filter_map(Value::as_str).map(str::to_string).collect();
    let mut chips = row().gap(6.0).flex_wrap().center_y();
    for t in &looks {
        let gone: Vec<String> = looks.iter().filter(|l| *l != t).cloned().collect();
        chips = chips.child(
            row()
                .key(&format!("look:{t}"))
                .role("button")
                .label(&format!("Remove {t}"))
                .h(28.0)
                .pl(12.0)
                .pr(8.0)
                .gap(6.0)
                .center_y()
                .radius(14.0)
                .border(1.0, p.line_strong)
                .hover(p.hover)
                .child(text(t.clone()).font(META).color(p.ink))
                .child(icon(&icons::CLOSE, 11.0).color(p.quiet))
                .on_press(move |s: &mut State| s.ask("set-looks", json!({ "looks": gone }), Then::Store("proactivity"))),
        );
    }
    let typed = s.typed("look:time");
    let valid = parse_time(&typed);
    let mut look_row = col().w_full().child(line("Looks at", Some("When ky looks for something to tell you"), row(), p)).child(row().w_full().px(16.0).pb(if looks.len() < LOOK_TIMES { 4.0 } else { 12.0 }).child(chips));
    if looks.len() < LOOK_TIMES {
        let add = button("add-look", "Add", "", p);
        let add = match valid {
            Some(t) if !looks.contains(&t) => {
                let mut next = looks.clone();
                next.push(t);
                next.sort();
                add.on_press(move |s: &mut State| {
                    s.set_field("look:time", "");
                    s.ask("set-looks", json!({ "looks": next }), Then::Store("proactivity"));
                })
            }
            _ => off(add),
        };
        look_row = look_row.child(row().w_full().px(16.0).pt(6.0).pb(12.0).gap(10.0).center_y().child(field(s, "look:time", "Add a time, like 08:30", p).w(180.0).min_w(180.0).grow(0.0)).child(add));
    }
    let zone = s.views.get("zone");
    let detected = zone.map_or("", |z| str_at(z, "detected"));
    let pinned = zone.is_some_and(|z| z.get("pinned").and_then(Value::as_bool) == Some(true));
    let zone_now = zone.map_or("", |z| str_at(z, "zone"));
    let auto = if detected.is_empty() { "Automatic".to_string() } else { format!("Automatic ({detected})") };
    let mut zone_end = row().gap(8.0).center_y();
    if pinned {
        zone_end = zone_end.child(value(zone_now, p)).child(button("zone-auto", "Automatic", "", p).on_press(|s: &mut State| s.ask("set-zone", json!({ "zone": null }), Then::Store("zone"))));
    } else {
        zone_end = zone_end.child(value(auto, p));
    }
    let mut zone_row = col().w_full().child(line("Time zone", Some(if pinned { "Pinned" } else { "Follows where your devices are" }), zone_end, p));
    let typed_zone = s.typed("zone:zone");
    let pin = button("zone-pin", "Pin", "", p);
    let pin = if typed_zone.contains('/') {
        pin.on_press(|s: &mut State| {
            let zone = s.typed("zone:zone");
            s.set_field("zone:zone", "");
            s.ask("set-zone", json!({ "zone": zone }), Then::Store("zone"));
        })
    } else {
        off(pin)
    };
    zone_row = zone_row.child(row().w_full().px(16.0).pb(12.0).gap(10.0).center_y().child(field(s, "zone:zone", "Pin one, like Europe/London", p)).child(pin));
    page = page.child(section("Schedule", rows(vec![look_row, zone_row], p), p));
    if let Some(why) = problem(s, "zone", p) {
        page = page.child(why);
    }
    // Notifications.
    let most = num_at(v, "rightAway") as i64;
    let step = |key: &str, label: &str, to: i64, p: &Palette| {
        let b = button(key, label, "", p);
        if (0..=RIGHT_AWAY_MOST).contains(&to) && to != most {
            b.on_press(move |s: &mut State| {
                s.ask("set-right-away", json!({ "most": to }), Then::Store("proactivity"));
                if let Some(v) = s.views.get_mut("proactivity") {
                    v["rightAway"] = json!(to);
                }
            })
        } else {
            off(b)
        }
    };
    let stepper = row().gap(8.0).center_y().child(step("fewer", "−", most - 1, p)).child(text(most.to_string()).font(ROW).color(p.ink).w(24.0)).child(step("more", "+", most + 1, p));
    page = page.child(section("Notifications", card(p).child(line("Per day, at most", Some("Posts that notify you right away"), stepper, p)), p));
    page.child(note("Replies always notify. This Mac shows ky's notifications while it's open; device push is on ky on the web.", p))
}

/// `08:30` or `8:30` as `08:30`.
fn parse_time(t: &str) -> Option<String> {
    let (h, m) = t.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && t.len() <= 5).then(|| format!("{h:02}:{m:02}"))
}

fn host_of(address: &str) -> String {
    let rest = address.split("://").nth(1).unwrap_or(address);
    rest.split('/').next().unwrap_or(rest).to_string()
}

pub fn peers(s: &State, p: &Palette) -> El {
    let add = row()
        .gap(8.0)
        .child(button("invite", "Invite someone", "", p).on_press(|s: &mut State| s.adding = Some("invite")))
        .child(button("have-invite", "I have an invite", "", p).on_press(|s: &mut State| s.adding = Some("pair")));
    let head = row().w_full().gap(12.0).child(heading("Peers", "Other people's kys this one can ask, and that can ask it.", p).grow(1.0).shrink()).child(add);
    let mut page = col().w_full().gap(22.0).child(head);
    match s.adding {
        Some("invite") => page = page.child(section("Invite someone", invite_form(s, p), p)),
        Some("pair") => page = page.child(section("I have an invite", pair_form(s, p), p)),
        _ => {}
    }
    let list = match s.views.get("peers").and_then(Value::as_array) {
        None => empty(s.problems.get("peers").map_or("Checking peers…", String::as_str), p),
        Some(list) if list.is_empty() => empty("No peers yet", p),
        Some(list) => rows(list.iter().map(|peer| peer_row(s, peer, p)).collect(), p),
    };
    page = page.child(section("Paired", list, p));
    page
}

fn peer_row(s: &State, peer: &Value, p: &Palette) -> El {
    let name = str_at(peer, "name").to_string();
    let (words, t) = match str_at(peer, "state") {
        "revoked" => ("They unpaired", "failed"),
        "unreachable" => ("Not answering", "waking"),
        _ => ("Paired", "online"),
    };
    let ask = format!("unpair-peer:{name}");
    let confirming = s.confirm.as_deref() == Some(ask.as_str());
    let mut sub = host_of(str_at(peer, "address"));
    let detail = str_at(peer, "detail");
    if str_at(peer, "state") == "unreachable" && !detail.is_empty() {
        sub = format!("{sub} · {detail}");
    }
    let end = row().gap(12.0).center_y().child(state(words, tone(t, p), p)).child(if confirming {
        row().gap(0.0)
    } else {
        button(&format!("unpair:{name}"), "Unpair", "danger", p).label(&format!("Unpair {name}")).on_press(move |s: &mut State| s.confirm = Some(ask.clone()))
    });
    let mut out = col().w_full().child(line(&name, Some(&sub), end, p));
    if confirming {
        let busy = s.busy.contains("peers");
        let who = name.clone();
        let yes = button("unpair-peer-yes", "Unpair", "danger", p);
        let yes = if busy { off(yes) } else { yes.on_press(move |s: &mut State| s.ask("peer-remove", json!({ "name": who }), Then::Form("peers"))) };
        out = out.child(
            row()
                .w_full()
                .px(16.0)
                .pb(12.0)
                .gap(8.0)
                .center_y()
                .child(text(format!("Unpair {name}? Neither ky can ask the other anything until you pair again.")).font(META).color(p.muted).wrap().grow(1.0).shrink())
                .child(button("unpair-peer-cancel", "Cancel", "", p).on_press(|s: &mut State| s.confirm = None))
                .child(yes),
        );
        if let Some(why) = problem(s, "peers", p) {
            out = out.child(why.px(16.0).pb(12.0));
        }
    }
    out
}

fn invite_form(s: &State, p: &Palette) -> El {
    let invite = s.views.get("invite");
    let busy = s.busy.contains("invite");
    let make = button("make-invite", if invite.is_some() { "New invite" } else { "Make invite" }, "primary", p);
    let make = if busy || s.typed("invite:name").is_empty() {
        off(make)
    } else {
        make.on_press(|s: &mut State| {
            let name = s.typed("invite:name");
            s.ask("peer-invite", json!({ "name": name }), Then::Store("invite"));
        })
    };
    let mut form = col()
        .w_full()
        .child(line("Name", Some("What ky calls theirs"), row(), p))
        .child(row().w_full().px(16.0).pb(12.0).gap(10.0).center_y().child(field(s, "invite:name", "benky", p)).child(button("invite-cancel", "Cancel", "", p).on_press(|s: &mut State| s.adding = None)).child(make));
    if let Some(i) = invite {
        let until = num_at(i, "_at") + 10.0 * 60_000.0;
        let body = if until <= time::now_ms() {
            text("That invite expired. Make a new one.").font(META).color(p.quiet).wrap()
        } else {
            col()
                .w_full()
                .gap(8.0)
                .child(copy_line("invite", &format!("{} {}", str_at(i, "address"), str_at(i, "code")), p))
                .child(text(format!("Send it to them to paste under I have an invite. It works once, until {}.", super::clock(until))).font(META).color(p.quiet).wrap())
        };
        form = form.child(col().w_full().px(16.0).pb(14.0).child(body));
    }
    if let Some(why) = problem(s, "invite", p) {
        form = form.child(why.px(16.0).pb(12.0));
    }
    card(p).child(form)
}

fn pair_form(s: &State, p: &Palette) -> El {
    let pasted = s.typed("pair:invite");
    let mut parts = pasted.split_whitespace();
    let (address, code) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
    let guess = host_of(&address).split('.').next().unwrap_or_default().to_string();
    let typed_name = s.typed("pair:name");
    let name = if typed_name.is_empty() { guess.clone() } else { typed_name };
    let busy = s.busy.contains("pair");
    let pair = button("pair", if busy { "Pairing…" } else { "Pair" }, "primary", p);
    let pair = if busy || address.is_empty() || code.is_empty() || name.is_empty() {
        off(pair)
    } else {
        pair.on_press(move |s: &mut State| s.ask("peer-pair", json!({ "name": name, "address": address, "code": code }), Then::Form("pair")))
    };
    let mut form = col()
        .w_full()
        .px(16.0)
        .py(14.0)
        .gap(10.0)
        .child(field(s, "pair:invite", "Paste what they sent you: an address and a code", p))
        .child(field(s, "pair:name", if guess.is_empty() { "anaky" } else { &guess }, p))
        .child(row().w_full().gap(8.0).justify_end().child(button("pair-cancel", "Cancel", "", p).on_press(|s: &mut State| s.adding = None)).child(pair));
    if let Some(why) = problem(s, "pair", p) {
        form = form.child(why);
    }
    card(p).child(form)
}

/// A mail's state word (`Mail.tsx`).
fn mail_word(state: &str) -> (&'static str, &'static str) {
    match state {
        "new" => ("Reading", "waking"),
        "triaged" => ("Read", ""),
        "kept" => ("Kept", ""),
        "held" => ("Waiting for you", "paused"),
        "discarded" => ("Discarded", ""),
        "sending" => ("Sending", "waking"),
        "sent" => ("Sent", "online"),
        _ => ("Failed", "failed"),
    }
}

fn mail_row(s: &State, m: &Value, actions: bool, p: &Palette) -> El {
    let id = str_at(m, "id").to_string();
    let who = if str_at(m, "partyName").is_empty() { str_at(m, "party") } else { str_at(m, "partyName") };
    let arrow = if str_at(m, "direction") == "out" { "To" } else { "From" };
    let (word, t) = mail_word(str_at(m, "state"));
    let mut sub = format!("{arrow} {who} · {}", time::ago(num_at(m, "at"), time::now_ms()));
    let preview = if str_at(m, "note").is_empty() { str_at(m, "preview") } else { str_at(m, "note") };
    if !preview.is_empty() {
        sub = format!("{sub}\n{preview}");
    }
    let subject = if str_at(m, "subject").is_empty() { "(no subject)" } else { str_at(m, "subject") };
    let end = if actions {
        let sending = s.busy.contains("mail-send");
        let (discard, send) = (id.clone(), id.clone());
        let send_b = button(&format!("send:{id}"), if sending { "Sending…" } else { "Send" }, "primary", p);
        row()
            .gap(8.0)
            .child(button(&format!("discard:{id}"), "Discard", "", p).on_press(move |s: &mut State| s.ask("mail-discard", json!({ "mail": discard }), Then::Form("mail-discard"))))
            .child(if sending { off(send_b) } else { send_b.on_press(move |s: &mut State| s.ask("mail-approve", json!({ "mail": send }), Then::Form("mail-send"))) })
    } else {
        row().gap(6.0).center_y().children(if t.is_empty() { vec![] } else { vec![dot(tone(t, p))] }).child(text(word).font(META).color(p.muted))
    };
    line(subject, Some(&sub), end, p)
}

pub fn mail(s: &State, p: &Palette) -> El {
    let page = col().w_full().gap(22.0).child(heading("Mail", "ky's own address: what it reads, and what it writes for you to send.", p));
    let Some(v) = s.views.get("mail") else {
        return page.child(empty(s.problems.get("mail").map_or("Loading mail…", String::as_str), p));
    };
    let address = str_at(v, "address");
    if address.is_empty() {
        return page.child(section(
            "Not set up",
            rows(
                vec![
                    line("ky needs a domain on Cloudflare", None, row(), p),
                    line("1", Some("On Cloudflare, turn on Email Routing and Email Sending for your domain."), row(), p),
                    line("2", Some("Run ky init --mail yourdomain.com."), row(), p),
                ],
                p,
            ),
            p,
        ));
    }
    let mut page = page.child(section("Address", copy_line("mail-address", address, p), p));
    let held = list_at(v, "held");
    if !held.is_empty() {
        page = page.child(section("Waiting for you", rows(held.iter().map(|m| mail_row(s, m, true, p)).collect(), p), p));
    }
    for key in ["mail-send", "mail-discard", "mail-allow"] {
        if let Some(why) = problem(s, key, p) {
            page = page.child(why);
        }
    }
    let recent = list_at(v, "recent");
    page = page.child(section("Recent", if recent.is_empty() { empty("No mail yet", p) } else { rows(recent.iter().map(|m| mail_row(s, m, false, p)).collect(), p) }, p));
    let allowed: Vec<&str> = list_at(v, "allowed").iter().filter_map(Value::as_str).collect();
    let allow = if allowed.is_empty() {
        empty("No one but you yet", p)
    } else {
        rows(
            allowed
                .iter()
                .map(|a| {
                    let address = a.to_string();
                    line(a, None, button(&format!("disallow:{a}"), "Remove", "danger", p).label(&format!("Stop allowing {a}")).on_press(move |s: &mut State| s.ask("mail-disallow", json!({ "address": address }), Then::Form("mail-allow"))), p)
                })
                .collect(),
            p,
        )
    };
    page.child(section("ky may write to", allow, p))
}
