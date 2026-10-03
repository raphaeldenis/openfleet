//! Masks credentials in a log line. A scanning port of packages/core/src/redact.ts: no regex, so every pass is linear.

pub const MASK: &str = "[redacted]";
// ponytail: a secret shorter than this would redact innocent text; the admin token is far longer.
const MIN_SECRET_LENGTH: usize = 8;
/// A percent-escape is decoded up to three layers deep, like `withEscapesDecoded`.
const ESCAPE_LAYERS_DECODED: usize = 3;
/// A percent-escape may itself be encoded up to four more times (`%2F`, `%252F`, …).
const ESCAPE_PREFIX_LAYERS: usize = 4;
const NESTED_DECODINGS_CHECKED: usize = 4;
/// A plain parameter value may nest up to this many `?` or `#` before the whole value is masked.
const NESTED_PARAMETERS_CHECKED: usize = 4;
const MASKING_PASSES_UNTIL_SETTLED: usize = 4;
/// A quoted value after a secret-named key is masked up to its closing quote, the end of its line or this many bytes.
const QUOTED_VALUE_LIMIT: usize = 16 * 1024;
/// A shorter unquoted value is a word of the sentence (`the token: is expired`), not a credential.
const UNQUOTED_VALUE_MINIMUM_LENGTH: usize = 4;
const LITERALS_THAT_HOLD_NO_SECRET: [&str; 4] = ["null", "true", "false", "undefined"];
const AUTHORIZATION_SCHEMES: [&str; 2] = ["bearer", "basic"];
const SECRET_KEY_WORDS: [&str; 9] = ["token", "secret", "authorization", "password", "cookie", "ticket", "apikey", "api_key", "api-key"];
const ESCAPED_SEPARATORS: &[u8] = b" :=\t";

type Replacement = Option<(usize, String)>;

/// Returns the line with every known secret, bearer token, basic credential, URL credential, secret query value and hook token masked.
pub fn redact(line: &str, secrets: &[String]) -> String {
  let usable_secrets = secrets.iter().filter(|secret| secret.len() >= MIN_SECRET_LENGTH);
  let without_secrets = usable_secrets.flat_map(|secret| spellings_of(secret)).fold(line.to_string(), |text, spelling| text.replace(&spelling, MASK));
  masked_until_settled(without_secrets)
}

/// A mask can leave text that reads as a new secret to an earlier rule (a hook segment, then `/token=`; `Authorization::=`): passes repeat until the text settles, so masking twice equals masking once.
fn masked_until_settled(text: String) -> String {
  let mut masked = text;
  for _ in 0..MASKING_PASSES_UNTIL_SETTLED {
    let next = masked_at_depth(&masked, 0);
    if next == masked {
      break;
    }
    masked = next;
  }
  masked
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
  let without_well_known_credentials = replacing_matches(text, well_known_credential_at);
  let without_bearer_tokens = replacing_matches(&without_well_known_credentials, bearer_token_at);
  let without_authorized_basic = replacing_matches(&without_bearer_tokens, authorized_basic_credential_at);
  let without_basic = replacing_matches(&without_authorized_basic, basic_credential_at);
  let without_url_credentials = replacing_matches(&without_basic, url_credentials_at);
  let without_hook_tokens = replacing_matches(&without_url_credentials, hook_token_at);
  let without_colon_values = replacing_matches(&without_hook_tokens, colon_value_at);
  let without_cookie_values = replacing_matches(&without_colon_values, cookie_header_at);
  replacing_matches(&without_cookie_values, |text, index| query_parameter_at(text, index, depth))
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

fn skip_bearer_separators(text: &str, from: usize) -> usize {
  let mut cursor = from;
  while bearer_separator_len_at(text, cursor) > 0 {
    cursor += bearer_separator_len_at(text, cursor);
  }
  cursor
}

/// Returns where the token starts: after the first `Bearer` and its separators, and after each repeated `Bearer` + separators that a token follows
/// (otherwise the repeated word is the token, as the backtracking regex settles it).
fn bearer_token_start(text: &str, marker_end: usize) -> Option<usize> {
  let first_token_start = skip_bearer_separators(text, marker_end);
  let has_separator = first_token_start > marker_end;
  if !has_separator {
    return None;
  }
  let mut token_start = first_token_start;
  while let Some(repeated_marker_end) = word_end(text.as_bytes(), token_start, "bearer") {
    let after_repeated_separators = skip_bearer_separators(text, repeated_marker_end);
    let repeated_marker_has_separator = after_repeated_separators > repeated_marker_end;
    let token_follows = text.as_bytes().get(after_repeated_separators).is_some_and(|byte| is_bearer_token_byte(*byte));
    if !(repeated_marker_has_separator && token_follows) {
      break;
    }
    token_start = after_repeated_separators;
  }
  Some(token_start)
}

fn bearer_token_at(text: &str, index: usize) -> Replacement {
  let bytes = text.as_bytes();
  let marker_end = word_end(bytes, index, "bearer")?;
  let token_start = bearer_token_start(text, marker_end)?;
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

/// Masks `user:pass` between `://` and the last `@` before the next `/` (a password may hold a raw `@`, not a raw `/`); runs never overlap.
fn url_credentials_at(text: &str, index: usize) -> Replacement {
  if !text.as_bytes()[index..].starts_with(b"://") {
    return None;
  }
  let authority_start = index + "://".len();
  let ends_the_authority = |character: char| character.is_whitespace() || character == '\u{feff}' || "/\"'`".contains(character);
  let authority_length = text[authority_start..].find(ends_the_authority).unwrap_or(text.len() - authority_start);
  let authority = &text[authority_start..authority_start + authority_length];
  let last_at_sign = authority.rfind('@').filter(|position| *position > 0)?;
  Some((authority_start + last_at_sign + 1, format!("://{MASK}@")))
}

// ---- secret-named parameters ----

fn is_a_parameter_delimiter(text: &str, index: usize) -> bool {
  space_len_at(text, index) > 0 || matches!(text.as_bytes().get(index), Some(b'?' | b'&' | b';' | b'#'))
}

fn starts_a_nested_parameter(character: char) -> bool {
  character == '?' || character == '#'
}

/// A value holding more nested `?` or `#` than the check reaches is masked whole; the bound keeps the rescans of one value linear.
fn nests_more_parameters_than_checked(value: &str) -> bool {
  value.chars().filter(|character| starts_a_nested_parameter(*character)).nth(NESTED_PARAMETERS_CHECKED).is_some()
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
  let is_secret_parameter = is_secret_key(key) || nests_more_parameters_than_checked(value) || hides_secret_behind_escapes(value, depth);
  if is_secret_parameter {
    return Some((value_end, format!("{}{key}={MASK}", &text[match_start..key_start])));
  }
  let kept_value_length = value.find(starts_a_nested_parameter).unwrap_or(value.len());
  let kept_end = value_start + kept_value_length;
  Some((kept_end, text[match_start..kept_end].to_string()))
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

// ---- well-known credential formats (the WELL_KNOWN_CREDENTIAL rule of redact.ts) ----

fn is_url_safe_byte(byte: u8) -> bool {
  is_word_byte(byte) || byte == b'-'
}

fn is_alphanumeric_or_dash_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || byte == b'-'
}

fn is_slack_token_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || byte == b'%' || byte == b'-'
}

fn is_uppercase_or_digit_byte(byte: u8) -> bool {
  byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

fn is_alphanumeric_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric()
}

/// Counts the bytes from `from` on that `accepts` takes.
fn run_length(bytes: &[u8], from: usize, accepts: impl Fn(u8) -> bool) -> usize {
  bytes.get(from..).map_or(0, |rest| rest.iter().take_while(|byte| accepts(**byte)).count())
}

/// A credential that identifies itself by a prefix and a run of tail characters.
struct ProviderFormat {
  prefixes: &'static [&'static str],
  is_tail_byte: fn(u8) -> bool,
  minimum_tail: usize,
  maximum_tail: Option<usize>,
  must_end_at_word_boundary: bool,
  may_end_with_routable_suffix: bool,
}

const fn provider_format(prefixes: &'static [&'static str], is_tail_byte: fn(u8) -> bool, minimum_tail: usize) -> ProviderFormat {
  ProviderFormat { prefixes, is_tail_byte, minimum_tail, maximum_tail: None, must_end_at_word_boundary: false, may_end_with_routable_suffix: false }
}

const PROVIDER_FORMATS: [ProviderFormat; 10] = [
  provider_format(&["sk-"], is_url_safe_byte, 20),
  provider_format(&["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], is_alphanumeric_byte, 36),
  provider_format(&["github_pat_"], is_url_safe_byte, 50),
  ProviderFormat { maximum_tail: Some(16), must_end_at_word_boundary: true, ..provider_format(&["AKIA", "ASIA"], is_uppercase_or_digit_byte, 16) },
  provider_format(&["xapp-"], is_alphanumeric_or_dash_byte, 10),
  provider_format(&["AIza"], is_url_safe_byte, 35),
  ProviderFormat { maximum_tail: Some(36), ..provider_format(&["npm_"], is_alphanumeric_byte, 36) },
  ProviderFormat { may_end_with_routable_suffix: true, ..provider_format(&["glpat-"], is_url_safe_byte, 20) },
  provider_format(&["sk_live_", "rk_live_", "sk_test_", "rk_test_", "whsec_"], is_alphanumeric_byte, 20),
  provider_format(&["hf_"], is_alphanumeric_byte, 30),
];

impl ProviderFormat {
  /// Returns where the credential ends when it starts at `index`.
  fn end_at(&self, bytes: &[u8], index: usize) -> Option<usize> {
    let prefix = self.prefixes.iter().find(|prefix| bytes[index..].starts_with(prefix.as_bytes()))?;
    let tail_start = index + prefix.len();
    let longest_tail = self.maximum_tail.unwrap_or(usize::MAX);
    let tail_length = bytes[tail_start..].iter().take(longest_tail).take_while(|byte| (self.is_tail_byte)(**byte)).count();
    if tail_length < self.minimum_tail {
      return None;
    }
    let tail_end = tail_start + tail_length;
    let runs_into_a_longer_word = self.must_end_at_word_boundary && bytes.get(tail_end).is_some_and(|byte| is_word_byte(*byte));
    if runs_into_a_longer_word {
      return None;
    }
    Some(if self.may_end_with_routable_suffix { tail_end + routable_suffix_length(bytes, tail_end) } else { tail_end })
  }
}

/// A routable GitLab token ends with `.01.` and at least four alphanumeric characters.
fn routable_suffix_length(bytes: &[u8], from: usize) -> usize {
  const MARK: &[u8] = b".01.";
  const MINIMUM_CHECKSUM: usize = 4;
  let has_the_mark = bytes[from..].starts_with(MARK);
  let checksum_length = if has_the_mark { run_length(bytes, from + MARK.len(), is_alphanumeric_byte) } else { 0 };
  if checksum_length >= MINIMUM_CHECKSUM {
    MARK.len() + checksum_length
  } else {
    0
  }
}

/// `xoxe.` fronts a Slack configuration token (`xoxe.xoxp-…`); `%` spells the escapes of an `xoxd-` cookie.
fn slack_token_end(bytes: &[u8], index: usize) -> Option<usize> {
  const CONFIGURATION_PREFIX: &[u8] = b"xoxe.";
  const MINIMUM_TAIL: usize = 10;
  let body_after_the_prefix = bytes[index..].starts_with(CONFIGURATION_PREFIX).then_some(index + CONFIGURATION_PREFIX.len());
  let body_end = |start: usize| {
    let body = &bytes[start..];
    let has_a_slack_prefix = body.starts_with(b"xox") && body.get(3).is_some_and(|kind| b"abcdeprs".contains(kind)) && body.get(4) == Some(&b'-');
    let tail_length = if has_a_slack_prefix { run_length(bytes, start + 5, is_slack_token_byte) } else { 0 };
    (tail_length >= MINIMUM_TAIL).then_some(start + 5 + tail_length)
  };
  body_after_the_prefix.and_then(body_end).or_else(|| body_end(index))
}

/// A JWT: `eyJ<header>.eyJ<payload>` and an optional signature; the header and the payload hold at least five characters after `eyJ`.
fn jwt_end(bytes: &[u8], index: usize) -> Option<usize> {
  const MARK: &[u8] = b"eyJ";
  const PAYLOAD_MARK: &[u8] = b".eyJ";
  const MINIMUM_SEGMENT: usize = 5;
  let follows_a_url_safe_byte = index > 0 && is_url_safe_byte(bytes[index - 1]);
  if follows_a_url_safe_byte || !bytes[index..].starts_with(MARK) {
    return None;
  }
  let header_length = run_length(bytes, index + MARK.len(), is_url_safe_byte);
  let header_end = index + MARK.len() + header_length;
  if header_length < MINIMUM_SEGMENT || !bytes[header_end..].starts_with(PAYLOAD_MARK) {
    return None;
  }
  let payload_start = header_end + PAYLOAD_MARK.len();
  let payload_length = run_length(bytes, payload_start, is_url_safe_byte);
  if payload_length < MINIMUM_SEGMENT {
    return None;
  }
  let payload_end = payload_start + payload_length;
  let has_a_signature_mark = bytes.get(payload_end) == Some(&b'.');
  Some(if has_a_signature_mark { payload_end + 1 + run_length(bytes, payload_end + 1, is_url_safe_byte) } else { payload_end })
}

/// Returns where a PEM label ends (after its closing dashes) when the label starting at `label_start` names a private key.
fn pem_label_end(bytes: &[u8], label_start: usize) -> Option<usize> {
  const CLOSING_DASHES: &[u8] = b"-----";
  let label_length = run_length(bytes, label_start, |byte| byte.is_ascii_uppercase() || byte == b' ');
  let label_end = label_start + label_length;
  let label = &bytes[label_start..label_end];
  let names_a_private_key = label.ends_with(b"PRIVATE KEY") || label.ends_with(b"PRIVATE KEY BLOCK");
  (names_a_private_key && bytes[label_end..].starts_with(CLOSING_DASHES)).then_some(label_end + CLOSING_DASHES.len())
}

/// A PEM private key block, up to its footer or to the end of a cut text.
fn pem_private_key_end(text: &str, index: usize) -> Option<usize> {
  const HEADER: &str = "-----BEGIN ";
  const FOOTER: &str = "-----END ";
  let bytes = text.as_bytes();
  if !bytes[index..].starts_with(HEADER.as_bytes()) {
    return None;
  }
  let header_end = pem_label_end(bytes, index + HEADER.len())?;
  let mut search_from = header_end;
  while let Some(offset) = text[search_from..].find(FOOTER) {
    let footer_start = search_from + offset;
    if let Some(footer_end) = pem_label_end(bytes, footer_start + FOOTER.len()) {
      return Some(footer_end);
    }
    search_from = footer_start + 1;
  }
  Some(text.len())
}

fn well_known_credential_at(text: &str, index: usize) -> Replacement {
  let bytes = text.as_bytes();
  let provider_credential_end = || {
    let starts_a_word = follows_a_word_boundary(bytes, index);
    let end_of_provider_format = || PROVIDER_FORMATS.iter().find_map(|format| format.end_at(bytes, index));
    starts_a_word.then(|| slack_token_end(bytes, index).or_else(end_of_provider_format)).flatten()
  };
  let end = pem_private_key_end(text, index).or_else(|| jwt_end(bytes, index)).or_else(provider_credential_end)?;
  Some((end, MASK.to_string()))
}

// ---- JSON and colon forms under a secret-named key ----

struct ColonValue {
  start: usize,
  end: usize,
  is_credential: bool,
}

fn is_a_space(character: char) -> bool {
  character.is_whitespace() || character == '\u{feff}'
}

fn is_key_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

fn is_padding_byte(byte: u8) -> bool {
  matches!(byte, b' ' | b'\t')
}

fn ends_an_unquoted_value(character: char) -> bool {
  is_a_space(character) || "\"'`,;&{}[]".contains(character)
}

fn is_a_plain_number(value: &str) -> bool {
  let unsigned = value.strip_prefix('-').unwrap_or(value);
  let (whole, fraction) = unsigned.split_once('.').map_or((unsigned, None), |(whole, fraction)| (whole, Some(fraction)));
  let is_digits = |digits: &str| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit());
  is_digits(whole) && fraction.map_or(true, is_digits)
}

/// The header names the cookie rule matches: `Cookie`, `Set-Cookie`, `X-Cookie`, … but not `mycookie`.
fn is_a_cookie_header_name(key: &str) -> bool {
  const COOKIE: &str = "cookie";
  let lowercase_key = key.to_ascii_lowercase();
  let Some(before_the_word) = lowercase_key.strip_suffix(COOKIE) else {
    return false;
  };
  before_the_word.bytes().last().map_or(true, |byte| !is_word_byte(byte))
}

fn is_authorization_scheme_before_mask(value: &str, text: &str, value_end: usize) -> bool {
  let is_a_scheme = AUTHORIZATION_SCHEMES.contains(&value.to_ascii_lowercase().as_str());
  is_a_scheme && text[value_end..].trim_start_matches([' ', '\t']).starts_with(MASK)
}

fn looks_like_a_credential(value: &str, text: &str, value_end: usize) -> bool {
  let is_long_enough = value.chars().count() >= UNQUOTED_VALUE_MINIMUM_LENGTH;
  let is_usage_counter_or_literal = is_a_plain_number(value) || LITERALS_THAT_HOLD_NO_SECRET.contains(&value.to_ascii_lowercase().as_str());
  let is_masked_already = value == MASK;
  is_long_enough && !is_masked_already && !is_usage_counter_or_literal && !is_authorization_scheme_before_mask(value, text, value_end)
}

/// Returns where the unquoted value that starts at `start` ends; a mask inside it (`[redacted]`, whose brackets would end it) belongs to the value.
fn unquoted_value_end(text: &str, start: usize) -> usize {
  let mut end = start;
  for (offset, character) in text[start..].char_indices() {
    let position = start + offset;
    let is_inside_a_mask = position < end;
    if is_inside_a_mask {
      continue;
    }
    if text[position..].starts_with(MASK) {
      end = position + MASK.len();
      continue;
    }
    if ends_an_unquoted_value(character) {
      return position;
    }
    end = position + character.len_utf8();
  }
  end
}

fn unquoted_value_from(text: &str, start: usize) -> ColonValue {
  let end = unquoted_value_end(text, start);
  ColonValue { start, end, is_credential: looks_like_a_credential(&text[start..end], text, end) }
}

/// A quoted value ends at its closing quote, the end of the line or the limit; a JSON document escaped inside a string (`\"token\":\"…\"`) ends at the first quote.
fn quoted_value_from(text: &str, content_start: usize, quote: u8, is_opening_quote_escaped: bool) -> ColonValue {
  let bytes = text.as_bytes();
  let mut limit = (content_start + QUOTED_VALUE_LIMIT).min(text.len());
  while !text.is_char_boundary(limit) {
    limit -= 1;
  }
  let mut end = content_start;
  while end < limit {
    let byte = bytes[end];
    if byte == quote || byte == b'\n' || byte == b'\r' {
      break;
    }
    let escapes_the_next_character = byte == b'\\' && !is_opening_quote_escaped;
    end += 1;
    if escapes_the_next_character {
      end += text[end..].chars().next().map_or(0, char::len_utf8);
    }
  }
  let mut content_end = end.min(limit);
  while is_opening_quote_escaped && content_end > content_start && bytes[content_end - 1] == b'\\' {
    content_end -= 1;
  }
  let content = &text[content_start..content_end];
  ColonValue { start: content_start, end: content_end, is_credential: !content.is_empty() && content != MASK }
}

/// The value after `key": ` or `key: `, or None when no colon follows the key; a cookie header's unquoted value belongs to the cookie rule.
fn colon_value_after(text: &str, key_end: usize, key: &str) -> Option<ColonValue> {
  let bytes = text.as_bytes();
  let after_closing_quote = key_end + run_length(bytes, key_end, |byte| matches!(byte, b'"' | b'\'' | b'\\'));
  let colon_at = after_closing_quote + run_length(bytes, after_closing_quote, is_padding_byte);
  if bytes.get(colon_at) != Some(&b':') {
    return None;
  }
  let value_start = colon_at + 1 + run_length(bytes, colon_at + 1, is_padding_byte);
  let quote_at = value_start + run_length(bytes, value_start, |byte| byte == b'\\');
  let is_opening_quote_escaped = quote_at > value_start;
  if let Some(quote) = bytes.get(quote_at).copied().filter(|byte| matches!(byte, b'"' | b'\'')) {
    return Some(quoted_value_from(text, quote_at + 1, quote, is_opening_quote_escaped));
  }
  if is_opening_quote_escaped || is_a_cookie_header_name(key) {
    return None;
  }
  Some(unquoted_value_from(text, value_start))
}

/// Masks the value that follows a secret-named key with a colon (`{"token":"…"}`, `password: …`); a match starts at the first byte of a run of key characters.
fn colon_value_at(text: &str, index: usize) -> Replacement {
  let bytes = text.as_bytes();
  let starts_a_key_run = is_key_byte(bytes[index]) && (index == 0 || !is_key_byte(bytes[index - 1]));
  if !starts_a_key_run {
    return None;
  }
  let key_end = index + run_length(bytes, index, is_key_byte);
  let key = &text[index..key_end];
  if !is_secret_key(key) {
    return None;
  }
  let value = colon_value_after(text, key_end, key)?;
  value.is_credential.then(|| (value.end, format!("{}{MASK}", &text[index..value.start])))
}

// ---- Cookie and Set-Cookie headers ----

fn is_a_cookie_quote(character: char) -> bool {
  "\"'`".contains(character)
}

fn is_a_cookie_name_character(character: char) -> bool {
  !(character == '=' || character == ';' || is_a_space(character) || is_a_cookie_quote(character))
}

fn ends_a_cookie_value(character: char) -> bool {
  character == ';' || is_a_space(character) || is_a_cookie_quote(character)
}

/// Masks the value of every `name=value` pair (`Cookie`), or of the first one only (`Set-Cookie`, whose attributes stay readable).
fn masked_cookie_pairs(pairs: &str, first_pair_only: bool) -> String {
  let mut masked = String::with_capacity(pairs.len());
  let mut copied_up_to = 0;
  let mut cursor = 0;
  while cursor < pairs.len() {
    let name_length = pairs[cursor..].find(|character| !is_a_cookie_name_character(character)).unwrap_or(pairs.len() - cursor);
    if name_length == 0 {
      if first_pair_only {
        break;
      }
      cursor += pairs[cursor..].chars().next().map_or(1, char::len_utf8);
      continue;
    }
    let name_end = cursor + name_length;
    let value_start = name_end + 1;
    let has_a_value_mark = pairs.as_bytes().get(name_end) == Some(&b'=');
    let value_length = if has_a_value_mark { pairs[value_start..].find(ends_a_cookie_value).unwrap_or(pairs.len() - value_start) } else { 0 };
    if value_length > 0 {
      masked.push_str(&pairs[copied_up_to..value_start]);
      masked.push_str(MASK);
      copied_up_to = value_start + value_length;
    }
    if first_pair_only {
      break;
    }
    cursor = if value_length > 0 { copied_up_to } else { name_end };
  }
  masked.push_str(&pairs[copied_up_to..]);
  masked
}

fn cookie_header_at(text: &str, index: usize) -> Replacement {
  const SET_COOKIE: &[u8] = b"set-cookie";
  const COOKIE: &[u8] = b"cookie";
  let bytes = text.as_bytes();
  if !follows_a_word_boundary(bytes, index) {
    return None;
  }
  let starts_with_word = |word: &[u8]| bytes.get(index..index + word.len()).is_some_and(|candidate| candidate.eq_ignore_ascii_case(word));
  let is_set_cookie = starts_with_word(SET_COOKIE);
  let name_length = if is_set_cookie { SET_COOKIE.len() } else if starts_with_word(COOKIE) { COOKIE.len() } else { return None };
  let colon_at = index + name_length + run_length(bytes, index + name_length, is_padding_byte);
  if bytes.get(colon_at) != Some(&b':') {
    return None;
  }
  let pairs_start = colon_at + 1 + run_length(bytes, colon_at + 1, is_padding_byte);
  let pairs_length = text[pairs_start..].find(['\r', '\n']).unwrap_or(text.len() - pairs_start);
  let pairs_end = pairs_start + pairs_length;
  let masked_pairs = masked_cookie_pairs(&text[pairs_start..pairs_end], is_set_cookie);
  Some((pairs_end, format!("{}{masked_pairs}", &text[index..pairs_start])))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{Duration, Instant};

  fn masked(text: &str) -> String {
    redact(text, &[])
  }

  fn alphanumeric(length: usize) -> String {
    "aB3".repeat(length / 3 + 1)[..length].to_string()
  }

  fn assert_masked_exactly_from(credential_prefix: &str, tail_character: char, minimum_tail: usize) {
    let tail_of = |length: usize| tail_character.to_string().repeat(length);
    let too_short = format!("use {credential_prefix}{} now", tail_of(minimum_tail - 1));
    let long_enough = format!("use {credential_prefix}{} now", tail_of(minimum_tail));

    assert_eq!(masked(&too_short), too_short, "{credential_prefix} with {} characters", minimum_tail - 1);
    assert_eq!(masked(&long_enough), "use [redacted] now", "{credential_prefix} with {minimum_tail} characters");
  }

  // ---- provider formats (parity with WELL_KNOWN_CREDENTIAL in packages/core/src/redact.ts) ----

  fn the_twenty_nine_provider_credentials() -> Vec<String> {
    let after = |prefix: &str, body: String| format!("{prefix}{body}");
    let mut credentials = vec![after("sk-", alphanumeric(30))];
    credentials.extend(["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map(|prefix| after(prefix, alphanumeric(36))));
    credentials.push(after("github_pat_", "aB3_".repeat(15)));
    credentials.extend(["AKIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE", "eyJabcdef.eyJabcdef.abcdef"].map(str::to_string));
    credentials.extend(["xoxb-", "xoxp-", "xoxc-", "xoxd-", "xoxe-", "xoxa-", "xoxr-", "xoxs-", "xapp-", "xoxe.xoxp-"].map(|prefix| after(prefix, alphanumeric(30))));
    credentials.push(after("AIza", "Ab3_-".repeat(8)));
    credentials.push(after("npm_", alphanumeric(36)));
    credentials.push(format!("glpat-{}.01.abcd", alphanumeric(24)));
    credentials.extend(["sk_live_", "rk_live_", "sk_test_", "rk_test_", "whsec_", "hf_"].map(|prefix| after(prefix, alphanumeric(36))));
    credentials
  }

  #[test]
  fn masks_each_of_the_twenty_nine_provider_credentials_like_the_ts_masker() {
    let credentials = the_twenty_nine_provider_credentials();

    let leaking: Vec<&String> = credentials.iter().filter(|credential| masked(&format!("use {credential} now")) != "use [redacted] now").collect();

    assert_eq!(credentials.len(), 29);
    assert_eq!(leaking, Vec::<&String>::new());
  }

  #[test]
  fn masks_a_pem_private_key_block_from_its_header_to_its_footer() {
    for label in ["RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "PGP PRIVATE KEY BLOCK", "PRIVATE KEY", "EC PRIVATE KEY"] {
      let pem = format!("before -----BEGIN {label}-----\nQUJDREVGR0g=\n-----END {label}----- after");

      assert_eq!(masked(&pem), "before [redacted] after", "{label}");
    }
  }

  #[test]
  fn masks_a_pem_header_whose_footer_the_text_was_cut_before() {
    assert_eq!(masked("x -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq"), "x [redacted]");
    assert_eq!(masked("x -----BEGIN PRIVATE KEY-----\n-----END CERTIFICATE-----\nmore"), "x [redacted]");
  }

  #[test]
  fn leaves_a_certificate_and_a_public_key_alone() {
    for pem in ["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"] {
      assert_eq!(masked(pem), pem);
    }
  }

  #[test]
  fn leaves_the_words_that_only_look_like_a_credential_prefix_alone() {
    for plain in [
      "ask about sk-1, the ghp_ prefix, AKIA alone and eyJ fragments",
      "AKIAIOSFODNN7EXAMPLEXTRA",
      "AKIAIOSFODNN7EXAMPLEx",
      "x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
      "the task-list and risk-register, a chf_ value, whsec alone, hf_transfer_enabled and a sk_testing run",
      "hf_abcdef is not a token",
      "whsec_short is not a secret",
      "header eyJhbGciOiJIUzI1NiJ9 only",
    ] {
      assert_eq!(masked(plain), plain);
    }
  }

  #[test]
  fn masks_a_provider_credential_from_its_minimum_length_and_not_before() {
    assert_masked_exactly_from("sk-", 'a', 20);
    assert_masked_exactly_from("sk-proj-", 'a', 15);
    assert_masked_exactly_from("ghp_", 'a', 36);
    assert_masked_exactly_from("ghs_", 'a', 36);
    assert_masked_exactly_from("github_pat_", 'a', 50);
    assert_masked_exactly_from("xoxb-", 'a', 10);
    assert_masked_exactly_from("xoxd-", '%', 10);
    assert_masked_exactly_from("xoxe.xoxp-", 'a', 10);
    assert_masked_exactly_from("xapp-", 'a', 10);
    assert_masked_exactly_from("AIza", 'a', 35);
    assert_masked_exactly_from("npm_", 'a', 36);
    assert_masked_exactly_from("glpat-", 'a', 20);
    assert_masked_exactly_from("sk_live_", 'a', 20);
    assert_masked_exactly_from("rk_test_", 'a', 20);
    assert_masked_exactly_from("whsec_", 'a', 20);
    assert_masked_exactly_from("hf_", 'a', 30);
  }

  #[test]
  fn masks_an_aws_key_id_of_exactly_sixteen_characters_after_its_prefix() {
    assert_masked_exactly_from("AKIA", 'A', 16);
    assert_masked_exactly_from("ASIA", '7', 16);
    assert_eq!(masked(&format!("use AKIA{} now", "A".repeat(17))), format!("use AKIA{} now", "A".repeat(17)));
  }

  #[test]
  fn masks_the_first_thirty_six_characters_of_a_longer_npm_token() {
    assert_eq!(masked(&format!("npm_{}", "a".repeat(40))), "[redacted]aaaa");
  }

  #[test]
  fn masks_a_routable_gitlab_token_with_its_suffix_and_keeps_a_short_one() {
    let body = "a".repeat(24);

    assert_eq!(masked(&format!("use glpat-{body}.01.abcd now")), "use [redacted] now");
    assert_eq!(masked(&format!("use glpat-{body}.01.abc now")), "use [redacted].01.abc now");
  }

  #[test]
  fn masks_a_credential_only_when_a_word_boundary_precedes_it() {
    let key = format!("sk-{}", "a".repeat(30));

    assert_eq!(masked(&format!("_{key}")), format!("_{key}"));
    assert_eq!(masked(&format!("x{key}")), format!("x{key}"));
    assert_eq!(masked(&format!("={key}")), "=[redacted]");
    assert_eq!(masked(&format!("é{key}")), "é[redacted]");
  }

  #[test]
  fn masks_a_jwt_whose_signature_is_missing_empty_or_short() {
    let header = "eyJhbGciOiJIUzI1NiJ9";
    let payload = "eyJzdWIiOiIxMjM0NTY3ODkw";

    for jwt in [format!("{header}.{payload}"), format!("{header}.{payload}."), format!("{header}.{payload}.ab"), format!("{header}.{payload}.{}", "s".repeat(43))] {
      assert_eq!(masked(&format!("use {jwt} now")), "use [redacted] now", "{jwt}");
    }
  }

  #[test]
  fn masks_an_incomplete_jwt_tail_whatever_the_length_of_its_payload() {
    let header = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9";

    for payload_length in [100, 508, 512, 600, 5000, 5100, 100_000] {
      let head = format!("Fix CI {header}.eyJ{}", "a".repeat(payload_length));

      assert_eq!(masked(&head), "Fix CI [redacted]", "payload of {payload_length} characters");
    }
  }

  #[test]
  fn masks_a_provider_key_nested_under_a_parameter_with_its_characters_percent_encoded() {
    let encoded_github_token = format!("%67hp_{}", alphanumeric(36));
    let encoded_openai_key = format!("%73k-{}", alphanumeric(30));

    assert_eq!(masked(&format!("GET /cb?next={encoded_github_token}&page=2")), "GET /cb?next=[redacted]&page=2");
    assert_eq!(masked(&format!("GET /cb?next={encoded_openai_key}")), "GET /cb?next=[redacted]");
  }

  #[test]
  fn masks_a_provider_key_written_plainly_under_a_plain_parameter() {
    assert_eq!(masked(&format!("GET /cb?next=sk-{}&page=2", alphanumeric(30))), "GET /cb?next=[redacted]&page=2");
  }

  // ---- the next-line character (U+0085) is a separator in both implementations ----

  #[test]
  fn treats_the_next_line_character_as_a_separator_after_bearer_and_between_parameters() {
    assert_eq!(masked("Bearer\u{85}SYNTHETIC_SECRET_123"), "Bearer [redacted]");
    assert_eq!(masked("a=x\u{85}token=SECRETVAL1"), "a=x\u{85}token=[redacted]");
  }

  #[test]
  fn ends_a_url_authority_and_a_hook_token_at_the_next_line_character() {
    assert_eq!(masked("https://u:p\u{85}x@host/"), "https://u:p\u{85}x@host/");
    assert_eq!(masked("/hooks/tok123\u{85}keep"), "/hooks/[redacted]\u{85}keep");
  }

  // ---- JSON and colon forms under a secret-named key ----

  #[test]
  fn masks_the_json_and_colon_forms_under_a_secret_named_key() {
    let cases = [
      (r#"{"token":"SYNTHETIC_SECRET_123"}"#, r#"{"token":"[redacted]"}"#),
      (r#"{"password": "SYNTHETIC_SECRET_123", "user": "ada"}"#, r#"{"password": "[redacted]", "user": "ada"}"#),
      ("{'api_key': 'SYNTHETIC_SECRET_123'}", "{'api_key': '[redacted]'}"),
      (r#"{"token":"SYNTHETIC\"SECRET_123"}"#, r#"{"token":"[redacted]"}"#),
      (r#"{"body":"{\"token\":\"SYNTHETIC_SECRET_123\"}"}"#, r#"{"body":"{\"token\":\"[redacted]\"}"}"#),
      (r#"{"token":"SYNTHETIC_SECRET_123"#, r#"{"token":"[redacted]"#),
      ("token: SYNTHETIC_SECRET_123", "token: [redacted]"),
      ("login failed, password: SYNTHETIC_SECRET_123 rejected", "login failed, password: [redacted] rejected"),
      ("AWS_SECRET_ACCESS_KEY: SYNTHETIC_SECRET_123", "AWS_SECRET_ACCESS_KEY: [redacted]"),
      ("api_key: SYNTHETIC_SECRET_123", "api_key: [redacted]"),
      ("X-Api-Key: SYNTHETIC_SECRET_123", "X-Api-Key: [redacted]"),
      ("client_secret: SYNTHETIC_SECRET_123\nretries: 3", "client_secret: [redacted]\nretries: 3"),
      ("token: SYNTHETIC_SECRET_123, retry in 5s", "token: [redacted], retry in 5s"),
      ("token:SYNTHETIC_SECRET_123", "token:[redacted]"),
      ("{\"token\":\"SYNTHETIC_SECRET_123\nnext line", "{\"token\":\"[redacted]\nnext line"),
      ("token: SYNTHETIC_SECRET_123&page=2", "token: [redacted]&page=2"),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text}");
    }
  }

  #[test]
  fn leaves_the_colon_forms_that_hold_no_credential_alone() {
    for plain in [
      "the token: is expired",
      "tokens: 450000",
      r#"{"max_tokens": 4096}"#,
      r#"{"token": null}"#,
      r#"{"hasToken": true}"#,
      r#"{"token":""}"#,
      "Enter your password:",
      "host: localhost:7331 at 12:30:45",
      "password: [redacted]",
      r#"{"token":"[redacted]"}"#,
      "Authorization: Bearer [redacted]",
      "Cookie banner accepted",
    ] {
      assert_eq!(masked(plain), plain);
    }
  }

  #[test]
  fn masks_only_the_bounded_start_of_a_quoted_value_that_never_closes() {
    let endless = format!("{{\"token\":\"{}", "a".repeat(40_000));

    let result = masked(&endless);

    assert!(result.starts_with("{\"token\":\"[redacted]"));
    assert!(result.len() < endless.len());
  }

  #[test]
  fn cuts_a_long_quoted_value_on_a_character_boundary() {
    for filler in ["é", "日", "😀", "\\é", "\\😀"] {
      let endless = format!("{{\"token\":\"{}", filler.repeat(20_000));

      let result = masked(&endless);

      assert!(result.starts_with("{\"token\":\"[redacted]"), "{filler}");
    }
  }

  // ---- Cookie and Set-Cookie headers ----

  #[test]
  fn masks_the_value_of_every_cookie_and_keeps_the_attributes_of_a_set_cookie_header() {
    let cases = [
      ("Cookie: session=SYNTHETIC_SECRET_123", "Cookie: session=[redacted]"),
      ("Cookie: a=SECRETVAL1; b=SECRETVAL2; c=SECRETVAL3", "Cookie: a=[redacted]; b=[redacted]; c=[redacted]"),
      ("Set-Cookie: session=SYNTHETIC_SECRET_123; HttpOnly", "Set-Cookie: session=[redacted]; HttpOnly"),
      ("Set-Cookie: sid=SECRETVAL1; Path=/; Max-Age=3600; Secure; SameSite=Lax", "Set-Cookie: sid=[redacted]; Path=/; Max-Age=3600; Secure; SameSite=Lax"),
      ("set-cookie: id=SECRETVAL1; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "set-cookie: id=[redacted]; Expires=Wed, 21 Oct 2026 07:28:00 GMT"),
      ("< Set-Cookie: session=SECRETVAL1; HttpOnly\r\n< Content-Type: text/html", "< Set-Cookie: session=[redacted]; HttpOnly\r\n< Content-Type: text/html"),
      ("Cookie: sid=SECRETVAL1==", "Cookie: sid=[redacted]"),
      ("Cookie: a=SECRETVAL1\nx=plain", "Cookie: a=[redacted]\nx=plain"),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text}");
    }
  }

  #[test]
  fn leaves_the_cookie_headers_that_hold_no_value_alone() {
    for plain in ["Set-Cookie: session=; Max-Age=0", "Cookie: ", "Cookie: session=[redacted]; theme=[redacted]"] {
      assert_eq!(masked(plain), plain);
    }
  }

  // ---- idempotence and UTF-8 safety ----

  #[test]
  fn masks_a_hook_segment_whose_leftover_looks_like_a_parameter_the_same_way_twice() {
    let once = masked("/hooks/=/token=");

    assert_eq!(once, "/hooks/[redacted]/token=[redacted]");
    assert_eq!(masked(&once), once);
  }

  #[test]
  fn masks_the_json_cookie_and_provider_forms_the_same_way_twice() {
    for text in [r#"{"token":"SYNTHETIC_SECRET_123"}"#, "password: SYNTHETIC_SECRET_123", "Authorization: Bearer SYNTHETIC_SECRET_123", "Cookie: session=SECRETVAL1; theme=dark"] {
      let once = masked(text);

      assert_eq!(masked(&once), once, "{text}");
    }
  }

  fn corpus_of(count: usize) -> Vec<String> {
    let pieces = [
      "?", "#", "@", "://", "=", "&", ";", ":", "%", "%3F", "%23", "%40", "é", "日", "😀", "\u{85}", "\u{feff}", "Bearer", "Basic", "Authorization:", "token", "a=", "/hooks/", "[redacted]",
      " ", "\n", "\"", "'", "\\\"", "{", "}", ",", "Cookie: ", "Set-Cookie: ", "password: ", "\"token\":", "eyJabcdef.eyJabcdef", "sk-", "xxxxxxxxxxxxxxxxxxxxxxxx", "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----",
    ];
    let mut seed: u32 = 139;
    let mut next = move || {
      seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
      seed as usize
    };
    (0..count)
      .map(|_| {
        let length = next() % 30;
        (0..length).map(|_| pieces[next() % pieces.len()]).collect::<String>()
      })
      .collect()
  }

  #[test]
  fn masks_every_vector_of_a_multibyte_corpus_the_same_way_twice_without_panicking() {
    let not_idempotent: Vec<String> = corpus_of(6000).into_iter().filter(|text| masked(&masked(text)) != masked(text)).collect();

    assert_eq!(not_idempotent, Vec::<String>::new());
  }

  // ---- linear time ----

  #[test]
  fn masks_the_hardened_rules_in_linear_time() {
    const SMALL_INPUT: usize = 64 * 1024;
    const LARGE_INPUT: usize = 256 * 1024;
    const NOISE_FLOOR: Duration = Duration::from_millis(20);
    const GENEROUS_CEILING: Duration = Duration::from_secs(20);
    let units = [
      "token:", "token: ", "\"token\":\"", "token:\"", "token:\\", "a:", "token:token:", "token:[redacted]", "password: '", "token:\\\"a", "api_key:1", "a:b ", ":",
      "Cookie: ", "Cookie: a=", "Set-Cookie: a=b;", "Cookie:a=b;c", "Cookie", "Cookie:   ", "Set-Cookie: a=b; c=d; e", "Cookie: aaaaaaaaaaaaaaaa",
      "eyJ", "-eyJaaaaaa.eyJaaaaaa.", "eyJaaaaaa.eyJaaaaaa", "eyJaaaaaa.eyJ.", "sk-", "-sk-", "ghp_", "github_pat_", "AKIA", "AKIAAAAAAAAAAAAAAAAA", "xoxe.", "xoxe.xoxp-", "xoxd-",
      "xapp-", "AIza", "npm_", "glpat-", "glpat-aaaaaaaaaaaaaaaaaaaa.01.", "sk_live_", "whsec_", "hf_", "-----BEGIN PRIVATE KEY-----", "-----BEGIN A A A A ", "-----BEGIN PRIVATE KEY-----\n-----END ",
      "-----END ", "\u{85}", "Bearer\u{85}", "a=\u{85}token=", "é\"token\":\"", "日token: ",
    ];
    let fastest_masking_of = |unit: &str, size: usize| {
      let hostile = unit.repeat(size / unit.len() + 1);
      (0..3)
        .map(|_| {
          let started_at = Instant::now();
          masked(&hostile);
          started_at.elapsed()
        })
        .min()
        .unwrap()
    };

    for unit in units {
      let time_at_small_input = fastest_masking_of(unit, SMALL_INPUT).max(NOISE_FLOOR);
      let time_at_large_input = fastest_masking_of(unit, LARGE_INPUT);

      assert!(time_at_large_input < time_at_small_input * 8, "{unit:?}: 4x the input took {time_at_large_input:?} against {time_at_small_input:?}");
      assert!(time_at_large_input < GENEROUS_CEILING, "{unit:?} x 256 KiB took {time_at_large_input:?}");
    }
  }
}
