//! Folder watch (fallback when OBS's WebSocket is off): find recordings in the
//! OBS recording folder that are finished (size stable, not locked by OBS) and
//! prefer OBS's remuxed MP4 over the MKV it was made from.

use crate::config::Config;
use crate::state::State;
use crate::upload::file_signature;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// Containers OBS's "Automatically remux to mp4" turns into an MP4 next to them.
pub const REMUXABLE: &[&str] = &["mkv", "flv", "ts"];

pub fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase()
}

pub fn mp4_sibling(path: &Path) -> PathBuf {
    path.with_extension("mp4")
}

/// True when no other program (OBS still writing or remuxing) has the file open.
#[cfg(windows)]
pub fn unlocked(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // share_mode(0): fails with a sharing violation while OBS holds the file.
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
        .is_ok()
}

#[cfg(not(windows))]
pub fn unlocked(path: &Path) -> bool {
    std::fs::File::open(path).is_ok()
}

/// Remembers each file's size; a file is stable once its size and mtime stopped changing.
#[derive(Default)]
pub struct Stability {
    seen: HashMap<PathBuf, ((u64, u64), Instant)>,
}

impl Stability {
    pub fn is_ready(&mut self, path: &Path, stable_for: Duration) -> bool {
        let Ok(signature) = file_signature(path) else {
            self.seen.remove(path);
            return false;
        };
        let now = Instant::now();
        let entry = self
            .seen
            .entry(path.to_path_buf())
            .or_insert((signature, now));
        if entry.0 != signature {
            *entry = (signature, now);
            return false;
        }
        signature.0 > 0 && now.duration_since(entry.1) >= stable_for && unlocked(path)
    }

    pub fn forget(&mut self, path: &Path) {
        self.seen.remove(path);
    }
}

fn age(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

/// What to do with a finished recording at `path`.
#[derive(Debug, PartialEq)]
pub enum Decision {
    Upload(PathBuf),
    /// An MKV whose MP4 copy exists: the MP4 is uploaded instead.
    Superseded,
    /// Not ready yet (still written, or OBS may still remux it).
    Wait,
}

pub fn decide(path: &Path, config: &Config, stability: &mut Stability) -> Decision {
    let stable_for = Duration::from_secs(config.stable_seconds);
    if REMUXABLE.contains(&extension(path).as_str()) {
        let mp4 = mp4_sibling(path);
        if mp4.exists() {
            return Decision::Superseded;
        }
        if !stability.is_ready(path, stable_for) {
            return Decision::Wait;
        }
        // Give OBS's automatic remux time to produce the MP4.
        let old_enough = age(path)
            .map(|a| a >= Duration::from_secs(config.remux_wait_seconds))
            .unwrap_or(false);
        return if old_enough {
            Decision::Upload(path.to_path_buf())
        } else {
            Decision::Wait
        };
    }
    if stability.is_ready(path, stable_for) {
        Decision::Upload(path.to_path_buf())
    } else {
        Decision::Wait
    }
}

/// Recordings in the folder that are recent and not uploaded yet.
pub fn candidates(config: &Config, state: &State) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(&config.recordings_dir) else {
        return Vec::new();
    };
    let max_age = Duration::from_secs(config.max_age_hours * 3600);
    let mut found: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.is_file() && config.is_recording(path))
        .filter(|path| age(path).map(|a| a <= max_age).unwrap_or(false))
        .filter(|path| match file_signature(path) {
            Ok((size, modified)) => !state.is_finished(path, size, modified),
            Err(_) => false,
        })
        .collect();
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(dir: &Path) -> Config {
        let mut config = Config::parse(&format!(
            "api_base='https://x/api'\ntoken='asu_t'\nrecordings_dir='{}'\nstable_seconds=0\nremux_wait_seconds=0",
            dir.display()
        ))
        .unwrap();
        config.state_file = Some(dir.join("state.json"));
        config
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("obs-uploader-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_is_ready_only_after_its_size_stopped_changing() {
        let dir = temp_dir("stable");
        let file = dir.join("rec.mp4");
        std::fs::write(&file, b"abc").unwrap();
        let mut stability = Stability::default();
        assert!(
            stability.is_ready(&file, Duration::ZERO),
            "unchanged since first seen"
        );
        std::fs::write(&file, b"abcdef").unwrap();
        assert!(
            !stability.is_ready(&file, Duration::ZERO),
            "it grew: wait for the next look"
        );
        assert!(stability.is_ready(&file, Duration::ZERO));
        assert!(!stability.is_ready(&file, Duration::from_secs(3600)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prefers_the_remuxed_mp4_over_the_mkv() {
        let dir = temp_dir("remux");
        let config = config(&dir);
        let mkv = dir.join("2026-11-14 19-00-01.mkv");
        std::fs::write(&mkv, b"mkv").unwrap();
        let mut stability = Stability::default();
        assert_eq!(
            decide(&mkv, &config, &mut stability),
            Decision::Upload(mkv.clone()),
            "no MP4: the MKV is uploaded"
        );
        std::fs::write(mp4_sibling(&mkv), b"mp4").unwrap();
        assert_eq!(decide(&mkv, &config, &mut stability), Decision::Superseded);
        let state = State::load(&dir.join("state.json"));
        let found = candidates(&config, &state);
        assert_eq!(found.len(), 2);
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        assert_eq!(candidates(&config, &state).len(), 2, "only recordings");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn waits_for_obs_to_remux_a_fresh_mkv() {
        let dir = temp_dir("fresh");
        let mut config = config(&dir);
        config.remux_wait_seconds = 3600;
        let mkv = dir.join("fresh.mkv");
        std::fs::write(&mkv, b"mkv").unwrap();
        assert_eq!(
            decide(&mkv, &config, &mut Stability::default()),
            Decision::Wait
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
