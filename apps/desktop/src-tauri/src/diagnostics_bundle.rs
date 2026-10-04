use std::ffi::OsString;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BUNDLE_EXTENSION: &str = "zip";
const PRIVATE_FILE_MODE: u32 = 0o600;
const MAX_DEFAULT_NAME_CHARS: usize = 80;
pub const MAX_BUNDLE_BYTES: usize = 64 * 1024 * 1024;
const DIALOG_CANCELLED_MARKERS: [&str; 2] = ["(-128)", "User canceled"];

/// Takes the suggested file name from argv, so nothing the webview sends is ever interpolated into the script.
const SAVE_DIALOG_SCRIPT: &str = r#"on run argv
  set chosen to choose file name with prompt "Save the OpenFleet diagnostics bundle" default name (item 1 of argv)
  return POSIX path of chosen
end run"#;

#[derive(Debug, PartialEq)]
pub enum DialogOutcome {
  Chosen(PathBuf),
  Cancelled,
  Failed(String),
}

#[derive(Debug, PartialEq)]
pub enum SaveOutcome {
  Saved(PathBuf),
  Cancelled,
}

/// The arguments `osascript` receives: the script, then the suggested name as its one argv item.
pub fn dialog_args(default_name: &str) -> Vec<OsString> {
  vec![OsString::from("-e"), OsString::from(SAVE_DIALOG_SCRIPT), OsString::from(default_name)]
}

/// A suggested name is a plain `.zip` file name: no folder, no control character, bounded length.
pub fn is_acceptable_default_name(name: &str) -> bool {
  let is_plain_name = !name.is_empty() && name.chars().count() <= MAX_DEFAULT_NAME_CHARS && !name.starts_with('.');
  let has_only_safe_characters = name.chars().all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character));
  let has_bundle_extension = Path::new(name).extension().is_some_and(|extension| extension.eq_ignore_ascii_case(BUNDLE_EXTENSION));
  is_plain_name && has_only_safe_characters && has_bundle_extension
}

/// Reads what `osascript` ended with: the chosen path, a cancel by the user (exit code -128), or a failure.
pub fn classify_dialog_result(succeeded: bool, stdout: &str, stderr: &str) -> DialogOutcome {
  if succeeded {
    let chosen = stdout.trim();
    return if chosen.is_empty() { DialogOutcome::Failed("the dialog returned no path".to_string()) } else { DialogOutcome::Chosen(PathBuf::from(chosen)) };
  }
  let was_cancelled = DIALOG_CANCELLED_MARKERS.iter().any(|marker| stderr.contains(marker));
  if was_cancelled { DialogOutcome::Cancelled } else { DialogOutcome::Failed(format!("the dialog failed: {}", stderr.trim())) }
}

/// Appends `.zip` when the user typed a name without it.
pub fn with_bundle_extension(path: PathBuf) -> PathBuf {
  let has_bundle_extension = path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case(BUNDLE_EXTENSION));
  if has_bundle_extension {
    return path;
  }
  let mut spelled = path.into_os_string();
  spelled.push(".");
  spelled.push(BUNDLE_EXTENSION);
  PathBuf::from(spelled)
}

/// A destination is an absolute `.zip` path inside a folder that exists.
pub fn validate_destination(path: &Path) -> Result<(), String> {
  if !path.is_absolute() {
    return Err("the destination is not an absolute path".to_string());
  }
  let has_bundle_extension = path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case(BUNDLE_EXTENSION));
  if !has_bundle_extension {
    return Err("the destination is not a .zip file".to_string());
  }
  let parent_exists = path.parent().is_some_and(Path::is_dir);
  if !parent_exists {
    return Err("the destination folder does not exist".to_string());
  }
  Ok(())
}

/// Writes the file readable by its owner only, whether or not it existed (an existing file keeps its old mode otherwise).
#[allow(clippy::disallowed_methods)]
pub fn write_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
  use std::fs::OpenOptions;
  let mut file = OpenOptions::new().write(true).create(true).truncate(true).mode(PRIVATE_FILE_MODE).open(path)?;
  file.set_permissions(std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
  file.write_all(bytes)?;
  file.sync_all()
}

/// Asks where to save (through `choose`), then writes the bundle there; a cancelled dialog writes nothing and is not an error.
pub fn save_bundle(default_name: &str, bytes: &[u8], choose: impl FnOnce(&str) -> DialogOutcome) -> Result<SaveOutcome, String> {
  if !is_acceptable_default_name(default_name) {
    return Err("the suggested file name is not acceptable".to_string());
  }
  if bytes.len() > MAX_BUNDLE_BYTES {
    return Err("the bundle is too large".to_string());
  }
  let chosen = match choose(default_name) {
    DialogOutcome::Cancelled => return Ok(SaveOutcome::Cancelled),
    DialogOutcome::Failed(reason) => return Err(reason),
    DialogOutcome::Chosen(path) => with_bundle_extension(path),
  };
  validate_destination(&chosen)?;
  write_private_file(&chosen, bytes).map_err(|err| format!("could not write the bundle: {err}"))?;
  Ok(SaveOutcome::Saved(chosen))
}

/// Shows the macOS save sheet and waits for the user; blocks until it closes, so callers run it off the main thread.
pub fn choose_destination_with_macos(default_name: &str) -> DialogOutcome {
  let output = Command::new("/usr/bin/osascript").args(dialog_args(default_name)).stdin(Stdio::null()).output();
  match output {
    Ok(finished) => classify_dialog_result(finished.status.success(), &String::from_utf8_lossy(&finished.stdout), &String::from_utf8_lossy(&finished.stderr)),
    Err(err) => DialogOutcome::Failed(format!("could not show the dialog: {err}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  struct ScratchFolder(PathBuf);

  impl std::ops::Deref for ScratchFolder {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
      &self.0
    }
  }

  impl Drop for ScratchFolder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn scratch_folder(label: &str) -> ScratchFolder {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let folder = std::env::temp_dir().join(format!("openfleet-bundle-test-{label}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    ScratchFolder(folder)
  }

  #[test]
  fn the_suggested_name_travels_as_the_third_argument_and_never_inside_the_script() {
    let hostile = "x\" & (do shell script \"id\") & \".zip";

    let args = dialog_args(hostile);

    assert_eq!(args.len(), 3);
    assert_eq!(args[2], OsString::from(hostile));
    assert!(!args[1].to_string_lossy().contains("do shell script"));
  }

  #[test]
  fn only_plain_zip_names_are_acceptable_suggestions() {
    assert!(is_acceptable_default_name("openfleet-diagnostics-2026-10-04-1412.zip"));
    for refused in ["", "bundle.txt", "../bundle.zip", "a/b.zip", ".hidden.zip", "bundle\n.zip", "x\".zip", &"a".repeat(90)] {
      assert!(!is_acceptable_default_name(refused), "{refused:?}");
    }
  }

  #[test]
  fn a_chosen_path_is_trimmed_of_the_trailing_newline() {
    assert_eq!(classify_dialog_result(true, "/Users/x/Desktop/bundle.zip\n", ""), DialogOutcome::Chosen(PathBuf::from("/Users/x/Desktop/bundle.zip")));
  }

  #[test]
  fn an_empty_answer_is_a_failure() {
    assert!(matches!(classify_dialog_result(true, "  \n", ""), DialogOutcome::Failed(_)));
  }

  #[test]
  fn the_user_cancelling_the_sheet_is_a_cancel_not_a_failure() {
    let stderr = "0:62: execution error: User canceled. (-128)\n";

    assert_eq!(classify_dialog_result(false, "", stderr), DialogOutcome::Cancelled);
  }

  #[test]
  fn another_osascript_error_is_a_failure_carrying_its_text() {
    assert_eq!(classify_dialog_result(false, "", "boom\n"), DialogOutcome::Failed("the dialog failed: boom".to_string()));
  }

  #[test]
  fn a_missing_extension_gets_zip_appended_and_an_existing_one_is_kept() {
    assert_eq!(with_bundle_extension(PathBuf::from("/a/bundle")), PathBuf::from("/a/bundle.zip"));
    assert_eq!(with_bundle_extension(PathBuf::from("/a/bundle.ZIP")), PathBuf::from("/a/bundle.ZIP"));
    assert_eq!(with_bundle_extension(PathBuf::from("/a/bundle.tar")), PathBuf::from("/a/bundle.tar.zip"));
  }

  #[test]
  fn a_destination_must_be_absolute_zip_and_in_an_existing_folder() {
    let folder = scratch_folder("validate");

    assert!(validate_destination(&folder.join("bundle.zip")).is_ok());
    assert!(validate_destination(Path::new("bundle.zip")).is_err());
    assert!(validate_destination(&folder.join("bundle.txt")).is_err());
    assert!(validate_destination(&folder.join("missing").join("bundle.zip")).is_err());
  }

  #[test]
  fn the_bundle_is_written_readable_by_its_owner_only_even_over_a_looser_file() {
    let folder = scratch_folder("mode");
    let path = folder.join("bundle.zip");
    std::fs::write(&path, b"old").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    write_private_file(&path, b"PK new").unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"PK new");
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
  }

  #[test]
  fn saving_writes_the_chosen_file_and_adds_the_extension_the_user_left_out() {
    let folder = scratch_folder("save");
    let chosen = folder.join("mine");

    let outcome = save_bundle("openfleet-diagnostics-x.zip", b"PK", |_| DialogOutcome::Chosen(chosen)).unwrap();

    assert_eq!(outcome, SaveOutcome::Saved(folder.join("mine.zip")));
    assert_eq!(std::fs::read(folder.join("mine.zip")).unwrap(), b"PK");
  }

  #[test]
  fn a_cancelled_dialog_writes_nothing_and_succeeds() {
    let folder = scratch_folder("cancel");

    let outcome = save_bundle("openfleet-diagnostics-x.zip", b"PK", |_| DialogOutcome::Cancelled).unwrap();

    assert_eq!(outcome, SaveOutcome::Cancelled);
    assert_eq!(std::fs::read_dir(&*folder).unwrap().count(), 0);
  }

  #[test]
  fn a_failed_dialog_and_an_unwritable_destination_are_errors() {
    let failed = save_bundle("openfleet-diagnostics-x.zip", b"PK", |_| DialogOutcome::Failed("no".to_string()));
    let unwritable = save_bundle("openfleet-diagnostics-x.zip", b"PK", |_| DialogOutcome::Chosen(PathBuf::from("/nonexistent-folder/bundle.zip")));

    assert!(failed.is_err());
    assert!(unwritable.is_err());
  }

  #[test]
  fn a_bad_suggested_name_never_reaches_the_dialog() {
    let outcome = save_bundle("../x.zip", b"PK", |_| panic!("the dialog must not open"));

    assert!(outcome.is_err());
  }
}
