/// Why Tauri asks the app to exit.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ExitRequest {
  /// The last window was destroyed; Tauri reports no exit code.
  LastWindowClosed,
  /// Quit from the menu, Cmd+Q, the Dock or `AppHandle::exit`; Tauri reports an exit code.
  Quit,
}

#[derive(Debug, PartialEq)]
pub enum ExitDecision {
  KeepRunning,
  StopDaemonAndExit,
}

impl ExitRequest {
  pub fn from_exit_code(code: Option<i32>) -> Self {
    match code {
      Some(_) => Self::Quit,
      None => Self::LastWindowClosed,
    }
  }
}

/// Closing the last window keeps the app and its daemon alive; only a real quit stops the fleet.
pub fn decide_exit(request: ExitRequest, open_window_count: usize) -> ExitDecision {
  let is_last_window_gone = request == ExitRequest::LastWindowClosed && open_window_count == 0;
  if is_last_window_gone {
    return ExitDecision::KeepRunning;
  }
  ExitDecision::StopDaemonAndExit
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_exit_request_without_code_is_the_last_window_closing() {
    assert_eq!(ExitRequest::from_exit_code(None), ExitRequest::LastWindowClosed);
  }

  #[test]
  fn an_exit_request_with_a_code_is_a_quit() {
    assert_eq!(ExitRequest::from_exit_code(Some(0)), ExitRequest::Quit);
  }

  #[test]
  fn closing_the_last_window_keeps_the_app_running() {
    assert_eq!(decide_exit(ExitRequest::LastWindowClosed, 0), ExitDecision::KeepRunning);
  }

  #[test]
  fn a_quit_stops_the_daemon_and_exits_even_when_a_window_is_open() {
    assert_eq!(decide_exit(ExitRequest::Quit, 1), ExitDecision::StopDaemonAndExit);
  }

  #[test]
  fn a_quit_stops_the_daemon_and_exits_when_no_window_is_left() {
    assert_eq!(decide_exit(ExitRequest::Quit, 0), ExitDecision::StopDaemonAndExit);
  }

  #[test]
  fn a_codeless_request_while_windows_remain_is_not_a_window_close() {
    assert_eq!(decide_exit(ExitRequest::LastWindowClosed, 2), ExitDecision::StopDaemonAndExit);
  }
}
