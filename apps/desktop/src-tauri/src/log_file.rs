use crate::admin_token::openfleet_home_dir;
use crate::redaction::redact;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, sync_channel, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
pub const KEPT_FILES: usize = 3;
pub const LOG_FILE_NAME: &str = "daemon.log";
const CHANNEL_CAPACITY: usize = 2048;
const PRIVATE_DIR_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
const SECONDS_PER_DAY: u64 = 86_400;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stream {
  Out,
  Err,
}

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
  pub fn append_line(&mut self, line: &str) -> io::Result<()> {
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

  fn line_bytes(&self, line: &str) -> Vec<u8> {
    let room_for_the_text = self.max_bytes.saturating_sub(1) as usize;
    let text = truncated_at_char_boundary(line, room_for_the_text);
    format!("{text}\n").into_bytes()
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

fn truncated_at_char_boundary(text: &str, max_bytes: usize) -> &str {
  let mut end = max_bytes.min(text.len());
  while !text.is_char_boundary(end) {
    end -= 1;
  }
  &text[..end]
}

/// Returns the line as the log stores it: `<ts> [out|err] <line>`, a daemon NDJSON line untouched.
pub fn format_line(stream: Stream, line: &str, unix_seconds: u64) -> String {
  let is_daemon_ndjson_line = serde_json::from_str::<serde_json::Value>(line.trim()).is_ok_and(|value| value.is_object());
  if is_daemon_ndjson_line {
    return line.to_string();
  }
  let stream_label = match stream {
    Stream::Out => "out",
    Stream::Err => "err",
  };
  format!("{} [{stream_label}] {line}", iso_utc(unix_seconds))
}

/// Formats seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (civil-from-days, proleptic Gregorian).
fn iso_utc(unix_seconds: u64) -> String {
  let seconds_of_day = unix_seconds % SECONDS_PER_DAY;
  let days_since_epoch = (unix_seconds / SECONDS_PER_DAY) as i64;
  let shifted_days = days_since_epoch + 719_468;
  let era = shifted_days.div_euclid(146_097);
  let day_of_era = shifted_days.rem_euclid(146_097);
  let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
  let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let month_index = (5 * day_of_year + 2) / 153;
  let day = day_of_year - (153 * month_index + 2) / 5 + 1;
  let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
  let year = year_of_era + era * 400 + i64::from(month <= 2);
  let (hour, minute, second) = (seconds_of_day / 3_600, seconds_of_day % 3_600 / 60, seconds_of_day % 60);
  format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Returns the last `count` lines of the log (topping up from `path.1`), redacted.
pub fn last_redacted_lines(path: &Path, count: usize, secrets: &[String]) -> Vec<String> {
  let current = lines_of(path);
  let rotated = if current.len() < count { lines_of(&numbered(path, 1)) } else { Vec::new() };
  let all_lines: Vec<String> = rotated.into_iter().chain(current).collect();
  let first_kept = all_lines.len().saturating_sub(count);
  all_lines[first_kept..].iter().map(|line| redact(line, secrets)).collect()
}

// ponytail: reads the whole file (at most 5 MB); seek from the end if this ever shows up in a profile.
fn lines_of(path: &Path) -> Vec<String> {
  let bytes = std::fs::read(path).unwrap_or_default();
  String::from_utf8_lossy(&bytes).lines().map(str::to_string).collect()
}

enum Message {
  Line(Stream, String),
  /// Stops the writer once every line queued before it is written, then acknowledges.
  Close(mpsc::Sender<()>),
}

/// The admin token is checked again at most this often once one is known.
const SECRET_CHECK_INTERVAL_SECONDS: u64 = 2;
const MAX_SECRETS_KEPT: usize = 8;
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// The writer thread's state: rotating file, secrets to redact, and what it failed to write.
struct LogWriter<F: LogFs> {
  log: RotatingLog<F>,
  poll_secrets: Box<dyn FnMut() -> Option<Vec<String>> + Send>,
  clock: Box<dyn Fn() -> u64 + Send>,
  secrets: Vec<String>,
  secrets_checked_at: Option<u64>,
  lines_dropped_by_the_queue: Arc<AtomicU64>,
  lines_lost_to_write_errors: u64,
  last_write_error: Option<io::Error>,
}

impl<F: LogFs> LogWriter<F> {
  fn run(mut self, messages: mpsc::Receiver<Message>) {
    for message in messages {
      match message {
        Message::Line(stream, line) => self.write(stream, &line),
        Message::Close(acknowledge) => {
          let _ = acknowledge.send(());
          return;
        }
      }
    }
  }

  fn write(&mut self, stream: Stream, line: &str) {
    let now = (self.clock)();
    self.refresh_secrets(now);
    self.report_lost_lines(now);
    let stored_line = format_line(stream, &redact(line, &self.secrets), now);
    if let Err(error) = self.log.append_line(&stored_line) {
      self.lines_lost_to_write_errors += 1;
      self.last_write_error = Some(error);
    }
  }

  /// Looks for a new admin token on every line while none is known (the file may appear after the first output), then every two seconds.
  fn refresh_secrets(&mut self, now: u64) {
    let no_secret_known_yet = self.secrets.is_empty();
    let check_is_due = self.secrets_checked_at.map_or(true, |checked_at| now.saturating_sub(checked_at) >= SECRET_CHECK_INTERVAL_SECONDS);
    if !(no_secret_known_yet || check_is_due) {
      return;
    }
    self.secrets_checked_at = Some(now);
    for secret in (self.poll_secrets)().unwrap_or_default() {
      if !self.secrets.contains(&secret) {
        self.secrets.push(secret);
      }
    }
    let surplus = self.secrets.len().saturating_sub(MAX_SECRETS_KEPT);
    self.secrets.drain(..surplus);
  }

  /// Writes one notice per cause; a count is cleared only once its notice is in the file.
  fn report_lost_lines(&mut self, now: u64) {
    let dropped = self.lines_dropped_by_the_queue.load(Ordering::SeqCst);
    if dropped > 0 && self.append_notice(now, &format!("{dropped} lines dropped: the log writer fell behind")) {
      self.lines_dropped_by_the_queue.fetch_sub(dropped, Ordering::SeqCst);
    }
    if self.lines_lost_to_write_errors > 0 {
      let cause = self.last_write_error.as_ref().map_or_else(String::new, |error| format!(" ({error})"));
      let notice = format!("{} lines lost: could not write the log file{cause}", self.lines_lost_to_write_errors);
      if self.append_notice(now, &notice) {
        self.lines_lost_to_write_errors = 0;
        self.last_write_error = None;
      }
    }
  }

  fn append_notice(&mut self, now: u64, text: &str) -> bool {
    self.log.append_line(&format!("{} [log] {text}", iso_utc(now))).is_ok()
  }
}

/// Hands daemon output to a writer thread; never blocks the caller and counts what it had to drop.
#[derive(Clone)]
pub struct DaemonLog {
  sender: SyncSender<Message>,
  lines_dropped_by_the_queue: Arc<AtomicU64>,
  output_ended: Arc<AtomicBool>,
}

impl DaemonLog {
  /// `poll_secrets` returns the secrets to add when the admin token changed, None while it is as it was.
  pub fn start<F: LogFs + Send + 'static>(
    log: RotatingLog<F>,
    poll_secrets: impl FnMut() -> Option<Vec<String>> + Send + 'static,
    clock: impl Fn() -> u64 + Send + 'static,
  ) -> Self {
    Self::start_with_capacity(log, poll_secrets, clock, CHANNEL_CAPACITY)
  }

  pub fn start_with_capacity<F: LogFs + Send + 'static>(
    log: RotatingLog<F>,
    poll_secrets: impl FnMut() -> Option<Vec<String>> + Send + 'static,
    clock: impl Fn() -> u64 + Send + 'static,
    capacity: usize,
  ) -> Self {
    let (sender, receiver) = sync_channel::<Message>(capacity);
    let lines_dropped_by_the_queue = Arc::new(AtomicU64::new(0));
    let writer = LogWriter {
      log,
      poll_secrets: Box::new(poll_secrets),
      clock: Box::new(clock),
      secrets: Vec::new(),
      secrets_checked_at: None,
      lines_dropped_by_the_queue: lines_dropped_by_the_queue.clone(),
      lines_lost_to_write_errors: 0,
      last_write_error: None,
    };
    std::thread::spawn(move || writer.run(receiver));
    Self { sender, lines_dropped_by_the_queue, output_ended: Arc::new(AtomicBool::new(false)) }
  }

  /// Queues every non-blank line of a chunk of daemon output.
  pub fn record(&self, stream: Stream, chunk: &str) {
    for line in chunk.lines().filter(|line| !line.trim().is_empty()) {
      let queue_is_full = matches!(self.sender.try_send(Message::Line(stream, line.to_string())), Err(TrySendError::Full(_)));
      if queue_is_full {
        self.lines_dropped_by_the_queue.fetch_add(1, Ordering::SeqCst);
      }
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

  /// Drains the queue and stops the writer; false when it did not finish within `timeout`.
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
  use std::sync::mpsc;
  use std::sync::Mutex;
  use std::time::{Duration, Instant};

  const LOG: &str = "/logs/daemon.log";

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

  fn scratch_folder(name: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("of-log-file-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
  }

  // ---- rotation ----

  #[test]
  fn appends_lines_to_the_current_file() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 100);

    log.append_line("one").unwrap();
    log.append_line("two").unwrap();

    assert_eq!(fs.lines(LOG), vec!["one", "two"]);
  }

  #[test]
  fn keeps_writing_in_the_current_file_up_to_exactly_the_limit() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 8);

    log.append_line("abc").unwrap();
    log.append_line("def").unwrap();

    assert_eq!(fs.text(LOG), "abc\ndef\n");
    assert!(!fs.exists("/logs/daemon.log.1"));
  }

  #[test]
  fn rotates_before_the_line_that_would_pass_the_limit() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 8);
    log.append_line("abc").unwrap();
    log.append_line("def").unwrap();

    log.append_line("g").unwrap();

    assert_eq!(fs.text(LOG), "g\n");
    assert_eq!(fs.text("/logs/daemon.log.1"), "abc\ndef\n");
  }

  #[test]
  fn keeps_the_current_file_and_two_rotated_ones_and_drops_the_oldest() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 4);

    for line in ["aaa", "bbb", "ccc", "ddd"] {
      log.append_line(line).unwrap();
    }

    assert_eq!(fs.text(LOG), "ddd\n");
    assert_eq!(fs.text("/logs/daemon.log.1"), "ccc\n");
    assert_eq!(fs.text("/logs/daemon.log.2"), "bbb\n");
    assert!(!fs.exists("/logs/daemon.log.3"));
  }

  #[test]
  fn resumes_from_the_size_of_an_existing_file() {
    let fs = Arc::new(FakeFs::default());
    fs.seed(LOG, "abc\n");
    let mut log = rotating(&fs, 8);

    log.append_line("def").unwrap();
    log.append_line("g").unwrap();

    assert_eq!(fs.text("/logs/daemon.log.1"), "abc\ndef\n");
  }

  #[test]
  fn a_failing_rename_neither_raises_nor_loses_the_line() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 4);
    log.append_line("aaa").unwrap();
    fs.rename_fails.store(true, Ordering::SeqCst);

    let outcome = log.append_line("bbb");

    assert!(outcome.is_ok());
    assert_eq!(fs.text(LOG), "aaa\nbbb\n");
  }

  #[test]
  fn a_line_longer_than_the_limit_is_cut_so_the_file_never_exceeds_it() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 10);

    log.append_line(&"x".repeat(50)).unwrap();

    assert_eq!(fs.text(LOG), format!("{}\n", "x".repeat(9)));
  }

  #[test]
  fn a_cut_never_splits_a_multibyte_character() {
    let fs = Arc::new(FakeFs::default());
    let mut log = rotating(&fs, 10);

    log.append_line(&"é".repeat(20)).unwrap();

    assert_eq!(fs.text(LOG), format!("{}\n", "é".repeat(4)));
  }

  // ---- prefixing ----

  #[test]
  fn prefixes_a_plain_line_with_the_timestamp_and_the_stream() {
    assert_eq!(format_line(Stream::Out, "hello", 0), "1970-01-01T00:00:00Z [out] hello");
    assert_eq!(format_line(Stream::Err, "boom", 1_700_000_000), "2023-11-14T22:13:20Z [err] boom");
  }

  #[test]
  fn keeps_a_daemon_ndjson_line_intact() {
    let ndjson = r#"{"ts":"2026-09-30T10:00:00.000Z","level":"info","msg":"listening"}"#;

    assert_eq!(format_line(Stream::Out, ndjson, 0), ndjson);
  }

  #[test]
  fn prefixes_a_line_that_only_looks_like_json() {
    assert_eq!(format_line(Stream::Err, "{ not json }", 0), "1970-01-01T00:00:00Z [err] { not json }");
  }

  // ---- redaction ----

  #[test]
  fn redacts_the_admin_token_wherever_it_appears() {
    let secrets = vec!["s3cr3t-admin-token".to_string()];

    let line = redact("token=s3cr3t-admin-token and again s3cr3t-admin-token", &secrets);

    assert_eq!(line, "token=[redacted] and again [redacted]");
  }

  #[test]
  fn redacts_a_bearer_token_in_any_letter_case() {
    assert_eq!(redact("Authorization: Bearer abc.DEF-123_x/y=", &[]), "Authorization: Bearer [redacted]");
    assert_eq!(redact("authorization: bearer abc123", &[]), "authorization: bearer [redacted]");
  }

  #[test]
  fn redacts_a_hook_token_path_segment() {
    assert_eq!(redact("POST /hooks/9f8e7d6c5b4a/pre-tool 200", &[]), "POST /hooks/[redacted]/pre-tool 200");
  }

  #[test]
  fn leaves_a_line_without_secrets_alone() {
    assert_eq!(redact("listening on 127.0.0.1:7331 (Bearer)", &[]), "listening on 127.0.0.1:7331 (Bearer)");
  }

  #[test]
  fn ignores_a_secret_too_short_to_be_a_token() {
    assert_eq!(redact("a b c", &["a".to_string(), String::new()]), "a b c");
  }

  #[test]
  fn redaction_is_idempotent() {
    let once = redact("Bearer abc123 /hooks/tok123", &[]);

    assert_eq!(redact(&once, &[]), once);
  }

  // ---- redaction parity with packages/core/src/redact.ts ----

  fn leaked_by(text: &str, leaked: &str) -> bool {
    redact(text, &[]).contains(leaked)
  }

  #[test]
  fn masks_every_bearer_spelling_the_daemon_masks() {
    let spellings = [
      "Bearer s3cr3t.tok-EN",
      "bearer s3cr3t.tok-EN",
      "BEARER s3cr3t.tok-EN",
      "Bearer   s3cr3t.tok-EN",
      "Bearer\ts3cr3t.tok-EN",
      "Bearer:s3cr3t.tok-EN",
      "Bearer: s3cr3t.tok-EN",
      "Bearer=s3cr3t.tok-EN",
      "Bearer%20s3cr3t.tok-EN",
      "bearer%20s3cr3t.tok-EN",
      "Bearer%3As3cr3t.tok-EN",
      "Bearer%253As3cr3t.tok-EN",
      "B%65arer s3cr3t.tok-EN",
      "Authorization:Bearer\ts3cr3t.tok-EN",
    ];

    let leaking: Vec<&str> = spellings.into_iter().filter(|text| leaked_by(&format!("call with {text} now"), "s3cr3t")).collect();

    assert_eq!(leaking, Vec::<&str>::new());
  }

  #[test]
  fn masks_the_whole_bearer_token_even_when_it_holds_percent_signs() {
    let cases = [
      ("Bearer abc%2Bdef", "abc", "def"),
      ("Bearer abc%44EF123", "abc", "EF123"),
      ("Bearer abc%ZZdef123", "abc", "def123"),
    ];

    for (text, head, tail) in cases {
      let masked = redact(text, &[]);
      assert!(!masked.contains(head) && !masked.contains(tail), "{text} became {masked}");
    }
  }

  #[test]
  fn masks_every_hook_token_spelling_the_daemon_masks() {
    let spellings = [
      "/hooks/t0k3nVALUE",
      "http://127.0.0.1:7331/hooks/t0k3nVALUE/stop?x=1",
      "%2Fhooks%2Ft0k3nVALUE",
      "%2fhooks%2ft0k3nVALUE",
      "/hooks%2Ft0k3nVALUE",
      "%252Fhooks%252Ft0k3nVALUE",
      "/HOOKS/t0k3nVALUE",
      "/%68ooks/t0k3nVALUE",
      "/hooks/%74t0k3nVALUE",
      "/hooks/%2574t0k3nVALUE",
    ];

    let leaking: Vec<&str> = spellings.into_iter().filter(|text| leaked_by(&format!("posted to {text} now"), "t0k3nVALUE")).collect();

    assert_eq!(leaking, Vec::<&str>::new());
  }

  #[test]
  fn masks_the_characters_of_a_hook_token_written_with_escapes() {
    assert!(!leaked_by("/hooks/abc%44EF123", "EF123"));
    assert!(!leaked_by("/hooks/abc%ZZdef123", "def123"));
    assert!(!leaked_by("/hooks%252Fabc%2544EF123", "EF123"));
  }

  #[test]
  fn keeps_the_hooks_route_pattern_which_is_not_a_secret() {
    assert_eq!(redact("POST /hooks/:token → 500", &[]), "POST /hooks/:token → 500");
  }

  #[test]
  fn masks_a_basic_credential() {
    let cases = [
      ("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"),
      ("sent Basic dXNlcjpwYXNz9 to the proxy", "dXNlcjpwYXNz9"),
      ("failed with Authorization: Basic dXNlcjpwYXNz today", "dXNlcjpwYXNz"),
      ("failed with Proxy-Authorization: Basic dXNlcjpwYXNz today", "dXNlcjpwYXNz"),
      ("failed with authorization:Basic dXNlcjpwYXNz today", "dXNlcjpwYXNz"),
    ];

    for (text, credential) in cases {
      let masked = redact(text, &[]);
      assert!(!masked.contains(credential), "{text} became {masked}");
      assert!(masked.contains("Basic [redacted]"), "{text} became {masked}");
    }
  }

  #[test]
  fn keeps_the_word_basic_in_prose() {
    for sentence in ["Basic authentication failed", "the Basic plan costs more", "the Basic plan costs more than Basic support", "Basic setup failed"] {
      assert_eq!(redact(sentence, &[]), sentence);
    }
  }

  #[test]
  fn masks_the_credentials_of_a_url() {
    let masked = redact("connect https://admin:hunter2longpassword@host/path failed", &[]);

    assert_eq!(masked, "connect https://[redacted]@host/path failed");
  }

  #[test]
  fn masks_a_secret_named_query_or_parameter_value() {
    let cases = [
      "GET /x?token=t0k3nVALUE&page=2",
      "GET /x?page=2&access_token=t0k3nVALUE",
      "ws://127.0.0.1:7331/ws?ticket=t0k3nVALUE",
      "GET /x?api_key=t0k3nVALUE",
      "GET /x?api-key=t0k3nVALUE",
      "GET /x?apiKey=t0k3nVALUE",
      "GET /x?client_secret=t0k3nVALUE",
      "GET /x?Authorization=t0k3nVALUE",
      "GET /x?password=t0k3nVALUE",
      "GET /x?cookie=t0k3nVALUE",
      "GET /x;password=t0k3nVALUE",
      "failed with token=t0k3nVALUE today",
      "access_token=t0k3nVALUE",
      "/x?%74oken=t0k3nVALUE",
      "/x?to%6Ben=t0k3nVALUE",
      "/x?%2574oken=t0k3nVALUE",
      "/x?page=2&%70assword=t0k3nVALUE",
      "/cb?next=%2Fx%3Ftoken%3Dt0k3nVALUE",
      "/cb?next=%252Fx%253Ftoken%253Dt0k3nVALUE",
    ];

    let leaking: Vec<&str> = cases.into_iter().filter(|text| leaked_by(text, "t0k3nVALUE")).collect();

    assert_eq!(leaking, Vec::<&str>::new());
  }

  #[test]
  fn keeps_the_other_query_parameters() {
    assert_eq!(redact("GET /x?token=t0k3nVALUE&page=2", &[]), "GET /x?token=[redacted]&page=2");
    assert_eq!(redact("GET /x?page=2&sort=asc", &[]), "GET /x?page=2&sort=asc");
    assert!(redact("/cb?next=%2Fx%3Ftoken%3DabcDEF123&page=2", &[]).contains("&page=2"));
  }

  #[test]
  fn masks_the_admin_token_in_its_percent_encoded_forms() {
    let secrets = vec!["abc+def/ghi=jkl_mno".to_string()];

    let masked = redact("a abc%2Bdef%2Fghi%3Djkl_mno b abc%2bdef%2fghi%3djkl_mno c %61%62%63%2B%64%65%66%2F%67%68%69%3D%6A%6B%6C%5F%6D%6E%6F", &secrets);

    assert_eq!(masked, "a [redacted] b [redacted] c [redacted]");
  }

  #[test]
  fn redaction_stays_idempotent_on_every_shape() {
    let once = redact("Bearer:abc Basic dXNlcjpwYXNzd29yZA== https://u:p@h/ /x?token=t /hooks/tok", &[]);

    assert_eq!(redact(&once, &[]), once);
  }

  #[test]
  fn redacts_hostile_input_in_linear_time() {
    const KIBIBYTE: usize = 1024;
    const SMALL_INPUT: usize = 16 * KIBIBYTE;
    const LARGE_INPUT: usize = 4 * SMALL_INPUT;
    const MEBIBYTE: usize = 1024 * KIBIBYTE;
    const NOISE_FLOOR: Duration = Duration::from_millis(20);
    const GENEROUS_CEILING: Duration = Duration::from_secs(20);
    let units = [
      "?", "%", "%25", "/", "Bearer ", "/hooks/", "a", "&", "=", " ", "?a=%25/hooks/Bearer &Basic ", "://", "Basic ", "%2Fhooks%2F", "token=", "a=%3D",
      "Bearer", "%42earer", "Basic/", "Basic+", "bearerx", "Authorization: Basic",
    ];
    let secrets = vec!["s3cr3t-admin-token".to_string()];
    let fastest_redaction_of = |unit: &str, size: usize| {
      let hostile = unit.repeat(size / unit.len() + 1);
      (0..3)
        .map(|_| {
          let started_at = Instant::now();
          redact(&hostile, &secrets);
          started_at.elapsed()
        })
        .min()
        .unwrap()
    };

    for unit in units {
      let time_at_small_input = fastest_redaction_of(unit, SMALL_INPUT).max(NOISE_FLOOR);
      let time_at_large_input = fastest_redaction_of(unit, LARGE_INPUT);
      assert!(time_at_large_input < time_at_small_input * 8, "{unit:?}: 4x the input took {time_at_large_input:?} against {time_at_small_input:?}");

      let time_at_one_mebibyte = fastest_redaction_of(unit, MEBIBYTE);
      assert!(time_at_one_mebibyte < GENEROUS_CEILING, "{unit:?} x 1 MiB took {time_at_one_mebibyte:?}");
    }
  }

  // ---- tail for the issue report ----

  #[test]
  fn returns_the_last_lines_redacted() {
    let folder = scratch_folder("tail");
    let path = folder.join(LOG_FILE_NAME);
    std::fs::write(&path, "first\nBearer abc123\nlast\n").unwrap();

    let lines = last_redacted_lines(&path, 2, &[]);

    assert_eq!(lines, vec!["Bearer [redacted]", "last"]);
    std::fs::remove_dir_all(folder).unwrap();
  }

  #[test]
  fn tops_up_from_the_rotated_file_when_the_current_one_is_short() {
    let folder = scratch_folder("topup");
    std::fs::write(folder.join("daemon.log.1"), "old1\nold2\n").unwrap();
    std::fs::write(folder.join(LOG_FILE_NAME), "new1\n").unwrap();

    let lines = last_redacted_lines(&folder.join(LOG_FILE_NAME), 3, &[]);

    assert_eq!(lines, vec!["old1", "old2", "new1"]);
    std::fs::remove_dir_all(folder).unwrap();
  }

  #[test]
  fn returns_nothing_when_there_is_no_log_yet() {
    let folder = scratch_folder("nolog");

    assert!(last_redacted_lines(&folder.join(LOG_FILE_NAME), 50, &[]).is_empty());
    std::fs::remove_dir_all(folder).unwrap();
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
    let folder = scratch_folder("perms");
    let logs = folder.join("logs");
    let path = logs.join(LOG_FILE_NAME);

    DiskFs.append(&path, b"line\n").unwrap();

    assert_eq!(std::fs::metadata(&logs).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(DiskFs.size(&path).unwrap(), 5);
    std::fs::remove_dir_all(folder).unwrap();
  }

  // ---- the writer ----

  fn writer_over(fs: &Arc<FakeFs>, max_bytes: u64, secrets: Vec<String>, capacity: usize) -> DaemonLog {
    let mut secrets_not_yet_polled = Some(secrets);
    DaemonLog::start_with_capacity(rotating(fs, max_bytes), move || secrets_not_yet_polled.take(), || 0, capacity)
  }

  #[test]
  fn the_writer_prefixes_and_redacts_each_line_of_a_chunk() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 1000, vec!["s3cr3t-admin-token".to_string()], 16);

    log.record(Stream::Out, "hello\n\nworld s3cr3t-admin-token\n");
    log.record(Stream::Err, "Bearer abc123");

    wait_until(|| fs.lines(LOG).len() == 3);
    assert_eq!(
      fs.lines(LOG),
      vec!["1970-01-01T00:00:00Z [out] hello", "1970-01-01T00:00:00Z [out] world [redacted]", "1970-01-01T00:00:00Z [err] Bearer [redacted]"]
    );
  }

  #[test]
  fn interleaved_stdout_and_stderr_lines_stay_whole() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 1_000_000, vec![], 4096);
    let out = log.clone();
    let err = log.clone();

    let out_thread = std::thread::spawn(move || (0..200).for_each(|n| out.record(Stream::Out, &format!("out-line-{n}-{}", "o".repeat(40)))));
    let err_thread = std::thread::spawn(move || (0..200).for_each(|n| err.record(Stream::Err, &format!("err-line-{n}-{}", "e".repeat(40)))));
    out_thread.join().unwrap();
    err_thread.join().unwrap();

    wait_until(|| fs.lines(LOG).len() == 400);
    let is_whole = |line: &String| {
      let is_out = line.contains("[out] out-line-") && line.ends_with(&"o".repeat(40));
      let is_err = line.contains("[err] err-line-") && line.ends_with(&"e".repeat(40));
      is_out || is_err
    };
    assert!(fs.lines(LOG).iter().all(is_whole));
  }

  #[test]
  fn a_slow_disk_drops_lines_and_the_next_write_says_how_many() {
    let fs = Arc::new(FakeFs::default());
    let (entered_sender, entered) = mpsc::channel();
    let (release, release_receiver) = mpsc::channel();
    *fs.first_append_gate.lock().unwrap() = Some((entered_sender, release_receiver));
    let log = writer_over(&fs, 10_000, vec![], 1);
    log.record(Stream::Out, "first");
    entered.recv().unwrap();

    for n in 0..4 {
      log.record(Stream::Out, &format!("burst-{n}"));
    }
    release.send(()).unwrap();

    wait_until(|| fs.lines(LOG).len() == 3);
    let lines = fs.lines(LOG);
    assert!(lines[0].ends_with("[out] first"));
    assert!(lines[1].ends_with("[log] 3 lines dropped: the log writer fell behind"));
    assert!(lines[2].ends_with("[out] burst-0"));
  }

  #[test]
  fn the_writer_picks_the_secrets_up_once_they_exist() {
    let fs = Arc::new(FakeFs::default());
    let secrets = Arc::new(Mutex::new(None::<Vec<String>>));
    let shared = secrets.clone();
    let log = DaemonLog::start_with_capacity(rotating(&fs, 1000), move || shared.lock().unwrap().take(), || 0, 16);

    log.record(Stream::Out, "before");
    wait_until(|| fs.lines(LOG).len() == 1);
    *secrets.lock().unwrap() = Some(vec!["s3cr3t-admin-token".to_string()]);
    log.record(Stream::Out, "token s3cr3t-admin-token");

    wait_until(|| fs.lines(LOG).len() == 2);
    assert!(fs.lines(LOG)[1].ends_with("token [redacted]"));
  }

  // ---- a token that changes while the writer runs ----

  struct ChangingToken {
    next: Arc<Mutex<Option<Vec<String>>>>,
    seconds: Arc<AtomicU64>,
    polls: Arc<AtomicUsize>,
  }

  impl ChangingToken {
    fn start(fs: &Arc<FakeFs>) -> (Self, DaemonLog) {
      let changing = Self { next: Arc::default(), seconds: Arc::default(), polls: Arc::default() };
      let (next, seconds, polls) = (changing.next.clone(), changing.seconds.clone(), changing.polls.clone());
      let poll = move || {
        polls.fetch_add(1, Ordering::SeqCst);
        next.lock().unwrap().take()
      };
      let log = DaemonLog::start_with_capacity(rotating(fs, 100_000), poll, move || seconds.load(Ordering::SeqCst), 64);
      (changing, log)
    }
    fn rotate_to(&self, token: &str) {
      *self.next.lock().unwrap() = Some(vec![token.to_string()]);
    }
    fn advance(&self, seconds: u64) {
      self.seconds.fetch_add(seconds, Ordering::SeqCst);
    }
  }

  #[test]
  fn a_token_rotated_while_the_writer_runs_is_masked_and_the_old_one_stays_masked() {
    let fs = Arc::new(FakeFs::default());
    let (token, log) = ChangingToken::start(&fs);
    token.rotate_to("old-admin-token-1");
    log.record(Stream::Out, "first old-admin-token-1");
    wait_until(|| fs.lines(LOG).len() == 1);

    token.rotate_to("new-admin-token-2");
    token.advance(3);
    log.record(Stream::Out, "then new-admin-token-2 and old-admin-token-1");

    wait_until(|| fs.lines(LOG).len() == 2);
    assert!(fs.lines(LOG)[1].ends_with("then [redacted] and [redacted]"), "{:?}", fs.lines(LOG));
  }

  #[test]
  fn the_writer_looks_for_a_new_token_at_most_every_two_seconds_once_it_knows_one() {
    let fs = Arc::new(FakeFs::default());
    let (token, log) = ChangingToken::start(&fs);
    token.rotate_to("old-admin-token-1");

    for (line_count, advance_by) in [(1, 0), (2, 1), (3, 1)] {
      token.advance(advance_by);
      log.record(Stream::Out, "a line");
      wait_until(|| fs.lines(LOG).len() == line_count);
    }

    assert_eq!(token.polls.load(Ordering::SeqCst), 2, "polls at 0 s (nothing known yet) and at 2 s, not at 1 s");
  }

  #[test]
  fn the_writer_keeps_only_the_last_eight_tokens() {
    let fs = Arc::new(FakeFs::default());
    let (token, log) = ChangingToken::start(&fs);
    let names: Vec<String> = (1..=10).map(|n| format!("admin-token-{n:02}")).collect();

    for (index, name) in names.iter().enumerate() {
      token.rotate_to(name);
      token.advance(2);
      log.record(Stream::Out, &format!("rotated {name}"));
      wait_until(|| fs.lines(LOG).len() == index + 1);
    }
    token.advance(2);
    log.record(Stream::Out, &format!("all {}", names.join(" ")));

    wait_until(|| fs.lines(LOG).len() == 11);
    let last_line = fs.lines(LOG).pop().unwrap();
    assert!(last_line.contains("admin-token-01 admin-token-02 [redacted] [redacted]"), "{last_line}");
    assert!(last_line.ends_with("[redacted] [redacted]"), "{last_line}");
  }

  // ---- drop accounting ----

  #[test]
  fn a_failed_write_is_counted_as_lost_and_not_blamed_on_a_slow_writer() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 10_000, vec![], 16);
    fs.fail_appends_containing("");

    log.record(Stream::Out, "lost-1");
    log.record(Stream::Out, "lost-2");
    wait_until(|| fs.failed_append_count() >= 3);
    fs.stop_failing_appends();
    log.record(Stream::Out, "fine");

    wait_until(|| fs.lines(LOG).len() == 2);
    let lines = fs.lines(LOG);
    assert!(lines[0].ends_with("[log] 2 lines lost: could not write the log file (disk full)"), "{lines:?}");
    assert!(lines[1].ends_with("[out] fine"));
    assert!(!lines.iter().any(|line| line.contains("fell behind")));
  }

  #[test]
  fn a_full_queue_is_blamed_on_the_writer_and_not_on_the_disk() {
    let fs = Arc::new(FakeFs::default());
    let (entered_sender, entered) = mpsc::channel();
    let (release, release_receiver) = mpsc::channel();
    *fs.first_append_gate.lock().unwrap() = Some((entered_sender, release_receiver));
    let log = writer_over(&fs, 10_000, vec![], 1);
    log.record(Stream::Out, "first");
    entered.recv().unwrap();
    for n in 0..3 {
      log.record(Stream::Out, &format!("burst-{n}"));
    }
    release.send(()).unwrap();

    wait_until(|| fs.lines(LOG).len() == 3);
    let lines = fs.lines(LOG);
    assert!(lines[1].ends_with("[log] 2 lines dropped: the log writer fell behind"), "{lines:?}");
    assert!(!lines.iter().any(|line| line.contains("could not write")));
  }

  #[test]
  fn the_lost_count_survives_a_notice_that_could_not_be_written() {
    let fs = Arc::new(FakeFs::default());
    let (entered_sender, entered) = mpsc::channel();
    let (release, release_receiver) = mpsc::channel();
    *fs.first_append_gate.lock().unwrap() = Some((entered_sender, release_receiver));
    let log = writer_over(&fs, 10_000, vec![], 1);
    log.record(Stream::Out, "first");
    entered.recv().unwrap();
    for n in 0..4 {
      log.record(Stream::Out, &format!("burst-{n}"));
    }
    fs.fail_appends_containing("lines dropped");
    release.send(()).unwrap();
    wait_until(|| fs.lines(LOG).len() == 2);

    fs.stop_failing_appends();
    log.record(Stream::Out, "after");

    wait_until(|| fs.lines(LOG).len() == 4);
    let lines = fs.lines(LOG);
    assert!(lines[2].ends_with("[log] 3 lines dropped: the log writer fell behind"), "{lines:?}");
    assert!(lines[3].ends_with("[out] after"));
  }

  // ---- flush on exit ----

  #[test]
  fn flush_and_close_writes_every_queued_line_before_it_returns() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, vec![], 64);
    for n in 0..30 {
      log.record(Stream::Out, &format!("line {n}"));
    }

    let drained = log.flush_and_close(Duration::from_secs(2));

    assert!(drained);
    assert_eq!(fs.lines(LOG).len(), 30);
  }

  #[test]
  fn flush_and_close_gives_up_within_its_timeout_when_the_disk_is_stuck() {
    let fs = Arc::new(FakeFs::default());
    let (entered_sender, entered) = mpsc::channel();
    let (release, release_receiver) = mpsc::channel();
    *fs.first_append_gate.lock().unwrap() = Some((entered_sender, release_receiver));
    let log = writer_over(&fs, 10_000, vec![], 4);
    log.record(Stream::Out, "stuck");
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
    let (entered_sender, entered) = mpsc::channel();
    let (release, release_receiver) = mpsc::channel();
    *fs.first_append_gate.lock().unwrap() = Some((entered_sender, release_receiver));
    let log = writer_over(&fs, 10_000, vec![], 1);
    log.record(Stream::Out, "stuck");
    entered.recv().unwrap();
    log.record(Stream::Out, "fills the queue");
    let started_at = Instant::now();

    let drained = log.flush_and_close(Duration::from_millis(100));

    assert!(!drained);
    assert!(started_at.elapsed() < Duration::from_secs(1));
    release.send(()).unwrap();
  }

  #[test]
  fn the_exit_waits_for_the_last_event_of_the_output_pipe() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, vec![], 64);
    let pipe = log.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(50));
      pipe.record(Stream::Err, "the daemon exited with code Some(0)");
      pipe.mark_output_ended();
    });

    let drained = log.close_after_output_ends(Duration::from_secs(2));

    assert!(drained);
    assert!(fs.lines(LOG).last().is_some_and(|line| line.ends_with("the daemon exited with code Some(0)")), "{:?}", fs.lines(LOG));
  }

  #[test]
  fn the_exit_does_not_wait_for_ever_for_a_pipe_that_never_ends() {
    let fs = Arc::new(FakeFs::default());
    let log = writer_over(&fs, 100_000, vec![], 64);
    log.record(Stream::Out, "queued");
    let started_at = Instant::now();

    let drained = log.close_after_output_ends(Duration::from_millis(400));

    assert!(drained);
    assert!(started_at.elapsed() < Duration::from_secs(1));
    assert_eq!(fs.lines(LOG).len(), 1);
  }
}
