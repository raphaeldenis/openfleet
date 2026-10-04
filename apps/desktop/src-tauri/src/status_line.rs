//! Turns a raw line of daemon output into the single line the webview may show: masked, home-shortened, escaped and capped.

use crate::daemon::last_non_blank_line;
use crate::issue_report::with_home_shortened;
use crate::redaction::redact;

pub const MAX_STATUS_LINE_CHARS: usize = 200;
const TRUNCATION_MARK: char = '…';

/// Returns the last non-blank line of `raw` as text that is safe to render and copy: secrets masked, `user_home` shown as `~`, invisible and bidi characters escaped, at most `MAX_STATUS_LINE_CHARS` characters.
pub fn webview_safe_line(raw: &str, user_home: &str, secrets: &[String]) -> String {
  let line = last_non_blank_line(raw).unwrap_or_default();
  let masked = redact(&line, secrets);
  let shortened = with_home_shortened(&masked, user_home);
  let escaped = with_invisible_characters_escaped(&shortened);
  let masked_again_once_escapes_are_visible = redact(&escaped, secrets);
  capped(&masked_again_once_escapes_are_visible)
}

fn is_invisible_or_bidi(character: char) -> bool {
  let is_bidi_control = matches!(character, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
  let is_zero_width = matches!(character, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}');
  character.is_control() || is_bidi_control || is_zero_width
}

fn with_invisible_characters_escaped(text: &str) -> String {
  text.chars().map(|character| if is_invisible_or_bidi(character) { character.escape_unicode().to_string() } else { character.to_string() }).collect()
}

fn capped(text: &str) -> String {
  if text.chars().count() <= MAX_STATUS_LINE_CHARS {
    return text.to_string();
  }
  let kept: String = text.chars().take(MAX_STATUS_LINE_CHARS - 1).collect();
  format!("{kept}{TRUNCATION_MARK}")
}

#[cfg(test)]
mod tests {
  use super::*;

  const HOME: &str = "/Users/jdoe";
  const ADMIN_TOKEN: &str = "adm1n-t0ken-0123456789";

  fn safe(raw: &str) -> String {
    webview_safe_line(raw, HOME, &[ADMIN_TOKEN.to_string()])
  }

  #[test]
  fn keeps_a_boot_refusal_readable() {
    assert_eq!(safe("openfleet: refusing to boot: port 7331 is already in use"), "openfleet: refusing to boot: port 7331 is already in use");
  }

  #[test]
  fn keeps_a_node_fatal_marker_readable() {
    assert_eq!(safe("FATAL ERROR: Reached heap limit Allocation failed"), "FATAL ERROR: Reached heap limit Allocation failed");
  }

  #[test]
  fn masks_the_admin_token() {
    let line = safe(&format!("boot failed with {ADMIN_TOKEN} in the request"));

    assert!(!line.contains(ADMIN_TOKEN), "{line}");
  }

  #[test]
  fn masks_a_bearer_credential() {
    let line = safe("request failed: Authorization: Bearer abcdefghijklmnop1234567890");

    assert!(!line.contains("abcdefghijklmnop1234567890"), "{line}");
  }

  #[test]
  fn masks_a_secret_valued_key() {
    let line = safe(r#"config rejected: {"apiKey":"sk-live-0123456789abcdef"}"#);

    assert!(!line.contains("sk-live-0123456789abcdef"), "{line}");
  }

  #[test]
  fn shortens_the_home_folder_to_a_tilde() {
    assert_eq!(safe("ENOENT: no such file /Users/jdoe/.openfleet/db.sqlite"), "ENOENT: no such file ~/.openfleet/db.sqlite");
  }

  #[test]
  fn leaves_another_users_folder_alone() {
    assert_eq!(safe("ENOENT: /Users/jdoe2/x"), "ENOENT: /Users/jdoe2/x");
  }

  #[test]
  fn caps_a_long_line_with_a_truncation_mark() {
    let line = safe(&"x".repeat(5_000));

    assert_eq!(line.chars().count(), MAX_STATUS_LINE_CHARS);
    assert!(line.ends_with(TRUNCATION_MARK));
  }

  #[test]
  fn caps_by_characters_not_bytes() {
    let line = safe(&"é".repeat(500));

    assert_eq!(line.chars().count(), MAX_STATUS_LINE_CHARS);
  }

  #[test]
  fn leaves_a_line_of_exactly_the_cap_untouched() {
    let exact = "y".repeat(MAX_STATUS_LINE_CHARS);

    assert_eq!(safe(&exact), exact);
  }

  #[test]
  fn escapes_bidi_overrides() {
    let line = safe("exit \u{202E}gnp.exe\u{2066}");

    assert_eq!(line, "exit \\u{202e}gnp.exe\\u{2066}");
  }

  #[test]
  fn escapes_control_characters_and_zero_width_characters() {
    let line = safe("a\u{1b}[31mred\u{0}b\u{200B}c\u{7f}");

    assert_eq!(line, "a\\u{1b}[31mred\\u{0}b\\u{200b}c\\u{7f}");
  }

  #[test]
  fn keeps_only_the_last_non_blank_line_of_a_multi_line_chunk() {
    let line = safe("first line\nsecond line\n\n  \n");

    assert_eq!(line, "second line");
  }

  #[test]
  fn escapes_a_carriage_return_that_would_overwrite_the_line() {
    let line = safe("visible\rhidden overwrite");

    assert!(!line.contains('\r'), "{line}");
  }

  #[test]
  fn shows_the_replacement_character_for_non_utf8_bytes() {
    let raw = String::from_utf8_lossy(&[b'b', b'a', b'd', 0xff, 0xfe, b'!']).to_string();

    assert_eq!(safe(&raw), "bad\u{fffd}\u{fffd}!");
  }

  #[test]
  fn does_not_let_an_invisible_character_hide_a_known_secret() {
    let line = safe(&format!("{ADMIN_TOKEN}\u{200B}{ADMIN_TOKEN}"));

    assert!(!line.contains(ADMIN_TOKEN), "{line}");
  }

  #[test]
  fn returns_an_empty_line_for_blank_output() {
    assert_eq!(safe("  \n\n"), "");
  }

  #[test]
  fn is_idempotent() {
    let once = safe(&format!("Bearer abcdefghijklmnop1234567890 /Users/jdoe/x \u{202E} {ADMIN_TOKEN}"));

    assert_eq!(safe(&once), once);
  }
}
