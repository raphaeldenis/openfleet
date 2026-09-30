mod admin_token;
mod app_exit;
mod daemon;
mod issue_report;
mod log_file;
mod path_repair;
mod redaction;

use tauri::Manager;

#[cfg(target_os = "macos")]
const MAIN_WINDOW_LABEL: &str = "main";

#[tauri::command]
fn read_admin_token(app: tauri::AppHandle) -> Result<String, String> {
  let user_home = app.path().home_dir().map_err(|err| err.to_string())?;
  let token_path = admin_token::admin_token_path(std::env::var("OPENFLEET_HOME").ok(), &user_home);
  admin_token::read_admin_token_at(&token_path)
}

const LOG_LINES_IN_REPORT: usize = 50;

/// Opens the logs folder in Finder. Takes no argument: the webview cannot choose what is opened.
#[tauri::command(async)]
fn reveal_logs(app: tauri::AppHandle) -> Result<(), String> {
  let user_home = app.path().home_dir().map_err(|err| err.to_string())?;
  let logs_folder = log_file::logs_dir(std::env::var("OPENFLEET_HOME").ok(), &user_home);
  issue_report::reveal_logs_dir(&logs_folder, |folder| issue_report::open_with_macos(folder.as_os_str()))
}

/// Opens the prefilled GitHub new-issue form in the browser; nothing is sent until the user submits it there.
#[tauri::command(async)]
fn report_issue(app: tauri::AppHandle, daemon: tauri::State<daemon::DaemonState>) -> Result<(), String> {
  let user_home = app.path().home_dir().map_err(|err| err.to_string())?;
  let openfleet_home = std::env::var("OPENFLEET_HOME").ok();
  let secrets = admin_token::admin_token_secrets(&admin_token::admin_token_path(openfleet_home.clone(), &user_home));
  let log_path = log_file::logs_dir(openfleet_home, &user_home).join(log_file::LOG_FILE_NAME);
  let status = daemon.snapshot(std::time::Instant::now());
  let daemon_state = serde_json::to_value(status.state).ok().and_then(|state| state.as_str().map(str::to_string)).unwrap_or_default();
  let report = issue_report::IssueReport {
    app_version: app.package_info().version.to_string(),
    daemon_version: status.daemon_version,
    daemon_state,
    macos_version: issue_report::macos_version(),
    arch: std::env::consts::ARCH.to_string(),
    log_lines: log_file::last_redacted_lines(&log_path, LOG_LINES_IN_REPORT, &secrets),
    user_home: user_home.to_string_lossy().to_string(),
  };
  issue_report::open_issue_form(&report, |url| issue_report::open_with_macos(url.as_ref()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let application = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(daemon::DaemonState::new())
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .invoke_handler(tauri::generate_handler![read_admin_token, daemon::daemon_status, reveal_logs, report_issue])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      daemon::start(app.handle().clone());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  application.run(|app, event| {
    app_exit::stop_daemon_on_final_exit(&event, || {
      daemon::stop(app);
      daemon::flush_log(app);
    });
    match event {
      tauri::RunEvent::ExitRequested { code, api, .. } => {
        let request = app_exit::ExitRequest::from_exit_code(code);
        if app_exit::decide_exit(request, app.webview_windows().len()) == app_exit::ExitDecision::KeepRunning {
          api.prevent_exit();
        }
      }
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Reopen { .. } => show_main_window(app),
      _ => {}
    }
  });
}

#[cfg(target_os = "macos")]
fn show_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    return;
  }
  let Some(window_config) = app.config().app.windows.first() else { return };
  if let Ok(builder) = tauri::WebviewWindowBuilder::from_config(app, window_config) {
    let _ = builder.build();
  }
}

#[cfg(test)]
mod tests {
  /// A sync command runs on the main thread unless it is declared `async`, and these two read files and wait on child processes.
  #[test]
  fn the_support_commands_run_off_the_main_thread_and_take_no_webview_argument() {
    let source = include_str!("lib.rs");

    for signature in ["fn reveal_logs(app: tauri::AppHandle)", "fn report_issue(app: tauri::AppHandle, daemon: tauri::State<daemon::DaemonState>)"] {
      let lines_before: Vec<&str> = source.split(signature).next().unwrap().lines().collect();
      assert_eq!(lines_before.last().copied(), Some("#[tauri::command(async)]"), "{signature}");
    }
  }
}
