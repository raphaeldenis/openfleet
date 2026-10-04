use super::salt::Salt;
use std::fmt;

const TAG_BYTES: usize = 4;

/// The first 4 bytes of the keyed BLAKE3 hash of a text, rendered as 8 lowercase hex characters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hash8([u8; TAG_BYTES]);

impl Hash8 {
  /// Hashes the raw bytes of `text` under the install salt.
  pub fn of(salt: &Salt, text: &[u8]) -> Self {
    let digest = blake3::keyed_hash(salt.key(), text);
    let mut tag = [0u8; TAG_BYTES];
    tag.copy_from_slice(&digest.as_bytes()[..TAG_BYTES]);
    Self(tag)
  }
}

impl fmt::Display for Hash8 {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    self.0.iter().try_for_each(|byte| write!(formatter, "{byte:02x}"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::salt::SALT_LEN;
  use crate::linear_growth::{assert_linear_growth, cpu_time_to_run_on_repeated, LinearGrowthBudget};

  const ONE_MIB: usize = 1 << 20;

  fn salt_of(byte: u8) -> Salt {
    Salt::from_bytes([byte; SALT_LEN])
  }

  #[test]
  fn matches_the_official_blake3_keyed_hash_vector_for_an_empty_input() {
    let official_test_key = Salt::from_bytes(*b"whats the Elvish word for friend");

    let tag = Hash8::of(&official_test_key, b"");

    assert_eq!(tag.to_string(), "92b2b756");
  }

  #[test]
  fn renders_eight_lowercase_hex_characters() {
    let tag = Hash8::of(&salt_of(1), b"some text").to_string();

    assert_eq!(tag.len(), 8);
    assert!(tag.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)), "{tag}");
  }

  #[test]
  fn the_same_bytes_under_the_same_salt_give_the_same_tag() {
    assert_eq!(Hash8::of(&salt_of(1), b"disk full"), Hash8::of(&salt_of(1), b"disk full"));
  }

  #[test]
  fn the_same_bytes_under_another_salt_give_another_tag() {
    assert_ne!(Hash8::of(&salt_of(1), b"disk full"), Hash8::of(&salt_of(2), b"disk full"));
  }

  #[test]
  fn other_bytes_give_another_tag() {
    assert_ne!(Hash8::of(&salt_of(1), b"disk full"), Hash8::of(&salt_of(1), b"disk full."));
  }

  #[test]
  fn hashing_one_mebibyte_costs_a_linear_cpu_time() {
    let salt = salt_of(3);
    let measure = cpu_time_to_run_on_repeated("a", |text| {
      std::hint::black_box(Hash8::of(&salt, text.as_bytes()));
    });

    assert_linear_growth(measure, &LinearGrowthBudget::between(16 * 1024, ONE_MIB));
  }
}
