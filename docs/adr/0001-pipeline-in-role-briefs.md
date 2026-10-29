---
status: accepted
date: 2026-10-29
---

# The pipeline lives in prose in the role briefs (design decision D9)

The delivery pipeline (PM, ARCHITECT, DEV, UI smoke, QE, QA, Design QA, ponytail, adversarial go/no-go, draft PR) is written as prose and tables in the role briefs of the team pack, not as an executable `pipeline.json`. OpenFleet has no task entity to hang loop counters or step state on, so an executor would have nothing to execute against. The Lead follows the briefs, and an executor is reconsidered once a task entity exists (TASK-ENTITY01).

Source: already practised by the Scape fleet (notes #102 Standards — Rôles, #46, #84) and the team pack design, section D9 (`openfleet/specs/2026-09-30-team-pack-design.md` under `~/Documents/superpowers/`).
