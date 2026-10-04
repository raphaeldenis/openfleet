use crate::admin_token::{admin_token_path, admin_token_secrets};
use crate::log_file::{logs_dir, DaemonLog, DiskFs, RotatingLog, Stream, KEPT_FILES, LOG_FILE_NAME, MAX_LOG_BYTES};
use crate::path_repair::{repair_path, run_login_shell, PathSource, RepairedPath, LOGIN_SHELL_TIMEOUT};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use crate::status_line::webview_safe_line;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const HEALTH_ADDRESS: &str = "127.0.0.1:7331";
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
pub const READY_TIMEOUT: Duration = Duration::from_secs(15);
pub const SLOW_START_EXTRA_BUDGET: Duration = Duration::from_secs(300);
pub const GRACE_BEFORE_SIGKILL: Duration = Duration::from_secs(12);
const LOG_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
/// A dying daemon's shutdown is bounded by its 10 s guard; the launch waits this long for its port to free.
pub const SHUTTING_DOWN_DAEMON_WAIT: Duration = Duration::from_secs(15);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const BOOT_REFUSAL_PREFIX: &str = "openfleet: refusing to boot";
const PORT_VARIABLE: &str = "OPENFLEET_PORT";
const EXIT_ON_STDIN_EOF_VARIABLE: &str = "OPENFLEET_EXIT_ON_STDIN_EOF";
const NO_SIGNAL: i32 = 0;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DaemonPhase {
  Starting,
  /// Still starting after `READY_TIMEOUT`: the process is alive and has not refused to boot.
  Slow,
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
  pub path_source: Option<PathSource>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub daemon_version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub started_seconds_ago: Option<u64>,
}

impl DaemonStatus {
  fn starting() -> Self {
    Self { state: DaemonPhase::Starting, last_line: None, path_source: None, daemon_version: None, started_seconds_ago: None }
  }
}

#[derive(Debug, PartialEq)]
pub enum StopOutcome {
  ExitedOnSigterm,
  KilledAfterGrace,
}

/// What a daemon answers on `GET /health`.
#[derive(Debug, PartialEq)]
pub struct HealthAnswer {
  pub version: Option<String>,
}

/// Returns the last non-blank line of a chunk of daemon output.
pub fn last_non_blank_line(chunk: &str) -> Option<String> {
  chunk.lines().map(str::trim).rfind(|line| !line.is_empty()).map(str::to_string)
}

fn last_boot_refusal_line(chunk: &str) -> Option<String> {
  chunk.lines().map(str::trim).rfind(|line| line.starts_with(BOOT_REFUSAL_PREFIX)).map(str::to_string)
}

fn version_in_health_response(response: &str) -> Option<String> {
  let (_, body) = response.split_once("\r\n\r\n")?;
  let json = body.get(body.find('{')?..=body.rfind('}')?)?;
  let health: serde_json::Value = serde_json::from_str(json).ok()?;
  health.get("version")?.as_str().map(str::to_string)
}

/// Returns the daemon's answer when it replies `GET /health` with a 200 within `timeout`.
pub fn probe_health(address: &str, timeout: Duration) -> Option<HealthAnswer> {
  let response = health_response(address, timeout)?;
  response.starts_with("HTTP/1.1 200").then(|| HealthAnswer { version: version_in_health_response(&response) })
}

/// Returns true when the daemon on `address` answers `GET /health` with a 503: it is closing its sessions and still holds the port.
pub fn is_shutting_down(address: &str, timeout: Duration) -> bool {
  health_response(address, timeout).is_some_and(|response| response.starts_with("HTTP/1.1 503"))
}

/// Blocks while the daemon on `address` reports it is shutting down, for at most `total`, so a new daemon can bind the port.
pub fn wait_while_shutting_down(address: &str, total: Duration) {
  let deadline = Instant::now() + total;
  while Instant::now() < deadline && is_shutting_down(address, PROBE_TIMEOUT) {
    std::thread::sleep(READY_POLL_INTERVAL);
  }
}

fn health_response(address: &str, timeout: Duration) -> Option<String> {
  let socket_address = address.parse::<SocketAddr>().ok()?;
  let mut stream = TcpStream::connect_timeout(&socket_address, timeout).ok()?;
  let _ = stream.set_read_timeout(Some(timeout));
  let _ = stream.set_write_timeout(Some(timeout));
  let request = format!("GET /health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
  stream.write_all(request.as_bytes()).ok()?;
  let mut response = String::new();
  let _ = stream.read_to_string(&mut response);
  Some(response)
}

/// Polls `/health` until it answers, `total` elapses or `keep_waiting` turns false.
pub fn wait_until_healthy(address: &str, total: Duration, keep_waiting: impl Fn() -> bool) -> Option<HealthAnswer> {
  let deadline = Instant::now() + total;
  while Instant::now() < deadline && keep_waiting() {
    if let Some(answer) = probe_health(address, PROBE_TIMEOUT) {
      return Some(answer);
    }
    std::thread::sleep(READY_POLL_INTERVAL);
  }
  None
}

/// Sends signals to processes; the seam that lets the stop logic run against a fake.
pub trait Signals {
  fn send(&self, pid: u32, signal: i32) -> bool;

  fn is_alive(&self, pid: u32) -> bool {
    self.send(pid, NO_SIGNAL)
  }
}

pub struct OsSignals;

impl Signals for OsSignals {
  fn send(&self, pid: u32, signal: i32) -> bool {
    // SAFETY: kill(2) takes plain integers and has no memory-safety preconditions.
    unsafe { libc::kill(pid as libc::pid_t, signal) == 0 }
  }
}

/// Returns true while a process with this pid exists.
#[cfg(test)]
pub fn is_process_alive(pid: u32) -> bool {
  OsSignals.is_alive(pid)
}

/// Sends SIGTERM, waits up to `grace` for the process to exit, then re-checks once and sends SIGKILL.
pub fn terminate_gracefully(signals: &impl Signals, pid: u32, grace: Duration, mut has_exited: impl FnMut() -> bool) -> StopOutcome {
  signals.send(pid, libc::SIGTERM);
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
  signals.send(pid, libc::SIGKILL);
  StopOutcome::KilledAfterGrace
}

/// The spawned sidecar; holding the plugin's handle keeps the child's stdin pipe open, and closing it asks the daemon to exit.
pub struct RunningChild {
  pid: u32,
  _stdin_holder: Box<dyn Send>,
}

impl RunningChild {
  fn of_sidecar(child: CommandChild) -> Self {
    Self::holding(child.pid(), child)
  }

  fn holding(pid: u32, stdin_holder: impl Send + 'static) -> Self {
    Self { pid, _stdin_holder: Box::new(stdin_holder) }
  }
}

struct Inner {
  status: DaemonStatus,
  last_stderr_line: Option<String>,
  boot_refusal_line: Option<String>,
  child: Option<RunningChild>,
  spawned_at: Option<Instant>,
  daemon_log: Option<DaemonLog>,
  scrub_scope: ScrubScope,
}

/// What `snapshot` needs to make the last line safe for the webview.
#[derive(Default, Clone)]
struct ScrubScope {
  user_home: String,
  admin_token_path: Option<PathBuf>,
}

impl ScrubScope {
  fn safe_line(&self, raw_line: &str) -> String {
    let secrets = self.admin_token_path.as_deref().map(admin_token_secrets).unwrap_or_default();
    webview_safe_line(raw_line, &self.user_home, &secrets)
  }
}

/// Tauri state: the daemon's status for the webview and the sidecar handle to stop on quit.
pub struct DaemonState {
  inner: Mutex<Inner>,
}

impl DaemonState {
  pub fn new() -> Self {
    Self { inner: Mutex::new(Inner { status: DaemonStatus::starting(), last_stderr_line: None, boot_refusal_line: None, child: None, spawned_at: None, daemon_log: None, scrub_scope: ScrubScope::default() }) }
  }

  fn record_scrub_scope(&self, scrub_scope: ScrubScope) {
    self.inner.lock().unwrap().scrub_scope = scrub_scope;
  }

  fn record_daemon_log(&self, daemon_log: DaemonLog) {
    self.inner.lock().unwrap().daemon_log = Some(daemon_log);
  }

  fn daemon_log(&self) -> Option<DaemonLog> {
    self.inner.lock().unwrap().daemon_log.clone()
  }

  /// Returns the status as the webview sees it at `now`: its last line is masked, shortened, escaped and capped.
  pub fn snapshot(&self, now: Instant) -> DaemonStatus {
    let (mut status, scrub_scope) = {
      let inner = self.inner.lock().unwrap();
      let mut status = inner.status.clone();
      let is_booting = matches!(status.state, DaemonPhase::Starting | DaemonPhase::Slow);
      status.started_seconds_ago = inner.spawned_at.filter(|_| is_booting).map(|spawned_at| now.saturating_duration_since(spawned_at).as_secs());
      (status, inner.scrub_scope.clone())
    };
    status.last_line = status.last_line.map(|raw_line| scrub_scope.safe_line(&raw_line));
    status
  }

  fn phase(&self) -> DaemonPhase {
    self.inner.lock().unwrap().status.state
  }

  /// True while the sidecar is alive and has neither answered nor refused to boot.
  fn is_awaiting_health(&self) -> bool {
    let inner = self.inner.lock().unwrap();
    let is_booting = matches!(inner.status.state, DaemonPhase::Starting | DaemonPhase::Slow);
    is_booting && inner.child.is_some()
  }

  fn record_spawn(&self, child: RunningChild, repaired_path: RepairedPath, spawned_at: Instant) {
    let mut inner = self.inner.lock().unwrap();
    inner.child = Some(child);
    inner.spawned_at = Some(spawned_at);
    inner.status.path_source = Some(repaired_path.source);
  }

  /// Hands the child over exactly once; every later call gets None.
  fn take_child(&self) -> Option<RunningChild> {
    self.inner.lock().unwrap().child.take()
  }

  fn on_reused(&self, daemon_version: Option<String>) {
    let mut inner = self.inner.lock().unwrap();
    inner.status.state = DaemonPhase::Reused;
    inner.status.daemon_version = daemon_version;
  }

  /// A health answer makes a booting daemon Ready; a daemon already Failed stays Failed.
  fn on_health_answered(&self, daemon_version: Option<String>) {
    let mut inner = self.inner.lock().unwrap();
    let is_booting = matches!(inner.status.state, DaemonPhase::Starting | DaemonPhase::Slow);
    if !is_booting {
      return;
    }
    inner.status.state = DaemonPhase::Ready;
    inner.status.last_line = None;
    inner.status.daemon_version = daemon_version;
  }

  fn on_slow(&self) {
    let mut inner = self.inner.lock().unwrap();
    if inner.status.state == DaemonPhase::Starting {
      inner.status.state = DaemonPhase::Slow;
    }
  }

  fn on_start_failed(&self, reason: String) {
    let mut inner = self.inner.lock().unwrap();
    inner.status.state = DaemonPhase::Failed;
    inner.status.last_line = Some(reason);
  }

  fn on_gave_up_waiting(&self, reason: String) {
    if self.phase() == DaemonPhase::Slow {
      self.on_start_failed(reason);
    }
  }

  /// A plain stderr line is remembered for later; a boot-refusal line fails a booting daemon at once.
  fn on_stderr(&self, chunk: &str) {
    let mut inner = self.inner.lock().unwrap();
    if let Some(line) = last_non_blank_line(chunk) {
      inner.last_stderr_line = Some(line);
    }
    let Some(refusal_line) = last_boot_refusal_line(chunk) else { return };
    inner.boot_refusal_line = Some(refusal_line.clone());
    let is_booting = matches!(inner.status.state, DaemonPhase::Starting | DaemonPhase::Slow);
    if is_booting {
      inner.status.state = DaemonPhase::Failed;
      inner.status.last_line = Some(refusal_line);
    }
  }

  /// The process is gone: forgets the child (so nothing signals a reaped pid) and fails with the refusal line or the last output line.
  fn on_terminated(&self, exit_code: Option<i32>) {
    let mut inner = self.inner.lock().unwrap();
    inner.child = None;
    let reason = inner.boot_refusal_line.clone().or_else(|| inner.last_stderr_line.clone()).unwrap_or_else(|| format!("the daemon exited with code {exit_code:?}"));
    inner.status.state = DaemonPhase::Failed;
    inner.status.last_line = Some(reason);
  }
}

#[tauri::command]
pub fn daemon_status(state: State<DaemonState>) -> DaemonStatus {
  state.snapshot(Instant::now())
}

/// Reuses a daemon already answering on 7331, otherwise spawns the bundled one; never blocks the caller.
pub fn start(app: AppHandle) {
  std::thread::spawn(move || boot(&app));
}

/// Stops the sidecar with SIGTERM, then SIGKILL after the grace; leaves a reused daemon alone.
pub fn stop(app: &AppHandle) {
  let state = app.state::<DaemonState>();
  match stop_daemon(&state, &OsSignals, GRACE_BEFORE_SIGKILL) {
    Some(outcome) => log::info!("daemon stopped: {outcome:?}"),
    None => log::info!("no daemon of ours to stop"),
  }
}

/// Writes the daemon's last output lines to `daemon.log` and stops the writer; waits at most `LOG_FLUSH_TIMEOUT`. Call it after `stop`.
pub fn flush_log(app: &AppHandle) {
  let Some(daemon_log) = app.state::<DaemonState>().daemon_log() else { return };
  let drained = daemon_log.close_after_output_ends(LOG_FLUSH_TIMEOUT);
  log::info!("daemon log flushed: {drained}");
}

/// Takes the child out of the state once and stops it; returns None when there is nothing to stop.
pub fn stop_daemon(state: &DaemonState, signals: &impl Signals, grace: Duration) -> Option<StopOutcome> {
  let child = state.take_child()?;
  let pid = child.pid;
  log::info!("stopping the daemon (pid {pid})");
  Some(terminate_gracefully(signals, pid, grace, || !signals.is_alive(pid)))
}

fn boot(app: &AppHandle) {
  let state = app.state::<DaemonState>();
  state.record_scrub_scope(scrub_scope_of(app));
  if let Some(answer) = probe_health(HEALTH_ADDRESS, PROBE_TIMEOUT) {
    log::info!("a daemon already answers on {HEALTH_ADDRESS}, reusing it");
    state.on_reused(answer.version);
    return;
  }
  wait_while_shutting_down(HEALTH_ADDRESS, SHUTTING_DOWN_DAEMON_WAIT);
  match spawn_sidecar(app) {
    Ok(()) => wait_for_ready(&state, HEALTH_ADDRESS, READY_TIMEOUT, SLOW_START_EXTRA_BUDGET),
    Err(reason) => {
      log::error!("could not start the daemon: {reason}");
      state.on_start_failed(reason);
    }
  }
}

fn scrub_scope_of(app: &AppHandle) -> ScrubScope {
  let Ok(user_home) = app.path().home_dir() else { return ScrubScope::default() };
  let token_path = admin_token_path(std::env::var("OPENFLEET_HOME").ok(), &user_home);
  ScrubScope { user_home: user_home.to_string_lossy().to_string(), admin_token_path: Some(token_path) }
}

/// Polls `/health` for `ready_timeout`, then keeps polling for `extra_budget` in the Slow state; Failed only comes from the process side.
fn wait_for_ready(state: &DaemonState, address: &str, ready_timeout: Duration, extra_budget: Duration) {
  let is_awaiting = || state.is_awaiting_health();
  if let Some(answer) = wait_until_healthy(address, ready_timeout, is_awaiting) {
    state.on_health_answered(answer.version);
    return;
  }
  state.on_slow();
  if let Some(answer) = wait_until_healthy(address, extra_budget, is_awaiting) {
    state.on_health_answered(answer.version);
    return;
  }
  let total_seconds = (ready_timeout + extra_budget).as_secs();
  state.on_gave_up_waiting(format!("the daemon did not answer on {address} within {total_seconds}s"));
}

/// Returns the sidecar's environment: the parent's without OPENFLEET_PORT (the probe and the CSP are fixed on 7331), with the repaired PATH and the stdin-EOF shutdown switch.
pub fn sidecar_env(parent_env: impl IntoIterator<Item = (String, String)>, repaired_path: &str) -> HashMap<String, String> {
  let mut env: HashMap<String, String> = parent_env.into_iter().filter(|(name, _)| name != PORT_VARIABLE).collect();
  env.insert("PATH".to_string(), repaired_path.to_string());
  env.insert(EXIT_ON_STDIN_EOF_VARIABLE.to_string(), "1".to_string());
  env
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
  let daemon_script = app.path().resource_dir().map_err(|err| err.to_string())?.join("resources/daemon/daemon.mjs");
  if !daemon_script.exists() {
    return Err(format!("daemon bundle not found at {} (run: pnpm --filter @openfleet/core bundle)", daemon_script.display()));
  }
  let home = app.path().home_dir().map_err(|err| err.to_string())?;
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
  let repaired_path = repair_path(|| run_login_shell(&shell, LOGIN_SHELL_TIMEOUT), &home.to_string_lossy());
  let environment = sidecar_env(std::env::vars(), &repaired_path.path);

  let (events, child) = app
    .shell()
    .sidecar("node")
    .map_err(|err| err.to_string())?
    .args([daemon_script.to_string_lossy().to_string()])
    .env_clear()
    .envs(environment)
    .spawn()
    .map_err(|err| err.to_string())?;
  let state = app.state::<DaemonState>();
  state.record_spawn(RunningChild::of_sidecar(child), repaired_path, Instant::now());
  let app_for_events = app.clone();
  let daemon_log = start_daemon_log(&home);
  state.record_daemon_log(daemon_log.clone());
  tauri::async_runtime::spawn(async move { pipe_daemon_output(app_for_events, events, daemon_log).await });
  Ok(())
}

/// Starts the writer that appends the sidecar's output, redacted, to `<OPENFLEET_HOME or ~/.openfleet>/logs/daemon.log`.
fn start_daemon_log(user_home: &Path) -> DaemonLog {
  let openfleet_home = std::env::var("OPENFLEET_HOME").ok();
  let log_path = logs_dir(openfleet_home.clone(), user_home).join(LOG_FILE_NAME);
  let token_path = admin_token_path(openfleet_home, user_home);
  let rotating_log = RotatingLog::open(DiskFs, log_path, MAX_LOG_BYTES, KEPT_FILES);
  DaemonLog::start(rotating_log, move || Some(admin_token_secrets(&token_path)), unix_seconds_now)
}

fn unix_seconds_now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

async fn pipe_daemon_output(app: AppHandle, mut events: tauri::async_runtime::Receiver<CommandEvent>, daemon_log: DaemonLog) {
  let state = app.state::<DaemonState>();
  while let Some(event) = events.recv().await {
    match event {
      CommandEvent::Stdout(bytes) => {
        let chunk = String::from_utf8_lossy(&bytes).to_string();
        log::info!("[daemon] {}", chunk.trim_end());
        daemon_log.record(Stream::Out, &chunk);
      }
      CommandEvent::Stderr(bytes) => {
        let chunk = String::from_utf8_lossy(&bytes).to_string();
        log::warn!("[daemon] {}", chunk.trim_end());
        daemon_log.record(Stream::Err, &chunk);
        state.on_stderr(&chunk);
      }
      CommandEvent::Error(reason) => {
        log::error!("[daemon] {reason}");
        daemon_log.record(Stream::Err, &format!("sidecar error: {reason}"));
      }
      CommandEvent::Terminated(payload) => {
        log::warn!("[daemon] exited with code {:?}", payload.code);
        daemon_log.record(Stream::Err, &format!("the daemon exited with code {:?}", payload.code));
        state.on_terminated(payload.code);
      }
      _ => {}
    }
  }
  daemon_log.mark_output_ended();
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;
  use std::io::{BufRead, BufReader};
  use std::net::TcpListener;
  use std::process::{Child, Command, Stdio};
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::Arc;

  const SHORT: Duration = Duration::from_millis(300);
  const PID: u32 = 4242;

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

  fn serve_always(response: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
      while let Ok((mut stream, _)) = listener.accept() {
        let mut request = [0u8; 512];
        let _ = stream.read(&mut request);
        let _ = stream.write_all(response.as_bytes());
      }
    });
    address
  }

  /// Answers 200 only to `GET /health`, 404 to anything else.
  fn serve_health_only(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut request = [0u8; 512];
        let read = stream.read(&mut request).unwrap_or(0);
        let is_health_request = request[..read].starts_with(b"GET /health HTTP/1.1\r\n");
        let response = if is_health_request { format!("HTTP/1.1 200 OK\r\n\r\n{body}") } else { "HTTP/1.1 404 Not Found\r\n\r\n".to_string() };
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

  fn state_with_a_spawned_child() -> DaemonState {
    let state = DaemonState::new();
    let repaired = RepairedPath { path: "/a:/b".to_string(), source: PathSource::Shell };
    state.record_spawn(RunningChild::holding(PID, ()), repaired, Instant::now());
    state
  }

  #[derive(Default)]
  struct RecordingSignals {
    sent: RefCell<Vec<(u32, i32)>>,
    is_alive_answers: RefCell<Vec<bool>>,
  }

  impl RecordingSignals {
    fn answering_alive(answers: Vec<bool>) -> Self {
      Self { sent: RefCell::default(), is_alive_answers: RefCell::new(answers) }
    }
  }

  impl Signals for RecordingSignals {
    fn send(&self, pid: u32, signal: i32) -> bool {
      self.sent.borrow_mut().push((pid, signal));
      if signal == NO_SIGNAL {
        let mut answers = self.is_alive_answers.borrow_mut();
        return if answers.is_empty() { false } else { answers.remove(0) };
      }
      true
    }
  }

  #[test]
  fn serializes_a_failed_status_with_camel_case_keys() {
    let status = DaemonStatus { last_line: Some("boom".into()), path_source: Some(PathSource::Fallback), state: DaemonPhase::Failed, ..DaemonStatus::starting() };

    let json = serde_json::to_string(&status).unwrap();

    assert_eq!(json, r#"{"state":"failed","lastLine":"boom","pathSource":"fallback"}"#);
  }

  #[test]
  fn omits_the_optional_keys_of_a_starting_status() {
    assert_eq!(serde_json::to_string(&DaemonStatus::starting()).unwrap(), r#"{"state":"starting"}"#);
  }

  #[test]
  fn serializes_the_reused_and_slow_states() {
    let reused = DaemonStatus { state: DaemonPhase::Reused, daemon_version: Some("1.2.3".into()), ..DaemonStatus::starting() };
    let slow = DaemonStatus { state: DaemonPhase::Slow, started_seconds_ago: Some(20), path_source: Some(PathSource::Fallback), ..DaemonStatus::starting() };

    assert_eq!(serde_json::to_string(&reused).unwrap(), r#"{"state":"reused","daemonVersion":"1.2.3"}"#);
    assert_eq!(serde_json::to_string(&slow).unwrap(), r#"{"state":"slow","pathSource":"fallback","startedSecondsAgo":20}"#);
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

    assert!(probe_health(&address, PROBE_TIMEOUT).is_some());
  }

  #[test]
  fn probe_reads_the_daemon_version_from_the_health_body() {
    let address = serve_once("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"version\":\"0.4.2\"}");

    assert_eq!(probe_health(&address, PROBE_TIMEOUT), Some(HealthAnswer { version: Some("0.4.2".to_string()) }));
  }

  #[test]
  fn probe_reports_no_version_when_the_body_carries_none() {
    let address = serve_once("HTTP/1.1 200 OK\r\n\r\nnot json");

    assert_eq!(probe_health(&address, PROBE_TIMEOUT), Some(HealthAnswer { version: None }));
  }

  #[test]
  fn probe_asks_for_get_health() {
    let address = serve_health_only("{\"version\":\"1\"}");

    assert!(probe_health(&address, PROBE_TIMEOUT).is_some());
  }

  #[test]
  fn probe_rejects_a_server_answering_500() {
    let address = serve_once("HTTP/1.1 500 Internal Server Error\r\n\r\n");

    assert!(probe_health(&address, PROBE_TIMEOUT).is_none());
  }

  #[test]
  fn probe_rejects_a_failure_that_merely_mentions_200() {
    let address = serve_once("HTTP/1.1 503 Service Unavailable\r\n\r\nretry after 200 ms");

    assert!(probe_health(&address, PROBE_TIMEOUT).is_none());
  }

  #[test]
  fn probe_does_not_take_a_shutting_down_daemon_for_a_live_one() {
    let address = serve_once("HTTP/1.1 503 Service Unavailable\r\n\r\n{\"ok\":false,\"status\":\"shutting_down\"}");

    assert!(probe_health(&address, PROBE_TIMEOUT).is_none());
  }

  #[test]
  fn a_503_shutting_down_answer_is_recognised_as_shutting_down() {
    let address = serve_once("HTTP/1.1 503 Service Unavailable\r\n\r\n{\"ok\":false,\"status\":\"shutting_down\"}");

    assert!(is_shutting_down(&address, PROBE_TIMEOUT));
  }

  #[test]
  fn a_200_answer_and_a_closed_port_are_not_shutting_down() {
    assert!(!is_shutting_down(&serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}"), PROBE_TIMEOUT));
    assert!(!is_shutting_down(&closed_address(), PROBE_TIMEOUT));
  }

  #[test]
  fn waiting_for_a_shutting_down_daemon_returns_once_it_stops_answering() {
    let address = serve_once("HTTP/1.1 503 Service Unavailable\r\n\r\n{\"ok\":false,\"status\":\"shutting_down\"}");
    let started = Instant::now();

    wait_while_shutting_down(&address, Duration::from_secs(30));

    assert!(started.elapsed() < Duration::from_secs(5));
  }

  #[test]
  fn waiting_for_a_shutting_down_daemon_gives_up_after_the_total_delay() {
    let address = serve_always("HTTP/1.1 503 Service Unavailable\r\n\r\n{\"ok\":false,\"status\":\"shutting_down\"}");
    let started = Instant::now();

    wait_while_shutting_down(&address, SHORT);

    assert!(started.elapsed() >= SHORT);
    assert!(started.elapsed() < Duration::from_secs(3));
  }

  #[test]
  fn waiting_returns_at_once_when_nothing_is_shutting_down() {
    let started = Instant::now();

    wait_while_shutting_down(&closed_address(), Duration::from_secs(30));

    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn probe_finds_nothing_on_a_closed_port() {
    assert!(probe_health(&closed_address(), PROBE_TIMEOUT).is_none());
  }

  #[test]
  fn probe_gives_up_on_a_server_that_never_answers() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let started = Instant::now();

    let answered = probe_health(&address, SHORT);

    assert!(answered.is_none());
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn wait_returns_as_soon_as_the_daemon_answers() {
    let address = serve_once("HTTP/1.1 200 OK\r\n\r\n");

    assert!(wait_until_healthy(&address, Duration::from_secs(5), || true).is_some());
  }

  #[test]
  fn wait_gives_up_after_the_total_delay() {
    let started = Instant::now();

    let answered = wait_until_healthy(&closed_address(), SHORT, || true);

    assert!(answered.is_none());
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn wait_stops_at_once_when_the_caller_stops_waiting() {
    let started = Instant::now();

    let answered = wait_until_healthy(&closed_address(), Duration::from_secs(30), || false);

    assert!(answered.is_none());
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn terminate_sends_sigterm_first_and_nothing_else_when_the_process_exits() {
    let signals = RecordingSignals::default();

    let outcome = terminate_gracefully(&signals, PID, Duration::from_secs(5), || true);

    assert_eq!(outcome, StopOutcome::ExitedOnSigterm);
    assert_eq!(*signals.sent.borrow(), vec![(PID, libc::SIGTERM)]);
  }

  #[test]
  fn terminate_sends_sigkill_after_the_grace_when_the_process_stays() {
    let signals = RecordingSignals::default();

    let outcome = terminate_gracefully(&signals, PID, Duration::ZERO, || false);

    assert_eq!(outcome, StopOutcome::KilledAfterGrace);
    assert_eq!(*signals.sent.borrow(), vec![(PID, libc::SIGTERM), (PID, libc::SIGKILL)]);
  }

  #[test]
  fn terminate_re_checks_once_after_the_grace_before_sending_sigkill() {
    let signals = RecordingSignals::default();
    let mut checks = 0;

    let outcome = terminate_gracefully(&signals, PID, Duration::ZERO, || {
      checks += 1;
      true
    });

    assert_eq!(outcome, StopOutcome::ExitedOnSigterm);
    assert_eq!(checks, 1);
    assert_eq!(*signals.sent.borrow(), vec![(PID, libc::SIGTERM)]);
  }

  #[test]
  fn liveness_is_asked_with_the_null_signal() {
    let signals = RecordingSignals::answering_alive(vec![true, false]);

    assert!(signals.is_alive(PID));
    assert!(!signals.is_alive(PID));
    assert_eq!(*signals.sent.borrow(), vec![(PID, 0), (PID, 0)]);
  }

  #[test]
  fn a_real_process_receives_sigterm_and_gets_to_run_its_handler() {
    let marker = std::env::temp_dir().join(format!("openfleet-sigterm-{}", std::process::id()));
    let script = format!("trap 'echo terminated > {}; exit 0' TERM; echo ready; while :; do sleep 0.1; done", marker.display());
    let mut child = spawn_shell(&script);
    let pid = child.id();

    let outcome = terminate_gracefully(&OsSignals, pid, Duration::from_secs(5), || child.try_wait().unwrap().is_some());

    assert_eq!(outcome, StopOutcome::ExitedOnSigterm);
    assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "terminated");
    let _ = std::fs::remove_file(&marker);
  }

  #[test]
  fn a_real_process_that_ignores_sigterm_is_killed_after_the_grace() {
    let mut child = spawn_shell("trap '' TERM; echo ready; while :; do sleep 1; done");
    let pid = child.id();
    let started = Instant::now();

    let outcome = terminate_gracefully(&OsSignals, pid, SHORT, || child.try_wait().unwrap().is_some());

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

  #[test]
  fn stop_signals_the_child_once_and_a_second_stop_does_nothing() {
    let state = state_with_a_spawned_child();
    let signals = RecordingSignals::answering_alive(vec![false]);

    let first = stop_daemon(&state, &signals, Duration::from_secs(5));
    let second = stop_daemon(&state, &signals, Duration::from_secs(5));

    assert_eq!(first, Some(StopOutcome::ExitedOnSigterm));
    assert_eq!(second, None);
    assert_eq!(signals.sent.borrow().iter().filter(|(_, signal)| *signal == libc::SIGTERM).count(), 1);
  }

  #[test]
  fn stop_escalates_to_sigkill_when_the_daemon_is_still_alive_after_the_grace() {
    let state = state_with_a_spawned_child();
    let signals = RecordingSignals::answering_alive(vec![true]);

    let outcome = stop_daemon(&state, &signals, Duration::ZERO);

    assert_eq!(outcome, Some(StopOutcome::KilledAfterGrace));
    assert_eq!(*signals.sent.borrow().last().unwrap(), (PID, libc::SIGKILL));
  }

  struct DropFlag(Arc<AtomicBool>);

  impl Drop for DropFlag {
    fn drop(&mut self) {
      self.0.store(true, Ordering::SeqCst);
    }
  }

  fn state_holding_a_stdin_holder() -> (DaemonState, Arc<AtomicBool>) {
    let dropped = Arc::new(AtomicBool::new(false));
    let state = DaemonState::new();
    let repaired = RepairedPath { path: "/a:/b".to_string(), source: PathSource::Shell };
    state.record_spawn(RunningChild::holding(PID, DropFlag(dropped.clone())), repaired, Instant::now());
    (state, dropped)
  }

  #[test]
  fn the_stdin_holder_lives_as_long_as_the_state_keeps_the_child() {
    let (state, dropped) = state_holding_a_stdin_holder();

    assert!(!dropped.load(Ordering::SeqCst));
    drop(state);
    assert!(dropped.load(Ordering::SeqCst));
  }

  #[test]
  fn the_stdin_holder_is_released_when_the_daemon_terminates() {
    let (state, dropped) = state_holding_a_stdin_holder();

    state.on_terminated(Some(0));

    assert!(dropped.load(Ordering::SeqCst));
  }

  struct SignalsWatchingTheHolder(Arc<AtomicBool>, RefCell<Vec<bool>>);

  impl Signals for SignalsWatchingTheHolder {
    fn send(&self, _pid: u32, _signal: i32) -> bool {
      self.1.borrow_mut().push(self.0.load(Ordering::SeqCst));
      false
    }
  }

  #[test]
  fn stop_keeps_the_stdin_holder_open_until_the_daemon_is_signalled_and_gone() {
    let (state, dropped) = state_holding_a_stdin_holder();
    let signals = SignalsWatchingTheHolder(dropped.clone(), RefCell::default());

    stop_daemon(&state, &signals, Duration::from_secs(5));

    assert!(signals.1.borrow().iter().all(|holder_already_dropped| !holder_already_dropped));
    assert!(dropped.load(Ordering::SeqCst));
  }

  #[test]
  fn stop_sends_no_signal_to_a_daemon_that_already_terminated() {
    let state = state_with_a_spawned_child();
    state.on_terminated(Some(1));
    let signals = RecordingSignals::default();

    let outcome = stop_daemon(&state, &signals, Duration::from_secs(5));

    assert_eq!(outcome, None);
    assert!(signals.sent.borrow().is_empty());
  }

  #[test]
  fn stop_sends_no_signal_when_the_daemon_was_reused() {
    let state = DaemonState::new();
    state.on_reused(Some("1.0.0".into()));
    let signals = RecordingSignals::default();

    assert_eq!(stop_daemon(&state, &signals, Duration::from_secs(5)), None);
    assert!(signals.sent.borrow().is_empty());
  }

  #[test]
  fn a_plain_stderr_warning_never_fails_a_booting_daemon() {
    let state = state_with_a_spawned_child();

    state.on_stderr("(node:1) ExperimentalWarning: something\n");

    assert_eq!(state.snapshot(Instant::now()).state, DaemonPhase::Starting);
    assert!(state.is_awaiting_health());
  }

  #[test]
  fn a_boot_refusal_line_fails_the_daemon_with_that_line() {
    let state = state_with_a_spawned_child();

    state.on_stderr("warn first\nopenfleet: refusing to boot: port 7331 is already in use\ntrailing noise\n");

    let status = state.snapshot(Instant::now());
    assert_eq!(status.state, DaemonPhase::Failed);
    assert_eq!(status.last_line.as_deref(), Some("openfleet: refusing to boot: port 7331 is already in use"));
    assert!(!state.is_awaiting_health());
  }

  #[test]
  fn a_termination_reports_the_refusal_line_over_a_later_stderr_line() {
    let state = state_with_a_spawned_child();
    state.on_stderr("openfleet: refusing to boot: schema is newer\n");
    state.on_stderr("some cleanup message\n");

    state.on_terminated(Some(1));

    assert_eq!(state.snapshot(Instant::now()).last_line.as_deref(), Some("openfleet: refusing to boot: schema is newer"));
  }

  #[test]
  fn a_termination_reports_the_last_stderr_line_once_the_process_has_exited() {
    let state = state_with_a_spawned_child();
    state.on_stderr("Error: boom\n");

    state.on_terminated(Some(1));

    let status = state.snapshot(Instant::now());
    assert_eq!(status.state, DaemonPhase::Failed);
    assert_eq!(status.last_line.as_deref(), Some("Error: boom"));
  }

  #[test]
  fn a_termination_without_output_reports_the_exit_code() {
    let state = state_with_a_spawned_child();

    state.on_terminated(Some(3));

    assert_eq!(state.snapshot(Instant::now()).last_line.as_deref(), Some("the daemon exited with code Some(3)"));
  }

  #[test]
  fn a_termination_forgets_the_child() {
    let state = state_with_a_spawned_child();

    state.on_terminated(Some(0));

    assert!(state.take_child().is_none());
  }

  #[test]
  fn the_child_is_handed_over_only_once() {
    let state = state_with_a_spawned_child();

    assert!(state.take_child().is_some());
    assert!(state.take_child().is_none());
  }

  #[test]
  fn a_late_health_answer_turns_a_slow_daemon_ready_and_clears_the_line() {
    let state = state_with_a_spawned_child();
    state.on_slow();
    assert_eq!(state.phase(), DaemonPhase::Slow);

    state.on_health_answered(Some("0.4.2".into()));

    let status = state.snapshot(Instant::now());
    assert_eq!(status.state, DaemonPhase::Ready);
    assert_eq!(status.daemon_version.as_deref(), Some("0.4.2"));
    assert_eq!(status.last_line, None);
  }

  #[test]
  fn a_health_answer_does_not_revive_a_failed_daemon() {
    let state = state_with_a_spawned_child();
    state.on_terminated(Some(1));

    state.on_health_answered(None);

    assert_eq!(state.phase(), DaemonPhase::Failed);
  }

  #[test]
  fn slow_is_only_entered_from_starting() {
    let state = state_with_a_spawned_child();
    state.on_health_answered(None);

    state.on_slow();

    assert_eq!(state.phase(), DaemonPhase::Ready);
  }

  #[test]
  fn the_status_counts_seconds_since_the_spawn_only_while_booting() {
    let state = state_with_a_spawned_child();
    let later = Instant::now() + Duration::from_secs(20);

    assert_eq!(state.snapshot(later).started_seconds_ago, Some(20));
    state.on_slow();
    assert_eq!(state.snapshot(later).started_seconds_ago, Some(20));
    state.on_health_answered(None);
    assert_eq!(state.snapshot(later).started_seconds_ago, None);
  }

  #[test]
  fn the_status_carries_where_the_path_came_from_and_never_the_path_itself() {
    let state = state_with_a_spawned_child();

    let status = state.snapshot(Instant::now());
    let json = serde_json::to_string(&status).unwrap();

    assert_eq!(status.path_source, Some(PathSource::Shell));
    assert!(!json.contains("/a:/b"), "{json}");
  }

  #[test]
  fn the_snapshot_masks_shortens_and_caps_the_last_line_while_the_stored_line_stays_raw() {
    let state = DaemonState::new();
    state.record_scrub_scope(ScrubScope { user_home: "/Users/jdoe".into(), admin_token_path: None });
    let raw_line = format!("crash in /Users/jdoe/app Authorization: Bearer abcdefghijklmnop1234567890 {}", "z".repeat(400));

    state.on_start_failed(raw_line.clone());
    let last_line = state.snapshot(Instant::now()).last_line.unwrap();

    assert!(last_line.starts_with("crash in ~/app "), "{last_line}");
    assert!(!last_line.contains("abcdefghijklmnop1234567890"), "{last_line}");
    assert_eq!(last_line.chars().count(), crate::status_line::MAX_STATUS_LINE_CHARS);
    assert_eq!(state.inner.lock().unwrap().status.last_line, Some(raw_line));
  }

  #[test]
  fn the_snapshot_escapes_bidi_controls_in_a_boot_refusal() {
    let state = DaemonState::new();

    state.on_stderr("openfleet: refusing to boot: \u{202E}evil\n");

    assert_eq!(state.snapshot(Instant::now()).last_line.as_deref(), Some("openfleet: refusing to boot: \\u{202e}evil"));
  }

  #[test]
  fn a_reused_daemon_exposes_its_version() {
    let state = DaemonState::new();

    state.on_reused(Some("9.9.9".into()));

    let status = state.snapshot(Instant::now());
    assert_eq!(status.state, DaemonPhase::Reused);
    assert_eq!(status.daemon_version.as_deref(), Some("9.9.9"));
  }

  #[test]
  fn waiting_turns_slow_after_the_ready_timeout_then_ready_when_the_daemon_finally_answers() {
    let state = state_with_a_spawned_child();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(1500));
      for mut stream in listener.incoming().flatten() {
        let mut request = [0u8; 512];
        let _ = stream.read(&mut request);
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n{\"version\":\"7.7.7\"}");
      }
    });
    let observed_slow = std::sync::atomic::AtomicBool::new(false);

    std::thread::scope(|scope| {
      scope.spawn(|| {
        while state.phase() != DaemonPhase::Ready {
          if state.phase() == DaemonPhase::Slow {
            observed_slow.store(true, std::sync::atomic::Ordering::SeqCst);
          }
          std::thread::sleep(Duration::from_millis(10));
        }
      });
      wait_for_ready(&state, &address, Duration::from_millis(200), Duration::from_secs(5));
    });

    let status = state.snapshot(Instant::now());
    assert_eq!(status.state, DaemonPhase::Ready);
    assert_eq!(status.daemon_version.as_deref(), Some("7.7.7"));
    assert!(observed_slow.load(std::sync::atomic::Ordering::SeqCst));
  }

  #[test]
  fn waiting_gives_up_with_a_timeout_message_that_is_not_a_stderr_warning() {
    let state = state_with_a_spawned_child();
    state.on_stderr("Warning: something harmless\n");

    wait_for_ready(&state, &closed_address(), Duration::from_millis(100), Duration::from_millis(300));

    let status = state.snapshot(Instant::now());
    assert_eq!(status.state, DaemonPhase::Failed);
    assert!(status.last_line.unwrap().starts_with("the daemon did not answer on"));
  }

  #[test]
  fn waiting_stops_at_once_when_the_daemon_dies() {
    let state = state_with_a_spawned_child();
    state.on_terminated(Some(1));
    let started = Instant::now();

    wait_for_ready(&state, &closed_address(), Duration::from_secs(30), Duration::from_secs(30));

    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(state.phase(), DaemonPhase::Failed);
  }

  #[test]
  fn the_sidecar_environment_drops_the_port_and_sets_path_and_the_stdin_switch() {
    let parent = vec![
      ("OPENFLEET_PORT".to_string(), "7332".to_string()),
      ("OPENFLEET_HOME".to_string(), "/tmp/home".to_string()),
      ("PATH".to_string(), "/usr/bin".to_string()),
    ];

    let env = sidecar_env(parent, "/repaired/bin");

    assert_eq!(env.get("OPENFLEET_PORT"), None);
    assert_eq!(env.get("OPENFLEET_HOME").map(String::as_str), Some("/tmp/home"));
    assert_eq!(env.get("PATH").map(String::as_str), Some("/repaired/bin"));
    assert_eq!(env.get("OPENFLEET_EXIT_ON_STDIN_EOF").map(String::as_str), Some("1"));
  }
}
