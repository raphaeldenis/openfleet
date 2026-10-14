# Governance queue: the human API

A manager files proposals (a law, a standing permission, a resource access) through its MCP tools. A proposal grants nothing while it is pending. The laws and permissions in force stay the prose of the mission note, which the daemon never writes.

Only the human decides, with the daemon admin token. Every route below sits under `/api`: the MCP token of a session is answered `401 unauthorized`, and no decision route exists under `/mcp`.

## Routes

| Route | Answer | Errors |
|---|---|---|
| `GET /api/governance/proposals?status=` | The proposals of every manager in that status. `status` is `pending` (default), `approved`, `denied` or `withdrawn`. Pending ones come oldest first, answered ones newest answer first. | `invalid_body` (400) for another status |
| `GET /api/managers/:id/governance` | The governance view of one manager: `resourceGrants`, `pending`, `denied`, `history`, `governanceEvictedDenials`. | `manager_not_found` (404) for an unknown id or a session that is not a manager |
| `POST /api/governance/proposals/:id/decide` | The answered proposal. Body: `{ "decision": "approve" }` or `{ "decision": "deny", "reason": "…" }`. | `invalid_body` (400): unknown decision, or a denial whose `reason` is missing, blank or longer than 500 characters; `proposal_not_found` (404); `already_resolved` (409); `not_found` (404) when approving an access whose resource no longer exists |

An invalid decision body (for example a denial without a reason) is refused with 400 `invalid_body` before the proposal is looked up, so an unknown or already resolved id with an invalid body answers 400, not 404 or 409.

Approving a `resourceAccess` records exactly one grant (a new approval for the same manager and resource replaces the role and the access). Approving a `law` or a `permission` changes the proposal status only. Grants are informative: the server does not enforce them yet.

## Events

The WebSocket carries two events, each with the full `GovernanceProposalView`:

- `governance.proposed { proposal }`: a proposal is filed. A duplicate of an identical pending proposal (returned with `deduplicated: true` to the manager) announces nothing.
- `governance.resolved { proposal }`: a proposal leaves `pending`, whether a human approved or denied it or its manager withdrew it.

The `snapshot` event carries `proposals`: the pending proposals of every manager. The desktop holds them in `FleetEventsService.proposals`.

## Desktop UI

- **Inbox, Governance filter.** One card per pending proposal, oldest first (ties broken by id). A card shows the manager, the type, the age, the incident and the proposal as inert plain text. `Approve` and `Deny` are named after the type, the manager and the first 40 characters of the text. A denial needs a reason of 1 to 500 characters; spaces and invisible characters alone do not count. The card leaves when the daemon announces `governance.resolved`, never on the HTTP answer alone; a refusal (`already_resolved`, `proposal_not_found`, a network failure) keeps the card with a readable message. Focus moves to the action button of the next card, or to the Governance filter when none is left, and a polite live region announces how many proposals need the human.
- **Badge and count.** The Inbox title and the sidebar Inbox badge share one count (approvals, pending proposals, questions, context notices).
- **Approved law or permission.** The daemon never writes the mission note, so the card of an approved text says `Copy this into the Laws section of the mission note.`, with a link that opens the note. Copy and paste is the only path: there is no button that writes into the note. The text stays until `Dismiss`, across filter changes and across leaving the Inbox, and the Inbox is not shown as empty while one is left.
- **Manager dashboard, Governance section.** Pending proposals (with a link to decide in the Inbox), denied ones with their reason, the number of older denials evicted, the history (`Approved`, `Withdrawn`) and the resource grants, labelled `informational: not enforced yet`. The section is reloaded when the pending proposals of that manager change, shows `Loading…` after a switch of manager, and shows a readable error, never the view of another manager, when a load fails.
- **Names.** A resource access shows the title of the note or the name of the table when it can be resolved, otherwise its id; a lookup that failed is tried again at the next display. A manager whose session is gone is shown as `Closed manager` or `Unknown manager`, never as its raw id.
- **End-to-end seeding.** `POST /api/managers/:id/fake-propose-law` files a pending law through the real queue, and exists only when `OPENFLEET_E2E` is set.
