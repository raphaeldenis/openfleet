---
status: proposed
date: 2026-10-29
---

# Raphaël-specific content stays out of the default pack (design decision D11)

Content tied to one person or project (Keycloak impersonation, Looker notes, model pins, Jira playbooks, local paths) lives as overlay notes of that project, and the pack has no `extends` chain in v1. A second pack extending the default would add a versioning problem before a second pack exists. Awaiting Raphaël's confirmation.
