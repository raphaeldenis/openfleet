use serde::Serialize;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

pub const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const READ_CHUNK_BYTES: usize = 4096;
const LOGIN_SHELL_SCRIPT: &str = r#"command -v claude; echo "__PATH__=$PATH""#;
const PATH_MARKER: &str = "__PATH__=";

/// Returns the PATH printed by the login shell, ignoring any noise the shell rc files print around it.
pub fn parse_path_from_login_shell(output: &str) -> Option<String> {
  let mut path_line_values = output.lines().filter_map(|line| line.strip_prefix(PATH_MARKER));
  let last_value = path_line_values.next_back()?.trim();
  (!last_value.is_empty()).then(|| last_value.to_string())
}

/// Returns the PATH used when the login shell gives none.
pub fn fallback_path(home: &str) -> String {
  format!("/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:/usr/bin:/bin")
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PathSource {
  Shell,
  Fallback,
}

#[derive(Debug, PartialEq)]
pub struct RepairedPath {
  pub path: String,
  pub source: PathSource,
}

/// Returns the login shell's PATH, or the fallback PATH when the shell failed, timed out or printed no PATH.
pub fn repair_path(run_login_shell: impl FnOnce() -> Option<String>, home: &str) -> RepairedPath {
  let login_shell_path = run_login_shell().and_then(|output| parse_path_from_login_shell(&output));
  match login_shell_path {
    Some(path) => RepairedPath { path, source: PathSource::Shell },
    None => RepairedPath { path: fallback_path(home), source: PathSource::Fallback },
  }
}

/// Runs `$SHELL -ilc` once and returns its stdout, or None when the shell fails to start, exits non-zero or outlives `timeout`.
pub fn run_login_shell(shell: &str, timeout: Duration) -> Option<String> {
  run_shell_script(shell, &["-ilc", LOGIN_SHELL_SCRIPT], timeout)
}

fn has_complete_path_line(output: &[u8]) -> bool {
  let text = String::from_utf8_lossy(output);
  let Some(last_newline) = text.rfind('\n') else { return false };
  parse_path_from_login_shell(&text[..=last_newline]).is_some()
}

fn kill_process_group(group_id: u32) {
  // SAFETY: kill(2) takes plain integers; a negative pid addresses the process group.
  unsafe { libc::kill(-(group_id as libc::pid_t), libc::SIGKILL) };
}

/// Runs the shell in its own process group and returns its stdout once the shell has exited with a PATH line (or closed its output),
/// or None when it fails to start, exits non-zero or outlives `timeout`; the group is killed on the way out so no background job leaks.
fn run_shell_script(shell: &str, args: &[&str], timeout: Duration) -> Option<String> {
  let mut shell_process = Command::new(shell)
    .args(args)
    .process_group(0)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let group_id = shell_process.id();
  let mut stdout = shell_process.stdout.take()?;
  let (sender, receiver) = mpsc::channel::<Vec<u8>>();
  std::thread::spawn(move || {
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    while let Ok(read) = stdout.read(&mut chunk) {
      if read == 0 || sender.send(chunk[..read].to_vec()).is_err() {
        break;
      }
    }
  });

  let deadline = Instant::now() + timeout;
  let mut output: Vec<u8> = Vec::new();
  let mut is_output_open = true;
  let mut exit_status: Option<ExitStatus> = None;
  loop {
    if is_output_open {
      match receiver.recv_timeout(OUTPUT_POLL_INTERVAL) {
        Ok(chunk) => output.extend_from_slice(&chunk),
        Err(RecvTimeoutError::Timeout) => {}
        Err(RecvTimeoutError::Disconnected) => is_output_open = false,
      }
    } else {
      std::thread::sleep(OUTPUT_POLL_INTERVAL);
    }
    if exit_status.is_none() {
      exit_status = shell_process.try_wait().ok().flatten();
    }
    let has_shell_answered = exit_status.is_some() && (has_complete_path_line(&output) || !is_output_open);
    if has_shell_answered {
      kill_process_group(group_id);
      return exit_status?.success().then(|| String::from_utf8_lossy(&output).into_owned());
    }
    if Instant::now() >= deadline {
      kill_process_group(group_id);
      let _ = shell_process.wait();
      return None;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const HOME: &str = "/Users/test";
  const FALLBACK: &str = "/opt/homebrew/bin:/usr/local/bin:/Users/test/.local/bin:/usr/bin:/bin";

  #[test]
  fn parses_the_path_line_between_shell_noise() {
    let output = "Welcome back!\n/Users/test/.local/bin/claude\n__PATH__=/a/bin:/b/bin\nlogout hook ran\n";

    assert_eq!(parse_path_from_login_shell(output), Some("/a/bin:/b/bin".to_string()));
  }

  #[test]
  fn parses_the_path_when_claude_is_not_found() {
    assert_eq!(parse_path_from_login_shell("__PATH__=/a/bin\n"), Some("/a/bin".to_string()));
  }

  #[test]
  fn keeps_the_last_path_line_when_an_rc_file_echoes_the_marker_too() {
    let output = "__PATH__=/from/rc\n__PATH__=/real/bin\n";

    assert_eq!(parse_path_from_login_shell(output), Some("/real/bin".to_string()));
  }

  #[test]
  fn finds_no_path_in_empty_output() {
    assert_eq!(parse_path_from_login_shell(""), None);
  }

  #[test]
  fn finds_no_path_when_the_marker_is_absent_or_its_value_is_blank() {
    assert_eq!(parse_path_from_login_shell("some noise\n"), None);
    assert_eq!(parse_path_from_login_shell("__PATH__=\n"), None);
    assert_eq!(parse_path_from_login_shell("__PATH__=   \n"), None);
  }

  #[test]
  fn builds_the_fallback_path_from_the_home_folder() {
    assert_eq!(fallback_path(HOME), FALLBACK);
  }

  #[test]
  fn repairs_the_path_with_the_login_shell_output() {
    let repaired = repair_path(|| Some("noise\n__PATH__=/a/bin\n".to_string()), HOME);

    assert_eq!(repaired, RepairedPath { path: "/a/bin".to_string(), source: PathSource::Shell });
  }

  #[test]
  fn falls_back_when_the_login_shell_times_out_or_fails() {
    assert_eq!(repair_path(|| None, HOME), RepairedPath { path: FALLBACK.to_string(), source: PathSource::Fallback });
  }

  #[test]
  fn falls_back_when_the_login_shell_prints_nothing_usable() {
    assert_eq!(repair_path(|| Some(String::new()), HOME), RepairedPath { path: FALLBACK.to_string(), source: PathSource::Fallback });
  }

  #[test]
  fn serializes_the_path_source_in_lowercase() {
    assert_eq!(serde_json::to_string(&PathSource::Shell).unwrap(), r#""shell""#);
    assert_eq!(serde_json::to_string(&PathSource::Fallback).unwrap(), r#""fallback""#);
  }

  const SHORT: Duration = Duration::from_millis(400);
  const PLENTY: Duration = Duration::from_secs(10);

  fn run_sh(script: &str, timeout: Duration) -> Option<String> {
    run_shell_script("/bin/sh", &["-c", script], timeout)
  }

  fn scratch_file(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("openfleet-path-repair-{}-{name}", std::process::id()))
  }

  #[test]
  fn keeps_the_path_when_the_shell_prints_a_non_utf8_byte() {
    let output = run_sh(r"printf '\377 motd\n__PATH__=/a/bin\n'", PLENTY).unwrap();

    assert_eq!(parse_path_from_login_shell(&output), Some("/a/bin".to_string()));
  }

  #[test]
  fn returns_the_output_of_a_shell_that_exits_zero() {
    assert_eq!(run_sh("echo __PATH__=/x", PLENTY), Some("__PATH__=/x\n".to_string()));
  }

  #[test]
  fn returns_nothing_when_the_shell_exits_non_zero() {
    assert_eq!(run_sh("echo __PATH__=/x; exit 3", PLENTY), None);
  }

  #[test]
  fn does_not_wait_for_a_background_job_that_keeps_the_pipe_open() {
    let started = std::time::Instant::now();

    let output = run_sh("sleep 30 & echo __PATH__=/x", PLENTY);

    assert_eq!(output, Some("__PATH__=/x\n".to_string()));
    assert!(started.elapsed() < Duration::from_secs(5));
  }

  #[test]
  fn kills_the_whole_process_group_on_timeout() {
    let pid_file = scratch_file("timeout-grandchild");
    let script = format!("sleep 30 & echo $! > {}; wait", pid_file.display());

    let output = run_sh(&script, SHORT);

    assert_eq!(output, None);
    let grandchild: u32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    let _ = std::fs::remove_file(&pid_file);
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while crate::daemon::is_process_alive(grandchild) && std::time::Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!crate::daemon::is_process_alive(grandchild));
  }

  #[test]
  fn returns_nothing_when_the_shell_never_prints_and_never_exits() {
    assert_eq!(run_sh("sleep 30", SHORT), None);
  }
}
