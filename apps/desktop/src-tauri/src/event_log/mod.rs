//! The closed vocabulary of the desktop log: every field a log line can hold is one of these types, and none holds free text.
//! A line is a `DesktopEvent` rendered into a `SanitizedLine` that has passed the grammar.
#![allow(dead_code, unused_imports)]

#[cfg(test)]
mod arch_test;
mod daemon_line;
mod event;
mod field;
mod foreign;
mod grammar;
mod hash;
#[cfg(test)]
mod hostile_corpus;
mod salt;
#[cfg(test)]
pub(crate) mod synthetic_tokens;

pub use daemon_line::{is_node_fatal_line, project_daemon_records, DaemonLineAssembler, ProjectedRecord};
pub use event::{DaemonLineFields, DaemonTextClass, DesktopEvent, ForeignTarget, LineBuilder, SpawnFailure};
pub use field::{
  Bool, CatalogueId, Count, DaemonMessage, DaemonPhase, DurationMs, EventName, ExitCode, IoFailure, IoKind, JsonFailure, KnownCode, KnownErrorName,
  KnownPaths, Level, Literal, LogValue, Opaque, PathClass, PathSource, Pid, SessionId, ShortId, StackFrames, StopOutcome, Stream, Ts,
};
pub use foreign::{install_foreign_logger, AllowlistLogger, FOREIGN_RECORDS};
pub use grammar::{fields_of, validate, FieldKind, FieldSpec, GrammarViolation, SanitizedLine, MAX_LINE_BYTES, MAX_VALUE_BYTES};
pub use hash::Hash8;
pub use salt::{Salt, SALT_FILE_NAME};
