// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![deny(clippy::disallowed_macros, clippy::disallowed_methods)]

fn main() {
  app_lib::run();
}
