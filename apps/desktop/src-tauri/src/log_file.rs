use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
pub const KEPT_FILES: usize = 3;
pub const LOG_FILE_NAME: &str = "daemon.log";
const CHANNEL_CAPACITY: usize = 2048;
const MIN_SECRET_LENGTH: usize = 8;
const REDACTED: &str = "[redacted]";

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
  fn size(&self, _path: &Path) -> io::Result<u64> {
    todo!()
  }
  fn append(&self, _path: &Path, _bytes: &[u8]) -> io::Result<()> {
    todo!()
  }
  fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
    todo!()
  }
}

/// Returns `$OPENFLEET_HOME/logs`, else `~/.openfleet/logs`.
pub fn logs_dir(_openfleet_home: Option<String>, _user_home: &Path) -> PathBuf {
  todo!()
}

/// Creates the folder (and its parents) readable by the owner only.
pub fn ensure_private_dir(_dir: &Path) -> io::Result<()> {
  todo!()
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
  pub fn open(_fs: F, _path: PathBuf, _max_bytes: u64, _kept_files: usize) -> Self {
    todo!()
  }

  /// Writes the line and a newline; a failing rotation is skipped, never raised.
  pub fn append_line(&mut self, _line: &str) -> io::Result<()> {
    todo!()
  }
}

/// Returns the line redacted: every known secret, `Bearer <token>` and `/hooks/<token>` become `[redacted]`.
pub fn redact(_line: &str, _secrets: &[String]) -> String {
  todo!()
}

/// Returns the line as the log stores it: `<ts> [out|err] <line>`, a daemon NDJSON line untouched.
pub fn format_line(_stream: Stream, _line: &str, _unix_seconds: u64) -> String {
  todo!()
}

/// Returns the last `count` lines of the log (topping up from `path.1`), redacted.
pub fn last_redacted_lines(_path: &Path, _count: usize, _secrets: &[String]) -> Vec<String> {
  todo!()
}

/// Hands daemon output to a writer thread; never blocks the caller and counts what it had to drop.
#[derive(Clone)]
pub struct DaemonLog {
  sender: SyncSender<(Stream, String)>,
  dropped: Arc<AtomicU64>,
}

impl DaemonLog {
  pub fn start<F: LogFs + Send + 'static>(
    _log: RotatingLog<F>,
    _read_secrets: impl Fn() -> Vec<String> + Send + 'static,
    _clock: impl Fn() -> u64 + Send + 'static,
  ) -> Self {
    todo!()
  }

  pub fn start_with_capacity<F: LogFs + Send + 'static>(
    _log: RotatingLog<F>,
    _read_secrets: impl Fn() -> Vec<String> + Send + 'static,
    _clock: impl Fn() -> u64 + Send + 'static,
    _capacity: usize,
  ) -> Self {
    todo!()
  }

  /// Queues every non-blank line of a chunk of daemon output.
  pub fn record(&self, _stream: Stream, _chunk: &str) {
    todo!()
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
