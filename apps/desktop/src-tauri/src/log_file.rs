use crate::admin_token::openfleet_home_dir;
use crate::event_log::{Bool, DaemonLineAssembler, DesktopEvent, IoFailure, Opaque, Salt, SanitizedLine, Stream, Ts, Count};
use std::ffi::OsStr;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, sync_channel, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
pub const KEPT_FILES: usize = 3;
pub const LOG_FILE_NAME: &str = "desktop.log";
const LEGACY_LOG_FILE_NAME: &str = "daemon.log";
const CHANNEL_CAPACITY: usize = 2048;
const PRIVATE_DIR_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// The filesystem operations rotation needs; the seam that lets rotation run against a fake.
pub trait LogFs {
  fn size(&self, path: &Path) -> io::Result<u64>;
  fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
  fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
}

pub struct DiskFs;

impl LogFs for DiskFs {
  fn size(&self, path: &Path) -> io::Result<u64> {
    std::fs::metadata(path).map(|metadata| metadata.len())
  }

  #[allow(clippy::disallowed_methods)]
  fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(folder) = path.parent() {
      ensure_private_dir(folder)?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).mode(PRIVATE_FILE_MODE).open(path)?;
    file.write_all(bytes)
  }

  fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
    std::fs::rename(from, to)
  }
}

/// Returns `$OPENFLEET_HOME/logs`, else `~/.openfleet/logs`.
pub fn logs_dir(openfleet_home: Option<String>, user_home: &Path) -> PathBuf {
  openfleet_home_dir(openfleet_home, user_home).join("logs")
}

/// Creates the folder (and its parents) readable by the owner only.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
  std::fs::DirBuilder::new().recursive(true).mode(PRIVATE_DIR_MODE).create(dir)
}

/// Appends lines to `path`, rotating to `path.1`, `path.2`, … so the current file never exceeds `max_bytes`.
pub struct RotatingLog<F: LogFs> {
  fs: F,
  path: PathBuf,
  max_bytes: u64,
  kept_files: usize,
  size: u64,
}

impl<F: LogFs> RotatingLog<F> {
  pub fn open(fs: F, path: PathBuf, max_bytes: u64, kept_files: usize) -> Self {
    let size = fs.size(&path).unwrap_or(0);
    Self { fs, path, max_bytes, kept_files, size }
  }

  /// Writes the line and a newline; a failing rotation is skipped, never raised.
  pub fn append_line(&mut self, line: &SanitizedLine) -> io::Result<()> {
    let bytes = self.line_bytes(line);
    let would_pass_the_limit = self.size + bytes.len() as u64 > self.max_bytes;
    let has_content_to_rotate = self.size > 0;
    if would_pass_the_limit && has_content_to_rotate {
      self.rotate();
    }
    self.fs.append(&self.path, &bytes)?;
    self.size += bytes.len() as u64;
    Ok(())
  }

  /// A line is ASCII by the grammar, so the cut that keeps the file within its limit never splits a character.
  fn line_bytes(&self, line: &SanitizedLine) -> Vec<u8> {
    let room_for_the_text = self.max_bytes.saturating_sub(1) as usize;
    let text = line.as_str().as_bytes();
    let kept_text = &text[..room_for_the_text.min(text.len())];
    [kept_text, b"\n"].concat()
  }

  // ponytail: when the current file cannot be renamed it keeps growing past the limit until a rename works again.
  fn rotate(&mut self) {
    let mut current_file_moved = false;
    for generation in (1..self.kept_files).rev() {
      let from = if generation == 1 { self.path.clone() } else { numbered(&self.path, generation - 1) };
      let moved = self.fs.rename(&from, &numbered(&self.path, generation)).is_ok();
      if generation == 1 {
        current_file_moved = moved;
      }
    }
    if current_file_moved {
      self.size = 0;
    }
  }
}

fn numbered(path: &Path, generation: usize) -> PathBuf {
  let mut name = path.as_os_str().to_os_string();
  name.push(format!(".{generation}"));
  PathBuf::from(name)
}

/// Returns the last `count` lines of the log, topping up from `path.1`.
pub fn last_lines(path: &Path, count: usize) -> Vec<String> {
  let current = lines_of(path);
  let rotated = if current.len() < count { lines_of(&numbered(path, 1)) } else { Vec::new() };
  let all_lines: Vec<String> = rotated.into_iter().chain(current).collect();
  let first_kept = all_lines.len().saturating_sub(count);
  all_lines[first_kept..].to_vec()
}

// ponytail: reads the whole file (at most 5 MB); seek from the end if this ever shows up in a profile.
fn lines_of(path: &Path) -> Vec<String> {
  let bytes = std::fs::read(path).unwrap_or_default();
  String::from_utf8_lossy(&bytes).lines().map(str::to_string).collect()
}

/// Deletes `daemon.log`, `daemon.log.1`, … written by an earlier version: a pattern masker wrote them and they can hold secrets.
pub fn delete_legacy_logs(logs_dir: &Path) {
  let Ok(entries) = std::fs::read_dir(logs_dir) else { return };
  for entry in entries.flatten().filter(|entry| is_legacy_log_name(&entry.file_name())) {
    let _ = std::fs::remove_file(entry.path());
  }
}

fn is_legacy_log_name(file_name: &OsStr) -> bool {
  let Some(name) = file_name.to_str() else { return false };
  let Some(suffix) = name.strip_prefix(LEGACY_LOG_FILE_NAME) else { return false };
  let is_current_file = suffix.is_empty();
  let is_rotated_generation = suffix.strip_prefix('.').is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()));
  is_current_file || is_rotated_generation
}

fn timestamp_at(unix_seconds: u64) -> Ts {
  Ts::from_unix_seconds(unix_seconds).unwrap_or_else(|| Ts::from_unix_seconds(0).expect("the epoch is a valid timestamp"))
}

enum Message {
  Event(Box<DesktopEvent>),
  DaemonChunk(Stream, Vec<u8>),
  /// Stops the writer once every message queued before it is written, then acknowledges.
  Close(mpsc::Sender<()>),
}

/// The writer thread's state: rotating file, the line assemblers of the two daemon streams, and what it failed to write.
struct LogWriter<F: LogFs> {
  log: RotatingLog<F>,
  salt: Option<Arc<Salt>>,
  clock: Box<dyn Fn() -> u64 + Send>,
  out_assembler: DaemonLineAssembler,
  err_assembler: DaemonLineAssembler,
  messages_dropped_by_the_queue: Arc<AtomicU64>,
  lines_lost_to_write_errors: u64,
  last_write_failure: Option<IoFailure>,
}

impl<F: LogFs> LogWriter<F> {
  fn run(mut self, messages: mpsc::Receiver<Message>) {
    for message in messages {
      match message {
        Message::Event(event) => self.write_events(&[*event]),
        Message::DaemonChunk(stream, bytes) => self.write_daemon_chunk(stream, &bytes),
        Message::Close(acknowledge) => {
          self.write_unfinished_daemon_lines();
          self.write_events(&[DesktopEvent::DaemonLogFlushed { drained: Bool(true) }]);
          let _ = acknowledge.send(());
          return;
        }
      }
    }
  }

  fn write_daemon_chunk(&mut self, stream: Stream, bytes: &[u8]) {
    let salt = self.salt.as_deref();
    let assembler = match stream {
      Stream::Out => &mut self.out_assembler,
      Stream::Err => &mut self.err_assembler,
    };
    let events = assembler.push_chunk(bytes, salt);
    self.write_events(&events);
  }

  fn write_unfinished_daemon_lines(&mut self) {
    let salt = self.salt.as_deref();
    let unfinished_events: Vec<DesktopEvent> = [&mut self.out_assembler, &mut self.err_assembler].into_iter().filter_map(|assembler| assembler.flush(salt)).collect();
    self.write_events(&unfinished_events);
  }

  fn write_events(&mut self, events: &[DesktopEvent]) {
    let now = timestamp_at((self.clock)());
    self.report_lost_lines(now);
    for event in events {
      self.append(&event.render(now));
    }
  }

  fn append(&mut self, line: &SanitizedLine) -> bool {
    match self.log.append_line(line) {
      Ok(()) => true,
      Err(error) => {
        self.lines_lost_to_write_errors += 1;
        self.last_write_failure = Some(IoFailure::of(&error));
        false
      }
    }
  }

  /// Writes one notice per cause; a count is cleared only once its notice is in the file.
  fn report_lost_lines(&mut self, now: Ts) {
    let dropped = self.messages_dropped_by_the_queue.load(Ordering::SeqCst);
    if dropped > 0 && self.append_notice(now, DesktopEvent::WriterDropped { count: Count(dropped) }) {
      self.messages_dropped_by_the_queue.fetch_sub(dropped, Ordering::SeqCst);
    }
    if self.lines_lost_to_write_errors > 0 {
      let failure = self.last_write_failure.unwrap_or_else(|| IoFailure::of(&io::Error::from(io::ErrorKind::Other)));
      let notice = DesktopEvent::WriterLost { count: Count(self.lines_lost_to_write_errors), failure };
      if self.append_notice(now, notice) {
        self.lines_lost_to_write_errors = 0;
        self.last_write_failure = None;
      }
    }
  }

  fn append_notice(&mut self, now: Ts, notice: DesktopEvent) -> bool {
    self.log.append_line(&notice.render(now)).is_ok()
  }
}

/// Hands desktop events and daemon output to a writer thread; never blocks the caller and counts what it had to drop.
/// The only way into the file is a typed event or a daemon chunk, which the writer projects onto the allowlist.
#[derive(Clone)]
pub struct DesktopLog {
  sender: SyncSender<Message>,
  salt: Option<Arc<Salt>>,
  messages_dropped_by_the_queue: Arc<AtomicU64>,
  output_ended: Arc<AtomicBool>,
}

impl DesktopLog {
  /// `salt` keys the tag of every free text; without one a text is reduced to its length.
  pub fn start<F: LogFs + Send + 'static>(log: RotatingLog<F>, salt: Option<Salt>, clock: impl Fn() -> u64 + Send + 'static) -> Self {
    Self::start_with_capacity(log, salt, clock, CHANNEL_CAPACITY)
  }

  pub fn start_with_capacity<F: LogFs + Send + 'static>(log: RotatingLog<F>, salt: Option<Salt>, clock: impl Fn() -> u64 + Send + 'static, capacity: usize) -> Self {
    let (sender, receiver) = sync_channel::<Message>(capacity);
    let salt = salt.map(Arc::new);
    let messages_dropped_by_the_queue = Arc::new(AtomicU64::new(0));
    let writer = LogWriter {
      log,
      salt: salt.clone(),
      clock: Box::new(clock),
      out_assembler: DaemonLineAssembler::new(Stream::Out),
      err_assembler: DaemonLineAssembler::new(Stream::Err),
      messages_dropped_by_the_queue: messages_dropped_by_the_queue.clone(),
      lines_lost_to_write_errors: 0,
      last_write_failure: None,
    };
    std::thread::spawn(move || writer.run(receiver));
    Self { sender, salt, messages_dropped_by_the_queue, output_ended: Arc::new(AtomicBool::new(false)) }
  }

  /// Reduces a free text to its length and its tag under this install's salt.
  pub fn opaque(&self, text: &[u8]) -> Opaque {
    Opaque::of(text, self.salt.as_deref())
  }

  /// Queues an event; the writer stamps it with its clock.
  pub fn record_event(&self, event: DesktopEvent) {
    self.queue(Message::Event(Box::new(event)));
  }

  /// Queues a chunk of the daemon's output; the writer joins chunks into lines and logs each line projected onto the allowlist.
  pub fn ingest_daemon_chunk(&self, stream: Stream, chunk: &[u8]) {
    self.queue(Message::DaemonChunk(stream, chunk.to_vec()));
  }

  fn queue(&self, message: Message) {
    let queue_is_full = matches!(self.sender.try_send(message), Err(TrySendError::Full(_)));
    if queue_is_full {
      self.messages_dropped_by_the_queue.fetch_add(1, Ordering::SeqCst);
    }
  }

  /// Marks that the daemon's output pipe has delivered its last event.
  pub fn mark_output_ended(&self) {
    self.output_ended.store(true, Ordering::SeqCst);
  }

  /// Waits up to half of `timeout` for the output to end, then drains the queue and stops the writer within the other half.
  pub fn close_after_output_ends(&self, timeout: Duration) -> bool {
    let waiting_until = Instant::now() + timeout / 2;
    while !self.output_ended.load(Ordering::SeqCst) && Instant::now() < waiting_until {
      std::thread::sleep(CLOSE_POLL_INTERVAL);
    }
    self.flush_and_close(timeout / 2)
  }

  /// Drains the queue, writes the unfinished daemon lines and a `daemon_log_flushed` line, and stops the writer; false when it did not finish within `timeout`.
  pub fn flush_and_close(&self, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let (acknowledge, acknowledged) = mpsc::channel();
    let mut close = Message::Close(acknowledge);
    loop {
      match self.sender.try_send(close) {
        Ok(()) => break,
        Err(TrySendError::Disconnected(_)) => return true,
        Err(TrySendError::Full(unsent)) => {
          if Instant::now() >= deadline {
            return false;
          }
          close = unsent;
          std::thread::sleep(CLOSE_POLL_INTERVAL);
        }
      }
    }
    acknowledged.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_ok()
  }
}

/// Starts the desktop log of an install: deletes the files an earlier version wrote, loads or creates the salt in `openfleet_home`,
/// and appends to `<openfleet_home>/logs/desktop.log`.
pub fn start_on_disk(openfleet_home: &Path, clock: impl Fn() -> u64 + Send + 'static) -> DesktopLog {
  let logs_folder = openfleet_home.join("logs");
  delete_legacy_logs(&logs_folder);
  let salt = ensure_private_dir(openfleet_home).ok().and_then(|()| Salt::load_or_create(openfleet_home));
  let rotating_log = RotatingLog::open(DiskFs, logs_folder.join(LOG_FILE_NAME), MAX_LOG_BYTES, KEPT_FILES);
  DesktopLog::start(rotating_log, salt, clock)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::{DaemonTextClass, Pid, SALT_FILE_NAME};
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::mpsc;
  use std::sync::Mutex;

  const LOG: &str = "/logs/desktop.log";
  const EPOCH_PREFIX: &str = "1970-01-01T00:00:00Z";
  /// `<ts> info daemon_stop_requested pid=N` plus its newline, for a one-digit pid.
  const ONE_LINE_BYTES: u64 = 54;

  #[derive(Default)]
  struct FakeFs {
    files: Mutex<HashMap<PathBuf, Vec<u8>>>,
    rename_fails: AtomicBool,
    first_append_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    appends_failing_with: Mutex<Option<String>>,
    failed_appends: AtomicUsize,
  }

  impl FakeFs {
    /// Makes every append whose text contains `fragment` fail; an empty fragment fails them all.
    fn fail_appends_containing(&self, fragment: &str) {
      *self.appends_failing_with.lock().unwrap() = Some(fragment.to_string());
    }
    fn stop_failing_appends(&self) {
      *self.appends_failing_with.lock().unwrap() = None;
    }
    fn failed_append_count(&self) -> usize {
      self.failed_appends.load(Ordering::SeqCst)
    }
    fn text(&self, path: &str) -> String {
      self.files.lock().unwrap().get(Path::new(path)).map(|bytes| String::from_utf8_lossy(bytes).to_string()).unwrap_or_default()
    }
    fn lines(&self, path: &str) -> Vec<String> {
      self.text(path).lines().map(str::to_string).collect()
    }
    fn exists(&self, path: &str) -> bool {
      self.files.lock().unwrap().contains_key(Path::new(path))
    }
    fn seed(&self, path: &str, content: &str) {
      self.files.lock().unwrap().insert(PathBuf::from(path), content.as_bytes().to_vec());
    }
  }

  impl LogFs for Arc<FakeFs> {
    fn size(&self, path: &Path) -> io::Result<u64> {
      self.files.lock().unwrap().get(path).map(|bytes| bytes.len() as u64).ok_or_else(|| io::ErrorKind::NotFound.into())
    }
    fn append(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
      let gate = self.first_append_gate.lock().unwrap().take();
      if let Some((entered, release)) = gate {
        entered.send(()).unwrap();
        release.recv().unwrap();
      }
      let failing_fragment = self.appends_failing_with.lock().unwrap().clone();
      if failing_fragment.is_some_and(|fragment| String::from_utf8_lossy(bytes).contains(&fragment)) {
        self.failed_appends.fetch_add(1, Ordering::SeqCst);
        return Err(io::Error::other("disk full"));
      }
      self.files.lock().unwrap().entry(path.to_path_buf()).or_default().extend_from_slice(bytes);
      Ok(())
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
      if self.rename_fails.load(Ordering::SeqCst) {
        return Err(io::Error::other("rename refused"));
      }
      let mut files = self.files.lock().unwrap();
      let content = files.remove(from).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
      files.insert(to.to_path_buf(), content);
      Ok(())
    }
  }

  /// A folder under the system temp dir that is removed when the guard drops, whatever the test outcome.
  struct ScratchFolder(PathBuf);

  impl ScratchFolder {
    fn new(name: &str) -> Self {
      let folder = std::env::temp_dir().join(format!("of-log-file-{name}-{}", std::process::id()));
      let _ = std::fs::remove_dir_all(&folder);
      std::fs::create_dir_all(&folder).unwrap();
      Self(folder)
    }

    fn path(&self) -> &Path {
      &self.0
    }
  }

  impl Drop for ScratchFolder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn rotating(fs: &Arc<FakeFs>, max_bytes: u64) -> RotatingLog<Arc<FakeFs>> {
    RotatingLog::open(fs.clone(), PathBuf::from(LOG), max_bytes, KEPT_FILES)
  }

  fn wait_until(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
      assert!(Instant::now() < deadline, "condition not met within 5s");
      std::thread::sleep(Duration::from_millis(5));
    }
  }

  fn stop_requested(pid: u32) -> DesktopEvent {
    DesktopEvent::DaemonStopRequested { pid: Pid(pid) }
  }

  /// The line the writer stores for `stop_requested(pid)` at the epoch.
  fn stop_requested_line(pid: u32) -> SanitizedLine {
    stop_requested(pid).render(timestamp_at(0))
  }

  fn stored_stop_requested(pid: u32) -> String {
    format!("{EPOCH_PREFIX} info daemon_stop_requested pid={pid}")
  }

  // ---- rotation ----

  #[test]
  fn appends_lines_to_the_current_file() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 1000);

    log.append_line(&stop_requested_line(1)).unwrap();
    log.append_line(&stop_requested_line(2)).unwrap();

    assert_eq!(fs.lines(LOG), vec![stored_stop_requested(1), stored_stop_requested(2)]);
  }

  #[test]
  fn keeps_writing_in_the_current_file_up_to_exactly_the_limit() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 2 * ONE_LINE_BYTES);

    log.append_line(&stop_requested_line(1)).unwrap();
    log.append_line(&stop_requested_line(2)).unwrap();

    assert_eq!(fs.lines(LOG).len(), 2);
    assert!(!fs.exists("/logs/desktop.log.1"));
  }

  #[test]
  fn rotates_before_the_line_that_would_pass_the_limit() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 2 * ONE_LINE_BYTES);
    log.append_line(&stop_requested_line(1)).unwrap();
    log.append_line(&stop_requested_line(2)).unwrap();

    log.append_line(&stop_requested_line(3)).unwrap();

    assert_eq!(fs.lines(LOG), vec![stored_stop_requested(3)]);
    assert_eq!(fs.lines("/logs/desktop.log.1"), vec![stored_stop_requested(1), stored_stop_requested(2)]);
  }

  #[test]
  fn keeps_the_current_file_and_two_rotated_ones_and_drops_the_oldest() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, ONE_LINE_BYTES);

    for pid in 1..=4 {
      log.append_line(&stop_requested_line(pid)).unwrap();
    }

    assert_eq!(fs.lines(LOG), vec![stored_stop_requested(4)]);
    assert_eq!(fs.lines("/logs/desktop.log.1"), vec![stored_stop_requested(3)]);
    assert_eq!(fs.lines("/logs/desktop.log.2"), vec![stored_stop_requested(2)]);
    assert!(!fs.exists("/logs/desktop.log.3"));
  }

  #[test]
  fn resumes_from_the_size_of_an_existing_file() {
    let fs = Arc::new(FakeFs::default());
    fs.seed(LOG, &format!("{}\n", stored_stop_requested(1)));
    let mut log = rotating(&fs, 2 * ONE_LINE_BYTES);

    log.append_line(&stop_requested_line(2)).unwrap();
    log.append_line(&stop_requested_line(3)).unwrap();

    assert_eq!(fs.lines("/logs/desktop.log.1"), vec![stored_stop_requested(1), stored_stop_requested(2)]);
  }

  #[test]
  fn a_failing_rename_neither_raises_nor_loses_the_line() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, ONE_LINE_BYTES);
    log.append_line(&stop_requested_line(1)).unwrap();
    fs.rename_fails.store(true, Ordering::SeqCst);

    let outcome = log.append_line(&stop_requested_line(2));

    assert!(outcome.is_ok());
    assert_eq!(fs.lines(LOG), vec![stored_stop_requested(1), stored_stop_requested(2)]);
  }

  #[test]
  fn a_line_longer_than_the_limit_is_cut_so_the_file_never_exceeds_it() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 10);

    log.append_line(&stop_requested_line(1)).unwrap();

    assert_eq!(fs.text(LOG), format!("{}\n", &EPOCH_PREFIX[..9]));
  }

  // ---- reading the tail ----

  #[test]
  fn returns_the_last_lines_as_stored() {
    let folder = ScratchFolder::new("tail");
    let path = folder.path().join(LOG_FILE_NAME);
    std::fs::write(&path, "first\nBearer abc123\nlast\n").unwrap();

    let lines = last_lines(&path, 2);

    assert_eq!(lines, vec!["Bearer abc123", "last"]);
  }

  #[test]
  fn tops_up_from_the_rotated_file_when_the_current_one_is_short() {
    let folder = ScratchFolder::new("topup");
    std::fs::write(folder.path().join("desktop.log.1"), "old1\nold2\n").unwrap();
    std::fs::write(folder.path().join(LOG_FILE_NAME), "new1\n").unwrap();

    let lines = last_lines(&folder.path().join(LOG_FILE_NAME), 3);

    assert_eq!(lines, vec!["old1", "old2", "new1"]);
  }

  #[test]
  fn returns_nothing_when_there_is_no_log_yet() {
    let folder = ScratchFolder::new("nolog");

    assert!(last_lines(&folder.path().join(LOG_FILE_NAME), 50).is_empty());
  }

  #[test]
  fn never_reads_the_files_of_an_earlier_version() {
    let folder = ScratchFolder::new("legacy-unread");
    std::fs::write(folder.path().join("daemon.log"), "an old masked line\n").unwrap();

    assert!(last_lines(&folder.path().join(LOG_FILE_NAME), 50).is_empty());
  }

  // ---- location and permissions ----

  #[test]
  fn the_logs_folder_follows_openfleet_home_like_the_admin_token() {
    assert_eq!(logs_dir(Some("/scratch/of".to_string()), Path::new("/Users/test")), PathBuf::from("/scratch/of/logs"));
    assert_eq!(logs_dir(None, Path::new("/Users/test")), PathBuf::from("/Users/test/.openfleet/logs"));
  }

  #[test]
  fn the_disk_log_is_private_to_the_owner() {
    use std::os::unix::fs::PermissionsExt;
    let folder = ScratchFolder::new("perms");
    let logs = folder.path().join("logs");
    let path = logs.join(LOG_FILE_NAME);

    DiskFs.append(&path, b"line\n").unwrap();

    assert_eq!(std::fs::metadata(&logs).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(DiskFs.size(&path).unwrap(), 5);
  }

  // ---- the writer ----

  fn salt() -> Salt {
    let home = ScratchFolder::new("salt");
    Salt::load_or_create(home.path()).expect("a salt in a writable folder")
  }

  fn writer_over(fs: &Arc<FakeFs>, max_bytes: u64, salt: Option<Salt>, capacity: usize) -> DesktopLog {
    DesktopLog::start_with_capacity(rotating(fs, max_bytes), salt, || 0, capacity)
  }

  fn ingest(log: &DesktopLog, stream: Stream, text: &str) {
    log.ingest_daemon_chunk(stream, text.as_bytes());
  }

  #[test]
  fn the_writer_projects_each_line_of_a_chunk_onto_the_allowlist_and_skips_blank_lines() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, None, 16);

    ingest(&log, Stream::Out, "hello\n\n{\"level\":\"warn\",\"msg\":\"world\"}\n");
    ingest(&log, Stream::Err, "Bearer abc123\n");

    wait_until(|| fs.lines(LOG).len() == 3);
    assert_eq!(
      fs.lines(LOG),
      vec![
        format!("{EPOCH_PREFIX} info daemon_text stream=out class=other text=[text:5]"),
        format!("{EPOCH_PREFIX} warn daemon_line msg=[text:5] extra_fields=0"),
        format!("{EPOCH_PREFIX} warn daemon_text stream=err class=other text=[text:13]"),
      ]
    );
  }

  #[test]
  fn the_writer_joins_a_line_split_across_chunks_of_the_same_stream_only() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, None, 16);

    ingest(&log, Stream::Out, "hel");
    ingest(&log, Stream::Err, "boom\n");
    ingest(&log, Stream::Out, "lo\n");

    wait_until(|| fs.lines(LOG).len() == 2);
    assert_eq!(
      fs.lines(LOG),
      vec![
        format!("{EPOCH_PREFIX} warn daemon_text stream=err class=other text=[text:4]"),
        format!("{EPOCH_PREFIX} info daemon_text stream=out class=other text=[text:5]"),
      ]
    );
  }

  #[test]
  fn the_writer_tags_free_text_under_the_install_salt_and_never_stores_it() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, Some(salt()), 16);
    let secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

    ingest(&log, Stream::Err, &format!("{secret}\n"));
    log.record_event(DesktopEvent::SidecarFailed { reason: log.opaque(secret.as_bytes()) });

    wait_until(|| fs.lines(LOG).len() == 2);
    let expected_tag = log.opaque(secret.as_bytes()).to_string();
    assert_eq!(fs.lines(LOG)[0], format!("{EPOCH_PREFIX} warn daemon_text stream=err class=other text={expected_tag}"));
    assert_eq!(fs.lines(LOG)[1], format!("{EPOCH_PREFIX} error sidecar_failed reason={expected_tag}"));
    assert!(!fs.text(LOG).contains("ghp_"));
  }

  #[test]
  fn a_typed_event_is_stored_with_the_writer_clock() {
    let fs = Arc::new(FakeFs::default());
    let log = DesktopLog::start_with_capacity(rotating(&fs, 100_000), None, || 1_700_000_000, 16);

    log.record_event(DesktopEvent::DaemonExited { code: Some(crate::event_log::ExitCode(1)) });

    wait_until(|| fs.lines(LOG).len() == 1);
    assert_eq!(fs.lines(LOG), vec!["2023-11-14T22:13:20Z warn daemon_exited code=1"]);
  }

  #[test]
  fn interleaved_stdout_and_stderr_lines_stay_whole() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 1_000_000, None, 4096);
    let out = log.clone();
    let err = log.clone();

    let out_thread = std::thread::spawn(move || (0..200).for_each(|n| ingest(&out, Stream::Out, &format!("out-line-{n}-{}\n", "o".repeat(40)))));
    let err_thread = std::thread::spawn(move || (0..200).for_each(|n| ingest(&err, Stream::Err, &format!("err-line-{n}-{}\n", "e".repeat(40)))));
    out_thread.join().unwrap();
    err_thread.join().unwrap();

    wait_until(|| fs.lines(LOG).len() == 400);
    let is_whole = |line: &String| {
      let is_out = line.starts_with(&format!("{EPOCH_PREFIX} info daemon_text stream=out class=other text=[text:"));
      let is_err = line.starts_with(&format!("{EPOCH_PREFIX} warn daemon_text stream=err class=other text=[text:"));
      (is_out || is_err) && line.ends_with("]")
    };
    assert!(fs.lines(LOG).iter().all(is_whole));
  }

  fn hold_the_first_append(fs: &Arc<FakeFs>) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
    let (entered_sender, entered) = mpsc::channel();
    let (release, release_receiver) = mpsc::channel();
    *fs.first_append_gate.lock().unwrap() = Some((entered_sender, release_receiver));
    (entered, release)
  }

  #[test]
  fn a_slow_disk_drops_messages_and_the_next_write_says_how_many() {
    let fs = Arc::new(FakeFs::default());
    let (entered, release) = hold_the_first_append(&fs);
    let log = writer_over(&fs, 10_000, None, 1);
    ingest(&log, Stream::Out, "first\n");
    entered.recv().unwrap();

    for n in 0..4 {
      ingest(&log, Stream::Out, &format!("burst-{n}\n"));
    }
    release.send(()).unwrap();

    wait_until(|| fs.lines(LOG).len() == 3);
    let lines = fs.lines(LOG);
    assert!(lines[0].contains("daemon_text stream=out"));
    assert_eq!(lines[1], format!("{EPOCH_PREFIX} warn writer_dropped count=3"));
    assert!(lines[2].contains("daemon_text stream=out"));
  }

  // ---- drop accounting ----

  #[test]
  fn a_failed_write_is_counted_as_lost_by_kind_and_not_blamed_on_a_slow_writer() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 10_000, None, 16);
    fs.fail_appends_containing("");

    ingest(&log, Stream::Out, "lost-1\n");
    ingest(&log, Stream::Out, "lost-2\n");
    wait_until(|| fs.failed_append_count() >= 3);
    fs.stop_failing_appends();
    ingest(&log, Stream::Out, "fine\n");

    wait_until(|| fs.lines(LOG).len() == 2);
    let lines = fs.lines(LOG);
    assert_eq!(lines[0], format!("{EPOCH_PREFIX} error writer_lost count=2 kind=other errno=none"));
    assert!(lines[1].contains("daemon_text stream=out"));
    assert!(!fs.text(LOG).contains("disk full"));
    assert!(!lines.iter().any(|line| line.contains("writer_dropped")));
  }

  #[test]
  fn a_full_queue_is_blamed_on_the_writer_and_not_on_the_disk() {
    let fs = Arc::new(FakeFs::default());
    let (entered, release) = hold_the_first_append(&fs);
    let log = writer_over(&fs, 10_000, None, 1);
    ingest(&log, Stream::Out, "first\n");
    entered.recv().unwrap();
    for n in 0..3 {
      ingest(&log, Stream::Out, &format!("burst-{n}\n"));
    }
    release.send(()).unwrap();

    wait_until(|| fs.lines(LOG).len() == 3);
    let lines = fs.lines(LOG);
    assert_eq!(lines[1], format!("{EPOCH_PREFIX} warn writer_dropped count=2"));
    assert!(!lines.iter().any(|line| line.contains("writer_lost")));
  }

  #[test]
  fn the_dropped_count_survives_a_notice_that_could_not_be_written() {
    let fs = Arc::new(FakeFs::default());
    let (entered, release) = hold_the_first_append(&fs);
    let log = writer_over(&fs, 10_000, None, 1);
    ingest(&log, Stream::Out, "first\n");
    entered.recv().unwrap();
    for n in 0..4 {
      ingest(&log, Stream::Out, &format!("burst-{n}\n"));
    }
    fs.fail_appends_containing("writer_dropped");
    release.send(()).unwrap();
    wait_until(|| fs.lines(LOG).len() == 2);

    fs.stop_failing_appends();
    ingest(&log, Stream::Out, "after\n");

    wait_until(|| fs.lines(LOG).len() == 4);
    let lines = fs.lines(LOG);
    assert_eq!(lines[2], format!("{EPOCH_PREFIX} warn writer_dropped count=3"));
    assert!(lines[3].contains("daemon_text stream=out"));
  }

  // ---- flush on exit ----

  #[test]
  fn flush_and_close_writes_every_queued_line_then_the_flushed_marker() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, None, 64);
    for n in 0..30 {
      ingest(&log, Stream::Out, &format!("line {n}\n"));
    }

    let drained = log.flush_and_close(Duration::from_secs(2));

    assert!(drained);
    let lines = fs.lines(LOG);
    assert_eq!(lines.len(), 31);
    assert_eq!(lines[30], format!("{EPOCH_PREFIX} info daemon_log_flushed drained=true"));
  }

  #[test]
  fn flush_and_close_writes_the_unfinished_line_of_each_stream() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, None, 64);
    ingest(&log, Stream::Out, "no newline out");
    ingest(&log, Stream::Err, "no newline err");

    log.flush_and_close(Duration::from_secs(2));

    let lines = fs.lines(LOG);
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("stream=out") && lines[1].contains("stream=err"));
  }

  #[test]
  fn flush_and_close_gives_up_within_its_timeout_when_the_disk_is_stuck() {
    let fs = Arc::new(FakeFs::default());
    let (entered, release) = hold_the_first_append(&fs);
    let log = writer_over(&fs, 10_000, None, 4);
    ingest(&log, Stream::Out, "stuck\n");
    entered.recv().unwrap();
    let started_at = Instant::now();

    let drained = log.flush_and_close(Duration::from_millis(100));

    assert!(!drained);
    assert!(started_at.elapsed() < Duration::from_secs(1));
    release.send(()).unwrap();
  }

  #[test]
  fn flush_and_close_returns_when_the_queue_is_full_and_the_disk_is_stuck() {
    let fs = Arc::new(FakeFs::default());
    let (entered, release) = hold_the_first_append(&fs);
    let log = writer_over(&fs, 10_000, None, 1);
    ingest(&log, Stream::Out, "stuck\n");
    entered.recv().unwrap();
    ingest(&log, Stream::Out, "fills the queue\n");
    let started_at = Instant::now();

    let drained = log.flush_and_close(Duration::from_millis(100));

    assert!(!drained);
    assert!(started_at.elapsed() < Duration::from_secs(1));
    release.send(()).unwrap();
  }

  #[test]
  fn the_exit_waits_for_the_last_event_of_the_output_pipe() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, None, 64);
    let pipe = log.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(50));
      pipe.record_event(DesktopEvent::DaemonExited { code: Some(crate::event_log::ExitCode(0)) });
      pipe.mark_output_ended();
    });

    let drained = log.close_after_output_ends(Duration::from_secs(2));

    assert!(drained);
    let lines = fs.lines(LOG);
    assert!(lines.iter().any(|line| line.contains("daemon_exited code=0")), "{lines:?}");
  }

  #[test]
  fn the_exit_does_not_wait_for_ever_for_a_pipe_that_never_ends() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, None, 64);
    ingest(&log, Stream::Out, "queued\n");
    let started_at = Instant::now();

    let drained = log.close_after_output_ends(Duration::from_millis(400));

    assert!(drained);
    assert!(started_at.elapsed() < Duration::from_secs(1));
    assert_eq!(fs.lines(LOG).len(), 2);
  }

  #[test]
  fn a_class_of_text_stays_reachable_through_the_event_vocabulary() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, None, 16);

    log.record_event(DesktopEvent::DaemonText { stream: Stream::Err, class: DaemonTextClass::NodeFatal, text: log.opaque(b"x") });

    wait_until(|| fs.lines(LOG).len() == 1);
    assert!(fs.lines(LOG)[0].contains("class=node_fatal"));
  }

  // ---- the files of an earlier version, on a real disk ----

  fn write_file(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
  }

  fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().to_string()).collect();
    names.sort();
    names
  }

  #[test]
  fn the_first_start_deletes_every_file_an_earlier_version_wrote() {
    let home = ScratchFolder::new("legacy-delete");
    let logs = home.path().join("logs");
    for name in ["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.10"] {
      write_file(&logs.join(name), "Authorization: Bearer leftover-secret-0123456789\n");
    }
    for kept in ["desktop.log.1", "daemon.log.bak", "daemon.logs", "mydaemon.log", "daemon.log.", "notes.txt"] {
      write_file(&logs.join(kept), "unrelated\n");
    }

    let log = start_on_disk(home.path(), || 0);
    assert!(log.flush_and_close(Duration::from_secs(5)));

    let names = names_in(&logs);
    assert_eq!(names, vec!["daemon.log.", "daemon.log.bak", "daemon.logs", "desktop.log", "desktop.log.1", "mydaemon.log", "notes.txt"]);
  }

  #[test]
  fn a_start_without_a_logs_folder_or_legacy_files_just_works() {
    let home = ScratchFolder::new("fresh-install");

    let log = start_on_disk(home.path(), || 0);
    log.ingest_daemon_chunk(Stream::Out, b"hello\n");
    assert!(log.flush_and_close(Duration::from_secs(5)));

    let stored = std::fs::read_to_string(home.path().join("logs").join(LOG_FILE_NAME)).unwrap();
    assert_eq!(stored.lines().count(), 2);
  }

  #[test]
  fn the_secrets_of_an_earlier_version_never_reach_the_new_file_or_the_tail_readers() {
    let home = ScratchFolder::new("legacy-secret");
    let logs = home.path().join("logs");
    write_file(&logs.join("daemon.log"), "leftover-secret-0123456789\n");

    let log = start_on_disk(home.path(), || 0);
    log.ingest_daemon_chunk(Stream::Err, b"openfleet: refusing to boot: port in use\n");
    assert!(log.flush_and_close(Duration::from_secs(5)));

    let tail = last_lines(&logs.join(LOG_FILE_NAME), 100).join("\n");
    assert!(!tail.contains("leftover-secret"), "{tail}");
    assert!(tail.contains("class=boot_refusal"), "{tail}");
  }

  #[test]
  fn the_file_and_the_salt_are_private_and_the_salt_lives_outside_the_logs_folder() {
    use std::os::unix::fs::PermissionsExt;
    let home = ScratchFolder::new("private-install");

    let log = start_on_disk(home.path(), || 0);
    log.ingest_daemon_chunk(Stream::Out, b"hello\n");
    assert!(log.flush_and_close(Duration::from_secs(5)));

    let mode_of = |path: PathBuf| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode_of(home.path().join(SALT_FILE_NAME)), 0o600);
    assert_eq!(mode_of(home.path().join("logs").join(LOG_FILE_NAME)), 0o600);
    assert_eq!(mode_of(home.path().join("logs")), 0o700);
    assert_eq!(names_in(&home.path().join("logs")), vec!["desktop.log"]);
  }

  #[test]
  fn the_tags_of_two_starts_of_one_install_agree() {
    let home = ScratchFolder::new("stable-tags");
    let tag_after_a_start = || {
      let log = start_on_disk(home.path(), || 0);
      let tag = log.opaque(b"same message").to_string();
      assert!(log.flush_and_close(Duration::from_secs(5)));
      tag
    };

    let first_start = tag_after_a_start();
    let second_start = tag_after_a_start();

    assert_eq!(first_start, second_start);
    assert!(first_start.matches(':').count() == 2, "{first_start}");
  }

  #[test]
  fn an_unwritable_home_still_logs_with_lengths_only() {
    let folder = ScratchFolder::new("no-salt");
    let blocked_home = folder.path().join("a-file-not-a-folder");
    std::fs::write(&blocked_home, "x").unwrap();

    let log = start_on_disk(&blocked_home, || 0);

    assert_eq!(log.opaque(b"abcd").to_string(), "[text:4]");
    assert!(log.flush_and_close(Duration::from_secs(5)));
  }
}
