//! The desktop side of the secrets channel (docs/secrets.md, "Secrets of playbooks").
//!
//! The keychain belongs to this app. The daemon, the app's sidecar, prints one request per line on its stdout; the app does the keychain work and answers on the daemon's stdin.
//! Both are private pipes: no other process can answer in the app's place or take the connection over, and only the app holds the writing end of the stdin. No network is involved.
//! This module holds the logic and no I/O of its own: the keychain is a port, and the answer is a line the caller writes to the stdin of the sidecar.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::mpsc;
use std::time::Duration;

/// Every line of the channel, in both directions, starts with this; the sidecar's ordinary log lines never do.
pub const SECRET_LINE_PREFIX: &str = "OPENFLEET_SECRETS ";

/// The keychain service every playbook secret is filed under; the account is `kind/id/name`.
pub const KEYCHAIN_SERVICE: &str = "app.openfleet.playbook-secrets";

/// How long the app waits for the keychain before it answers `unavailable`: a keychain that waits on a prompt must not hold the daemon past its own wait of 15 seconds.
pub const KEYCHAIN_WAIT: Duration = Duration::from_secs(10);

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

/// A request the daemon printed. `value` is present for a set only.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequest {
  #[serde(rename = "type")]
  message_type: String,
  pub request_id: String,
  pub op: SecretOperation,
  pub scope: SecretScope,
  pub name: String,
  pub value: Option<String>,
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

fn answer_line(request_id: &str, outcome: Value) -> String {
  let mut message = outcome;
  message["type"] = Value::String("secret_answer".to_string());
  message["requestId"] = Value::String(request_id.to_string());
  format!("{SECRET_LINE_PREFIX}{message}\n")
}

fn unavailable() -> Value {
  json!({ "outcome": "unavailable" })
}

fn succeeded() -> Value {
  json!({ "outcome": "ok" })
}

/// Does the keychain work a request asks for and returns the line that answers it on the stdin of the daemon. A value goes from the request to the keychain (set) or from the keychain to the answer (read), nowhere else.
pub fn answer_request(request: &SecretRequest, keychain: &impl SecretKeychain) -> String {
  let account = keychain_account_of(&request.scope, &request.name);
  let outcome = match request.op {
    SecretOperation::Set => match request.value.as_deref() {
      Some(value) => keychain.set(&account, value).map_or_else(|_| unavailable(), |()| succeeded()),
      None => unavailable(),
    },
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
  answer_line(&request.request_id, outcome)
}

/// Like `answer_request`, but gives up after `wait`: a keychain that blocks (a prompt nobody answers) yields the line `unavailable` and the worker finishes on its own.
pub fn answer_request_within<K: SecretKeychain + Send + Sync + 'static>(request: SecretRequest, keychain: std::sync::Arc<K>, wait: Duration) -> String {
  let request_id = request.request_id.clone();
  let (sender, receiver) = mpsc::channel();
  std::thread::spawn(move || {
    let _ = sender.send(answer_request(&request, keychain.as_ref()));
  });
  receiver.recv_timeout(wait).unwrap_or_else(|_| answer_line(&request_id, unavailable()))
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
  use std::sync::{Arc, Mutex};

  const CANARY: &str = "canary-value-0123456789";
  const ACCOUNT: &str = "playbook/pb-1/JIRA_TOKEN";

  fn request_json(op: &str, value: Option<&str>) -> String {
    let mut request = json!({ "type": "secret_request", "requestId": "req-1", "op": op, "scope": { "kind": "playbook", "id": "pb-1" }, "name": "JIRA_TOKEN" });
    if let Some(value) = value {
      request["value"] = json!(value);
    }
    request.to_string()
  }

  fn request_of(op: &str, value: Option<&str>) -> SecretRequest {
    parse_request(&request_json(op, value)).unwrap()
  }

  fn answer_of(line: &str) -> Value {
    serde_json::from_str(secret_line_payload(line).unwrap()).unwrap()
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

  /// A keychain whose every call waits until the test lets it go, as a keychain does behind a prompt nobody answers.
  struct BlockedKeychain {
    release: Mutex<mpsc::Receiver<()>>,
  }

  impl SecretKeychain for BlockedKeychain {
    fn set(&self, _account: &str, _value: &str) -> Result<(), KeychainUnavailable> {
      let _ = self.release.lock().unwrap().recv();
      Ok(())
    }
    fn clear(&self, _account: &str) -> Result<(), KeychainUnavailable> {
      let _ = self.release.lock().unwrap().recv();
      Ok(())
    }
    fn read(&self, _account: &str) -> Result<Option<String>, KeychainUnavailable> {
      let _ = self.release.lock().unwrap().recv();
      Ok(Some(CANARY.to_string()))
    }
  }

  #[test]
  fn parses_a_request_line_of_the_daemon() {
    let request = request_of("set", Some(CANARY));

    assert_eq!(request.op, SecretOperation::Set);
    assert_eq!(request.scope, SecretScope { kind: "playbook".to_string(), id: "pb-1".to_string() });
    assert_eq!((request.request_id.as_str(), request.name.as_str(), request.value.as_deref()), ("req-1", "JIRA_TOKEN", Some(CANARY)));
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
  fn a_set_stores_the_value_and_answers_ok_under_the_request_id_without_the_value() {
    let keychain = FakeKeychain::default();

    let line = answer_request(&request_of("set", Some(CANARY)), &keychain);

    assert_eq!(keychain.items.borrow().get(ACCOUNT).map(String::as_str), Some(CANARY));
    assert_eq!(answer_of(&line), json!({ "type": "secret_answer", "requestId": "req-1", "outcome": "ok" }));
    assert!(!line.contains(CANARY));
  }

  #[test]
  fn a_set_without_a_value_stores_nothing_and_answers_unavailable() {
    let keychain = FakeKeychain::default();

    let line = answer_request(&request_of("set", None), &keychain);

    assert_eq!(answer_of(&line)["outcome"], json!("unavailable"));
    assert!(keychain.items.borrow().is_empty());
  }

  #[test]
  fn a_set_on_a_locked_keychain_answers_unavailable_and_stores_nothing() {
    let keychain = FakeKeychain { locked: true, ..FakeKeychain::default() };

    let line = answer_request(&request_of("set", Some(CANARY)), &keychain);

    assert_eq!(answer_of(&line)["outcome"], json!("unavailable"));
    assert!(keychain.items.borrow().is_empty());
  }

  #[test]
  fn a_clear_removes_the_item_and_clearing_a_missing_item_still_answers_ok() {
    let keychain = FakeKeychain::default();
    keychain.items.borrow_mut().insert(ACCOUNT.to_string(), CANARY.to_string());

    let first = answer_request(&request_of("clear", None), &keychain);
    let second = answer_request(&request_of("clear", None), &keychain);

    assert!(keychain.items.borrow().is_empty());
    assert_eq!((answer_of(&first)["outcome"].clone(), answer_of(&second)["outcome"].clone()), (json!("ok"), json!("ok")));
  }

  #[test]
  fn a_status_reports_stored_or_missing_and_never_the_value() {
    let keychain = FakeKeychain::default();
    let missing = answer_request(&request_of("status", None), &keychain);
    keychain.items.borrow_mut().insert(ACCOUNT.to_string(), CANARY.to_string());

    let stored = answer_request(&request_of("status", None), &keychain);

    assert_eq!(answer_of(&missing)["outcome"], json!("missing"));
    assert_eq!(answer_of(&stored)["outcome"], json!("stored"));
    assert!(!stored.contains(CANARY));
  }

  #[test]
  fn a_read_answers_the_value_or_not_found() {
    let keychain = FakeKeychain::default();
    let absent = answer_request(&request_of("read", None), &keychain);
    keychain.items.borrow_mut().insert(ACCOUNT.to_string(), CANARY.to_string());

    let present = answer_request(&request_of("read", None), &keychain);

    assert_eq!(answer_of(&absent), json!({ "type": "secret_answer", "requestId": "req-1", "outcome": "not_found" }));
    assert_eq!(answer_of(&present), json!({ "type": "secret_answer", "requestId": "req-1", "outcome": "value", "value": CANARY }));
  }

  #[test]
  fn a_read_on_a_locked_keychain_answers_unavailable() {
    let keychain = FakeKeychain { locked: true, ..FakeKeychain::default() };

    let line = answer_request(&request_of("read", None), &keychain);

    assert_eq!(answer_of(&line)["outcome"], json!("unavailable"));
  }

  #[test]
  fn a_blocked_keychain_answers_unavailable_within_the_wait_and_never_the_value() {
    let (release, blocked) = mpsc::channel();
    let keychain = Arc::new(BlockedKeychain { release: Mutex::new(blocked) });

    let line = answer_request_within(request_of("read", None), keychain, Duration::from_millis(50));

    assert_eq!(answer_of(&line), json!({ "type": "secret_answer", "requestId": "req-1", "outcome": "unavailable" }));
    assert!(!line.contains(CANARY));
    drop(release);
  }

  #[test]
  fn a_blocked_keychain_does_not_hold_back_the_next_request() {
    let (release, blocked) = mpsc::channel();
    let stuck = Arc::new(BlockedKeychain { release: Mutex::new(blocked) });
    let free = Arc::new(Mutex::new(FakeKeychainSync::default()));
    let _ = answer_request_within(request_of("clear", None), stuck, Duration::from_millis(20));

    let line = answer_request_within(request_of("status", None), free, Duration::from_secs(5));

    assert_eq!(answer_of(&line)["outcome"], json!("missing"));
    drop(release);
  }

  /// A thread-safe keychain with nothing in it, for the request that follows a blocked one.
  #[derive(Default)]
  struct FakeKeychainSync(HashMap<String, String>);

  impl SecretKeychain for Mutex<FakeKeychainSync> {
    fn set(&self, account: &str, value: &str) -> Result<(), KeychainUnavailable> {
      self.lock().unwrap().0.insert(account.to_string(), value.to_string());
      Ok(())
    }
    fn clear(&self, account: &str) -> Result<(), KeychainUnavailable> {
      self.lock().unwrap().0.remove(account);
      Ok(())
    }
    fn read(&self, account: &str) -> Result<Option<String>, KeychainUnavailable> {
      Ok(self.lock().unwrap().0.get(account).cloned())
    }
  }

  #[test]
  fn an_answer_names_the_request_it_answers_so_an_older_generation_of_the_daemon_can_ignore_it() {
    let keychain = FakeKeychain::default();
    let mut request = request_of("clear", None);
    request.request_id = "request-of-the-old-daemon".to_string();

    let line = answer_request(&request, &keychain);

    assert_eq!(answer_of(&line)["requestId"], json!("request-of-the-old-daemon"));
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
