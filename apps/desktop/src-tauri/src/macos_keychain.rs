//! The macOS keychain behind `SecretKeychain`, through the Security framework (the `security-framework` crate).
//!
//! Not covered by a test: a test must never touch a real keychain item. What is checked is the logic around it (`secret_channel`); what is not is the access control
//! of the items (whether a rebuilt, ad hoc signed app is prompted again) and the behaviour of a locked keychain. See docs/secrets.md.

use crate::secret_channel::{KeychainUnavailable, SecretKeychain, KEYCHAIN_SERVICE};

/// `errSecItemNotFound`: no item under that service and account.
const ITEM_NOT_FOUND: i32 = -25300;

pub struct MacKeychain;

#[cfg(target_os = "macos")]
impl SecretKeychain for MacKeychain {
  fn set(&self, account: &str, value: &str) -> Result<(), KeychainUnavailable> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, account, value.as_bytes()).map_err(|_| KeychainUnavailable)
  }

  fn clear(&self, account: &str) -> Result<(), KeychainUnavailable> {
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account) {
      Ok(()) => Ok(()),
      Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
      Err(_) => Err(KeychainUnavailable),
    }
  }

  fn read(&self, account: &str) -> Result<Option<String>, KeychainUnavailable> {
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
      Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| KeychainUnavailable),
      Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
      Err(_) => Err(KeychainUnavailable),
    }
  }
}

/// Off macOS there is no keychain to use: every operation is unavailable.
#[cfg(not(target_os = "macos"))]
impl SecretKeychain for MacKeychain {
  fn set(&self, _account: &str, _value: &str) -> Result<(), KeychainUnavailable> {
    let _ = (KEYCHAIN_SERVICE, ITEM_NOT_FOUND);
    Err(KeychainUnavailable)
  }

  fn clear(&self, _account: &str) -> Result<(), KeychainUnavailable> {
    Err(KeychainUnavailable)
  }

  fn read(&self, _account: &str) -> Result<Option<String>, KeychainUnavailable> {
    Err(KeychainUnavailable)
  }
}
