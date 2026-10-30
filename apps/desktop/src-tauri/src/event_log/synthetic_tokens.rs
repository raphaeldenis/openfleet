//! Builds token-shaped strings at run time, so no source file holds a literal credential shape.
//! `no_literal_token_shape_in_sources` fails on any literal that looks like one of these shapes.

#[derive(Clone, Copy, Debug)]
pub(crate) enum TokenShape {
  Gitlab,
  Github,
  GithubFineGrained,
  OpenAi,
  Anthropic,
  Aws,
  AwsSession,
  SlackBot,
  SlackUser,
  SlackRefresh,
  Jwt,
}

const GITHUB_BODY_LEN: usize = 36;
const AWS_BODY_LEN: usize = 16;
const OPENAI_BODY_LEN: usize = 24;
const ANTHROPIC_BODY_LEN: usize = 40;
const DEFAULT_SEED: u64 = 1;
const MIXED_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

impl TokenShape {
  fn prefix(self) -> String {
    let fragments: &[&str] = match self {
      TokenShape::Gitlab => &["gl", "pat-"],
      TokenShape::Github => &["gh", "p_"],
      TokenShape::GithubFineGrained => &["github", "_pat_"],
      TokenShape::OpenAi => &["s", "k-"],
      TokenShape::Anthropic => &["s", "k-ant-api03-"],
      TokenShape::Aws => &["AK", "IA"],
      TokenShape::AwsSession => &["AS", "IA"],
      TokenShape::SlackBot => &["xo", "xb-"],
      TokenShape::SlackUser => &["xo", "xp-"],
      TokenShape::SlackRefresh => &["xo", "xe-"],
      TokenShape::Jwt => &["ey", "J"],
    };
    fragments.concat()
  }

  fn alphabet(self) -> &'static [u8] {
    match self {
      TokenShape::Aws | TokenShape::AwsSession => UPPER_ALPHABET,
      _ => MIXED_ALPHABET,
    }
  }
}

fn next_xorshift(state: u64) -> u64 {
  let mut next = state;
  next ^= next << 13;
  next ^= next >> 7;
  next ^= next << 17;
  next
}

/// Returns `length` deterministic characters drawn from `alphabet`; the same seed gives the same body.
pub(crate) fn body(alphabet: &[u8], length: usize, seed: u64) -> String {
  let mut state = seed.max(DEFAULT_SEED);
  (0..length)
    .map(|_| {
      state = next_xorshift(state);
      alphabet[(state % alphabet.len() as u64) as usize] as char
    })
    .collect()
}

/// Returns the shape's prefix followed by a deterministic body of `body_len` characters.
pub(crate) fn token(shape: TokenShape, body_len: usize, seed: u64) -> String {
  format!("{}{}", shape.prefix(), body(shape.alphabet(), body_len, seed))
}

/// Returns a three-segment JWT-shaped string whose segments each carry `segment_body_len` characters after their start.
pub(crate) fn jwt(segment_body_len: usize, seed: u64) -> String {
  let header = token(TokenShape::Jwt, segment_body_len, seed);
  let payload = token(TokenShape::Jwt, segment_body_len, seed + 1);
  let signature = body(MIXED_ALPHABET, segment_body_len, seed + 2);
  format!("{header}.{payload}.{signature}")
}

/// Returns a token with the shape of a GitHub personal access token.
pub(crate) fn github_token() -> String {
  token(TokenShape::Github, GITHUB_BODY_LEN, DEFAULT_SEED)
}

/// Returns a token with the shape of an AWS access key id.
pub(crate) fn aws_key_id() -> String {
  token(TokenShape::Aws, AWS_BODY_LEN, DEFAULT_SEED)
}

/// Returns a token with the shape of an AWS temporary access key id.
pub(crate) fn aws_session_key_id() -> String {
  token(TokenShape::AwsSession, AWS_BODY_LEN, DEFAULT_SEED)
}

/// Returns a token with the shape of an OpenAI-style secret key.
pub(crate) fn openai_key() -> String {
  token(TokenShape::OpenAi, OPENAI_BODY_LEN, DEFAULT_SEED)
}

/// Returns a token with the shape of an Anthropic API key.
pub(crate) fn anthropic_key() -> String {
  token(TokenShape::Anthropic, ANTHROPIC_BODY_LEN, DEFAULT_SEED)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::{Path, PathBuf};

  const MIN_BODY_LEN: usize = 8;
  const GENERATOR_SOURCE: &str = "event_log/synthetic_tokens.rs";

  fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
  }

  fn is_dashed_body_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
  }

  fn is_upper_body_byte(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit()
  }

  fn is_alphanumeric_body_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
  }

  type IsBodyByte = fn(u8) -> bool;

  fn shapes_with_body_class() -> Vec<(TokenShape, IsBodyByte)> {
    vec![
      (TokenShape::Gitlab, is_dashed_body_byte),
      (TokenShape::Github, is_alphanumeric_body_byte),
      (TokenShape::GithubFineGrained, is_dashed_body_byte),
      (TokenShape::OpenAi, is_dashed_body_byte),
      (TokenShape::Aws, is_upper_body_byte),
      (TokenShape::AwsSession, is_upper_body_byte),
      (TokenShape::SlackBot, is_dashed_body_byte),
      (TokenShape::SlackUser, is_dashed_body_byte),
      (TokenShape::SlackRefresh, is_dashed_body_byte),
      (TokenShape::Jwt, is_dashed_body_byte),
    ]
  }

  fn has_literal_token_shape(line: &str) -> bool {
    shapes_with_body_class().into_iter().any(|(shape, is_body_byte)| {
      let prefix = shape.prefix();
      line.match_indices(&prefix).any(|(start, _)| {
        let follows_a_word = start > 0 && is_word_byte(line.as_bytes()[start - 1]);
        let body_len = line[start + prefix.len()..].bytes().take_while(|byte| is_body_byte(*byte)).count();
        !follows_a_word && body_len >= MIN_BODY_LEN
      })
    })
  }

  fn rust_sources(folder: &Path) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    for entry in std::fs::read_dir(folder).unwrap() {
      let path = entry.unwrap().path();
      if path.is_dir() {
        sources.extend(rust_sources(&path));
      } else if path.extension().is_some_and(|extension| extension == "rs") {
        sources.push(path);
      }
    }
    sources
  }

  fn literal_token_lines_in(root: &Path) -> Vec<String> {
    let mut offenders = Vec::new();
    for path in rust_sources(root) {
      let relative = path.strip_prefix(root).unwrap().to_str().unwrap().to_string();
      if relative == GENERATOR_SOURCE {
        continue;
      }
      for (index, line) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
        if has_literal_token_shape(line) {
          offenders.push(format!("{relative}:{}", index + 1));
        }
      }
    }
    offenders
  }

  #[test]
  fn no_literal_token_shape_in_sources() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");

    assert_eq!(literal_token_lines_in(&root), Vec::<String>::new());
  }

  #[test]
  fn recognises_every_generated_shape_written_out_literally() {
    let generated = [
      github_token(),
      aws_key_id(),
      aws_session_key_id(),
      openai_key(),
      anthropic_key(),
      jwt(20, DEFAULT_SEED),
      token(TokenShape::Gitlab, 20, DEFAULT_SEED),
      token(TokenShape::GithubFineGrained, 40, DEFAULT_SEED),
      token(TokenShape::SlackBot, 24, DEFAULT_SEED),
      token(TokenShape::SlackUser, 24, DEFAULT_SEED),
      token(TokenShape::SlackRefresh, 24, DEFAULT_SEED),
    ];

    for secret in generated {
      assert!(has_literal_token_shape(&format!("let secret = \"{secret}\";")), "missed {secret}");
    }
  }

  #[test]
  fn leaves_a_word_that_merely_contains_a_prefix_and_a_bare_prefix_alone() {
    for line in ["let branch = \"task-12-session-lifecycle-routes\";", "let prefixes = [\"sk-\", \"ghp_\", \"AKIA\"];", "let short = \"sk-1\";"] {
      assert!(!has_literal_token_shape(line), "flagged {line}");
    }
  }

  #[test]
  fn builds_the_same_token_for_the_same_seed_and_another_for_another_seed() {
    assert_eq!(token(TokenShape::Github, 36, 3), token(TokenShape::Github, 36, 3));
    assert_ne!(token(TokenShape::Github, 36, 3), token(TokenShape::Github, 36, 4));
    assert_eq!(github_token().len(), 4 + GITHUB_BODY_LEN);
  }
}
