use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub const SALT_FILE_NAME: &str = "log.salt";
pub const SALT_LEN: usize = 32;
const RANDOM_SOURCE: &str = "/dev/urandom";
const OWNER_READ_WRITE_ONLY: u32 = 0o600;

/// The per-install key of the text tags. It has no `Display`, and its `Debug` prints no byte.
#[derive(Clone, PartialEq)]
pub struct Salt([u8; SALT_LEN]);

impl std::fmt::Debug for Salt {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str("Salt(hidden)")
  }
}

impl Salt {
  pub(super) fn from_bytes(bytes: [u8; SALT_LEN]) -> Self {
    Self(bytes)
  }

  pub(super) fn key(&self) -> &[u8; SALT_LEN] {
    &self.0
  }

  /// Returns the salt stored in `<home>/log.salt`, creating the file from the OS random source when it is absent or malformed.
  /// Returns `None` on any error: the tags then degrade to a length without a hash.
  pub fn load_or_create(home: &Path) -> Option<Self> {
    let salt_path = home.join(SALT_FILE_NAME);
    match read_salt(&salt_path) {
      Ok(Some(salt)) => Some(salt),
      Ok(None) => replace_malformed_salt(&salt_path),
      Err(error) if error.kind() == io::ErrorKind::NotFound => create_salt(&salt_path),
      Err(_) => None,
    }
  }
}

fn read_salt(salt_path: &Path) -> io::Result<Option<Salt>> {
  let stored = std::fs::read(salt_path)?;
  let bytes: Option<[u8; SALT_LEN]> = stored.try_into().ok();
  Ok(bytes.map(Salt))
}

fn random_salt() -> io::Result<Salt> {
  let mut bytes = [0u8; SALT_LEN];
  File::open(RANDOM_SOURCE)?.read_exact(&mut bytes)?;
  Ok(Salt(bytes))
}

fn write_private_file(path: &Path, salt: &Salt) -> io::Result<()> {
  let mut file = OpenOptions::new().write(true).create_new(true).mode(OWNER_READ_WRITE_ONLY).open(path)?;
  file.write_all(&salt.0)?;
  file.sync_all()
}

fn staging_path_beside(salt_path: &Path) -> PathBuf {
  salt_path.with_extension(format!("{}.tmp", std::process::id()))
}

/// Writes the salt to a staging file, then links it under its final name: the final file is never seen half-written and a concurrent creator never overwrites it.
fn create_salt(salt_path: &Path) -> Option<Salt> {
  let staging_path = staging_path_beside(salt_path);
  let _ = std::fs::remove_file(&staging_path);
  let salt = random_salt().ok()?;
  write_private_file(&staging_path, &salt).ok()?;
  let link_result = std::fs::hard_link(&staging_path, salt_path);
  let _ = std::fs::remove_file(&staging_path);

  match link_result {
    Ok(()) => Some(salt),
    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => read_salt(salt_path).ok().flatten(),
    Err(_) => None,
  }
}

fn replace_malformed_salt(salt_path: &Path) -> Option<Salt> {
  let staging_path = staging_path_beside(salt_path);
  let _ = std::fs::remove_file(&staging_path);
  let salt = random_salt().ok()?;
  write_private_file(&staging_path, &salt).ok()?;
  let is_renamed = std::fs::rename(&staging_path, salt_path).is_ok();
  if !is_renamed {
    let _ = std::fs::remove_file(&staging_path);
    return None;
  }
  Some(salt)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;

  fn scratch_folder(name: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("of-log-salt-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
  }

  fn mode_of(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
  }

  #[test]
  fn creates_a_32_byte_salt_file_readable_by_its_owner_only() {
    let home = scratch_folder("create");

    let salt = Salt::load_or_create(&home);

    assert!(salt.is_some());
    let salt_path = home.join(SALT_FILE_NAME);
    assert_eq!(std::fs::read(&salt_path).unwrap().len(), SALT_LEN);
    assert_eq!(mode_of(&salt_path), 0o600);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn returns_the_same_salt_on_every_later_call() {
    let home = scratch_folder("stable");

    let first = Salt::load_or_create(&home);
    let second = Salt::load_or_create(&home);

    assert!(first.is_some());
    assert_eq!(first, second);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn two_installs_get_different_salts() {
    let first_home = scratch_folder("first-install");
    let second_home = scratch_folder("second-install");

    let first = Salt::load_or_create(&first_home);
    let second = Salt::load_or_create(&second_home);

    assert_ne!(first, second);
    std::fs::remove_dir_all(first_home).unwrap();
    std::fs::remove_dir_all(second_home).unwrap();
  }

  #[test]
  fn keeps_an_existing_valid_file_untouched() {
    let home = scratch_folder("existing");
    let stored_bytes = [7u8; SALT_LEN];
    std::fs::write(home.join(SALT_FILE_NAME), stored_bytes).unwrap();

    let salt = Salt::load_or_create(&home);

    assert_eq!(salt, Some(Salt::from_bytes(stored_bytes)));
    assert_eq!(std::fs::read(home.join(SALT_FILE_NAME)).unwrap(), stored_bytes);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn never_overwrites_a_file_that_appears_during_creation() {
    let home = scratch_folder("race");
    let salt_path = home.join(SALT_FILE_NAME);
    let winner_bytes = [9u8; SALT_LEN];
    std::fs::write(&salt_path, winner_bytes).unwrap();

    let salt = create_salt(&salt_path);

    assert_eq!(salt, Some(Salt::from_bytes(winner_bytes)));
    assert_eq!(std::fs::read(&salt_path).unwrap(), winner_bytes);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn replaces_a_malformed_file_with_a_fresh_private_salt() {
    let home = scratch_folder("malformed");
    let salt_path = home.join(SALT_FILE_NAME);
    std::fs::write(&salt_path, b"too short").unwrap();

    let salt = Salt::load_or_create(&home);

    assert!(salt.is_some());
    assert_eq!(std::fs::read(&salt_path).unwrap().len(), SALT_LEN);
    assert_eq!(mode_of(&salt_path), 0o600);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn leaves_no_staging_file_behind() {
    let home = scratch_folder("staging");

    Salt::load_or_create(&home);

    let names: Vec<_> = std::fs::read_dir(&home).unwrap().map(|entry| entry.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from(SALT_FILE_NAME)]);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn fails_closed_when_the_home_folder_does_not_exist() {
    let home = scratch_folder("missing-home").join("absent");

    assert_eq!(Salt::load_or_create(&home), None);
    std::fs::remove_dir_all(home.parent().unwrap()).unwrap();
  }

  #[test]
  fn fails_closed_and_keeps_the_file_when_it_is_unreadable() {
    let home = scratch_folder("unreadable");
    let salt_path = home.join(SALT_FILE_NAME);
    std::fs::write(&salt_path, [5u8; SALT_LEN]).unwrap();
    std::fs::set_permissions(&salt_path, std::fs::Permissions::from_mode(0o000)).unwrap();

    let salt = Salt::load_or_create(&home);

    assert_eq!(salt, None);
    std::fs::set_permissions(&salt_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(std::fs::read(&salt_path).unwrap(), [5u8; SALT_LEN]);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn fails_closed_when_the_salt_path_is_a_folder() {
    let home = scratch_folder("folder");
    std::fs::create_dir(home.join(SALT_FILE_NAME)).unwrap();

    assert_eq!(Salt::load_or_create(&home), None);
    std::fs::remove_dir_all(home).unwrap();
  }

  #[test]
  fn debug_prints_no_salt_byte() {
    let salt = Salt::from_bytes([0xAB; SALT_LEN]);

    let rendered = format!("{salt:?} {salt:#?}");

    assert!(!rendered.to_lowercase().contains("ab"), "{rendered}");
    assert!(!rendered.contains("171"), "{rendered}");
  }
}
