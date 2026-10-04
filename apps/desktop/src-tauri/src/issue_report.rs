use crate::log_file::ensure_private_dir;
use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const NEW_ISSUE_URL: &str = "https://github.com/raphaeldenis/openfleet/issues/new";
/// GitHub refuses a prefilled URL beyond roughly 8 KB.
pub const MAX_URL_BYTES: usize = 7500;
pub const MAX_LINE_CHARS: usize = 400;
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const SW_VERS_TIMEOUT: Duration = Duration::from_secs(3);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub struct IssueReport {
  pub app_version: String,
  pub daemon_version: Option<String>,
  pub daemon_state: String,
  pub macos_version: String,
  pub arch: String,
  pub log_lines: Vec<String>,
  pub user_home: String,
}

/// Returns the GitHub new-issue URL prefilled with the report, the oldest log lines dropped until it fits `MAX_URL_BYTES`.
pub fn issue_url(report: &IssueReport) -> String {
  let mut lines: Vec<String> = report.log_lines.iter().map(|line| fit_line(&with_home_shortened(line, &report.user_home))).collect();
  loop {
    let url = url_with(report, &lines);
    let fits = url.len() <= MAX_URL_BYTES;
    if fits || lines.is_empty() {
      return url;
    }
    lines.remove(0);
  }
}

/// Cuts the line to `MAX_LINE_CHARS` and defuses a code fence so the log cannot close the block it sits in.
fn fit_line(line: &str) -> String {
  line.chars().take(MAX_LINE_CHARS).collect::<String>().replace("```", "'''")
}

/// Every way a log line spells the home folder: plain, JSON-escaped with and without escaped slashes, percent-encoded in both hex cases.
fn home_spellings(user_home: &str) -> Vec<String> {
  let home = user_home.trim_end_matches('/');
  if home.is_empty() {
    return Vec::new();
  }
  let json_escaped = home.replace('\\', "\\\\").replace('"', "\\\"");
  let json_escaped_with_slashes = json_escaped.replace('/', "\\/");
  vec![home.to_string(), json_escaped, json_escaped_with_slashes, percent_escaped(home, false), percent_escaped(home, true)]
}

/// Replaces the home folder with `~` wherever a whole folder name ends, so `/Users/jdoe2` is not taken for `/Users/jdoe`.
pub fn with_home_shortened(text: &str, user_home: &str) -> String {
  home_spellings(user_home).iter().fold(text.to_string(), |shortened, spelling| with_folder_shortened(&shortened, spelling))
}

fn with_folder_shortened(text: &str, folder: &str) -> String {
  let mut shortened = String::with_capacity(text.len());
  let mut copied_up_to = 0;
  for (start, _) in text.match_indices(folder) {
    let end = start + folder.len();
    let name_continues = text[end..].chars().next().is_some_and(|next| next.is_alphanumeric() || "._-".contains(next));
    if name_continues {
      continue;
    }
    shortened.push_str(&text[copied_up_to..start]);
    shortened.push('~');
    copied_up_to = end;
  }
  shortened.push_str(&text[copied_up_to..]);
  shortened
}

fn url_with(report: &IssueReport, lines: &[String]) -> String {
  let field = |text: &str| with_home_shortened(text, &report.user_home);
  let daemon_version = field(report.daemon_version.as_deref().unwrap_or("unknown"));
  let log_block = if lines.is_empty() { "(no daemon log yet)".to_string() } else { lines.join("\n") };
  let body = format!(
    "Describe what went wrong:\n\n\n---\nApp version: {}\nDaemon version: {daemon_version}\nmacOS: {}\nCPU: {}\nDaemon state: {}\n\nLast daemon log lines:\n```\n{log_block}\n```\n",
    field(&report.app_version),
    field(&report.macos_version),
    field(&report.arch),
    field(&report.daemon_state)
  );
  let title = format!("Bug report: OpenFleet {}", report.app_version);
  format!("{NEW_ISSUE_URL}?title={}&body={}", percent_encoded(&title), percent_encoded(&body))
}

fn percent_encoded(text: &str) -> String {
  percent_escaped(text, false)
}

fn percent_escaped(text: &str, lowercase_hex: bool) -> String {
  text.bytes().fold(String::with_capacity(text.len() * 3), |mut encoded, byte| {
    let is_unreserved = byte.is_ascii_alphanumeric() || b"-._~".contains(&byte);
    if is_unreserved {
      encoded.push(byte as char);
    } else if lowercase_hex {
      encoded.push_str(&format!("%{byte:02x}"));
    } else {
      encoded.push_str(&format!("%{byte:02X}"));
    }
    encoded
  })
}

/// Clears the busy flag when the job ends, however it ends.
struct ClearOnDrop<'a>(&'a AtomicBool);

impl Drop for ClearOnDrop<'_> {
  fn drop(&mut self) {
    self.0.store(false, Ordering::SeqCst);
  }
}

/// Runs the job unless one is already running on the same flag, in which case the call does nothing and succeeds.
pub fn run_unless_busy(in_flight: &AtomicBool, job: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
  let another_is_running = in_flight.swap(true, Ordering::SeqCst);
  if another_is_running {
    return Ok(());
  }
  let _clears_the_flag = ClearOnDrop(in_flight);
  job()
}

/// Opens the folder in the file manager.
pub fn reveal_logs_dir(logs_dir: &Path, open: impl Fn(&Path) -> io::Result<()>) -> Result<(), String> {
  ensure_private_dir(logs_dir).map_err(|err| format!("could not create {}: {err}", logs_dir.display()))?;
  open(logs_dir).map_err(|err| format!("could not open {}: {err}", logs_dir.display()))
}

/// Opens the prefilled issue form in the default browser; the webview supplies nothing.
pub fn open_issue_form(report: &IssueReport, open: impl Fn(&str) -> io::Result<()>) -> Result<(), String> {
  open(&issue_url(report)).map_err(|err| format!("could not open the browser: {err}"))
}

/// Runs the command and returns what it printed; fails when it exits unsuccessfully or outlives `timeout`, in which case it is killed.
pub fn run_within(mut command: Command, timeout: Duration) -> io::Result<String> {
  let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
  let deadline = Instant::now() + timeout;
  loop {
    if let Some(status) = child.try_wait()? {
      return finished_output(&mut child, status, &command);
    }
    if Instant::now() >= deadline {
      let _ = child.kill();
      let _ = child.wait();
      return Err(io::Error::new(io::ErrorKind::TimedOut, format!("{:?} did not finish within {}s", command.get_program(), timeout.as_secs_f32())));
    }
    std::thread::sleep(COMMAND_POLL_INTERVAL);
  }
}

// ponytail: reads the pipe only after the exit, so a command printing more than a pipe buffer (64 KB) would time out; `open` and `sw_vers` print a line.
fn finished_output(child: &mut Child, status: ExitStatus, command: &Command) -> io::Result<String> {
  if !status.success() {
    return Err(io::Error::other(format!("{:?} exited with {status}", command.get_program())));
  }
  let mut printed = String::new();
  if let Some(mut stdout) = child.stdout.take() {
    stdout.read_to_string(&mut printed)?;
  }
  Ok(printed)
}

/// Asks macOS to open a folder or URL with its default application.
pub fn open_with_macos(target: &OsStr) -> io::Result<()> {
  let mut open = Command::new("/usr/bin/open");
  open.arg(target);
  run_within(open, OPEN_TIMEOUT).map(|_| ())
}

/// Asks macOS to show a file selected in Finder.
pub fn reveal_in_macos(target: &OsStr) -> io::Result<()> {
  let mut open = Command::new("/usr/bin/open");
  open.arg("-R").arg(target);
  run_within(open, OPEN_TIMEOUT).map(|_| ())
}

/// Returns the macOS product version, `unknown` when `sw_vers` does not answer in time.
pub fn macos_version() -> String {
  let mut sw_vers = Command::new("/usr/bin/sw_vers");
  sw_vers.arg("-productVersion");
  let version = run_within(sw_vers, SW_VERS_TIMEOUT).ok().map(|printed| printed.trim().to_string());
  version.filter(|version| !version.is_empty()).unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_second_invocation_is_ignored_while_one_is_running_and_allowed_once_it_ends() {
    let in_flight = AtomicBool::new(false);
    let mut nested_runs = 0;

    let outer = run_unless_busy(&in_flight, || {
      let nested = run_unless_busy(&in_flight, || {
        nested_runs += 1;
        Ok(())
      });
      assert_eq!(nested, Ok(()));
      Ok(())
    });
    let mut later_runs = 0;
    let later = run_unless_busy(&in_flight, || {
      later_runs += 1;
      Ok(())
    });

    assert_eq!((outer, later), (Ok(()), Ok(())));
    assert_eq!(nested_runs, 0, "ignored while the first runs");
    assert_eq!(later_runs, 1, "allowed again after it ended");
  }

  #[test]
  fn the_busy_flag_is_released_when_the_job_fails() {
    let in_flight = AtomicBool::new(false);

    let failed = run_unless_busy(&in_flight, || Err("boom".to_string()));
    let mut retried = false;
    let _ = run_unless_busy(&in_flight, || {
      retried = true;
      Ok(())
    });

    assert_eq!(failed, Err("boom".to_string()));
    assert!(retried);
  }
  use std::cell::RefCell;

  fn report_with(log_lines: Vec<String>) -> IssueReport {
    IssueReport {
      app_version: "0.2.0".to_string(),
      daemon_version: Some("0.2.0".to_string()),
      daemon_state: "ready".to_string(),
      macos_version: "15.4".to_string(),
      arch: "aarch64".to_string(),
      log_lines,
      user_home: "/Users/jdoe".to_string(),
    }
  }

  fn decoded_body(url: &str) -> String {
    let encoded = url.split("&body=").nth(1).unwrap();
    let mut bytes = Vec::new();
    let raw = encoded.as_bytes();
    let mut index = 0;
    while index < raw.len() {
      if raw[index] == b'%' {
        bytes.push(u8::from_str_radix(&encoded[index + 1..index + 3], 16).unwrap());
        index += 3;
      } else {
        bytes.push(raw[index]);
        index += 1;
      }
    }
    String::from_utf8(bytes).unwrap()
  }

  #[test]
  fn targets_the_new_issue_form_of_the_openfleet_repository_with_a_title() {
    let url = issue_url(&report_with(vec![]));

    assert!(url.starts_with("https://github.com/raphaeldenis/openfleet/issues/new?title="));
    assert!(url.contains("&body="));
  }

  #[test]
  fn the_body_carries_the_versions_the_system_the_daemon_state_and_the_log_lines() {
    let body = decoded_body(&issue_url(&report_with(vec!["first line".to_string(), "second line".to_string()])));

    assert!(body.contains("App version: 0.2.0"));
    assert!(body.contains("Daemon version: 0.2.0"));
    assert!(body.contains("macOS: 15.4"));
    assert!(body.contains("CPU: aarch64"));
    assert!(body.contains("Daemon state: ready"));
    assert!(body.contains("first line\nsecond line"));
  }

  #[test]
  fn says_unknown_when_the_daemon_version_is_not_known() {
    let report = IssueReport { daemon_version: None, ..report_with(vec![]) };

    assert!(decoded_body(&issue_url(&report)).contains("Daemon version: unknown"));
  }

  #[test]
  fn encodes_newlines_quotes_unicode_and_reserved_characters() {
    let url = issue_url(&report_with(vec![r#"say "héllo" & 日本 #1 100%"#.to_string()]));

    assert!(!url.contains(['\n', ' ', '"', '#', '日']));
    assert!(url.contains("%0A"));
    assert!(url.contains("%22h%C3%A9llo%22"));
    assert!(url.contains("%E6%97%A5"));
    assert_eq!(url.matches('&').count(), 1);
    assert!(decoded_body(&url).contains(r#"say "héllo" & 日本 #1 100%"#));
  }

  #[test]
  fn a_backtick_fence_in_a_log_line_cannot_close_the_code_block() {
    let body = decoded_body(&issue_url(&report_with(vec!["```boom```".to_string()])));

    assert_eq!(body.matches("```").count(), 2);
  }

  #[test]
  fn stays_within_the_size_cap_dropping_the_oldest_lines_first() {
    let lines: Vec<String> = (0..50).map(|n| format!("line-{n:02} {}", "é".repeat(MAX_LINE_CHARS))).collect();

    let url = issue_url(&report_with(lines));

    assert!(url.len() <= MAX_URL_BYTES);
    let body = decoded_body(&url);
    assert!(body.contains("line-49"));
    assert!(!body.contains("line-00"));
  }

  #[test]
  fn a_single_huge_line_is_cut_instead_of_dropped() {
    let url = issue_url(&report_with(vec!["x".repeat(100_000)]));

    assert!(url.len() <= MAX_URL_BYTES);
    assert!(decoded_body(&url).contains(&"x".repeat(MAX_LINE_CHARS)));
  }

  #[test]
  fn shortens_the_home_folder_to_a_tilde_in_every_spelling_a_log_line_uses() {
    let lines = [
      r#"{"msg":"worktree at /Users/jdoe/work/app"}"#,
      "opened %2FUsers%2Fjdoe%2Fwork",
      "opened %2fUsers%2fjdoe%2fwork",
      r#"{"path":"\/Users\/jdoe\/work"}"#,
      "cwd=/Users/jdoe",
      "/Users/jdoe/a and /Users/jdoe/b",
    ]
    .map(str::to_string)
    .to_vec();

    let body = decoded_body(&issue_url(&report_with(lines)));

    assert!(!body.contains("jdoe"), "the body still names the user:\n{body}");
    assert!(body.contains("worktree at ~/work/app"));
    assert!(body.contains("cwd=~\n"));
    assert!(body.contains("~/a and ~/b"));
  }

  #[test]
  fn shortens_the_home_folder_in_the_report_fields_too() {
    let report = IssueReport { daemon_state: "failed at /Users/jdoe/x".to_string(), macos_version: "15.4 /Users/jdoe".to_string(), ..report_with(vec![]) };

    let body = decoded_body(&issue_url(&report));

    assert!(!body.contains("jdoe"), "the body still names the user:\n{body}");
    assert!(body.contains("Daemon state: failed at ~/x"));
  }

  #[test]
  fn shortens_a_home_folder_with_characters_that_json_escapes() {
    let report = IssueReport { user_home: "/Users/j\"doe".to_string(), ..report_with(vec![r#"{"path":"/Users/j\"doe/x"}"#.to_string()]) };

    let body = decoded_body(&issue_url(&report));

    assert!(!body.contains("doe"), "the body still names the user:\n{body}");
  }

  #[test]
  fn leaves_another_folder_that_starts_with_the_home_name_alone() {
    let body = decoded_body(&issue_url(&report_with(vec!["/Users/jdoe2/x and /Users/jdoe/y".to_string()])));

    assert!(body.contains("/Users/jdoe2/x and ~/y"));
  }

  #[test]
  fn cuts_a_line_after_the_home_folder_is_shortened_not_before() {
    let line = format!("/Users/jdoe/{}", "x".repeat(MAX_LINE_CHARS - 2));

    let body = decoded_body(&issue_url(&report_with(vec![line])));

    assert!(body.contains(&format!("~/{}", "x".repeat(MAX_LINE_CHARS - 2))));
  }

  #[test]
  fn shortens_nothing_when_the_home_folder_is_the_root_or_empty() {
    for user_home in ["", "/"] {
      let report = IssueReport { user_home: user_home.to_string(), ..report_with(vec!["/usr/bin/x".to_string()]) };

      assert!(decoded_body(&issue_url(&report)).contains("/usr/bin/x"));
    }
  }

  #[test]
  fn keeps_every_line_when_they_fit() {
    let lines: Vec<String> = (0..5).map(|n| format!("short-{n}")).collect();

    let body = decoded_body(&issue_url(&report_with(lines)));

    assert!((0..5).all(|n| body.contains(&format!("short-{n}"))));
  }

  #[test]
  fn reveals_exactly_the_logs_folder_and_creates_it_first() {
    let folder = std::env::temp_dir().join(format!("of-reveal-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    let logs = folder.join("logs");
    let opened = RefCell::new(Vec::new());

    let outcome = reveal_logs_dir(&logs, |path| {
      opened.borrow_mut().push(path.to_path_buf());
      Ok(())
    });

    assert_eq!(outcome, Ok(()));
    assert_eq!(*opened.borrow(), vec![logs.clone()]);
    assert!(logs.is_dir());
    std::fs::remove_dir_all(folder).unwrap();
  }

  #[test]
  fn a_failing_open_is_reported_with_its_cause() {
    let folder = std::env::temp_dir().join(format!("of-reveal-fail-{}", std::process::id()));

    let outcome = reveal_logs_dir(&folder.join("logs"), |_| Err(io::Error::other("no finder")));

    assert!(outcome.unwrap_err().contains("no finder"));
    let _ = std::fs::remove_dir_all(folder);
  }

  #[test]
  fn opens_only_the_prefilled_openfleet_issue_form() {
    let opened = RefCell::new(Vec::new());

    let outcome = open_issue_form(&report_with(vec!["a line".to_string()]), |url| {
      opened.borrow_mut().push(url.to_string());
      Ok(())
    });

    assert_eq!(outcome, Ok(()));
    assert_eq!(opened.borrow().len(), 1);
    assert!(opened.borrow()[0].starts_with("https://github.com/raphaeldenis/openfleet/issues/new?title="));
  }

  #[test]
  fn a_command_that_outlives_its_timeout_is_killed_and_reported() {
    let started_at = std::time::Instant::now();
    let mut sleeper = Command::new("/bin/sleep");
    sleeper.arg("30");

    let outcome = run_within(sleeper, Duration::from_millis(200));

    assert_eq!(outcome.unwrap_err().kind(), io::ErrorKind::TimedOut);
    assert!(started_at.elapsed() < Duration::from_secs(5));
  }

  #[test]
  fn a_command_that_finishes_in_time_returns_what_it_printed() {
    let mut echo = Command::new("/bin/echo");
    echo.arg("hello");

    assert_eq!(run_within(echo, Duration::from_secs(5)).unwrap(), "hello\n");
  }

  #[test]
  fn a_command_that_exits_unsuccessfully_is_an_error() {
    let outcome = run_within(Command::new("/usr/bin/false"), Duration::from_secs(5));

    assert!(outcome.unwrap_err().to_string().contains("exited with"));
  }

  #[test]
  fn a_missing_program_is_an_error() {
    assert!(run_within(Command::new("/nonexistent/program"), Duration::from_secs(5)).is_err());
  }

  #[test]
  fn the_webview_is_granted_no_opener_permission() {
    let capabilities = include_str!("../capabilities/default.json");

    assert!(!capabilities.contains("opener"));
    assert!(!capabilities.contains("shell:"));
  }
}
