//! The long-running loop: OBS WebSocket events (reconnecting while OBS is
//! closed) plus a periodic folder scan, one upload at a time.

use crate::api::Api;
use crate::config::Config;
use crate::log;
use crate::obs;
use crate::state::{Entry, State};
use crate::upload::{self, file_signature, Options, Outcome};
use crate::watch::{self, Decision, Stability};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const OBS_RECONNECT_SECONDS: u64 = 15;
const MAX_STATUS_POLLS: u32 = 120;

pub fn options(config: &Config) -> Options<'static> {
    Options {
        session_id: config.session_id,
        parallel: config.parallel_chunks,
        backoff: &upload::default_backoff,
        poll_every: Duration::from_secs(10),
        max_polls: MAX_STATUS_POLLS,
    }
}

pub fn upload_one(api: &Api, path: &Path, state: &mut State, config: &Config) -> bool {
    match upload::upload_file(api, path, state, &options(config)) {
        Ok(Outcome::Completed { action, lecture }) => {
            let what = if action == "replaced" {
                "replaced the auto-recording in"
            } else {
                "published as"
            };
            log::line(&format!("{}: {what} \"{lecture}\"", path.display()));
            true
        }
        Ok(Outcome::Processing) => {
            log::line(&format!(
                "{}: uploaded; the server is still processing it (it finishes on its own)",
                path.display()
            ));
            true
        }
        Ok(Outcome::Failed(message)) => {
            log::line(&format!(
                "{}: the server could not use this file: {message}",
                path.display()
            ));
            true
        }
        Err(message) => {
            log::line(&format!(
                "{}: upload stopped: {message} (it resumes on the next try)",
                path.display()
            ));
            false
        }
    }
}

fn mark_superseded(state: &mut State, path: &Path) {
    if let Ok((size, modified)) = file_signature(path) {
        if !state.is_finished(path, size, modified) {
            log::line(&format!(
                "{}: OBS remuxed it to MP4; the MP4 is uploaded instead",
                path.display()
            ));
            state.set(
                path,
                Entry {
                    size,
                    modified,
                    sha256: String::new(),
                    upload_id: String::new(),
                    status: "superseded".into(),
                    message: String::new(),
                },
            );
        }
    }
}

fn start_obs_listener(config: &Config) -> mpsc::Receiver<PathBuf> {
    let (sender, receiver) = mpsc::channel();
    let url = config.obs_websocket_url.clone();
    let password = config.obs_websocket_password.clone();
    std::thread::spawn(move || {
        let mut last_error = String::new();
        loop {
            let result = obs::listen(&url, &password, |path| {
                log::line(&format!("OBS stopped recording: {}", path.display()));
                let _ = sender.send(path);
            });
            if let Err(err) = result {
                if err != last_error {
                    log::line(&format!("{err}; the folder is watched instead (retrying OBS every {OBS_RECONNECT_SECONDS} s)"));
                    last_error = err;
                }
            }
            std::thread::sleep(Duration::from_secs(OBS_RECONNECT_SECONDS));
        }
    });
    receiver
}

/// Runs until the process is stopped.
pub fn run(config: &Config) -> ! {
    let api = Api::new(&config.api_base, &config.token);
    let mut state = State::load(&config.state_path());
    let mut stability = Stability::default();
    match api.latest_target() {
        Ok(Some(target)) => log::line(&format!(
            "signed in; recordings go to {}",
            if config.session_id.is_some() {
                "the configured class".to_string()
            } else {
                format!(
                    "\"{}\" (your latest class)",
                    target["title"].as_str().unwrap_or("?")
                )
            }
        )),
        Ok(None) => {
            log::line("signed in; no recent class yet (recordings wait until there is one)")
        }
        Err(err) => log::line(&format!("cannot reach the platform yet: {err}")),
    }
    log::line(&format!("watching {}", config.recordings_dir.display()));
    let events = start_obs_listener(config);
    // Files OBS reported, waiting until they are finished (and possibly remuxed).
    let mut pending: Vec<(PathBuf, Instant)> = Vec::new();
    let poll = Duration::from_secs(config.poll_seconds.max(1));
    let mut next_scan = Instant::now();
    loop {
        if let Ok(path) = events.recv_timeout(Duration::from_secs(2)) {
            if !pending.iter().any(|(p, _)| p == &path) {
                pending.push((path, Instant::now()));
            }
        }
        let mut queue: Vec<PathBuf> = pending.iter().map(|(p, _)| p.clone()).collect();
        if Instant::now() >= next_scan {
            next_scan = Instant::now() + poll;
            for path in watch::candidates(config, &state) {
                if !queue.contains(&path) {
                    queue.push(path);
                }
            }
        }
        for path in queue {
            let target = match watch::decide(&path, config, &mut stability) {
                Decision::Wait => {
                    // An OBS-reported MKV: the remuxed MP4 may already be there and ready.
                    let mp4 = watch::mp4_sibling(&path);
                    if watch::REMUXABLE.contains(&watch::extension(&path).as_str())
                        && mp4.exists()
                        && stability.is_ready(&mp4, Duration::from_secs(config.stable_seconds))
                    {
                        mark_superseded(&mut state, &path);
                        Some(mp4)
                    } else {
                        None
                    }
                }
                Decision::Superseded => {
                    mark_superseded(&mut state, &path);
                    pending.retain(|(p, _)| p != &path);
                    let mp4 = watch::mp4_sibling(&path);
                    if stability.is_ready(&mp4, Duration::from_secs(config.stable_seconds)) {
                        Some(mp4)
                    } else {
                        None
                    }
                }
                Decision::Upload(file) => Some(file),
            };
            let Some(file) = target else { continue };
            let Ok((size, modified)) = file_signature(&file) else {
                continue;
            };
            if state.is_finished(&file, size, modified) {
                pending.retain(|(p, _)| p != &path);
                continue;
            }
            if upload_one(&api, &file, &mut state, config) {
                pending.retain(|(p, _)| p != &path && p != &file);
                stability.forget(&file);
            }
        }
    }
}
