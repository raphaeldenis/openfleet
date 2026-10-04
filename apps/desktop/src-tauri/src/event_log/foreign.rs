use super::event::{DesktopEvent, ForeignTarget};
use super::field::{Count, Level};
use log::{LevelFilter, Log, Metadata, Record, SetLoggerError};
use std::sync::atomic::{AtomicU64, Ordering};

const COUNTED_LEVELS: [Level; 4] = [Level::Error, Level::Warn, Level::Info, Level::Debug];
const COUNTED_TARGETS: [ForeignTarget; 8] = [
  ForeignTarget::Tauri,
  ForeignTarget::Tao,
  ForeignTarget::Wry,
  ForeignTarget::Tokio,
  ForeignTarget::Hyper,
  ForeignTarget::TauriPluginShell,
  ForeignTarget::App,
  ForeignTarget::Other,
];
/// Records below warnings are not counted: they are frequent and carry nothing a bug report needs.
const COUNTED_FROM: LevelFilter = LevelFilter::Warn;

fn level_index(level: log::Level) -> usize {
  match level {
    log::Level::Error => 0,
    log::Level::Warn => 1,
    log::Level::Info => 2,
    log::Level::Debug | log::Level::Trace => 3,
  }
}

fn target_index(target: &str) -> usize {
  let crate_name = target.split("::").next().unwrap_or("");
  let class = match crate_name {
    "tauri" => ForeignTarget::Tauri,
    "tao" => ForeignTarget::Tao,
    "wry" => ForeignTarget::Wry,
    "tokio" => ForeignTarget::Tokio,
    "hyper" => ForeignTarget::Hyper,
    "tauri_plugin_shell" => ForeignTarget::TauriPluginShell,
    "app" | "app_lib" => ForeignTarget::App,
    _ => ForeignTarget::Other,
  };
  COUNTED_TARGETS.iter().position(|counted| *counted == class).unwrap_or(COUNTED_TARGETS.len() - 1)
}

/// The `log::Log` of the desktop: it counts a record by (level, crate class) and never reads its message, target text or arguments.
pub struct AllowlistLogger {
  counts: [AtomicU64; CELL_COUNT],
}

const CELL_COUNT: usize = COUNTED_LEVELS.len() * COUNTED_TARGETS.len();

fn cell_of(level_at: usize, target_at: usize) -> usize {
  level_at * COUNTED_TARGETS.len() + target_at
}

#[allow(clippy::declare_interior_mutable_const)]
const NOT_COUNTED_YET: AtomicU64 = AtomicU64::new(0);

impl AllowlistLogger {
  pub const fn new() -> Self {
    Self { counts: [NOT_COUNTED_YET; CELL_COUNT] }
  }

  /// Returns one `foreign_records` event per non-zero (level, crate class) and resets those counts.
  pub fn drain_events(&self) -> Vec<DesktopEvent> {
    let mut events = Vec::new();
    for (level_at, level) in COUNTED_LEVELS.iter().enumerate() {
      for (target_at, target) in COUNTED_TARGETS.iter().enumerate() {
        let count = self.counts[cell_of(level_at, target_at)].swap(0, Ordering::SeqCst);
        if count > 0 {
          events.push(DesktopEvent::ForeignRecords { level: *level, target: *target, count: Count(count) });
        }
      }
    }
    events
  }
}

impl Log for AllowlistLogger {
  fn enabled(&self, metadata: &Metadata) -> bool {
    metadata.level() <= COUNTED_FROM
  }

  fn log(&self, record: &Record) {
    if !self.enabled(record.metadata()) {
      return;
    }
    self.counts[cell_of(level_index(record.level()), target_index(record.target()))].fetch_add(1, Ordering::SeqCst);
  }

  fn flush(&self) {}
}

/// The one logger of the process: counts what third-party crates log, so no foreign text reaches a sink.
pub static FOREIGN_RECORDS: AllowlistLogger = AllowlistLogger::new();

pub fn install_foreign_logger() -> Result<(), SetLoggerError> {
  log::set_logger(&FOREIGN_RECORDS)?;
  log::set_max_level(COUNTED_FROM);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::field::Level as EventLevel;

  fn record_of(logger: &AllowlistLogger, level: log::Level, target: &str, message: &str) {
    logger.log(&Record::builder().level(level).target(target).args(format_args!("{message}")).build());
  }

  fn rendered(logger: &AllowlistLogger) -> Vec<String> {
    let now = crate::event_log::Ts::from_unix_seconds(0).unwrap();
    logger.drain_events().iter().map(|event| event.render(now).to_string()).collect()
  }

  #[test]
  fn counts_records_by_level_and_crate_class_and_renders_one_line_per_cell() {
    let logger = AllowlistLogger::new();
    for _ in 0..3 {
      record_of(&logger, log::Level::Warn, "tauri::manager", "a");
    }
    record_of(&logger, log::Level::Error, "wry::webview", "b");
    record_of(&logger, log::Level::Warn, "tauri_plugin_shell::process", "c");

    let lines = rendered(&logger);

    assert_eq!(
      lines,
      vec![
        "1970-01-01T00:00:00Z error foreign_records target=wry count=1",
        "1970-01-01T00:00:00Z warn foreign_records target=tauri count=3",
        "1970-01-01T00:00:00Z warn foreign_records target=tauri_plugin_shell count=1",
      ]
    );
  }

  #[test]
  fn a_second_drain_starts_from_zero() {
    let logger = AllowlistLogger::new();
    record_of(&logger, log::Level::Warn, "hyper::client", "a");

    assert_eq!(rendered(&logger).len(), 1);
    assert!(rendered(&logger).is_empty());
  }

  #[test]
  fn an_unknown_or_lookalike_crate_is_counted_as_other() {
    let logger = AllowlistLogger::new();
    for target in ["some_crate", "tauri_runtime", "tauri-evil", "", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"] {
      record_of(&logger, log::Level::Warn, target, "x");
    }

    assert_eq!(rendered(&logger), vec!["1970-01-01T00:00:00Z warn foreign_records target=other count=5"]);
  }

  #[test]
  fn our_own_crate_is_counted_as_app() {
    let logger = AllowlistLogger::new();
    record_of(&logger, log::Level::Error, "app_lib::daemon", "x");

    assert_eq!(rendered(&logger), vec!["1970-01-01T00:00:00Z error foreign_records target=app count=1"]);
  }

  #[test]
  fn records_below_warnings_are_not_counted() {
    let logger = AllowlistLogger::new();
    record_of(&logger, log::Level::Info, "tauri", "x");
    record_of(&logger, log::Level::Debug, "tauri", "x");
    record_of(&logger, log::Level::Trace, "tauri", "x");

    assert!(rendered(&logger).is_empty());
  }

  #[test]
  fn the_message_of_a_record_reaches_no_line() {
    let logger = AllowlistLogger::new();
    record_of(&logger, log::Level::Error, "tauri", "Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz");

    let lines = rendered(&logger).join("\n");

    assert!(!lines.contains("ghp_") && !lines.contains("Bearer"), "{lines}");
  }

  #[test]
  fn the_message_is_never_formatted() {
    struct PanicsWhenFormatted;
    impl std::fmt::Display for PanicsWhenFormatted {
      fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        panic!("the logger formatted the message");
      }
    }
    let logger = AllowlistLogger::new();

    logger.log(&Record::builder().level(log::Level::Error).target("tauri").args(format_args!("{}", PanicsWhenFormatted)).build());

    assert_eq!(rendered(&logger).len(), 1);
  }

  #[test]
  fn every_counted_level_and_target_renders_a_valid_event() {
    let logger = AllowlistLogger::new();
    for target in ["tauri", "tao", "wry", "tokio", "hyper", "tauri_plugin_shell", "app", "x"] {
      record_of(&logger, log::Level::Warn, target, "x");
      record_of(&logger, log::Level::Error, target, "x");
    }

    let events = logger.drain_events();

    assert_eq!(events.len(), 16);
    assert!(events.iter().all(|event| matches!(event, DesktopEvent::ForeignRecords { level, .. } if *level == EventLevel::Warn || *level == EventLevel::Error)));
  }
}
