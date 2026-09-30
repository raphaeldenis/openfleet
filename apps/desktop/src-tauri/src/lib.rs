mod admin_token;
mod app_exit;
mod daemon;
mod issue_report;
mod log_file;
mod path_repair;

use tauri::Manager;

#[cfg(target_os = "macos")]
const MAIN_WINDOW_LABEL: &str = "main";

#[tauri::command]
fn read_admin_token(app: tauri::AppHandle) -> Result<String, String> {
  let user_home = app.path().home_dir().map_err(|err| err.to_string())?;
  let token_path = admin_token::admin_token_path(std::env::var("OPENFLEET_HOME").ok(), &user_home);
  admin_token::read_admin_token_at(&token_path)
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
    .invoke_handler(tauri::generate_handler![read_admin_token, daemon::daemon_status])
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
    app_exit::stop_daemon_on_final_exit(&event, || daemon::stop(app));
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
