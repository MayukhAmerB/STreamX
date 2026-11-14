//! End-to-end upload against a mock of /api/recording-uploads/ (std TcpListener,
//! no network): resume, parallel chunks, retry after 503, checksums, token
//! header, complete + status polling, local state.

use obs_uploader::api::Api;
use obs_uploader::state::State;
use obs_uploader::upload::{sha256_hex, upload_file, Options, Outcome};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const TOKEN: &str = "asu_test-token";
const CHUNK: u64 = 4;

#[derive(Default)]
struct Mock {
    total: u64,
    sha256: String,
    chunks: BTreeMap<u64, Vec<u8>>,
    preloaded: Vec<u64>,
    put_log: Vec<u64>,
    fail_once: Vec<u64>,
    status: String,
    completes: u32,
    reject_token: bool,
    bad_headers: Vec<String>,
}

struct Request {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn read_request(reader: &mut BufReader<TcpStream>) -> Option<Request> {
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = BTreeMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        headers,
        body,
    })
}

fn upload_json(mock: &Mock) -> Value {
    let received: Vec<u64> = mock.chunks.keys().copied().collect();
    let mut value = json!({
        "id": "6f1c0b8e-0000-4000-8000-000000000001",
        "status": mock.status,
        "session_id": 7,
        "session_title": "Recon Class",
        "total_bytes": mock.total,
        "chunk_bytes": CHUNK,
        "chunk_count": mock.total.div_ceil(CHUNK),
        "received_chunks": received,
        "error": "",
        "result": null
    });
    if mock.status == "completed" {
        value["result"] =
            json!({"action": "replaced", "lecture_title": "Recon Class - 14 Nov 2026"});
    }
    value
}

fn handle(mock: &Arc<Mutex<Mock>>, request: Request) -> (u16, Value) {
    let mut mock = mock.lock().unwrap();
    if request.headers.get("x-upload-token").map(String::as_str) != Some(TOKEN) || mock.reject_token
    {
        return (
            401,
            json!({"success": false, "message": "This upload token is invalid, expired or revoked.", "errors": {"code": "authentication_failed"}}),
        );
    }
    let path = request
        .path
        .trim_start_matches("/api/recording-uploads/")
        .to_string();
    match (request.method.as_str(), path.as_str()) {
        ("POST", "") => {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            mock.total = body["size"].as_u64().unwrap();
            mock.sha256 = body["sha256"].as_str().unwrap().to_string();
            if mock.status.is_empty() {
                mock.status = "uploading".into();
            }
            for index in mock.preloaded.clone() {
                mock.chunks.insert(index, vec![]);
            }
            (201, json!({"success": true, "data": upload_json(&mock)}))
        }
        ("PUT", p) if p.contains("/chunks/") => {
            let index: u64 = p.split('/').nth(2).unwrap().parse().unwrap();
            mock.put_log.push(index);
            if request.headers.get("content-type").map(String::as_str)
                != Some("application/octet-stream")
            {
                mock.bad_headers
                    .push(format!("content-type on chunk {index}"));
            }
            if request.headers.get("x-chunk-sha256") != Some(&sha256_hex(&request.body)) {
                mock.bad_headers.push(format!("sha256 of chunk {index}"));
            }
            if let Some(pos) = mock.fail_once.iter().position(|i| *i == index) {
                mock.fail_once.remove(pos);
                return (
                    503,
                    json!({"success": false, "message": "busy", "errors": {"code": "service_unavailable"}}),
                );
            }
            mock.chunks.insert(index, request.body);
            (200, json!({"success": true, "data": {"index": index}}))
        }
        ("POST", p) if p.ends_with("/complete/") => {
            mock.completes += 1;
            mock.status = "queued".into();
            (202, json!({"success": true, "data": upload_json(&mock)}))
        }
        ("GET", p) if p.split('/').filter(|s| !s.is_empty()).count() == 1 => {
            // The worker finished between two polls.
            mock.status = "completed".into();
            (200, json!({"success": true, "data": upload_json(&mock)}))
        }
        _ => (404, json!({"success": false, "message": "not found"})),
    }
}

fn serve(mock: Arc<Mutex<Mock>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mock = mock.clone();
            std::thread::spawn(move || {
                let mut writer = stream.try_clone().unwrap();
                let mut reader = BufReader::new(stream);
                while let Some(request) = read_request(&mut reader) {
                    let (status, body) = handle(&mock, request);
                    let text = body.to_string();
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}",
                        text.len()
                    );
                    if writer.write_all(reply.as_bytes()).is_err() {
                        return;
                    }
                }
            });
        }
    });
    format!("http://{address}/api")
}

fn no_wait(_attempt: u32) -> Duration {
    Duration::ZERO
}

fn options() -> Options<'static> {
    Options {
        session_id: None,
        parallel: 3,
        backoff: &no_wait,
        poll_every: Duration::ZERO,
        max_polls: 5,
    }
}

fn recording(name: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("obs-uploader-mock-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("2026-11-14 19-00-01.mkv");
    std::fs::write(&file, bytes).unwrap();
    (dir, file)
}

#[test]
fn uploads_every_chunk_retries_a_503_and_reports_the_replacement() {
    let content = b"\x1a\x45\xdf\xa3 OBS recording bytes".to_vec(); // 24 bytes = 6 chunks
    let mock = Arc::new(Mutex::new(Mock {
        fail_once: vec![2],
        ..Default::default()
    }));
    let api = Api::new(&serve(mock.clone()), TOKEN);
    let (dir, file) = recording("full", &content);
    let mut state = State::load(&dir.join("state.json"));

    let outcome = upload_file(&api, &file, &mut state, &options()).unwrap();

    assert_eq!(
        outcome,
        Outcome::Completed {
            action: "replaced".into(),
            lecture: "Recon Class - 14 Nov 2026".into()
        }
    );
    let mock = mock.lock().unwrap();
    let assembled: Vec<u8> = mock.chunks.values().flatten().copied().collect();
    assert_eq!(assembled, content);
    assert_eq!(mock.sha256, sha256_hex(&content));
    assert_eq!(
        mock.put_log.iter().filter(|i| **i == 2).count(),
        2,
        "chunk 2 retried after the 503"
    );
    assert_eq!(mock.completes, 1);
    assert!(mock.bad_headers.is_empty(), "{:?}", mock.bad_headers);
    let saved = State::load(&dir.join("state.json"));
    let (size, modified) = obs_uploader::upload::file_signature(&file).unwrap();
    assert!(saved.is_finished(&file, size, modified));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn resumes_by_sending_only_the_missing_chunks() {
    let content = b"0123456789ab".to_vec(); // 3 chunks; the server already has 0 and 2
    let mock = Arc::new(Mutex::new(Mock {
        preloaded: vec![0, 2],
        ..Default::default()
    }));
    let api = Api::new(&serve(mock.clone()), TOKEN);
    let (dir, file) = recording("resume", &content);
    let mut state = State::load(&dir.join("state.json"));
    upload_file(&api, &file, &mut state, &options()).unwrap();
    assert_eq!(mock.lock().unwrap().put_log, vec![1]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_revoked_token_stops_without_retrying_forever() {
    let mock = Arc::new(Mutex::new(Mock {
        reject_token: true,
        ..Default::default()
    }));
    let api = Api::new(&serve(mock.clone()), TOKEN);
    let (dir, file) = recording("revoked", b"abcd");
    let mut state = State::load(&dir.join("state.json"));
    let error = upload_file(&api, &file, &mut state, &options()).unwrap_err();
    assert!(error.contains("401"), "{error}");
    assert!(mock.lock().unwrap().put_log.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
