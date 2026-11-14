//! Local resume state (`state.json`): which recordings were uploaded, and the
//! upload id of the one in progress, so a reboot continues where it stopped.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub size: u64,
    pub modified: u64,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub upload_id: String,
    /// uploading | processing | completed | failed | superseded
    pub status: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub files: BTreeMap<String, Entry>,
    #[serde(skip)]
    path: PathBuf,
}

pub fn key(path: &Path) -> String {
    let full = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    full.to_string_lossy().to_lowercase()
}

impl State {
    pub fn load(path: &Path) -> State {
        let mut state: State = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        state.path = path.to_path_buf();
        state
    }

    /// Written to a temp file and renamed, so a crash never leaves half a file.
    pub fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        std::fs::rename(&temp, &self.path)
    }

    pub fn get(&self, path: &Path) -> Option<&Entry> {
        self.files.get(&key(path))
    }

    pub fn set(&mut self, path: &Path, entry: Entry) {
        self.files.insert(key(path), entry);
        if let Err(err) = self.save() {
            crate::log::line(&format!(
                "could not save the state file {}: {err}",
                self.path.display()
            ));
        }
    }

    /// Done with this exact file (same size and modification time): never upload it again.
    pub fn is_finished(&self, path: &Path, size: u64, modified: u64) -> bool {
        matches!(self.get(path), Some(entry)
            if entry.size == size && entry.modified == modified
                && matches!(entry.status.as_str(), "completed" | "processing" | "superseded" | "failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("obs-uploader-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("state.json");
        let file = dir.join("rec.mkv");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, b"x").unwrap();
        let mut state = State::load(&path);
        state.set(
            &file,
            Entry {
                size: 1,
                modified: 5,
                sha256: "aa".into(),
                upload_id: "u".into(),
                status: "completed".into(),
                message: String::new(),
            },
        );
        let again = State::load(&path);
        assert!(again.is_finished(&file, 1, 5));
        assert!(
            !again.is_finished(&file, 2, 5),
            "a re-recorded file with the same name is new"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
