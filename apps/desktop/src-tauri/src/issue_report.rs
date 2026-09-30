use std::io;
use std::path::Path;

pub const NEW_ISSUE_URL: &str = "https://github.com/raphaeldenis/openfleet/issues/new";
/// GitHub refuses a prefilled URL beyond roughly 8 KB.
pub const MAX_URL_BYTES: usize = 7500;
pub const MAX_LINE_CHARS: usize = 400;

pub struct IssueReport {
  pub app_version: String,
  pub daemon_version: Option<String>,
  pub daemon_state: String,
  pub macos_version: String,
  pub arch: String,
  pub log_lines: Vec<String>,
}

/// Returns the GitHub new-issue URL prefilled with the report, the oldest log lines dropped until it fits `MAX_URL_BYTES`.
pub fn issue_url(_report: &IssueReport) -> String {
  todo!()
}

/// Opens the folder in the file manager.
pub fn reveal_logs_dir(_logs_dir: &Path, _open: impl Fn(&Path) -> io::Result<()>) -> Result<(), String> {
  todo!()
}

/// Opens the prefilled issue form in the default browser; the webview supplies nothing.
pub fn open_issue_form(_report: &IssueReport, _open: impl Fn(&str) -> io::Result<()>) -> Result<(), String> {
  todo!()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;

  fn report_with(log_lines: Vec<String>) -> IssueReport {
    IssueReport {
      app_version: "0.2.0".to_string(),
      daemon_version: Some("0.2.0".to_string()),
      daemon_state: "ready".to_string(),
      macos_version: "15.4".to_string(),
      arch: "aarch64".to_string(),
      log_lines,
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
  fn the_webview_is_granted_no_opener_permission() {
    let capabilities = include_str!("../capabilities/default.json");

    assert!(!capabilities.contains("opener"));
    assert!(!capabilities.contains("shell:"));
  }
}
