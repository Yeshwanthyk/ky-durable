//! The queue above the composer (`src/ui/QueueTray.tsx`): messages sent while ky works, waiting
//! for its next step. Each can be taken back to edit or deleted; Steer now stops ky's current
//! step so the queue goes in at once.

use rune::{El, col, el, icon, row, text};
use serde_json::{Value, json};

use crate::settings::Then;
use crate::theme::{META, META_STRONG, Palette, ROW, icons};
use crate::{Conn, State, wire};

impl State {
    /// Ask on `session`'s own socket: a side chat's queue is its own.
    pub fn ask_on(&mut self, session: &str, kind: &str, fields: Value, then: Then) {
        self.sent += 1;
        let id = format!("mac-ask-{}", self.sent);
        let Some(conn) = self.conns.iter().find(|c| c.session == session) else { return };
        if !conn.live() {
            return;
        }
        conn.send(wire::command(kind, &id, fields));
        self.asks.insert(id, then);
    }

    /// Page in the chat before what's shown ("Earlier turns").
    pub fn load_earlier(&mut self, session: &str) {
        let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) else { return };
        let Some(before) = conn.chat.before else { return };
        if conn.chat.paging == crate::chat::Paging::Loading || !conn.live() {
            return;
        }
        conn.chat.paging = crate::chat::Paging::Loading;
        self.ask_on(session, "earlier", serde_json::json!({ "before": before }), Then::Earlier { session: session.to_string(), before });
    }

    /// Take a queued message back: to edit in the composer, or to drop.
    pub fn withdraw(&mut self, session: &str, operation: &str, edit: bool) {
        let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) else { return };
        let Some(item) = conn.chat.outbox.iter_mut().find(|o| o.operation == operation) else { return };
        if item.taking {
            return;
        }
        // Marked first, so pi's word that it's withdrawn drops it rather than returning it.
        item.taking = true;
        if conn.live() {
            self.ask_on(session, "withdraw", json!({ "operationId": operation }), Then::Withdraw { session: session.to_string(), operation: operation.to_string(), edit });
        } else {
            self.withdrawn(session, operation, edit, Ok(Value::Bool(true)));
        }
    }

    /// pi's answer to a withdraw: true, it's back; false, pi had placed it already.
    pub fn withdrawn(&mut self, session: &str, operation: &str, edit: bool, answer: Result<Value, String>) {
        let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) else { return };
        let Some(at) = conn.chat.outbox.iter().position(|o| o.operation == operation) else { return };
        if answer.ok().and_then(|v| v.as_bool()) == Some(true) {
            let item = conn.chat.outbox.remove(at);
            if edit {
                conn.restore(item);
            }
        } else {
            conn.chat.outbox[at].taking = false;
        }
    }

    /// Stop the step ky is on, so the whole queue goes in now.
    pub fn steer_now(&mut self, session: &str) {
        self.sent += 1;
        let id = format!("mac-steer-{}", self.sent);
        let Some(conn) = self.conns.iter_mut().find(|c| c.session == session) else { return };
        conn.send(wire::command("steer-now", &id, json!({})));
        conn.steering = Some(conn.chat.outbox.len() + conn.chat.queued_elsewhere());
    }
}

/// The tray, or nothing when nothing waits.
pub fn tray(conn: &Conn, p: &Palette) -> Option<El> {
    let more = conn.chat.queued_elsewhere();
    let queued = conn.chat.outbox.len() + more;
    if queued == 0 {
        return None;
    }
    let session = conn.session.clone();
    let steering = conn.steering == Some(queued);
    let note = if steering { "Steering · stopping ky's current step" } else { "Queued · goes in at ky's next step" };
    let mut head = row().w_full().gap(8.0).center_y().child(text(note).font(META).color(p.quiet).grow(1.0));
    if conn.chat.running && conn.live() && !steering {
        let s2 = session.clone();
        head = head.child(
            row()
                .key("queue-steer")
                .role("button")
                .label("Steer now")
                .gap(6.0)
                .px(10.0)
                .h(26.0)
                .radius(13.0)
                .center_y()
                .fill(p.raised)
                .hover(p.hover)
                .child(icon(&icons::BOLT, 12.0).color(p.ink))
                .child(text("Steer now").font(META_STRONG).color(p.ink))
                .on_press(move |s: &mut State| s.steer_now(&s2)),
        );
    }
    let mut list = col().key("queue-list").label("Queued messages").w_full().gap(2.0);
    for item in &conn.chat.outbox {
        let words = item.summary();
        let busy = item.taking || (conn.live() && item.submission.is_none());
        let action = |key: &str, label: String, glyph: &'static rune::Icon, edit: bool| {
            let (session, op) = (session.clone(), item.operation.clone());
            let mut b = el().key(&format!("{key}:{}", item.operation)).role("button").label(&label).size(26.0, 26.0).radius(8.0).center().child(icon(glyph, 13.0).color(if busy { p.quiet } else { p.muted }));
            if !busy {
                b = b.hover(p.hover).on_press(move |s: &mut State| s.withdraw(&session, &op, edit));
            }
            b
        };
        list = list.child(
            row()
                .key(&format!("queued:{}", item.operation))
                .w_full()
                .gap(8.0)
                .py(2.0)
                .center_y()
                .child(icon(&icons::CLOCK, 13.0).color(p.quiet))
                .child(text(words.clone()).font(ROW).color(if item.taking { p.quiet } else { p.ink }).max_lines(1).grow(1.0).shrink().min_w(0.0))
                .child(action("queue-edit", format!("Edit queued message: {words}"), &icons::PENCIL, true))
                .child(action("queue-delete", format!("Delete queued message: {words}"), &icons::CLOSE, false)),
        );
    }
    let mut tray = col().key("queue").label("Queued messages").w_full().px(16.0).py(10.0).gap(6.0).radius(16.0).fill(p.sunken).border(1.0, p.line).child(head).child(list);
    if more > 0 {
        let words = if more == 1 { "1 more queued from elsewhere".to_string() } else { format!("{more} more queued from elsewhere") };
        tray = tray.child(text(words).font(META).color(p.quiet));
    }
    Some(tray)
}
