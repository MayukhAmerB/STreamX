//! Resumable upload of one recording: whole-file SHA-256, create (or resume),
//! the missing 32 MiB chunks in parallel with retry and backoff, complete,
//! then wait for the server to publish it.

use crate::api::{Api, ApiError, Upload};
use crate::log;
use crate::state::{Entry, State};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

const MAX_DAMAGED_ATTEMPTS: u32 = 5;
const IO_BLOCK: usize = 1024 * 1024;

pub struct Options<'a> {
    pub session_id: Option<u64>,
    pub parallel: usize,
    /// Delay before retry `attempt` (1-based).
    pub backoff: &'a (dyn Fn(u32) -> Duration + Sync),
    pub poll_every: Duration,
    pub max_polls: u32,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Published (replaced the auto-recording or created the lecture).
    Completed { action: String, lecture: String },
    /// Uploaded; the server is still processing (it finishes on its own).
    Processing,
    /// The server refused the file (wrong format, checksum, ...).
    Failed(String),
}

/// 1 s, 2 s, 4 s ... capped at 60 s.
pub fn default_backoff(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.saturating_sub(1).min(6)).min(Duration::from_secs(60))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; IO_BLOCK];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn file_signature(path: &Path) -> std::io::Result<(u64, u64)> {
    let meta = std::fs::metadata(path)?;
    let modified = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok((meta.len(), modified))
}

fn read_chunk(path: &Path, upload: &Upload, index: u64) -> std::io::Result<Vec<u8>> {
    let start = index * upload.chunk_bytes;
    let size = upload.chunk_bytes.min(upload.total_bytes - start) as usize;
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = vec![0u8; size];
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

/// Calls `request` until it succeeds or fails for good.
fn with_retry<T>(
    what: &str,
    options: &Options,
    mut request: impl FnMut() -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let mut attempt = 0;
    loop {
        match request() {
            Ok(value) => return Ok(value),
            Err(err) if err.is_retryable() => {
                attempt += 1;
                let delay = (options.backoff)(attempt);
                log::line(&format!(
                    "{what}: {err}; retrying in {} s (attempt {attempt})",
                    delay.as_secs()
                ));
                std::thread::sleep(delay);
            }
            Err(err) => return Err(err),
        }
    }
}

fn send_chunks(
    path: &Path,
    api: &Api,
    upload: &Upload,
    missing: Vec<u64>,
    options: &Options,
) -> Result<(), String> {
    let queue = Mutex::new(missing.into_iter().collect::<VecDeque<u64>>());
    let fatal: Mutex<Option<String>> = Mutex::new(None);
    let sent = Mutex::new(0u64);
    let total = upload.chunk_count;
    std::thread::scope(|scope| {
        for _ in 0..options.parallel.max(1) {
            scope.spawn(|| loop {
                if fatal.lock().map(|f| f.is_some()).unwrap_or(true) {
                    return;
                }
                let next = queue.lock().ok().and_then(|mut q| q.pop_front());
                let Some(index) = next else { return };
                let bytes = match read_chunk(path, upload, index) {
                    Ok(bytes) => bytes,
                    Err(err) => {
                        *fatal.lock().unwrap() =
                            Some(format!("cannot read part {index} of the file: {err}"));
                        return;
                    }
                };
                let digest = sha256_hex(&bytes);
                let mut attempt = 0;
                loop {
                    match api.put_chunk(&upload.id, index, &bytes, &digest) {
                        Ok(()) => {
                            let mut done = sent.lock().unwrap();
                            *done += 1;
                            log::line(&format!(
                                "part {}/{} sent ({} so far this run)",
                                index + 1,
                                total,
                                *done
                            ));
                            break;
                        }
                        Err(ApiError::Status(_, code, _))
                            if code == "chunk_checksum_mismatch"
                                && attempt + 1 >= MAX_DAMAGED_ATTEMPTS =>
                        {
                            *fatal.lock().unwrap() =
                                Some(format!("part {} keeps arriving damaged", index + 1));
                            return;
                        }
                        Err(err) if err.is_retryable() => {
                            attempt += 1;
                            let delay = (options.backoff)(attempt);
                            log::line(&format!(
                                "part {}: {err}; retrying in {} s",
                                index + 1,
                                delay.as_secs()
                            ));
                            std::thread::sleep(delay);
                        }
                        Err(err) => {
                            *fatal.lock().unwrap() =
                                Some(format!("part {} refused: {err}", index + 1));
                            return;
                        }
                    }
                }
            });
        }
    });
    match fatal.into_inner().unwrap_or(None) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

fn missing_chunks(upload: &Upload) -> Vec<u64> {
    (0..upload.chunk_count)
        .filter(|index| !upload.received_chunks.contains(index))
        .collect()
}

fn outcome_of(upload: &Upload) -> Option<Outcome> {
    match upload.status.as_str() {
        "completed" => {
            let result = upload.result.clone().unwrap_or_default();
            Some(Outcome::Completed {
                action: result["action"].as_str().unwrap_or("").to_string(),
                lecture: result["lecture_title"].as_str().unwrap_or("").to_string(),
            })
        }
        "failed" | "aborted" | "expired" => Some(Outcome::Failed(if upload.error.is_empty() {
            format!("the upload is {}", upload.status)
        } else {
            upload.error.clone()
        })),
        _ => None,
    }
}

/// Uploads `path` (resuming whatever the server already has) and records progress in `state`.
pub fn upload_file(
    api: &Api,
    path: &Path,
    state: &mut State,
    options: &Options,
) -> Result<Outcome, String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("the file name is not valid text")?
        .to_string();
    let (size, modified) =
        file_signature(path).map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    log::line(&format!(
        "hashing {name} ({:.1} MB)",
        size as f64 / 1_048_576.0
    ));
    let sha256 =
        sha256_file(path).map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    let mut entry = Entry {
        size,
        modified,
        sha256: sha256.clone(),
        upload_id: String::new(),
        status: "uploading".into(),
        message: String::new(),
    };
    state.set(path, entry.clone());

    let mut upload = with_retry("start upload", options, || {
        api.create(&name, size, &sha256, options.session_id)
    })
    .map_err(|err| err.to_string())?;
    entry.upload_id = upload.id.clone();
    state.set(path, entry.clone());
    log::line(&format!(
        "upload {} to \"{}\": {} of {} parts already on the server",
        upload.id,
        upload.session_title,
        upload.received_chunks.len(),
        upload.chunk_count
    ));

    if upload.status == "uploading" {
        loop {
            let missing = missing_chunks(&upload);
            send_chunks(path, api, &upload, missing, options)?;
            if file_signature(path)
                .map(|sig| sig != (size, modified))
                .unwrap_or(true)
            {
                return Err(format!(
                    "{name} changed while it was uploading; it will be uploaded again"
                ));
            }
            match with_retry("complete", options, || api.complete(&upload.id)) {
                Ok(queued) => {
                    upload = queued;
                    break;
                }
                Err(ApiError::Status(409, code, _)) if code == "chunks_missing" => {
                    upload = with_retry("status", options, || api.status(&upload.id))
                        .map_err(|err| err.to_string())?;
                }
                Err(err) => return Err(err.to_string()),
            }
        }
    }

    entry.status = "processing".into();
    state.set(path, entry.clone());
    log::line(&format!("{name}: uploaded; the server is processing it"));
    let mut polls = 0;
    loop {
        if let Some(outcome) = outcome_of(&upload) {
            entry.status = if matches!(outcome, Outcome::Completed { .. }) {
                "completed".into()
            } else {
                "failed".into()
            };
            if let Outcome::Failed(message) = &outcome {
                entry.message = message.clone();
            }
            state.set(path, entry);
            return Ok(outcome);
        }
        if polls >= options.max_polls {
            return Ok(Outcome::Processing);
        }
        polls += 1;
        std::thread::sleep(options.poll_every);
        upload = with_retry("status", options, || api.status(&upload.id))
            .map_err(|err| err.to_string())?;
    }
}
