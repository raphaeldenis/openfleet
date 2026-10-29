# New projects start on the worker permission profile

Children start on the `worker` permission profile: edits allowed inside their own worktree, single-line test and commit commands allowed, force-push denied, everything else gated. The alternative, gating every call as the harness does today, floods the inbox and trains humans to approve blindly. Raphaël confirmed this posture on 2026-10-29.
