//! What ky shows outside its window: the Dock icon's count of running tasks, and a notification
//! when a task finishes or fails while ky isn't the front app.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;

/// The last count the Dock shows, so a frame that changes nothing touches nothing.
static SHOWN: AtomicUsize = AtomicUsize::new(0);

/// Put `n` on the Dock icon, or clear it at 0.
pub fn badge(n: usize) {
    if SHOWN.swap(n, Ordering::Relaxed) == n {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        use objc2_foundation::NSString;
        let Some(mtm) = MainThreadMarker::new() else { return };
        let tile = NSApplication::sharedApplication(mtm).dockTile();
        let label = (n > 0).then(|| NSString::from_str(&n.to_string()));
        tile.setBadgeLabel(label.as_deref());
    }
}

/// Whether ky is the app in front, where its own rows already say what happened.
fn front() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        if let Some(mtm) = MainThreadMarker::new() {
            return NSApplication::sharedApplication(mtm).isActive();
        }
    }
    true
}

/// The tasks that were running in `before` and are done or failed in `after`, each said once.
pub fn finished(before: &Value, after: &Value) {
    let (Some(before), Some(after)) = (before.as_array(), after.as_array()) else { return };
    let ended: Vec<(String, &str)> = after
        .iter()
        .filter_map(|t| {
            let id = t["id"].as_str()?;
            let status = t["status"].as_str()?;
            let was = before.iter().find(|b| b["id"].as_str() == Some(id))?["status"].as_str()?;
            (matches!(was, "queued" | "working") && matches!(status, "done" | "failed")).then(|| (crate::activity::plain(t["title"].as_str().unwrap_or("A task")), status))
        })
        .collect();
    if ended.is_empty() || front() {
        return;
    }
    for (title, status) in ended {
        let head = if status == "failed" { "Task failed" } else { "Task done" };
        notify(head, &title);
    }
}

/// A notification through Notification Center; words go as arguments, never into the script.
fn notify(title: &str, body: &str) {
    let (title, body) = (title.to_string(), body.to_string());
    std::thread::spawn(move || {
        let _ = std::process::Command::new("osascript")
            .args(["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", &title, &body])
            .status();
    });
}
