//! A minimal HTTP/1.1 client for the daemon's loopback routes: one JSON POST per connection, no token and no Origin header (the internal secret routes refuse both).

use crate::secret_channel::DaemonLoopback;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

pub struct Loopback {
  address: SocketAddr,
}

impl Loopback {
  pub fn at(address: SocketAddr) -> Self {
    Self { address }
  }
}

fn request_text(path: &str, body: &str) -> String {
  format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

/// Decodes a chunked body; stops at the terminating chunk or at the first malformed size.
fn dechunked(mut raw: &[u8]) -> Vec<u8> {
  let mut body = Vec::new();
  while let Some(line_end) = raw.windows(2).position(|pair| pair == b"\r\n") {
    let size_text = String::from_utf8_lossy(&raw[..line_end]);
    let Ok(size) = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16) else { break };
    let chunk_start = line_end + 2;
    if size == 0 || raw.len() < chunk_start + size {
      break;
    }
    body.extend_from_slice(&raw[chunk_start..chunk_start + size]);
    raw = raw.get(chunk_start + size + 2..).unwrap_or(&[]);
  }
  body
}

/// The status and the JSON body of a raw HTTP response; an empty or non-JSON body reads as `null`.
pub fn parse_response(raw: &[u8]) -> Result<(u16, Value), String> {
  let separator = raw.windows(4).position(|window| window == b"\r\n\r\n").ok_or("the answer has no header end")?;
  let head = String::from_utf8_lossy(&raw[..separator]).to_string();
  let status = head.lines().next().and_then(|status_line| status_line.split_whitespace().nth(1)).and_then(|code| code.parse::<u16>().ok()).ok_or("the answer has no status")?;
  let is_chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
  let body_bytes = &raw[separator + 4..];
  let body = if is_chunked { dechunked(body_bytes) } else { body_bytes.to_vec() };
  Ok((status, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

impl DaemonLoopback for Loopback {
  fn post(&self, path: &str, body: &Value) -> Result<(u16, Value), String> {
    let mut stream = TcpStream::connect_timeout(&self.address, CONNECT_TIMEOUT).map_err(|error| error.kind().to_string())?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(|error| error.kind().to_string())?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(|error| error.kind().to_string())?;
    stream.write_all(request_text(path, &body.to_string()).as_bytes()).map_err(|error| error.kind().to_string())?;
    let mut raw = Vec::new();
    stream.take(MAX_RESPONSE_BYTES).read_to_end(&mut raw).map_err(|error| error.kind().to_string())?;
    parse_response(&raw)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use std::net::TcpListener;

  /// Serves one connection: answers `response` and returns what the client sent.
  fn serve_once(response: &'static str) -> (SocketAddr, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut received = Vec::new();
      let mut buffer = [0u8; 1024];
      while !String::from_utf8_lossy(&received).contains("\r\n\r\n{") {
        let read = stream.read(&mut buffer).unwrap();
        received.extend_from_slice(&buffer[..read]);
      }
      stream.write_all(response.as_bytes()).unwrap();
      String::from_utf8_lossy(&received).to_string()
    });
    (address, handle)
  }

  #[test]
  fn posts_the_json_body_with_no_token_and_no_origin_and_reads_the_answer() {
    let (address, server) = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"ok\":true}  ");

    let answer = Loopback::at(address).post("/internal/secrets/deliver", &json!({ "nonce": "n" }));

    let request = server.join().unwrap().to_ascii_lowercase();
    assert_eq!(answer, Ok((200, json!({ "ok": true }))));
    assert!(request.starts_with("post /internal/secrets/deliver http/1.1\r\n"));
    assert!(request.ends_with("{\"nonce\":\"n\"}"));
    assert!(!request.contains("authorization:") && !request.contains("origin:"));
  }

  #[test]
  fn reads_a_refusal_status() {
    let (address, _server) = serve_once("HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}");

    let answer = Loopback::at(address).post("/internal/secrets/take", &json!({ "nonce": "n" }));

    assert_eq!(answer, Ok((401, json!({}))));
  }

  #[test]
  fn decodes_a_chunked_body() {
    let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n";

    assert_eq!(parse_response(raw), Ok((200, json!({ "a": 1 }))));
  }

  #[test]
  fn reports_an_answer_without_a_status_as_an_error() {
    assert!(parse_response(b"garbage").is_err());
  }

  #[test]
  fn reports_a_daemon_that_is_not_listening_as_an_error() {
    let address = {
      let listener = TcpListener::bind("127.0.0.1:0").unwrap();
      listener.local_addr().unwrap()
    };

    assert!(Loopback::at(address).post("/internal/secrets/take", &json!({})).is_err());
  }
}
