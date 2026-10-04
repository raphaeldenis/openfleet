use super::field::{EventName, Level, Ts};
use std::fmt;

const MAX_VALUE_BYTES: usize = 64;
const SEPARATOR: u8 = b' ';
const ASSIGNMENT: u8 = b'=';
const HEADER_TOKENS: usize = 3;

/// A finished log line: the only thing the writer accepts.
/// Its text is private and `seal` is its only constructor, so every line has passed the grammar; there is no `From<String>` and no `Default`.
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

  let allowed_keys = allowed_keys_of(event);
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
    if !allowed_keys.iter().any(|allowed| allowed.as_bytes() == key) {
      return Err(GrammarViolation::KeyNotInTheEventFields);
    }
    if seen_keys.contains(&key) {
      return Err(GrammarViolation::DuplicateKey);
    }
    seen_keys.push(key);
  }
  Ok(())
}

/// The static list of keys each event may carry.
pub fn allowed_keys_of(event: EventName) -> &'static [&'static str] {
  match event {
    EventName::DaemonReused => &[],
    EventName::DaemonSpawnFailed => &["cause", "path_class", "kind", "errno", "text"],
    EventName::DaemonStopRequested => &["pid"],
    EventName::DaemonStopped => &["outcome"],
    EventName::DaemonLogFlushed => &["drained"],
    EventName::DaemonPhaseChanged => &["from", "to"],
    EventName::DaemonExited => &["code"],
    EventName::SidecarFailed => &["reason"],
    EventName::DaemonText => &["stream", "class", "text"],
    EventName::DaemonLine => &["id", "session", "code", "msg", "err_name", "err_code", "err_msg", "frames", "extra_fields"],
    EventName::PathRepaired => &["source"],
    EventName::IssueReportOpened => &["lines", "url_bytes"],
    EventName::BundleSaved => &["bytes"],
    EventName::WriterDropped => &["count"],
    EventName::WriterLost => &["count", "kind", "errno"],
    EventName::WriterHeader => &["started"],
    EventName::ForeignRecords => &["target", "count"],
    EventName::PanicRecorded => &["line", "column"],
    EventName::RejectedRecord => &["event"],
  }
}

/// Wraps a candidate line when it passes the grammar; otherwise returns `rejected_record event=<name>`, never the candidate.
pub(super) fn seal(event: EventName, timestamp: Ts, candidate: String) -> SanitizedLine {
  match validate(event, &candidate) {
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
      let value = "a".repeat(64);

      assert_eq!(validate(EventName::DaemonStopped, &line_of("daemon_stopped", &format!("outcome={value}"))), Ok(()));
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
      let hostile = line_of("daemon_stop_requested", "pid=ghp_abcdefghijklmnopqrstuvwxyz0123456789 \n secret");

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
