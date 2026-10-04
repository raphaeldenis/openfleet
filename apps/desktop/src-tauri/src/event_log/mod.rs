//! The closed vocabulary of the desktop log: every field a log line can hold is one of these types, and none holds free text.
//! A line is a `DesktopEvent` rendered into a `SanitizedLine` that has passed the grammar.
#![allow(dead_code, unused_imports)]

mod event;
mod field;
mod grammar;
mod hash;
mod salt;

pub use event::{DaemonLineFields, DaemonTextClass, DesktopEvent, ForeignTarget, SpawnFailure};
pub use field::{
  Bool, Bytes, Count, DaemonPhase, DurationMs, EventName, ExitCode, IoFailure, IoKind, JsonFailure, KnownCode, KnownPaths, Level, Opaque, PathClass, PathSource,
  Pid, SessionId, ShortId, StopOutcome, Stream, Ts,
};
pub use grammar::{allowed_keys_of, validate, GrammarViolation, SanitizedLine};
pub use hash::Hash8;
pub use salt::{Salt, SALT_FILE_NAME};
