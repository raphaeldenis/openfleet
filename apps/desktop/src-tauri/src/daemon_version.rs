use serde::Serialize;

const UNRECOGNISED: &str = "unrecognised";
const MAX_NUMBER_DIGITS: usize = 4;
const RELEASE_CHANNELS: [&str; 5] = ["alpha", "beta", "rc", "dev", "next"];
const MAX_BUILD_METADATA_SEGMENTS: usize = 2;
const MIN_SHORT_SHA_DIGITS: usize = 7;
const MAX_SHORT_SHA_DIGITS: usize = 12;
const MAX_BUILD_NUMBER_DIGITS: usize = 8;
const DEV_BUILD: &str = "dev";
const DEV_BUILD_SHA_PREFIX: &str = "dev-";
const DEV_BUILD_SHA_DIGITS: usize = 8;

/// The version a daemon reports on `/health`, kept only when it reads `1.2.3`, `1.2.3-rc.1`, `1.2.3+abc1234.7`, `dev` or `dev-0a1b2c3d`; anything else is `unrecognised`.
/// A pre-release is a release channel (`alpha`, `beta`, `rc`, `dev`, `next`) with an optional `.<1 to 4 digits>`; a build metadata segment is 7 to 12 lowercase hex digits or 1 to 8 digits.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(transparent)]
pub struct DaemonVersion(String);

impl DaemonVersion {
  /// Returns the version when `reported` is a short semver or a local dev build, otherwise the `unrecognised` marker, never the reported text.
  pub fn parse(reported: &str) -> Self {
    let is_recognised = is_short_semver(reported) || is_dev_build(reported);
    if is_recognised {
      return Self(reported.to_string());
    }
    Self(UNRECOGNISED.to_string())
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

fn is_short_semver(reported: &str) -> bool {
  let (release, build_metadata) = match reported.split_once('+') {
    Some((release, build_metadata)) => (release, Some(build_metadata)),
    None => (reported, None),
  };
  let (numbers, pre_release) = match release.split_once('-') {
    Some((numbers, pre_release)) => (numbers, Some(pre_release)),
    None => (release, None),
  };
  let has_valid_numbers = has_three_short_numbers(numbers);
  let has_valid_pre_release = pre_release.is_none_or(is_release_channel_pre_release);
  let has_valid_build_metadata = build_metadata.is_none_or(is_short_build_metadata);
  has_valid_numbers && has_valid_pre_release && has_valid_build_metadata
}

fn is_dev_build(reported: &str) -> bool {
  let is_lowercase_hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
  let is_dev_build_at_a_commit = reported.strip_prefix(DEV_BUILD_SHA_PREFIX).is_some_and(|sha| sha.len() == DEV_BUILD_SHA_DIGITS && sha.bytes().all(is_lowercase_hex));
  reported == DEV_BUILD || is_dev_build_at_a_commit
}

fn has_three_short_numbers(numbers: &str) -> bool {
  let parts: Vec<&str> = numbers.split('.').collect();
  let is_short_number = |part: &&str| (1..=MAX_NUMBER_DIGITS).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit());
  parts.len() == 3 && parts.iter().all(is_short_number)
}

/// A release channel (`alpha`, `beta`, `rc`, `dev`, `next`) alone or followed by `.` and one to four digits.
fn is_release_channel_pre_release(pre_release: &str) -> bool {
  let (channel, iteration) = match pre_release.split_once('.') {
    Some((channel, iteration)) => (channel, Some(iteration)),
    None => (pre_release, None),
  };
  let is_release_channel = RELEASE_CHANNELS.contains(&channel);
  let has_valid_iteration = iteration.is_none_or(|digits| (1..=MAX_NUMBER_DIGITS).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit()));
  is_release_channel && has_valid_iteration
}

/// One or two dot-separated segments, each 7 to 12 lowercase hex digits or 1 to 8 digits. The capacity is 24 characters of `0-9a-f` at most: it fits a git sha or a build number, not a provider key (those carry uppercase, a prefix with a hyphen or underscore, or more than 12 characters per segment).
fn is_short_build_metadata(build_metadata: &str) -> bool {
  let segments: Vec<&str> = build_metadata.split('.').collect();
  (1..=MAX_BUILD_METADATA_SEGMENTS).contains(&segments.len()) && segments.iter().all(|segment| is_short_sha(segment) || is_build_number(segment))
}

fn is_short_sha(segment: &str) -> bool {
  let is_lowercase_hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
  (MIN_SHORT_SHA_DIGITS..=MAX_SHORT_SHA_DIGITS).contains(&segment.len()) && segment.bytes().all(is_lowercase_hex)
}

fn is_build_number(segment: &str) -> bool {
  (1..=MAX_BUILD_NUMBER_DIGITS).contains(&segment.len()) && segment.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::synthetic_tokens::{aws_key_id, github_token, openai_key, token, TokenShape};

  #[test]
  fn keeps_a_plain_or_pre_release_semver() {
    for version in ["0.4.2", "1.2.3", "9999.9999.9999", "0.2.0-dev", "1.2.3-rc.1", "0.2.0-beta.1", "1.0.0-alpha", "1.0.0-next.12", "1.0.0-beta.1234", "1.0.0-rc"] {
      assert_eq!(DaemonVersion::parse(version).as_str(), version);
    }
  }

  #[test]
  fn reduces_a_pre_release_outside_the_release_channels_to_unrecognised() {
    let not_release_channels = [
      "1.0.0-0.3.7",
      "1.0.0-1",
      "1.2.3-rc1",
      "1.0.0-beta.1.2",
      "1.2.3-snapshot",
      "1.2.3-abcdefghijklmnopqrstuvwx",
      "1.2.3-rc.12345",
      "1.2.3-rc.",
      "1.2.3-rc.x",
      "1.2.3-Rc.1",
      "1.2.3-betas",
      "1.2.3-rc.1+abc",
    ];
    for hostile in not_release_channels {
      assert_eq!(DaemonVersion::parse(hostile).as_str(), "unrecognised", "{hostile:?}");
    }
  }

  #[test]
  fn reduces_a_short_hex_build_metadata_to_unrecognised() {
    for hostile in ["1.0.0+abc", "1.2.3+a1b2c3", "1.2.3+abcdef", "1.2.3+abc1234.abc"] {
      assert_eq!(DaemonVersion::parse(hostile).as_str(), "unrecognised", "{hostile:?}");
    }
  }

  #[test]
  fn keeps_a_semver_with_a_build_number_or_a_short_sha() {
    for version in ["1.2.3+412", "1.2.3+abc1234", "1.2.3+abc1234.7", "1.2.3-rc.1+412", "1.2.3+12345678", "1.2.3+0123456789ab"] {
      assert_eq!(DaemonVersion::parse(version).as_str(), version);
    }
  }

  #[test]
  fn reduces_a_key_shaped_build_metadata_to_unrecognised() {
    let key_shaped_values = [
      aws_key_id(),
      openai_key(),
      token(TokenShape::OpenAi, 20, 7),
      token(TokenShape::GithubFineGrained, 40, 3),
      github_token(),
    ];
    for key_shaped in key_shaped_values {
      for hostile in [format!("1.2.3+{key_shaped}"), format!("1.2.3+412.{key_shaped}"), format!("1.2.3-rc.1+{key_shaped}")] {
        assert_eq!(DaemonVersion::parse(&hostile).as_str(), "unrecognised", "{hostile:?}");
      }
    }
  }

  #[test]
  fn keeps_a_local_dev_build() {
    for version in ["dev", "dev-0a1b2c3d", "dev-ffffffff"] {
      assert_eq!(DaemonVersion::parse(version).as_str(), version);
    }
  }

  #[test]
  fn reduces_a_malformed_build_metadata_or_dev_build_to_unrecognised() {
    let not_versions = [
      "1.2.3+",
      "1.2.3+build.7",
      "1.2.3+Exp-Sha.5114f85",
      "1.2.3+ABC1234",
      "1.2.3+abc-1234",
      "1.2.3+0123456789abc",
      "1.2.3+0123456789123",
      "1.2.3+1.2.3",
      "1.2.3+1..2",
      "1.2.3+.1",
      "1.2.3+has_underscore",
      "1.2.3+has space",
      "1.2.3++1",
      "1.2.3+1+2",
      "+412",
      "dev-",
      "dev-0a1b2c3",
      "dev-0a1b2c3d4",
      "dev-0A1B2C3D",
      "dev-0a1b2c3g",
      "dev-0a1b2c3d+412",
      "Dev",
      "develop",
      "dev ",
    ];
    for hostile in not_versions {
      assert_eq!(DaemonVersion::parse(hostile).as_str(), "unrecognised", "{hostile:?}");
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
      "1.2.3-abcdefghijklmnopqrstuvwxy",
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
