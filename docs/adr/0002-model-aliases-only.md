---
status: accepted
date: 2026-10-29
---

# Profiles name model aliases, never exact model ids (design decision D12)

Profiles and spawn calls use the rungs haiku, sonnet, opus and fable, resolved through the model table at launch, with an allowed-rung list per role and every escalation logged. Exact ids would pin each profile to a model that is retired. The Scape fleet works this way today: note #102 allows aliases only. Opus and fable are reached only by a logged escalation.

Source: already practised by the Scape fleet (notes #102 Standards — Rôles, #46, #84) and the team pack design, section D12 (`openfleet/specs/2026-09-30-team-pack-design.md` under `~/Documents/superpowers/`).
