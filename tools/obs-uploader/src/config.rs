//! `config.toml`: where the API is, the personal upload token, where OBS records.

use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const DEFAULT_EXTENSIONS: &[&str] = &["mkv", "mp4", "mov", "flv", "ts", "m4v"];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// e.g. "https://api.alsyedinitiative.com/api"
    pub api_base: String,
    /// Personal upload token created in Console -> Upload recording ("asu_...").
    pub token: String,
    /// OBS Settings -> Output -> Recording -> Recording Path.
    pub recordings_dir: PathBuf,
    /// Upload to this class id instead of "my live class, else the one that ended last".
    #[serde(default)]
    pub session_id: Option<u64>,
    #[serde(default = "default_ws_url")]
    pub obs_websocket_url: String,
    /// OBS Tools -> WebSocket Server Settings -> Server Password ("" when authentication is off).
    #[serde(default)]
    pub obs_websocket_password: String,
    /// Where the resume state lives (default: next to the config file).
    #[serde(default)]
    pub state_file: Option<PathBuf>,
    #[serde(default = "default_extensions")]
    pub extensions: Vec<String>,
    /// A file is ready when its size has not changed for this long and it can be opened exclusively.
    #[serde(default = "default_stable_seconds")]
    pub stable_seconds: u64,
    /// How long to wait for OBS's "automatically remux to mp4" copy of an MKV.
    #[serde(default = "default_remux_wait_seconds")]
    pub remux_wait_seconds: u64,
    /// Folder scan interval (the fallback when OBS's WebSocket is not reachable).
    #[serde(default = "default_poll_seconds")]
    pub poll_seconds: u64,
    /// Only recordings modified within this many hours are picked up by the folder scan.
    #[serde(default = "default_max_age_hours")]
    pub max_age_hours: u64,
    #[serde(default = "default_parallel")]
    pub parallel_chunks: usize,
}

fn default_ws_url() -> String {
    "ws://127.0.0.1:4455".to_string()
}
fn default_extensions() -> Vec<String> {
    DEFAULT_EXTENSIONS
        .iter()
        .map(|ext| ext.to_string())
        .collect()
}
fn default_stable_seconds() -> u64 {
    20
}
fn default_remux_wait_seconds() -> u64 {
    180
}
fn default_poll_seconds() -> u64 {
    15
}
fn default_max_age_hours() -> u64 {
    24
}
fn default_parallel() -> usize {
    3
}

impl Config {
    pub fn parse(text: &str) -> Result<Config, String> {
        let mut config: Config =
            toml::from_str(text).map_err(|err| format!("config.toml: {err}"))?;
        config.api_base = config.api_base.trim().trim_end_matches('/').to_string();
        if !(config.api_base.starts_with("https://") || config.api_base.starts_with("http://")) {
            return Err("config.toml: api_base must start with https://".into());
        }
        if !config.token.trim().starts_with("asu_") {
            return Err(
                "config.toml: token must be a personal upload token (it starts with asu_)".into(),
            );
        }
        config.token = config.token.trim().to_string();
        config.parallel_chunks = config.parallel_chunks.clamp(1, 6);
        config.extensions = config
            .extensions
            .iter()
            .map(|ext| ext.trim_start_matches('.').to_lowercase())
            .collect();
        Ok(config)
    }

    pub fn load(path: &Path) -> Result<Config, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
        let mut config = Config::parse(&text)?;
        if config.state_file.is_none() {
            config.state_file = Some(path.with_file_name("state.json"));
        }
        Ok(config)
    }

    pub fn state_path(&self) -> PathBuf {
        self.state_file
            .clone()
            .unwrap_or_else(|| PathBuf::from("state.json"))
    }

    pub fn is_recording(&self, path: &Path) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                self.extensions
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(ext))
            })
            .unwrap_or(false)
    }
}

/// `%APPDATA%\obs-uploader\config.toml` on Windows, `~/.config/obs-uploader/config.toml` elsewhere.
pub fn default_config_path() -> PathBuf {
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata)
            .join("obs-uploader")
            .join("config.toml");
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".config")
        .join("obs-uploader")
        .join("config.toml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_config_with_defaults() {
        let config = Config::parse(
            r#"
api_base = "https://api.alsyedinitiative.com/api/"
token = "asu_abc"
recordings_dir = 'C:\Users\host\Videos'
"#,
        )
        .unwrap();
        assert_eq!(config.api_base, "https://api.alsyedinitiative.com/api");
        assert_eq!(config.obs_websocket_url, "ws://127.0.0.1:4455");
        assert_eq!(config.parallel_chunks, 3);
        assert!(config.is_recording(Path::new("2026-11-14 19-00-01.MKV")));
        assert!(!config.is_recording(Path::new("notes.txt")));
    }

    #[test]
    fn rejects_bad_values_and_unknown_keys() {
        assert!(Config::parse("api_base='ftp://x'\ntoken='asu_a'\nrecordings_dir='.'").is_err());
        assert!(
            Config::parse("api_base='https://x'\ntoken='not-a-token'\nrecordings_dir='.'").is_err()
        );
        assert!(
            Config::parse("api_base='https://x'\ntoken='asu_a'\nrecordings_dir='.'\ntypo=1")
                .is_err()
        );
    }
}
