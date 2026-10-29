use super::daemon_line::is_catalogue_id;
use super::event::{DaemonTextClass, ForeignTarget, ABSENT, OUTCOME_NOTHING_TO_STOP, SPAWN_CAUSE_BUNDLE_NOT_FOUND, SPAWN_CAUSE_IO, SPAWN_CAUSE_UNCLASSIFIED};
use super::field::{
  with_extra, DaemonPhase, EventName, IoKind, Level, PathClass, PathSource, SessionId, ShortId, StopOutcome, Stream, Ts, CODE_VALUES, ERROR_NAME_VALUES, MAX_FRAMES,
};
use std::fmt;

/// The longest line the writer accepts; the longest legitimate line (a full `daemon_line`) is about 400 bytes.
pub const MAX_LINE_BYTES: usize = 512;
/// The ceiling of every `FieldSpec::max_bytes`.
pub const MAX_VALUE_BYTES: usize = 64;
const NONE_VALUE: &[u8] = ABSENT.text().as_bytes();
const SEPARATOR: u8 = b' ';
const ASSIGNMENT: u8 = b'=';
const HEADER_TOKENS: usize = 3;

/// A finished log line: the only thing the writer accepts.
/// Its text is private and `seal` is its only constructor, so every line has passed the grammar; there is no `From<String>` and no `Default`.
///
/// ```
/// use app_lib::SanitizedLine;
/// fn read_line(line: &SanitizedLine) -> &str { line.as_str() }
/// ```
///
/// ```compile_fail,E0277
/// use app_lib::SanitizedLine;
/// let line: SanitizedLine = "raw secret".into();
/// ```
///
/// ```compile_fail,E0308
/// use app_lib::SanitizedLine;
/// fn append_line(line: &SanitizedLine) {}
/// append_line("raw secret");
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct SanitizedLine {
  text: String,
  is_rejection: bool,
}

impl SanitizedLine {
  pub fn as_str(&self) -> &str {
    &self.text
  }

  /// True when the line stands for a record that failed the grammar; the writer counts these.
  pub fn is_rejection(&self) -> bool {
    self.is_rejection
  }
}

impl fmt::Display for SanitizedLine {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(&self.text)
  }
}

/// Why a candidate line is not made of constructor output.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GrammarViolation {
  ForbiddenByte,
  MalformedHeader,
  EventNameMismatch,
  MalformedPair,
  KeyNotInTheEventFields,
  DuplicateKey,
  ValueTooLong,
  LineTooLong,
  ValueShapeMismatch,
}

fn is_allowed_byte(byte: u8) -> bool {
  let is_name_byte = byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-' | b'/' | b'[' | b']');
  is_name_byte || byte == ASSIGNMENT || byte == SEPARATOR
}

fn is_key(token: &[u8]) -> bool {
  !token.is_empty() && token.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// Checks `<ts> <level> <event> key=value ...` in one pass over the bytes plus one over the tokens.
/// It looks for no secret: it proves the line has the shape of constructor output.
pub fn validate(event: EventName, line: &str) -> Result<(), GrammarViolation> {
  let bytes = line.as_bytes();
  if bytes.len() > MAX_LINE_BYTES {
    return Err(GrammarViolation::LineTooLong);
  }
  if !bytes.iter().all(|byte| is_allowed_byte(*byte)) {
    return Err(GrammarViolation::ForbiddenByte);
  }

  let mut tokens = bytes.split(|byte| *byte == SEPARATOR);
  let header: Vec<&[u8]> = tokens.by_ref().take(HEADER_TOKENS).collect();
  let [timestamp, level, event_token] = header[..] else { return Err(GrammarViolation::MalformedHeader) };
  let has_timestamp = std::str::from_utf8(timestamp).ok().and_then(Ts::parse).is_some_and(|parsed| parsed.to_string().as_bytes() == timestamp);
  let has_level = std::str::from_utf8(level).ok().and_then(Level::parse).is_some();
  if !has_timestamp || !has_level {
    return Err(GrammarViolation::MalformedHeader);
  }
  if event_token != event.as_str().as_bytes() {
    return Err(GrammarViolation::EventNameMismatch);
  }

  let fields = fields_of(event);
  let mut seen_keys: Vec<&[u8]> = Vec::new();
  for pair in tokens {
    let Some(assignment_at) = pair.iter().position(|byte| *byte == ASSIGNMENT) else { return Err(GrammarViolation::MalformedPair) };
    let (key, value_with_assignment) = pair.split_at(assignment_at);
    let value = &value_with_assignment[1..];
    let is_well_formed = is_key(key) && !value.is_empty() && !value.contains(&ASSIGNMENT);
    if !is_well_formed {
      return Err(GrammarViolation::MalformedPair);
    }
    if value.len() > MAX_VALUE_BYTES {
      return Err(GrammarViolation::ValueTooLong);
    }
    let Some(field) = fields.iter().find(|field| field.key.as_bytes() == key) else { return Err(GrammarViolation::KeyNotInTheEventFields) };
    if seen_keys.contains(&key) {
      return Err(GrammarViolation::DuplicateKey);
    }
    if !field.kind.accepts(value) {
      return Err(GrammarViolation::ValueShapeMismatch);
    }
    if value.len() > usize::from(field.max_bytes) {
      return Err(GrammarViolation::ValueTooLong);
    }
    seen_keys.push(key);
  }
  Ok(())
}

/// What a value is allowed to look like under its key.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FieldKind {
  Decimal,
  SignedDecimal,
  SignedDecimalOrNone,
  Bool,
  Enum(&'static [&'static str]),
  Opaque,
  Ts,
  Hex8,
  Uuid,
  Frames,
  CatalogueOrOpaque,
}

impl FieldKind {
  /// True when `value` has the shape this kind renders; a linear scan, no secret lookup.
  pub fn accepts(self, value: &[u8]) -> bool {
    let text = std::str::from_utf8(value).unwrap_or("");
    match self {
      FieldKind::Decimal => is_decimal(value),
      FieldKind::SignedDecimal => is_signed_decimal(value),
      FieldKind::SignedDecimalOrNone => value == NONE_VALUE || is_signed_decimal(value),
      FieldKind::Bool => value == b"true" || value == b"false",
      FieldKind::Enum(names) => names.iter().any(|name| name.as_bytes() == value),
      FieldKind::Opaque => is_opaque(value),
      FieldKind::Ts => Ts::parse(text).is_some_and(|parsed| parsed.to_string() == text),
      FieldKind::Hex8 => ShortId::parse(text).is_some(),
      FieldKind::Uuid => SessionId::parse(text).is_some(),
      FieldKind::Frames => is_frames(value),
      FieldKind::CatalogueOrOpaque => is_opaque(value) || is_catalogue_id(text),
    }
  }
}

fn is_decimal(value: &[u8]) -> bool {
  let has_no_leading_zero = value.len() == 1 || value.first() != Some(&b'0');
  !value.is_empty() && has_no_leading_zero && value.iter().all(u8::is_ascii_digit)
}

fn is_signed_decimal(value: &[u8]) -> bool {
  is_decimal(value.strip_prefix(b"-").unwrap_or(value))
}

fn is_lowercase_hex(byte: &u8) -> bool {
  matches!(*byte, b'0'..=b'9' | b'a'..=b'f')
}

const MAX_OPAQUE_LENGTH_DIGITS: usize = 8;
const OPAQUE_TAG_BYTES: usize = 8;

/// `[text:<1 to 8 digits>]` or `[text:<1 to 8 digits>:<8 lowercase hex>]`.
fn is_opaque(value: &[u8]) -> bool {
  let Some(inner) = value.strip_prefix(b"[text:").and_then(|rest| rest.strip_suffix(b"]")) else { return false };
  let (length, tag) = match inner.iter().position(|byte| *byte == b':') {
    Some(colon_at) => (&inner[..colon_at], Some(&inner[colon_at + 1..])),
    None => (inner, None),
  };
  let has_length = (1..=MAX_OPAQUE_LENGTH_DIGITS).contains(&length.len()) && length.iter().all(u8::is_ascii_digit);
  let has_tag_or_none = tag.is_none_or(|tag| tag.len() == OPAQUE_TAG_BYTES && tag.iter().all(is_lowercase_hex));
  has_length && has_tag_or_none
}

/// `L:C` positions joined by `/`, at most 8.
fn is_frames(value: &[u8]) -> bool {
  let positions: Vec<&[u8]> = value.split(|byte| *byte == b'/').collect();
  let is_position = |position: &&[u8]| {
    let Some(colon_at) = position.iter().position(|byte| *byte == b':') else { return false };
    is_decimal(&position[..colon_at]) && is_decimal(&position[colon_at + 1..])
  };
  (1..=MAX_FRAMES).contains(&positions.len()) && positions.iter().all(is_position)
}

/// One key an event may carry, the shape of its value and the longest value in bytes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FieldSpec {
  pub key: &'static str,
  pub kind: FieldKind,
  pub max_bytes: u8,
}

macro_rules! field {
  ($key:literal, $kind:expr, $max_bytes:literal) => {
    FieldSpec { key: $key, kind: $kind, max_bytes: $max_bytes }
  };
}

const SPAWN_CAUSES: [&str; 3] = [SPAWN_CAUSE_BUNDLE_NOT_FOUND.text(), SPAWN_CAUSE_IO.text(), SPAWN_CAUSE_UNCLASSIFIED.text()];
const STOP_OUTCOME_VALUES: [&str; StopOutcome::NAMES.len() + 1] = with_extra(&StopOutcome::NAMES, OUTCOME_NOTHING_TO_STOP.text());

const DAEMON_SPAWN_FAILED_FIELDS: &[FieldSpec] = &[
  field!("cause", FieldKind::Enum(&SPAWN_CAUSES), 16),
  field!("path_class", FieldKind::Enum(&PathClass::NAMES), 14),
  field!("kind", FieldKind::Enum(&IoKind::NAMES), 20),
  field!("errno", FieldKind::SignedDecimalOrNone, 11),
  field!("text", FieldKind::Opaque, 24),
];
const DAEMON_STOP_REQUESTED_FIELDS: &[FieldSpec] = &[field!("pid", FieldKind::Decimal, 10)];
const DAEMON_STOPPED_FIELDS: &[FieldSpec] = &[field!("outcome", FieldKind::Enum(&STOP_OUTCOME_VALUES), 18)];
const DAEMON_LOG_FLUSHED_FIELDS: &[FieldSpec] = &[field!("drained", FieldKind::Bool, 5)];
const DAEMON_PHASE_CHANGED_FIELDS: &[FieldSpec] =
  &[field!("from", FieldKind::Enum(&DaemonPhase::NAMES), 8), field!("to", FieldKind::Enum(&DaemonPhase::NAMES), 8)];
const DAEMON_EXITED_FIELDS: &[FieldSpec] = &[field!("code", FieldKind::SignedDecimalOrNone, 11)];
const SIDECAR_FAILED_FIELDS: &[FieldSpec] = &[field!("reason", FieldKind::Opaque, 24)];
const DAEMON_TEXT_FIELDS: &[FieldSpec] = &[
  field!("stream", FieldKind::Enum(&Stream::NAMES), 3),
  field!("class", FieldKind::Enum(&DaemonTextClass::NAMES), 12),
  field!("text", FieldKind::Opaque, 24),
];
const DAEMON_LINE_FIELDS: &[FieldSpec] = &[
  field!("id", FieldKind::Hex8, 8),
  field!("session", FieldKind::Uuid, 36),
  field!("code", FieldKind::Enum(&CODE_VALUES), 26),
  field!("msg", FieldKind::CatalogueOrOpaque, 64),
  field!("err_name", FieldKind::Enum(&ERROR_NAME_VALUES), 14),
  field!("err_code", FieldKind::Enum(&CODE_VALUES), 26),
  field!("err_msg", FieldKind::Opaque, 24),
  field!("frames", FieldKind::Frames, 64),
  field!("extra_fields", FieldKind::Decimal, 20),
];
const PATH_REPAIRED_FIELDS: &[FieldSpec] = &[field!("source", FieldKind::Enum(&PathSource::NAMES), 8)];
const ISSUE_REPORT_OPENED_FIELDS: &[FieldSpec] = &[field!("lines", FieldKind::Decimal, 20), field!("url_bytes", FieldKind::Decimal, 20)];
const BUNDLE_SAVED_FIELDS: &[FieldSpec] = &[field!("bytes", FieldKind::Decimal, 20)];
const WRITER_DROPPED_FIELDS: &[FieldSpec] = &[field!("count", FieldKind::Decimal, 20)];
const WRITER_LOST_FIELDS: &[FieldSpec] = &[
  field!("count", FieldKind::Decimal, 20),
  field!("kind", FieldKind::Enum(&IoKind::NAMES), 20),
  field!("errno", FieldKind::SignedDecimalOrNone, 11),
];
const WRITER_HEADER_FIELDS: &[FieldSpec] = &[field!("started", FieldKind::Ts, 20)];
const FOREIGN_RECORDS_FIELDS: &[FieldSpec] = &[field!("target", FieldKind::Enum(&ForeignTarget::NAMES), 18), field!("count", FieldKind::Decimal, 20)];
const PANIC_RECORDED_FIELDS: &[FieldSpec] = &[field!("line", FieldKind::Decimal, 20), field!("column", FieldKind::Decimal, 20)];
const REJECTED_RECORD_FIELDS: &[FieldSpec] = &[field!("event", FieldKind::Enum(&EventName::NAMES), 21)];

/// The registry: every key each event may carry, with the shape and the size of its value.
pub fn fields_of(event: EventName) -> &'static [FieldSpec] {
  match event {
    EventName::DaemonReused => &[],
    EventName::DaemonSpawnFailed => DAEMON_SPAWN_FAILED_FIELDS,
    EventName::DaemonStopRequested => DAEMON_STOP_REQUESTED_FIELDS,
    EventName::DaemonStopped => DAEMON_STOPPED_FIELDS,
    EventName::DaemonLogFlushed => DAEMON_LOG_FLUSHED_FIELDS,
    EventName::DaemonPhaseChanged => DAEMON_PHASE_CHANGED_FIELDS,
    EventName::DaemonExited => DAEMON_EXITED_FIELDS,
    EventName::SidecarFailed => SIDECAR_FAILED_FIELDS,
    EventName::DaemonText => DAEMON_TEXT_FIELDS,
    EventName::DaemonLine => DAEMON_LINE_FIELDS,
    EventName::PathRepaired => PATH_REPAIRED_FIELDS,
    EventName::IssueReportOpened => ISSUE_REPORT_OPENED_FIELDS,
    EventName::BundleSaved => BUNDLE_SAVED_FIELDS,
    EventName::WriterDropped => WRITER_DROPPED_FIELDS,
    EventName::WriterLost => WRITER_LOST_FIELDS,
    EventName::WriterHeader => WRITER_HEADER_FIELDS,
    EventName::ForeignRecords => FOREIGN_RECORDS_FIELDS,
    EventName::PanicRecorded => PANIC_RECORDED_FIELDS,
    EventName::RejectedRecord => REJECTED_RECORD_FIELDS,
  }
}

/// What `seal` does with a value that does not match the kind of its key.
#[derive(Clone, Copy, Debug, PartialEq)]
enum ShapeMismatchPolicy {
  PanicToExposeTheBug,
  RejectTheRecord,
}

const SHAPE_MISMATCH_POLICY: ShapeMismatchPolicy = if cfg!(debug_assertions) { ShapeMismatchPolicy::PanicToExposeTheBug } else { ShapeMismatchPolicy::RejectTheRecord };

/// Wraps a candidate line when it passes the grammar; otherwise returns `rejected_record event=<name>`, never the candidate.
/// A value of the wrong kind is a bug of the renderer: it panics in a debug build and is rejected in a release build.
pub(super) fn seal(event: EventName, timestamp: Ts, candidate: String) -> SanitizedLine {
  seal_under(SHAPE_MISMATCH_POLICY, event, timestamp, candidate)
}

fn seal_under(policy: ShapeMismatchPolicy, event: EventName, timestamp: Ts, candidate: String) -> SanitizedLine {
  let violation = validate(event, &candidate);
  let exposes_the_bug = violation == Err(GrammarViolation::ValueShapeMismatch) && policy == ShapeMismatchPolicy::PanicToExposeTheBug;
  if exposes_the_bug {
    panic!("{event} rendered a value that does not match the kind of its field");
  }
  match violation {
    Ok(()) => SanitizedLine { text: candidate, is_rejection: false },
    Err(_) => {
      let rejection = format!("{timestamp} {} {} event={event}", Level::Error, EventName::RejectedRecord);
      SanitizedLine { text: rejection, is_rejection: true }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::synthetic_tokens::github_token;

  const TS: &str = "2026-10-04T12:00:00Z";

  fn ts() -> Ts {
    Ts::parse(TS).expect("a valid timestamp")
  }

  fn line_of(event: &str, pairs: &str) -> String {
    format!("{TS} info {event} {pairs}").trim_end().to_string()
  }

  mod validate {
    use super::*;

    #[test]
    fn accepts_a_header_without_pairs() {
      assert_eq!(validate(EventName::DaemonReused, &line_of("daemon_reused", "")), Ok(()));
    }

    #[test]
    fn accepts_pairs_with_the_allowed_punctuation() {
      let line = line_of("daemon_text", "stream=out class=other text=[text:12:0a1b2c3d]");

      assert_eq!(validate(EventName::DaemonText, &line), Ok(()));
    }

    #[test]
    fn rejects_a_byte_outside_the_alphabet() {
      for forbidden in ["\n", "\r", "\0", "\t", "\u{202e}", "é", "😀", "\"", "'", "`", "$", "%", "@", "+", "{", "}", ",", ";", "(", "\\", "*", "<", "#"] {
        let line = line_of("daemon_stopped", &format!("outcome=a{forbidden}b"));

        assert_eq!(validate(EventName::DaemonStopped, &line), Err(GrammarViolation::ForbiddenByte), "{forbidden:?}");
      }
    }

    #[test]
    fn rejects_a_value_longer_than_sixty_four_bytes() {
      let long_value = "a".repeat(65);

      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", &format!("outcome={long_value}"))), Err(GrammarViolation::ValueTooLong));
    }

    #[test]
    fn accepts_a_value_of_exactly_sixty_four_bytes() {
      let sixty_four_byte_frames = "123:456/123:456/123:456/123:456/123:456/123:456/123:456/1234:456";
      assert_eq!(sixty_four_byte_frames.len(), 64);

      assert_eq!(validate(EventName::DaemonLine, &line_of("daemon_line", &format!("frames={sixty_four_byte_frames}"))), Ok(()));
    }

    #[test]
    fn rejects_a_key_the_event_does_not_list() {
      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", "pid=1")), Err(GrammarViolation::KeyNotInTheEventFields));
    }

    #[test]
    fn rejects_a_repeated_key() {
      assert_eq!(validate(EventName::DaemonPhaseChanged, &line_of("daemon_phase_changed", "from=slow from=ready")), Err(GrammarViolation::DuplicateKey));
    }

    #[test]
    fn rejects_a_token_that_is_not_a_pair() {
      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", "outcome")), Err(GrammarViolation::MalformedPair));
    }

    #[test]
    fn rejects_an_empty_value_or_a_second_assignment() {
      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", "outcome=")), Err(GrammarViolation::MalformedPair));
      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", "outcome=a=b")), Err(GrammarViolation::MalformedPair));
    }

    #[test]
    fn rejects_a_doubled_space() {
      assert_eq!(validate(EventName::DaemonPhaseChanged, &line_of("daemon_phase_changed", "from=slow  to=ready")), Err(GrammarViolation::MalformedPair));
    }

    #[test]
    fn rejects_an_uppercase_or_empty_key() {
      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", "Outcome=x")), Err(GrammarViolation::MalformedPair));
      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", "=x")), Err(GrammarViolation::MalformedPair));
    }

    #[test]
    fn rejects_a_header_that_is_not_timestamp_level_event() {
      assert_eq!(validate(EventName::DaemonReused, "daemon_reused"), Err(GrammarViolation::MalformedHeader));
      assert_eq!(validate(EventName::DaemonReused, &format!("{TS} loud daemon_reused")), Err(GrammarViolation::MalformedHeader));
      assert_eq!(validate(EventName::DaemonReused, "2026-13-04T12:00:00Z info daemon_reused"), Err(GrammarViolation::MalformedHeader));
      assert_eq!(validate(EventName::DaemonReused, "2026-10-04T12:00:00.5Z info daemon_reused"), Err(GrammarViolation::MalformedHeader));
      assert_eq!(validate(EventName::DaemonReused, ""), Err(GrammarViolation::MalformedHeader));
    }

    #[test]
    fn rejects_an_event_name_that_is_not_the_expected_one() {
      assert_eq!(validate(EventName::DaemonReused, &line_of("daemon_stopped", "")), Err(GrammarViolation::EventNameMismatch));
    }
  }

  mod registry {
    use super::*;

    fn all_specs() -> Vec<(EventName, FieldSpec)> {
      EventName::ALL.iter().flat_map(|event| fields_of(*event).iter().map(|spec| (*event, *spec))).collect()
    }

    #[test]
    fn every_key_is_a_valid_key_and_unique_within_its_event() {
      for event in EventName::ALL {
        let keys: Vec<&str> = fields_of(event).iter().map(|spec| spec.key).collect();

        assert!(keys.iter().all(|key| is_key(key.as_bytes())), "{event}: {keys:?}");
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), keys.len(), "{event}: {keys:?}");
      }
    }

    #[test]
    fn every_max_bytes_is_positive_and_within_the_value_ceiling() {
      for (event, spec) in all_specs() {
        assert!(spec.max_bytes > 0 && usize::from(spec.max_bytes) <= MAX_VALUE_BYTES, "{event}.{}", spec.key);
      }
    }

    #[test]
    fn every_value_an_enum_field_lists_fits_its_max_bytes_and_the_alphabet() {
      for (event, spec) in all_specs() {
        let FieldKind::Enum(names) = spec.kind else { continue };

        for name in names {
          assert!(name.len() <= usize::from(spec.max_bytes), "{event}.{} lists {name}", spec.key);
          assert!(name.bytes().all(is_allowed_byte) && !name.is_empty(), "{event}.{} lists {name}", spec.key);
          assert!(spec.kind.accepts(name.as_bytes()), "{event}.{} rejects its own {name}", spec.key);
        }
      }
    }

    #[test]
    fn the_largest_value_of_each_kind_fits_its_max_bytes() {
      let largest = |spec: FieldSpec| -> &'static str {
        match spec.kind {
          FieldKind::Decimal if spec.key == "pid" => "4294967295",
          FieldKind::Decimal => "18446744073709551615",
          FieldKind::SignedDecimal | FieldKind::SignedDecimalOrNone => "-2147483648",
          FieldKind::Bool => "false",
          FieldKind::Enum(_) => "",
          FieldKind::Opaque | FieldKind::CatalogueOrOpaque => "[text:99999999:ffffffff]",
          FieldKind::Ts => "9999-12-31T23:59:59Z",
          FieldKind::Hex8 => "ffffffff",
          FieldKind::Uuid => "ffffffff-ffff-ffff-ffff-ffffffffffff",
          FieldKind::Frames => "123:456/123:456/123:456/123:456/123:456/123:456/123:456/1234:456",
        }
      };
      for (event, spec) in all_specs() {
        let value = largest(spec);

        assert!(value.len() <= usize::from(spec.max_bytes), "{event}.{} would reject {value}", spec.key);
        assert!(matches!(spec.kind, FieldKind::Enum(_)) || spec.kind.accepts(value.as_bytes()), "{event}.{} rejects {value}", spec.key);
      }
    }

    #[test]
    fn every_catalogue_id_is_accepted_and_fits_a_message_value() {
      let catalogue = include_str!("../../daemon_messages.txt");
      let msg = fields_of(EventName::DaemonLine).iter().find(|spec| spec.key == "msg").expect("a msg field");

      for (id, _) in catalogue.lines().filter_map(|entry| entry.split_once(' ')) {
        assert!(id.len() <= usize::from(msg.max_bytes), "{id}");
        assert!(msg.kind.accepts(id.as_bytes()), "{id}");
      }
    }

    #[test]
    fn the_names_of_a_closed_enum_follow_its_all_list_and_its_display() {
      fn assert_names<T: Copy + std::fmt::Display>(all: &[T], names: &[&str]) {
        let displayed: Vec<String> = all.iter().map(|variant| variant.to_string()).collect();
        assert_eq!(displayed, names);
      }
      assert_names(&DaemonPhase::ALL, &DaemonPhase::NAMES);
      assert_names(&StopOutcome::ALL, &StopOutcome::NAMES);
      assert_names(&PathSource::ALL, &PathSource::NAMES);
      assert_names(&Stream::ALL, &Stream::NAMES);
      assert_names(&PathClass::ALL, &PathClass::NAMES);
      assert_names(&ForeignTarget::ALL, &ForeignTarget::NAMES);
      assert_names(&DaemonTextClass::ALL, &DaemonTextClass::NAMES);
      assert_names(&EventName::ALL, &EventName::NAMES);
      let io_kind_names: Vec<&str> = IoKind::ALL.iter().map(|kind| kind.as_str()).collect();
      assert_eq!(io_kind_names, IoKind::NAMES);
    }

    #[test]
    fn a_stop_outcome_field_also_lists_nothing_to_stop() {
      assert!(STOP_OUTCOME_VALUES.contains(&"nothing_to_stop"));
      assert_eq!(STOP_OUTCOME_VALUES.len(), StopOutcome::ALL.len() + 1);
    }

    #[test]
    fn the_code_fields_list_other_beside_the_table() {
      assert!(CODE_VALUES.contains(&"other") && CODE_VALUES.contains(&"ENOENT"));
      assert!(ERROR_NAME_VALUES.contains(&"other") && ERROR_NAME_VALUES.contains(&"TypeError"));
    }
  }

  mod typed_values {
    use super::*;

    const SESSION: &str = "123e4567-e89b-42d3-a456-426614174000";

    fn token_shaped() -> String {
      ["gh", "p_", &"x".repeat(36)].concat()
    }

    fn accepted_pairs() -> Vec<(EventName, String)> {
      let pairs: &[(EventName, &str)] = &[
        (EventName::DaemonStopRequested, "pid=4242"),
        (EventName::DaemonStopped, "outcome=exited_on_sigterm"),
        (EventName::DaemonStopped, "outcome=nothing_to_stop"),
        (EventName::DaemonLogFlushed, "drained=true"),
        (EventName::DaemonPhaseChanged, "from=starting to=slow"),
        (EventName::DaemonExited, "code=-9"),
        (EventName::DaemonExited, "code=none"),
        (EventName::SidecarFailed, "reason=[text:12:0a1b2c3d]"),
        (EventName::SidecarFailed, "reason=[text:12]"),
        (EventName::DaemonText, "stream=err class=node_fatal text=[text:3]"),
        (EventName::DaemonSpawnFailed, "cause=bundle_not_found path_class=daemon_bundle"),
        (EventName::DaemonSpawnFailed, "cause=io kind=timed_out errno=none"),
        (EventName::DaemonSpawnFailed, "cause=unclassified text=[text:9]"),
        (EventName::PathRepaired, "source=fallback"),
        (EventName::IssueReportOpened, "lines=50 url_bytes=7500"),
        (EventName::BundleSaved, "bytes=1048576"),
        (EventName::WriterDropped, "count=0"),
        (EventName::WriterLost, "count=3 kind=storage_full errno=28"),
        (EventName::WriterLost, "count=3 kind=other errno=none"),
        (EventName::WriterHeader, "started=2026-10-04T12:00:00Z"),
        (EventName::ForeignRecords, "target=tauri_plugin_shell count=3"),
        (EventName::PanicRecorded, "line=1 column=2"),
        (EventName::RejectedRecord, "event=daemon_text"),
        (EventName::DaemonLine, "id=0a1b2c3d extra_fields=3"),
        (EventName::DaemonLine, "code=ENOENT msg=ws_write_failed err_name=TypeError err_code=other extra_fields=0"),
        (EventName::DaemonLine, "msg=[text:12:0a1b2c3d] err_msg=[text:5:ffffffff] extra_fields=0"),
        (EventName::DaemonLine, "frames=120:5/88:13 extra_fields=0"),
        (EventName::DaemonLine, "frames=1:1/2:2/3:3/4:4/5:5/6:6/7:7/8:8 extra_fields=0"),
        (EventName::DaemonLine, "code=session_not_found extra_fields=18446744073709551615"),
        (EventName::DaemonLine, "err_code=SQLITE_BUSY extra_fields=1"),
        (EventName::DaemonLine, "err_name=SqliteError extra_fields=1"),
        (EventName::DaemonStopRequested, "pid=0"),
        (EventName::DaemonExited, "code=2147483647"),
      ];
      let mut accepted: Vec<(EventName, String)> = pairs.iter().map(|(event, pairs)| (*event, pairs.to_string())).collect();
      accepted.push((EventName::DaemonLine, format!("session={SESSION} extra_fields=0")));
      accepted
    }

    fn rejected_pairs() -> Vec<(EventName, String)> {
      let secret_like_code = ["AK", "IAIOSFODNN7EXAMPLE"].concat();
      let pairs: Vec<(EventName, String)> = vec![
        (EventName::DaemonStopRequested, format!("pid={}", token_shaped())),
        (EventName::DaemonStopRequested, "pid=12a".to_string()),
        (EventName::DaemonStopRequested, "pid=-1".to_string()),
        (EventName::DaemonStopRequested, "pid=007".to_string()),
        (EventName::DaemonStopped, "outcome=bogus".to_string()),
        (EventName::DaemonStopped, format!("outcome={}", token_shaped())),
        (EventName::DaemonLogFlushed, "drained=yes".to_string()),
        (EventName::DaemonPhaseChanged, "from=bogus to=slow".to_string()),
        (EventName::DaemonExited, "code=abc".to_string()),
        (EventName::DaemonExited, "code=--1".to_string()),
        (EventName::SidecarFailed, format!("reason={}", token_shaped())),
        (EventName::SidecarFailed, "reason=[text:x]".to_string()),
        (EventName::SidecarFailed, "reason=[text:123456789]".to_string()),
        (EventName::SidecarFailed, "reason=[text:12:0A1B2C3D]".to_string()),
        (EventName::SidecarFailed, "reason=[text:12:0a1b2c3]".to_string()),
        (EventName::SidecarFailed, "reason=[text:12:0a1b2c3d".to_string()),
        (EventName::DaemonText, "stream=out class=other text=hello".to_string()),
        (EventName::DaemonText, "stream=sideways class=other text=[text:3]".to_string()),
        (EventName::DaemonSpawnFailed, format!("cause=io text={}", token_shaped())),
        (EventName::DaemonSpawnFailed, "cause=whatever".to_string()),
        (EventName::WriterHeader, "started=2026-13-04T12:00:00Z".to_string()),
        (EventName::WriterHeader, "started=2026-10-04T12:00:00.5Z".to_string()),
        (EventName::WriterLost, "count=3 kind=bogus errno=28".to_string()),
        (EventName::WriterLost, "count=3 kind=other errno=abc".to_string()),
        (EventName::ForeignRecords, "target=nope count=3".to_string()),
        (EventName::ForeignRecords, "target=tauri count=-1".to_string()),
        (EventName::RejectedRecord, "event=nope".to_string()),
        (EventName::PathRepaired, "source=elsewhere".to_string()),
        (EventName::DaemonLine, "id=ABCDEF01 extra_fields=0".to_string()),
        (EventName::DaemonLine, "id=0a1b2c3 extra_fields=0".to_string()),
        (EventName::DaemonLine, "session=123E4567-E89B-42D3-A456-426614174000 extra_fields=0".to_string()),
        (EventName::DaemonLine, format!("session={} extra_fields=0", SESSION.replace('-', ""))),
        (EventName::DaemonLine, format!("code={secret_like_code} extra_fields=0")),
        (EventName::DaemonLine, format!("err_code={secret_like_code} extra_fields=0")),
        (EventName::DaemonLine, "err_name=Mystery extra_fields=0".to_string()),
        (EventName::DaemonLine, "msg=not_in_the_catalogue extra_fields=0".to_string()),
        (EventName::DaemonLine, format!("err_msg={} extra_fields=0", token_shaped())),
        (EventName::DaemonLine, "frames=1:2/ extra_fields=0".to_string()),
        (EventName::DaemonLine, "frames=a:b extra_fields=0".to_string()),
        (EventName::DaemonLine, "frames=1:2/3:4/5:6/7:8/9:10/11:12/13:14/15:16/17:18 extra_fields=0".to_string()),
        (EventName::DaemonLine, "extra_fields=-1".to_string()),
        (EventName::DaemonLine, "extra_fields=abc".to_string()),
      ];
      pairs
    }

    #[test]
    fn accepts_each_kind_of_value_under_its_own_key() {
      for (event, pairs) in accepted_pairs() {
        let line = line_of(event.as_str(), &pairs);

        assert_eq!(validate(event, &line), Ok(()), "{line}");
      }
    }

    #[test]
    fn rejects_a_value_whose_shape_is_not_the_kind_of_its_key() {
      for (event, pairs) in rejected_pairs() {
        let line = line_of(event.as_str(), &pairs);

        let is_a_value_problem = matches!(validate(event, &line), Err(GrammarViolation::ValueShapeMismatch | GrammarViolation::ValueTooLong));
        assert!(is_a_value_problem, "{line}");
      }
    }

    #[test]
    fn a_value_of_the_wrong_kind_is_a_shape_mismatch() {
      let line = line_of("daemon_stop_requested", &format!("pid={}", token_shaped()));

      assert_eq!(validate(EventName::DaemonStopRequested, &line), Err(GrammarViolation::ValueShapeMismatch));
    }

    #[test]
    fn a_mismatched_value_panics_under_the_debug_policy_without_printing_the_candidate() {
      let candidate = line_of("daemon_stop_requested", &format!("pid={}", token_shaped()));

      let outcome = std::panic::catch_unwind(|| seal_under(ShapeMismatchPolicy::PanicToExposeTheBug, EventName::DaemonStopRequested, ts(), candidate));

      let payload = outcome.expect_err("a mismatch must panic under the debug policy");
      let message = payload.downcast_ref::<String>().cloned().unwrap_or_default();
      assert!(message.contains("daemon_stop_requested") && !message.contains("ghp_"), "{message}");
    }

    #[test]
    fn a_mismatched_value_is_a_rejected_record_under_the_release_policy() {
      let candidate = line_of("daemon_stop_requested", &format!("pid={}", token_shaped()));

      let sealed = seal_under(ShapeMismatchPolicy::RejectTheRecord, EventName::DaemonStopRequested, ts(), candidate);

      assert_eq!(sealed.as_str(), format!("{TS} error rejected_record event=daemon_stop_requested"));
      assert!(sealed.is_rejection());
    }

    #[test]
    fn the_build_profile_picks_the_policy() {
      let expected = if cfg!(debug_assertions) { ShapeMismatchPolicy::PanicToExposeTheBug } else { ShapeMismatchPolicy::RejectTheRecord };

      assert_eq!(SHAPE_MISMATCH_POLICY, expected);
    }

    #[test]
    fn a_shape_mismatch_that_is_not_a_value_problem_is_always_rejected_never_a_panic() {
      let sealed = seal_under(ShapeMismatchPolicy::PanicToExposeTheBug, EventName::DaemonStopRequested, ts(), "not a line".to_string());

      assert!(sealed.is_rejection());
    }

    #[test]
    fn rejects_a_line_longer_than_five_hundred_and_twelve_bytes() {
      let every_key_at_the_value_bound = format!("id={0} session={0} code={0} msg={0} err_name={0} err_code={0} err_msg={0} frames={0} extra_fields={0}", "a".repeat(64));
      let line = line_of("daemon_line", &every_key_at_the_value_bound);
      assert!(line.len() > 512);

      assert_eq!(validate(EventName::DaemonLine, &line), Err(GrammarViolation::LineTooLong));
    }

    #[test]
    fn accepts_the_longest_legitimate_daemon_line() {
      let pairs = format!(
        "id=ffffffff session={SESSION} code=docs_folder_not_writable msg=[text:99999999:ffffffff] err_name=ReferenceError err_code=docs_folder_not_writable err_msg=[text:99999999:ffffffff] frames=123:456/123:456/123:456/123:456/123:456/123:456/123:456/1234:456 extra_fields=18446744073709551615"
      );
      let line = line_of("daemon_line", &pairs);
      assert!(line.len() > 340 && line.len() <= MAX_LINE_BYTES, "{}", line.len());

      assert_eq!(validate(EventName::DaemonLine, &line), Ok(()));
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "does not match the kind of its field")]
    fn a_mismatched_value_panics_in_a_debug_build() {
      let candidate = line_of("daemon_stop_requested", &format!("pid={}", token_shaped()));

      seal(EventName::DaemonStopRequested, ts(), candidate);
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn a_mismatched_value_is_a_rejected_record_in_a_release_build() {
      let candidate = line_of("daemon_stop_requested", &format!("pid={}", token_shaped()));

      let sealed = seal(EventName::DaemonStopRequested, ts(), candidate);

      assert_eq!(sealed.as_str(), format!("{TS} error rejected_record event=daemon_stop_requested"));
      assert!(sealed.is_rejection());
    }
  }

  mod seal {
    use super::*;

    #[test]
    fn keeps_a_line_that_passes_the_grammar() {
      let candidate = line_of("daemon_stop_requested", "pid=42");

      let sealed = seal(EventName::DaemonStopRequested, ts(), candidate.clone());

      assert_eq!(sealed.as_str(), candidate);
      assert!(!sealed.is_rejection());
    }

    #[test]
    fn replaces_a_line_that_fails_by_a_rejected_record_naming_only_the_event() {
      let hostile = line_of("daemon_stop_requested", &format!("pid={} \n secret", github_token()));

      let sealed = seal(EventName::DaemonStopRequested, ts(), hostile);

      assert_eq!(sealed.as_str(), format!("{TS} error rejected_record event=daemon_stop_requested"));
      assert!(sealed.is_rejection());
    }

    #[test]
    fn the_rejected_record_itself_passes_the_grammar() {
      let sealed = seal(EventName::SidecarFailed, ts(), "not a line".to_string());

      assert_eq!(validate(EventName::RejectedRecord, sealed.as_str()), Ok(()));
    }
  }

  mod no_free_string_constructor {
    trait AmbiguousIfImplemented<Marker> {
      fn probe() {}
    }
    impl<T: ?Sized> AmbiguousIfImplemented<()> for T {}

    /// Compiles only when the type does NOT implement the bound: an implementation makes `probe` ambiguous.
    macro_rules! assert_not_implemented {
      ($type:ty: $bound:path) => {
        const _: fn() = || {
          struct Implemented;
          impl<T: ?Sized + $bound> AmbiguousIfImplemented<Implemented> for T {}
          let _ = <$type as AmbiguousIfImplemented<_>>::probe;
        };
      };
    }

    assert_not_implemented!(super::super::SanitizedLine: Default);
    assert_not_implemented!(super::super::SanitizedLine: From<String>);
    assert_not_implemented!(super::super::SanitizedLine: From<&'static str>);
    assert_not_implemented!(super::super::SanitizedLine: std::str::FromStr);

    #[test]
    fn a_sanitized_line_has_no_conversion_from_text() {
      // The assertions above are the proof: this crate does not compile if one of them is implemented.
    }
  }
}
