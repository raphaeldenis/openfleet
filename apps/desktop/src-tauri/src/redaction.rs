//! Frozen: the event log never calls this module (the allowlist keeps free text out by construction); only the status line shown to the webview masks with it.
//! Masks credentials in a line of text. A scanning port of packages/core/src/redact.ts: no regex, so every pass is linear.
//! The documented ceilings of that file (non-`eyJ` JWT payloads, quoted values past the limit, short or literal-looking values) hold here too.

pub const MASK: &str = "[redacted]";
/// The mask of packages/core/src/redact.ts: the daemon's output carries it, so a masked text from either side is recognised.
const CORE_MASK: &str = "***";
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
/// A collection under a secret-named key (`"token":["A",{"b":"C"}]`) nests up to this deep before it is masked to the limit.
const COLLECTION_DEPTH_LIMIT: usize = 32;
/// An authorization scheme (`Token`, `Digest`, …) is at least this long; a shorter word is prose (`the authorization: is required`).
const AUTHORIZATION_SCHEME_MINIMUM_LENGTH: usize = 3;
/// A shorter unquoted value is a word of the sentence (`the token: is expired`), not a credential.
const UNQUOTED_VALUE_MINIMUM_LENGTH: usize = 4;
const LITERALS_THAT_HOLD_NO_SECRET: [&str; 4] = ["null", "true", "false", "undefined"];
const AUTHORIZATION_SCHEMES: [&str; 2] = ["bearer", "basic"];
const SECRET_KEY_WORDS: [&str; 9] = ["token", "secret", "authorization", "password", "cookie", "ticket", "apikey", "api_key", "api-key"];
/// The last noun of a key that names a credential (`accessToken`, `client_secret`), for the rule that masks a whole collection.
const SINGULAR_CREDENTIAL_NOUNS: [&str; 9] = ["token", "secret", "password", "passwd", "authorization", "credential", "cookie", "ticket", "apikey"];
/// A plural noun also counts things (`tokens: [1,2]`): its collection is a credential only when it holds a string.
const PLURAL_CREDENTIAL_NOUNS: [&str; 6] = ["tokens", "secrets", "passwords", "credentials", "cookies", "tickets"];
const CREDENTIAL_NOUN_PAIRS: [&str; 3] = ["api key", "private key", "secret key"];
/// `token_value`, `secretData`: the noun after the credential word only says how the credential is held.
const CONTAINER_WORDS: [&str; 7] = ["value", "values", "string", "data", "list", "map", "json"];
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
  let without_colon_values = replacing_matches(&without_url_credentials, colon_value_at);
  let without_cookie_values = replacing_matches(&without_colon_values, cookie_header_at);
  let without_secret_parameters = replacing_matches(&without_cookie_values, |text, index| query_parameter_at(text, index, depth));
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

/// Returns where a token starts after the separators that follow `from`: the longest run of separators that a token byte follows, as the backtracking regex settles it
/// (`Bearer %3A` and `Bearer<U+0085>=` hold a token made of the last separator-like characters, which is masked).
fn token_start_after_separators(text: &str, from: usize) -> Option<usize> {
  let mut cursor = from;
  let mut token_start = None;
  while bearer_separator_len_at(text, cursor) > 0 {
    cursor += bearer_separator_len_at(text, cursor);
    let token_follows = text.as_bytes().get(cursor).is_some_and(|byte| is_bearer_token_byte(*byte));
    if token_follows {
      token_start = Some(cursor);
    }
  }
  token_start
}

/// Returns where the token starts: after the first `Bearer` and its separators, and after each repeated `Bearer` + separators that a token follows
/// (otherwise the repeated word is the token, as the backtracking regex settles it).
fn bearer_token_start(text: &str, marker_end: usize) -> Option<usize> {
  let mut token_start = token_start_after_separators(text, marker_end)?;
  while let Some(repeated_marker_end) = word_end(text.as_bytes(), token_start, "bearer") {
    let Some(after_repeated_separators) = token_start_after_separators(text, repeated_marker_end) else {
      break;
    };
    token_start = after_repeated_separators;
  }
  Some(token_start)
}

/// Masks the token and writes the word canonically as `Bearer`, whatever its case or escapes, like the core masker.
fn bearer_token_at(text: &str, index: usize) -> Replacement {
  let bytes = text.as_bytes();
  let marker_end = word_end(bytes, index, "bearer")?;
  let token_start = bearer_token_start(text, marker_end)?;
  let token_length = bytes[token_start..].iter().take_while(|byte| is_bearer_token_byte(**byte)).count();
  (token_length > 0).then(|| (token_start + token_length, format!("Bearer {MASK}")))
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

/// Splits a key into the words of its camel case, snake case, kebab case and dotted spelling (`accessToken`, `x-api-key`, `API_KEY`, `APIKey` → access token, x api key, api key, api key).
fn key_words(key: &str) -> Vec<String> {
  let bytes = key.as_bytes();
  let mut words = Vec::new();
  let mut at = 0;
  while at < bytes.len() {
    let byte = bytes[at];
    let word_end = if byte.is_ascii_digit() {
      at + run_length(bytes, at, |next| next.is_ascii_digit())
    } else if byte.is_ascii_lowercase() {
      at + run_length(bytes, at, |next| next.is_ascii_lowercase())
    } else if byte.is_ascii_uppercase() && bytes.get(at + 1).is_some_and(u8::is_ascii_lowercase) {
      at + 1 + run_length(bytes, at + 1, |next| next.is_ascii_lowercase())
    } else if byte.is_ascii_uppercase() {
      let upper_run_end = at + run_length(bytes, at, |next| next.is_ascii_uppercase());
      let last_upper_starts_a_word = bytes.get(upper_run_end).is_some_and(u8::is_ascii_lowercase);
      if last_upper_starts_a_word { upper_run_end - 1 } else { upper_run_end }
    } else {
      at += 1;
      continue;
    };
    words.push(key[at..word_end].to_ascii_lowercase());
    at = word_end;
  }
  words
}

#[derive(PartialEq)]
enum CredentialNoun {
  Singular,
  Plural,
  None,
}

/// The last noun of a key: `token`, `accessToken`, `x-api-key`, `private_key`, `token_value` end on a credential; `tokens` and `authTokens` end on a plural one.
/// `tokenizer`, `password_policy`, `ticketCount` and `secretary` only hold a secret word inside another word or before another noun: they describe a credential, they are not one.
fn credential_noun_of(key: &str) -> CredentialNoun {
  let mut words = key_words(key);
  while words.last().is_some_and(|word| CONTAINER_WORDS.contains(&word.as_str())) {
    words.pop();
  }
  let last_word = words.last().map(String::as_str).unwrap_or_default();
  let last_pair = words[words.len().saturating_sub(2)..].join(" ");
  if SINGULAR_CREDENTIAL_NOUNS.contains(&last_word) || CREDENTIAL_NOUN_PAIRS.contains(&last_pair.as_str()) {
    return CredentialNoun::Singular;
  }
  if PLURAL_CREDENTIAL_NOUNS.contains(&last_word) {
    CredentialNoun::Plural
  } else {
    CredentialNoun::None
  }
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
  let masked_text = masked_at_depth(&decoded_text, depth + 1);
  spelled_with_the_core_mask(&masked_text) != spelled_with_the_core_mask(&decoded_text)
}

/// Writes every mask of this masker as the mask of the core masker: a text a rule only respells (`***` → `[redacted]`) holds no new secret.
fn spelled_with_the_core_mask(text: &str) -> String {
  text.replace(MASK, CORE_MASK)
}

// ---- hook tokens ----

fn slash_end(bytes: &[u8], index: usize) -> Option<usize> {
  unit_at(bytes, index).filter(|(byte, _)| *byte == b'/').map(|(_, end)| end)
}

/// `/hooks/:token` is the route pattern, not a secret.
fn is_the_route_pattern(rest: &str) -> bool {
  let bytes = rest.as_bytes();
  let names_the_placeholder = bytes.get(..":token".len()).is_some_and(|word| word.eq_ignore_ascii_case(b":token"));
  let placeholder_ends_there = bytes.get(":token".len()).is_none_or(|byte| !is_word_byte(*byte) && *byte != b'-');
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
  is_digits(whole) && fraction.is_none_or(is_digits)
}

/// The header names the cookie rule matches: `Cookie`, `Set-Cookie`, `X-Cookie`, … but not `mycookie`.
fn is_a_cookie_header_name(key: &str) -> bool {
  const COOKIE: &str = "cookie";
  let lowercase_key = key.to_ascii_lowercase();
  let Some(before_the_word) = lowercase_key.strip_suffix(COOKIE) else {
    return false;
  };
  before_the_word.bytes().last().is_none_or(|byte| !is_word_byte(byte))
}

fn is_a_mask(text: &str) -> bool {
  text == MASK || text == CORE_MASK
}

fn starts_with_a_mask(text: &str) -> bool {
  text.starts_with(MASK) || text.starts_with(CORE_MASK)
}

fn is_authorization_scheme_before_mask(value: &str, text: &str, value_end: usize) -> bool {
  let is_a_scheme = AUTHORIZATION_SCHEMES.contains(&value.to_ascii_lowercase().as_str());
  is_a_scheme && starts_with_a_mask(text[value_end..].trim_start_matches([' ', '\t']))
}

fn looks_like_a_credential(value: &str, text: &str, value_end: usize) -> bool {
  let is_long_enough = value.chars().count() >= UNQUOTED_VALUE_MINIMUM_LENGTH;
  let is_usage_counter_or_literal = is_a_plain_number(value) || LITERALS_THAT_HOLD_NO_SECRET.contains(&value.to_ascii_lowercase().as_str());
  is_long_enough && !is_usage_counter_or_literal && !is_authorization_scheme_before_mask(value, text, value_end)
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
  ColonValue { start: content_start, end: content_end, is_credential: !content.is_empty() }
}

fn is_a_quote_byte(byte: u8) -> bool {
  matches!(byte, b'"' | b'\'' | b'`')
}

/// Returns the last byte index a bounded scan from `from` may reach, on a character boundary.
fn bounded_limit(text: &str, from: usize) -> usize {
  let mut limit = (from + QUOTED_VALUE_LIMIT).min(text.len());
  while !text.is_char_boundary(limit) {
    limit -= 1;
  }
  limit
}

struct QuoteScan {
  quote: u8,
  limit: usize,
  are_line_breaks_part_of_the_string: bool,
  are_quotes_escaped: bool,
}

/// Returns where the string whose content starts at `content_start` closes: at its closing quote (a backslash and a quote inside an escaped JSON document),
/// or at the line break (when line breaks end the string) or the limit when it never closes; a backslash escapes the next byte of a plain string.
fn closing_quote_at(bytes: &[u8], content_start: usize, scan: &QuoteScan) -> usize {
  let mut at = content_start;
  while at < scan.limit {
    let byte = bytes[at];
    let is_line_break = byte == b'\n' || byte == b'\r';
    let closes_the_string = if scan.are_quotes_escaped { byte == b'\\' && bytes.get(at + 1) == Some(&scan.quote) } else { byte == scan.quote };
    if closes_the_string || (is_line_break && !scan.are_line_breaks_part_of_the_string) {
      return at;
    }
    let escapes_the_next_byte = byte == b'\\' && !scan.are_quotes_escaped;
    at += if escapes_the_next_byte { 2 } else { 1 };
  }
  at.min(scan.limit)
}

/// Returns the quote delimiting a string at `at`: a plain quote, or, inside an escaped JSON document, a backslash and a quote.
fn quote_delimiter_at(bytes: &[u8], at: usize, are_quotes_escaped: bool) -> Option<u8> {
  let byte = bytes[at];
  if !are_quotes_escaped {
    return is_a_quote_byte(byte).then_some(byte);
  }
  let next_byte = bytes.get(at + 1).copied()?;
  (byte == b'\\' && is_a_quote_byte(next_byte)).then_some(next_byte)
}

struct Collection {
  end: usize,
  holds_a_string: bool,
}

/// Returns where the `[…]` or `{…}` that opens at `start` closes, strings and nesting included; one that never balances, nests deeper than the limit
/// or runs past the length limit is cut at the limit. It also says whether a string value sits inside (an object key does not count;
/// a string cut by the limit or a collection cut by the depth limit does).
fn collection_from(text: &str, start: usize, are_quotes_escaped: bool) -> Collection {
  let bytes = text.as_bytes();
  let limit = bounded_limit(text, start);
  let delimiter_width = if are_quotes_escaped { 2 } else { 1 };
  let mut depth = 0;
  let mut open_quote: Option<u8> = None;
  let mut holds_a_string = false;
  let mut is_last_string_a_key_or_a_value = false;
  let mut at = start;
  while at < limit {
    let byte = bytes[at];
    let delimiter = quote_delimiter_at(bytes, at, are_quotes_escaped);
    if let Some(quote) = open_quote {
      let closes_the_string = delimiter == Some(quote);
      let escapes_the_next_byte = byte == b'\\' && !are_quotes_escaped;
      if closes_the_string {
        open_quote = None;
        is_last_string_a_key_or_a_value = true;
      }
      at += if closes_the_string { delimiter_width } else if escapes_the_next_byte { 2 } else { 1 };
      continue;
    }
    let is_string_just_closed = is_last_string_a_key_or_a_value && text.is_char_boundary(at) && space_len_at(text, at) == 0;
    if is_string_just_closed {
      holds_a_string |= byte != b':';
      is_last_string_a_key_or_a_value = false;
    }
    if delimiter.is_some() {
      open_quote = delimiter;
      at += delimiter_width;
      continue;
    }
    if matches!(byte, b'[' | b'{') {
      depth += 1;
    }
    if depth > COLLECTION_DEPTH_LIMIT {
      return Collection { end: limit, holds_a_string: true };
    }
    if matches!(byte, b']' | b'}') {
      depth -= 1;
    }
    if depth == 0 {
      return Collection { end: at + 1, holds_a_string };
    }
    at += 1;
  }
  let is_string_cut_by_the_limit = open_quote.is_some() || is_last_string_a_key_or_a_value;
  Collection { end: limit, holds_a_string: holds_a_string || is_string_cut_by_the_limit }
}

/// Returns where the line after the line break at `line_break_at` starts when it continues the header (it starts with a space or a tab).
fn start_of_folded_line_after(bytes: &[u8], line_break_at: usize) -> Option<usize> {
  let next_line_start = if bytes[line_break_at] == b'\r' && bytes.get(line_break_at + 1) == Some(&b'\n') { line_break_at + 2 } else { line_break_at + 1 };
  matches!(bytes.get(next_line_start), Some(b' ' | b'\t')).then_some(next_line_start)
}

/// Skips the spaces, tabs and folded line breaks of a header, up to the length limit.
fn end_of_folded_padding(text: &str, from: usize) -> usize {
  let bytes = text.as_bytes();
  let limit = bounded_limit(text, from);
  let mut at = from;
  while at < limit {
    if is_padding_byte(bytes[at]) {
      at += 1;
      continue;
    }
    let is_a_line_break = matches!(bytes[at], b'\r' | b'\n');
    let Some(folded_line_start) = is_a_line_break.then(|| start_of_folded_line_after(bytes, at)).flatten() else {
      break;
    };
    at = folded_line_start;
  }
  at
}

/// `response = "…"`: the quote at `at` follows an equals sign, whatever padding sits between them.
fn follows_an_equals_sign(bytes: &[u8], at: usize, credentials_start: usize) -> bool {
  let mut before_padding = at;
  while before_padding > credentials_start && is_padding_byte(bytes[before_padding - 1]) {
    before_padding -= 1;
  }
  before_padding > 0 && bytes[before_padding - 1] == b'='
}

fn is_header_whitespace_byte(byte: u8) -> bool {
  matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

/// Returns where the credentials of an authorization scheme end: at a line break that no folded line follows, a closing bracket, a quote that opens no parameter value
/// (`response="…"` belongs to them) or the limit; trailing whitespace stays out.
fn end_of_authorization_credentials(text: &str, start: usize) -> usize {
  let bytes = text.as_bytes();
  let limit = bounded_limit(text, start);
  let mut at = start;
  while at < limit {
    let byte = bytes[at];
    if bytes[at..].starts_with(MASK.as_bytes()) {
      at += MASK.len();
      continue;
    }
    let ends_the_line = byte == b'\n' || byte == b'\r';
    let folded_line_start = ends_the_line.then(|| start_of_folded_line_after(bytes, at)).flatten();
    if let Some(folded_line_start) = folded_line_start {
      at = folded_line_start;
      continue;
    }
    let escaped_quote = if byte == b'\\' { bytes.get(at + 1).copied().filter(|next_byte| is_a_quote_byte(*next_byte)) } else { None };
    let quote = escaped_quote.or_else(|| is_a_quote_byte(byte).then_some(byte));
    let quote_width = if escaped_quote.is_some() { 2 } else { 1 };
    let opens_a_parameter_value = quote.is_some() && follows_an_equals_sign(bytes, at, start);
    let is_a_closing_bracket = matches!(byte, b']' | b'}');
    let is_a_quote_that_opens_no_value = quote.is_some() && !opens_a_parameter_value;
    if ends_the_line || is_a_closing_bracket || is_a_quote_that_opens_no_value {
      break;
    }
    let Some(quote) = quote else {
      at += 1;
      continue;
    };
    let scan = QuoteScan { quote, limit, are_line_breaks_part_of_the_string: false, are_quotes_escaped: escaped_quote.is_some() };
    let closing_at = closing_quote_at(bytes, at + quote_width, &scan);
    let closes_with_the_quote = if escaped_quote.is_some() { bytes.get(closing_at) == Some(&b'\\') && bytes.get(closing_at + 1) == Some(&quote) } else { bytes.get(closing_at) == Some(&quote) };
    at = if closes_with_the_quote { closing_at + quote_width } else { closing_at };
  }
  let mut end = at;
  while end > start && is_header_whitespace_byte(bytes[end - 1]) {
    end -= 1;
  }
  end
}

/// The key of a header such as `Authorization` or `Proxy-Authorization`, not `myauthorization`.
fn is_an_authorization_header_name(key: &str) -> bool {
  const AUTHORIZATION: &str = "authorization";
  let lowercase_key = key.to_ascii_lowercase();
  let Some(before_the_word) = lowercase_key.strip_suffix(AUTHORIZATION) else {
    return false;
  };
  before_the_word.bytes().last().is_none_or(|byte| !byte.is_ascii_alphanumeric())
}

fn is_a_generic_authorization_scheme(scheme: &str) -> bool {
  let is_long_enough = scheme.len() >= AUTHORIZATION_SCHEME_MINIMUM_LENGTH;
  let holds_scheme_characters = scheme.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._~+/-".contains(&byte));
  is_long_enough && holds_scheme_characters && !AUTHORIZATION_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str())
}

/// `Token X` or `Digest username="U", …` behind an authorization header: the scheme word stays readable, everything it introduces is the credential.
fn authorization_credentials_from(text: &str, value_start: usize, key: &str) -> Option<ColonValue> {
  if !is_an_authorization_header_name(key) {
    return None;
  }
  let scheme_end = unquoted_value_end(text, value_start);
  let credentials_start = end_of_folded_padding(text, scheme_end);
  let has_credentials_after_padding = credentials_start > scheme_end;
  if !(has_credentials_after_padding && is_a_generic_authorization_scheme(&text[value_start..scheme_end])) {
    return None;
  }
  let credentials_end = end_of_authorization_credentials(text, credentials_start);
  (credentials_end > credentials_start).then(|| ColonValue { start: credentials_start, end: credentials_end, is_credential: !is_a_mask(&text[credentials_start..credentials_end]) })
}

/// The value after `key": ` or `key: `, or None when no colon follows the key; a cookie header's unquoted value belongs to the cookie rule.
fn colon_value_after(text: &str, key_end: usize, key: &str) -> Option<ColonValue> {
  let bytes = text.as_bytes();
  let after_closing_quote = key_end + run_length(bytes, key_end, |byte| matches!(byte, b'"' | b'\'' | b'\\'));
  let colon_at = after_closing_quote + run_length(bytes, after_closing_quote, is_padding_byte);
  if bytes.get(colon_at) != Some(&b':') {
    return None;
  }
  let value_start = if is_an_authorization_header_name(key) { end_of_folded_padding(text, colon_at + 1) } else { colon_at + 1 + run_length(bytes, colon_at + 1, is_padding_byte) };
  let quote_at = value_start + run_length(bytes, value_start, |byte| byte == b'\\');
  let is_opening_quote_escaped = quote_at > value_start;
  if let Some(quote) = bytes.get(quote_at).copied().filter(|byte| matches!(byte, b'"' | b'\'')) {
    return Some(quoted_value_from(text, quote_at + 1, quote, is_opening_quote_escaped));
  }
  let is_the_mask = text[quote_at..].starts_with(MASK);
  let opens_collection = !is_opening_quote_escaped && !is_the_mask && matches!(bytes.get(quote_at), Some(b'[' | b'{'));
  let credential_noun = credential_noun_of(key);
  if opens_collection && credential_noun != CredentialNoun::None {
    let is_inside_an_escaped_document = text[key_end..after_closing_quote].contains('\\');
    let collection = collection_from(text, value_start, is_inside_an_escaped_document);
    let is_counter_collection = credential_noun == CredentialNoun::Plural && !collection.holds_a_string;
    if !is_counter_collection {
      return Some(ColonValue { start: value_start, end: collection.end, is_credential: true });
    }
  }
  let is_key_known_to_quoted_and_collection_rules_only = !is_secret_key(key);
  if is_opening_quote_escaped || is_a_cookie_header_name(key) || is_key_known_to_quoted_and_collection_rules_only {
    return None;
  }
  authorization_credentials_from(text, value_start, key).or_else(|| Some(unquoted_value_from(text, value_start)))
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
  if !is_secret_key(key) && credential_noun_of(key) == CredentialNoun::None {
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

struct CookieValue {
  start: usize,
  end: usize,
  next: usize,
}

/// A quoted value is masked between its quotes; one that never closes is masked to the end of the header or the limit.
fn cookie_value_from(pairs: &str, value_start: usize) -> CookieValue {
  let bytes = pairs.as_bytes();
  let Some(quote) = bytes.get(value_start).copied().filter(|byte| is_a_quote_byte(*byte)) else {
    let length = pairs[value_start..].find(ends_a_cookie_value).unwrap_or(pairs.len() - value_start);
    return CookieValue { start: value_start, end: value_start + length, next: value_start + length };
  };
  let content_start = value_start + 1;
  let scan = QuoteScan { quote, limit: bounded_limit(pairs, content_start), are_line_breaks_part_of_the_string: true, are_quotes_escaped: false };
  let content_end = closing_quote_at(bytes, content_start, &scan);
  let is_closed = bytes.get(content_end) == Some(&quote);
  CookieValue { start: content_start, end: content_end, next: if is_closed { content_end + 1 } else { content_end } }
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
    let has_a_value_mark = pairs.as_bytes().get(name_end) == Some(&b'=');
    let value_with_content = has_a_value_mark.then(|| cookie_value_from(pairs, name_end + 1)).filter(|value| value.end > value.start);
    if let Some(value) = &value_with_content {
      masked.push_str(&pairs[copied_up_to..value.start]);
      masked.push_str(MASK);
      copied_up_to = value.end;
    }
    if first_pair_only {
      break;
    }
    cursor = value_with_content.map_or(name_end, |value| value.next);
  }
  masked.push_str(&pairs[copied_up_to..]);
  masked
}

/// Returns where a header value ends: a header continues on the next line when that line starts with a space or a tab (the legacy folded form).
fn end_of_header_value(text: &str, from: usize) -> usize {
  let bytes = text.as_bytes();
  let mut at = from;
  while at < bytes.len() {
    let is_a_line_break = matches!(bytes[at], b'\r' | b'\n');
    if !is_a_line_break {
      at += 1;
      continue;
    }
    let Some(folded_line_start) = start_of_folded_line_after(bytes, at) else {
      return at;
    };
    at = folded_line_start;
  }
  bytes.len()
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
  let pairs_end = end_of_header_value(text, pairs_start);
  let masked_pairs = masked_cookie_pairs(&text[pairs_start..pairs_end], is_set_cookie);
  Some((pairs_end, format!("{}{masked_pairs}", &text[index..pairs_start])))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::linear_growth::{cpu_time_to_run_on_repeated, linear_growth_problems, thread_cpu_time_of, LinearGrowthBudget};

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
    let endless = format!("{{\"token\":\"{}", "a".repeat(100_000));

    let result = masked(&endless);

    assert!(result.starts_with("{\"token\":\"[redacted]"));
    assert!(result.ends_with(&"a".repeat(20_000)));
  }

  #[test]
  fn masks_a_jwt_only_from_five_characters_after_each_eyj() {
    for plain in ["eyJabcd.eyJabcde.sig", "eyJabcde.eyJabcd.sig"] {
      assert_eq!(masked(plain), plain);
    }
  }

  #[test]
  fn keeps_a_mask_inside_an_unquoted_value_as_part_of_it() {
    assert_eq!(masked("token: abcd[redacted]efgh"), "token: [redacted]");
  }

  #[test]
  fn masks_a_quoted_value_of_ten_thousand_characters_whole() {
    assert_eq!(masked(&format!("{{\"token\":\"{}\"}}", "a".repeat(10_000))), "{\"token\":\"[redacted]\"}");
  }

  #[test]
  fn masks_the_shapes_that_a_mask_makes_readable_as_a_new_secret_the_same_way_twice() {
    for text in ["Authorization::=", "token:[redacted]}z=", "/hooks/=/token="] {
      let once = masked(text);

      assert_eq!(masked(&once), once, "{text}");
    }
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

  // ---- quoted and folded cookie values ----

  #[test]
  fn masks_the_quoted_and_folded_cookie_values() {
    let cases = [
      (r#"Cookie: session="SYNTHETIC_SECRET_123""#, r#"Cookie: session="[redacted]""#),
      (r#"Set-Cookie: session="SYNTHETIC_SECRET_123"; Path=/; Max-Age=3600; HttpOnly"#, r#"Set-Cookie: session="[redacted]"; Path=/; Max-Age=3600; HttpOnly"#),
      (r#"Cookie: session=abc; other="SECOND_SECRET_456""#, r#"Cookie: session=[redacted]; other="[redacted]""#),
      ("Cookie: session='SYNTHETIC_SECRET_123'", "Cookie: session='[redacted]'"),
      (r#"Cookie: s="AAA;b=BBB"; t=2"#, r#"Cookie: s="[redacted]"; t=[redacted]"#),
      (r#"Cookie: s="AA\"BBSECRET"; t=2"#, r#"Cookie: s="[redacted]"; t=[redacted]"#),
      ("Cookie: a=1;\r\n session=SYNTHETIC_SECRET_123", "Cookie: a=[redacted];\r\n session=[redacted]"),
      ("Cookie: a=1;\n\tsession=SYNTHETIC_SECRET_123", "Cookie: a=[redacted];\n\tsession=[redacted]"),
      ("Cookie: a=\"SECRET_ONE\r\n SECRET_TWO\"; b=2", "Cookie: a=\"[redacted]\"; b=[redacted]"),
      (r#"Cookie: s="SYNTHETIC_SECRET_123; more"#, r#"Cookie: s="[redacted]"#),
      (r#"Set-Cookie: s="SYNTHETIC_SECRET_123"#, r#"Set-Cookie: s="[redacted]"#),
      (r#"Cookie: s="é日😀SECRET"; t=é"#, r#"Cookie: s="[redacted]"; t=[redacted]"#),
      ("Cookie: s=\"SECRET_VALUE_1\nnext=plain", "Cookie: s=\"[redacted]\nnext=plain"),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text}");
    }
  }

  #[test]
  fn leaves_the_cookie_headers_that_hold_no_quoted_content_alone() {
    for plain in [r#"Cookie: s=""; t="""#, r#"Cookie: s="[redacted]""#, "Cookie: a=\nsession=plain"] {
      assert_eq!(masked(plain), plain);
    }
  }

  #[test]
  fn masks_only_the_bounded_start_of_a_cookie_value_that_never_closes() {
    let result = masked(&format!("Cookie: s=\"{}", "a".repeat(100_000)));

    assert!(result.starts_with("Cookie: s=\"[redacted]"));
    assert!(result.ends_with(&"a".repeat(20_000)));
  }

  // ---- authorization schemes other than Basic and Bearer ----

  #[test]
  fn masks_the_credentials_of_an_authorization_scheme_and_keeps_the_scheme_readable() {
    let cases = [
      ("Authorization: Token SYNTHETIC_SECRET_123", "Authorization: Token [redacted]"),
      ("Proxy-Authorization: Token SYNTHETIC_SECRET_123", "Proxy-Authorization: Token [redacted]"),
      ("authorization: token SYNTHETIC_SECRET_123", "authorization: token [redacted]"),
      (r#"Authorization: Digest username="USER_SECRET_123", response="SYNTHETIC_SECRET_123""#, "Authorization: Digest [redacted]"),
      (
        r#"Authorization: Digest username="USER_SECRET_123", realm="api", nonce="N0NCE", uri="/x", algorithm=SHA-256, qop=auth, cnonce="CN", nc=1, response="SYNTHETIC_SECRET_123", opaque="OP""#,
        "Authorization: Digest [redacted]",
      ),
      ("Authorization: AWS4-HMAC-SHA256 Credential=SYNTHETIC/20260101/s3, Signature=abc123", "Authorization: AWS4-HMAC-SHA256 [redacted]"),
      ("Authorization: Token SYNTHETIC_SECRET_123\nHost: example.com", "Authorization: Token [redacted]\nHost: example.com"),
      (r#"{"msg":"Authorization: Token SYNTHETIC_SECRET_123","level":"info"}"#, r#"{"msg":"Authorization: Token [redacted]","level":"info"}"#),
      (r#"{"msg":"Authorization: Digest response=\"SECRET_VALUE_1\"","level":"info"}"#, r#"{"msg":"Authorization: Digest [redacted]","level":"info"}"#),
      ("Authorization: Token SYNTHETIC_SECRET_123  ", "Authorization: Token [redacted]  "),
      ("Authorization: Basic c3ludGhldGljOmNyZWQ=", "Authorization: Basic [redacted]"),
      ("Authorization: Bearer SYNTHETIC_SECRET_123", "Authorization: Bearer [redacted]"),
      ("Authorization: SYNTHETIC_SECRET_123", "Authorization: [redacted]"),
      ("Authorization: Token", "Authorization: [redacted]"),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text}");
    }
  }

  #[test]
  fn leaves_the_authorization_forms_that_hold_no_credential_alone() {
    for plain in ["Authorization: Token [redacted]", "Authorization: Token ***", "Authorization: Bearer [redacted]", "Authorization: Bearer ***", "the authorization: is required"] {
      assert_eq!(masked(plain), plain);
    }
  }

  // ---- an authorization header with padding around its parameters ----

  #[test]
  fn masks_the_digest_parameters_written_with_padding_around_the_equals_sign() {
    let cases = [
      (r#"Authorization: Digest response = "SYNTHETIC_SECRET_123""#, "Authorization: Digest [redacted]"),
      (r#"Authorization: Digest username = "USER_SECRET_123", response = "SYNTHETIC_SECRET_123""#, "Authorization: Digest [redacted]"),
      ("Authorization: Digest response=\t\"SYNTHETIC_SECRET_123\"", "Authorization: Digest [redacted]"),
      (r#"Authorization: Digest response= "SYNTHETIC_SECRET_123""#, "Authorization: Digest [redacted]"),
      (r#"Authorization: Digest response ="SYNTHETIC_SECRET_123""#, "Authorization: Digest [redacted]"),
      ("Authorization: Digest qop = auth, response \t= \t\"SYNTHETIC_SECRET_123\", opaque = \"OP\"", "Authorization: Digest [redacted]"),
      ("Authorization: Digest response = 'SYNTHETIC_SECRET_123'", "Authorization: Digest [redacted]"),
      ("Authorization: Digest response = \"SYNTHETIC_SECRET_123\"\nHost: example.com", "Authorization: Digest [redacted]\nHost: example.com"),
      (r#"{"msg":"Authorization: Digest response = \"SECRET_VALUE_1\"","level":"info"}"#, r#"{"msg":"Authorization: Digest [redacted]","level":"info"}"#),
      (r#"Authorization: Token SYNTHETIC_SECRET_123 "after""#, r#"Authorization: Token [redacted] "after""#),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text}");
    }
  }

  // ---- an authorization header folded over several lines ----

  #[test]
  fn masks_the_credentials_of_an_authorization_header_folded_over_several_lines() {
    let cases = [
      ("Authorization: Token X\r\n SYNTHETIC_SECRET_123", "Authorization: Token [redacted]"),
      ("Authorization: Token\r\n SYNTHETIC_SECRET_123", "Authorization: Token\r\n [redacted]"),
      ("Authorization:\r\n Token SYNTHETIC_SECRET_123", "Authorization:\r\n Token [redacted]"),
      ("Authorization: Token X\n\tSYNTHETIC_SECRET_123", "Authorization: Token [redacted]"),
      ("Authorization: Token X\r\n Y\r\n\tSYNTHETIC_SECRET_123", "Authorization: Token [redacted]"),
      ("Proxy-Authorization: Token X\r\n SYNTHETIC_SECRET_123", "Proxy-Authorization: Token [redacted]"),
      ("Authorization: Digest username=\"U\",\r\n response=\"SYNTHETIC_SECRET_123\"", "Authorization: Digest [redacted]"),
      ("Authorization: Token X\r\n SYNTHETIC_SECRET_123\r\nHost: example.com", "Authorization: Token [redacted]\r\nHost: example.com"),
      ("Authorization: Token X\r\n Y=Z", "Authorization: Token [redacted]"),
      ("Authorization: Token X\r\n é日😀SECRET", "Authorization: Token [redacted]"),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text:?}");
    }
  }

  #[test]
  fn leaves_the_folded_authorization_forms_that_hold_no_credential_alone() {
    for plain in ["Authorization: Token\r\n [redacted]", "Authorization: Token\r\n ***", "the authorization:\r\n is required"] {
      assert_eq!(masked(plain), plain, "{plain:?}");
    }
  }

  #[test]
  fn masks_the_folded_and_padded_authorization_forms_the_same_way_twice() {
    for text in [
      "Authorization: Token X\r\n SYNTHETIC_SECRET_123",
      "Authorization:\r\n Token SYNTHETIC_SECRET_123",
      "Authorization: Token\r\n SYNTHETIC_SECRET_123",
      r#"Authorization: Digest response = "SYNTHETIC_SECRET_123""#,
      "Authorization: Digest username\t=\t\"U\", response = \"X\"",
    ] {
      let once = masked(text);

      assert_eq!(masked(&once), once, "{text:?}");
    }
  }

  // ---- collections under a key that merely holds a secret word ----

  #[test]
  fn leaves_the_collection_under_a_key_that_merely_holds_a_secret_word_readable() {
    for plain in [
      r#"tokenizer: {"count":1}"#,
      r#"maxTokens: {"count":1}"#,
      "tokens: [1,2]",
      r#"password_policy: {"count":1}"#,
      "keyboard: [1,2]",
      r#"author: {"count":1}"#,
      r#"{"tokenizer":{"count":1}}"#,
      r#"{"maxTokens":{"count":1}}"#,
      r#"{"tokens":[1,2]}"#,
      r#"{"password_policy":{"minLength":8}}"#,
      r#"secretary: {"count":1}"#,
      "ticketCount: [1,2]",
      r#"{"cookiejar":{"size":2}}"#,
      "maxTokens: 4096",
      r#"{"token_count":{"input":1}}"#,
      r#"authorization_policy: {"mode":"strict"}"#,
    ] {
      assert_eq!(masked(plain), plain);
    }
  }

  #[test]
  fn masks_the_collection_under_a_key_whose_last_noun_is_a_credential() {
    let cases = [
      (r#"{"token":["a"]}"#, r#"{"token":[redacted]}"#),
      (r#"{"api_key":{"a":"b"}}"#, r#"{"api_key":[redacted]}"#),
      (r#"{"accessToken":["a"]}"#, r#"{"accessToken":[redacted]}"#),
      (r#"x-api-key: ["a","b"]"#, "x-api-key: [redacted]"),
      (r#"{"apiKey":["a"]}"#, r#"{"apiKey":[redacted]}"#),
      (r#"{"API_KEY":["a"]}"#, r#"{"API_KEY":[redacted]}"#),
      (r#"{"APIKey":["a"]}"#, r#"{"APIKey":[redacted]}"#),
      (r#"{"apikey":["a"]}"#, r#"{"apikey":[redacted]}"#),
      (r#"{"private_key":["a"]}"#, r#"{"private_key":[redacted]}"#),
      (r#"{"privateKey":{"a":"b"}}"#, r#"{"privateKey":[redacted]}"#),
      (r#"{"client_secret":["a"]}"#, r#"{"client_secret":[redacted]}"#),
      (r#"{"password":{"a":"b"}}"#, r#"{"password":[redacted]}"#),
      (r#"{"passwd":["a"]}"#, r#"{"passwd":[redacted]}"#),
      (r#"{"credentials":{"user":"u"}}"#, r#"{"credentials":[redacted]}"#),
      (r#"{"credential":["a"]}"#, r#"{"credential":[redacted]}"#),
      (r#"{"authorization":["a"]}"#, r#"{"authorization":[redacted]}"#),
      (r#"{"auth.token":["a"]}"#, r#"{"auth.token":[redacted]}"#),
      (r#"{"ACCESS_TOKEN":["a"]}"#, r#"{"ACCESS_TOKEN":[redacted]}"#),
      (r#"{"secrets":["a"]}"#, r#"{"secrets":[redacted]}"#),
      (r#"{"passwords":["a"]}"#, r#"{"passwords":[redacted]}"#),
      (r#"{"cookie":{"a":"b"}}"#, r#"{"cookie":[redacted]}"#),
      (r#"{"ticket":["a"]}"#, r#"{"ticket":[redacted]}"#),
      (r#"{"token_value":["a"]}"#, r#"{"token_value":[redacted]}"#),
      (r#"{"secret_key":["a"]}"#, r#"{"secret_key":[redacted]}"#),
      (r#"{"secretData":{"a":"b"}}"#, r#"{"secretData":[redacted]}"#),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text}");
    }
  }

  #[test]
  fn masks_a_collection_under_a_plural_credential_noun_when_it_holds_a_string() {
    let cases = [
      (r#"tokens: ["a","b"]"#, "tokens: [redacted]"),
      (r#"{"tokens":{"a":"x"}}"#, r#"{"tokens":[redacted]}"#),
      (r#"{"tokens":[1,"a"]}"#, r#"{"tokens":[redacted]}"#),
      (r#"{"tokens":[[1],{"deep":["s"]}],"next":1}"#, r#"{"tokens":[redacted],"next":1}"#),
      (r#"{"secrets":["a"]}"#, r#"{"secrets":[redacted]}"#),
      (r#"{"passwords":{"admin":"x"}}"#, r#"{"passwords":[redacted]}"#),
      (r#"{"credentials":{"user":"u"}}"#, r#"{"credentials":[redacted]}"#),
      (r#"{"cookies":["a=b"]}"#, r#"{"cookies":[redacted]}"#),
      (r#"{"tickets":["T-1"]}"#, r#"{"tickets":[redacted]}"#),
      (r#"{"authTokens":["a"]}"#, r#"{"authTokens":[redacted]}"#),
      (r#"{"tokens":[ "a" ]}"#, r#"{"tokens":[redacted]}"#),
      (r#"{"body":"{\"tokens\":[\"a\"]}"}"#, r#"{"body":"{\"tokens\":[redacted]}"}"#),
      (r#"{"tokens":[1,2,"a"#, r#"{"tokens":[redacted]"#),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(text), expected, "{text}");
    }
  }

  #[test]
  fn leaves_a_collection_under_a_plural_credential_noun_readable_when_it_holds_no_string() {
    for plain in [
      "tokens: [1,2]",
      "tokens: [true,null]",
      r#"{"tokens":{"in":12,"out":30}}"#,
      r#"{"tokens":[1.5,-2,false]}"#,
      r#"{"tokens":{ "in" : 12 }}"#,
      r#"{"maxTokens":{"count":1}}"#,
      r#"{"secrets":[]}"#,
      r#"{"credentials":{}}"#,
      r#"{"tickets":[[1],{"a":[2,null]}]}"#,
    ] {
      assert_eq!(masked(plain), plain);
    }
  }

  #[test]
  fn masks_a_plural_collection_nested_deeper_than_the_limit_which_it_cannot_read_to_the_end() {
    let deeper_than_the_limit = format!(r#"{{"tokens":{}1{},"after":1}}"#, "[".repeat(40), "]".repeat(40));

    assert_eq!(masked(&deeper_than_the_limit), r#"{"tokens":[redacted]"#);
  }

  #[test]
  fn masks_a_credential_nested_in_a_plural_collection_whole_and_in_a_readable_one_on_its_own() {
    assert_eq!(masked(r#"{"tokens":{"password":"SYNTHETIC_SECRET_123","in":1}}"#), r#"{"tokens":[redacted]}"#);
    assert_eq!(masked(r#"{"tokens":{"in":{"password":"SYNTHETIC_SECRET_123"}}}"#), r#"{"tokens":[redacted]}"#);
    assert_eq!(masked(r#"{"tokens":{"in":1,"password":12345678}}"#), r#"{"tokens":{"in":1,"password":12345678}}"#);
  }

  #[test]
  fn keeps_masking_what_sits_inside_or_after_a_key_that_merely_holds_a_secret_word() {
    assert_eq!(masked(r#"{"tokenizer":{"token":"SYNTHETIC_SECRET_123"}}"#), r#"{"tokenizer":{"token":"[redacted]"}}"#);
    assert_eq!(masked(r#"{"tokenizer":"SYNTHETIC_SECRET_123"}"#), r#"{"tokenizer":"[redacted]"}"#);
  }

  #[test]
  fn splits_a_key_into_its_words_whatever_its_spelling() {
    let cases = [
      ("accessToken", vec!["access", "token"]),
      ("x-api-key", vec!["x", "api", "key"]),
      ("API_KEY", vec!["api", "key"]),
      ("APIKey", vec!["api", "key"]),
      ("auth.token2", vec!["auth", "token", "2"]),
      ("TOKENS", vec!["tokens"]),
      ("aTokenB", vec!["a", "token", "b"]),
      ("日token", vec!["token"]),
    ];

    for (key, expected) in cases {
      assert_eq!(key_words(key), expected, "{key}");
    }
  }

  // ---- collections under a secret-named key ----

  #[test]
  fn masks_the_whole_collection_under_a_secret_named_key_and_keeps_the_key_readable() {
    let deeper_than_the_limit = format!(r#"{{"token":{}"S"{},"after":1}}"#, "[".repeat(40), "]".repeat(40));
    let cases = [
      (r#"{"token":["SYNTHETIC_SECRET_123","SECOND_SECRET_456"]}"#.to_string(), r#"{"token":[redacted]}"#.to_string()),
      (r#"{"token":{"value":"SYNTHETIC_SECRET_123","nested":["Y"]}}"#.to_string(), r#"{"token":[redacted]}"#.to_string()),
      (r#"{"user":"ada","token":["A","B"],"retry":3}"#.to_string(), r#"{"user":"ada","token":[redacted],"retry":3}"#.to_string()),
      (r#"{"token":["A]B","SECRET_TAIL"],"next":1}"#.to_string(), r#"{"token":[redacted],"next":1}"#.to_string()),
      ("{'token':{'a':'}SECRET_TAIL'},'next':1}".to_string(), "{'token':[redacted],'next':1}".to_string()),
      (r#"{"token":["A\"]SECRET_TAIL"],"next":1}"#.to_string(), r#"{"token":[redacted],"next":1}"#.to_string()),
      (r#"{"body":"{\"token\":[\"A\",\"B\"]}"}"#.to_string(), r#"{"body":"{\"token\":[redacted]}"}"#.to_string()),
      (r#"{"body":"{\"token\":[\"A]\",\"SECRET_TAIL\"]}"}"#.to_string(), r#"{"body":"{\"token\":[redacted]}"}"#.to_string()),
      (r#"{"api_key": ["K1", "K2"]}"#.to_string(), r#"{"api_key": [redacted]}"#.to_string()),
      (r#"{"cookie":{"session":"SYNTHETIC_SECRET_123"}}"#.to_string(), r#"{"cookie":[redacted]}"#.to_string()),
      ("{\n  \"token\": {\n    \"value\": \"SYNTHETIC_SECRET_123\"\n  },\n  \"next\": 1\n}".to_string(), "{\n  \"token\": [redacted],\n  \"next\": 1\n}".to_string()),
      (r#"token: ["A", "B"] and more"#.to_string(), "token: [redacted] and more".to_string()),
      (r#"{"token":["A","B""#.to_string(), r#"{"token":[redacted]"#.to_string()),
      (deeper_than_the_limit, r#"{"token":[redacted]"#.to_string()),
    ];

    for (text, expected) in cases {
      assert_eq!(masked(&text), expected, "{text}");
    }
  }

  #[test]
  fn leaves_the_values_that_only_look_like_a_collection_or_a_counter_alone() {
    for plain in ["maxTokens: 4096", r#"{"max_tokens": 4096}"#, "keyboard: us", r#"{"items":[1,2,3],"name":"x"}"#, "the token: is expired", r#"{"token":[redacted]}"#, r#"{"token":***}"#] {
      assert_eq!(masked(plain), plain);
    }
  }

  #[test]
  fn keeps_masking_a_plain_value_after_a_required_marker_the_way_it_did_before() {
    assert_eq!(masked("password: required"), "password: [redacted]");
  }

  #[test]
  fn masks_only_the_bounded_start_of_an_array_that_never_closes() {
    assert!(masked(&format!("token: [{}", "a".repeat(100_000))).starts_with("token: [redacted]"));
  }

  #[test]
  fn keeps_the_text_after_the_bound_of_an_array_that_never_closes_readable() {
    assert!(masked(&format!("{{\"token\":[\"A\",{} tail", "y".repeat(20_000))).ends_with(" tail"));
  }

  #[test]
  fn reads_its_own_mask_as_an_atom_and_not_as_the_start_of_a_collection() {
    assert_eq!(masked("token: [redacted]B"), "token: [redacted]");
    assert_eq!(masked(r#"{"token\":["A]B"]"#), r#"{"token\":[redacted]"]"#);
    assert_eq!(masked("Authorization:{]://,[\"/hooks/"), "Authorization:[redacted],[\"/hooks/");
  }

  #[test]
  fn does_not_take_a_respelled_core_mask_for_a_newly_found_secret_behind_escapes() {
    for plain in ["=%3F/hooks/***", "a=%2F%2F***%40x"] {
      assert_eq!(spelled_with_the_core_mask(&masked(plain)), plain, "{plain}");
    }
  }

  // ---- Bearer parity with the core masker ----

  #[test]
  fn masks_a_bearer_made_of_separator_like_characters_the_way_the_core_masker_does() {
    for (text, expected) in [("Bearer %3A", "Bearer [redacted]"), ("Bearer\u{85}=", "Bearer [redacted]"), ("Bearer%3A%3A", "Bearer [redacted]")] {
      assert_eq!(masked(text), expected, "{text:?}");
    }
  }

  #[test]
  fn writes_the_bearer_word_canonically_whatever_its_case() {
    assert_eq!(masked("authorization: bearer SYNTHETIC_SECRET_123"), "authorization: Bearer [redacted]");
    assert_eq!(masked("BEARER SYNTHETIC_SECRET_123"), "Bearer [redacted]");
    assert_eq!(masked("%42earer SYNTHETIC_SECRET_123"), "Bearer [redacted]");
  }

  #[test]
  fn recognises_the_mask_of_the_core_masker_before_a_scheme() {
    assert_eq!(masked("Authorization: Bearer ***"), "Authorization: Bearer ***");
    assert_eq!(masked("authorization: bearer ***"), "authorization: bearer ***");
  }

  // ---- UTF-8 boundaries of the bounded scans ----

  #[test]
  fn cuts_the_new_bounded_scans_on_a_character_boundary() {
    let templates = ["Cookie: s=\"{}", "Set-Cookie: s=\"{}", "Cookie: s=\\\"{}", "Authorization: Digest a=\"{}", "Authorization: Token {}", "token: [\"{}", "token: {\"a\":[\"{}", "token: [\\\"{}"];

    for template in templates {
      for filler in ["é", "日", "😀", "\\é", "\\😀"] {
        for offset in 0..5 {
          let body = format!("{}{}", "a".repeat(offset), filler.repeat(20_000));
          let result = masked(&template.replace("{}", &body));

          assert!(result.contains(MASK), "{template} {filler} {offset}");
        }
      }
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
      "Token ", "Digest ", "[\"", "{\"a\":", "]", "Authorization: ", "Proxy-Authorization: ", "response=\"", "\r\n ", "***", "=\\\"", "\\\"]", "\\\"token\\\":",
      " = ", "\t", "\n\t", "tokenizer: ", "passwd: ", "\"private_key\":", "[1,2]",
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
    let units = [
      "token:","token: ", "\"token\":\"", "token:\"", "token:\\", "a:", "token:token:", "token:[redacted]", "password: '", "token:\\\"a", "api_key:1", "a:b ", ":",
      "Cookie: ", "Cookie: a=", "Set-Cookie: a=b;", "Cookie:a=b;c", "Cookie", "Cookie:   ", "Set-Cookie: a=b; c=d; e", "Cookie: aaaaaaaaaaaaaaaa",
      "eyJ", "-eyJaaaaaa.eyJaaaaaa.", "eyJaaaaaa.eyJaaaaaa", "eyJaaaaaa.eyJ.", "sk-", "-sk-", "ghp_", "github_pat_", "AKIA", "AKIAAAAAAAAAAAAAAAAA", "xoxe.", "xoxe.xoxp-", "xoxd-",
      "xapp-", "AIza", "npm_", "glpat-", "glpat-aaaaaaaaaaaaaaaaaaaa.01.", "sk_live_", "whsec_", "hf_", "-----BEGIN PRIVATE KEY-----", "-----BEGIN A A A A ", "-----BEGIN PRIVATE KEY-----\n-----END ",
      "-----END ", "\u{85}", "Bearer\u{85}", "a=\u{85}token=", "é\"token\":\"", "日token: ",
      "Cookie: a=\"", "Set-Cookie: a=\"", "Cookie: a=\"b\"; ", "Cookie: a=\\\"", "Cookie: a='", "Cookie: a=1;\r\n ", "Cookie:\r\n \r\n ", "Cookie: \"", "Cookie: a=\"\\", "Cookie: é=\"日",
      "Authorization: Token ", "Authorization: Digest a=\"", "Authorization: Digest a=\"b\", ", "Proxy-Authorization: Token a b ", "Authorization: aaa ", "Authorization: Digest a=\\\"", "Authorization: Token \"", "authorization: aaa}",
      "token:[", "token:{\"a\":[", "token:[\"", "token:[\\\"", "{\"token\":[", "token: [[[[[[[[[[", "\"token\":{\"token\":", "token:[]", "token:['", "\\\"token\\\":[\\\"", "token:[}", "Bearer %3A", "Bearer%3A%3A", "Bearer\u{85}=",
      "Authorization: Digest a = \"", "Authorization: Digest a = \"b\" , ", "Authorization: Digest a=\t \t\"", "Authorization: Digest a =                \"", "Authorization: Digest a =\\\"",
      "Authorization: Token a\r\n ", "Authorization:\r\n ", "Authorization: Token\r\n \r\n ", "Authorization:\n\t", "Authorization: Token a\n\tb ", "Proxy-Authorization:\r\n Token\r\n a\r\n ", "Authorization: Digest a=\"b\",\r\n ",
      "tokens:[1,\"", "tokens:[1,2,", "tokens:{\"a\":", "tokens:{\"a\":1,", "tokens:[ \"", "tokens:[\"a\" ", "tokens:[[[[", "secrets:{\"", "tokens:[\"é\"\u{a0}",
      "tokenizer:[", "maxTokens:{", "password_policy: [", "tokens:[1,", "x-api-key:[", "aB:[tokenizer:{", "Authorization: Token é\r\n ", "Authorization: Digest a = \"日",
    ];
    for unit in units {
      let cpu_time_to_mask = cpu_time_to_run_on_repeated(unit, |hostile| {
        masked(hostile);
      });

      let problems = linear_growth_problems(cpu_time_to_mask, &LinearGrowthBudget::between(SMALL_INPUT, LARGE_INPUT));

      assert!(problems.is_empty(), "{unit:?}: {problems:?}");
    }
  }

  #[test]
  fn splits_one_endless_key_into_words_in_linear_time() {
    const SMALL_INPUT: usize = 64 * 1024;
    const LARGE_INPUT: usize = 256 * 1024;
    type HostileKeyShape = (&'static str, fn(usize) -> String);
    let texts_of_size: [HostileKeyShape; 5] = [
      ("camel", |size| format!("{}:[", "token".repeat(size / 5))),
      ("upper", |size| format!("{}:[", "TOKEN".repeat(size / 5))),
      ("mixed", |size| format!("{}:[", "aTokenB".repeat(size / 7))),
      ("upper then lower", |size| format!("{}a:[", "A".repeat(size))),
      ("digits", |size| format!("token{}:[", "1".repeat(size))),
    ];
    for (name, text_of_size) in texts_of_size {
      let cpu_time_to_mask = |size: usize| {
        let hostile = text_of_size(size);
        thread_cpu_time_of(|| {
          masked(&hostile);
        })
      };

      let problems = linear_growth_problems(cpu_time_to_mask, &LinearGrowthBudget::between(SMALL_INPUT, LARGE_INPUT));

      assert!(problems.is_empty(), "{name}: {problems:?}");
    }
  }
}
