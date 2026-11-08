//! The sidebar's times, as the web's `src/ui/time.ts` writes them: each side chat under its day
//! (Today, Yesterday, a weekday this week, then a date) and how long ago it last moved.

/// The local calendar day and weekday of `ms` (milliseconds since the epoch): (days since the
/// epoch, 0 = Sunday … 6, month 0–11, day of month, year).
fn local(ms: f64) -> (i64, i32, i32, i32, i32) {
    let secs = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: localtime_r writes into the `tm` we own and reads only `secs`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    let day = (secs as i64 + tm.tm_gmtoff).div_euclid(86_400);
    (day, tm.tm_wday, tm.tm_mon, tm.tm_mday, tm.tm_year + 1900)
}

const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Today", "Yesterday", "Tuesday", "Oct 3", "Oct 3, 2025".
pub fn day(ms: f64, now: f64) -> String {
    let (d, wday, mon, mday, year) = local(ms);
    let (today, _, _, _, this_year) = local(now);
    match today - d {
        ..=0 => "Today".into(),
        1 => "Yesterday".into(),
        2..=6 => WEEKDAYS[wday as usize].into(),
        _ if year == this_year => format!("{} {mday}", MONTHS[mon as usize]),
        _ => format!("{} {mday}, {year}", MONTHS[mon as usize]),
    }
}

/// "now", "5m", "3h", "2d", "4w".
pub fn ago(ms: f64, now: f64) -> String {
    let minutes = ((now - ms) / 60_000.0).max(0.0) as i64;
    match minutes {
        0 => "now".into(),
        1..=59 => format!("{minutes}m"),
        60..=1439 => format!("{}h", minutes / 60),
        1440..=10079 => format!("{}d", minutes / 1440),
        _ => format!("{}w", minutes / 10080),
    }
}

pub fn now_ms() -> f64 {
    std::time::UNIX_EPOCH.elapsed().map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_the_web_writes_them() {
        let now = now_ms();
        assert_eq!(day(now, now), "Today");
        assert_eq!(day(now - 86_400_000.0, now), "Yesterday");
        assert_eq!(ago(now - 30_000.0, now), "now");
        assert_eq!(ago(now - 5.0 * 60_000.0, now), "5m");
        assert_eq!(ago(now - 3.0 * 3_600_000.0, now), "3h");
        assert_eq!(ago(now - 2.0 * 86_400_000.0, now), "2d");
    }
}
