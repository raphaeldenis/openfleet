# Governance queue: the human API

A manager files proposals (a law, a standing permission, a resource access) through its MCP tools. A proposal grants nothing while it is pending. The laws and permissions in force stay the prose of the mission note, which the daemon never writes.

Only the human decides, with the daemon admin token. Every route below sits under `/api`: the MCP token of a session is answered `401 unauthorized`, and no decision route exists under `/mcp`.

## Routes

| Route | Answer | Errors |
|---|---|---|
| `GET /api/governance/proposals?status=` | The proposals of every manager in that status. `status` is `pending` (default), `approved`, `denied` or `withdrawn`. Pending ones come oldest first, answered ones newest answer first. | `invalid_body` (400) for another status |
| `GET /api/managers/:id/governance` | The governance view of one manager: `resourceGrants`, `pending`, `denied`, `history`, `governanceEvictedDenials`. | `manager_not_found` (404) for an unknown id or a session that is not a manager |
| `POST /api/governance/proposals/:id/decide` | The answered proposal. Body: `{ "decision": "approve" }` or `{ "decision": "deny", "reason": "…" }`. | `invalid_body` (400): unknown decision, or a denial whose `reason` is missing, blank or longer than 500 characters; `proposal_not_found` (404); `already_resolved` (409); `store_not_found` / `note_not_found` (404) when approving an access whose resource no longer exists |

Approving a `resourceAccess` records exactly one grant (a new approval for the same manager and resource replaces the role and the access). Approving a `law` or a `permission` changes the proposal status only. Grants are informative: the server does not enforce them yet.

## Events

The WebSocket carries two events, each with the full `GovernanceProposalView`:

- `governance.proposed { proposal }`: a proposal is filed. A duplicate of an identical pending proposal (returned with `deduplicated: true` to the manager) announces nothing.
- `governance.resolved { proposal }`: a proposal leaves `pending`, whether a human approved or denied it or its manager withdrew it.

The `snapshot` event carries `proposals`: the pending proposals of every manager. The desktop holds them in `FleetEventsService.proposals`.
