//! The closed vocabulary of the desktop log: every field a log line can hold is one of these types, and none holds free text.
#![allow(dead_code, unused_imports)]

mod field;
mod hash;
mod salt;

pub use field::{
  Bool, Bytes, Count, DaemonPhase, DurationMs, EventName, ExitCode, IoFailure, IoKind, JsonFailure, KnownCode, KnownPaths, Level, Opaque, PathClass, PathSource,
  Pid, SessionId, ShortId, StopOutcome, Stream, Ts,
};
pub use hash::Hash8;
pub use salt::{Salt, SALT_FILE_NAME};
