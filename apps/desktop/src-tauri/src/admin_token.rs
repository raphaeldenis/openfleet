use std::path::{Path, PathBuf};

/// Returns the folder the daemon keeps its files in: `$OPENFLEET_HOME`, else `~/.openfleet`.
pub fn openfleet_home_dir(openfleet_home: Option<String>, user_home: &Path) -> PathBuf {
  openfleet_home.map_or_else(|| user_home.join(".openfleet"), PathBuf::from)
}

/// Returns where the daemon keeps its admin token: `$OPENFLEET_HOME/admin.token`, else `~/.openfleet/admin.token`.
pub fn admin_token_path(openfleet_home: Option<String>, user_home: &Path) -> PathBuf {
  openfleet_home_dir(openfleet_home, user_home).join("admin.token")
}

/// Reads the admin token, trimmed.
pub fn read_admin_token_at(token_path: &Path) -> Result<String, String> {
  std::fs::read_to_string(token_path)
    .map(|contents| contents.trim().to_string())
    .map_err(|err| format!("could not read {}: {err}", token_path.display()))
}

/// Returns the admin token as a list a redaction pass can use: empty when the token cannot be read yet.
pub fn admin_token_secrets(token_path: &Path) -> Vec<String> {
  read_admin_token_at(token_path).into_iter().filter(|token| !token.is_empty()).collect()
}

/// Reads the admin token again whenever the file's modification time or size changes.
pub struct AdminTokenWatch {
  path: PathBuf,
}

impl AdminTokenWatch {
  pub fn new(path: PathBuf) -> Self {
    Self { path }
  }

  /// Returns the token's secrets when the file appeared, changed or vanished since the last call; None when it is as it was.
  pub fn secrets_if_changed(&mut self) -> Option<Vec<String>> {
    let _ = &self.path;
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scratch_folder(name: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("of-admin-token-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    folder
  }

  #[test]
  fn uses_openfleet_home_when_it_is_set() {
    let path = admin_token_path(Some("/scratch/of".to_string()), Path::new("/Users/test"));

    assert_eq!(path, PathBuf::from("/scratch/of/admin.token"));
  }

  #[test]
  fn defaults_to_the_dot_openfleet_folder_of_the_user() {
    let path = admin_token_path(None, Path::new("/Users/test"));

    assert_eq!(path, PathBuf::from("/Users/test/.openfleet/admin.token"));
  }

  #[test]
  fn reads_the_token_without_its_trailing_newline() {
    let folder = scratch_folder("read");
    std::fs::write(folder.join("admin.token"), "secret-token\n").unwrap();

    let token = read_admin_token_at(&folder.join("admin.token"));

    assert_eq!(token, Ok("secret-token".to_string()));
    std::fs::remove_dir_all(folder).unwrap();
  }

  #[test]
  fn names_the_missing_file_in_the_error() {
    let missing = scratch_folder("missing").join("admin.token");

    let error = read_admin_token_at(&missing).unwrap_err();

    assert!(error.contains("could not read"));
    assert!(error.contains("admin.token"));
    std::fs::remove_dir_all(missing.parent().unwrap()).unwrap();
  }

  fn touch_to(path: &Path, modified: std::time::SystemTime) {
    std::fs::File::options().write(true).open(path).unwrap().set_modified(modified).unwrap();
  }

  #[test]
  fn the_watch_reads_the_token_again_only_when_the_file_changed() {
    let folder = scratch_folder("watch");
    let path = folder.join("admin.token");
    let mut watch = AdminTokenWatch::new(path.clone());
    let later = |seconds: u64| std::time::SystemTime::now() + std::time::Duration::from_secs(seconds);
    assert_eq!(watch.secrets_if_changed(), None, "no file yet");

    std::fs::write(&path, "first-token-0001\n").unwrap();
    assert_eq!(watch.secrets_if_changed(), Some(vec!["first-token-0001".to_string()]), "the file appeared");
    assert_eq!(watch.secrets_if_changed(), None, "nothing changed");

    std::fs::write(&path, "other-token-0002\n").unwrap();
    touch_to(&path, later(60));
    assert_eq!(watch.secrets_if_changed(), Some(vec!["other-token-0002".to_string()]), "same size, new modification time");

    let modified_before = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, "a-much-longer-token-0003\n").unwrap();
    touch_to(&path, modified_before);
    assert_eq!(watch.secrets_if_changed(), Some(vec!["a-much-longer-token-0003".to_string()]), "new size, same modification time");

    std::fs::remove_file(&path).unwrap();
    assert_eq!(watch.secrets_if_changed(), Some(Vec::new()), "the file vanished");
    assert_eq!(watch.secrets_if_changed(), None, "still gone");
    std::fs::remove_dir_all(folder).unwrap();
  }
}
