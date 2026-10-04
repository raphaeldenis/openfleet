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

/// Returns the admin token as a list the status line scrub can use: empty when the token cannot be read yet. The event log never reads it.
pub fn admin_token_secrets(token_path: &Path) -> Vec<String> {
  read_admin_token_at(token_path).into_iter().filter(|token| !token.is_empty()).collect()
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

  #[test]
  fn the_secrets_follow_a_token_file_that_was_unreadable_at_first() {
    use std::os::unix::fs::PermissionsExt;
    let folder = scratch_folder("unreadable");
    let path = folder.join("admin.token");
    std::fs::write(&path, "late-token-0001\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(admin_token_secrets(&path), Vec::<String>::new(), "unreadable");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

    assert_eq!(admin_token_secrets(&path), vec!["late-token-0001".to_string()]);
    std::fs::remove_dir_all(folder).unwrap();
  }

  #[test]
  fn the_secrets_follow_the_token_file_as_it_changes() {
    let folder = scratch_folder("watch");
    let path = folder.join("admin.token");
    assert_eq!(admin_token_secrets(&path), Vec::<String>::new(), "no file yet");

    std::fs::write(&path, "first-token-0001\n").unwrap();
    assert_eq!(admin_token_secrets(&path), vec!["first-token-0001".to_string()], "the file appeared");

    std::fs::write(&path, "other-token-0002\n").unwrap();
    assert_eq!(admin_token_secrets(&path), vec!["other-token-0002".to_string()], "the file changed");

    std::fs::write(&path, "\n").unwrap();
    assert_eq!(admin_token_secrets(&path), Vec::<String>::new(), "an empty file holds no secret");
    std::fs::remove_dir_all(folder).unwrap();
  }
}
