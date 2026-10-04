//! Acceptance of the allowlist through the public writer and an in-memory filesystem.
//!
//! Two sinks run the same property:
//! - `ProjectionSink` (the fake sink) is the projection alone: line assembler, projection, render, grammar.
//! - `WriterSink` is the production path: the daemon's chunks go through `DesktopLog::ingest_daemon_chunk`, the desktop's own failures
//!   through the constructors `daemon.rs` uses, and the stored file is read back.

use super::salt::SALT_LEN;
use super::field::{SessionId, ShortId};
use super::{validate, DaemonLineAssembler, DesktopEvent, EventName, KnownPaths, PathClass, Salt, Stream, Ts};
use crate::log_file::{DesktopLog, RotatingLog, KEPT_FILES, MAX_LOG_BYTES};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const NOW: &str = "2026-10-04T12:00:00Z";
const FIXED_SEED: u64 = 0x9E37_79B9_7F4A_7C15;
const RANDOM_ITEM_COUNT: usize = 2_000;
const RANDOM_PREFIX_COUNT: usize = 40;
const WINDOW_BYTES: usize = 12;
const MIN_FORM_BYTES: usize = 6;
const BASE64_EDGE_CHARS: usize = 4;
const FIVE_MIB: usize = 5 * 1024 * 1024;
const ASSEMBLER_CAP_BYTES: usize = 64 * 1024;
const BOUNDARY_ANCHORS: [usize; 6] = [16_383, 16_384, 16_385, ASSEMBLER_CAP_BYTES - 1, ASSEMBLER_CAP_BYTES, ASSEMBLER_CAP_BYTES + 1];
const BOUNDARY_PADDINGS: [char; 4] = ['a', 'é', '日', '😀'];
const WRITER_CLOSE_TIMEOUT: Duration = Duration::from_secs(60);
const BENIGN_FIRST_LINE: &[u8] = b"benign line before the hostile one\r\n";
const SCENARIOS_PER_WRITER: usize = 64;
const BOUNDARY_SECRET: &str = "SyntheticBoundarySecret0123456789";

// ---- the corpus ----

#[derive(Clone)]
struct HostileItem {
  name: String,
  text: String,
  secret: String,
}

impl HostileItem {
  fn bare(name: &str, secret: String) -> Self {
    Self { name: name.to_string(), text: secret.clone(), secret }
  }

  fn carried(name: &str, text: String, secret: &str) -> Self {
    Self { name: name.to_string(), text, secret: secret.to_string() }
  }
}

fn alphanumeric(length: usize) -> String {
  "aB3".repeat(length / 3 + 1)[..length].to_string()
}

fn the_twenty_nine_provider_credentials() -> Vec<HostileItem> {
  let after = |prefix: &str, body: String| format!("{prefix}{body}");
  let mut credentials = vec![after("sk-", alphanumeric(30))];
  credentials.extend(["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map(|prefix| after(prefix, alphanumeric(36))));
  credentials.push(after("github_pat_", "aB3_".repeat(15)));
  credentials.extend(["AKIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE", "eyJabcdef.eyJabcdef.abcdef"].map(str::to_string));
  credentials.extend(["xoxb-", "xoxp-", "xoxc-", "xoxd-", "xoxe-", "xoxa-", "xoxr-", "xoxs-", "xapp-", "xoxe.xoxp-"].map(|prefix| after(prefix, alphanumeric(30))));
  credentials.push(after("AIza", "Ab3_-".repeat(8)));
  credentials.push(after("npm_", alphanumeric(36)));
  credentials.push(format!("glpat-{}.01.abcd", alphanumeric(24)));
  credentials.extend(["sk_live_", "rk_live_", "sk_test_", "rk_test_", "whsec_", "hf_"].map(|prefix| after(prefix, alphanumeric(36))));
  credentials.into_iter().map(|credential| HostileItem::bare(&format!("provider {credential}"), credential)).collect()
}

fn credential_schemes() -> Vec<HostileItem> {
  const PEM_BODY: &str = "SYNTHETICPEMBODYNOTAREALKEY0001";
  const BASIC_PAYLOAD: &str = "c3ludGhldGljLXVzZXI6c3ludGhldGljLXBhc3M=";
  const HOOK_TOKEN: &str = "SyntheticHookToken0123456789";
  const USERINFO_PASSWORD: &str = "SyntheticPassw0rdUserinfo";
  const QUERY_SECRET: &str = "SyntheticQuerySecret0123";
  const COOKIE_VALUE: &str = "SyntheticCookieValue0123";
  const BEARER_VALUE: &str = "SyntheticBearerValue0123";

  let pem_blocks = ["RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "PGP PRIVATE KEY BLOCK", "PRIVATE KEY", "EC PRIVATE KEY"]
    .map(|label| HostileItem::carried(&format!("pem {label}"), format!("-----BEGIN {label}-----\n{PEM_BODY}\n-----END {label}-----"), PEM_BODY));
  let carried = |name: &str, template: &str, secret: &str| HostileItem::carried(name, template.replace("{S}", secret), secret);
  let others = vec![
    carried("bearer header", "Authorization: Bearer {S}", BEARER_VALUE),
    carried("bearer lowercase", "authorization=bearer {S}", BEARER_VALUE),
    carried("bearer uppercase", "BEARER {S}", BEARER_VALUE),
    carried("bearer quoted", "Authorization: \"Bearer {S}\"", BEARER_VALUE),
    carried("hook path", "POST /hooks/{S} 200", HOOK_TOKEN),
    carried("hook url", "http://127.0.0.1:7332/hooks/{S}", HOOK_TOKEN),
    carried("basic header", "Authorization: Basic {S}", BASIC_PAYLOAD),
    carried("url userinfo", "https://synthetic-user:{S}@example.invalid/path", USERINFO_PASSWORD),
    carried("query token", "https://example.invalid/cb?token={S}&x=1", QUERY_SECRET),
    carried("query api key", "https://example.invalid/cb?api_key={S}", QUERY_SECRET),
    carried("cookie header", "Cookie: session={S}; theme=dark", COOKIE_VALUE),
    carried("set-cookie header", "Set-Cookie: sid={S}; HttpOnly", COOKIE_VALUE),
    carried("json password", "{\"password\":\"{S}\"}", QUERY_SECRET),
    carried("colon password", "password: {S}", QUERY_SECRET),
    carried("api key header", "x-api-key: {S}", QUERY_SECRET),
  ];
  pem_blocks.into_iter().chain(others).collect()
}

fn codex_vectors() -> Vec<HostileItem> {
  const SECRET: &str = "SyntheticCodexSecret0123";
  let carried = |name: &str, template: &str| HostileItem::carried(name, template.replace("{S}", SECRET), SECRET);
  let spaces = |count: usize| " ".repeat(count);
  let padded = |name: &str, head: &str, padding: String, tail: &str| HostileItem::carried(name, format!("{head}{padding}{tail}"), SECRET);

  vec![
    carried("F1 quoted folded cookie", "Cookie: \"a=1;\r\n session={S}\""),
    carried("F2 token scheme", "Token {S}"),
    carried("F2 digest scheme", "Digest username=\"u\", response=\"{S}\""),
    carried("F3 token array", "{\"token\":[\"{S}\"]}"),
    HostileItem::carried("F4 non-eyJ jwt", "ZmFrZWhlYWRlcg.ewogICJzeW50aGV0aWMiOiB0cnVlCn0.ZmFrZXNpZw".to_string(), "ewogICJzeW50aGV0aWMiOiB0cnVlCn0"),
    padded("F5 token after 65536 a", "token: \"", "a".repeat(65_536), &format!("{SECRET}\"")),
    carried("F6 token digits", "token: {S}"),
    carried("F6 api key header", "x-api-key: {S}"),
    carried("F6 backtick", "token: `{S}`"),
    carried("F7 bearer percent colon", "Bearer %3A {S}"),
    carried("F7 next line equals", "token\u{85}={S}"),
    carried("R1 spaced equals", "response = \"{S}\""),
    carried("R1 tab separated", "response\t=\t\"{S}\""),
    carried("R2 folded authorization", "Authorization:\r\n Bearer {S}"),
    padded("R3 array after 16383 spaces", "token: [", spaces(16_383), &format!("\"{SECRET}\"]")),
    padded("R3 second element past the bound", "token: [\"a\",", spaces(16_383), &format!("\"{SECRET}\"]")),
    carried("R3 depth 33", &format!("token: {}\"{{S}}\"{}", "[".repeat(33), "]".repeat(33))),
    padded("R4 cookie 65536 padding", "Cookie: ", "a".repeat(65_536), &format!("; session={SECRET}")),
    padded("R4 cookie 100000 padding", "Cookie: ", "a".repeat(100_000), &format!("; session={SECRET}")),
    padded("R4 authorization 65536 padding", "Authorization: ", "a".repeat(65_536), &format!(" Bearer {SECRET}")),
    padded("R4 authorization 100000 padding", "Authorization: ", "a".repeat(100_000), &format!(" Bearer {SECRET}")),
    padded("R4 cookie 16384 emoji padding", "Cookie: ", "😀".repeat(16_384), &format!("; session={SECRET}")),
  ]
}

/// xorshift64*: a fixed seed gives the same corpus on every run.
struct Xorshift64Star(u64);

impl Xorshift64Star {
  fn next(&mut self) -> u64 {
    self.0 ^= self.0 >> 12;
    self.0 ^= self.0 << 25;
    self.0 ^= self.0 >> 27;
    self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
  }

  fn below(&mut self, bound: usize) -> usize {
    (self.next() % bound as u64) as usize
  }

  fn pick(&mut self, options: &[usize]) -> usize {
    options[self.below(options.len())]
  }

  fn string_of(&mut self, alphabet: &str, length: usize) -> String {
    let symbols: Vec<char> = alphabet.chars().collect();
    (0..length).map(|_| symbols[self.below(symbols.len())]).collect()
  }
}

const HEX: &str = "0123456789abcdef";
const BASE62: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE64_STANDARD: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DIGITS: &str = "0123456789";
const PASSPHRASE: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#%&*+-.:;<>?@^~";
const LOWERCASE: &str = "abcdefghijklmnopqrstuvwxyz";

fn random_token_shapes() -> Vec<HostileItem> {
  let mut random = Xorshift64Star(FIXED_SEED);
  let prefix_count = RANDOM_PREFIX_COUNT;
  let prefixes: Vec<String> = (0..prefix_count)
    .map(|_| {
      let prefix_length = 2 + random.below(5);
      format!("{}_", random.string_of(LOWERCASE, prefix_length))
    })
    .collect();
  let hex_lengths = [32, 40, 64];
  let base64_lengths = [43, 44, 86];

  (0..RANDOM_ITEM_COUNT)
    .map(|index| {
      let (shape, secret) = match index % 10 {
        0 => {
          let length = random.pick(&hex_lengths);
          ("hex", random.string_of(HEX, length))
        }
        1 => {
          let length = random.pick(&base64_lengths);
          ("base64", random.string_of(BASE64_STANDARD, length))
        }
        2 => {
          let length = random.pick(&base64_lengths);
          ("base64url", random.string_of(BASE64_URL, length))
        }
        3 => ("jwt-like", format!("{}.{}.{}", random.string_of(BASE64_URL, 36), random.string_of(BASE64_URL, 60), random.string_of(BASE64_URL, 43))),
        4 => ("uuid", uuid_v4_of(&mut random)),
        5 | 6 => {
          let prefix = &prefixes[random.below(prefixes.len())];
          let body_length = 20 + random.below(61);
          ("prefixed base62", format!("{prefix}{}", random.string_of(BASE62, body_length)))
        }
        7 => ("pin", random.string_of(DIGITS, 6)),
        _ => {
          let passphrase_length = 16 + random.below(5);
          ("passphrase", random.string_of(PASSPHRASE, passphrase_length))
        }
      };
      HostileItem::bare(&format!("random {shape} #{index}"), secret)
    })
    .collect()
}

fn uuid_v4_of(random: &mut Xorshift64Star) -> String {
  let variant = random.string_of("89ab", 1);
  format!("{}-{}-4{}-{variant}{}-{}", random.string_of(HEX, 8), random.string_of(HEX, 4), random.string_of(HEX, 3), random.string_of(HEX, 3), random.string_of(HEX, 12))
}

/// Secrets whose first, middle or last byte sits on a boundary offset (16 KiB, the assembler cap), behind each padding character.
fn boundary_straddling_items() -> Vec<HostileItem> {
  let representatives: Vec<HostileItem> = the_twenty_nine_provider_credentials().into_iter().step_by(6).collect();
  let mut items = Vec::new();
  for representative in &representatives {
    let secret_bytes = representative.secret.len();
    let straddling_byte_indexes = [("first", 0), ("middle", secret_bytes / 2), ("last", secret_bytes - 1)];
    for (which, byte_index) in straddling_byte_indexes {
      for anchor in BOUNDARY_ANCHORS {
        for padding in BOUNDARY_PADDINGS {
          let prefix = padding_of_exact_bytes(padding, anchor - byte_index);
          let name = format!("{} {which} byte at {anchor} behind {padding}", representative.name);
          items.push(HostileItem::carried(&name, format!("{prefix}{}", representative.secret), &representative.secret));
        }
      }
    }
  }
  items
}

fn padding_of_exact_bytes(padding: char, byte_count: usize) -> String {
  let whole_padding_chars = byte_count / padding.len_utf8();
  let remainder_bytes = byte_count % padding.len_utf8();
  format!("{}{}", padding.to_string().repeat(whole_padding_chars), "a".repeat(remainder_bytes))
}

// ---- where a secret can land ----

/// Every kind of free text the desktop can be handed; the exhaustive `match` in `position_in_all` forces a row for each new kind.
#[derive(Clone, Copy, Debug, PartialEq)]
enum FreeTextKind {
  SidecarReason,
  IoErrorText,
  SpawnFailurePath,
  StdoutNonJson,
  StderrNonJson,
  BootRefusalReason,
  DaemonMsg,
  Detail,
  ErrMessage,
  ErrStack,
  ErrCause,
  ExtraFieldValue,
  ExtraFieldKey,
  Ts,
  Id,
  SessionId,
  Code,
  ErrName,
  ErrCode,
}

impl FreeTextKind {
  const ALL: [FreeTextKind; 19] = [
    FreeTextKind::SidecarReason,
    FreeTextKind::IoErrorText,
    FreeTextKind::SpawnFailurePath,
    FreeTextKind::StdoutNonJson,
    FreeTextKind::StderrNonJson,
    FreeTextKind::BootRefusalReason,
    FreeTextKind::DaemonMsg,
    FreeTextKind::Detail,
    FreeTextKind::ErrMessage,
    FreeTextKind::ErrStack,
    FreeTextKind::ErrCause,
    FreeTextKind::ExtraFieldValue,
    FreeTextKind::ExtraFieldKey,
    FreeTextKind::Ts,
    FreeTextKind::Id,
    FreeTextKind::SessionId,
    FreeTextKind::Code,
    FreeTextKind::ErrName,
    FreeTextKind::ErrCode,
  ];

  fn position_in_all(self) -> usize {
    match self {
      FreeTextKind::SidecarReason => 0,
      FreeTextKind::IoErrorText => 1,
      FreeTextKind::SpawnFailurePath => 2,
      FreeTextKind::StdoutNonJson => 3,
      FreeTextKind::StderrNonJson => 4,
      FreeTextKind::BootRefusalReason => 5,
      FreeTextKind::DaemonMsg => 6,
      FreeTextKind::Detail => 7,
      FreeTextKind::ErrMessage => 8,
      FreeTextKind::ErrStack => 9,
      FreeTextKind::ErrCause => 10,
      FreeTextKind::ExtraFieldValue => 11,
      FreeTextKind::ExtraFieldKey => 12,
      FreeTextKind::Ts => 13,
      FreeTextKind::Id => 14,
      FreeTextKind::SessionId => 15,
      FreeTextKind::Code => 16,
      FreeTextKind::ErrName => 17,
      FreeTextKind::ErrCode => 18,
    }
  }

  /// What the desktop receives when `text` arrives through this kind: a desktop-made notice, or bytes on a daemon pipe.
  fn delivery_of(self, text: &str) -> Delivery {
    let json_record = |record: Value| Delivery::pipe(Stream::Out, format!("{record}\n").into_bytes());
    let error_record = |error: Value| json_record(json!({ "level": "error", "msg": "ws: write failed", "err": error }));
    match self {
      FreeTextKind::SidecarReason | FreeTextKind::IoErrorText | FreeTextKind::SpawnFailurePath => Delivery::DesktopNotice { kind: self, text: text.to_string() },
      FreeTextKind::StdoutNonJson => Delivery::pipe(Stream::Out, format!("{text}\n").into_bytes()),
      FreeTextKind::StderrNonJson => Delivery::pipe(Stream::Err, format!("{text}\n").into_bytes()),
      FreeTextKind::BootRefusalReason => Delivery::pipe(Stream::Err, format!("openfleet: refusing to boot: {text}\n").into_bytes()),
      FreeTextKind::DaemonMsg => json_record(json!({ "level": "info", "msg": text })),
      FreeTextKind::Detail => json_record(json!({ "level": "info", "msg": "ws: write failed", "detail": text })),
      FreeTextKind::ErrMessage => error_record(json!({ "name": "Error", "message": text })),
      FreeTextKind::ErrStack => error_record(json!({ "name": "Error", "message": "m", "stack": format!("Error: {text}\n    at run (/app/daemon.mjs:1:1)") })),
      FreeTextKind::ErrCause => error_record(json!({ "name": "Error", "message": "m", "cause": { "message": text } })),
      FreeTextKind::ExtraFieldValue => json_record(json!({ "level": "info", "msg": "ws: write failed", "step": text })),
      FreeTextKind::ExtraFieldKey => json_record(json!({ "level": "info", "msg": "ws: write failed", text: "x" })),
      FreeTextKind::Ts => json_record(json!({ "level": "info", "ts": text, "msg": "ws: write failed" })),
      FreeTextKind::Id => json_record(json!({ "level": "info", "id": text, "msg": "ws: write failed" })),
      FreeTextKind::SessionId => json_record(json!({ "level": "info", "sessionId": text, "msg": "ws: write failed" })),
      FreeTextKind::Code => json_record(json!({ "level": "info", "code": text, "msg": "ws: write failed" })),
      FreeTextKind::ErrName => error_record(json!({ "name": text, "message": "m" })),
      FreeTextKind::ErrCode => error_record(json!({ "name": "Error", "message": "m", "code": text })),
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Placement {
  SoleValue,
  Prefix,
  Middle,
  Suffix,
  InsideJsonString,
  AsJsonKey,
  EscapedJson,
  SplitAcrossTwoChunks,
  AfterCrlf,
}

impl Placement {
  const ALL: [Placement; 9] = [
    Placement::SoleValue,
    Placement::Prefix,
    Placement::Middle,
    Placement::Suffix,
    Placement::InsideJsonString,
    Placement::AsJsonKey,
    Placement::EscapedJson,
    Placement::SplitAcrossTwoChunks,
    Placement::AfterCrlf,
  ];

  fn text_around(self, hostile_text: &str) -> String {
    const NEIGHBOUR: &str = "neighbour words ";
    match self {
      Placement::Prefix => format!("{hostile_text} {NEIGHBOUR}"),
      Placement::Middle => format!("{NEIGHBOUR}{hostile_text} {NEIGHBOUR}"),
      Placement::Suffix => format!("{NEIGHBOUR}{hostile_text}"),
      Placement::InsideJsonString => json!({ "value": hostile_text }).to_string(),
      Placement::AsJsonKey => json!({ hostile_text: "value" }).to_string(),
      Placement::EscapedJson => Value::String(Value::String(hostile_text.to_string()).to_string()).to_string(),
      Placement::SoleValue | Placement::SplitAcrossTwoChunks | Placement::AfterCrlf => hostile_text.to_string(),
    }
  }

  fn shape_chunks(self, chunks: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    match self {
      Placement::SplitAcrossTwoChunks => chunks
        .into_iter()
        .flat_map(|chunk| {
          let (head, tail) = chunk.split_at(chunk.len() / 2);
          [head.to_vec(), tail.to_vec()]
        })
        .collect(),
      Placement::AfterCrlf => chunks.into_iter().map(|chunk| [BENIGN_FIRST_LINE, chunk.as_slice()].concat()).collect(),
      _ => chunks,
    }
  }
}

#[derive(Clone, Debug)]
enum Delivery {
  DaemonPipe { stream: Stream, chunks: Vec<Vec<u8>> },
  DesktopNotice { kind: FreeTextKind, text: String },
}

impl Delivery {
  fn pipe(stream: Stream, bytes: Vec<u8>) -> Self {
    Delivery::DaemonPipe { stream, chunks: vec![bytes] }
  }

  fn shaped_by(self, placement: Placement) -> Self {
    match self {
      Delivery::DaemonPipe { stream, chunks } => Delivery::DaemonPipe { stream, chunks: placement.shape_chunks(chunks) },
      notice @ Delivery::DesktopNotice { .. } => notice,
    }
  }
}

struct Scenario {
  name: String,
  delivery: Delivery,
  secret: String,
  typed_id_projection: Option<String>,
}

/// The oracle's single documented exception: a daemon-minted id that the typed parser accepts is stored as itself.
/// It covers only the `sessionId` and `id` fields, only when the secret is the whole field value, and only the exact `field=value` token.
fn typed_id_projection_of(kind: FreeTextKind, field_value: &str) -> Option<String> {
  match kind {
    FreeTextKind::SessionId if SessionId::parse(field_value).is_some() => Some(format!("session={field_value}")),
    FreeTextKind::Id if ShortId::parse(field_value).is_some() => Some(format!("id={field_value}")),
    _ => None,
  }
}

fn scenario_of(item: &HostileItem, kind: FreeTextKind, placement: Placement) -> Scenario {
  let text = placement.text_around(&item.text);
  let delivery = kind.delivery_of(&text).shaped_by(placement);
  let secret_is_the_whole_field_value = text == item.secret;
  let typed_id_projection = if secret_is_the_whole_field_value { typed_id_projection_of(kind, &text) } else { None };
  Scenario { name: format!("{} | {kind:?} | {placement:?}", item.name), delivery, secret: item.secret.clone(), typed_id_projection }
}

fn every_kind_and_placement(items: Vec<HostileItem>) -> impl Iterator<Item = Scenario> {
  items
    .into_iter()
    .flat_map(|item| FreeTextKind::ALL.into_iter().flat_map(move |kind| {
      let item = item.clone();
      Placement::ALL.into_iter().map(move |placement| scenario_of(&item, kind, placement))
    }))
}

fn provider_credentials_scenarios() -> impl Iterator<Item = Scenario> {
  every_kind_and_placement(the_twenty_nine_provider_credentials())
}

fn credential_schemes_scenarios() -> impl Iterator<Item = Scenario> {
  every_kind_and_placement(credential_schemes())
}

fn codex_vectors_scenarios() -> impl Iterator<Item = Scenario> {
  every_kind_and_placement(codex_vectors())
}

const KINDS_CARRYING_FREE_TEXT_ON_A_PIPE: [FreeTextKind; 3] = [FreeTextKind::DaemonMsg, FreeTextKind::StdoutNonJson, FreeTextKind::ErrMessage];

fn boundary_scenarios() -> impl Iterator<Item = Scenario> {
  every_kind_and_placement(boundary_straddling_items())
}

struct BoundaryCase {
  kind: FreeTextKind,
  anchor: usize,
  padding: char,
  secret_byte: usize,
}

fn secret_position_in(delivery: &Delivery, secret: &str) -> usize {
  let bytes = match delivery {
    Delivery::DaemonPipe { chunks, .. } => chunks.concat(),
    Delivery::DesktopNotice { text, .. } => text.as_bytes().to_vec(),
  };
  bytes.windows(secret.len()).position(|window| window == secret.as_bytes()).expect("the input contains the secret")
}

/// Pads until the chosen secret byte sits on the anchor; the envelope length depends on the padding because JSON object keys are sorted.
fn delivery_with_secret_byte_on_anchor(case: &BoundaryCase) -> Delivery {
  const SETTLING_ROUNDS: usize = 3;
  let mut padding_bytes = 0;
  for _ in 0..SETTLING_ROUNDS {
    let text = format!("{}{BOUNDARY_SECRET}", padding_of_exact_bytes(case.padding, padding_bytes));
    let delivery = case.kind.delivery_of(&text);
    let envelope_bytes = secret_position_in(&delivery, BOUNDARY_SECRET) - padding_bytes;
    let anchored_secret_byte = secret_position_in(&delivery, BOUNDARY_SECRET) + case.secret_byte;
    if anchored_secret_byte == case.anchor { return delivery; }
    padding_bytes = case.anchor - case.secret_byte - envelope_bytes;
  }
  let text = format!("{}{BOUNDARY_SECRET}", padding_of_exact_bytes(case.padding, padding_bytes));
  case.kind.delivery_of(&text)
}

fn exact_boundary_scenario(case: BoundaryCase) -> Scenario {
  let delivery = delivery_with_secret_byte_on_anchor(&case);
  let anchored_secret_byte = secret_position_in(&delivery, BOUNDARY_SECRET) + case.secret_byte;
  assert_eq!(anchored_secret_byte, case.anchor, "the byte crosses the actual input boundary");
  let delivery = match delivery {
    Delivery::DaemonPipe { stream, chunks } => {
      let bytes = chunks.concat();
      let (head, tail) = bytes.split_at(case.anchor);
      Delivery::DaemonPipe { stream, chunks: vec![head.to_vec(), tail.to_vec()] }
    }
    notice => notice,
  };
  Scenario { name: format!("actual boundary {} byte {} behind {} | {:?}", case.anchor, case.secret_byte, case.padding, case.kind), delivery, secret: BOUNDARY_SECRET.to_string(), typed_id_projection: None }
}

fn exact_boundary_scenarios() -> impl Iterator<Item = Scenario> {
  FreeTextKind::ALL.into_iter().flat_map(|kind| BOUNDARY_ANCHORS.into_iter().flat_map(move |anchor| {
    BOUNDARY_PADDINGS.into_iter().flat_map(move |padding| [0, BOUNDARY_SECRET.len() / 2, BOUNDARY_SECRET.len() - 1].into_iter().map(move |secret_byte| {
      exact_boundary_scenario(BoundaryCase { kind, anchor, padding, secret_byte })
    }))
  }))
}

fn random_token_scenarios() -> impl Iterator<Item = Scenario> {
  every_kind_and_placement(random_token_shapes())
}

fn five_mib_line_scenarios() -> Vec<Scenario> {
  let representatives: Vec<HostileItem> = the_twenty_nine_provider_credentials().into_iter().step_by(10).collect();
  representatives
    .iter()
    .flat_map(|item| {
      let giant_text = format!("{}{}{}", "a".repeat(FIVE_MIB / 2), item.text, "a".repeat(FIVE_MIB / 2));
      let giant_item = HostileItem::carried(&format!("{} inside a 5 MiB line", item.name), giant_text, &item.secret);
      KINDS_CARRYING_FREE_TEXT_ON_A_PIPE.map(|kind| scenario_of(&giant_item, kind, Placement::SoleValue))
    })
    .collect()
}

fn all_hostile_items() -> Vec<HostileItem> {
  the_twenty_nine_provider_credentials().into_iter()
    .chain(credential_schemes())
    .chain(codex_vectors())
    .chain(boundary_straddling_items())
    .chain(random_token_shapes())
    .collect()
}

fn assert_corpus_in_giant_lines(sink: &dyn Sink) {
  let items = all_hostile_items();
  let mut remaining = items.as_slice();
  while !remaining.is_empty() {
    let mut text = String::new();
    let mut included_items = 0;
    for item in remaining {
      let embedded = Value::String(item.text.clone()).to_string();
      let fits_this_batch = text.len() + embedded.len() < FIVE_MIB;
      if !fits_this_batch { break; }
      text.push_str(&embedded);
      included_items += 1;
    }
    assert!(included_items > 0);
    text.push_str(&"a".repeat(FIVE_MIB - text.len()));
    for kind in FreeTextKind::ALL {
      let delivery = kind.delivery_of(&text);
      let lines = sink.emitted_lines(&delivery);
      for item in &remaining[..included_items] {
        let name = format!("{} | {kind:?} | InsideFiveMibLine", item.name);
        assert_stored_lines(&name, &item.secret, None, &lines);
      }
      assert_eq!(lines.len(), record_count_of(&delivery) + sink.flush_marker_count());
    }
    remaining = &remaining[included_items..];
  }
}

// ---- the forbidden forms ----

fn base64_of(bytes: &[u8], alphabet: &str) -> String {
  let symbols = alphabet.as_bytes();
  bytes
    .chunks(3)
    .flat_map(|group| {
      let [first, second, third] = [group[0], *group.get(1).unwrap_or(&0), *group.get(2).unwrap_or(&0)];
      let sextets = [first >> 2, (first & 3) << 4 | second >> 4, (second & 15) << 2 | third >> 6, third & 63];
      let emitted = group.len() + 1;
      sextets.into_iter().take(emitted).map(|sextet| symbols[sextet as usize] as char)
    })
    .collect()
}

/// The part of the encoding that does not depend on the neighbouring bytes, at each of the three alignments.
fn base64_middles_of(secret: &str, alphabet: &str) -> Vec<String> {
  (0..3)
    .filter_map(|alignment| {
      let shifted = format!("{}{secret}", "x".repeat(alignment));
      let encoded = base64_of(shifted.as_bytes(), alphabet);
      let middle_length = encoded.len().checked_sub(2 * BASE64_EDGE_CHARS)?;
      Some(encoded[BASE64_EDGE_CHARS..BASE64_EDGE_CHARS + middle_length].to_string())
    })
    .collect()
}

fn hex_of(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn percent_encoded(text: &str, hex_digits_are_upper: bool) -> String {
  text
    .bytes()
    .map(|byte| if hex_digits_are_upper { format!("%{byte:02X}") } else { format!("%{byte:02x}") })
    .collect()
}

fn json_unicode_escaped(text: &str) -> String {
  text.encode_utf16().map(|unit| format!("\\u{unit:04x}")).collect()
}

fn windows_of(secret: &str) -> Vec<String> {
  secret.as_bytes().windows(WINDOW_BYTES).filter_map(|window| std::str::from_utf8(window).ok().map(str::to_string)).collect()
}

/// Lowercased text a stored line must not contain: the raw secret and each decoded form of it.
fn forbidden_forms_of(secret: &str) -> Vec<String> {
  let percent_once_lower = percent_encoded(secret, false);
  let percent_once_upper = percent_encoded(secret, true);
  let mut forms = vec![
    secret.to_string(),
    hex_of(secret.as_bytes()),
    percent_once_lower.clone(),
    percent_once_upper,
    percent_once_lower.replace('%', "%25"),
    json_unicode_escaped(secret),
  ];
  forms.extend(base64_middles_of(secret, BASE64_STANDARD));
  forms.extend(base64_middles_of(secret, BASE64_URL));
  forms.extend(windows_of(secret));
  let mut folded: Vec<String> = forms.into_iter().filter(|form| form.len() >= MIN_FORM_BYTES).map(|form| form.to_lowercase()).collect();
  folded.sort();
  folded.dedup();
  folded
}

// ---- the sinks ----

trait Sink {
  fn emitted_lines(&self, delivery: &Delivery) -> Vec<String>;

  fn emitted_batch(&self, deliveries: &[&Delivery]) -> Vec<Vec<String>> {
    deliveries.iter().map(|delivery| self.emitted_lines(delivery)).collect()
  }

  fn flush_marker_count(&self) -> usize { 0 }
}

fn fixed_now() -> Ts {
  Ts::parse(NOW).expect("a valid timestamp")
}

/// The projection, independent of the writer thread and filesystem.
struct ProjectionSink {
  salt: Option<Salt>,
}

impl ProjectionSink {
  fn with_salt() -> Self {
    Self { salt: Some(Salt::from_bytes([7; SALT_LEN])) }
  }

  fn without_salt() -> Self {
    Self { salt: None }
  }

  fn line_of(event: &DesktopEvent) -> String {
    let line = event.render(fixed_now());
    let rendered_event = if line.is_rejection() { EventName::RejectedRecord } else { event.name() };
    assert_eq!(validate(rendered_event, line.as_str()), Ok(()), "the sink emitted a line outside the grammar: {line}");
    line.to_string()
  }
}

/// The event the desktop records when `text` reaches it through a desktop-made notice; `opaque` is the tag of `text` under the sink's salt.
fn notice_event(kind: FreeTextKind, text: &str, opaque: super::Opaque) -> DesktopEvent {
  use super::{IoFailure, SpawnFailure};
  match kind {
    FreeTextKind::SidecarReason => DesktopEvent::SidecarFailed { reason: opaque },
    FreeTextKind::IoErrorText => DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::Io(IoFailure::of(&io::Error::other(text.to_string()))) },
    FreeTextKind::SpawnFailurePath => {
      let home = Path::new("/home/synthetic/.openfleet");
      let known = KnownPaths { openfleet_home: home, logs_dir: home, admin_token: home, daemon_bundle: home, user_home: Path::new("/home/synthetic") };
      DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::BundleNotFound(PathClass::classify(Path::new(text), &known)) }
    }
    other => unreachable!("{other:?} is delivered on a daemon pipe"),
  }
}

impl Sink for ProjectionSink {
  fn emitted_lines(&self, delivery: &Delivery) -> Vec<String> {
    match delivery {
      Delivery::DesktopNotice { kind, text } => {
        let opaque = super::Opaque::of(text.as_bytes(), self.salt.as_ref());
        vec![Self::line_of(&notice_event(*kind, text, opaque))]
      }
      Delivery::DaemonPipe { stream, chunks } => {
        let mut assembler = DaemonLineAssembler::new(*stream);
        let mut events: Vec<DesktopEvent> = chunks.iter().flat_map(|chunk| assembler.push_chunk(chunk, self.salt.as_ref())).collect();
        events.extend(assembler.flush(self.salt.as_ref()));
        events.iter().map(Self::line_of).collect()
      }
    }
  }
}

/// The production path: chunks go to `DesktopLog::ingest_daemon_chunk`, notices to `record_event`, and the stored file is read back.
struct WriterSink {
  salt: Option<Salt>,
}

impl WriterSink {
  fn with_salt() -> Self {
    Self { salt: Some(Salt::from_bytes([7; SALT_LEN])) }
  }

  fn without_salt() -> Self {
    Self { salt: None }
  }
}

#[derive(Clone, Default)]
struct MemoryFs(Arc<Mutex<Vec<u8>>>);

impl crate::log_file::LogFs for MemoryFs {
  fn size(&self, _path: &Path) -> io::Result<u64> {
    Ok(self.0.lock().unwrap().len() as u64)
  }

  fn append(&self, _path: &Path, bytes: &[u8]) -> io::Result<()> {
    self.0.lock().unwrap().extend_from_slice(bytes);
    Ok(())
  }

  fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
    Ok(())
  }
}

impl Sink for WriterSink {
  fn emitted_lines(&self, delivery: &Delivery) -> Vec<String> {
    self.emitted_batch(&[delivery]).remove(0)
  }

  fn flush_marker_count(&self) -> usize { 1 }

  fn emitted_batch(&self, deliveries: &[&Delivery]) -> Vec<Vec<String>> {
    let fs = MemoryFs::default();
    let rotating_log = RotatingLog::open(fs.clone(), PathBuf::from("/logs/desktop.log"), MAX_LOG_BYTES, KEPT_FILES);
    let queued_messages = deliveries.iter().map(|delivery| match delivery {
      Delivery::DaemonPipe { chunks, .. } => chunks.len(),
      Delivery::DesktopNotice { .. } => 1,
    }).sum::<usize>();
    let capacity_including_close = queued_messages + 1;
    let log = DesktopLog::start_with_capacity(rotating_log, self.salt.clone(), || 0, capacity_including_close);
    for delivery in deliveries {
      match delivery {
        Delivery::DaemonPipe { stream, chunks } => chunks.iter().for_each(|chunk| log.ingest_daemon_chunk(*stream, chunk)),
        Delivery::DesktopNotice { kind, text } => log.record_event(notice_event(*kind, text, log.opaque(text.as_bytes()))),
      }
    }
    assert!(log.flush_and_close(WRITER_CLOSE_TIMEOUT), "the writer did not drain");
    let stored = fs.0.lock().unwrap().clone();
    let mut lines: Vec<String> = String::from_utf8_lossy(&stored).lines().map(str::to_string).collect();
    let marker = lines.pop().expect("the flushed marker");
    assert!(marker.ends_with("info daemon_log_flushed drained=true"), "{marker}");
    let expected_records = deliveries.iter().map(|delivery| record_count_of(delivery)).sum::<usize>();
    assert_eq!(lines.len(), expected_records, "every input record is stored");
    let mut next_line = 0;
    deliveries.iter().map(|delivery| {
      let end = next_line + record_count_of(delivery);
      let mut scenario_lines = lines[next_line..end].to_vec();
      next_line = end;
      scenario_lines.push(marker.clone());
      scenario_lines
    }).collect()
  }
}

fn record_count_of(delivery: &Delivery) -> usize {
  let Delivery::DaemonPipe { chunks, .. } = delivery else { return 1 };
  let joined_chunks = chunks.concat();
  String::from_utf8_lossy(&joined_chunks).lines().filter(|line| !line.is_empty()).count()
}

// ---- the property ----

fn leaked_form_in(lines: &[String], secret: &str) -> Option<String> {
  let folded_lines: Vec<String> = lines.iter().map(|line| line.to_lowercase()).collect();
  let encoded_leak = forbidden_forms_of(secret).into_iter().find(|form| folded_lines.iter().any(|line| line.contains(form.as_str())));
  if encoded_leak.is_some() { return encoded_leak; }
  let folded_secret = secret.to_ascii_lowercase();
  let watched_windows: HashSet<&[u8]> = secret.as_bytes().windows(WINDOW_BYTES).chain(folded_secret.as_bytes().windows(WINDOW_BYTES)).collect();
  for view in lines.iter().flat_map(|line| decoded_views_of(line)) {
    for window in view.windows(WINDOW_BYTES) {
      if watched_windows.contains(window) {
        return Some(format!("12-byte window {}", hex_of(window)));
      }
    }
  }
  None
}

fn hex_decoded(text: &[u8]) -> Option<Vec<u8>> {
  text.chunks_exact(2).map(|pair| std::str::from_utf8(pair).ok().and_then(|pair| u8::from_str_radix(pair, 16).ok())).collect()
}

fn percent_decoded(text: &[u8]) -> Vec<u8> {
  let mut decoded = Vec::with_capacity(text.len());
  let mut index = 0;
  while index < text.len() {
    let encoded_byte = (text[index] == b'%').then(|| text.get(index + 1..index + 3).and_then(hex_decoded).and_then(|pair| pair.first().copied())).flatten();
    if let Some(byte) = encoded_byte {
      decoded.push(byte);
      index += 3;
      continue;
    }
    decoded.push(text[index]);
    index += 1;
  }
  decoded
}

fn base64_decoded(token: &[u8]) -> Vec<u8> {
  let value_of = |byte: u8| match byte {
    b'-' | b'+' => Some(62u32),
    b'_' | b'/' => Some(63u32),
    other => BASE64_STANDARD.as_bytes().iter().position(|candidate| *candidate == other).map(|index| index as u32),
  };
  let sextets: Vec<u32> = token.iter().filter_map(|byte| value_of(*byte)).collect();
  sextets.chunks(4).flat_map(|group| {
    let packed = group.iter().enumerate().fold(0u32, |total, (index, sextet)| total | (sextet << (18 - 6 * index as u32)));
    (0..group.len().saturating_sub(1)).map(move |index| (packed >> (16 - 8 * index as u32)) as u8)
  }).collect()
}

fn decoded_views_of(line: &str) -> Vec<Vec<u8>> {
  let raw = line.as_bytes();
  let percent_once = percent_decoded(raw);
  let percent_twice = percent_decoded(&percent_once);
  let mut views = vec![raw.to_vec(), percent_once, percent_twice];
  let unicode_view = serde_json::from_str::<String>(&format!("\"{}\"", line.replace('"', "\\\""))).ok();
  if let Some(decoded) = unicode_view { views.push(decoded.into_bytes()); }
  for token in line.split([' ', '=', '[', ']', ':']) {
    let bytes = token.as_bytes();
    for alignment in 0..4.min(bytes.len() + 1) {
      views.push(base64_decoded(&bytes[alignment..]));
    }
    views.extend(hex_decoded(bytes));
  }
  let folded: Vec<Vec<u8>> = views.iter().map(|view| view.to_ascii_lowercase()).collect();
  views.extend(folded);
  views
}

/// Panics, naming every scenario that leaks, when a stored line contains the secret or a decoded form of it.
fn assert_allowlist_property(sink: &dyn Sink, scenarios: impl IntoIterator<Item = Scenario>) {
  let mut scenarios = scenarios.into_iter();
  loop {
    let batch: Vec<Scenario> = scenarios.by_ref().take(SCENARIOS_PER_WRITER).collect();
    if batch.is_empty() { return; }
    let deliveries: Vec<&Delivery> = batch.iter().map(|scenario| &scenario.delivery).collect();
    let emitted = sink.emitted_batch(&deliveries);
    assert_eq!(emitted.len(), batch.len(), "every scenario receives a result");
    for (scenario, lines) in batch.iter().zip(emitted) {
      assert_eq!(lines.len(), record_count_of(&scenario.delivery) + sink.flush_marker_count(), "{}: record count", scenario.name);
      assert_stored_lines(&scenario.name, &scenario.secret, scenario.typed_id_projection.as_deref(), &lines);
    }
  }
}

fn assert_stored_lines(name: &str, secret: &str, typed_id_projection: Option<&str>, lines: &[String]) {
  for line in lines {
    let event_name = line.split(' ').nth(2).unwrap_or_default();
    let event = EventName::ALL.into_iter().find(|event| event.as_str() == event_name).expect("a known event");
    assert_eq!(validate(event, line), Ok(()), "{name}: {line}");
  }
  let lines_without_the_typed_id: Vec<String> = match typed_id_projection {
    Some(token) => lines.iter().map(|line| line.replacen(token, "", 1)).collect(),
    None => lines.to_vec(),
  };
  let leak = leaked_form_in(&lines_without_the_typed_id, secret);
  assert_eq!(leak, None, "{name} leaks into {lines:?}");
}

#[derive(Default)]
struct WriterCpuSamples {
  first_append: Option<Duration>,
  last_append: Duration,
  records: usize,
}

#[derive(Clone, Default)]
struct CpuTimedFs(Arc<Mutex<WriterCpuSamples>>);

fn current_thread_cpu_time() -> Duration {
  let mut clock = libc::timespec { tv_sec: 0, tv_nsec: 0 };
  let status = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut clock) };
  assert_eq!(status, 0);
  Duration::new(clock.tv_sec as u64, clock.tv_nsec as u32)
}

impl crate::log_file::LogFs for CpuTimedFs {
  fn size(&self, _: &Path) -> io::Result<u64> { Ok(0) }
  fn rename(&self, _: &Path, _: &Path) -> io::Result<()> { Ok(()) }
  fn append(&self, _: &Path, _: &[u8]) -> io::Result<()> {
    let now = current_thread_cpu_time();
    let mut samples = self.0.lock().unwrap();
    samples.first_append.get_or_insert(now);
    samples.last_append = now;
    samples.records += 1;
    Ok(())
  }
}

struct CpuWorkload<'a> {
  chunk: &'a [u8],
  repetitions: usize,
  expected_records: usize,
}

fn writer_cpu_time_of(workload: CpuWorkload<'_>) -> Duration {
  let fs = CpuTimedFs::default();
  let rotating = RotatingLog::open(fs.clone(), PathBuf::from("/memory/desktop.log"), MAX_LOG_BYTES, KEPT_FILES);
  let queue_capacity = workload.repetitions + 2;
  let log = DesktopLog::start_with_capacity(rotating, Some(Salt::from_bytes([7; SALT_LEN])), || 0, queue_capacity);
  log.record_event(DesktopEvent::DaemonReused);
  for _ in 0..workload.repetitions {
    log.ingest_daemon_chunk(Stream::Out, workload.chunk);
  }
  assert!(log.flush_and_close(WRITER_CLOSE_TIMEOUT));
  let samples = fs.0.lock().unwrap();
  let records_including_cpu_markers = workload.expected_records * workload.repetitions + 2;
  assert_eq!(samples.records, records_including_cpu_markers);
  samples.last_append - samples.first_append.unwrap()
}

#[derive(Clone, Copy, Debug)]
enum HostileWorkload {
  DeepArrays,
  QuoteFlood,
  UnicodeEscapes,
  ManyKeys,
}

impl HostileWorkload {
  const ALL: [Self; 4] = [Self::DeepArrays, Self::QuoteFlood, Self::UnicodeEscapes, Self::ManyKeys];

  fn chunk_of(self, byte_budget: usize) -> Vec<u8> {
    let text = match self {
      Self::DeepArrays => format!("{{\"nested\":{}0{}}}", "[".repeat(byte_budget / 2), "]".repeat(byte_budget / 2)),
      Self::QuoteFlood => "\"".repeat(byte_budget),
      Self::UnicodeEscapes => format!("{{\"msg\":\"{}\"}}", "\\u0000".repeat(byte_budget / 6)),
      Self::ManyKeys => {
        let pairs: Vec<String> = (0..byte_budget / 20).map(|index| format!("\"key{index:010}\":0")).collect();
        format!("{{{}}}", pairs.join(","))
      }
    };
    format!("{text}\n").into_bytes()
  }
}

fn require_cpu_budget(measured: Duration, ceiling: Duration) {
  assert!(measured < ceiling, "writer CPU time {measured:?} exceeds {ceiling:?}");
}

fn require_linear_writer_cpu(measure: impl FnMut(usize) -> Duration, budget: &crate::linear_growth::LinearGrowthBudget) {
  crate::linear_growth::assert_linear_growth(measure, budget);
}

#[cfg(test)]
mod tests {
  use super::*;

  mod the_corpus {
    use super::*;

    #[test]
    fn holds_the_twenty_nine_provider_credentials() {
      assert_eq!(the_twenty_nine_provider_credentials().len(), 29);
    }

    #[test]
    fn holds_two_thousand_seeded_random_tokens_that_are_the_same_on_every_run() {
      let first_run: Vec<String> = random_token_shapes().into_iter().map(|item| item.secret).collect();
      let second_run: Vec<String> = random_token_shapes().into_iter().map(|item| item.secret).collect();

      assert_eq!(first_run.len(), RANDOM_ITEM_COUNT);
      assert_eq!(first_run, second_run);
    }

    #[test]
    fn places_each_boundary_secret_byte_on_its_anchor_offset() {
      let item = boundary_straddling_items().into_iter().find(|item| item.name.contains("last byte at 16384 behind 😀")).expect("a last-byte item");

      let offset_of_last_secret_byte = item.text.len() - 1;

      assert_eq!(offset_of_last_secret_byte, 16_384);
    }

    #[test]
    fn lists_every_free_text_kind_once_in_all() {
      for kind in FreeTextKind::ALL {
        assert_eq!(FreeTextKind::ALL[kind.position_in_all()], kind);
      }
    }
  }

  mod the_forbidden_forms {
    use super::*;

    #[test]
    fn include_the_base64_middle_at_every_alignment() {
      let forms = forbidden_forms_of("SyntheticSecretValue0123");

      let standard_encoding = base64_of(b"SyntheticSecretValue0123", BASE64_STANDARD).to_lowercase();
      assert!(forms.iter().any(|form| standard_encoding.contains(form.as_str()) && form.len() > 16), "{forms:?}");
    }

    #[test]
    fn encode_base64_like_the_rfc() {
      assert_eq!(base64_of(b"foobar", BASE64_STANDARD), "Zm9vYmFy");
      assert_eq!(base64_of(b"fo", BASE64_STANDARD), "Zm8");
    }

    #[test]
    fn include_hex_percent_double_percent_and_json_unicode() {
      let forms = forbidden_forms_of("Secret-0123456");

      for expected in ["5365637265742d30313233343536", "%53%65%63", "%2553%2565", "\\u0053\\u0065"] {
        assert!(forms.iter().any(|form| form.contains(&expected.to_lowercase())), "{expected} missing");
      }
    }

    #[test]
    fn cover_every_twelve_byte_window() {
      let forms = forbidden_forms_of("ABCDEFGHIJKLMNOP");

      assert!(forms.contains(&"abcdefghijkl".to_string()) && forms.contains(&"efghijklmnop".to_string()));
    }

    #[test]
    fn drop_the_raw_form_when_it_is_shorter_than_the_detectable_minimum() {
      assert!(!forbidden_forms_of("abc").contains(&"abc".to_string()));
    }
  }

  mod the_property {
    use super::*;

    #[test]
    fn detects_encoded_twelve_byte_tails_at_every_alignment() {
      let secret = "SyntheticSecretValue0123";
      let tail = &secret[secret.len() - WINDOW_BYTES..];
      let mut encodings = vec![hex_of(tail.as_bytes()), percent_encoded(tail, true), json_unicode_escaped(tail)];
      encodings.push(percent_encoded(&percent_encoded(tail, false), true));
      for alphabet in [BASE64_STANDARD, BASE64_URL] {
        for prefix_bytes in 0..3 {
          encodings.push(base64_of(format!("{}{tail}", "x".repeat(prefix_bytes)).as_bytes(), alphabet));
        }
      }
      for encoding in encodings {
        assert!(leaked_form_in(&[format!("text={encoding}")], secret).is_some(), "missed {encoding}");
      }
    }

    #[test]
    fn detects_windows_of_twelve_bytes_inside_multibyte_secrets() {
      let secret = "日😀éSyntheticTail";
      let window = std::str::from_utf8(&secret.as_bytes()[..WINDOW_BYTES]).unwrap();
      assert!(leaked_form_in(&[window.to_string()], secret).is_some());
    }

    #[test]
    #[should_panic(expected = "record count")]
    fn rejects_a_sink_that_silently_drops_a_record() {
      struct EmptySink;
      impl Sink for EmptySink {
        fn emitted_lines(&self, _: &Delivery) -> Vec<String> { Vec::new() }
      }
      let item = HostileItem::bare("dropped", "SyntheticSecretValue0123".to_string());
      assert_allowlist_property(&EmptySink, [scenario_of(&item, FreeTextKind::SidecarReason, Placement::SoleValue)]);
    }

    #[test]
    #[should_panic(expected = "ForbiddenByte")]
    fn rejects_a_stored_line_outside_the_grammar() {
      struct UngrammaticalSink;
      impl Sink for UngrammaticalSink {
        fn emitted_lines(&self, _: &Delivery) -> Vec<String> { vec![format!("{NOW} info daemon_text stream=out class=other text=%")] }
      }
      let item = HostileItem::bare("grammar", "SyntheticSecretValue0123".to_string());
      assert_allowlist_property(&UngrammaticalSink, [scenario_of(&item, FreeTextKind::SidecarReason, Placement::SoleValue)]);
    }

    #[test]
    fn detects_a_secret_copied_into_a_line() {
      let secret = "SyntheticSecretValue0123";

      let leak = leaked_form_in(&[format!("xx {} yy", secret.to_uppercase())], secret);

      assert!(leak.is_some());
    }

    #[test]
    fn detects_a_base64_encoded_secret_in_a_line() {
      let secret = "SyntheticSecretValue0123";
      let encoded = base64_of(secret.as_bytes(), BASE64_STANDARD);

      let leak = leaked_form_in(&[format!("msg={encoded}")], secret);

      assert!(leak.is_some());
    }

    #[test]
    fn passes_a_line_that_only_holds_the_length_and_tag() {
      let lines = vec!["2026-10-04T12:00:00Z info daemon_line msg=[text:24:0a1b2c3d] extra_fields=0".to_string()];

      assert_eq!(leaked_form_in(&lines, "SyntheticSecretValue0123"), None);
    }
  }

  mod the_typed_id_exception {
    use super::*;

    struct FixedLinesSink(Vec<String>);

    impl Sink for FixedLinesSink {
      fn emitted_lines(&self, _: &Delivery) -> Vec<String> { self.0.clone() }
    }

    fn random_uuid() -> HostileItem {
      random_token_shapes().into_iter().find(|item| item.name.starts_with("random uuid")).expect("a random uuid item")
    }

    fn line_with(fields: &str) -> String {
      format!("1970-01-01T00:00:00Z info daemon_line {fields} extra_fields=0")
    }

    #[test]
    fn stores_a_uuid_in_the_session_field_as_the_typed_id_and_nothing_else() {
      let uuid = random_uuid();
      let scenario = scenario_of(&uuid, FreeTextKind::SessionId, Placement::SoleValue);

      let lines = WriterSink::with_salt().emitted_lines(&scenario.delivery);

      assert_eq!(lines[0], format!("1970-01-01T00:00:00Z info daemon_line session={} msg=ws_write_failed extra_fields=0", uuid.secret));
      assert_eq!(scenario.typed_id_projection, Some(format!("session={}", uuid.secret)));
    }

    #[test]
    fn accepts_the_typed_id_in_the_session_field_for_the_writer() {
      let scenario = scenario_of(&random_uuid(), FreeTextKind::SessionId, Placement::SoleValue);

      assert_allowlist_property(&WriterSink::with_salt(), [scenario]);
    }

    #[test]
    fn covers_no_other_kind() {
      let uuid = random_uuid();

      let kinds_with_an_exception: Vec<FreeTextKind> = FreeTextKind::ALL
        .into_iter()
        .filter(|kind| Placement::ALL.into_iter().any(|placement| scenario_of(&uuid, *kind, placement).typed_id_projection.is_some()))
        .collect();

      assert_eq!(kinds_with_an_exception, vec![FreeTextKind::SessionId]);
    }

    #[test]
    fn covers_no_other_placement_of_the_session_field() {
      let uuid = random_uuid();

      let placements_with_an_exception: Vec<Placement> = Placement::ALL
        .into_iter()
        .filter(|placement| scenario_of(&uuid, FreeTextKind::SessionId, *placement).typed_id_projection.is_some())
        .collect();

      assert_eq!(placements_with_an_exception, vec![Placement::SoleValue, Placement::SplitAcrossTwoChunks, Placement::AfterCrlf]);
    }

    #[test]
    fn covers_a_short_id_only_in_the_id_field() {
      let eight_hex = HostileItem::bare("eight hex", "0a1b2c3d".to_string());

      assert_eq!(scenario_of(&eight_hex, FreeTextKind::Id, Placement::SoleValue).typed_id_projection, Some("id=0a1b2c3d".to_string()));
      assert_eq!(scenario_of(&eight_hex, FreeTextKind::SessionId, Placement::SoleValue).typed_id_projection, None);
    }

    #[test]
    #[should_panic(expected = "leaks into")]
    fn turns_red_when_the_uuid_is_also_copied_into_another_field() {
      let uuid = random_uuid();
      let scenario = scenario_of(&uuid, FreeTextKind::SessionId, Placement::SoleValue);
      let sink = FixedLinesSink(vec![line_with(&format!("session={0} msg={0}", uuid.secret))]);

      assert_allowlist_property(&sink, [scenario]);
    }

    #[test]
    #[should_panic(expected = "leaks into")]
    fn turns_red_when_the_exception_is_widened_to_the_message_kind() {
      let uuid = random_uuid();
      let scenario = scenario_of(&uuid, FreeTextKind::DaemonMsg, Placement::SoleValue);
      let sink = FixedLinesSink(vec![line_with(&format!("session={}", uuid.secret))]);

      assert_allowlist_property(&sink, [scenario]);
    }

    #[test]
    #[should_panic(expected = "leaks into")]
    fn turns_red_when_the_exception_is_widened_to_the_id_kind() {
      let uuid = random_uuid();
      let scenario = scenario_of(&uuid, FreeTextKind::Id, Placement::SoleValue);
      let sink = FixedLinesSink(vec![line_with(&format!("id={}", uuid.secret))]);

      assert_allowlist_property(&sink, [scenario]);
    }

    #[test]
    #[should_panic(expected = "leaks into")]
    fn turns_red_when_the_uuid_is_copied_from_a_prefixed_session_field() {
      let uuid = random_uuid();
      let scenario = scenario_of(&uuid, FreeTextKind::SessionId, Placement::Prefix);
      let sink = FixedLinesSink(vec![line_with(&format!("session={}", uuid.secret))]);

      assert_allowlist_property(&sink, [scenario]);
    }
  }

  mod the_projection_sink {
    use super::*;

    #[test]
    fn keeps_every_provider_credential_out_of_every_kind_and_placement() {
      assert_allowlist_property(&ProjectionSink::with_salt(), provider_credentials_scenarios());
    }

    #[test]
    fn keeps_every_credential_scheme_out_of_every_kind_and_placement() {
      assert_allowlist_property(&ProjectionSink::with_salt(), credential_schemes_scenarios());
    }

    #[test]
    fn keeps_every_codex_vector_out_of_every_kind_and_placement() {
      assert_allowlist_property(&ProjectionSink::with_salt(), codex_vectors_scenarios());
    }

    #[test]
    fn keeps_boundary_straddling_secrets_out() {
      assert_allowlist_property(&ProjectionSink::with_salt(), boundary_scenarios());
    }

    #[test]
    fn keeps_random_token_shapes_out() {
      assert_allowlist_property(&ProjectionSink::with_salt(), random_token_scenarios());
    }

    #[test]
    fn keeps_secrets_out_of_a_five_mib_line() {
      assert_allowlist_property(&ProjectionSink::with_salt(), five_mib_line_scenarios());
    }

    #[test]
    fn keeps_the_corpus_out_when_the_install_has_no_salt() {
      assert_allowlist_property(&ProjectionSink::without_salt(), provider_credentials_scenarios());
      assert_allowlist_property(&ProjectionSink::without_salt(), codex_vectors_scenarios());
    }

    #[test]
    fn emits_the_same_lines_for_the_same_input_and_salt() {
      for scenario in codex_vectors_scenarios() {
        let first = ProjectionSink::with_salt().emitted_lines(&scenario.delivery);
        let second = ProjectionSink::with_salt().emitted_lines(&scenario.delivery);
        assert_eq!(first, second, "{}", scenario.name);
      }
    }

    #[test]
    fn emits_one_line_per_record_and_drops_none_silently() {
      let record = |number: usize| format!("{{\"level\":\"info\",\"msg\":\"ws: write failed\",\"step\":{number}}}\n");
      let chunks: Vec<Vec<u8>> = (0..25).map(|number| record(number).into_bytes()).collect();

      let lines = ProjectionSink::with_salt().emitted_lines(&Delivery::DaemonPipe { stream: Stream::Out, chunks });

      assert_eq!(lines.len(), 25);
    }

    #[test]
    fn counts_a_secret_split_across_two_chunks_as_two_text_records() {
      let secret = "ghp_aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3";
      let (head, tail) = secret.split_at(secret.len() / 2);
      let chunks = vec![format!("note {head}").into_bytes(), format!("{tail}\n").into_bytes()];

      let lines = ProjectionSink::with_salt().emitted_lines(&Delivery::DaemonPipe { stream: Stream::Err, chunks });

      assert_eq!(lines.len(), 1);
      assert_eq!(leaked_form_in(&lines, secret), None);
    }
  }

  mod the_writer_sink {
    use super::*;

    #[test]
    fn keeps_every_provider_credential_out_of_every_kind_and_placement() {
      assert_allowlist_property(&WriterSink::with_salt(), provider_credentials_scenarios());
    }

    #[test]
    fn keeps_every_credential_scheme_out_of_every_kind_and_placement() {
      assert_allowlist_property(&WriterSink::with_salt(), credential_schemes_scenarios());
    }

    #[test]
    fn keeps_every_codex_vector_out_of_every_kind_and_placement() {
      assert_allowlist_property(&WriterSink::with_salt(), codex_vectors_scenarios());
    }

    #[test]
    fn keeps_boundary_straddling_secrets_out() {
      assert_allowlist_property(&WriterSink::with_salt(), boundary_scenarios());
      assert_allowlist_property(&WriterSink::with_salt(), exact_boundary_scenarios());
    }

    #[test]
    fn keeps_random_token_shapes_out() {
      assert_allowlist_property(&WriterSink::with_salt(), random_token_scenarios());
    }

    #[test]
    fn keeps_secrets_out_of_a_five_mib_line() {
      assert_allowlist_property(&WriterSink::with_salt(), five_mib_line_scenarios());
      assert_corpus_in_giant_lines(&WriterSink::with_salt());
    }

    #[test]
    fn keeps_the_corpus_out_when_the_install_has_no_salt() {
      assert_allowlist_property(&WriterSink::without_salt(), every_kind_and_placement(all_hostile_items()).chain(exact_boundary_scenarios()));
      assert_corpus_in_giant_lines(&WriterSink::without_salt());
    }

    fn event_named(line: &str) -> EventName {
      let name = line.split(' ').nth(2).unwrap_or("");
      EventName::ALL.into_iter().find(|event| event.as_str() == name).unwrap_or_else(|| panic!("a stored line names no known event: {line}"))
    }

    #[test]
    fn stores_only_lines_that_pass_the_grammar() {
      for scenario in codex_vectors_scenarios().chain(credential_schemes_scenarios()) {
        for line in WriterSink::with_salt().emitted_lines(&scenario.delivery) {
          assert_eq!(validate(event_named(&line), &line), Ok(()), "{}: {line}", scenario.name);
        }
      }
    }

    #[test]
    fn stores_one_line_per_record_then_the_flushed_marker() {
      let record = |number: usize| format!("{{\"level\":\"info\",\"msg\":\"ws: write failed\",\"step\":{number}}}\n");
      let chunks: Vec<Vec<u8>> = (0..25).map(|number| record(number).into_bytes()).collect();

      let lines = WriterSink::with_salt().emitted_lines(&Delivery::DaemonPipe { stream: Stream::Out, chunks });

      assert_eq!(lines.len(), 26);
      assert!(lines[25].ends_with("info daemon_log_flushed drained=true"), "{}", lines[25]);
    }

    #[test]
    fn stores_the_same_lines_for_the_same_input_and_salt() {
      for scenario in codex_vectors_scenarios() {
        let first = WriterSink::with_salt().emitted_lines(&scenario.delivery);
        let second = WriterSink::with_salt().emitted_lines(&scenario.delivery);
        assert_eq!(first, second, "{}", scenario.name);
      }
    }

    #[test]
    fn stores_a_secret_split_across_two_chunks_as_one_text_record() {
      let secret = "ghp_aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3aB3";
      let (head, tail) = secret.split_at(secret.len() / 2);
      let chunks = vec![format!("note {head}").into_bytes(), format!("{tail}\n").into_bytes()];

      let lines = WriterSink::with_salt().emitted_lines(&Delivery::DaemonPipe { stream: Stream::Err, chunks });

      assert_eq!(lines.len(), 2);
      assert!(lines[0].contains(" daemon_text stream=err "), "{}", lines[0]);
      assert_eq!(leaked_form_in(&lines, secret), None);
    }
  }

  mod writer_cpu_cost {
    use super::*;
    use crate::linear_growth::LinearGrowthBudget;

    const SMALL_INPUT_BYTES: usize = 16 * 1024;
    const LARGE_INPUT_BYTES: usize = 64 * 1024;
    const ONE_MIB: usize = 1024 * 1024;
    const REPETITIONS_TO_CLEAR_THE_NOISE_FLOOR: usize = 32;
    const CPU_CEILING: Duration = Duration::from_secs(20);

    #[test]
    fn hostile_ingestion_grows_linearly_on_the_writer_thread() {
      for workload in HostileWorkload::ALL {
        let measure = |size| {
          let chunk = workload.chunk_of(size);
          writer_cpu_time_of(CpuWorkload { chunk: &chunk, repetitions: REPETITIONS_TO_CLEAR_THE_NOISE_FLOOR, expected_records: 1 })
        };
        require_linear_writer_cpu(measure, &LinearGrowthBudget::between(SMALL_INPUT_BYTES, LARGE_INPUT_BYTES));
      }
    }

    #[test]
    fn one_mib_and_five_mib_hostile_lines_stay_within_the_cpu_ceiling() {
      for size in [ONE_MIB, FIVE_MIB] {
        for workload in HostileWorkload::ALL {
          let chunk = workload.chunk_of(size);
          let measured = writer_cpu_time_of(CpuWorkload { chunk: &chunk, repetitions: 1, expected_records: 1 });
          require_cpu_budget(measured, CPU_CEILING);
        }
      }
    }

    #[test]
    fn one_hundred_thousand_tiny_records_grow_linearly() {
      let measure = |records| {
        let chunk = b"{\"msg\":\"ws: write failed\"}\n".repeat(records);
        writer_cpu_time_of(CpuWorkload { chunk: &chunk, repetitions: 1, expected_records: records })
      };
      require_linear_writer_cpu(measure, &LinearGrowthBudget::between(25_000, 100_000));
    }

    #[test]
    #[should_panic(expected = "writer CPU time")]
    fn rejects_a_cpu_time_above_the_ceiling() {
      require_cpu_budget(Duration::from_secs(21), CPU_CEILING);
    }

    #[test]
    #[should_panic(expected = "growth is not linear")]
    fn rejects_quadratic_cpu_growth() {
      let measure = |size: usize| Duration::from_micros((size * size / 10) as u64);
      require_linear_writer_cpu(measure, &LinearGrowthBudget::between(1_000, 4_000));
    }
  }
}
