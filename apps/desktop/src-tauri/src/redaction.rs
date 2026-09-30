//! Masks credentials in a log line. A scanning port of packages/core/src/redact.ts: no regex, so every pass is linear.

pub const MASK: &str = "[redacted]";
// ponytail: a secret shorter than this would redact innocent text; the admin token is far longer.
const MIN_SECRET_LENGTH: usize = 8;
/// A percent-escape is decoded up to three layers deep, like `withEscapesDecoded`.
const ESCAPE_LAYERS_DECODED: usize = 3;
/// A percent-escape may itself be encoded up to four more times (`%2F`, `%252F`, …).
const ESCAPE_PREFIX_LAYERS: usize = 4;
const NESTED_DECODINGS_CHECKED: usize = 4;
const SECRET_KEY_WORDS: [&str; 9] = ["token", "secret", "authorization", "password", "cookie", "ticket", "apikey", "api_key", "api-key"];
const ESCAPED_SEPARATORS: &[u8] = b" :=\t";

type Replacement = Option<(usize, String)>;

/// Returns the line with every known secret, bearer token, basic credential, URL credential, secret query value and hook token masked.
pub fn redact(line: &str, secrets: &[String]) -> String {
  let usable_secrets = secrets.iter().filter(|secret| secret.len() >= MIN_SECRET_LENGTH);
  let without_secrets = usable_secrets.flat_map(|secret| spellings_of(secret)).fold(line.to_string(), |text, spelling| text.replace(&spelling, MASK));
  masked_at_depth(&without_secrets, 0)
}

/// The secret as written plainly, with its reserved characters escaped, and with every character escaped, in both hex cases.
fn spellings_of(secret: &str) -> Vec<String> {
  let escaped = |everything: bool, lowercase: bool| {
    secret.bytes().fold(String::with_capacity(secret.len() * 3), |mut spelling, byte| {
      let is_unreserved = byte.is_ascii_alphanumeric() || b"-._~".contains(&byte);
      match (is_unreserved && !everything, lowercase) {
        (true, _) => spelling.push(byte as char),
        (false, true) => spelling.push_str(&format!("%{byte:02x}")),
        (false, false) => spelling.push_str(&format!("%{byte:02X}")),
      }
      spelling
    })
  };
  vec![secret.to_string(), escaped(false, false), escaped(false, true), escaped(true, false), escaped(true, true)]
}

fn masked_at_depth(text: &str, depth: usize) -> String {
  let without_bearer_tokens = replacing_matches(text, bearer_token_at);
  let without_authorized_basic = replacing_matches(&without_bearer_tokens, authorized_basic_credential_at);
  let without_basic = replacing_matches(&without_authorized_basic, basic_credential_at);
  let without_url_credentials = replacing_matches(&without_basic, url_credentials_at);
  let without_secret_parameters = replacing_matches(&without_url_credentials, |text, index| query_parameter_at(text, index, depth));
  replacing_matches(&without_secret_parameters, hook_token_at)
}

/// Rebuilds the text, replacing each match `replacement_at` finds with the text it returns; a match never overlaps the previous one.
fn replacing_matches(text: &str, replacement_at: impl Fn(&str, usize) -> Replacement) -> String {
  let mut rebuilt = String::with_capacity(text.len());
  let mut copied_up_to = 0;
  let mut index = 0;
  while index < text.len() {
    if let Some((end, replacement)) = replacement_at(text, index) {
      rebuilt.push_str(&text[copied_up_to..index]);
      rebuilt.push_str(&replacement);
      copied_up_to = end;
      index = end;
      continue;
    }
    index += 1;
    while !text.is_char_boundary(index) {
      index += 1;
    }
  }
  rebuilt.push_str(&text[copied_up_to..]);
  rebuilt
}

fn is_word_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || byte == b'_'
}

fn follows_a_word_boundary(bytes: &[u8], index: usize) -> bool {
  index == 0 || !is_word_byte(bytes[index - 1])
}

fn hex_value(byte: u8) -> Option<u8> {
  char::from(byte).to_digit(16).map(|digit| digit as u8)
}

/// Returns the byte at `index`, written literally or as a percent-escape (`%2F`, `%252F`, …), and where it ends.
fn unit_at(bytes: &[u8], index: usize) -> Option<(u8, usize)> {
  let first = *bytes.get(index)?;
  if first != b'%' {
    return Some((first, index + 1));
  }
  let mut cursor = index + 1;
  let mut layers = 0;
  while layers < ESCAPE_PREFIX_LAYERS && bytes[cursor..].starts_with(b"25") {
    cursor += 2;
    layers += 1;
  }
  let high = hex_value(*bytes.get(cursor)?)?;
  let low = hex_value(*bytes.get(cursor + 1)?)?;
  Some((high * 16 + low, cursor + 2))
}

/// Returns where `word` ends when it starts at `start`, any of its letters written in any case or as an escape.
fn word_end(bytes: &[u8], start: usize, word: &str) -> Option<usize> {
  word.bytes().try_fold(start, |cursor, expected| {
    let (found, next) = unit_at(bytes, cursor)?;
    found.eq_ignore_ascii_case(&expected).then_some(next)
  })
}

fn space_len_at(text: &str, index: usize) -> usize {
  let next = text.get(index..).and_then(|rest| rest.chars().next());
  next.filter(|character| character.is_whitespace() || *character == '\u{feff}').map_or(0, char::len_utf8)
}

fn skip_spaces(text: &str, from: usize) -> usize {
  let mut cursor = from;
  while space_len_at(text, cursor) > 0 {
    cursor += space_len_at(text, cursor);
  }
  cursor
}

// ---- Bearer ----

fn is_bearer_token_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || b"._~+/=%-".contains(&byte)
}

fn bearer_separator_len_at(text: &str, index: usize) -> usize {
  let space = space_len_at(text, index);
  if space > 0 {
    return space;
  }
  match text.as_bytes().get(index) {
    Some(b':' | b'=') => 1,
    Some(b'%') => unit_at(text.as_bytes(), index).filter(|(byte, _)| ESCAPED_SEPARATORS.contains(byte)).map_or(0, |(_, end)| end - index),
    _ => 0,
  }
}

fn bearer_token_at(text: &str, index: usize) -> Replacement {
  let bytes = text.as_bytes();
  let marker_end = word_end(bytes, index, "bearer")?;
  let mut token_start = marker_end;
  while bearer_separator_len_at(text, token_start) > 0 {
    token_start += bearer_separator_len_at(text, token_start);
  }
  let has_separator = token_start > marker_end;
  if !has_separator {
    return None;
  }
  let token_length = bytes[token_start..].iter().take_while(|byte| is_bearer_token_byte(**byte)).count();
  (token_length > 0).then(|| (token_start + token_length, format!("{} {MASK}", &text[index..marker_end])))
}

// ---- Basic ----

fn is_base64_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/'
}

fn basic_credential_at(text: &str, index: usize) -> Replacement {
  let bytes = text.as_bytes();
  let is_the_word_basic = bytes[index..].starts_with(b"Basic") && follows_a_word_boundary(bytes, index);
  if !is_the_word_basic {
    return None;
  }
  let after_word = index + "Basic".len();
  let credential_start = skip_spaces(text, after_word);
  let has_space = credential_start > after_word;
  if !has_space {
    return None;
  }
  let run_length = bytes[credential_start..].iter().take_while(|byte| is_base64_byte(**byte)).count();
  let run_end = credential_start + run_length;
  let run = &bytes[credential_start..run_end];
  let looks_encoded = run.iter().any(|byte| byte.is_ascii_digit() || *byte == b'+' || *byte == b'/') || bytes.get(run_end) == Some(&b'=');
  if !(run_length >= 8 && looks_encoded) {
    return None;
  }
  let padding = bytes[run_end..].iter().take(2).take_while(|byte| **byte == b'=').count();
  Some((run_end + padding, format!("Basic {MASK}")))
}

/// Behind an Authorization header the word Basic introduces a credential whatever characters it holds.
fn authorized_basic_credential_at(text: &str, index: usize) -> Replacement {
  const HEADER: &str = "authorization";
  let bytes = text.as_bytes();
  let is_the_header = bytes.get(index..index + HEADER.len()).is_some_and(|word| word.eq_ignore_ascii_case(HEADER.as_bytes())) && follows_a_word_boundary(bytes, index);
  if !is_the_header {
    return None;
  }
  let before_assignment = skip_spaces(text, index + HEADER.len());
  let is_assignment = matches!(bytes.get(before_assignment), Some(b':' | b'='));
  let scheme_start = skip_spaces(text, before_assignment + 1);
  let scheme_end = scheme_start + "basic".len();
  let is_basic_scheme = bytes.get(scheme_start..scheme_end).is_some_and(|word| word.eq_ignore_ascii_case(b"basic"));
  if !(is_assignment && is_basic_scheme) {
    return None;
  }
  let credential_start = skip_spaces(text, scheme_end);
  let ends_the_credential = |character: char| character.is_whitespace() || character == '\u{feff}' || "\"'`&;".contains(character);
  let credential_length = text[credential_start..].find(ends_the_credential).unwrap_or(text.len() - credential_start);
  let has_space = credential_start > scheme_end;
  (has_space && credential_length > 0).then(|| (credential_start + credential_length, format!("{}Basic {MASK}", &text[index..scheme_start])))
}

// ---- URL credentials ----

/// Masks `user:pass` between `://` and the `@`; the scan stops at the next `/`, so runs never overlap.
fn url_credentials_at(text: &str, index: usize) -> Replacement {
  if !text.as_bytes()[index..].starts_with(b"://") {
    return None;
  }
  let credentials_start = index + "://".len();
  let ends_the_credentials = |character: char| character.is_whitespace() || character == '\u{feff}' || "/@\"'`".contains(character);
  let credentials_length = text[credentials_start..].find(ends_the_credentials).unwrap_or(text.len() - credentials_start);
  let at_sign = credentials_start + credentials_length;
  let is_followed_by_an_at_sign = text.as_bytes().get(at_sign) == Some(&b'@');
  (credentials_length > 0 && is_followed_by_an_at_sign).then(|| (at_sign + 1, format!("://{MASK}@")))
}

// ---- secret-named parameters ----

fn is_a_parameter_delimiter(text: &str, index: usize) -> bool {
  space_len_at(text, index) > 0 || matches!(text.as_bytes().get(index), Some(b'?' | b'&' | b';'))
}

fn ends_a_parameter_key(character: char) -> bool {
  character.is_whitespace() || character == '\u{feff}' || "=&?;\"'`#".contains(character)
}

fn ends_a_parameter_value(character: char) -> bool {
  character.is_whitespace() || character == '\u{feff}' || "&;\"'`".contains(character)
}

/// Matches `(^|[?&;\s])key=value` starting at `index`, the start of the text or one delimiter character.
fn query_parameter_at(text: &str, index: usize, depth: usize) -> Replacement {
  let at_the_start = if index == 0 { parameter_from(text, 0, 0, depth) } else { None };
  at_the_start.or_else(|| {
    let delimiter_length = if is_a_parameter_delimiter(text, index) { text[index..].chars().next().map_or(0, char::len_utf8) } else { 0 };
    (delimiter_length > 0).then(|| parameter_from(text, index, index + delimiter_length, depth)).flatten()
  })
}

fn parameter_from(text: &str, match_start: usize, key_start: usize, depth: usize) -> Replacement {
  let key_length = text[key_start..].find(ends_a_parameter_key).unwrap_or(text.len() - key_start);
  let key_end = key_start + key_length;
  if text.as_bytes().get(key_end) != Some(&b'=') {
    return None;
  }
  let value_start = key_end + 1;
  let value_length = text[value_start..].find(ends_a_parameter_value).unwrap_or(text.len() - value_start);
  let value_end = value_start + value_length;
  let key = &text[key_start..key_end];
  let value = &text[value_start..value_end];
  let is_secret_parameter = is_secret_key(key) || hides_secret_behind_escapes(value, depth);
  let replacement = if is_secret_parameter { format!("{}{key}={MASK}", &text[match_start..key_start]) } else { text[match_start..value_end].to_string() };
  Some((value_end, replacement))
}

fn is_secret_key(key: &str) -> bool {
  let decoded_key = with_escapes_decoded(key.as_bytes()).to_ascii_lowercase();
  SECRET_KEY_WORDS.iter().any(|word| decoded_key.windows(word.len()).any(|window| window == word.as_bytes()))
}

fn with_one_layer_decoded(bytes: &[u8]) -> Vec<u8> {
  let mut decoded = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    let escape = if bytes[index] == b'%' && index + 2 < bytes.len() { hex_value(bytes[index + 1]).zip(hex_value(bytes[index + 2])) } else { None };
    match escape {
      Some((high, low)) => {
        decoded.push(high * 16 + low);
        index += 3;
      }
      None => {
        decoded.push(bytes[index]);
        index += 1;
      }
    }
  }
  decoded
}

/// Decodes every well-formed percent-escape, up to three layers deep; a malformed one stays as it is.
fn with_escapes_decoded(bytes: &[u8]) -> Vec<u8> {
  let mut decoded = bytes.to_vec();
  for _ in 0..ESCAPE_LAYERS_DECODED {
    let next = with_one_layer_decoded(&decoded);
    if next == decoded {
      break;
    }
    decoded = next;
  }
  decoded
}

/// A value that decodes to a URL or header carrying a secret (`next=%2Fx%3Ftoken%3D…`) hides that secret behind its escapes.
fn hides_secret_behind_escapes(value: &str, depth: usize) -> bool {
  let decoded = with_escapes_decoded(value.as_bytes());
  if decoded == value.as_bytes() {
    return false;
  }
  let is_nested_too_deep_to_check = depth >= NESTED_DECODINGS_CHECKED;
  if is_nested_too_deep_to_check {
    return true;
  }
  let decoded_text = String::from_utf8_lossy(&decoded);
  masked_at_depth(&decoded_text, depth + 1).as_str() != &*decoded_text
}

// ---- hook tokens ----

fn slash_end(bytes: &[u8], index: usize) -> Option<usize> {
  unit_at(bytes, index).filter(|(byte, _)| *byte == b'/').map(|(_, end)| end)
}

/// `/hooks/:token` is the route pattern, not a secret.
fn is_the_route_pattern(rest: &str) -> bool {
  let bytes = rest.as_bytes();
  let names_the_placeholder = bytes.get(..":token".len()).is_some_and(|word| word.eq_ignore_ascii_case(b":token"));
  let placeholder_ends_there = bytes.get(":token".len()).map_or(true, |byte| !is_word_byte(*byte) && *byte != b'-');
  names_the_placeholder && placeholder_ends_there
}

fn hook_token_at(text: &str, index: usize) -> Replacement {
  let bytes = text.as_bytes();
  let word_start = slash_end(bytes, index)?;
  let token_start = slash_end(bytes, word_end(bytes, word_start, "hooks")?)?;
  let rest = &text[token_start..];
  let ends_the_token = |character: char| character.is_whitespace() || character == '\u{feff}' || "/\"'`&".contains(character);
  let token_length = rest.find(ends_the_token).unwrap_or(rest.len());
  (token_length > 0 && !is_the_route_pattern(rest)).then(|| (token_start + token_length, format!("/hooks/{MASK}")))
}
