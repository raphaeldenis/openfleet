//! Acceptance skeleton of the allowlist: no byte sequence of the hostile corpus, nor any decoded form of it, may appear in a line the log emits.
//!
//! Two sinks run the same property:
//! - `ProjectionSink` (the fake sink) is the allowlist path as built today: line assembler, projection, render, grammar. Its tests are green.
//! - `LegacySink` is the production path still wired today: `DaemonLog::record` and the pattern masker. Its tests are red,
//!   declared through `red_until_ra04!` (one ignore reason) and listed in `RED_UNTIL_RA04`; the cutover un-ignores every one of them.

use super::salt::SALT_LEN;
use super::{validate, DaemonLineAssembler, DesktopEvent, EventName, IoFailure, KnownPaths, Opaque, PathClass, Salt, SpawnFailure, Stream, Ts};
use crate::log_file::{DaemonLog, RotatingLog, Stream as LegacyStream, KEPT_FILES, MAX_LOG_BYTES};
use serde_json::{json, Value};
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

/// Every case the legacy sink is expected to fail until the writer cutover; `red_until_ra04!` invocations must match this list one for one.
const RED_UNTIL_RA04: [&str; 6] = [
  "legacy_sink_keeps_provider_credentials_out_of_every_kind",
  "legacy_sink_keeps_credential_schemes_out_of_every_kind",
  "legacy_sink_keeps_codex_vectors_out_of_every_kind",
  "legacy_sink_keeps_boundary_straddling_secrets_out",
  "legacy_sink_keeps_random_token_shapes_out",
  "legacy_sink_keeps_secrets_out_of_a_five_mib_line",
];

macro_rules! red_until_ra04 {
  ($name:ident, $scenarios:expr) => {
    #[test]
    #[ignore = "red until RA-04: the legacy DaemonLog masks by pattern and copies the rest, so this corpus leaks until the allowlist writer replaces it"]
    fn $name() {
      assert_allowlist_property(&LegacySink, &$scenarios);
    }
  };
}

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
  EscapedJson,
  SplitAcrossTwoChunks,
  AfterCrlf,
}

impl Placement {
  const ALL: [Placement; 7] = [
    Placement::SoleValue,
    Placement::Prefix,
    Placement::Middle,
    Placement::Suffix,
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
      Placement::EscapedJson => Value::String(hostile_text.to_string()).to_string(),
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
}

fn scenario_of(item: &HostileItem, kind: FreeTextKind, placement: Placement) -> Scenario {
  let text = placement.text_around(&item.text);
  let delivery = kind.delivery_of(&text).shaped_by(placement);
  Scenario { name: format!("{} | {kind:?} | {placement:?}", item.name), delivery, secret: item.secret.clone() }
}

fn every_kind_and_placement(items: &[HostileItem]) -> Vec<Scenario> {
  items
    .iter()
    .flat_map(|item| FreeTextKind::ALL.into_iter().flat_map(move |kind| Placement::ALL.into_iter().map(move |placement| scenario_of(item, kind, placement))))
    .collect()
}

fn kinds_and_middle_placement(items: &[HostileItem], kinds: &[FreeTextKind]) -> Vec<Scenario> {
  items.iter().flat_map(|item| kinds.iter().map(move |kind| scenario_of(item, *kind, Placement::Middle))).collect()
}

fn provider_credentials_scenarios() -> Vec<Scenario> {
  every_kind_and_placement(&the_twenty_nine_provider_credentials())
}

fn credential_schemes_scenarios() -> Vec<Scenario> {
  every_kind_and_placement(&credential_schemes())
}

fn codex_vectors_scenarios() -> Vec<Scenario> {
  every_kind_and_placement(&codex_vectors())
}

const KINDS_CARRYING_FREE_TEXT_ON_A_PIPE: [FreeTextKind; 3] = [FreeTextKind::DaemonMsg, FreeTextKind::StdoutNonJson, FreeTextKind::ErrMessage];

fn boundary_scenarios() -> Vec<Scenario> {
  kinds_and_middle_placement(&boundary_straddling_items(), &[FreeTextKind::DaemonMsg, FreeTextKind::StdoutNonJson])
}

fn random_token_scenarios() -> Vec<Scenario> {
  kinds_and_middle_placement(&random_token_shapes(), &KINDS_CARRYING_FREE_TEXT_ON_A_PIPE)
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
  let characters: Vec<char> = secret.chars().collect();
  let window_chars = WINDOW_BYTES;
  if characters.len() < window_chars {
    return Vec::new();
  }
  characters.windows(window_chars).map(|window| window.iter().collect()).collect()
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
}

fn fixed_now() -> Ts {
  Ts::parse(NOW).expect("a valid timestamp")
}

/// The fake sink: the allowlist path as it exists before the writer cutover.
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

  fn event_of_notice(&self, kind: FreeTextKind, text: &str) -> DesktopEvent {
    let opaque = Opaque::of(text.as_bytes(), self.salt.as_ref());
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

  fn line_of(event: &DesktopEvent) -> String {
    let line = event.render(fixed_now());
    let rendered_event = if line.is_rejection() { EventName::RejectedRecord } else { event.name() };
    assert_eq!(validate(rendered_event, line.as_str()), Ok(()), "the sink emitted a line outside the grammar: {line}");
    line.to_string()
  }
}

impl Sink for ProjectionSink {
  fn emitted_lines(&self, delivery: &Delivery) -> Vec<String> {
    match delivery {
      Delivery::DesktopNotice { kind, text } => vec![Self::line_of(&self.event_of_notice(*kind, text))],
      Delivery::DaemonPipe { stream, chunks } => {
        let mut assembler = DaemonLineAssembler::new(*stream);
        let mut events: Vec<DesktopEvent> = chunks.iter().flat_map(|chunk| assembler.push_chunk(chunk, self.salt.as_ref())).collect();
        events.extend(assembler.flush(self.salt.as_ref()));
        events.iter().map(Self::line_of).collect()
      }
    }
  }
}

/// The production path wired today: every chunk goes to `DaemonLog::record`, and the stored file is read back.
struct LegacySink;

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

impl Sink for LegacySink {
  fn emitted_lines(&self, delivery: &Delivery) -> Vec<String> {
    let fs = MemoryFs::default();
    let log = RotatingLog::open(fs.clone(), PathBuf::from("/logs/daemon.log"), MAX_LOG_BYTES, KEPT_FILES);
    let daemon_log = DaemonLog::start(log, || None, || 0);
    match delivery {
      Delivery::DaemonPipe { stream, chunks } => {
        let legacy_stream = match stream {
          Stream::Out => LegacyStream::Out,
          Stream::Err => LegacyStream::Err,
        };
        chunks.iter().for_each(|chunk| daemon_log.record(legacy_stream, &String::from_utf8_lossy(chunk)));
      }
      Delivery::DesktopNotice { kind, text } => {
        let notice = match kind {
          FreeTextKind::SpawnFailurePath => format!("daemon bundle not found at {text}"),
          _ => text.clone(),
        };
        daemon_log.record(LegacyStream::Err, &notice);
      }
    }
    assert!(daemon_log.flush_and_close(WRITER_CLOSE_TIMEOUT), "the legacy writer did not drain");
    let stored = fs.0.lock().unwrap().clone();
    String::from_utf8_lossy(&stored).lines().map(str::to_string).collect()
  }
}

// ---- the property ----

fn leaked_form_in(lines: &[String], secret: &str) -> Option<String> {
  let folded_lines: Vec<String> = lines.iter().map(|line| line.to_lowercase()).collect();
  forbidden_forms_of(secret).into_iter().find(|form| folded_lines.iter().any(|line| line.contains(form.as_str())))
}

/// Panics, naming every scenario that leaks, when a stored line contains the secret or a decoded form of it.
fn assert_allowlist_property(sink: &dyn Sink, scenarios: &[Scenario]) {
  let leaking: Vec<String> = scenarios
    .iter()
    .filter_map(|scenario| {
      let lines = sink.emitted_lines(&scenario.delivery);
      leaked_form_in(&lines, &scenario.secret).map(|form| format!("{} leaks `{}`", scenario.name, form.chars().take(40).collect::<String>()))
    })
    .collect();
  assert_eq!(leaking.len(), 0, "{} of {} scenarios leak:\n{}", leaking.len(), scenarios.len(), leaking.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
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
    fn cover_every_twelve_character_window() {
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

  mod the_projection_sink {
    use super::*;

    #[test]
    fn keeps_every_provider_credential_out_of_every_kind_and_placement() {
      assert_allowlist_property(&ProjectionSink::with_salt(), &provider_credentials_scenarios());
    }

    #[test]
    fn keeps_every_credential_scheme_out_of_every_kind_and_placement() {
      assert_allowlist_property(&ProjectionSink::with_salt(), &credential_schemes_scenarios());
    }

    #[test]
    fn keeps_every_codex_vector_out_of_every_kind_and_placement() {
      assert_allowlist_property(&ProjectionSink::with_salt(), &codex_vectors_scenarios());
    }

    #[test]
    fn keeps_boundary_straddling_secrets_out() {
      assert_allowlist_property(&ProjectionSink::with_salt(), &boundary_scenarios());
    }

    #[test]
    fn keeps_random_token_shapes_out() {
      assert_allowlist_property(&ProjectionSink::with_salt(), &random_token_scenarios());
    }

    #[test]
    fn keeps_secrets_out_of_a_five_mib_line() {
      assert_allowlist_property(&ProjectionSink::with_salt(), &five_mib_line_scenarios());
    }

    #[test]
    fn keeps_the_corpus_out_when_the_install_has_no_salt() {
      assert_allowlist_property(&ProjectionSink::without_salt(), &provider_credentials_scenarios());
      assert_allowlist_property(&ProjectionSink::without_salt(), &codex_vectors_scenarios());
    }

    #[test]
    fn emits_the_same_lines_for_the_same_input_and_salt() {
      let scenarios = codex_vectors_scenarios();

      let first_run: Vec<Vec<String>> = scenarios.iter().map(|scenario| ProjectionSink::with_salt().emitted_lines(&scenario.delivery)).collect();
      let second_run: Vec<Vec<String>> = scenarios.iter().map(|scenario| ProjectionSink::with_salt().emitted_lines(&scenario.delivery)).collect();

      assert_eq!(first_run, second_run);
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

  mod the_red_cases {
    use super::*;

    red_until_ra04!(legacy_sink_keeps_provider_credentials_out_of_every_kind, provider_credentials_scenarios());
    red_until_ra04!(legacy_sink_keeps_credential_schemes_out_of_every_kind, credential_schemes_scenarios());
    red_until_ra04!(legacy_sink_keeps_codex_vectors_out_of_every_kind, codex_vectors_scenarios());
    red_until_ra04!(legacy_sink_keeps_boundary_straddling_secrets_out, boundary_scenarios());
    red_until_ra04!(legacy_sink_keeps_random_token_shapes_out, random_token_scenarios());
    red_until_ra04!(legacy_sink_keeps_secrets_out_of_a_five_mib_line, five_mib_line_scenarios());

    #[test]
    fn are_exactly_the_cases_named_in_the_red_list() {
      let source = include_str!("hostile_corpus.rs");
      let invocation = ["red_until_ra04", "!("].concat();
      let invocation_count = source.matches(invocation.as_str()).count();

      let unlisted: Vec<&str> = RED_UNTIL_RA04.into_iter().filter(|name| !source.contains(&format!("{invocation}{name},"))).collect();

      assert_eq!(unlisted, Vec::<&str>::new());
      assert_eq!(invocation_count, RED_UNTIL_RA04.len());
    }
  }
}
