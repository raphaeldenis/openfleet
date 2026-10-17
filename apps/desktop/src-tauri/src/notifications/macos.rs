use super::{clicked_route_of, request_identifier_of, route_of_identifier, ClickedRoute, DeliveryStatus, NotificationCenter, NotificationRequest};
use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
  UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
  UNUserNotificationCenterDelegate,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// The first request waits for a human answering the system prompt.
const SYSTEM_ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

static NEXT_BANNER_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// The system centre refuses to exist outside an `.app` bundle (`tauri dev`, `cargo test`) and raises an exception instead of an error.
fn is_running_from_app_bundle() -> bool {
  let bundle = NSBundle::mainBundle();
  let has_identifier = bundle.bundleIdentifier().is_some();
  let is_app_bundle = bundle.bundlePath().to_string().ends_with(".app");
  has_identifier && is_app_bundle
}

struct DelegateState {
  on_click: Box<dyn Fn(ClickedRoute) + Send + Sync>,
}

define_class!(
  // SAFETY: NSObject has no subclassing requirements and the delegate implements no `Drop`.
  #[unsafe(super(NSObject))]
  #[name = "OpenFleetNotificationDelegate"]
  #[ivars = DelegateState]
  struct NotificationDelegate;

  unsafe impl NSObjectProtocol for NotificationDelegate {}

  unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
    #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
    fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
      completion.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
    }

    #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
    fn did_receive_response(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, completion: &DynBlock<dyn Fn()>) {
      let identifier = response.notification().request().identifier().to_string();
      let clicked = clicked_route_of(route_of_identifier(&identifier));
      if let Some(clicked) = clicked {
        (self.ivars().on_click)(clicked);
      }
      completion.call(());
    }
  }
);

impl NotificationDelegate {
  fn with_state(state: DelegateState) -> Retained<Self> {
    let this = Self::alloc().set_ivars(state);
    unsafe { msg_send![super(this), init] }
  }
}

/// Registers the handler that runs when the user clicks a banner. Does nothing outside an `.app` bundle.
pub fn install_click_handler(on_click: impl Fn(ClickedRoute) + Send + Sync + 'static) {
  if !is_running_from_app_bundle() {
    return;
  }
  let delegate = NotificationDelegate::with_state(DelegateState { on_click: Box::new(on_click) });
  UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
  // The centre holds its delegate weakly: the delegate lives as long as the process.
  std::mem::forget(delegate);
}

pub struct MacNotificationCenter;

impl NotificationCenter for MacNotificationCenter {
  fn deliver(&self, request: &NotificationRequest) -> Result<DeliveryStatus, String> {
    if !is_running_from_app_bundle() {
      return Ok(DeliveryStatus::Unsupported);
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let is_permission_granted = ask_permission(&center)?;
    if !is_permission_granted {
      return Ok(DeliveryStatus::PermissionDenied);
    }
    add_banner(&center, request)?;
    Ok(DeliveryStatus::Delivered)
  }
}

/// Asks the system once; it answers at once when the human already decided.
fn ask_permission(center: &UNUserNotificationCenter) -> Result<bool, String> {
  let (sender, receiver) = mpsc::channel();
  let completion = RcBlock::new(move |is_granted: Bool, _error: *mut NSError| {
    let _ = sender.send(is_granted.as_bool());
  });
  let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Badge | UNAuthorizationOptions::Sound;
  center.requestAuthorizationWithOptions_completionHandler(options, &completion);
  receiver.recv_timeout(SYSTEM_ANSWER_TIMEOUT).map_err(|_| "the system did not answer the notification permission request".to_string())
}

fn add_banner(center: &UNUserNotificationCenter, request: &NotificationRequest) -> Result<(), String> {
  let content = UNMutableNotificationContent::new();
  content.setTitle(&NSString::from_str(&request.title));
  content.setBody(&NSString::from_str(&request.body));
  let sequence = NEXT_BANNER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
  let identifier = NSString::from_str(&request_identifier_of(sequence, &request.route));
  let banner = UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);

  let (sender, receiver) = mpsc::channel();
  let completion = RcBlock::new(move |error: *mut NSError| {
    let failure = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
    let _ = sender.send(failure);
  });
  center.addNotificationRequest_withCompletionHandler(&banner, Some(&completion));
  let failure = receiver.recv_timeout(SYSTEM_ANSWER_TIMEOUT).map_err(|_| "the system did not confirm the notification".to_string())?;
  failure.map_or(Ok(()), Err)
}
