use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

pub const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
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

/// Returns the login shell's PATH, or the fallback PATH when the shell failed, timed out or printed no PATH.
pub fn repair_path(run_login_shell: impl FnOnce() -> Option<String>, home: &str) -> String {
  let login_shell_path = run_login_shell().and_then(|output| parse_path_from_login_shell(&output));
  login_shell_path.unwrap_or_else(|| fallback_path(home))
}

/// Runs `$SHELL -ilc` once and returns its stdout, or None when the shell fails to start, exits non-zero or outlives `timeout`.
pub fn run_login_shell(shell: &str, timeout: Duration) -> Option<String> {
  let mut shell_process = Command::new(shell)
    .args(["-ilc", LOGIN_SHELL_SCRIPT])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let mut stdout = shell_process.stdout.take()?;
  let (sender, receiver) = mpsc::channel();
  std::thread::spawn(move || {
    let mut output = String::new();
    let _ = stdout.read_to_string(&mut output);
    let _ = sender.send(output);
  });
  match receiver.recv_timeout(timeout) {
    Ok(output) => shell_process.wait().ok()?.success().then_some(output),
    Err(_) => {
      let _ = shell_process.kill();
      let _ = shell_process.wait();
      None
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
    let path = repair_path(|| Some("noise\n__PATH__=/a/bin\n".to_string()), HOME);

    assert_eq!(path, "/a/bin");
  }

  #[test]
  fn falls_back_when_the_login_shell_times_out_or_fails() {
    assert_eq!(repair_path(|| None, HOME), FALLBACK);
  }

  #[test]
  fn falls_back_when_the_login_shell_prints_nothing_usable() {
    assert_eq!(repair_path(|| Some(String::new()), HOME), FALLBACK);
  }
}
