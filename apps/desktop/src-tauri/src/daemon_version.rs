use serde::Serialize;

const UNRECOGNISED: &str = "unrecognised";
const MAX_NUMBER_DIGITS: usize = 4;
const MAX_PRE_RELEASE_BYTES: usize = 24;

/// The version a daemon reports on `/health`, kept only when it reads `1.2.3` or `1.2.3-rc.1`; anything else is `unrecognised`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(transparent)]
pub struct DaemonVersion(String);

impl DaemonVersion {
  /// Returns the version when `reported` is a short semver, otherwise the `unrecognised` marker, never the reported text.
  pub fn parse(reported: &str) -> Self {
    let (numbers, pre_release) = match reported.split_once('-') {
      Some((numbers, pre_release)) => (numbers, Some(pre_release)),
      None => (reported, None),
    };
    let has_valid_numbers = has_three_short_numbers(numbers);
    let has_valid_pre_release = pre_release.is_none_or(is_short_pre_release);
    if has_valid_numbers && has_valid_pre_release {
      return Self(reported.to_string());
    }
    Self(UNRECOGNISED.to_string())
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

fn has_three_short_numbers(numbers: &str) -> bool {
  let parts: Vec<&str> = numbers.split('.').collect();
  let is_short_number = |part: &&str| (1..=MAX_NUMBER_DIGITS).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit());
  parts.len() == 3 && parts.iter().all(is_short_number)
}

fn is_short_pre_release(pre_release: &str) -> bool {
  let is_allowed_byte = |byte: u8| byte.is_ascii_digit() || byte.is_ascii_lowercase() || byte == b'.';
  (1..=MAX_PRE_RELEASE_BYTES).contains(&pre_release.len()) && pre_release.bytes().all(is_allowed_byte)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn keeps_a_plain_or_pre_release_semver() {
    for version in ["0.4.2", "1.2.3", "9999.9999.9999", "0.2.0-dev", "1.2.3-rc.1", "1.2.3-abcdefghijklmnopqrstuvwx"] {
      assert_eq!(DaemonVersion::parse(version).as_str(), version);
    }
  }

  #[test]
  fn reduces_anything_else_to_unrecognised() {
    let not_versions = [
      "",
      "1",
      "1.2",
      "1.2.3.4",
      "12345.1.1",
      "v1.2.3",
      " 1.2.3",
      "1.2.3 ",
      "1.2.3-",
      "1.2.3-RC1",
      "1.2.3-has-dash",
      "1.2.3+412",
      "1.2.3-abcdefghijklmnopqrstuvwxy",
      "dev",
      "1.2.3\n",
      "١.٢.٣",
    ];
    for hostile in not_versions {
      assert_eq!(DaemonVersion::parse(hostile).as_str(), "unrecognised", "{hostile:?}");
    }
  }

  #[test]
  fn serializes_as_a_bare_string() {
    assert_eq!(serde_json::to_string(&DaemonVersion::parse("1.2.3")).unwrap(), r#""1.2.3""#);
  }
}
