use crate::path_repair::{repair_path, run_login_shell, LOGIN_SHELL_TIMEOUT};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const HEALTH_ADDRESS: &str = "127.0.0.1:7331";
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
pub const READY_TIMEOUT: Duration = Duration::from_secs(15);
pub const GRACE_BEFORE_SIGKILL: Duration = Duration::from_secs(12);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DaemonPhase {
  Starting,
  Ready,
  Failed,
  Reused,
}

/// What the webview learns about the daemon through the `daemon_status` command.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
  pub state: DaemonPhase,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_line: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub path_tried: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum StopOutcome {
  ExitedOnSigterm,
  KilledAfterGrace,
}

/// Returns the last non-blank line of a chunk of daemon output.
pub fn last_non_blank_line(chunk: &str) -> Option<String> {
  chunk.lines().map(str::trim).rfind(|line| !line.is_empty()).map(str::to_string)
}

/// Returns true when the daemon at `address` answers `GET /health` with a 200 within `timeout`.
pub fn probe_health(address: &str, timeout: Duration) -> bool {
  let Ok(socket_address) = address.parse::<SocketAddr>() else { return false };
  let Ok(mut stream) = TcpStream::connect_timeout(&socket_address, timeout) else { return false };
  let _ = stream.set_read_timeout(Some(timeout));
  let _ = stream.set_write_timeout(Some(timeout));
  let request = format!("GET /health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
  if stream.write_all(request.as_bytes()).is_err() {
    return false;
  }
  let mut response = String::new();
  let _ = stream.read_to_string(&mut response);
  response.starts_with("HTTP/1.1 200")
}

/// Polls `/health` until it answers, `total` elapses or `keep_waiting` turns false; returns whether the daemon answered.
pub fn wait_until_healthy(address: &str, total: Duration, keep_waiting: impl Fn() -> bool) -> bool {
  let deadline = Instant::now() + total;
  while Instant::now() < deadline && keep_waiting() {
    if probe_health(address, PROBE_TIMEOUT) {
      return true;
    }
    std::thread::sleep(READY_POLL_INTERVAL);
  }
  false
}

/// Sends SIGTERM, waits up to `grace` for the process to exit, then sends SIGKILL.
pub fn terminate_gracefully(pid: u32, grace: Duration, mut has_exited: impl FnMut() -> bool) -> StopOutcome {
  send_signal(pid, libc::SIGTERM);
  let deadline = Instant::now() + grace;
  while Instant::now() < deadline {
    if has_exited() {
      return StopOutcome::ExitedOnSigterm;
    }
    std::thread::sleep(EXIT_POLL_INTERVAL);
  }
  if has_exited() {
    return StopOutcome::ExitedOnSigterm;
  }
  send_signal(pid, libc::SIGKILL);
  StopOutcome::KilledAfterGrace
}

/// Returns true while a process with this pid exists.
pub fn is_process_alive(pid: u32) -> bool {
  const NO_SIGNAL: i32 = 0;
  send_signal(pid, NO_SIGNAL)
}

fn send_signal(pid: u32, signal: i32) -> bool {
  // SAFETY: kill(2) takes plain integers and has no memory-safety preconditions.
  unsafe { libc::kill(pid as libc::pid_t, signal) == 0 }
}

/// Tauri state: the daemon's status for the webview and the sidecar handle to stop on quit.
pub struct DaemonState {
  status: Mutex<DaemonStatus>,
  last_stderr_line: Mutex<Option<String>>,
  child: Mutex<Option<CommandChild>>,
}

impl DaemonState {
  pub fn new() -> Self {
    let starting = DaemonStatus { state: DaemonPhase::Starting, last_line: None, path_tried: None };
    Self { status: Mutex::new(starting), last_stderr_line: Mutex::new(None), child: Mutex::new(None) }
  }

  fn phase(&self) -> DaemonPhase {
    self.status.lock().unwrap().state
  }

  fn set_phase(&self, state: DaemonPhase, last_line: Option<String>) {
    let mut status = self.status.lock().unwrap();
    status.state = state;
    status.last_line = last_line;
  }

  fn set_phase_if_starting(&self, state: DaemonPhase, last_line: Option<String>) {
    if self.phase() == DaemonPhase::Starting {
      self.set_phase(state, last_line);
    }
  }

  fn remember_path_tried(&self, path: String) {
    self.status.lock().unwrap().path_tried = Some(path);
  }

  fn last_stderr_line(&self) -> Option<String> {
    self.last_stderr_line.lock().unwrap().clone()
  }
}

#[tauri::command]
pub fn daemon_status(state: State<DaemonState>) -> DaemonStatus {
  state.status.lock().unwrap().clone()
}

/// Reuses a daemon already answering on 7331, otherwise spawns the bundled one; never blocks the caller.
pub fn start(app: AppHandle) {
  std::thread::spawn(move || boot(&app));
}

/// Stops the sidecar with SIGTERM, then SIGKILL after the grace; leaves a reused daemon alone.
pub fn stop(app: &AppHandle) {
  let state = app.state::<DaemonState>();
  let Some(child) = state.child.lock().unwrap().take() else { return };
  let pid = child.pid();
  log::info!("stopping the daemon (pid {pid})");
  let outcome = terminate_gracefully(pid, GRACE_BEFORE_SIGKILL, || !is_process_alive(pid));
  log::info!("daemon stopped: {outcome:?}");
}

fn boot(app: &AppHandle) {
  let state = app.state::<DaemonState>();
  if probe_health(HEALTH_ADDRESS, PROBE_TIMEOUT) {
    log::info!("a daemon already answers on {HEALTH_ADDRESS}, reusing it");
    state.set_phase(DaemonPhase::Reused, None);
    return;
  }
  match spawn_sidecar(app) {
    Ok(()) => wait_for_ready(&state),
    Err(reason) => {
      log::error!("could not start the daemon: {reason}");
      state.set_phase(DaemonPhase::Failed, Some(reason));
    }
  }
}

fn wait_for_ready(state: &DaemonState) {
  let is_still_starting = || state.phase() == DaemonPhase::Starting;
  if wait_until_healthy(HEALTH_ADDRESS, READY_TIMEOUT, is_still_starting) {
    state.set_phase_if_starting(DaemonPhase::Ready, None);
    return;
  }
  let reason = state.last_stderr_line().unwrap_or_else(|| format!("the daemon did not answer on {HEALTH_ADDRESS} within {}s", READY_TIMEOUT.as_secs()));
  state.set_phase_if_starting(DaemonPhase::Failed, Some(reason));
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
  let daemon_script = app.path().resource_dir().map_err(|err| err.to_string())?.join("resources/daemon/daemon.mjs");
  if !daemon_script.exists() {
    return Err(format!("daemon bundle not found at {} (run: pnpm --filter @openfleet/core bundle)", daemon_script.display()));
  }
  let home = app.path().home_dir().map_err(|err| err.to_string())?;
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
  let repaired_path = repair_path(|| run_login_shell(&shell, LOGIN_SHELL_TIMEOUT), &home.to_string_lossy());
  let state = app.state::<DaemonState>();
  state.remember_path_tried(repaired_path.clone());

  let (events, child) = app
    .shell()
    .sidecar("node")
    .map_err(|err| err.to_string())?
    .args([daemon_script.to_string_lossy().to_string()])
    .env("PATH", repaired_path)
    .spawn()
    .map_err(|err| err.to_string())?;
  *state.child.lock().unwrap() = Some(child);
  let app_for_events = app.clone();
  tauri::async_runtime::spawn(async move { pipe_daemon_output(app_for_events, events).await });
  Ok(())
}

async fn pipe_daemon_output(app: AppHandle, mut events: tauri::async_runtime::Receiver<CommandEvent>) {
  let state = app.state::<DaemonState>();
  while let Some(event) = events.recv().await {
    match event {
      CommandEvent::Stdout(bytes) => log::info!("[daemon] {}", String::from_utf8_lossy(&bytes).trim_end()),
      CommandEvent::Stderr(bytes) => {
        let chunk = String::from_utf8_lossy(&bytes).to_string();
        log::warn!("[daemon] {}", chunk.trim_end());
        if let Some(line) = last_non_blank_line(&chunk) {
          *state.last_stderr_line.lock().unwrap() = Some(line);
        }
      }
      CommandEvent::Error(reason) => log::error!("[daemon] {reason}"),
      CommandEvent::Terminated(payload) => {
        log::warn!("[daemon] exited with code {:?}", payload.code);
        let reason = state.last_stderr_line().unwrap_or_else(|| format!("the daemon exited with code {:?}", payload.code));
        state.set_phase(DaemonPhase::Failed, Some(reason));
      }
      _ => {}
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader};
  use std::net::TcpListener;
  use std::process::{Child, Command, Stdio};

  const SHORT: Duration = Duration::from_millis(300);

  fn serve_once(response: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut request = [0u8; 512];
        let _ = stream.read(&mut request);
        let _ = stream.write_all(response.as_bytes());
      }
    });
    address
  }

  fn closed_address() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().to_string()
  }

  fn spawn_shell(script: &str) -> Child {
    let mut child = Command::new("/bin/sh").args(["-c", script]).stdout(Stdio::piped()).spawn().unwrap();
    let mut announced_ready = String::new();
    BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut announced_ready).unwrap();
    child
  }

  #[test]
  fn serializes_a_failed_status_with_camel_case_keys() {
    let status = DaemonStatus { state: DaemonPhase::Failed, last_line: Some("boom".into()), path_tried: Some("/a:/b".into()) };

    let json = serde_json::to_string(&status).unwrap();

    assert_eq!(json, r#"{"state":"failed","lastLine":"boom","pathTried":"/a:/b"}"#);
  }

  #[test]
  fn omits_the_optional_keys_of_a_starting_status() {
    let status = DaemonStatus { state: DaemonPhase::Starting, last_line: None, path_tried: None };

    assert_eq!(serde_json::to_string(&status).unwrap(), r#"{"state":"starting"}"#);
  }

  #[test]
  fn serializes_the_reused_state() {
    let status = DaemonStatus { state: DaemonPhase::Reused, last_line: None, path_tried: None };

    assert_eq!(serde_json::to_string(&status).unwrap(), r#"{"state":"reused"}"#);
  }

  #[test]
  fn keeps_the_last_non_blank_line_of_a_chunk() {
    assert_eq!(last_non_blank_line("first\nopenfleet: refusing to start\n\n  \n"), Some("openfleet: refusing to start".to_string()));
    assert_eq!(last_non_blank_line("\n \n"), None);
    assert_eq!(last_non_blank_line(""), None);
  }

  #[test]
  fn probe_sees_a_daemon_answering_200() {
    let address = serve_once("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}");

    assert!(probe_health(&address, PROBE_TIMEOUT));
  }

  #[test]
  fn probe_rejects_a_server_answering_500() {
    let address = serve_once("HTTP/1.1 500 Internal Server Error\r\n\r\n");

    assert!(!probe_health(&address, PROBE_TIMEOUT));
  }

  #[test]
  fn probe_finds_nothing_on_a_closed_port() {
    assert!(!probe_health(&closed_address(), PROBE_TIMEOUT));
  }

  #[test]
  fn probe_gives_up_on_a_server_that_never_answers() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let started = Instant::now();

    let answered = probe_health(&address, SHORT);

    assert!(!answered);
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn wait_returns_true_as_soon_as_the_daemon_answers() {
    let address = serve_once("HTTP/1.1 200 OK\r\n\r\n");

    assert!(wait_until_healthy(&address, Duration::from_secs(5), || true));
  }

  #[test]
  fn wait_gives_up_after_the_total_delay() {
    let started = Instant::now();

    let answered = wait_until_healthy(&closed_address(), SHORT, || true);

    assert!(!answered);
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn wait_stops_at_once_when_the_caller_stops_waiting() {
    let started = Instant::now();

    let answered = wait_until_healthy(&closed_address(), Duration::from_secs(30), || false);

    assert!(!answered);
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn terminate_lets_a_well_behaved_process_exit_on_sigterm() {
    let mut child = spawn_shell("echo ready; exec sleep 30");
    let pid = child.id();

    let outcome = terminate_gracefully(pid, Duration::from_secs(5), || child.try_wait().unwrap().is_some());

    assert_eq!(outcome, StopOutcome::ExitedOnSigterm);
  }

  #[test]
  fn terminate_kills_a_process_that_ignores_sigterm_after_the_grace() {
    let mut child = spawn_shell("trap '' TERM; echo ready; while :; do sleep 1; done");
    let pid = child.id();
    let started = Instant::now();

    let outcome = terminate_gracefully(pid, SHORT, || child.try_wait().unwrap().is_some());

    assert_eq!(outcome, StopOutcome::KilledAfterGrace);
    assert!(started.elapsed() >= SHORT);
    assert!(child.wait().is_ok());
  }

  #[test]
  fn reports_whether_a_process_is_alive() {
    let mut child = spawn_shell("echo ready; exec sleep 30");
    let pid = child.id();
    assert!(is_process_alive(pid));

    child.kill().unwrap();
    child.wait().unwrap();

    assert!(!is_process_alive(pid));
  }
}
