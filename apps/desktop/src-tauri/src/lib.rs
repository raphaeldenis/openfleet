mod daemon;
mod path_repair;

use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
fn read_admin_token(app: tauri::AppHandle) -> Result<String, String> {
  let home = match std::env::var("OPENFLEET_HOME") {
    Ok(value) => PathBuf::from(value),
    Err(_) => app.path().home_dir().map_err(|err| err.to_string())?.join(".openfleet"),
  };
  let token_path = home.join("admin.token");
  std::fs::read_to_string(&token_path)
    .map(|contents| contents.trim().to_string())
    .map_err(|err| format!("could not read {}: {err}", token_path.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let application = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(daemon::DaemonState::new())
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
    let is_quitting = matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit);
    if is_quitting {
      daemon::stop(app);
    }
  });
}
