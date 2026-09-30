use crate::admin_token::openfleet_home_dir;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Arc;

pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
pub const KEPT_FILES: usize = 3;
pub const LOG_FILE_NAME: &str = "daemon.log";
const CHANNEL_CAPACITY: usize = 2048;
const PRIVATE_DIR_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
// ponytail: a secret shorter than this would redact innocent text; the admin token is far longer.
const MIN_SECRET_LENGTH: usize = 8;
const REDACTED: &str = "[redacted]";
const SECONDS_PER_DAY: u64 = 86_400;

fn is_bearer_token_char(character: char) -> bool {
  character.is_ascii_alphanumeric() || "-._~+/=".contains(character)
}

fn is_hook_token_char(character: char) -> bool {
  character.is_ascii_alphanumeric() || "-._~".contains(character)
}

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

/// Returns the line redacted: every known secret, `Bearer <token>` and `/hooks/<token>` become `[redacted]`.
pub fn redact(line: &str, secrets: &[String]) -> String {
  let usable_secrets = secrets.iter().filter(|secret| secret.len() >= MIN_SECRET_LENGTH);
  let without_secrets = usable_secrets.fold(line.to_string(), |text, secret| text.replace(secret.as_str(), REDACTED));
  let without_bearer_tokens = mask_token_after(&without_secrets, "bearer ", is_bearer_token_char);
  mask_token_after(&without_bearer_tokens, "/hooks/", is_hook_token_char)
}

fn mask_token_after(text: &str, marker: &str, is_token_char: fn(char) -> bool) -> String {
  let lowered = text.to_ascii_lowercase();
  let mut masked = String::with_capacity(text.len());
  let mut cursor = 0;
  while let Some(offset) = lowered[cursor..].find(marker) {
    let token_start = cursor + offset + marker.len();
    let token_length = text[token_start..].find(|character| !is_token_char(character)).unwrap_or(text.len() - token_start);
    masked.push_str(&text[cursor..token_start]);
    if token_length > 0 {
      masked.push_str(REDACTED);
    }
    cursor = token_start + token_length;
  }
  masked.push_str(&text[cursor..]);
  masked
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

/// Hands daemon output to a writer thread; never blocks the caller and counts what it had to drop.
#[derive(Clone)]
pub struct DaemonLog {
  sender: SyncSender<(Stream, String)>,
  dropped: Arc<AtomicU64>,
}

impl DaemonLog {
  pub fn start<F: LogFs + Send + 'static>(
    log: RotatingLog<F>,
    read_secrets: impl Fn() -> Vec<String> + Send + 'static,
    clock: impl Fn() -> u64 + Send + 'static,
  ) -> Self {
    Self::start_with_capacity(log, read_secrets, clock, CHANNEL_CAPACITY)
  }

  pub fn start_with_capacity<F: LogFs + Send + 'static>(
    mut log: RotatingLog<F>,
    read_secrets: impl Fn() -> Vec<String> + Send + 'static,
    clock: impl Fn() -> u64 + Send + 'static,
    capacity: usize,
  ) -> Self {
    let (sender, receiver) = sync_channel::<(Stream, String)>(capacity);
    let dropped = Arc::new(AtomicU64::new(0));
    let dropped_by_the_writer = dropped.clone();
    std::thread::spawn(move || {
      let mut secrets: Vec<String> = Vec::new();
      for (stream, line) in receiver {
        // The admin token file may only appear after the daemon's first output, so it is read until found.
        if secrets.is_empty() {
          secrets = read_secrets();
        }
        let now = clock();
        let lost = dropped_by_the_writer.swap(0, Ordering::SeqCst);
        if lost > 0 {
          let _ = log.append_line(&format!("{} [log] {lost} lines dropped: the log writer fell behind", iso_utc(now)));
        }
        if log.append_line(&format_line(stream, &redact(&line, &secrets), now)).is_err() {
          dropped_by_the_writer.fetch_add(1, Ordering::SeqCst);
        }
      }
    });
    Self { sender, dropped }
  }

  /// Queues every non-blank line of a chunk of daemon output.
  pub fn record(&self, stream: Stream, chunk: &str) {
    for line in chunk.lines().filter(|line| !line.trim().is_empty()) {
      let queue_is_full = matches!(self.sender.try_send((stream, line.to_string())), Err(TrySendError::Full(_)));
      if queue_is_full {
        self.dropped.fetch_add(1, Ordering::SeqCst);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::mpsc;
  use std::sync::Mutex;
  use std::time::{Duration, Instant};

  const LOG: &str = "/logs/daemon.log";

  #[derive(Default)]
  struct FakeFs {
    files: Mutex<HashMap<PathBuf, Vec<u8>>>,
    rename_fails: AtomicBool,
    first_append_gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
  }

  impl FakeFs {
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
    DaemonLog::start_with_capacity(rotating(fs, max_bytes), move || secrets.clone(), || 0, capacity)
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
    let secrets = Arc::new(Mutex::new(Vec::<String>::new()));
    let shared = secrets.clone();
    let log = DaemonLog::start_with_capacity(rotating(&fs, 1000), move || shared.lock().unwrap().clone(), || 0, 16);

    log.record(Stream::Out, "before");
    wait_until(|| fs.lines(LOG).len() == 1);
    *secrets.lock().unwrap() = vec!["s3cr3t-admin-token".to_string()];
    log.record(Stream::Out, "token s3cr3t-admin-token");

    wait_until(|| fs.lines(LOG).len() == 2);
    assert!(fs.lines(LOG)[1].ends_with("token [redacted]"));
  }
}
