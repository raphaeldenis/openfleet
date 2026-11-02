//! The desktop side of the secrets channel (docs/secrets.md, "Secrets of playbooks").
//!
//! The keychain belongs to this app. The daemon, the app's sidecar, prints one request per line on its stdout; the app does the keychain work and answers over the daemon's loopback routes
//! `/internal/secrets/take` and `/internal/secrets/deliver`, each with a single-use nonce the daemon minted. The operator nonce that authorises a REST set or clear is minted here
//! and written to the sidecar's stdin. This module holds the logic with no I/O of its own: the keychain and the loopback are ports.

use serde::Deserialize;
use serde_json::{json, Value};

/// Every line of the channel, in both directions, starts with this; the sidecar's ordinary log lines never do.
pub const SECRET_LINE_PREFIX: &str = "OPENFLEET_SECRETS ";

/// The keychain service every playbook secret is filed under; the account is `kind/id/name`.
pub const KEYCHAIN_SERVICE: &str = "app.openfleet.playbook-secrets";

const OPERATOR_NONCE_BYTES: usize = 24;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SecretScope {
  pub kind: String,
  pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretOperation {
  Set,
  Clear,
  Status,
  Read,
}

/// A request the daemon printed. It names the operation, the secret and two nonces; it never holds a value.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequest {
  #[serde(rename = "type")]
  message_type: String,
  pub op: SecretOperation,
  pub scope: SecretScope,
  pub name: String,
  pub deliver_nonce: String,
  pub take_nonce: Option<String>,
}

/// The keychain could not be used: locked, denied, or unreadable. Its cause stays out of the answer to the daemon.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeychainUnavailable;

pub trait SecretKeychain {
  fn set(&self, account: &str, value: &str) -> Result<(), KeychainUnavailable>;
  /// Removes the item; an item that is not there is a success.
  fn clear(&self, account: &str) -> Result<(), KeychainUnavailable>;
  fn read(&self, account: &str) -> Result<Option<String>, KeychainUnavailable>;
}

/// The daemon's loopback routes. `post` answers the HTTP status and the JSON body.
pub trait DaemonLoopback {
  fn post(&self, path: &str, body: &Value) -> Result<(u16, Value), String>;
}

/// Why a request was not answered; the daemon times out on its own and answers the caller with `secret_store_unavailable`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ChannelFailure {
  DaemonUnreachable,
  NonceRefused,
  MalformedAnswer,
}

/// The line after the prefix, read as a request; `None` for any line that is not one (ordinary log, another message type, broken JSON).
pub fn parse_request(json_text: &str) -> Option<SecretRequest> {
  let request: SecretRequest = serde_json::from_str(json_text).ok()?;
  (request.message_type == "secret_request").then_some(request)
}

/// The text of a secret line without its prefix, or `None` for any other line.
pub fn secret_line_payload(line: &str) -> Option<&str> {
  line.strip_prefix(SECRET_LINE_PREFIX).map(str::trim_end)
}

/// The keychain account of a secret: scope kind, scope id and name, joined by slashes.
pub fn keychain_account_of(scope: &SecretScope, name: &str) -> String {
  format!("{}/{}/{}", scope.kind, scope.id, name)
}

fn deliver(daemon: &impl DaemonLoopback, nonce: &str, outcome: Value) -> Result<(), ChannelFailure> {
  let mut body = outcome;
  body["nonce"] = Value::String(nonce.to_string());
  let (status, _) = daemon.post("/internal/secrets/deliver", &body).map_err(|_| ChannelFailure::DaemonUnreachable)?;
  if status == 200 { Ok(()) } else { Err(ChannelFailure::NonceRefused) }
}

fn take_value(daemon: &impl DaemonLoopback, take_nonce: &str) -> Result<String, ChannelFailure> {
  let (status, answer) = daemon.post("/internal/secrets/take", &json!({ "nonce": take_nonce })).map_err(|_| ChannelFailure::DaemonUnreachable)?;
  if status != 200 {
    return Err(ChannelFailure::NonceRefused);
  }
  answer.get("value").and_then(Value::as_str).map(str::to_string).ok_or(ChannelFailure::MalformedAnswer)
}

fn unavailable() -> Value {
  json!({ "outcome": "unavailable" })
}

fn succeeded() -> Value {
  json!({ "outcome": "ok" })
}

/// Does the keychain work a request asks for and delivers the outcome to the daemon. A value goes from the daemon to the keychain (set) or from the keychain to the daemon (read), nowhere else.
pub fn answer_request(request: &SecretRequest, keychain: &impl SecretKeychain, daemon: &impl DaemonLoopback) -> Result<(), ChannelFailure> {
  let account = keychain_account_of(&request.scope, &request.name);
  let outcome = match request.op {
    SecretOperation::Set => {
      let Some(take_nonce) = request.take_nonce.as_deref() else { return Err(ChannelFailure::MalformedAnswer) };
      let value = take_value(daemon, take_nonce)?;
      keychain.set(&account, &value).map_or_else(|_| unavailable(), |()| succeeded())
    }
    SecretOperation::Clear => keychain.clear(&account).map_or_else(|_| unavailable(), |()| succeeded()),
    SecretOperation::Status => keychain.read(&account).map_or_else(
      |_| unavailable(),
      |found| json!({ "outcome": if found.is_some() { "stored" } else { "missing" } }),
    ),
    SecretOperation::Read => keychain.read(&account).map_or_else(
      |_| unavailable(),
      |found| found.map_or_else(|| json!({ "outcome": "not_found" }), |value| json!({ "outcome": "value", "value": value })),
    ),
  };
  deliver(daemon, &request.deliver_nonce, outcome)
}

/// A nonce of 192 random bits written in hexadecimal (48 characters, inside the daemon's URL-safe alphabet).
pub fn operator_nonce_from(random: [u8; OPERATOR_NONCE_BYTES]) -> String {
  random.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The line that hands an operator nonce to the daemon over the sidecar's stdin.
pub fn operator_nonce_line(nonce: &str) -> String {
  format!("{SECRET_LINE_PREFIX}{}\n", json!({ "type": "operator_nonce", "nonce": nonce }))
}

/// What a chunk of the sidecar's stdout holds: the secret requests it completes, and the bytes that are ordinary output.
#[derive(Debug, Default, PartialEq)]
pub struct FilteredChunk {
  pub requests: Vec<String>,
  pub passthrough: Vec<u8>,
}

/// Takes the secret lines out of the sidecar's stdout so they reach neither the log nor the status line. A chunk may end in the middle of a line:
/// only a partial line that could still become a secret line is held back until its newline; any other partial line passes at once.
#[derive(Debug, Default)]
pub struct SecretLineFilter {
  held: Vec<u8>,
}

impl SecretLineFilter {
  pub fn feed(&mut self, chunk: &[u8]) -> FilteredChunk {
    let mut filtered = FilteredChunk::default();
    self.held.extend_from_slice(chunk);
    while let Some(newline) = self.held.iter().position(|byte| *byte == b'\n') {
      let line: Vec<u8> = self.held.drain(..=newline).collect();
      match secret_line_payload(&String::from_utf8_lossy(&line)) {
        Some(payload) => filtered.requests.push(payload.to_string()),
        None => filtered.passthrough.extend_from_slice(&line),
      }
    }
    let prefix = SECRET_LINE_PREFIX.as_bytes();
    let could_become_secret_line = prefix.starts_with(&self.held) || self.held.starts_with(prefix);
    if !could_become_secret_line {
      filtered.passthrough.append(&mut self.held);
    }
    filtered
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;
  use std::collections::HashMap;

  const CANARY: &str = "canary-value-0123456789";

  fn request_json(op: &str, take_nonce: Option<&str>) -> String {
    let mut request = json!({ "type": "secret_request", "requestId": "r1", "op": op, "scope": { "kind": "playbook", "id": "pb-1" }, "name": "JIRA_TOKEN", "deliverNonce": "deliver-1" });
    if let Some(nonce) = take_nonce {
      request["takeNonce"] = json!(nonce);
    }
    request.to_string()
  }

  fn request_of(op: &str, take_nonce: Option<&str>) -> SecretRequest {
    parse_request(&request_json(op, take_nonce)).unwrap()
  }

  #[derive(Default)]
  struct FakeKeychain {
    items: RefCell<HashMap<String, String>>,
    locked: bool,
  }

  impl SecretKeychain for FakeKeychain {
    fn set(&self, account: &str, value: &str) -> Result<(), KeychainUnavailable> {
      if self.locked {
        return Err(KeychainUnavailable);
      }
      self.items.borrow_mut().insert(account.to_string(), value.to_string());
      Ok(())
    }
    fn clear(&self, account: &str) -> Result<(), KeychainUnavailable> {
      if self.locked {
        return Err(KeychainUnavailable);
      }
      self.items.borrow_mut().remove(account);
      Ok(())
    }
    fn read(&self, account: &str) -> Result<Option<String>, KeychainUnavailable> {
      if self.locked {
        return Err(KeychainUnavailable);
      }
      Ok(self.items.borrow().get(account).cloned())
    }
  }

  /// A daemon that serves `take` from `value_to_take` and records every post.
  struct FakeDaemon {
    value_to_take: Option<String>,
    status: u16,
    posts: RefCell<Vec<(String, Value)>>,
  }

  impl FakeDaemon {
    fn accepting() -> Self {
      Self { value_to_take: Some(CANARY.to_string()), status: 200, posts: RefCell::new(Vec::new()) }
    }
    fn delivered(&self) -> Value {
      self.posts.borrow().iter().find(|(path, _)| path == "/internal/secrets/deliver").map(|(_, body)| body.clone()).unwrap()
    }
  }

  impl DaemonLoopback for FakeDaemon {
    fn post(&self, path: &str, body: &Value) -> Result<(u16, Value), String> {
      self.posts.borrow_mut().push((path.to_string(), body.clone()));
      let answer = if path == "/internal/secrets/take" { json!({ "value": self.value_to_take }) } else { json!({ "ok": true }) };
      Ok((self.status, answer))
    }
  }

  const ACCOUNT: &str = "playbook/pb-1/JIRA_TOKEN";

  #[test]
  fn parses_a_request_line_of_the_daemon() {
    let request = request_of("set", Some("take-1"));

    assert_eq!(request.op, SecretOperation::Set);
    assert_eq!(request.scope, SecretScope { kind: "playbook".to_string(), id: "pb-1".to_string() });
    assert_eq!((request.name.as_str(), request.deliver_nonce.as_str(), request.take_nonce.as_deref()), ("JIRA_TOKEN", "deliver-1", Some("take-1")));
  }

  #[test]
  fn refuses_anything_that_is_not_a_secret_request() {
    for text in ["{not json", "{\"type\":\"operator_nonce\",\"nonce\":\"abc\"}", "{\"type\":\"secret_request\",\"op\":\"destroy\"}", ""] {
      assert_eq!(parse_request(text), None, "{text}");
    }
  }

  #[test]
  fn files_the_secret_under_scope_kind_scope_id_and_name() {
    let scope = SecretScope { kind: "connection".to_string(), id: "c-9".to_string() };

    assert_eq!(keychain_account_of(&scope, "API_KEY"), "connection/c-9/API_KEY");
  }

  #[test]
  fn a_set_takes_the_value_once_stores_it_and_delivers_ok_without_the_value() {
    let (keychain, daemon) = (FakeKeychain::default(), FakeDaemon::accepting());

    let result = answer_request(&request_of("set", Some("take-1")), &keychain, &daemon);

    assert_eq!(result, Ok(()));
    assert_eq!(keychain.items.borrow().get(ACCOUNT).map(String::as_str), Some(CANARY));
    assert_eq!(daemon.delivered(), json!({ "outcome": "ok", "nonce": "deliver-1" }));
    assert_eq!(daemon.posts.borrow()[0], ("/internal/secrets/take".to_string(), json!({ "nonce": "take-1" })));
  }

  #[test]
  fn a_set_on_a_locked_keychain_delivers_unavailable_and_stores_nothing() {
    let (keychain, daemon) = (FakeKeychain { locked: true, ..FakeKeychain::default() }, FakeDaemon::accepting());

    answer_request(&request_of("set", Some("take-1")), &keychain, &daemon).unwrap();

    assert_eq!(daemon.delivered(), json!({ "outcome": "unavailable", "nonce": "deliver-1" }));
    assert!(keychain.items.borrow().is_empty());
  }

  #[test]
  fn a_set_without_a_take_nonce_is_not_answered() {
    let (keychain, daemon) = (FakeKeychain::default(), FakeDaemon::accepting());

    assert_eq!(answer_request(&request_of("set", None), &keychain, &daemon), Err(ChannelFailure::MalformedAnswer));
    assert!(daemon.posts.borrow().is_empty());
  }

  #[test]
  fn a_refused_take_stores_nothing_and_delivers_nothing() {
    let (keychain, daemon) = (FakeKeychain::default(), FakeDaemon { status: 401, ..FakeDaemon::accepting() });

    let result = answer_request(&request_of("set", Some("take-1")), &keychain, &daemon);

    assert_eq!(result, Err(ChannelFailure::NonceRefused));
    assert!(keychain.items.borrow().is_empty());
    assert_eq!(daemon.posts.borrow().len(), 1);
  }

  #[test]
  fn a_clear_removes_the_item_and_clearing_a_missing_item_still_delivers_ok() {
    let keychain = FakeKeychain::default();
    keychain.items.borrow_mut().insert(ACCOUNT.to_string(), CANARY.to_string());
    let first = FakeDaemon::accepting();
    let second = FakeDaemon::accepting();

    answer_request(&request_of("clear", None), &keychain, &first).unwrap();
    answer_request(&request_of("clear", None), &keychain, &second).unwrap();

    assert!(keychain.items.borrow().is_empty());
    assert_eq!((first.delivered()["outcome"].clone(), second.delivered()["outcome"].clone()), (json!("ok"), json!("ok")));
  }

  #[test]
  fn a_status_reports_stored_or_missing_and_never_the_value() {
    let keychain = FakeKeychain::default();
    let missing = FakeDaemon::accepting();
    answer_request(&request_of("status", None), &keychain, &missing).unwrap();
    keychain.items.borrow_mut().insert(ACCOUNT.to_string(), CANARY.to_string());
    let stored = FakeDaemon::accepting();

    answer_request(&request_of("status", None), &keychain, &stored).unwrap();

    assert_eq!(missing.delivered()["outcome"], json!("missing"));
    assert_eq!(stored.delivered(), json!({ "outcome": "stored", "nonce": "deliver-1" }));
  }

  #[test]
  fn a_read_delivers_the_value_or_not_found() {
    let keychain = FakeKeychain::default();
    let absent = FakeDaemon::accepting();
    answer_request(&request_of("read", None), &keychain, &absent).unwrap();
    keychain.items.borrow_mut().insert(ACCOUNT.to_string(), CANARY.to_string());
    let present = FakeDaemon::accepting();

    answer_request(&request_of("read", None), &keychain, &present).unwrap();

    assert_eq!(absent.delivered(), json!({ "outcome": "not_found", "nonce": "deliver-1" }));
    assert_eq!(present.delivered(), json!({ "outcome": "value", "value": CANARY, "nonce": "deliver-1" }));
  }

  #[test]
  fn a_read_on_a_locked_keychain_delivers_unavailable() {
    let (keychain, daemon) = (FakeKeychain { locked: true, ..FakeKeychain::default() }, FakeDaemon::accepting());

    answer_request(&request_of("read", None), &keychain, &daemon).unwrap();

    assert_eq!(daemon.delivered(), json!({ "outcome": "unavailable", "nonce": "deliver-1" }));
  }

  #[test]
  fn a_delivery_the_daemon_refuses_is_a_failure() {
    let (keychain, daemon) = (FakeKeychain::default(), FakeDaemon { status: 401, ..FakeDaemon::accepting() });

    assert_eq!(answer_request(&request_of("clear", None), &keychain, &daemon), Err(ChannelFailure::NonceRefused));
  }

  #[test]
  fn writes_an_operator_nonce_as_48_hex_characters_inside_the_daemons_alphabet() {
    let nonce = operator_nonce_from([171; OPERATOR_NONCE_BYTES]);

    assert_eq!(nonce.len(), 48);
    assert!(nonce.chars().all(|character| character.is_ascii_hexdigit()));
  }

  #[test]
  fn hands_the_operator_nonce_to_the_daemon_as_one_prefixed_json_line() {
    let line = operator_nonce_line("abc123");

    assert!(line.ends_with('\n'));
    let payload = secret_line_payload(&line).unwrap();
    let message: Value = serde_json::from_str(payload).unwrap();
    assert_eq!(message, json!({ "type": "operator_nonce", "nonce": "abc123" }));
  }

  #[test]
  fn takes_secret_lines_out_of_the_output_and_keeps_the_rest() {
    let mut filter = SecretLineFilter::default();
    let chunk = format!("hello\n{SECRET_LINE_PREFIX}{{\"a\":1}}\nworld\n");

    let filtered = filter.feed(chunk.as_bytes());

    assert_eq!(filtered, FilteredChunk { requests: vec!["{\"a\":1}".to_string()], passthrough: b"hello\nworld\n".to_vec() });
  }

  #[test]
  fn reassembles_a_secret_line_split_across_chunks_and_withholds_its_pieces() {
    let mut filter = SecretLineFilter::default();
    let line = format!("{SECRET_LINE_PREFIX}{{\"nonce\":\"n\"}}\n");
    let (head, tail) = line.split_at(30);

    let first = filter.feed(head.as_bytes());
    let second = filter.feed(tail.as_bytes());

    assert_eq!(first, FilteredChunk::default());
    assert_eq!(second, FilteredChunk { requests: vec!["{\"nonce\":\"n\"}".to_string()], passthrough: Vec::new() });
  }

  #[test]
  fn lets_an_ordinary_partial_line_through_at_once() {
    let mut filter = SecretLineFilter::default();

    let filtered = filter.feed(b"daemon listening on");

    assert_eq!(filtered.passthrough, b"daemon listening on".to_vec());
  }

  #[test]
  fn holds_back_a_partial_line_that_could_still_be_the_prefix() {
    let mut filter = SecretLineFilter::default();

    let filtered = filter.feed(b"OPENFLEET_SEC");

    assert_eq!(filtered, FilteredChunk::default());
  }
}
