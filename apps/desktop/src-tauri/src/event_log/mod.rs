//! The closed vocabulary of the desktop log: every field a log line can hold is one of these types, and none holds free text.
//! A line is a `DesktopEvent` rendered into a `SanitizedLine` that has passed the grammar.
#![allow(dead_code, unused_imports)]

mod daemon_line;
mod event;
mod field;
mod foreign;
mod grammar;
mod hash;
#[cfg(test)]
mod hostile_corpus;
mod salt;

pub use daemon_line::DaemonLineAssembler;
pub use event::{DaemonLineFields, DaemonTextClass, DesktopEvent, ForeignTarget, SpawnFailure};
pub use field::{
  Bool, Bytes, CatalogueId, Count, DaemonMessage, DaemonPhase, DurationMs, EventName, ExitCode, IoFailure, IoKind, JsonFailure, KnownCode, KnownErrorName,
  KnownPaths, Level, Opaque, PathClass, PathSource, Pid, SessionId, ShortId, StackFrames, StopOutcome, Stream, Ts,
};
pub use foreign::{install_foreign_logger, AllowlistLogger, FOREIGN_RECORDS};
pub use grammar::{allowed_keys_of, validate, GrammarViolation, SanitizedLine};
pub use hash::Hash8;
pub use salt::{Salt, SALT_FILE_NAME};
