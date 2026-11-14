//! obs-websocket v5 (built into OBS 28+, Tools -> WebSocket Server Settings):
//! connect, authenticate, subscribe to output events and report every
//! `RecordStateChanged` -> `OBS_WEBSOCKET_OUTPUT_STOPPED` with its file path.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tungstenite::Message;

/// EventSubscription::Outputs (1 << 6): record/stream/replay-buffer state events.
pub const SUBSCRIBE_OUTPUTS: u64 = 1 << 6;
pub const OUTPUT_STOPPED: &str = "OBS_WEBSOCKET_OUTPUT_STOPPED";

/// The v5 authentication string: base64(sha256(base64(sha256(password + salt)) + challenge)).
pub fn auth_string(password: &str, salt: &str, challenge: &str) -> String {
    let secret = BASE64.encode(Sha256::digest(format!("{password}{salt}").as_bytes()));
    BASE64.encode(Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

/// The Identify message answering a Hello (op 0).
pub fn identify_message(hello: &Value, password: &str) -> Result<Value, String> {
    if hello["op"].as_u64() != Some(0) {
        return Err(format!("expected Hello from OBS, got {hello}"));
    }
    let mut data = json!({"rpcVersion": 1, "eventSubscriptions": SUBSCRIBE_OUTPUTS});
    let auth = &hello["d"]["authentication"];
    if auth.is_object() {
        if password.is_empty() {
            return Err(
                "OBS WebSocket asks for a password: set obs_websocket_password in config.toml"
                    .into(),
            );
        }
        let challenge = auth["challenge"].as_str().unwrap_or("");
        let salt = auth["salt"].as_str().unwrap_or("");
        data["authentication"] = json!(auth_string(password, salt, challenge));
    }
    Ok(json!({"op": 1, "d": data}))
}

/// The recording file of a "recording stopped" event, if this message is one.
pub fn stopped_recording(message: &Value) -> Option<PathBuf> {
    if message["op"].as_u64() != Some(5)
        || message["d"]["eventType"].as_str() != Some("RecordStateChanged")
    {
        return None;
    }
    let data = &message["d"]["eventData"];
    if data["outputState"].as_str() != Some(OUTPUT_STOPPED) {
        return None;
    }
    data["outputPath"]
        .as_str()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// Blocks while connected; calls `on_stopped` for every finished recording.
/// Returns when OBS closes the connection (or it cannot be opened).
pub fn listen(
    url: &str,
    password: &str,
    mut on_stopped: impl FnMut(PathBuf),
) -> Result<(), String> {
    let (mut socket, _response) =
        tungstenite::connect(url).map_err(|err| format!("OBS WebSocket {url}: {err}"))?;
    let hello = read_json(&mut socket)?;
    socket
        .send(Message::text(
            identify_message(&hello, password)?.to_string(),
        ))
        .map_err(|err| format!("OBS WebSocket: {err}"))?;
    let identified = read_json(&mut socket)?;
    if identified["op"].as_u64() != Some(2) {
        return Err(format!(
            "OBS WebSocket did not accept the connection: {identified}"
        ));
    }
    crate::log::line("connected to OBS: waiting for recordings to stop");
    loop {
        let message = read_json(&mut socket)?;
        if let Some(path) = stopped_recording(&message) {
            on_stopped(path);
        }
    }
}

fn read_json(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) -> Result<Value, String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                return serde_json::from_str(text.as_str())
                    .map_err(|err| format!("OBS sent invalid JSON: {err}"))
            }
            Ok(Message::Close(frame)) => {
                let reason = frame
                    .map(|f| format!("{} {}", u16::from(f.code), f.reason))
                    .unwrap_or_default();
                return Err(format!("OBS closed the WebSocket {reason}")
                    .trim()
                    .to_string());
            }
            Ok(_) => continue, // ping/pong/binary: tungstenite answers pings itself
            Err(err) => return Err(format!("OBS WebSocket: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_string_follows_the_v5_protocol() {
        // Recomputed step by step from the protocol definition.
        let secret = BASE64.encode(Sha256::digest(b"supersecretpasswordsalt"));
        let expected = BASE64.encode(Sha256::digest(format!("{secret}challenge").as_bytes()));
        assert_eq!(
            auth_string("supersecretpassword", "salt", "challenge"),
            expected
        );
        assert_eq!(auth_string("p", "s", "c").len(), 44);
    }

    #[test]
    fn identify_with_and_without_authentication() {
        let open = identify_message(&json!({"op": 0, "d": {"rpcVersion": 1}}), "").unwrap();
        assert_eq!(open["op"], 1);
        assert_eq!(open["d"]["eventSubscriptions"], SUBSCRIBE_OUTPUTS);
        assert!(open["d"]["authentication"].is_null());
        let hello = json!({"op": 0, "d": {"authentication": {"challenge": "c", "salt": "s"}}});
        let auth = identify_message(&hello, "p").unwrap();
        assert_eq!(auth["d"]["authentication"], auth_string("p", "s", "c"));
        assert!(identify_message(&hello, "").is_err());
    }

    #[test]
    fn only_a_stopped_recording_with_a_path_is_reported() {
        let event = |state: &str, path: &str| json!({"op": 5, "d": {"eventType": "RecordStateChanged", "eventData": {"outputActive": false, "outputState": state, "outputPath": path}}});
        assert_eq!(
            stopped_recording(&event(OUTPUT_STOPPED, "C:/Videos/2026-11-14 19-00-01.mkv")),
            Some(PathBuf::from("C:/Videos/2026-11-14 19-00-01.mkv"))
        );
        assert_eq!(
            stopped_recording(&event("OBS_WEBSOCKET_OUTPUT_STARTED", "x.mkv")),
            None
        );
        assert_eq!(stopped_recording(&event(OUTPUT_STOPPED, "")), None);
        assert_eq!(
            stopped_recording(&json!({"op": 5, "d": {"eventType": "StreamStateChanged"}})),
            None
        );
    }
}
