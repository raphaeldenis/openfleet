#[cfg(target_os = "macos")]
mod macos;

use serde::{Deserialize, Serialize};

const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 300;
const MAX_ROUTE_CHARS: usize = 200;

/// The event the webview listens to: a notification was clicked and carries the route to open.
pub const CLICK_EVENT_NAME: &str = "native-notification-clicked";

#[derive(Debug, Deserialize)]
pub struct NotificationRequest {
  pub title: String,
  pub body: String,
  pub route: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClickedRoute {
  pub route: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DeliveryStatus {
  Delivered,
  PermissionDenied,
  Unsupported,
}

/// What the webview learns about a notification request; a refusal by the system is an outcome, never an error.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NotificationOutcome {
  Delivered,
  PermissionDenied,
  Unsupported,
}

/// The system notification centre: the only place a banner is raised.
pub trait NotificationCenter {
  fn deliver(&self, request: &NotificationRequest) -> Result<DeliveryStatus, String>;
}

pub fn show_notification(center: &impl NotificationCenter, request: &NotificationRequest) -> Result<NotificationOutcome, String> {
  validate(request)?;
  let status = center.deliver(request)?;
  Ok(match status {
    DeliveryStatus::Delivered => NotificationOutcome::Delivered,
    DeliveryStatus::PermissionDenied => NotificationOutcome::PermissionDenied,
    DeliveryStatus::Unsupported => NotificationOutcome::Unsupported,
  })
}

fn validate(request: &NotificationRequest) -> Result<(), String> {
  let has_title = !request.title.trim().is_empty();
  if !has_title {
    return Err("a notification needs a title".to_string());
  }
  let is_title_short_enough = request.title.chars().count() <= MAX_TITLE_CHARS;
  if !is_title_short_enough {
    return Err(format!("the title is longer than {MAX_TITLE_CHARS} characters"));
  }
  let is_body_short_enough = request.body.chars().count() <= MAX_BODY_CHARS;
  if !is_body_short_enough {
    return Err(format!("the body is longer than {MAX_BODY_CHARS} characters"));
  }
  if !is_internal_route(&request.route) {
    return Err("the route must be a path inside the app".to_string());
  }
  Ok(())
}

/// An in-app path such as `/session/abc`: a single leading slash, no scheme, no backslash, no control character.
pub fn is_internal_route(route: &str) -> bool {
  let starts_inside_the_app = route.starts_with('/') && !route.starts_with("//");
  let is_short_enough = route.chars().count() <= MAX_ROUTE_CHARS;
  let has_only_plain_characters = !route.chars().any(|character| character.is_control() || character == '\\');
  starts_inside_the_app && is_short_enough && has_only_plain_characters
}

/// The route a clicked notification asks the webview to open; anything that is not an in-app path is ignored.
pub fn clicked_route_of(stored_route: Option<&str>) -> Option<ClickedRoute> {
  let route = stored_route?;
  is_internal_route(route).then(|| ClickedRoute { route: route.to_string() })
}

const IDENTIFIER_SEPARATOR: char = '|';

/// The system identifier of a banner: a sequence number keeps banners apart, the route rides after the separator.
pub fn request_identifier_of(sequence: u64, route: &str) -> String {
  format!("{sequence}{IDENTIFIER_SEPARATOR}{route}")
}

/// The route stored in a banner identifier; `None` when the identifier carries none.
pub fn route_of_identifier(identifier: &str) -> Option<&str> {
  identifier.split_once(IDENTIFIER_SEPARATOR).map(|(_sequence, route)| route)
}

/// The number the Dock tile shows; `None` clears it.
pub fn dock_badge_of(count: u32) -> Option<i64> {
  let is_cleared = count == 0;
  if is_cleared {
    return None;
  }
  Some(i64::from(count))
}

#[cfg(target_os = "macos")]
pub use macos::{install_click_handler, MacNotificationCenter};

/// Platforms without a native centre report `unsupported` so the caller never has to catch an error.
#[cfg(not(target_os = "macos"))]
pub struct MacNotificationCenter;

#[cfg(not(target_os = "macos"))]
impl NotificationCenter for MacNotificationCenter {
  fn deliver(&self, _request: &NotificationRequest) -> Result<DeliveryStatus, String> {
    Ok(DeliveryStatus::Unsupported)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;

  struct FakeCenter {
    answer: Result<DeliveryStatus, String>,
    delivered_titles: RefCell<Vec<String>>,
  }

  impl FakeCenter {
    fn answering(answer: Result<DeliveryStatus, String>) -> Self {
      Self { answer, delivered_titles: RefCell::new(Vec::new()) }
    }
  }

  impl NotificationCenter for FakeCenter {
    fn deliver(&self, request: &NotificationRequest) -> Result<DeliveryStatus, String> {
      self.delivered_titles.borrow_mut().push(request.title.clone());
      self.answer.clone()
    }
  }

  fn request(title: &str, body: &str, route: &str) -> NotificationRequest {
    NotificationRequest { title: title.to_string(), body: body.to_string(), route: route.to_string() }
  }

  #[test]
  fn a_valid_request_reaches_the_centre_and_reports_delivered() {
    let center = FakeCenter::answering(Ok(DeliveryStatus::Delivered));

    let outcome = show_notification(&center, &request("Gimli finished", "Bash", "/session/abc"));

    assert_eq!(outcome, Ok(NotificationOutcome::Delivered));
    assert_eq!(*center.delivered_titles.borrow(), vec!["Gimli finished".to_string()]);
  }

  #[test]
  fn a_denied_permission_is_an_outcome_not_an_error() {
    let center = FakeCenter::answering(Ok(DeliveryStatus::PermissionDenied));

    let outcome = show_notification(&center, &request("Gimli finished", "", "/session/abc"));

    assert_eq!(outcome, Ok(NotificationOutcome::PermissionDenied));
  }

  #[test]
  fn a_centre_failure_is_reported_to_the_caller() {
    let center = FakeCenter::answering(Err("boom".to_string()));

    let outcome = show_notification(&center, &request("Gimli finished", "", "/inbox"));

    assert_eq!(outcome, Err("boom".to_string()));
  }

  #[test]
  fn an_invalid_request_never_reaches_the_centre() {
    let center = FakeCenter::answering(Ok(DeliveryStatus::Delivered));
    let too_long_title = "t".repeat(MAX_TITLE_CHARS + 1);
    let too_long_body = "b".repeat(MAX_BODY_CHARS + 1);

    let outcomes = [
      show_notification(&center, &request("", "body", "/inbox")),
      show_notification(&center, &request("   ", "body", "/inbox")),
      show_notification(&center, &request(&too_long_title, "body", "/inbox")),
      show_notification(&center, &request("title", &too_long_body, "/inbox")),
      show_notification(&center, &request("title", "body", "https://evil.example")),
    ];

    assert!(outcomes.iter().all(Result::is_err));
    assert!(center.delivered_titles.borrow().is_empty());
  }

  #[test]
  fn limits_are_inclusive() {
    let center = FakeCenter::answering(Ok(DeliveryStatus::Delivered));
    let longest_title = "t".repeat(MAX_TITLE_CHARS);
    let longest_body = "b".repeat(MAX_BODY_CHARS);

    let outcome = show_notification(&center, &request(&longest_title, &longest_body, "/inbox"));

    assert_eq!(outcome, Ok(NotificationOutcome::Delivered));
  }

  #[test]
  fn only_in_app_paths_are_routes() {
    for route in ["/inbox", "/session/abc", "/manager/m1?tab=notes", "/"] {
      assert!(is_internal_route(route), "{route}");
    }
    let too_long_route = format!("/{}", "r".repeat(MAX_ROUTE_CHARS));
    for route in ["", "inbox", "//evil.example", "https://evil.example", "javascript:alert(1)", "/a\\b", "/a\nb", too_long_route.as_str()] {
      assert!(!is_internal_route(route), "{route}");
    }
  }

  #[test]
  fn a_clicked_notification_hands_its_route_to_the_webview() {
    assert_eq!(clicked_route_of(Some("/session/abc")), Some(ClickedRoute { route: "/session/abc".to_string() }));
  }

  #[test]
  fn a_clicked_notification_without_a_safe_route_opens_nothing() {
    assert_eq!(clicked_route_of(None), None);
    assert_eq!(clicked_route_of(Some("https://evil.example")), None);
  }

  #[test]
  fn a_banner_identifier_carries_its_route_back() {
    let identifier = request_identifier_of(7, "/session/abc?tab=notes|x");

    assert_eq!(route_of_identifier(&identifier), Some("/session/abc?tab=notes|x"));
  }

  #[test]
  fn banners_with_the_same_route_get_distinct_identifiers() {
    assert_ne!(request_identifier_of(1, "/inbox"), request_identifier_of(2, "/inbox"));
  }

  #[test]
  fn an_identifier_without_a_route_yields_none() {
    assert_eq!(route_of_identifier("no-separator"), None);
  }

  #[test]
  fn a_platform_without_a_centre_reports_unsupported() {
    let center = FakeCenter::answering(Ok(DeliveryStatus::Unsupported));

    let outcome = show_notification(&center, &request("Gimli finished", "", "/inbox"));

    assert_eq!(outcome, Ok(NotificationOutcome::Unsupported));
  }

  #[test]
  fn the_dock_badge_shows_the_count_and_zero_clears_it() {
    assert_eq!(dock_badge_of(0), None);
    assert_eq!(dock_badge_of(3), Some(3));
    assert_eq!(dock_badge_of(u32::MAX), Some(i64::from(u32::MAX)));
  }

  #[test]
  fn outcomes_serialize_as_a_status_tag() {
    let delivered = serde_json::to_value(NotificationOutcome::Delivered).unwrap();
    let denied = serde_json::to_value(NotificationOutcome::PermissionDenied).unwrap();
    let unsupported = serde_json::to_value(NotificationOutcome::Unsupported).unwrap();

    assert_eq!(delivered, serde_json::json!({ "status": "delivered" }));
    assert_eq!(denied, serde_json::json!({ "status": "permissionDenied" }));
    assert_eq!(unsupported, serde_json::json!({ "status": "unsupported" }));
  }
}
