# Governance queue: the human API

A manager files proposals (a law, a standing permission, a resource access) through its MCP tools. A proposal grants nothing while it is pending. The daemon never writes the mission note. The laws in force are the approved laws stored in the daemon (table `laws`, see [Laws](#laws)); standing permissions in force stay the prose of the mission note.

Only the human decides, with the daemon admin token. Every route below sits under `/api`: the MCP token of a session is answered `401 unauthorized`, and no decision route exists under `/mcp`.

## Routes

| Route | Answer | Errors |
|---|---|---|
| `GET /api/governance/proposals?status=` | The proposals of every manager in that status. `status` is `pending` (default), `approved`, `denied` or `withdrawn`. Pending ones come oldest first, answered ones newest answer first. | `invalid_body` (400) for another status |
| `GET /api/managers/:id/governance` | The governance view of one manager: `resourceGrants`, `pending`, `denied`, `history`, `governanceEvictedDenials`, and `laws` (every law of that manager, active and withdrawn, oldest first, each with its `status`). | `manager_not_found` (404) for an unknown id or a session that is not a manager |
| `POST /api/governance/proposals/:id/decide` | The answered proposal. Body: `{ "decision": "approve" }` or `{ "decision": "deny", "reason": "…" }`. | `invalid_body` (400): unknown decision, or a denial whose `reason` is missing, blank or longer than 500 characters; `proposal_not_found` (404); `already_resolved` (409); `not_found` (404) when approving an access whose resource no longer exists |
| `PATCH /api/governance/laws/:id` | The edited `LawView`. Body: `{ "text": "…", "expectedRevision": 1 }`. The text is 1 to 2000 visible characters, its secrets are masked, `revision` goes up by one and `updated_by` / `updated_at` record the human and the time. | `invalid_body` (400): blank or too long text, `expectedRevision` that is not an integer from 1; `law_not_found` (404); `law_revision_conflict` (409, `detail: { currentRev }`); `law_withdrawn` (409) |
| `POST /api/governance/laws/:id/withdraw` | The withdrawn `LawView` (`status: "withdrawn"`, `withdrawn_at`, `withdrawn_by`, `revision` up by one). Body: `{ "expectedRevision": 1 }`. | `invalid_body` (400); `law_not_found` (404); `law_revision_conflict` (409, `detail: { currentRev }`); `law_withdrawn` (409) |

An invalid decision body (for example a denial without a reason) is refused with 400 `invalid_body` before the proposal is looked up, so an unknown or already resolved id with an invalid body answers 400, not 404 or 409.

Approving a `resourceAccess` records exactly one grant (a new approval for the same manager and resource replaces the role and the access). Approving a `permission` changes the proposal status only. Approving a `law` records exactly one law in the same transaction as the decision (see [Laws](#laws)). Grants are informative: the server does not enforce them yet.

## Laws

A law is a standing rule of one manager, stored in the table `laws` (migration `036_governance_laws.sql`). A pending, denied or withdrawn proposal is never a law.

- **Born from approval.** Approving a law proposal inserts the law in the decision transaction: `approved_by = 'admin'` (the holder of the admin token is the human), `revision = 1`, `source_kind = 'proposal'`, the text of the proposal. The proposal stays an immutable audit record; `laws.text` is the current text. A failed insert undoes the decision, and the unique `proposal_id` guarantees one law per proposal, also under concurrent approvals (the second answers `already_resolved`).
- **No eviction.** The audit history of proposals keeps the newest 50 approved and withdrawn ones; a law is never evicted with its proposal (`proposal_id` becomes NULL). A law goes away only with its manager (cascade).
- **Scope.** A law belongs to one manager and is never visible to another.
- **Provenance.** `source_kind` is `proposal`, `legacy` or `import`. The migration turned every approved law proposal still held in the history into a `legacy` law: author unknown (`approved_by` NULL), dated at its decision, `source_created_at` set to the filing date. An approved law proposal already evicted from the history before the migration is not recovered, and one whose stored text is blank or longer than 2000 characters is skipped. No semantic deduplication: two proposals with the same text make two laws.
- **Bounds.** A law text is 1 to 2000 characters (checked by the database; secrets are masked before the bound is applied).
- **What the manager reads.** `get_argus_governance` returns `laws: [{ id, text, revision, createdAt, updatedAt, source }]`, the active laws of the calling manager only, oldest first, besides the previous keys. The laws of the response weigh at most 256 KiB: beyond that the response carries only whole laws from the oldest, with `lawsTruncated: true` and `lawsTotal` (the number of active laws). `history` remains an audit trail, not the rule set.
- **What the admin reads.** `GET /api/managers/:id/governance` returns every law of the manager with `status` (`active` or `withdrawn`), `revision`, authors and dates, untruncated.
- **Edited and withdrawn by a human only.** `PATCH /api/governance/laws/:id` replaces the current text and `POST /api/governance/laws/:id/withdraw` withdraws the law, both with the admin token and both checked against `expectedRevision`: the revision is compared inside the update itself, so of two concurrent writes on the same revision one succeeds and the other answers `409 law_revision_conflict` with `detail: { currentRev }`, and a refused call changes nothing. The proposal of origin is never touched: it stays the audit of what the manager asked, while `laws.text` is the rule in force. `updated_by` is the constant human actor `admin`.
- **Withdrawal is final.** A withdrawn law is history: editing it, or withdrawing it a second time, is refused with `409 law_withdrawn` (the repeated withdrawal is not idempotent, so the caller learns that it was already done). An unknown id answers `404 law_not_found`.
- **No MCP route.** No MCP tool creates, edits or withdraws a law, and no such path exists under `/mcp`: a manager only proposes. The manager is not messaged about an edit or a withdrawal; it reads the current laws with `get_argus_governance` (an edited law shows its current text and revision, a withdrawn law is no longer listed).
- **Not here yet.** Importing laws is separate work.

After a human approves or denies a proposal, its manager receives one queued governance message: `Proposal <id> approved` or `Proposal <id> denied: <reason>`. Approval accepts an optional reason of 1–500 visible characters, included in the message. The message uses the existing untrusted agent envelope, masks known secret formats and bounds its text to 700 characters. Delivery waits behind an unsent human draft. Withdrawing sends nothing; a closed manager receives nothing and stays closed. Repeated decisions return `already_resolved` and send no duplicate. Notification failure does not undo the recorded human decision.

## Events

The WebSocket carries two events with the full `GovernanceProposalView`:

- `governance.proposed { proposal }`: a proposal is filed. A duplicate of an identical pending proposal (returned with `deduplicated: true` to the manager) announces nothing.
- `governance.resolved { proposal }`: a proposal leaves `pending`, whether a human approved or denied it or its manager withdrew it.

and three with the full `LawView`, sent to every connected client (the admin feed sees every manager):

- `law.created { law }`: approving a law proposal enacted a law.
- `law.updated { law }`: a human edited the text (the revision went up).
- `law.withdrawn { law }`: a human withdrew the law.

A refused edit or withdrawal announces nothing.

The `snapshot` event carries `proposals`: the pending proposals of every manager. The desktop holds them in `FleetEventsService.proposals`.

## Desktop UI

- **Inbox, Governance filter.** One card per pending proposal, oldest first (ties broken by id). A card shows the manager, the type, the age, the incident and the proposal as inert plain text. `Approve` and `Deny` are named after the type, the manager and the first 40 characters of the text. A denial needs a reason of 1 to 500 characters; spaces and invisible characters alone do not count. The card leaves when the daemon announces `governance.resolved`, never on the HTTP answer alone; a refusal (`already_resolved`, `proposal_not_found`, a network failure) keeps the card with a readable message. Focus moves to the action button of the next card, or to the Governance filter when none is left, and a polite live region announces how many proposals need the human.
- **Badge and count.** The Inbox title and the sidebar Inbox badge share one count (approvals, pending proposals, questions, context notices).
- **Approved law.** Nothing is left to copy: the law lives in the daemon, so approving it leaves no card and no instruction in the Inbox, and nothing about it is kept in the session storage.
- **Approved permission.** The daemon never writes the mission note, so the card of an approved permission says `Copy this into the mission note, where your standing permissions are written.`, with a link that opens the note. Copy and paste is the only path: there is no button that writes into the note. The text stays until `Dismiss`, across filter changes and across leaving the Inbox, and the Inbox is not shown as empty while one is left. The session storage key `openfleet.governance.approved-texts.v1` now holds permissions only: a law text that an older version left there is ignored and dropped at the next write.
- **Manager dashboard, Laws.** The Governance section starts with the manager's laws. Each active law shows its text, its revision, its provenance (`Approved proposal`, `Earlier approval`, `Imported`) and when it was updated. `Edit` opens the text in place (`Save law`, `Cancel`); `Withdraw` asks `Confirm withdrawal` before anything is sent. A save or a withdrawal that loses the revision race shows `This law changed since you opened it. Reload it.`, reloads the laws and keeps the draft of the user, who then sees what the law now reads and saves against the reloaded revision. Withdrawn laws are listed apart, without actions. The section reloads itself on `law.created`, `law.updated` and `law.withdrawn` of that manager.
- **Manager dashboard, Governance section.** Pending proposals (with a link to decide in the Inbox), denied ones with their reason, the number of older denials evicted, the history (`Approved`, `Withdrawn`) and the resource grants, labelled `informational: not enforced yet`. The section is reloaded when the pending proposals of that manager change, shows `Loading…` after a switch of manager, and shows a readable error, never the view of another manager, when a load fails.
- **Names.** A resource access shows the title of the note or the name of the table when it can be resolved, otherwise its id; a lookup that failed is tried again at the next display. A manager whose session is gone is shown as `Closed manager` or `Unknown manager`, never as its raw id.
- **End-to-end seeding.** `POST /api/managers/:id/fake-propose-law` files a pending law through the real queue, and exists only when `OPENFLEET_E2E` is set.
