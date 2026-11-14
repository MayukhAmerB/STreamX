//! One-line log to stdout and to `obs-uploader.log` next to the state file
//! (Task Scheduler runs the uploader without a console).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub fn init(path: PathBuf) {
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::rename(&path, path.with_extension("log.old"));
        }
    }
    if let Ok(mut slot) = LOG_FILE.lock() {
        *slot = Some(path);
    }
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Civil date from days since 1970-01-01 (UTC), Howard Hinnant's algorithm.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

pub fn line(message: &str) {
    let text = format!("{} {message}", timestamp());
    println!("{text}");
    if let Ok(slot) = LOG_FILE.lock() {
        if let Some(path) = slot.as_ref() {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(file, "{text}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn timestamp_looks_like_iso8601() {
        let stamp = super::timestamp();
        assert_eq!(stamp.len(), 20);
        assert!(stamp.ends_with('Z'));
    }
}
