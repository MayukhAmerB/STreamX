//! The recording upload API (`/api/recording-uploads/`), authenticated with `X-Upload-Token`.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct Upload {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub session_id: Option<u64>,
    #[serde(default)]
    pub session_title: String,
    pub total_bytes: u64,
    pub chunk_bytes: u64,
    pub chunk_count: u64,
    #[serde(default)]
    pub received_chunks: Vec<u64>,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub result: Option<Value>,
}

#[derive(Debug)]
pub enum ApiError {
    /// The server answered with an HTTP error (code, stable error code, message).
    Status(u16, String, String),
    /// No answer (connection refused / reset / timeout): retry later.
    Transport(String),
}

impl ApiError {
    /// Sending the same request again may succeed.
    pub fn is_retryable(&self) -> bool {
        match self {
            ApiError::Transport(_) => true,
            ApiError::Status(status, code, _) => {
                matches!(*status, 408 | 425 | 429 | 500..=599)
                    || code == "chunk_checksum_mismatch"
                    || code == "chunk_incomplete"
            }
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Status(status, code, message) => write!(f, "HTTP {status} {code}: {message}"),
            ApiError::Transport(message) => write!(f, "connection problem: {message}"),
        }
    }
}

pub struct Api {
    base: String,
    token: String,
    agent: ureq::Agent,
}

fn from_ureq(error: ureq::Error) -> ApiError {
    match error {
        ureq::Error::Status(status, response) => {
            let body: Value = response.into_json().unwrap_or(Value::Null);
            let code = body["errors"]["code"]
                .as_str()
                .or(body["code"].as_str())
                .unwrap_or("")
                .to_string();
            let message = body["message"].as_str().unwrap_or("").to_string();
            ApiError::Status(status, code, message)
        }
        ureq::Error::Transport(transport) => ApiError::Transport(transport.to_string()),
    }
}

fn data<T: for<'de> Deserialize<'de>>(response: ureq::Response) -> Result<T, ApiError> {
    let body: Value = response
        .into_json()
        .map_err(|err| ApiError::Transport(err.to_string()))?;
    serde_json::from_value(body["data"].clone())
        .map_err(|err| ApiError::Transport(format!("unexpected answer: {err}")))
}

impl Api {
    pub fn new(base: &str, token: &str) -> Api {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(120))
            .timeout_write(Duration::from_secs(300))
            .user_agent(concat!("obs-uploader/", env!("CARGO_PKG_VERSION")))
            .build();
        Api {
            base: base.trim_end_matches('/').to_string(),
            token: token.to_string(),
            agent,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/recording-uploads/{}", self.base, path)
    }

    /// Starts the upload, or resumes the unfinished upload of the same file.
    pub fn create(
        &self,
        filename: &str,
        size: u64,
        sha256: &str,
        session_id: Option<u64>,
    ) -> Result<Upload, ApiError> {
        let mut body = json!({"filename": filename, "size": size, "sha256": sha256});
        if let Some(id) = session_id {
            body["session_id"] = json!(id);
        }
        let response = self
            .agent
            .post(&self.url(""))
            .set("X-Upload-Token", &self.token)
            .send_json(body)
            .map_err(from_ureq)?;
        data(response)
    }

    pub fn put_chunk(
        &self,
        upload_id: &str,
        index: u64,
        bytes: &[u8],
        sha256: &str,
    ) -> Result<(), ApiError> {
        self.agent
            .put(&self.url(&format!("{upload_id}/chunks/{index}/")))
            .set("X-Upload-Token", &self.token)
            .set("Content-Type", "application/octet-stream")
            .set("X-Chunk-Sha256", sha256)
            .send_bytes(bytes)
            .map_err(from_ureq)?;
        Ok(())
    }

    pub fn complete(&self, upload_id: &str) -> Result<Upload, ApiError> {
        let response = self
            .agent
            .post(&self.url(&format!("{upload_id}/complete/")))
            .set("X-Upload-Token", &self.token)
            .call()
            .map_err(from_ureq)?;
        data(response)
    }

    pub fn status(&self, upload_id: &str) -> Result<Upload, ApiError> {
        let response = self
            .agent
            .get(&self.url(&format!("{upload_id}/")))
            .set("X-Upload-Token", &self.token)
            .call()
            .map_err(from_ureq)?;
        data(response)
    }

    /// The class an upload without session_id goes to (title for the log), if any.
    pub fn latest_target(&self) -> Result<Option<Value>, ApiError> {
        let response = self
            .agent
            .get(&self.url("targets/?latest=1"))
            .set("X-Upload-Token", &self.token)
            .call()
            .map_err(from_ureq)?;
        let items: Vec<Value> = data(response)?;
        Ok(items.into_iter().next())
    }
}
