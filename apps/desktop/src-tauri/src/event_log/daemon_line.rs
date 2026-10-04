use super::event::{DaemonLineFields, DaemonTextClass, DesktopEvent};
use super::field::{CatalogueId, Count, DaemonMessage, KnownCode, KnownErrorName, Level, Opaque, SessionId, ShortId, StackFrames, Stream, Ts};
use super::salt::Salt;
use serde_json::{Map, Value};

const MAX_LINE_BYTES: usize = 64 * 1024;
const BOOT_REFUSAL_PREFIX: &str = "openfleet: refusing to boot";
const NODE_FATAL_PREFIXES: [&str; 5] = ["node:", "Node.js v", "FATAL ERROR:", "<--- ", "at "];
const BUNDLE_FILE_NAME: &str = "daemon.mjs";
const MESSAGE_CATALOGUE: &str = include_str!("../../daemon_messages.txt");

/// Joins the chunks of one daemon stream into lines and projects each line onto the allowlisted event.
/// A line longer than 64 KiB keeps its first 64 KiB for classification and tagging; the rest is dropped as it arrives.
pub struct DaemonLineAssembler {
  stream: Stream,
  pending: Vec<u8>,
  has_overflowed: bool,
}

impl DaemonLineAssembler {
  pub fn new(stream: Stream) -> Self {
    Self { stream, pending: Vec::new(), has_overflowed: false }
  }

  /// Returns the events of every line the chunk completes; an unfinished line waits for the next chunk.
  pub fn push_chunk(&mut self, chunk: &[u8], salt: Option<&Salt>) -> Vec<DesktopEvent> {
    let mut events = Vec::new();
    let mut remaining = chunk;
    while let Some(newline_at) = remaining.iter().position(|byte| *byte == b'\n') {
      self.append(&remaining[..newline_at]);
      remaining = &remaining[newline_at + 1..];
      events.extend(self.finish_line(salt));
    }
    self.append(remaining);
    events
  }

  /// Returns the event of the unfinished line, for a stream that ended without a final newline.
  pub fn flush(&mut self, salt: Option<&Salt>) -> Option<DesktopEvent> {
    self.finish_line(salt)
  }

  fn append(&mut self, bytes: &[u8]) {
    let room_left = MAX_LINE_BYTES - self.pending.len();
    let does_not_fit = bytes.len() > room_left;
    self.pending.extend_from_slice(&bytes[..bytes.len().min(room_left)]);
    self.has_overflowed |= does_not_fit;
  }

  fn finish_line(&mut self, salt: Option<&Salt>) -> Option<DesktopEvent> {
    let line = std::mem::take(&mut self.pending);
    let was_cut = std::mem::take(&mut self.has_overflowed);
    let line_without_carriage_return = line.strip_suffix(b"\r").unwrap_or(&line);
    if line_without_carriage_return.is_empty() {
      return None;
    }
    let event = if was_cut { unstructured_text(self.stream, line_without_carriage_return, salt) } else { project_line(self.stream, line_without_carriage_return, salt) };
    Some(event)
  }
}

fn project_line(stream: Stream, line: &[u8], salt: Option<&Salt>) -> DesktopEvent {
  let record = std::str::from_utf8(line).ok().and_then(|text| serde_json::from_str::<Value>(text).ok());
  match record {
    Some(Value::Object(fields)) => DesktopEvent::DaemonLine(project_record(&fields, stream, salt)),
    _ => unstructured_text(stream, line, salt),
  }
}

fn unstructured_text(stream: Stream, line: &[u8], salt: Option<&Salt>) -> DesktopEvent {
  DesktopEvent::DaemonText { stream, class: text_class_of(line), text: Opaque::of(line, salt) }
}

fn text_class_of(line: &[u8]) -> DaemonTextClass {
  let Some(text) = std::str::from_utf8(line).ok().map(str::trim_start) else { return DaemonTextClass::Other };
  let is_boot_refusal = text.starts_with(BOOT_REFUSAL_PREFIX);
  let is_node_fatal = NODE_FATAL_PREFIXES.iter().any(|prefix| text.starts_with(prefix));
  match (is_boot_refusal, is_node_fatal) {
    (true, _) => DaemonTextClass::BootRefusal,
    (false, true) => DaemonTextClass::NodeFatal,
    (false, false) => DaemonTextClass::Other,
  }
}

fn default_level_of(stream: Stream) -> Level {
  match stream {
    Stream::Out => Level::Info,
    Stream::Err => Level::Warn,
  }
}

fn project_record(record: &Map<String, Value>, stream: Stream, salt: Option<&Salt>) -> DaemonLineFields {
  let text_of = |key: &str| record.get(key).and_then(Value::as_str);
  let level = text_of("level").and_then(Level::parse);
  let daemon_ts = text_of("ts").and_then(Ts::parse);
  let id = text_of("id").and_then(ShortId::parse);
  let session = text_of("sessionId").and_then(SessionId::parse);
  let code = record.get("code").map(known_code_of);
  let message = record.get("msg").map(|value| message_of(value, salt));
  let error = record.get("err").and_then(Value::as_object);

  let projected_keys = [level.is_some(), daemon_ts.is_some(), id.is_some(), session.is_some(), code.is_some(), message.is_some(), error.is_some()];
  let projected_key_count = projected_keys.iter().filter(|is_projected| **is_projected).count();
  let extra_fields = Count((record.len() - projected_key_count) as u64);

  DaemonLineFields {
    level: level.unwrap_or_else(|| default_level_of(stream)),
    daemon_ts,
    id,
    session,
    code,
    message,
    error_name: error.and_then(|error| error.get("name")).map(|name| KnownErrorName::from_name(name.as_str().unwrap_or(""))),
    error_code: error.and_then(|error| error.get("code")).map(known_code_of),
    error_message: error.and_then(|error| error.get("message")).map(|message| opaque_of(message, salt)),
    frames: error.and_then(|error| error.get("stack")).and_then(Value::as_str).map(bundle_frames_of).filter(|frames| !frames.is_empty()),
    extra_fields,
  }
}

fn known_code_of(value: &Value) -> KnownCode {
  KnownCode::from_name(value.as_str().unwrap_or(""))
}

fn opaque_of(value: &Value, salt: Option<&Salt>) -> Opaque {
  match value.as_str() {
    Some(text) => Opaque::of(text.as_bytes(), salt),
    None => Opaque::of(value.to_string().as_bytes(), salt),
  }
}

fn message_of(value: &Value, salt: Option<&Salt>) -> DaemonMessage {
  let catalogue_id = value.as_str().and_then(catalogue_id_of);
  match catalogue_id {
    Some(id) => DaemonMessage::Catalogued(id),
    None => DaemonMessage::Unlisted(opaque_of(value, salt)),
  }
}

/// Each catalogue line is `<id> <literal>`: the id has no space, the literal is the rest of the line.
fn catalogue_id_of(literal: &str) -> Option<CatalogueId> {
  let entries = MESSAGE_CATALOGUE.lines().filter_map(|entry| entry.split_once(' '));
  let (id, _) = entries.into_iter().find(|(_, listed_literal)| *listed_literal == literal)?;
  Some(CatalogueId::new(id))
}

fn bundle_frames_of(stack: &str) -> StackFrames {
  let mut frames = StackFrames::empty();
  for (line, column) in stack.lines().filter_map(bundle_position_of) {
    if !frames.push(line, column) {
      break;
    }
  }
  frames
}

/// Reads `<line>:<column>` from a stack line whose file is exactly `daemon.mjs`; every other frame gives `None`.
fn bundle_position_of(stack_line: &str) -> Option<(u32, u32)> {
  let location = stack_line.trim_end().trim_end_matches(')');
  let (file_and_line, column) = location.rsplit_once(':')?;
  let (file, line) = file_and_line.rsplit_once(':')?;
  let directory = file.strip_suffix(BUNDLE_FILE_NAME)?;
  let is_whole_file_name = directory.is_empty() || directory.ends_with(['/', '(', ' ']);
  if !is_whole_file_name {
    return None;
  }
  Some((line.parse().ok()?, column.parse().ok()?))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::event_log::grammar::validate;
  use crate::event_log::salt::SALT_LEN;
  use crate::linear_growth::{assert_linear_growth, cpu_time_to_run_on_repeated, LinearGrowthBudget};

  const NOW: &str = "2026-10-04T12:00:00Z";
  const SECRET: &str = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

  fn salt() -> Salt {
    Salt::from_bytes([7; SALT_LEN])
  }

  fn tag_of(text: &str) -> String {
    Opaque::of(text.as_bytes(), Some(&salt())).to_string()
  }

  fn rendered(events: Vec<DesktopEvent>) -> Vec<String> {
    let now = Ts::parse(NOW).expect("a valid timestamp");
    events
      .into_iter()
      .map(|event| {
        let line = event.render(now);
        assert!(!line.is_rejection(), "{event:?} was rejected");
        assert_eq!(validate(event.name(), line.as_str()), Ok(()), "{line}");
        line.to_string()
      })
      .collect()
  }

  fn lines_of_chunks(stream: Stream, chunks: &[&[u8]]) -> Vec<String> {
    let mut assembler = DaemonLineAssembler::new(stream);
    let events = chunks.iter().flat_map(|chunk| assembler.push_chunk(chunk, Some(&salt()))).collect();
    rendered(events)
  }

  fn line_of(record: &str) -> String {
    let mut lines = lines_of_chunks(Stream::Out, &[format!("{record}\n").as_bytes()]);
    assert_eq!(lines.len(), 1, "{lines:?}");
    lines.remove(0)
  }

  mod a_json_record {
    use super::*;

    #[test]
    fn is_projected_field_by_field_onto_the_allowlist() {
      let record = r#"{"ts":"2026-10-04T11:59:58.123Z","level":"warn","msg":"ws: write failed","id":"0a1b2c3d","sessionId":"123e4567-e89b-42d3-a456-426614174000","code":"session_not_found","err":{"name":"TypeError","message":"boom","code":"ENOENT","stack":"TypeError: boom\n    at run (file:///opt/app/daemon.mjs:120:5)\n    at node:internal/main:1:1\n    at /opt/app/daemon.mjs:88:13"}}"#;

      let line = line_of(record);

      let expected = format!(
        "2026-10-04T11:59:58Z warn daemon_line id=0a1b2c3d session=123e4567-e89b-42d3-a456-426614174000 code=session_not_found msg=ws_write_failed err_name=TypeError err_code=ENOENT err_msg={} frames=120:5/88:13 extra_fields=0",
        tag_of("boom")
      );
      assert_eq!(line, expected);
    }

    #[test]
    fn hashes_a_message_that_is_not_in_the_catalogue() {
      let message = format!("session abc failed with {SECRET}");

      let line = line_of(&serde_json::json!({ "level": "error", "msg": message }).to_string());

      assert!(line.ends_with(&format!("msg={} extra_fields=0", tag_of(&message))), "{line}");
      assert!(!line.contains("ghp_"), "{line}");
    }

    #[test]
    fn counts_every_other_key_and_copies_none_of_them() {
      let record = serde_json::json!({ "level": "info", "msg": "ws: send failed", SECRET: "x", "step": SECRET, "detail": { "token": SECRET } });

      let line = line_of(&record.to_string());

      assert!(line.ends_with("msg=ws_send_failed extra_fields=3"), "{line}");
      assert!(!line.contains("ghp_") && !line.contains("token"), "{line}");
    }

    #[test]
    fn drops_the_error_cause_and_the_stack_text() {
      let record = serde_json::json!({ "level": "error", "msg": "x", "err": { "name": "Error", "message": "m", "stack": format!("Error: {SECRET}\n    at a (/Users/me/{SECRET}.js:1:1)"), "cause": { "message": SECRET } } });

      let line = line_of(&record.to_string());

      assert!(!line.contains("ghp_") && !line.contains("/Users"), "{line}");
      assert!(!line.contains("frames="), "{line}");
    }

    #[test]
    fn maps_an_error_name_outside_the_closed_list_to_other() {
      let record = serde_json::json!({ "level": "error", "msg": "x", "err": { "name": SECRET, "message": "", "code": "AKIAIOSFODNN7EXAMPLE" } });

      let line = line_of(&record.to_string());

      assert!(line.contains(" err_name=other err_code=other "), "{line}");
    }

    #[test]
    fn treats_a_numeric_error_code_and_a_non_string_name_as_other() {
      let record = serde_json::json!({ "level": "error", "msg": "x", "err": { "name": 5, "code": 13, "message": "" } });

      let line = line_of(&record.to_string());

      assert!(line.contains(" err_name=other err_code=other "), "{line}");
    }

    #[test]
    fn keeps_at_most_eight_frames_of_the_bundle_and_only_those() {
      let frames: Vec<String> = (1..=12).map(|number| format!("    at f{number} (/app/daemon.mjs:{number}:2)")).collect();
      let stack = format!("Error: x\n    at other (/app/not-daemon.mjs:9:9)\n    at evil (/app/xdaemon.mjs:7:7)\n{}", frames.join("\n"));
      let record = serde_json::json!({ "level": "error", "msg": "x", "err": { "name": "Error", "message": "", "stack": stack } });

      let line = line_of(&record.to_string());

      assert!(line.contains(" frames=1:2/2:2/3:2/4:2/5:2/6:2/7:2/8:2 "), "{line}");
    }

    #[test]
    fn keeps_only_the_frames_that_fit_the_value_bound() {
      let frames: Vec<String> = (0..8).map(|number| format!("    at f (/app/daemon.mjs:{}:{}))", 100_000 + number, 10_000 + number)).collect();
      let record = serde_json::json!({ "level": "error", "msg": "x", "err": { "name": "Error", "message": "", "stack": frames.join("\n") } });

      let line = line_of(&record.to_string());

      let frames_value = line.split(" frames=").nth(1).and_then(|rest| rest.split(' ').next()).unwrap_or("");
      assert!(!frames_value.is_empty() && frames_value.len() <= 64 && frames_value.starts_with("100000:10000/"), "{line}");
    }

    #[test]
    fn falls_back_to_the_desktop_clock_and_the_stream_level_for_a_bad_ts_and_level() {
      let record = r#"{"ts":"yesterday","level":"LOUD","msg":"ws: write failed"}"#;
      let mut assembler = DaemonLineAssembler::new(Stream::Err);

      let lines = rendered(assembler.push_chunk(format!("{record}\n").as_bytes(), Some(&salt())));

      assert_eq!(lines, vec![format!("{NOW} warn daemon_line msg=ws_write_failed extra_fields=2")]);
    }

    #[test]
    fn counts_a_malformed_id_and_session_id_instead_of_copying_them() {
      let record = serde_json::json!({ "level": "info", "msg": "ws: write failed", "id": SECRET, "sessionId": "not-a-uuid" });

      let line = line_of(&record.to_string());

      assert!(line.ends_with("msg=ws_write_failed extra_fields=2") && !line.contains("id="), "{line}");
    }

    #[test]
    fn hashes_a_message_that_is_not_a_string() {
      let line = line_of(r#"{"level":"info","msg":{"a":1}}"#);

      assert!(line.contains(&format!("msg={}", tag_of(r#"{"a":1}"#))), "{line}");
    }

    #[test]
    fn leaves_the_tag_out_when_the_install_has_no_salt() {
      let mut assembler = DaemonLineAssembler::new(Stream::Out);

      let lines = rendered(assembler.push_chunk(b"{\"level\":\"info\",\"msg\":\"hello\"}\n", None));

      assert_eq!(lines, vec![format!("{NOW} info daemon_line msg=[text:5] extra_fields=0")]);
    }

    #[test]
    fn renders_the_same_line_for_the_same_input_and_salt() {
      let record = r#"{"level":"info","msg":"same"}"#;

      assert_eq!(line_of(record), line_of(record));
    }

    #[test]
    fn stays_grammatical_for_hostile_keys_values_and_characters() {
      let hostile = serde_json::json!({
        "level": "info\n",
        "msg": "日本語 \u{202e} \"quoted\" = x\t\0",
        "id": "0a1b2c3d\n",
        "code": "a b=c",
        "err": { "name": "x y", "message": "😀", "code": "{}", "stack": "\n\n" },
        "k y=\n": 1,
      });

      let line = line_of(&hostile.to_string());

      assert!(line.starts_with(&format!("{NOW} info daemon_line")), "{line}");
    }
  }

  mod a_text_that_is_not_a_json_record {
    use super::*;

    #[test]
    fn becomes_a_length_and_a_tag() {
      let text = format!("plain {SECRET}");

      let lines = lines_of_chunks(Stream::Out, &[format!("{text}\n").as_bytes()]);

      assert_eq!(lines, vec![format!("{NOW} info daemon_text stream=out class=other text={}", tag_of(&text))]);
    }

    #[test]
    fn is_classified_as_a_boot_refusal_by_the_exact_prefix() {
      let lines = lines_of_chunks(Stream::Err, &[b"openfleet: refusing to boot: port 7331 is already in use\n"]);

      assert!(lines[0].starts_with(&format!("{NOW} warn daemon_text stream=err class=boot_refusal text=[text:")), "{lines:?}");
    }

    #[test]
    fn is_not_a_boot_refusal_when_the_prefix_is_only_inside() {
      let lines = lines_of_chunks(Stream::Err, &[b"x openfleet: refusing to boot\n"]);

      assert!(lines[0].contains("class=other"), "{lines:?}");
    }

    #[test]
    fn is_classified_as_a_node_fatal_for_the_runtime_crash_banners() {
      for banner in ["node:internal/modules/run_main:123", "Node.js v22.1.0", "FATAL ERROR: Reached heap limit", "    at run (file:///app/daemon.mjs:1:1)"] {
        let lines = lines_of_chunks(Stream::Err, &[format!("{banner}\n").as_bytes()]);

        assert!(lines[0].contains("class=node_fatal"), "{banner}: {lines:?}");
      }
    }

    #[test]
    fn covers_json_that_is_not_an_object_or_not_complete() {
      for text in ["[1,2]", "42", "\"text\"", "null", "{\"a\":1} trailing", "{\"level\":\"info\",\"msg\":\"cut...[truncated 9000 chars]", "{"] {
        let lines = lines_of_chunks(Stream::Out, &[format!("{text}\n").as_bytes()]);

        assert!(lines[0].contains(" daemon_text "), "{text}: {lines:?}");
      }
    }

    #[test]
    fn covers_json_nested_past_the_parser_limit() {
      let deep = format!("{}{}", "[".repeat(5_000), "]".repeat(5_000));

      let lines = lines_of_chunks(Stream::Out, &[format!("{{\"a\":{deep}}}\n").as_bytes()]);

      assert_eq!(lines.len(), 1);
      assert!(lines[0].contains(" daemon_text "), "{lines:?}");
    }

    #[test]
    fn hashes_the_raw_bytes_of_a_line_that_is_not_utf8() {
      let bytes = [0xff, 0xfe, b'x', b'\n'];

      let lines = lines_of_chunks(Stream::Out, &[&bytes]);

      let expected = Opaque::of(&bytes[..3], Some(&salt())).to_string();
      assert_eq!(lines, vec![format!("{NOW} info daemon_text stream=out class=other text={expected}")]);
    }
  }

  mod the_line_assembler {
    use super::*;

    const RECORD: &str = r#"{"level":"info","msg":"ws: write failed"}"#;
    const RECORD_LINE: &str = "2026-10-04T12:00:00Z info daemon_line msg=ws_write_failed extra_fields=0";

    #[test]
    fn joins_a_record_split_across_chunks() {
      let bytes = format!("{RECORD}\n");
      let (first, second) = bytes.as_bytes().split_at(17);

      let lines = lines_of_chunks(Stream::Out, &[first, second]);

      assert_eq!(lines, vec![RECORD_LINE]);
    }

    #[test]
    fn splits_a_chunk_holding_several_records() {
      let chunk = format!("{RECORD}\n{RECORD}\n{RECORD}\n");

      assert_eq!(lines_of_chunks(Stream::Out, &[chunk.as_bytes()]), vec![RECORD_LINE; 3]);
    }

    #[test]
    fn treats_a_carriage_return_before_the_newline_as_part_of_the_separator() {
      assert_eq!(lines_of_chunks(Stream::Out, &[format!("{RECORD}\r\n").as_bytes()]), vec![RECORD_LINE]);
    }

    #[test]
    fn skips_blank_lines() {
      assert_eq!(lines_of_chunks(Stream::Out, &[format!("\n\r\n{RECORD}\n\n").as_bytes()]), vec![RECORD_LINE]);
    }

    #[test]
    fn holds_an_unfinished_line_until_a_newline_or_a_flush() {
      let mut assembler = DaemonLineAssembler::new(Stream::Out);

      let before_the_newline = assembler.push_chunk(RECORD.as_bytes(), Some(&salt()));
      let on_flush = assembler.flush(Some(&salt()));

      assert!(before_the_newline.is_empty());
      assert_eq!(rendered(on_flush.into_iter().collect()), vec![RECORD_LINE]);
      assert!(assembler.flush(Some(&salt())).is_none());
    }

    #[test]
    fn reduces_a_line_over_64_kib_to_the_tag_of_its_first_64_kib_and_resumes_after_it() {
      let long_line = format!("{{\"msg\":\"{}\"}}\n", "a".repeat(100_000));
      let next_record = format!("{RECORD}\n");
      let chunks: [&[u8]; 3] = [&long_line.as_bytes()[..30_000], &long_line.as_bytes()[30_000..], next_record.as_bytes()];

      let lines = lines_of_chunks(Stream::Out, &chunks);

      let head = &long_line.as_bytes()[..64 * 1024];
      let expected_head = format!("{NOW} info daemon_text stream=out class=other text={}", Opaque::of(head, Some(&salt())));
      assert_eq!(lines, vec![expected_head, RECORD_LINE.to_string()]);
    }

    #[test]
    fn keeps_a_line_of_exactly_64_kib_structured() {
      let filler = "a".repeat(64 * 1024 - r#"{"msg":""}"#.len());
      let line = format!("{{\"msg\":\"{filler}\"}}\n");

      let lines = lines_of_chunks(Stream::Out, &[line.as_bytes()]);

      assert!(lines[0].contains(" daemon_line "), "{}", &lines[0]);
    }

    #[test]
    fn never_prints_a_secret_that_straddles_a_chunk_boundary() {
      let text = format!("noise {SECRET} noise\n");
      let (first, second) = text.as_bytes().split_at(12);

      let lines = lines_of_chunks(Stream::Out, &[first, second]);

      assert!(lines.iter().all(|line| !line.contains("ghp_")), "{lines:?}");
    }

    #[test]
    fn costs_a_linear_cpu_time_on_hostile_input() {
      let salt = salt();
      for unit in ["a", "[", "\"", "\\u0000", "{\"k\":1,"] {
        let measure = cpu_time_to_run_on_repeated(unit, |text| {
          let mut assembler = DaemonLineAssembler::new(Stream::Out);
          std::hint::black_box(assembler.push_chunk(text.as_bytes(), Some(&salt)));
          std::hint::black_box(assembler.flush(Some(&salt)));
        });

        assert_linear_growth(measure, &LinearGrowthBudget::between(16 * 1024, 1 << 20));
      }
    }

    #[test]
    fn costs_a_linear_cpu_time_on_many_tiny_lines() {
      let salt = salt();
      let measure = cpu_time_to_run_on_repeated("x\n", |text| {
        let mut assembler = DaemonLineAssembler::new(Stream::Out);
        std::hint::black_box(assembler.push_chunk(text.as_bytes(), Some(&salt)));
      });

      assert_linear_growth(measure, &LinearGrowthBudget::between(16 * 1024, 64 * 1024));
    }
  }

  mod the_message_catalogue {
    use super::*;

    #[test]
    fn renders_every_listed_literal_as_its_snake_case_id() {
      let entries: Vec<(&str, &str)> = MESSAGE_CATALOGUE.lines().filter_map(|entry| entry.split_once(' ')).collect();
      assert!(entries.len() >= 10, "the catalogue lists {} messages", entries.len());

      for (id, literal) in entries {
        let line = line_of(&serde_json::json!({ "level": "warn", "msg": literal }).to_string());

        assert!(line.contains(&format!(" msg={id} ")), "{literal}: {line}");
        assert!(id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'), "{id}");
      }
    }

    #[test]
    fn lists_each_id_and_each_literal_once() {
      let entries: Vec<(&str, &str)> = MESSAGE_CATALOGUE.lines().filter_map(|entry| entry.split_once(' ')).collect();
      let mut ids: Vec<&str> = entries.iter().map(|(id, _)| *id).collect();
      let mut literals: Vec<&str> = entries.iter().map(|(_, literal)| *literal).collect();
      ids.sort_unstable();
      literals.sort_unstable();
      let (id_count, literal_count) = (ids.len(), literals.len());
      ids.dedup();
      literals.dedup();

      assert_eq!((ids.len(), literals.len()), (id_count, literal_count));
    }
  }
}
