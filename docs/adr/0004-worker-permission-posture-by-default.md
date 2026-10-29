---
status: accepted
date: 2026-10-29
---

# New projects start on the worker permission profile (design decision D7)

The design specifies that children start on the `worker` permission profile (D7): edits allowed inside their own worktree, single-line test and commit commands allowed, force-push denied, everything else gated. The alternative, gating every call as the harness does today, floods the inbox and trains humans to approve blindly. Confirmed by Raphaël on 2026-10-29 (07:45Z, "ok all" on the worker posture question relayed by Forge).
