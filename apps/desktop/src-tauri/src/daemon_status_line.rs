//! The line the webview shows about a daemon that did not start, built from typed causes only: no daemon text reaches it.

use crate::event_log::{ExitCode, Opaque, SpawnFailure};
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

const BOOT_REFUSAL_PREFIX: &str = "openfleet: refusing to boot";
const NODE_FATAL_PREFIXES: [&str; 5] = ["node:", "Node.js v", "FATAL ERROR:", "<--- ", "at "];
const REFUSAL_CATALOGUE: &str = include_str!("../boot_refusals.txt");
const HINT_OPENING: &str = " (";
const SAVE_A_BUNDLE: &str = "Settings → Diagnostics → Export diagnostics bundle";

/// Why the daemon refused to boot, read from the catalogue of the hints it appends (`boot_refusals.txt`); any other refusal is `Unlisted`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RefusalReason {
  PortInUse,
  PortInvalid,
  PathNotPermitted,
  SchemaNewerThanCode,
  MigrationFailed,
  ConfigFileInvalid,
  Unlisted(Opaque),
}

impl RefusalReason {
  pub const LISTED: [RefusalReason; 6] = [
    RefusalReason::PortInUse,
    RefusalReason::PortInvalid,
    RefusalReason::PathNotPermitted,
    RefusalReason::SchemaNewerThanCode,
    RefusalReason::MigrationFailed,
    RefusalReason::ConfigFileInvalid,
  ];

  pub fn id(self) -> &'static str {
    match self {
      RefusalReason::PortInUse => "port_in_use",
      RefusalReason::PortInvalid => "port_invalid",
      RefusalReason::PathNotPermitted => "path_not_permitted",
      RefusalReason::SchemaNewerThanCode => "schema_newer_than_code",
      RefusalReason::MigrationFailed => "migration_failed",
      RefusalReason::ConfigFileInvalid => "config_file_invalid",
      RefusalReason::Unlisted(_) => "unlisted",
    }
  }

  /// Returns the first catalogued reason whose hint follows ` (` in `refusal_line`, else `Unlisted` with the line reduced to `opaque`.
  fn of_refusal_line(refusal_line: &str, opaque: Opaque) -> Self {
    let listed_id = catalogue_entries().find(|(_, literal)| refusal_line.contains(&format!("{HINT_OPENING}{literal}"))).map(|(id, _)| id);
    let listed_reason = listed_id.and_then(|id| RefusalReason::LISTED.into_iter().find(|reason| reason.id() == id));
    listed_reason.unwrap_or(RefusalReason::Unlisted(opaque))
  }

  fn copy(self) -> String {
    match self {
      RefusalReason::PortInUse => "its port is already in use: stop the other process, then check again".to_string(),
      RefusalReason::PortInvalid => "OPENFLEET_PORT is not a port: set it between 0 and 65535, or unset it".to_string(),
      RefusalReason::PathNotPermitted => "it may not read or write one of its folders: check the permissions of the OpenFleet folder".to_string(),
      RefusalReason::SchemaNewerThanCode => "the database is newer than this app: install the newer app, or restore a backup from before the upgrade".to_string(),
      RefusalReason::MigrationFailed => "the database upgrade failed: a backup from before the upgrade was saved".to_string(),
      RefusalReason::ConfigFileInvalid => "config.json is not valid: fix it, then check again".to_string(),
      RefusalReason::Unlisted(text) => format!("for an unlisted reason ({text}); {SAVE_A_BUNDLE}"),
    }
  }
}

fn catalogue_entries() -> impl Iterator<Item = (&'static str, &'static str)> {
  REFUSAL_CATALOGUE.lines().filter_map(|entry| entry.split_once(' '))
}

/// What the webview learns about why the daemon is not running: a typed cause, rendered to one line of fixed copy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StatusLine {
  BootRefusal(RefusalReason),
  NodeFatal,
  Exited(Option<ExitCode>),
  NoAnswer { seconds: u64 },
  SpawnFailed(SpawnFailure),
  Unrecognised(Opaque),
}

impl StatusLine {
  /// Classifies one line the daemon wrote on stderr; `opaque` is all that remains of its text.
  pub fn of_stderr_line(line: &str, opaque: Opaque) -> Self {
    let text = line.trim_start();
    let is_boot_refusal = text.starts_with(BOOT_REFUSAL_PREFIX);
    let is_node_fatal = NODE_FATAL_PREFIXES.iter().any(|prefix| text.starts_with(prefix));
    match (is_boot_refusal, is_node_fatal) {
      (true, _) => StatusLine::BootRefusal(RefusalReason::of_refusal_line(text, opaque)),
      (false, true) => StatusLine::NodeFatal,
      (false, false) => StatusLine::Unrecognised(opaque),
    }
  }

  pub fn kind(&self) -> &'static str {
    match self {
      StatusLine::BootRefusal(_) => "boot_refusal",
      StatusLine::NodeFatal => "node_fatal",
      StatusLine::Exited(_) => "exited",
      StatusLine::NoAnswer { .. } => "no_answer",
      StatusLine::SpawnFailed(_) => "spawn_failed",
      StatusLine::Unrecognised(_) => "unrecognised",
    }
  }

  /// Returns the line the webview shows: fixed copy around typed values, never daemon text.
  pub fn render(&self) -> String {
    match self {
      StatusLine::BootRefusal(reason) => format!("the daemon refused to boot: {}", reason.copy()),
      StatusLine::NodeFatal => format!("the daemon stopped on a fatal Node.js error; {SAVE_A_BUNDLE}"),
      StatusLine::Exited(Some(code)) => format!("the daemon exited with code {code}"),
      StatusLine::Exited(None) => "the daemon was stopped by a signal".to_string(),
      StatusLine::NoAnswer { seconds } => format!("the daemon did not answer within {seconds}s"),
      StatusLine::SpawnFailed(failure) => spawn_failure_copy(failure),
      StatusLine::Unrecognised(text) => format!("the daemon wrote an unrecognised error ({text}); {SAVE_A_BUNDLE}"),
    }
  }
}

fn spawn_failure_copy(failure: &SpawnFailure) -> String {
  match failure {
    SpawnFailure::BundleNotFound(_) => "daemon bundle not found (run: pnpm --filter @openfleet/core bundle)".to_string(),
    SpawnFailure::Io(io_failure) => format!("could not start the daemon: {io_failure}"),
    SpawnFailure::Unclassified(opaque) => format!("could not start the daemon: {opaque}"),
  }
}

/// Serialises as the `lastLine`, `lastLineKind` and, for a refusal, `refusalReason` keys of the daemon status.
impl Serialize for StatusLine {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    let mut entries = serializer.serialize_map(None)?;
    entries.serialize_entry("lastLine", &self.render())?;
    entries.serialize_entry("lastLineKind", self.kind())?;
    if let StatusLine::BootRefusal(reason) = self {
      entries.serialize_entry("refusalReason", reason.id())?;
    }
    entries.end()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::{IoFailure, PathClass};

  fn opaque(line: &str) -> Opaque {
    Opaque::of(line.as_bytes(), None)
  }

  fn status_line_of(line: &str) -> StatusLine {
    StatusLine::of_stderr_line(line, opaque(line))
  }

  #[test]
  fn names_each_catalogued_refusal_by_the_hint_the_daemon_appends() {
    let refusals = [
      ("openfleet: refusing to boot: port 7331 is already in use (stop the other process or set OPENFLEET_PORT)", RefusalReason::PortInUse),
      ("openfleet: refusing to boot: options.port should be >= 0 (set OPENFLEET_PORT to a port between 0 and 65535)", RefusalReason::PortInvalid),
      ("openfleet: refusing to boot: EACCES: denied (check the permissions of /Users/jdoe/.openfleet/sessions)", RefusalReason::PathNotPermitted),
      ("openfleet: refusing to boot: schema newer (quit the app, delete openfleet.db-wal and openfleet.db-shm, then copy the .db backup named x in y, never a .config.json copy, over openfleet.db; or install the newer app)", RefusalReason::SchemaNewerThanCode),
      ("openfleet: refusing to boot: no such table (the database from before this upgrade is saved at /b/x.db: quit the app, delete openfleet.db-wal and openfleet.db-shm, then copy it over openfleet.db)", RefusalReason::MigrationFailed),
      ("openfleet: refusing to boot (config: /Users/jdoe/.openfleet/config.json): workingState.maxAgeMinutes: too small", RefusalReason::ConfigFileInvalid),
    ];

    for (line, expected) in refusals {
      assert_eq!(status_line_of(line), StatusLine::BootRefusal(expected), "{line}");
    }
  }

  #[test]
  fn keeps_only_the_length_and_tag_of_an_unlisted_refusal() {
    let line = "openfleet: refusing to boot: admin token is too short";

    assert_eq!(status_line_of(line), StatusLine::BootRefusal(RefusalReason::Unlisted(opaque(line))));
    assert_eq!(status_line_of(line).render(), format!("the daemon refused to boot: for an unlisted reason ([text:{}]); {SAVE_A_BUNDLE}", line.len()));
  }

  #[test]
  fn tells_a_node_fatal_marker_from_unrecognised_text() {
    assert_eq!(status_line_of("FATAL ERROR: Reached heap limit Allocation failed"), StatusLine::NodeFatal);
    assert_eq!(status_line_of("Node.js v22.11.0"), StatusLine::NodeFatal);
    assert_eq!(status_line_of("Error: boom"), StatusLine::Unrecognised(opaque("Error: boom")));
  }

  #[test]
  fn is_not_a_boot_refusal_when_the_prefix_is_only_inside_the_line() {
    let line = "x openfleet: refusing to boot (stop the other process or set OPENFLEET_PORT)";

    assert_eq!(status_line_of(line), StatusLine::Unrecognised(opaque(line)));
  }

  #[test]
  fn every_listed_reason_has_a_catalogue_entry_and_every_entry_a_listed_reason() {
    let catalogue_ids: Vec<&str> = catalogue_entries().map(|(id, _)| id).collect();
    let listed_ids: Vec<&str> = RefusalReason::LISTED.iter().map(|reason| reason.id()).collect();

    assert_eq!(catalogue_ids, listed_ids);
  }

  #[test]
  fn renders_each_cause_as_fixed_copy() {
    assert_eq!(StatusLine::Exited(Some(ExitCode(3))).render(), "the daemon exited with code 3");
    assert_eq!(StatusLine::Exited(None).render(), "the daemon was stopped by a signal");
    assert_eq!(StatusLine::NoAnswer { seconds: 315 }.render(), "the daemon did not answer within 315s");
    assert_eq!(StatusLine::BootRefusal(RefusalReason::PortInUse).render(), "the daemon refused to boot: its port is already in use: stop the other process, then check again");
    assert_eq!(StatusLine::Unrecognised(opaque("Error: boom")).render(), format!("the daemon wrote an unrecognised error ([text:11]); {SAVE_A_BUNDLE}"));
  }

  #[test]
  fn tells_a_spawn_failure_by_its_typed_cause() {
    let missing_bundle = StatusLine::SpawnFailed(SpawnFailure::BundleNotFound(PathClass::DaemonBundle));
    let io_failure = StatusLine::SpawnFailed(SpawnFailure::Io(IoFailure::of(&std::io::Error::new(std::io::ErrorKind::PermissionDenied, "open /Users/jdoe/secret-path failed"))));

    assert_eq!(missing_bundle.render(), "daemon bundle not found (run: pnpm --filter @openfleet/core bundle)");
    assert_eq!(io_failure.render(), "could not start the daemon: kind=permission_denied errno=none");
  }

  #[test]
  fn serialises_the_line_its_kind_and_the_reason_of_a_refusal() {
    let refusal = serde_json::to_string(&StatusLine::BootRefusal(RefusalReason::PortInUse)).unwrap();
    let exit = serde_json::to_string(&StatusLine::Exited(Some(ExitCode(1)))).unwrap();

    assert_eq!(refusal, r#"{"lastLine":"the daemon refused to boot: its port is already in use: stop the other process, then check again","lastLineKind":"boot_refusal","refusalReason":"port_in_use"}"#);
    assert_eq!(exit, r#"{"lastLine":"the daemon exited with code 1","lastLineKind":"exited"}"#);
  }
}
