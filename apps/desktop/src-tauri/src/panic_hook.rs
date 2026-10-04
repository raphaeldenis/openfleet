use crate::event_log::{Count, DesktopEvent};
use crate::log_file::DesktopLog;
use std::panic::Location;
use std::sync::OnceLock;

static PANIC_LOG: OnceLock<DesktopLog> = OnceLock::new();

/// Replaces the default panic hook: a panic logs its source line and column and nothing of its payload.
pub fn install() {
  std::panic::set_hook(Box::new(|info| {
    if let Some(daemon_log) = PANIC_LOG.get() {
      record_panic(daemon_log, info.location());
    }
  }));
}

/// Sets the log the hook writes to; the first call wins.
pub fn attach_log(daemon_log: DesktopLog) {
  let _ = PANIC_LOG.set(daemon_log);
}

fn record_panic(daemon_log: &DesktopLog, location: Option<&Location>) {
  let (line, column) = location.map_or((0, 0), |location| (location.line(), location.column()));
  daemon_log.record_event(DesktopEvent::PanicRecorded { line: Count(u64::from(line)), column: Count(u64::from(column)) });
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::log_file::{start_on_disk, LOG_FILE_NAME};
  use std::time::Duration;

  struct ScratchFolder(std::path::PathBuf);

  impl Drop for ScratchFolder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn scratch_folder(name: &str) -> ScratchFolder {
    let folder = std::env::temp_dir().join(format!("of-panic-hook-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    ScratchFolder(folder)
  }

  fn stored_lines_after_a_panic_at(location: Option<&Location>) -> Vec<String> {
    let home = scratch_folder("stored");
    let daemon_log = start_on_disk(&home.0, || 0);

    record_panic(&daemon_log, location);

    assert!(daemon_log.flush_and_close(Duration::from_secs(5)));
    crate::log_file::last_lines(&home.0.join("logs").join(LOG_FILE_NAME), 10)
  }

  #[test]
  fn a_panic_logs_its_line_and_column() {
    let location = Location::caller();

    let lines = stored_lines_after_a_panic_at(Some(location));

    let expected = format!("1970-01-01T00:00:00Z error panic_recorded line={} column={}", location.line(), location.column());
    assert_eq!(lines[0], expected);
  }

  #[test]
  fn a_panic_without_a_location_logs_zeros() {
    let lines = stored_lines_after_a_panic_at(None);

    assert_eq!(lines[0], "1970-01-01T00:00:00Z error panic_recorded line=0 column=0");
  }
}
