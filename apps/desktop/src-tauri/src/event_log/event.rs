use super::field::{
  Bool, Bytes, Count, DaemonMessage, DaemonPhase, EventName, ExitCode, IoFailure, KnownCode, KnownErrorName, Level, Opaque, PathClass, PathSource, Pid,
  SessionId, ShortId, StackFrames, StopOutcome, Stream, Ts,
};
use super::grammar::{seal, SanitizedLine};
use std::fmt::{self, Display};

/// The classes of crate a foreign `log::` record is counted under.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ForeignTarget {
  Tauri,
  Tao,
  Wry,
  Tokio,
  Hyper,
  TauriPluginShell,
  App,
  Other,
}

impl Display for ForeignTarget {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      ForeignTarget::Tauri => "tauri",
      ForeignTarget::Tao => "tao",
      ForeignTarget::Wry => "wry",
      ForeignTarget::Tokio => "tokio",
      ForeignTarget::Hyper => "hyper",
      ForeignTarget::TauriPluginShell => "tauri_plugin_shell",
      ForeignTarget::App => "app",
      ForeignTarget::Other => "other",
    })
  }
}

/// What kind of non-JSON text the daemon wrote.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DaemonTextClass {
  BootRefusal,
  NodeFatal,
  Other,
}

impl Display for DaemonTextClass {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      DaemonTextClass::BootRefusal => "boot_refusal",
      DaemonTextClass::NodeFatal => "node_fatal",
      DaemonTextClass::Other => "other",
    })
  }
}

/// Why the daemon did not start, in the terms the log keeps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SpawnFailure {
  BundleNotFound(PathClass),
  Io(IoFailure),
  Unclassified(Opaque),
}

/// The projection of one daemon JSON record; each field is read from the daemon by name and typed, never copied as text.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DaemonLineFields {
  pub level: Level,
  pub daemon_ts: Option<Ts>,
  pub id: Option<ShortId>,
  pub session: Option<SessionId>,
  pub code: Option<KnownCode>,
  pub message: Option<DaemonMessage>,
  pub error_name: Option<KnownErrorName>,
  pub error_code: Option<KnownCode>,
  pub error_message: Option<Opaque>,
  pub frames: Option<StackFrames>,
  pub extra_fields: Count,
}

/// Everything the desktop says about itself. No variant holds a `String` or a `&str`: free text enters only as `Opaque`.
#[derive(Clone, Copy, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum DesktopEvent {
  DaemonReused,
  DaemonSpawnFailed { failure: SpawnFailure },
  DaemonStopRequested { pid: Pid },
  DaemonStopped { outcome: Option<StopOutcome> },
  DaemonLogFlushed { drained: Bool },
  DaemonPhaseChanged { from: DaemonPhase, to: DaemonPhase },
  DaemonExited { code: Option<ExitCode> },
  SidecarFailed { reason: Opaque },
  DaemonText { stream: Stream, class: DaemonTextClass, text: Opaque },
  DaemonLine(DaemonLineFields),
  PathRepaired { source: PathSource },
  IssueReportOpened { lines: Count, url_bytes: Bytes },
  BundleSaved { bytes: Bytes },
  WriterDropped { count: Count },
  WriterLost { count: Count, failure: IoFailure },
  WriterHeader { started: Ts },
  ForeignRecords { level: Level, target: ForeignTarget, count: Count },
  PanicRecorded { line: Count, column: Count },
  RejectedRecord { event: EventName },
}

struct LineBuilder {
  text: String,
}

impl LineBuilder {
  fn start(timestamp: Ts, level: Level, event: EventName) -> Self {
    Self { text: format!("{timestamp} {level} {event}") }
  }

  fn pair(&mut self, key: &'static str, value: impl Display) {
    self.text.push_str(&format!(" {key}={value}"));
  }

  /// Appends a value that already renders as `key=value` pairs.
  fn pairs(&mut self, group: impl Display) {
    self.text.push_str(&format!(" {group}"));
  }

  fn pair_if_present(&mut self, key: &'static str, value: Option<impl Display>) {
    if let Some(value) = value {
      self.pair(key, value);
    }
  }

  fn pair_or(&mut self, key: &'static str, value: Option<impl Display>, absent: &'static str) {
    match value {
      Some(value) => self.pair(key, value),
      None => self.pair(key, absent),
    }
  }
}

impl DesktopEvent {
  pub fn name(&self) -> EventName {
    match self {
      DesktopEvent::DaemonReused => EventName::DaemonReused,
      DesktopEvent::DaemonSpawnFailed { .. } => EventName::DaemonSpawnFailed,
      DesktopEvent::DaemonStopRequested { .. } => EventName::DaemonStopRequested,
      DesktopEvent::DaemonStopped { .. } => EventName::DaemonStopped,
      DesktopEvent::DaemonLogFlushed { .. } => EventName::DaemonLogFlushed,
      DesktopEvent::DaemonPhaseChanged { .. } => EventName::DaemonPhaseChanged,
      DesktopEvent::DaemonExited { .. } => EventName::DaemonExited,
      DesktopEvent::SidecarFailed { .. } => EventName::SidecarFailed,
      DesktopEvent::DaemonText { .. } => EventName::DaemonText,
      DesktopEvent::DaemonLine(_) => EventName::DaemonLine,
      DesktopEvent::PathRepaired { .. } => EventName::PathRepaired,
      DesktopEvent::IssueReportOpened { .. } => EventName::IssueReportOpened,
      DesktopEvent::BundleSaved { .. } => EventName::BundleSaved,
      DesktopEvent::WriterDropped { .. } => EventName::WriterDropped,
      DesktopEvent::WriterLost { .. } => EventName::WriterLost,
      DesktopEvent::WriterHeader { .. } => EventName::WriterHeader,
      DesktopEvent::ForeignRecords { .. } => EventName::ForeignRecords,
      DesktopEvent::PanicRecorded { .. } => EventName::PanicRecorded,
      DesktopEvent::RejectedRecord { .. } => EventName::RejectedRecord,
    }
  }

  pub fn level(&self) -> Level {
    match self {
      DesktopEvent::DaemonReused
      | DesktopEvent::DaemonStopRequested { .. }
      | DesktopEvent::DaemonStopped { .. }
      | DesktopEvent::DaemonLogFlushed { .. }
      | DesktopEvent::DaemonPhaseChanged { .. }
      | DesktopEvent::PathRepaired { .. }
      | DesktopEvent::IssueReportOpened { .. }
      | DesktopEvent::BundleSaved { .. }
      | DesktopEvent::WriterHeader { .. } => Level::Info,
      DesktopEvent::DaemonExited { .. } | DesktopEvent::WriterDropped { .. } => Level::Warn,
      DesktopEvent::DaemonSpawnFailed { .. }
      | DesktopEvent::SidecarFailed { .. }
      | DesktopEvent::WriterLost { .. }
      | DesktopEvent::PanicRecorded { .. }
      | DesktopEvent::RejectedRecord { .. } => Level::Error,
      DesktopEvent::DaemonText { stream: Stream::Out, .. } => Level::Info,
      DesktopEvent::DaemonText { stream: Stream::Err, .. } => Level::Warn,
      DesktopEvent::DaemonLine(fields) => fields.level,
      DesktopEvent::ForeignRecords { level, .. } => *level,
    }
  }

  /// Returns the line of this event at `now`, or the `rejected_record` line when the rendering fails the grammar.
  pub fn render(&self, now: Ts) -> SanitizedLine {
    let timestamp = self.timestamp(now);
    let mut line = LineBuilder::start(timestamp, self.level(), self.name());
    self.write_fields(&mut line);
    seal(self.name(), timestamp, line.text)
  }

  fn timestamp(&self, now: Ts) -> Ts {
    match self {
      DesktopEvent::DaemonLine(fields) => fields.daemon_ts.unwrap_or(now),
      _ => now,
    }
  }

  fn write_fields(&self, line: &mut LineBuilder) {
    match self {
      DesktopEvent::DaemonReused => {}
      DesktopEvent::DaemonSpawnFailed { failure } => write_spawn_failure(line, failure),
      DesktopEvent::DaemonStopRequested { pid } => line.pair("pid", pid),
      DesktopEvent::DaemonStopped { outcome } => line.pair_or("outcome", *outcome, "nothing_to_stop"),
      DesktopEvent::DaemonLogFlushed { drained } => line.pair("drained", drained),
      DesktopEvent::DaemonPhaseChanged { from, to } => {
        line.pair("from", from);
        line.pair("to", to);
      }
      DesktopEvent::DaemonExited { code } => line.pair_or("code", *code, "none"),
      DesktopEvent::SidecarFailed { reason } => line.pair("reason", reason),
      DesktopEvent::DaemonText { stream, class, text } => {
        line.pair("stream", stream);
        line.pair("class", class);
        line.pair("text", text);
      }
      DesktopEvent::DaemonLine(fields) => write_daemon_line(line, fields),
      DesktopEvent::PathRepaired { source } => line.pair("source", source),
      DesktopEvent::IssueReportOpened { lines, url_bytes } => {
        line.pair("lines", lines);
        line.pair("url_bytes", url_bytes);
      }
      DesktopEvent::BundleSaved { bytes } => line.pair("bytes", bytes),
      DesktopEvent::WriterDropped { count } => line.pair("count", count),
      DesktopEvent::WriterLost { count, failure } => {
        line.pair("count", count);
        line.pairs(failure);
      }
      DesktopEvent::WriterHeader { started } => line.pair("started", started),
      DesktopEvent::ForeignRecords { target, count, .. } => {
        line.pair("target", target);
        line.pair("count", count);
      }
      DesktopEvent::PanicRecorded { line: source_line, column } => {
        line.pair("line", source_line);
        line.pair("column", column);
      }
      DesktopEvent::RejectedRecord { event } => line.pair("event", event),
    }
  }
}

fn write_spawn_failure(line: &mut LineBuilder, failure: &SpawnFailure) {
  match failure {
    SpawnFailure::BundleNotFound(path_class) => {
      line.pair("cause", "bundle_not_found");
      line.pair("path_class", path_class);
    }
    SpawnFailure::Io(io_failure) => {
      line.pair("cause", "io");
      line.pairs(io_failure);
    }
    SpawnFailure::Unclassified(text) => {
      line.pair("cause", "unclassified");
      line.pair("text", text);
    }
  }
}

fn write_daemon_line(line: &mut LineBuilder, fields: &DaemonLineFields) {
  line.pair_if_present("id", fields.id);
  line.pair_if_present("session", fields.session);
  line.pair_if_present("code", fields.code);
  line.pair_if_present("msg", fields.message);
  line.pair_if_present("err_name", fields.error_name);
  line.pair_if_present("err_code", fields.error_code);
  line.pair_if_present("err_msg", fields.error_message);
  line.pair_if_present("frames", fields.frames);
  line.pair("extra_fields", fields.extra_fields);
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::grammar::{allowed_keys_of, validate};
  use crate::event_log::salt::{Salt, SALT_LEN};
  use crate::linear_growth::{assert_linear_growth, thread_cpu_time_of, LinearGrowthBudget};
  use std::collections::HashSet;
  use std::io;

  const NOW: &str = "2026-10-04T12:00:00Z";

  fn now() -> Ts {
    Ts::parse(NOW).expect("a valid timestamp")
  }

  fn salt() -> Salt {
    Salt::from_bytes([7; SALT_LEN])
  }

  fn opaque(text: &str) -> Opaque {
    Opaque::of(text.as_bytes(), Some(&salt()))
  }

  fn io_failure(errno: i32) -> IoFailure {
    IoFailure::of(&io::Error::from_raw_os_error(errno))
  }

  fn daemon_line(text: &str) -> DaemonLineFields {
    DaemonLineFields {
      level: Level::Warn,
      daemon_ts: Ts::parse("2026-10-04T11:59:58.123Z"),
      id: ShortId::parse("0a1b2c3d"),
      session: SessionId::parse("123e4567-e89b-42d3-a456-426614174000"),
      code: Some(KnownCode::from_name("session_not_found")),
      message: Some(DaemonMessage::Unlisted(opaque(text))),
      error_name: Some(KnownErrorName::from_name("TypeError")),
      error_code: Some(KnownCode::from_name("ENOENT")),
      error_message: Some(opaque(text)),
      frames: Some(frames_at(&[(120, 5), (88, 13)])),
      extra_fields: Count(3),
    }
  }

  fn frames_at(positions: &[(u32, u32)]) -> StackFrames {
    let mut frames = StackFrames::empty();
    positions.iter().for_each(|(line, column)| assert!(frames.push(*line, *column)));
    frames
  }

  /// One event per variant, and several for the variants with alternatives, each carrying `text` in every Opaque-capable field.
  fn events_carrying(text: &str) -> Vec<DesktopEvent> {
    vec![
      DesktopEvent::DaemonReused,
      DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::BundleNotFound(PathClass::DaemonBundle) },
      DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::Io(io_failure(28)) },
      DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::Unclassified(opaque(text)) },
      DesktopEvent::DaemonStopRequested { pid: Pid(4242) },
      DesktopEvent::DaemonStopped { outcome: None },
      DesktopEvent::DaemonStopped { outcome: Some(StopOutcome::KilledAfterGrace) },
      DesktopEvent::DaemonLogFlushed { drained: Bool(true) },
      DesktopEvent::DaemonPhaseChanged { from: DaemonPhase::Starting, to: DaemonPhase::Slow },
      DesktopEvent::DaemonExited { code: None },
      DesktopEvent::DaemonExited { code: Some(ExitCode(-9)) },
      DesktopEvent::SidecarFailed { reason: opaque(text) },
      DesktopEvent::DaemonText { stream: Stream::Err, class: DaemonTextClass::BootRefusal, text: opaque(text) },
      DesktopEvent::DaemonText { stream: Stream::Out, class: DaemonTextClass::Other, text: Opaque::of(text.as_bytes(), None) },
      DesktopEvent::DaemonLine(daemon_line(text)),
      DesktopEvent::DaemonLine(DaemonLineFields {
        daemon_ts: None,
        id: None,
        session: None,
        code: None,
        message: None,
        error_name: None,
        error_code: None,
        error_message: None,
        frames: None,
        ..daemon_line(text)
      }),
      DesktopEvent::PathRepaired { source: PathSource::Fallback },
      DesktopEvent::IssueReportOpened { lines: Count(50), url_bytes: Bytes(7_500) },
      DesktopEvent::BundleSaved { bytes: Bytes(1 << 20) },
      DesktopEvent::WriterDropped { count: Count(12) },
      DesktopEvent::WriterLost { count: Count(3), failure: io_failure(13) },
      DesktopEvent::WriterHeader { started: now() },
      DesktopEvent::ForeignRecords { level: Level::Warn, target: ForeignTarget::TauriPluginShell, count: Count(3) },
      DesktopEvent::PanicRecorded { line: Count(133), column: Count(9) },
      DesktopEvent::RejectedRecord { event: EventName::DaemonLine },
    ]
  }

  fn sample_events() -> Vec<DesktopEvent> {
    events_carrying("some daemon text")
  }

  mod rendering {
    use super::*;

    #[test]
    fn every_event_name_has_a_sample_event() {
      let sampled: HashSet<&str> = sample_events().iter().map(|event| event.name().as_str()).collect();

      let missing: Vec<&str> = EventName::ALL.iter().map(|name| name.as_str()).filter(|name| !sampled.contains(name)).collect();

      assert!(missing.is_empty(), "no sample for {missing:?}");
    }

    #[test]
    fn every_event_renders_a_line_that_passes_the_grammar() {
      for event in sample_events() {
        let line = event.render(now());

        assert!(!line.is_rejection(), "{event:?} was rejected");
        assert_eq!(validate(event.name(), line.as_str()), Ok(()), "{}", line.as_str());
      }
    }

    #[test]
    fn every_rendered_key_is_in_the_static_field_list_of_its_event() {
      for event in sample_events() {
        let line = event.render(now());

        let keys = line.as_str().split(' ').skip(3).filter_map(|pair| pair.split('=').next());
        for key in keys {
          assert!(allowed_keys_of(event.name()).contains(&key), "{key} of {}", event.name());
        }
      }
    }

    #[test]
    fn every_line_starts_with_the_timestamp_the_level_and_the_event_name() {
      let line = DesktopEvent::DaemonStopRequested { pid: Pid(42) }.render(now());

      assert_eq!(line.as_str(), "2026-10-04T12:00:00Z info daemon_stop_requested pid=42");
    }

    #[test]
    fn renders_the_desktop_facts_as_typed_pairs() {
      let render = |event: DesktopEvent| event.render(now()).to_string();

      assert_eq!(render(DesktopEvent::DaemonReused), "2026-10-04T12:00:00Z info daemon_reused");
      assert_eq!(render(DesktopEvent::DaemonStopped { outcome: None }), "2026-10-04T12:00:00Z info daemon_stopped outcome=nothing_to_stop");
      assert_eq!(render(DesktopEvent::DaemonLogFlushed { drained: Bool(false) }), "2026-10-04T12:00:00Z info daemon_log_flushed drained=false");
      assert_eq!(render(DesktopEvent::DaemonExited { code: Some(ExitCode(1)) }), "2026-10-04T12:00:00Z warn daemon_exited code=1");
      assert_eq!(render(DesktopEvent::DaemonExited { code: None }), "2026-10-04T12:00:00Z warn daemon_exited code=none");
      assert_eq!(
        render(DesktopEvent::DaemonPhaseChanged { from: DaemonPhase::Starting, to: DaemonPhase::Slow }),
        "2026-10-04T12:00:00Z info daemon_phase_changed from=starting to=slow"
      );
      assert_eq!(render(DesktopEvent::PathRepaired { source: PathSource::Shell }), "2026-10-04T12:00:00Z info path_repaired source=shell");
      assert_eq!(
        render(DesktopEvent::WriterLost { count: Count(3), failure: io_failure(28) }),
        "2026-10-04T12:00:00Z error writer_lost count=3 kind=storage_full errno=28"
      );
      assert_eq!(
        render(DesktopEvent::ForeignRecords { level: Level::Warn, target: ForeignTarget::Tauri, count: Count(3) }),
        "2026-10-04T12:00:00Z warn foreign_records target=tauri count=3"
      );
      assert_eq!(
        render(DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::BundleNotFound(PathClass::DaemonBundle) }),
        "2026-10-04T12:00:00Z error daemon_spawn_failed cause=bundle_not_found path_class=daemon_bundle"
      );
      assert_eq!(render(DesktopEvent::RejectedRecord { event: EventName::DaemonText }), "2026-10-04T12:00:00Z error rejected_record event=daemon_text");
    }

    #[test]
    fn free_text_renders_as_its_length_and_tag_only() {
      let line = DesktopEvent::SidecarFailed { reason: opaque("No such file or directory") }.render(now());

      let prefix = "2026-10-04T12:00:00Z error sidecar_failed reason=[text:25:";
      assert!(line.as_str().starts_with(prefix), "{line}");
      assert_eq!(line.as_str().len(), prefix.len() + "xxxxxxxx]".len());
    }

    #[test]
    fn a_daemon_line_takes_the_daemon_timestamp_and_level_and_skips_absent_fields() {
      let fields = DaemonLineFields {
        id: None,
        session: None,
        code: None,
        message: None,
        error_name: None,
        error_code: None,
        error_message: None,
        frames: None,
        ..daemon_line("x")
      };

      let line = DesktopEvent::DaemonLine(fields).render(now());

      assert_eq!(line.as_str(), "2026-10-04T11:59:58Z warn daemon_line extra_fields=3");
    }

    #[test]
    fn a_daemon_line_without_a_daemon_timestamp_takes_the_desktop_clock() {
      let fields = DaemonLineFields { daemon_ts: None, ..daemon_line("x") };

      let line = DesktopEvent::DaemonLine(fields).render(now());

      assert!(line.as_str().starts_with("2026-10-04T12:00:00Z warn daemon_line id=0a1b2c3d session=123e4567-e89b-42d3-a456-426614174000 code=session_not_found"));
    }

    #[test]
    fn the_same_event_and_salt_render_the_same_line() {
      let first = DesktopEvent::DaemonLine(daemon_line("same text")).render(now());
      let second = DesktopEvent::DaemonLine(daemon_line("same text")).render(now());

      assert_eq!(first, second);
    }

    #[test]
    fn without_a_salt_the_tag_is_absent() {
      let event = DesktopEvent::SidecarFailed { reason: Opaque::of(b"disk", None) };

      assert_eq!(event.render(now()).as_str(), "2026-10-04T12:00:00Z error sidecar_failed reason=[text:4]");
    }

    #[test]
    fn an_event_carrying_text_never_prints_it_through_debug() {
      let event = DesktopEvent::SidecarFailed { reason: opaque("ghp_abcdefghijklmnopqrstuvwxyz0123456789") };

      assert!(!format!("{event:?}").contains("ghp_"));
    }

    #[test]
    fn the_rejection_flag_is_off_for_every_regular_event() {
      assert!(sample_events().iter().all(|event| !event.render(now()).is_rejection()));
    }
  }

  mod properties {
    use super::*;

    const ITERATIONS: usize = 4_000;

    struct XorShift64Star(u64);

    impl XorShift64Star {
      fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
      }

      fn bytes(&mut self, length: usize) -> Vec<u8> {
        (0..length).map(|_| self.next() as u8).collect()
      }

      fn lowercase_hex(&mut self, length: usize) -> String {
        (0..length).map(|_| char::from_digit((self.next() % 16) as u32, 16).unwrap_or('0')).collect()
      }
    }

    fn random_events(random: &mut XorShift64Star) -> Vec<DesktopEvent> {
      let text_length = (random.next() % 300) as usize;
      let text = random.bytes(text_length);
      let maybe_salt = (random.next() % 4 != 0).then(salt);
      let opaque = Opaque::of(&text, maybe_salt.as_ref());
      let some_ts = |random: &mut XorShift64Star| Ts::from_unix_seconds(random.next() % 253_402_300_800);
      let kind = (random.next() % 4000) as i32;
      let error = if random.next() % 2 == 0 { io::Error::from_raw_os_error(kind) } else { io::Error::new(io::ErrorKind::NotFound, "text") };
      let hostile_name = String::from_utf8_lossy(&random.bytes(12)).into_owned();
      let words = [random.next(), random.next(), random.next()];

      vec![
        DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::Unclassified(opaque) },
        DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::Io(IoFailure::of(&error)) },
        DesktopEvent::DaemonStopRequested { pid: Pid(words[0] as u32) },
        DesktopEvent::DaemonExited { code: Some(ExitCode(words[1] as i32)) },
        DesktopEvent::SidecarFailed { reason: opaque },
        DesktopEvent::DaemonText { stream: Stream::Err, class: DaemonTextClass::NodeFatal, text: opaque },
        DesktopEvent::DaemonLine(DaemonLineFields {
          level: Level::Error,
          daemon_ts: some_ts(random),
          id: ShortId::parse(&random.lowercase_hex(8)),
          session: SessionId::parse(&format!(
            "{}-{}-{}-{}-{}",
            random.lowercase_hex(8),
            random.lowercase_hex(4),
            random.lowercase_hex(4),
            random.lowercase_hex(4),
            random.lowercase_hex(12)
          )),
          code: Some(KnownCode::from_name(&hostile_name)),
          message: Some(DaemonMessage::Unlisted(opaque)),
          error_name: Some(KnownErrorName::from_name(&hostile_name)),
          error_code: Some(KnownCode::from_name("EACCES")),
          error_message: Some(opaque),
          frames: Some(frames_at(&[(words[0] as u32, words[1] as u32)])),
          extra_fields: Count(words[2]),
        }),
        DesktopEvent::IssueReportOpened { lines: Count(words[0]), url_bytes: Bytes(words[1]) },
        DesktopEvent::BundleSaved { bytes: Bytes(words[2]) },
        DesktopEvent::WriterLost { count: Count(words[0]), failure: IoFailure::of(&error) },
        DesktopEvent::WriterHeader { started: some_ts(random).unwrap_or(now()) },
        DesktopEvent::ForeignRecords { level: Level::Debug, target: ForeignTarget::Other, count: Count(u64::MAX) },
        DesktopEvent::PanicRecorded { line: Count(words[1]), column: Count(words[2]) },
      ]
    }

    #[test]
    fn events_built_from_many_synthetic_field_values_always_pass_the_grammar() {
      let mut random = XorShift64Star(0x9E37_79B9_7F4A_7C15);

      for _ in 0..ITERATIONS {
        for event in random_events(&mut random) {
          let line = event.render(Ts::from_unix_seconds(random.next() % 253_402_300_800).unwrap_or(now()));

          assert!(!line.is_rejection(), "{event:?} -> {line}");
          assert_eq!(validate(event.name(), line.as_str()), Ok(()), "{line}");
        }
      }
    }

    #[test]
    fn every_value_stays_within_the_grammar_value_bound() {
      let mut random = XorShift64Star(42);

      for event in (0..500).flat_map(|_| random_events(&mut random)) {
        let line = event.render(now());

        assert!(line.as_str().split(' ').skip(3).all(|pair| pair.split_once('=').is_some_and(|(_, value)| value.len() <= 64)), "{line}");
      }
    }
  }

  mod hostile_inputs {
    use super::*;

    const MIN_WINDOW: usize = 12;

    fn token(prefix: &str, length: usize) -> String {
      let body: String = "Zq9XvB3nKd7LpR2sTe5YwUa8HcMj4GfN6Vb1".chars().cycle().take(length).collect();
      format!("{prefix}{body}")
    }

    fn pem() -> String {
      format!("-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----", token("MIIEowIBAAKCAQEA", 1_600))
    }

    fn hostile_secrets() -> Vec<String> {
      let github = token("ghp_", 36);
      let secret_key = token("sk-", 48);
      let bearer = format!("Authorization: Bearer {}", token("eyJhbGciOiJIUzI1NiJ9.", 120));
      let bidi = format!("\u{202e}\u{2066}{}\u{2069}\u{200f}", token("pa55w0rd-", 30));
      let control = format!("\u{0}\u{1b}[31m{}\u{7}\r\n\t{}", token("tok-", 24), token("again-", 24));
      let multibyte = format!("日本語😀é{}😀日本", token("secret-", 30));
      let long_16_kib = format!("{}{}", "a".repeat(16 * 1024), token("ghp_", 36));
      let long_64_kib = format!("{}{}", "é".repeat(32 * 1024), token("sk-", 48));
      let straddling_the_16_kib_edge = format!("{}{}{}", "a".repeat(16 * 1024 - 20), token("ghp_", 36), "b".repeat(100));
      vec![github, secret_key, bearer, pem(), bidi, control, multibyte, long_16_kib, long_64_kib, straddling_the_16_kib_edge]
    }

    const BASE64_STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn base64_decoded(token: &[u8]) -> Vec<u8> {
      let value_of = |byte: u8| match byte {
        b'-' => Some(62),
        b'_' => Some(63),
        other => BASE64_STANDARD.iter().position(|candidate| *candidate == other).map(|position| position as u32),
      };
      let sextets: Vec<u32> = token.iter().filter_map(|byte| value_of(*byte)).collect();
      sextets
        .chunks(4)
        .flat_map(|group| {
          let packed = group.iter().enumerate().fold(0u32, |total, (index, sextet)| total | (sextet << (18 - 6 * index as u32)));
          (0..group.len().saturating_sub(1)).map(move |index| (packed >> (16 - 8 * index as u32)) as u8)
        })
        .collect()
    }

    fn percent_decoded(text: &[u8]) -> Vec<u8> {
      let mut decoded = Vec::new();
      let mut index = 0;
      while index < text.len() {
        let hex_pair = text.get(index + 1..index + 3).and_then(|pair| std::str::from_utf8(pair).ok()).and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (text[index], hex_pair) {
          (b'%', Some(byte)) => {
            decoded.push(byte);
            index += 3;
          }
          (byte, _) => {
            decoded.push(byte);
            index += 1;
          }
        }
      }
      decoded
    }

    fn hex_decoded(text: &[u8]) -> Vec<u8> {
      text.chunks_exact(2).filter_map(|pair| std::str::from_utf8(pair).ok().and_then(|pair| u8::from_str_radix(pair, 16).ok())).collect()
    }

    const BASE64_GROUP_ALIGNMENTS: usize = 4;

    /// The line as it is, case-folded, percent-decoded, and with every token read as base64 (at each group alignment) or hex.
    fn views_of(line: &str) -> Vec<Vec<u8>> {
      let raw = line.as_bytes().to_vec();
      let tokens = line.split([' ', '=', '[', ']', ':']);
      let mut views = vec![raw.to_ascii_lowercase(), percent_decoded(&raw), raw];
      for token in tokens {
        for alignment in 0..BASE64_GROUP_ALIGNMENTS.min(token.len() + 1) {
          views.push(base64_decoded(&token.as_bytes()[alignment..]));
        }
        views.push(hex_decoded(token.as_bytes()));
      }
      views
    }

    fn windows_of(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
      let window_length = MIN_WINDOW.min(bytes.len().max(1));
      let is_long_enough = bytes.len() >= MIN_WINDOW;
      bytes.windows(window_length).filter(move |_| is_long_enough)
    }

    /// Every 12-byte window of the secret, raw and case-folded.
    fn watched_windows<'a>(secret: &'a [u8], folded_secret: &'a [u8]) -> HashSet<&'a [u8]> {
      windows_of(secret).chain(windows_of(folded_secret)).collect()
    }

    /// True when any watched window appears in any view of the line.
    fn leaks(line: &str, watched: &HashSet<&[u8]>) -> bool {
      views_of(line).iter().any(|view| windows_of(view).any(|window| watched.contains(window)))
    }

    fn leaks_secret(line: &str, secret: &str) -> bool {
      let folded = secret.to_ascii_lowercase();
      leaks(line, &watched_windows(secret.as_bytes(), folded.as_bytes()))
    }

    #[test]
    fn the_leak_detector_sees_a_secret_in_each_form_it_checks() {
      let secret = token("ghp_", 36);
      let base64_of_secret = {
        let encode = |bytes: &[u8]| -> String {
          bytes
            .chunks(3)
            .flat_map(|chunk| {
              let packed = chunk.iter().enumerate().fold(0u32, |total, (index, byte)| total | (u32::from(*byte) << (16 - 8 * index as u32)));
              (0..chunk.len() + 1).map(move |index| BASE64_STANDARD[((packed >> (18 - 6 * index as u32)) & 63) as usize] as char)
            })
            .collect()
        };
        encode(secret.as_bytes())
      };
      let percent_of_secret: String = secret.bytes().map(|byte| format!("%{byte:02x}")).collect();
      let hex_of_secret: String = secret.bytes().map(|byte| format!("{byte:02x}")).collect();

      assert!(leaks_secret(&format!("x {secret} y"), &secret));
      assert!(leaks_secret(&format!("x {} y", secret.to_ascii_uppercase()), &secret));
      assert!(leaks_secret(&format!("x text={base64_of_secret} y"), &secret));
      assert!(leaks_secret(&format!("x text=abc{base64_of_secret} y"), &secret));
      assert!(leaks_secret(&format!("x text={percent_of_secret} y"), &secret));
      assert!(leaks_secret(&format!("x text={hex_of_secret} y"), &secret));
      assert!(!leaks_secret("x text=[text:40:0a1b2c3d] y", &secret));
    }

    #[test]
    fn no_hostile_text_appears_in_any_line_of_any_event() {
      for secret in hostile_secrets() {
        let folded = secret.to_ascii_lowercase();
        let watched = watched_windows(secret.as_bytes(), folded.as_bytes());

        for event in events_carrying(&secret) {
          let line = event.render(now());

          assert!(!line.is_rejection(), "{event:?}");
          assert!(!leaks(line.as_str(), &watched), "a hostile text of {} bytes leaked into {}", secret.len(), event.name());
        }
      }
    }

    #[test]
    fn hostile_text_without_a_salt_never_appears_either() {
      for secret in hostile_secrets() {
        let folded = secret.to_ascii_lowercase();
        let watched = watched_windows(secret.as_bytes(), folded.as_bytes());
        let events = [
          DesktopEvent::SidecarFailed { reason: Opaque::of(secret.as_bytes(), None) },
          DesktopEvent::DaemonText { stream: Stream::Out, class: DaemonTextClass::Other, text: Opaque::of(secret.as_bytes(), None) },
        ];

        for event in events {
          assert!(!leaks(event.render(now()).as_str(), &watched), "{}", event.name());
        }
      }
    }

    #[test]
    fn hostile_text_given_to_the_classifiers_never_appears_either() {
      let known = crate::event_log::KnownPaths {
        openfleet_home: std::path::Path::new("/home/user/.openfleet"),
        logs_dir: std::path::Path::new("/home/user/.openfleet/logs"),
        admin_token: std::path::Path::new("/home/user/.openfleet/admin.token"),
        daemon_bundle: std::path::Path::new("/app/daemon.mjs"),
        user_home: std::path::Path::new("/home/user"),
      };
      for secret in hostile_secrets() {
        let hostile_path = std::path::PathBuf::from(format!("/home/user/{secret}"));
        let from_error = io::Error::new(io::ErrorKind::PermissionDenied, secret.clone());
        let events = [
          DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::BundleNotFound(PathClass::classify(&hostile_path, &known)) },
          DesktopEvent::DaemonSpawnFailed { failure: SpawnFailure::Io(IoFailure::of(&from_error)) },
          DesktopEvent::WriterLost { count: Count(1), failure: IoFailure::of(&from_error) },
          DesktopEvent::DaemonLine(DaemonLineFields {
            code: Some(KnownCode::from_name(&secret)),
            error_code: Some(KnownCode::from_name(&secret)),
            id: ShortId::parse(&secret),
            session: SessionId::parse(&secret),
            daemon_ts: Ts::parse(&secret),
            ..daemon_line("x")
          }),
        ];

        let folded = secret.to_ascii_lowercase();
        let watched = watched_windows(secret.as_bytes(), folded.as_bytes());
        for event in events {
          assert!(!leaks(event.render(now()).as_str(), &watched), "{}", event.name());
        }
      }
    }

    #[test]
    fn a_secret_lookalike_error_code_is_reduced_to_other() {
      let event = DesktopEvent::DaemonLine(DaemonLineFields { code: Some(KnownCode::from_name("AKIAIOSFODNN7EXAMPLE")), ..daemon_line("x") });

      assert!(event.render(now()).as_str().contains(" code=other "));
    }
  }

  mod rejection {
    use super::*;

    #[test]
    fn a_line_that_fails_the_grammar_is_replaced_and_flagged() {
      let hostile_candidate = format!("{NOW} info daemon_stopped outcome=ghp_\u{202e}secret");

      let sealed = seal(EventName::DaemonStopped, now(), hostile_candidate);

      assert_eq!(sealed.as_str(), "2026-10-04T12:00:00Z error rejected_record event=daemon_stopped");
      assert!(sealed.is_rejection());
      assert_eq!(validate(EventName::RejectedRecord, sealed.as_str()), Ok(()));
    }

    #[test]
    fn a_rejection_carries_nothing_of_the_candidate_whatever_its_shape() {
      let candidates = ["x".repeat(70_000), format!("{NOW} info daemon_stopped outcome={}", "k".repeat(65)), "\0".repeat(10), String::new()];

      for candidate in candidates {
        let sealed = seal(EventName::DaemonStopped, now(), candidate);

        assert_eq!(sealed.as_str(), "2026-10-04T12:00:00Z error rejected_record event=daemon_stopped");
        assert!(sealed.is_rejection());
      }
    }
  }

  mod cost {
    use super::*;

    #[test]
    fn rendering_one_hundred_thousand_events_costs_a_linear_cpu_time() {
      let events = sample_events();
      let timestamp = now();
      let measure = |event_count: usize| {
        thread_cpu_time_of(|| {
          for index in 0..event_count {
            std::hint::black_box(events[index % events.len()].render(timestamp));
          }
        })
      };

      assert_linear_growth(measure, &LinearGrowthBudget::between(25_000, 100_000));
    }
  }
}
