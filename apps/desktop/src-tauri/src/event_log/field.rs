use super::hash::Hash8;
use super::salt::Salt;
use serde_json::error::Category;
use std::fmt;
use std::io;
use std::path::{Component, Path};

/// Every event a log line can name.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EventName {
  DaemonReused,
  DaemonSpawnFailed,
  DaemonStopRequested,
  DaemonStopped,
  DaemonLogFlushed,
  DaemonPhaseChanged,
  DaemonExited,
  SidecarFailed,
  DaemonText,
  DaemonLine,
  PathRepaired,
  IssueReportOpened,
  BundleSaved,
  WriterDropped,
  WriterLost,
  WriterHeader,
  ForeignRecords,
  PanicRecorded,
  RejectedRecord,
}

impl EventName {
  pub const ALL: [EventName; 19] = [
    EventName::DaemonReused,
    EventName::DaemonSpawnFailed,
    EventName::DaemonStopRequested,
    EventName::DaemonStopped,
    EventName::DaemonLogFlushed,
    EventName::DaemonPhaseChanged,
    EventName::DaemonExited,
    EventName::SidecarFailed,
    EventName::DaemonText,
    EventName::DaemonLine,
    EventName::PathRepaired,
    EventName::IssueReportOpened,
    EventName::BundleSaved,
    EventName::WriterDropped,
    EventName::WriterLost,
    EventName::WriterHeader,
    EventName::ForeignRecords,
    EventName::PanicRecorded,
    EventName::RejectedRecord,
  ];

  pub fn as_str(self) -> &'static str {
    match self {
      EventName::DaemonReused => "daemon_reused",
      EventName::DaemonSpawnFailed => "daemon_spawn_failed",
      EventName::DaemonStopRequested => "daemon_stop_requested",
      EventName::DaemonStopped => "daemon_stopped",
      EventName::DaemonLogFlushed => "daemon_log_flushed",
      EventName::DaemonPhaseChanged => "daemon_phase_changed",
      EventName::DaemonExited => "daemon_exited",
      EventName::SidecarFailed => "sidecar_failed",
      EventName::DaemonText => "daemon_text",
      EventName::DaemonLine => "daemon_line",
      EventName::PathRepaired => "path_repaired",
      EventName::IssueReportOpened => "issue_report_opened",
      EventName::BundleSaved => "bundle_saved",
      EventName::WriterDropped => "writer_dropped",
      EventName::WriterLost => "writer_lost",
      EventName::WriterHeader => "writer_header",
      EventName::ForeignRecords => "foreign_records",
      EventName::PanicRecorded => "panic_recorded",
      EventName::RejectedRecord => "rejected_record",
    }
  }
}

impl fmt::Display for EventName {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(self.as_str())
  }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
  Debug,
  Info,
  Warn,
  Error,
}

impl Level {
  /// Returns the level a daemon line names, or `None` for any spelling other than the four lowercase ones.
  pub fn parse(text: &str) -> Option<Self> {
    match text {
      "debug" => Some(Level::Debug),
      "info" => Some(Level::Info),
      "warn" => Some(Level::Warn),
      "error" => Some(Level::Error),
      _ => None,
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Level::Debug => "debug",
      Level::Info => "info",
      Level::Warn => "warn",
      Level::Error => "error",
    }
  }
}

impl fmt::Display for Level {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(self.as_str())
  }
}

const SECONDS_PER_DAY: u64 = 86_400;
const LAST_REPRESENTABLE_SECOND: u64 = 253_402_300_799;
const ISO_DATE_AND_TIME_SHAPE: &[u8; 19] = b"dddd-dd-ddTdd:dd:dd";
const MAX_FRACTION_DIGITS: usize = 9;

/// A UTC second, rendered `YYYY-MM-DDTHH:MM:SSZ`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ts {
  year: u16,
  month: u8,
  day: u8,
  hour: u8,
  minute: u8,
  second: u8,
}

impl Ts {
  /// Returns the UTC second of a Unix time, or `None` past the year 9999.
  pub fn from_unix_seconds(unix_seconds: u64) -> Option<Self> {
    if unix_seconds > LAST_REPRESENTABLE_SECOND {
      return None;
    }
    let days_since_epoch = (unix_seconds / SECONDS_PER_DAY) as i64;
    let seconds_of_day = unix_seconds % SECONDS_PER_DAY;
    let (year, month, day) = civil_date_of(days_since_epoch);
    Some(Self {
      year: year as u16,
      month,
      day,
      hour: (seconds_of_day / 3600) as u8,
      minute: (seconds_of_day % 3600 / 60) as u8,
      second: (seconds_of_day % 60) as u8,
    })
  }

  /// Parses `YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z` with a real calendar date, and drops the fraction. Any other text gives `None`.
  pub fn parse(text: &str) -> Option<Self> {
    let bytes = text.as_bytes();
    let date_and_time = bytes.get(..ISO_DATE_AND_TIME_SHAPE.len())?;
    let zone_suffix = &bytes[ISO_DATE_AND_TIME_SHAPE.len()..];
    let is_iso_shaped = date_and_time.iter().zip(ISO_DATE_AND_TIME_SHAPE).all(|(byte, shape)| if *shape == b'd' { byte.is_ascii_digit() } else { byte == shape });
    if !is_iso_shaped || !is_utc_suffix(zone_suffix) {
      return None;
    }

    let year = number_in(&date_and_time[0..4])? as u16;
    let month = number_in(&date_and_time[5..7])? as u8;
    let day = number_in(&date_and_time[8..10])? as u8;
    let hour = number_in(&date_and_time[11..13])? as u8;
    let minute = number_in(&date_and_time[14..16])? as u8;
    let second = number_in(&date_and_time[17..19])? as u8;
    let is_real_date = (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day);
    let is_real_time = hour < 24 && minute < 60 && second < 60;
    (is_real_date && is_real_time).then_some(Self { year, month, day, hour, minute, second })
  }
}

/// Accepts `Z` and `.<1 to 9 digits>Z`.
fn is_utc_suffix(suffix: &[u8]) -> bool {
  let Some((&b'Z', before_zone)) = suffix.split_last() else { return false };
  if before_zone.is_empty() {
    return true;
  }
  let Some((&b'.', fraction)) = before_zone.split_first() else { return false };
  let has_fraction_length = (1..=MAX_FRACTION_DIGITS).contains(&fraction.len());
  has_fraction_length && fraction.iter().all(u8::is_ascii_digit)
}

fn number_in(digits: &[u8]) -> Option<u32> {
  digits.iter().try_fold(0u32, |total, digit| digit.is_ascii_digit().then(|| total * 10 + u32::from(digit - b'0')))
}

fn days_in_month(year: u16, month: u8) -> u8 {
  let is_leap_year = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  match month {
    2 if is_leap_year => 29,
    2 => 28,
    4 | 6 | 9 | 11 => 30,
    _ => 31,
  }
}

/// Converts days since 1970-01-01 to a (year, month, day) of the proleptic Gregorian calendar.
fn civil_date_of(days_since_epoch: i64) -> (i64, u8, u8) {
  let shifted_days = days_since_epoch + 719_468;
  let era = shifted_days.div_euclid(146_097);
  let day_of_era = shifted_days.rem_euclid(146_097);
  let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
  let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let month_from_march = (5 * day_of_year + 2) / 153;
  let day = (day_of_year - (153 * month_from_march + 2) / 5 + 1) as u8;
  let calendar_month = if month_from_march < 10 { month_from_march + 3 } else { month_from_march - 9 };
  let month = calendar_month as u8;
  let year = year_of_era + era * 400 + i64::from(month <= 2);
  (year, month, day)
}

impl fmt::Display for Ts {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(formatter, "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", self.year, self.month, self.day, self.hour, self.minute, self.second)
  }
}

fn is_lowercase_hex(byte: u8) -> bool {
  byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn value_of_lowercase_hex(digits: &[u8]) -> Option<u128> {
  digits.iter().try_fold(0u128, |total, digit| is_lowercase_hex(*digit).then(|| (total << 4) | u128::from((*digit as char).to_digit(16).unwrap_or(0))))
}

/// An 8-character lowercase hex id, the short reference the UI shows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShortId(u32);

impl ShortId {
  pub fn parse(text: &str) -> Option<Self> {
    let bytes = text.as_bytes();
    let has_short_id_length = bytes.len() == 8;
    if !has_short_id_length {
      return None;
    }
    value_of_lowercase_hex(bytes).map(|value| Self(value as u32))
  }
}

impl fmt::Display for ShortId {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(formatter, "{:08x}", self.0)
  }
}

const UUID_LENGTH: usize = 36;
const UUID_DASH_POSITIONS: [usize; 4] = [8, 13, 18, 23];

/// A canonical lowercase `8-4-4-4-12` UUID.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SessionId(u128);

impl SessionId {
  pub fn parse(text: &str) -> Option<Self> {
    let bytes = text.as_bytes();
    let has_uuid_length = bytes.len() == UUID_LENGTH;
    let has_dashes_in_place = UUID_DASH_POSITIONS.iter().all(|position| bytes.get(*position) == Some(&b'-'));
    if !has_uuid_length || !has_dashes_in_place {
      return None;
    }
    let digits: Vec<u8> = bytes.iter().copied().filter(|byte| *byte != b'-').collect();
    let has_only_the_four_dashes = digits.len() == UUID_LENGTH - UUID_DASH_POSITIONS.len();
    let value = value_of_lowercase_hex(&digits)?;
    has_only_the_four_dashes.then_some(Self(value))
  }
}

impl fmt::Display for SessionId {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    let hex = format!("{:032x}", self.0);
    write!(formatter, "{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
  }
}

macro_rules! decimal_field {
  ($(#[$meta:meta])* $name:ident($inner:ty)) => {
    $(#[$meta])*
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct $name(pub $inner);

    impl fmt::Display for $name {
      fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
      }
    }
  };
}

decimal_field!(Count(u64));
decimal_field!(DurationMs(u64));
decimal_field!(Bytes(u64));
decimal_field!(Pid(u32));
decimal_field!(ExitCode(i32));

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bool(pub bool);

impl fmt::Display for Bool {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(if self.0 { "true" } else { "false" })
  }
}

/// The phases of the daemon the desktop reports. `daemon::DaemonPhase` maps onto it when the call sites migrate (RA-05).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DaemonPhase {
  Starting,
  Slow,
  Ready,
  Failed,
  Reused,
}

impl fmt::Display for DaemonPhase {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      DaemonPhase::Starting => "starting",
      DaemonPhase::Slow => "slow",
      DaemonPhase::Ready => "ready",
      DaemonPhase::Failed => "failed",
      DaemonPhase::Reused => "reused",
    })
  }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StopOutcome {
  ExitedOnSigterm,
  KilledAfterGrace,
}

impl fmt::Display for StopOutcome {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      StopOutcome::ExitedOnSigterm => "exited_on_sigterm",
      StopOutcome::KilledAfterGrace => "killed_after_grace",
    })
  }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathSource {
  Shell,
  Fallback,
}

impl fmt::Display for PathSource {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      PathSource::Shell => "shell",
      PathSource::Fallback => "fallback",
    })
  }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stream {
  Out,
  Err,
}

impl fmt::Display for Stream {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      Stream::Out => "out",
      Stream::Err => "err",
    })
  }
}

/// The failure kinds the log names; `io::ErrorKind` is `non_exhaustive`, so anything unlisted is `Other`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum IoKind {
  NotFound,
  PermissionDenied,
  AlreadyExists,
  ConnectionRefused,
  ConnectionReset,
  ConnectionAborted,
  NotConnected,
  AddrInUse,
  AddrNotAvailable,
  BrokenPipe,
  WouldBlock,
  InvalidInput,
  InvalidData,
  TimedOut,
  WriteZero,
  Interrupted,
  Unsupported,
  UnexpectedEof,
  OutOfMemory,
  StorageFull,
  NotADirectory,
  IsADirectory,
  DirectoryNotEmpty,
  ReadOnlyFilesystem,
  CrossesDevices,
  Other,
}

impl IoKind {
  pub const ALL: [IoKind; 26] = [
    IoKind::NotFound,
    IoKind::PermissionDenied,
    IoKind::AlreadyExists,
    IoKind::ConnectionRefused,
    IoKind::ConnectionReset,
    IoKind::ConnectionAborted,
    IoKind::NotConnected,
    IoKind::AddrInUse,
    IoKind::AddrNotAvailable,
    IoKind::BrokenPipe,
    IoKind::WouldBlock,
    IoKind::InvalidInput,
    IoKind::InvalidData,
    IoKind::TimedOut,
    IoKind::WriteZero,
    IoKind::Interrupted,
    IoKind::Unsupported,
    IoKind::UnexpectedEof,
    IoKind::OutOfMemory,
    IoKind::StorageFull,
    IoKind::NotADirectory,
    IoKind::IsADirectory,
    IoKind::DirectoryNotEmpty,
    IoKind::ReadOnlyFilesystem,
    IoKind::CrossesDevices,
    IoKind::Other,
  ];

  pub fn as_str(self) -> &'static str {
    match self {
      IoKind::NotFound => "not_found",
      IoKind::PermissionDenied => "permission_denied",
      IoKind::AlreadyExists => "already_exists",
      IoKind::ConnectionRefused => "connection_refused",
      IoKind::ConnectionReset => "connection_reset",
      IoKind::ConnectionAborted => "connection_aborted",
      IoKind::NotConnected => "not_connected",
      IoKind::AddrInUse => "addr_in_use",
      IoKind::AddrNotAvailable => "addr_not_available",
      IoKind::BrokenPipe => "broken_pipe",
      IoKind::WouldBlock => "would_block",
      IoKind::InvalidInput => "invalid_input",
      IoKind::InvalidData => "invalid_data",
      IoKind::TimedOut => "timed_out",
      IoKind::WriteZero => "write_zero",
      IoKind::Interrupted => "interrupted",
      IoKind::Unsupported => "unsupported",
      IoKind::UnexpectedEof => "unexpected_eof",
      IoKind::OutOfMemory => "out_of_memory",
      IoKind::StorageFull => "storage_full",
      IoKind::NotADirectory => "not_a_directory",
      IoKind::IsADirectory => "is_a_directory",
      IoKind::DirectoryNotEmpty => "directory_not_empty",
      IoKind::ReadOnlyFilesystem => "read_only_filesystem",
      IoKind::CrossesDevices => "crosses_devices",
      IoKind::Other => "other",
    }
  }

  fn of_error_kind(kind: io::ErrorKind) -> Self {
    match kind {
      io::ErrorKind::NotFound => IoKind::NotFound,
      io::ErrorKind::PermissionDenied => IoKind::PermissionDenied,
      io::ErrorKind::AlreadyExists => IoKind::AlreadyExists,
      io::ErrorKind::ConnectionRefused => IoKind::ConnectionRefused,
      io::ErrorKind::ConnectionReset => IoKind::ConnectionReset,
      io::ErrorKind::ConnectionAborted => IoKind::ConnectionAborted,
      io::ErrorKind::NotConnected => IoKind::NotConnected,
      io::ErrorKind::AddrInUse => IoKind::AddrInUse,
      io::ErrorKind::AddrNotAvailable => IoKind::AddrNotAvailable,
      io::ErrorKind::BrokenPipe => IoKind::BrokenPipe,
      io::ErrorKind::WouldBlock => IoKind::WouldBlock,
      io::ErrorKind::InvalidInput => IoKind::InvalidInput,
      io::ErrorKind::InvalidData => IoKind::InvalidData,
      io::ErrorKind::TimedOut => IoKind::TimedOut,
      io::ErrorKind::WriteZero => IoKind::WriteZero,
      io::ErrorKind::Interrupted => IoKind::Interrupted,
      io::ErrorKind::Unsupported => IoKind::Unsupported,
      io::ErrorKind::UnexpectedEof => IoKind::UnexpectedEof,
      io::ErrorKind::OutOfMemory => IoKind::OutOfMemory,
      _ => IoKind::Other,
    }
  }

  /// Names the OS errors that older toolchains report as an uncategorized kind.
  fn of_errno(errno: i32) -> Self {
    match errno {
      libc::ENOSPC => IoKind::StorageFull,
      libc::ENOTDIR => IoKind::NotADirectory,
      libc::EISDIR => IoKind::IsADirectory,
      libc::ENOTEMPTY => IoKind::DirectoryNotEmpty,
      libc::EROFS => IoKind::ReadOnlyFilesystem,
      libc::EXDEV => IoKind::CrossesDevices,
      _ => IoKind::Other,
    }
  }
}

/// What the log keeps of an `io::Error`: its kind and its OS error number. The message is never read.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IoFailure {
  kind: IoKind,
  errno: Option<i32>,
}

impl IoFailure {
  pub fn of(error: &io::Error) -> Self {
    let errno = error.raw_os_error();
    let kind_from_the_standard_kind = IoKind::of_error_kind(error.kind());
    let kind = match (kind_from_the_standard_kind, errno) {
      (IoKind::Other, Some(errno)) => IoKind::of_errno(errno),
      (kind, _) => kind,
    };
    Self { kind, errno }
  }
}

impl fmt::Display for IoFailure {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self.errno {
      Some(errno) => write!(formatter, "kind={} errno={errno}", self.kind.as_str()),
      None => write!(formatter, "kind={} errno=none", self.kind.as_str()),
    }
  }
}

/// What the log keeps of a `serde_json::Error`: its category and its position. The message is never read.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JsonFailure {
  category: Category,
  line: u64,
  column: u64,
}

impl JsonFailure {
  pub fn of(error: &serde_json::Error) -> Self {
    Self { category: error.classify(), line: error.line() as u64, column: error.column() as u64 }
  }
}

impl fmt::Display for JsonFailure {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    let category = match self.category {
      Category::Io => "io",
      Category::Syntax => "syntax",
      Category::Data => "data",
      Category::Eof => "eof",
    };
    write!(formatter, "category={category} line={} col={}", self.line, self.column)
  }
}

const KNOWN_CODES: &[&str] = &[
  // errno names
  "E2BIG", "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EAGAIN", "EBADF", "EBUSY", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EEXIST", "EHOSTUNREACH",
  "EINTR", "EINVAL", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG", "ENETUNREACH", "ENFILE", "ENOENT", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY",
  "ENOTFOUND", "ENOTSUP", "EPERM", "EPIPE", "EROFS", "ETIMEDOUT", "EXDEV",
  // SQLite result names
  "SQLITE_BUSY", "SQLITE_CANTOPEN", "SQLITE_CONSTRAINT", "SQLITE_CORRUPT", "SQLITE_ERROR", "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_LOCKED", "SQLITE_MISUSE",
  "SQLITE_NOTADB", "SQLITE_READONLY",
  // shared error codes (packages/shared/src/errors.ts)
  "invalid_body", "invalid_json", "invalid_url", "invalid_branch_name", "unknown_harness", "constraint_violation", "message_too_long", "query_too_long",
  "outside_own_repository", "unauthorized", "not_found", "project_not_found", "no_state", "session_not_found", "note_not_found", "store_not_found",
  "view_not_found", "row_not_found", "manager_not_found", "handoff_not_found", "session_closed", "stale_revision", "file_backed", "file_unreadable",
  "path_escapes_docs_folder", "duplicate_name", "worktree_exists", "not_closed", "directory_missing", "directory_changed", "directory_unreadable",
  "already_resolved", "config_unreadable", "config_read_only", "message_id_reused", "too_many_pending", "children_cap", "outside_lineage", "not_a_manager",
  "mission_missing", "mission_too_large",
  "directory_in_use", "duplicate_child", "no_parent", "spawn_raced", "store_has_rows", "duplicate_id", "no_docs_folder", "not_file_backed",
  "docs_folder_not_writable", "payload_too_large", "note_too_large", "row_cap", "state_too_large", "daemon_shutting_down", "daemon_degraded",
  "delivery_failed", "message_held_for_review", "harness_exited", "claude_not_found", "git_unavailable", "internal_error", "launch_failed", "resume_timeout",
  "db_stuck",
];

const OTHER_CODE: &str = "other";

/// A code from the closed table of errno names, SQLite results and shared error codes; every other text is `other`.
/// The table, not a shape rule, decides: a token such as an `AKIA...` key has the shape of an errno name.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KnownCode(&'static str);

impl KnownCode {
  pub fn from_name(name: &str) -> Self {
    Self(listed_or_other(KNOWN_CODES, name))
  }
}

impl fmt::Display for KnownCode {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(self.0)
  }
}

fn listed_or_other(list: &'static [&'static str], name: &str) -> &'static str {
  list.iter().find(|listed| **listed == name).copied().unwrap_or(OTHER_CODE)
}

const KNOWN_ERROR_NAMES: &[&str] = &[
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "SqliteError", "AbortError", "TimeoutError",
];

/// An `Error.name` from the closed list of JavaScript built-ins and the database driver; every other name is `other`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KnownErrorName(&'static str);

impl KnownErrorName {
  pub fn from_name(name: &str) -> Self {
    Self(listed_or_other(KNOWN_ERROR_NAMES, name))
  }
}

impl fmt::Display for KnownErrorName {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(self.0)
  }
}

/// The id of a daemon message literal listed in the catalogue; only the catalogue constructs one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CatalogueId(&'static str);

impl CatalogueId {
  pub(super) fn new(id: &'static str) -> Self {
    Self(id)
  }
}

/// A daemon `msg`: readable when the literal is in the catalogue, otherwise reduced to its length and tag.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DaemonMessage {
  Catalogued(CatalogueId),
  Unlisted(Opaque),
}

impl fmt::Display for DaemonMessage {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      DaemonMessage::Catalogued(CatalogueId(id)) => formatter.write_str(id),
      DaemonMessage::Unlisted(opaque) => write!(formatter, "{opaque}"),
    }
  }
}

const MAX_FRAMES: usize = 8;
const MAX_FRAMES_RENDERED_BYTES: usize = 64;
const FRAME_SEPARATOR_BYTES: usize = 1;

/// Source positions (`line:column`) of the daemon bundle's own stack frames, rendered `L:C/L:C`.
/// Holds at most 8 positions and at most 64 rendered bytes, the longest value a log line allows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StackFrames {
  positions: [(u32, u32); MAX_FRAMES],
  count: usize,
  rendered_bytes: usize,
}

impl StackFrames {
  pub fn empty() -> Self {
    Self { positions: [(0, 0); MAX_FRAMES], count: 0, rendered_bytes: 0 }
  }

  pub fn is_empty(&self) -> bool {
    self.count == 0
  }

  /// Adds a position and returns true, or returns false when the frames are full or the rendering would pass 64 bytes.
  pub fn push(&mut self, line: u32, column: u32) -> bool {
    let separator_bytes = if self.is_empty() { 0 } else { FRAME_SEPARATOR_BYTES };
    let position_bytes = format!("{line}:{column}").len();
    let rendered_bytes_with_position = self.rendered_bytes + separator_bytes + position_bytes;
    let has_room = self.count < MAX_FRAMES && rendered_bytes_with_position <= MAX_FRAMES_RENDERED_BYTES;
    if !has_room {
      return false;
    }
    self.positions[self.count] = (line, column);
    self.count += 1;
    self.rendered_bytes = rendered_bytes_with_position;
    true
  }
}

impl fmt::Display for StackFrames {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    let rendered: Vec<String> = self.positions[..self.count].iter().map(|(line, column)| format!("{line}:{column}")).collect();
    formatter.write_str(&rendered.join("/"))
  }
}

/// The paths the desktop builds itself; a path is classified against them.
pub struct KnownPaths<'a> {
  pub openfleet_home: &'a Path,
  pub logs_dir: &'a Path,
  pub admin_token: &'a Path,
  pub daemon_bundle: &'a Path,
  pub user_home: &'a Path,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathClass {
  OpenfleetHome,
  LogsDir,
  AdminToken,
  DaemonBundle,
  UserHome,
  Other,
}

impl PathClass {
  /// Returns the most specific known location holding `path`; a path with a `..` component is `Other`.
  pub fn classify(path: &Path, known: &KnownPaths) -> Self {
    let climbs_out_of_its_prefix = path.components().any(|component| component == Component::ParentDir);
    if climbs_out_of_its_prefix {
      return PathClass::Other;
    }
    let is_admin_token = path == known.admin_token;
    let is_daemon_bundle = path.starts_with(known.daemon_bundle);
    let is_in_logs_dir = path.starts_with(known.logs_dir);
    let is_in_openfleet_home = path.starts_with(known.openfleet_home);
    let is_in_user_home = path.starts_with(known.user_home);
    [
      (is_admin_token, PathClass::AdminToken),
      (is_daemon_bundle, PathClass::DaemonBundle),
      (is_in_logs_dir, PathClass::LogsDir),
      (is_in_openfleet_home, PathClass::OpenfleetHome),
      (is_in_user_home, PathClass::UserHome),
    ]
    .into_iter()
    .find_map(|(is_match, class)| is_match.then_some(class))
    .unwrap_or(PathClass::Other)
  }
}

impl fmt::Display for PathClass {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      PathClass::OpenfleetHome => "openfleet_home",
      PathClass::LogsDir => "logs_dir",
      PathClass::AdminToken => "admin_token",
      PathClass::DaemonBundle => "daemon_bundle",
      PathClass::UserHome => "user_home",
      PathClass::Other => "other",
    })
  }
}

/// Free text reduced to its byte length and, when the install has a salt, a 4-byte keyed tag.
/// The source text is dropped inside `of`: the value holds no text, so no `Debug` or `Display` can print it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opaque {
  length: usize,
  tag: Option<Hash8>,
}

impl Opaque {
  pub fn of(text: &[u8], salt: Option<&Salt>) -> Self {
    Self { length: text.len(), tag: salt.map(|salt| Hash8::of(salt, text)) }
  }
}

impl fmt::Display for Opaque {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self.tag {
      Some(tag) => write!(formatter, "[text:{}:{tag}]", self.length),
      None => write!(formatter, "[text:{}]", self.length),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::salt::SALT_LEN;
  use crate::linear_growth::{assert_linear_growth, cpu_time_to_run_on_repeated, LinearGrowthBudget};
  use std::path::PathBuf;

  fn salt_of(byte: u8) -> Salt {
    Salt::from_bytes([byte; SALT_LEN])
  }

  fn is_snake_case(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
  }

  mod event_name {
    use super::*;

    #[test]
    fn every_name_is_snake_case_and_unique() {
      let names: Vec<&str> = EventName::ALL.iter().map(|name| name.as_str()).collect();

      assert!(names.iter().all(|name| is_snake_case(name)), "{names:?}");
      let mut sorted = names.clone();
      sorted.sort_unstable();
      sorted.dedup();
      assert_eq!(sorted.len(), names.len());
    }

    #[test]
    fn lists_every_variant() {
      let is_listed = |name: EventName| EventName::ALL.contains(&name);
      let exhaustive_guard = |name: EventName| match name {
        EventName::DaemonReused
        | EventName::DaemonSpawnFailed
        | EventName::DaemonStopRequested
        | EventName::DaemonStopped
        | EventName::DaemonLogFlushed
        | EventName::DaemonPhaseChanged
        | EventName::DaemonExited
        | EventName::SidecarFailed
        | EventName::DaemonText
        | EventName::DaemonLine
        | EventName::PathRepaired
        | EventName::IssueReportOpened
        | EventName::BundleSaved
        | EventName::WriterDropped
        | EventName::WriterLost
        | EventName::WriterHeader
        | EventName::ForeignRecords
        | EventName::PanicRecorded
        | EventName::RejectedRecord => is_listed(name),
      };

      assert!(EventName::ALL.iter().all(|name| exhaustive_guard(*name)));
    }
  }

  mod level {
    use super::*;

    #[test]
    fn parses_the_four_lowercase_levels() {
      assert_eq!(Level::parse("debug"), Some(Level::Debug));
      assert_eq!(Level::parse("info"), Some(Level::Info));
      assert_eq!(Level::parse("warn"), Some(Level::Warn));
      assert_eq!(Level::parse("error"), Some(Level::Error));
    }

    #[test]
    fn rejects_other_spellings() {
      for text in ["", "INFO", "Info", "warning", "info ", " info", "fatal", "info\n", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"] {
        assert_eq!(Level::parse(text), None, "{text:?}");
      }
    }

    #[test]
    fn renders_what_it_parses() {
      for text in ["debug", "info", "warn", "error"] {
        assert_eq!(Level::parse(text).unwrap().to_string(), text);
      }
    }
  }

  mod ts {
    use super::*;

    #[test]
    fn renders_the_unix_epoch() {
      assert_eq!(Ts::from_unix_seconds(0).unwrap().to_string(), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn renders_a_known_second() {
      assert_eq!(Ts::from_unix_seconds(1_000_000_000).unwrap().to_string(), "2001-09-09T01:46:40Z");
    }

    #[test]
    fn renders_a_leap_day() {
      assert_eq!(Ts::from_unix_seconds(1_709_164_800).unwrap().to_string(), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn renders_the_last_representable_second_and_rejects_the_next() {
      assert_eq!(Ts::from_unix_seconds(253_402_300_799).unwrap().to_string(), "9999-12-31T23:59:59Z");
      assert_eq!(Ts::from_unix_seconds(253_402_300_800), None);
      assert_eq!(Ts::from_unix_seconds(u64::MAX), None);
    }

    #[test]
    fn parses_a_javascript_iso_string_and_drops_the_fraction() {
      assert_eq!(Ts::parse("2026-10-04T12:34:56.789Z").unwrap().to_string(), "2026-10-04T12:34:56Z");
    }

    #[test]
    fn parses_a_string_without_a_fraction_and_with_one_to_nine_digits() {
      for text in ["2026-10-04T12:34:56Z", "2026-10-04T12:34:56.1Z", "2026-10-04T12:34:56.123456789Z"] {
        assert_eq!(Ts::parse(text).unwrap().to_string(), "2026-10-04T12:34:56Z", "{text}");
      }
    }

    #[test]
    fn accepts_a_leap_day_only_in_a_leap_year() {
      assert!(Ts::parse("2024-02-29T00:00:00Z").is_some());
      assert!(Ts::parse("2000-02-29T00:00:00Z").is_some());
      assert_eq!(Ts::parse("2023-02-29T00:00:00Z"), None);
      assert_eq!(Ts::parse("1900-02-29T00:00:00Z"), None);
    }

    #[test]
    fn rejects_out_of_range_fields() {
      for text in [
        "2026-00-04T12:34:56Z",
        "2026-13-04T12:34:56Z",
        "2026-10-00T12:34:56Z",
        "2026-10-32T12:34:56Z",
        "2026-04-31T12:34:56Z",
        "2026-10-04T24:00:00Z",
        "2026-10-04T12:60:00Z",
        "2026-10-04T12:34:60Z",
      ] {
        assert_eq!(Ts::parse(text), None, "{text}");
      }
    }

    #[test]
    fn rejects_text_that_is_not_the_fixed_grammar() {
      for text in [
        "",
        "2026-10-04",
        "2026-10-04 12:34:56Z",
        "2026-10-04T12:34:56",
        "2026-10-04T12:34:56+02:00",
        "2026-10-04T12:34:56.Z",
        "2026-10-04T12:34:56.1234567890Z",
        "2026-10-04T12:34:56.12aZ",
        "2026-10-04T12:34:56ZZ",
        "+026-10-04T12:34:56Z",
        "2026-10-04T12:34:56Z\n",
        "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        "２０２６-10-04T12:34:56Z",
      ] {
        assert_eq!(Ts::parse(text), None, "{text:?}");
      }
    }
  }

  mod short_id {
    use super::*;

    #[test]
    fn accepts_eight_lowercase_hex_characters_and_renders_them_back() {
      for text in ["0123abcd", "00000000", "ffffffff"] {
        assert_eq!(ShortId::parse(text).unwrap().to_string(), text);
      }
    }

    #[test]
    fn rejects_other_lengths_cases_and_characters() {
      for text in ["", "0123abc", "0123abcde", "0123ABCD", "0123abcg", "0123 abc", "0123abc\n", "0123abcé", "-123abcd", "+123abcd", "0x23abcd"] {
        assert_eq!(ShortId::parse(text), None, "{text:?}");
      }
    }
  }

  mod session_id {
    use super::*;

    const CANONICAL: &str = "123e4567-e89b-12d3-a456-426614174000";

    #[test]
    fn accepts_a_canonical_lowercase_uuid_and_renders_it_back() {
      assert_eq!(SessionId::parse(CANONICAL).unwrap().to_string(), CANONICAL);
      assert_eq!(SessionId::parse("00000000-0000-0000-0000-000000000000").unwrap().to_string(), "00000000-0000-0000-0000-000000000000");
    }

    #[test]
    fn rejects_uppercase_braces_urn_and_missing_dashes() {
      for text in [
        "123E4567-E89B-12D3-A456-426614174000",
        "{123e4567-e89b-12d3-a456-426614174000}",
        "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
        "123e4567e89b12d3a456426614174000",
        "123e4567-e89b-12d3-a456-42661417400",
        "123e4567-e89b-12d3-a456-4266141740000",
        "123e4567-e89b-12d3-a456_426614174000",
        "123e4567-e89b-12d3-a456-42661417400g",
        "123e4567-e89b-12d3-a45-6426614174000",
        "",
      ] {
        assert_eq!(SessionId::parse(text), None, "{text:?}");
      }
    }

    #[test]
    fn rejects_dashes_in_the_wrong_places_even_at_the_right_length() {
      assert_eq!(SessionId::parse("123e4567-e89b-12d3-a456-4266141740-0"), None);
      assert_eq!(SessionId::parse("123e45-7-e89b-12d3-a456-426614174000"), None);
    }
  }

  mod numbers_and_flags {
    use super::*;

    #[test]
    fn render_their_extremes_in_decimal() {
      assert_eq!(Count(u64::MAX).to_string(), "18446744073709551615");
      assert_eq!(DurationMs(0).to_string(), "0");
      assert_eq!(Bytes(5 * 1024 * 1024).to_string(), "5242880");
      assert_eq!(Pid(u32::MAX).to_string(), "4294967295");
      assert_eq!(ExitCode(i32::MIN).to_string(), "-2147483648");
      assert_eq!(ExitCode(i32::MAX).to_string(), "2147483647");
    }

    #[test]
    fn render_a_boolean_as_true_or_false() {
      assert_eq!(Bool(true).to_string(), "true");
      assert_eq!(Bool(false).to_string(), "false");
    }
  }

  mod states {
    use super::*;

    #[test]
    fn the_daemon_phase_renders_the_five_names_the_daemon_status_serializes() {
      let rendered: Vec<String> = [DaemonPhase::Starting, DaemonPhase::Slow, DaemonPhase::Ready, DaemonPhase::Failed, DaemonPhase::Reused].iter().map(ToString::to_string).collect();

      assert_eq!(rendered, vec!["starting", "slow", "ready", "failed", "reused"]);
    }

    #[test]
    fn the_stop_outcome_path_source_and_stream_render_snake_case() {
      assert_eq!(StopOutcome::ExitedOnSigterm.to_string(), "exited_on_sigterm");
      assert_eq!(StopOutcome::KilledAfterGrace.to_string(), "killed_after_grace");
      assert_eq!(PathSource::Shell.to_string(), "shell");
      assert_eq!(PathSource::Fallback.to_string(), "fallback");
      assert_eq!(Stream::Out.to_string(), "out");
      assert_eq!(Stream::Err.to_string(), "err");
    }
  }

  mod io_failure {
    use super::*;

    #[test]
    fn keeps_the_kind_and_the_os_error_number() {
      let failure = IoFailure::of(&io::Error::from_raw_os_error(libc::ENOENT));

      assert_eq!(failure.to_string(), "kind=not_found errno=2");
    }

    #[test]
    fn names_a_full_disk_from_its_os_error_number_whatever_the_toolchain_calls_it() {
      let failure = IoFailure::of(&io::Error::from_raw_os_error(libc::ENOSPC));

      assert_eq!(failure.to_string(), "kind=storage_full errno=28");
    }

    #[test]
    fn renders_none_when_the_error_has_no_os_error_number() {
      let failure = IoFailure::of(&io::Error::from(io::ErrorKind::TimedOut));

      assert_eq!(failure.to_string(), "kind=timed_out errno=none");
    }

    #[test]
    fn maps_a_kind_it_does_not_list_to_other() {
      let failure = IoFailure::of(&io::Error::other("boom"));

      assert_eq!(failure.to_string(), "kind=other errno=none");
    }

    #[test]
    fn never_reads_the_message() {
      let secret_message = "ghp_0123456789abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnopqrstuvwxyz";
      let error = io::Error::new(io::ErrorKind::PermissionDenied, secret_message);
      assert!(error.to_string().contains("ghp_"), "the premise: the message holds the secret");

      let failure = IoFailure::of(&error);

      let rendered = format!("{failure} {failure:?} {failure:#?}");
      assert!(!rendered.contains("ghp_"), "{rendered}");
      assert!(!rendered.contains("Bearer"), "{rendered}");
      assert!(!rendered.contains("0123456789"), "{rendered}");
      assert_eq!(failure.to_string(), "kind=permission_denied errno=none");
    }

    #[test]
    fn every_kind_renders_snake_case_and_unique() {
      let names: Vec<&str> = IoKind::ALL.iter().map(|kind| kind.as_str()).collect();

      assert!(names.iter().all(|name| is_snake_case(name)), "{names:?}");
      let mut sorted = names.clone();
      sorted.sort_unstable();
      sorted.dedup();
      assert_eq!(sorted.len(), names.len());
    }
  }

  mod json_failure {
    use super::*;

    #[test]
    fn keeps_the_category_and_the_position_of_a_syntax_error() {
      let error = serde_json::from_str::<serde_json::Value>("{\n  \"a\": nope").unwrap_err();

      let failure = JsonFailure::of(&error);

      assert_eq!(failure.to_string(), format!("category=syntax line={} col={}", error.line(), error.column()));
      assert!(failure.to_string().starts_with("category=syntax line=2 col="), "{failure}");
    }

    #[test]
    fn names_the_four_categories() {
      let syntax = serde_json::from_str::<serde_json::Value>("{]").unwrap_err();
      let data = serde_json::from_str::<u32>("\"text\"").unwrap_err();
      let eof = serde_json::from_str::<serde_json::Value>("{\"a\":").unwrap_err();
      let io_error = serde_json::from_reader::<_, serde_json::Value>(FailingReader).unwrap_err();

      assert!(JsonFailure::of(&syntax).to_string().starts_with("category=syntax"));
      assert!(JsonFailure::of(&data).to_string().starts_with("category=data"));
      assert!(JsonFailure::of(&eof).to_string().starts_with("category=eof"));
      assert!(JsonFailure::of(&io_error).to_string().starts_with("category=io"));
    }

    struct FailingReader;

    impl io::Read for FailingReader {
      fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("ghp_0123456789abcdefghijklmnopqrstuvwxyz"))
      }
    }

    #[test]
    fn never_reads_the_message() {
      let secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
      let data_error = serde_json::from_str::<u32>(&format!("\"{secret}\"")).unwrap_err();
      let io_error = serde_json::from_reader::<_, serde_json::Value>(FailingReader).unwrap_err();
      assert!(data_error.to_string().contains(secret), "the premise: a data error message quotes the value");

      for error in [data_error, io_error] {
        let failure = JsonFailure::of(&error);

        let rendered = format!("{failure} {failure:?} {failure:#?}");
        assert!(!rendered.contains("ghp_"), "{rendered}");
        assert!(!rendered.contains("0123456789"), "{rendered}");
      }
    }
  }

  mod known_code {
    use super::*;

    #[test]
    fn keeps_an_errno_name_a_sqlite_result_and_a_shared_error_code() {
      assert_eq!(KnownCode::from_name("ENOENT").to_string(), "ENOENT");
      assert_eq!(KnownCode::from_name("SQLITE_BUSY").to_string(), "SQLITE_BUSY");
      assert_eq!(KnownCode::from_name("stale_revision").to_string(), "stale_revision");
    }

    #[test]
    fn maps_an_unknown_name_to_other() {
      for name in ["", "ENOTAREALCODE", "enoent", "Stale_Revision", "ENOENT ", " ENOENT", "ENOENT\n", "ERR_SOMETHING_NEW"] {
        assert_eq!(KnownCode::from_name(name).to_string(), "other", "{name:?}");
      }
    }

    #[test]
    fn rejects_a_cloud_key_that_has_the_shape_of_an_errno_name() {
      for secret_looking in ["AKIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE", "E0123456789ABCDEFGH", "SQLITE_0123456789ABCDEF"] {
        assert_eq!(KnownCode::from_name(secret_looking).to_string(), "other", "{secret_looking}");
      }
    }

    #[test]
    fn lists_each_code_once_in_the_characters_a_log_line_allows() {
      let mut sorted = KNOWN_CODES.to_vec();
      sorted.sort_unstable();
      let before = sorted.len();
      sorted.dedup();

      assert_eq!(sorted.len(), before);
      assert!(KNOWN_CODES.iter().all(|code| code.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')));
    }

    #[test]
    fn lists_every_shared_error_code() {
      let shared_errors = include_str!("../../../../../packages/shared/src/errors.ts");
      let codes_block = shared_errors.split("export const ERROR_CODES = {").nth(1).unwrap().split("} as const satisfies").next().unwrap();
      let shared_codes: Vec<&str> = codes_block
        .lines()
        .filter_map(|line| line.trim_start().split_once(": { kind:"))
        .map(|(code, _)| code)
        .collect();

      assert!(shared_codes.len() > 50, "the extraction found {} codes", shared_codes.len());
      let missing: Vec<&&str> = shared_codes.iter().filter(|code| KnownCode::from_name(code).to_string() == "other").collect();
      assert!(missing.is_empty(), "codes of packages/shared/src/errors.ts missing from KNOWN_CODES: {missing:?}");
    }
  }

  mod path_class {
    use super::*;

    struct Paths {
      home: PathBuf,
      logs: PathBuf,
      token: PathBuf,
      bundle: PathBuf,
      user: PathBuf,
    }

    fn paths() -> Paths {
      Paths {
        home: PathBuf::from("/Users/test/.openfleet"),
        logs: PathBuf::from("/Users/test/.openfleet/logs"),
        token: PathBuf::from("/Users/test/.openfleet/admin.token"),
        bundle: PathBuf::from("/Applications/OpenFleet.app/Contents/Resources/daemon.mjs"),
        user: PathBuf::from("/Users/test"),
      }
    }

    fn classify(path: &str) -> String {
      let paths = paths();
      let known = KnownPaths { openfleet_home: &paths.home, logs_dir: &paths.logs, admin_token: &paths.token, daemon_bundle: &paths.bundle, user_home: &paths.user };
      PathClass::classify(Path::new(path), &known).to_string()
    }

    #[test]
    fn names_the_most_specific_known_location() {
      assert_eq!(classify("/Users/test/.openfleet/admin.token"), "admin_token");
      assert_eq!(classify("/Applications/OpenFleet.app/Contents/Resources/daemon.mjs"), "daemon_bundle");
      assert_eq!(classify("/Users/test/.openfleet/logs/desktop.log"), "logs_dir");
      assert_eq!(classify("/Users/test/.openfleet/logs"), "logs_dir");
      assert_eq!(classify("/Users/test/.openfleet/log.salt"), "openfleet_home");
      assert_eq!(classify("/Users/test/Documents/project"), "user_home");
    }

    #[test]
    fn classifies_every_other_path_as_other() {
      for path in ["/etc/passwd", "/Users/tester/x", "/Volumes/disk/.openfleet/logs", "relative/path", ""] {
        assert_eq!(classify(path), "other", "{path:?}");
      }
    }

    #[test]
    fn matches_whole_components_so_a_sibling_folder_of_the_home_is_not_the_home() {
      assert_eq!(classify("/Users/test/.openfleet-evil/logs"), "user_home");
    }

    #[test]
    fn does_not_trust_a_path_that_climbs_out_with_a_parent_component() {
      assert_eq!(classify("/Users/test/.openfleet/../../../etc/passwd"), "other");
      assert_eq!(classify("/Users/test/.openfleet/logs/../admin.token"), "other");
    }

    #[test]
    fn does_not_treat_a_sibling_of_the_admin_token_as_the_token() {
      assert_eq!(classify("/Users/test/.openfleet/admin.token.bak"), "openfleet_home");
      assert_eq!(classify("/Users/test/.openfleet/admin.token/extra"), "openfleet_home");
    }
  }

  mod opaque {
    use super::*;

    const SECRET_LOOKING_TEXTS: [&str; 5] = [
      "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE",
    ];

    fn every_window_of(text: &str, width: usize) -> Vec<String> {
      let characters: Vec<char> = text.chars().collect();
      characters.windows(width).map(|window| window.iter().collect()).collect()
    }

    #[test]
    fn renders_the_exact_byte_length_and_the_hash_when_the_install_has_a_salt() {
      let salt = salt_of(1);

      let rendered = Opaque::of(b"disk full", Some(&salt)).to_string();

      assert_eq!(rendered, format!("[text:9:{}]", Hash8::of(&salt, b"disk full")));
    }

    #[test]
    fn renders_the_length_alone_without_a_salt() {
      assert_eq!(Opaque::of(b"disk full", None).to_string(), "[text:9]");
    }

    #[test]
    fn counts_bytes_not_characters() {
      assert_eq!(Opaque::of("日本語".as_bytes(), None).to_string(), "[text:9]");
      assert_eq!(Opaque::of("😀".as_bytes(), None).to_string(), "[text:4]");
      assert_eq!(Opaque::of("é".as_bytes(), None).to_string(), "[text:2]");
      assert_eq!(Opaque::of(b"", None).to_string(), "[text:0]");
    }

    #[test]
    fn hashes_the_raw_bytes_of_a_text_that_is_not_utf8() {
      let salt = salt_of(1);

      let rendered = Opaque::of(&[0xff, 0xfe, 0x00, 0x80], Some(&salt)).to_string();

      assert_eq!(rendered, format!("[text:4:{}]", Hash8::of(&salt, &[0xff, 0xfe, 0x00, 0x80])));
    }

    #[test]
    fn the_same_text_under_the_same_salt_gives_the_same_tag() {
      assert_eq!(Opaque::of(b"same", Some(&salt_of(1))), Opaque::of(b"same", Some(&salt_of(1))));
    }

    #[test]
    fn the_same_text_under_another_salt_gives_another_tag() {
      assert_ne!(Opaque::of(b"same", Some(&salt_of(1))).to_string(), Opaque::of(b"same", Some(&salt_of(2))).to_string());
    }

    #[test]
    fn another_text_of_the_same_length_gives_another_tag() {
      assert_ne!(Opaque::of(b"abcd", Some(&salt_of(1))).to_string(), Opaque::of(b"abce", Some(&salt_of(1))).to_string());
    }

    #[test]
    fn no_salt_gives_no_hash() {
      let with_salt = Opaque::of(b"same", Some(&salt_of(1))).to_string();
      let without_salt = Opaque::of(b"same", None).to_string();

      assert_eq!(with_salt.matches(':').count(), 2);
      assert_eq!(without_salt.matches(':').count(), 1);
    }

    #[test]
    fn never_exposes_the_source_in_any_rendering() {
      let salt = salt_of(1);
      for secret in SECRET_LOOKING_TEXTS {
        for opaque in [Opaque::of(secret.as_bytes(), Some(&salt)), Opaque::of(secret.as_bytes(), None)] {
          let renderings = [format!("{opaque}"), format!("{opaque:?}"), format!("{opaque:#?}"), format!("{:?}", Some(opaque)), format!("{:?}", vec![opaque])];

          for rendering in &renderings {
            for window in every_window_of(secret, 6) {
              assert!(!rendering.contains(&window), "{window:?} leaked into {rendering}");
            }
          }
        }
      }
    }

    #[test]
    fn holds_no_text_inside_the_value() {
      assert_eq!(std::mem::size_of::<Opaque>(), std::mem::size_of::<(usize, Option<Hash8>)>());
    }

    #[test]
    fn handles_inputs_of_16_and_64_kibibytes_and_multibyte_text() {
      let salt = salt_of(1);
      let sixteen_kib = "a".repeat(16 * 1024);
      let sixty_four_kib = "😀".repeat(16 * 1024);
      let multibyte = "日本語é😀".repeat(100);

      assert!(Opaque::of(sixteen_kib.as_bytes(), Some(&salt)).to_string().starts_with("[text:16384:"));
      assert!(Opaque::of(sixty_four_kib.as_bytes(), Some(&salt)).to_string().starts_with("[text:65536:"));
      assert_eq!(Opaque::of(multibyte.as_bytes(), None).to_string(), format!("[text:{}]", multibyte.len()));
      assert_ne!(Opaque::of(sixteen_kib.as_bytes(), Some(&salt)), Opaque::of(format!("{sixteen_kib}b").as_bytes(), Some(&salt)));
    }

    #[test]
    fn stays_within_the_longest_value_a_log_line_allows() {
      let rendered = Opaque::of(&vec![b'x'; 5 * 1024 * 1024], Some(&salt_of(1))).to_string();

      assert!(rendered.len() <= 24, "{rendered}");
    }

    #[test]
    fn costs_a_linear_cpu_time() {
      let salt = salt_of(4);
      let measure = cpu_time_to_run_on_repeated("😀", |text| {
        std::hint::black_box(Opaque::of(text.as_bytes(), Some(&salt)));
      });

      assert_linear_growth(measure, &LinearGrowthBudget::between(16 * 1024, 1 << 20));
    }
  }
}
