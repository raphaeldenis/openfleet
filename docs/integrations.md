# Integrations

**In brief.** A *connection* says which provider OpenFleet talks to, on which hosts, with which credential. An *integration* is a connection used by one project. A manager can list the integrations of its project, read the last health of one and ask for a fresh probe. It can never create a connection, name a host or a url, set a credential or read one. The credential lives in the secret store of the desktop app (see [secrets.md](secrets.md)) and in no table, answer, log line or error message of the daemon. This page describes the foundations (I1) and the polling of Jira issues (I2a): the daemon keeps the issues of a Jira integration up to date, read only, and a human can read them over REST. There is no Jira or GitHub read tool for agents yet (I2b).

## What exists

| Piece | Where |
|---|---|
| Tables `integration_connections`, `integration_profiles`, `integration_health` (migration 070, down file alongside) | `packages/core/src/db/migrations/070_integrations.sql` |
| Provider registry: hosts a provider may reach, its probe path, how it presents a credential | `packages/core/src/integrations/integrationProviders.ts` |
| Probe port and its adapter over the pinned reader of the poller | `packages/core/src/integrations/integrationProbe.ts` |
| Service: create, list, health, refresh | `packages/core/src/integrations/integrationService.ts` |
| MCP tools | `packages/core/src/mcp/integrationTools.ts` |
| REST (admin token) | `packages/core/src/api/integrationRoutes.ts` |

Shipped providers: `jira_cloud` (hosts `<tenant>.atlassian.net`, credential `email:api_token`, probe `GET /rest/api/3/myself`) and `github` (host `api.github.com`, bearer token, probe `GET /rate_limit`). Jira Data Center has no provider: its hosts belong to each customer, so a host pattern cannot allow them without allowing a free url.

## Who can do what

| Action | Human (desktop app, admin token) | Agent (MCP) |
|---|---|---|
| Create a connection (name, provider, allowed hosts) | `POST /api/integration-connections` | no tool |
| List connections | `GET /api/integration-connections` | no tool |
| Create an integration in a project | `POST /api/integrations` | no tool |
| List integrations | `GET /api/integrations?projectId=` | `list_integrations` (read only) |
| Set or clear the token | `PUT` / `DELETE /api/secrets/connection/:id/TOKEN`, admin token **and** operator nonce | no tool |
| Read the last health | | `get_integration_health` (read only, no network call) |
| Probe now | | `refresh_integration` (execution_external, one call, cooldown) |
| Read the token | no route | no tool; only `refresh` reads it, inside the daemon, to reach the provider |

None of the three tools is in the reviewer set or the arbiter set. Their input is an integration id and nothing else.

## What a connection is allowed to reach

- A connection names hosts; each must be a bare host name (no scheme, port, path or user) that the **provider itself** allows. A connection with one refused host is refused whole: `integration_host_not_allowed`. An unknown provider is `integration_provider_unknown`.
- The probe asks `<scheme>://<first host><health path>` and nothing else, through the one reader of the poller (see "Polling Jira issues", "Where the credential goes"): the host is resolved once, the address must pass the provider's policy, and the connection is made to that address. A redirect is never followed, so the credential reaches the host asked and no other.
- A creation body is strict: a field it does not know, a `token` included, is refused `invalid_body`. A known field that holds a credential is refused `integration_label_is_secret` (see "What the guarantee covers").

## Health

`ok` (a 2xx whose body is JSON, or a 204 with no body), `auth_failed` (401, 403), `rate_limited` (429), `unreachable` (any other status, a 2xx that is not JSON, a redirect, an address the provider's policy refuses, a network failure, a timeout of 15 s that counts the resolution of the name), or `unknown` before the first refresh. It is a type: no byte of the provider's answer, no error text, leaves the probe.

`refresh_integration` is bounded, and the bound follows the credential: it belongs to the **connection**, so every integration of a connection shares one cooldown and one place in flight. A second refresh of the same connection (through any of its integrations, in any project) within 60 seconds, or while one is running, is refused `integration_refresh_cooldown` (retry later) before the credential is read. At most 4 refreshes are in flight at once across all connections (`MAX_CONCURRENT_REFRESHES`); a fifth is refused with the same code. A loop, or many profiles of one connection, cannot hammer a provider or lock out an account. A connection with no value on this device answers `secret_not_connected_on_this_device` and calls nobody.

The cooldown is kept in memory and measured on the monotonic clock: a step of the wall clock neither ends it nor extends it, and a restart of the daemon clears it.

## Polling Jira issues

A provider that names an issue search path (`jira_cloud`: `/rest/api/3/search/jql`) is polled by the daemon; `github` is not. The poller (`packages/core/src/integrations/integrationPoller.ts`) wakes every minute and polls the profiles that are due, at most 20 a pass, one after the other. A profile whose provider has no issue search is never due, so it cannot take a place of the pass. The due profiles are served by last attempt, the one never tried first and then the one tried longest ago, whatever its id: a profile is not left behind by the ones before it.

| Piece | Where |
|---|---|
| Tables `integration_poll_state`, `integration_connection_polling`, `integration_view_items` (migration 071, down file alongside) | `packages/core/src/db/migrations/071_integration_polling.sql` |
| The reader: one GET, pinned address, bounded | `packages/core/src/integrations/providerReader.ts`, `providerAddress.ts` |
| The poller and its schedule | `packages/core/src/integrations/integrationPoller.ts` |
| The cleaning of third-party text | `packages/core/src/integrations/jiraIssues.ts` |
| The masking of what a provider echoes of the credential | `packages/core/src/integrations/credentialEchoMasker.ts` |
| REST read of the issues | `GET /api/integrations/:id/items?projectId=` (admin token) |

- **The query.** It is fixed by the daemon. A profile whose `resource` is a Jira project key (`[A-Z][A-Z0-9_]{1,9}`) reads `project = <KEY> AND resolution = Unresolved ORDER BY updated DESC`; any other resource reads `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`. 50 issues at most, the fields `summary,status,priority,issuetype,assignee,updated`. No agent supplies a JQL text.
- **Read only.** The reader can only send a GET. No code path writes to a provider.
- **Where the credential goes.** The host is re-checked against the provider rule at every poll (a bare `*.atlassian.net` name: no user, port, IPv6, Unicode or trailing dot). It is resolved once, the address is checked by the provider's policy, and the connection is made to that address, so a second resolution that answers differently changes nothing. A redirect is never followed, whatever its target. The credential is in the `Authorization` header and nowhere in the answer of the reader.
- **The address policy.** Without a policy of its own a provider is reached at a global unicast address only. IPv4 refuses `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4` and `240.0.0.0/4` (the broadcast address included). IPv6 allows `2000::/3` and refuses, inside it, `2001::/23` (protocol assignments: Teredo, benchmarking, ORCHID), `2001:db8::/32` and `3fff::/20` (documentation) and `2002::/16` (6to4); everything outside `2000::/3` is refused: loopback, unspecified, unique local, link-local, the deprecated site-local `fec0::/10`, multicast, the IPv4-compatible `::/96`, the local-use NAT64 `64:ff9b:1::/48`. The two forms that carry an IPv4 address, the IPv4-mapped `::ffff:0:0/96` and the well-known NAT64 `64:ff9b::/96`, are allowed when the IPv4 address they carry passes the IPv4 rules. An address with a zone, a port or any text that is not an address is refused. A provider may name its own policy; the probe and the poller read the same one.
- **Bounds.** Body 1 MiB (declared or streamed), response headers 16 KiB, no cookie, `Accept-Encoding: identity`, and a deadline of 15 s that starts before the name is resolved and covers the resolution as much as the transport. A name that never resolves ends as `unreachable` at the deadline, and an answer of the resolver that comes after it is ignored: no connection is made. `stop()` of the poller aborts the read in flight, so a resolver that hangs does not hold it, and nothing is recorded after it. Anything over a bound, a body that is not JSON, or a JSON that is not a search result reads as `unreachable` and the issues already kept stay.
- **Schedule, on the injected clock.** After a success the next poll is in 5 minutes, and the ETag of the answer is sent back as `If-None-Match` (a 304 keeps the issues). After the n-th failure in a row the wait is one minute doubled n-1 times, at most one hour; a 429 waits its `Retry-After` (whole seconds) if that is longer, at most one hour. A device with no credential for the connection asks nobody and looks again in 5 minutes.
- **Refused credential.** A 401 or 403 is `auth_failed`. Three in a row on one connection stop its polling (`polling: stopped_auth_failed`); all the integrations of a connection share the count, and a refusal ends the pass for the other integrations of that connection. A success resets the count. A `refresh_integration` whose probe says `ok` lets the connection poll again at once.
- **Third-party text.** The key is checked (`[A-Z][A-Z0-9_]{1,19}-<digits>`; any other issue is dropped) and the address is built from the connection host (`<origin>/browse/<KEY>`). The summary and the status, priority, type and assignee names are cleaned (control, bidirectional and zero-width characters removed, blanks collapsed, `<` and `>` turned into `‹` and `›`), cut (200 and 64 characters, ending in `…`) and kept under `untrusted`. Nothing else of the answer is kept: not the Jira address, not an email, not a description.
- **What the provider echoes of the credential.** Every text that comes from the provider passes the masker of the credential of its connection before it is kept or shown, at two points: on the raw text, and again after the cleaning (a value split by invisible characters is whole once they are removed), both before the cut, so a cut cannot leave the start of a value. The masker reads a text of the size of a body (1 MiB) whole, so no step cuts a text before the masking of the complete text is done: a token split by one, many or consecutive invisible characters is masked in a text of any length the reader accepts, at the head, in the middle or astride the former 262 144-character ceiling of the shared masker. The masker knows the credential, the whole `Authorization` value, and the part of the credential after its first colon (the API token of `email:api_token`), each plain, URL-encoded, form-encoded, in base64 and base64url, and escaped for JSON; a match becomes `[secret:INTEGRATION_CREDENTIAL]`. An issue whose key is a form of the credential is dropped. The ETag is kept only when it has the shape of one (a quoted tag of at most 254 characters of printable ASCII without a quote or a space, with or without the weak marker `W/`, 256 characters in all) and holds no form of the credential; otherwise none is kept and none is sent back. Nothing else of the headers leaves the reader (the `Retry-After` is read as whole seconds).

Minimum length: a value of fewer than 8 characters is not masked (it would destroy legitimate text), so the secret service refuses to store a connection `TOKEN` whose part after the first colon is under 8 characters (`secret_too_short`, the code of any secret under 8), and no such token is ever polled with. `stop()` of the poller also holds while the secret store has not answered: a pass that wakes after the stop writes nothing and sends nothing to the provider.

What this does not claim: the masker recognises the forms above and no transformation of them (a hash, a split in two answers, a base64 of the credential at another alignment, a changed letter case, a spelling by hand); an echo of the credential in a text that is cut by the third party itself is not recognised. The cleaning removes markup characters and invisible ones, not words, so a title that reads like an instruction is still only a title and a reader must treat it as data; without a view configuration the issues are polled for one query per integration (see "View configurations and their approval").

## View configurations and their approval

An integration holds two separate places for its view (a JQL and the fields to keep): the **active configuration**, which a human approved and which the daemon polls, and the **proposal**, which waits for a human. The daemon runs nothing else than what was approved. There is no MCP tool for it yet (I2b-2); this part is REST only, behind the admin token. An MCP session bearer is refused (401) on these `/api/integrations/...` routes, which a test exercises on the real path.

| Action | Route |
|---|---|
| Read | `GET /api/integrations/:id/view-config?projectId=` (404 `integration_view_config_not_found` when there is neither an active configuration nor a proposal) |
| Propose (create or replace the proposal) | `PUT /api/integrations/:id/view-config?projectId=`, body `{ jql, fields, expectedRev? }`; the answer holds the `proposal` |
| Approve | `POST /api/integrations/:id/view-config/approve?projectId=`, body `{ approvedRev }`, header `x-human-proof` (404 `integration_view_proposal_not_found` when no proposal waits) |

- **Two places.** `active` holds `jql`, `fields`, `approvedRev`, `approvedAt` and a `status`; `proposal` holds `jql`, `fields`, `contentRev` and `reviewDigest`, the digest that approving the revision records (it covers the canonical JQL **and** the fields). Every proposal is a new revision (`contentRev` only goes up), even when its content is unchanged or identical to the active one. Proposing replaces the proposal and nothing else: it never clears, changes or suspends the active configuration, and has no effect on the polling, so a proposer cannot freeze a profile by writing proposals. Approving promotes the reviewed proposal to the active configuration in one step (`approvedRev` is the revision of the proposal) and empties the proposal place.
- **Withheld status.** `status` is `running` while the stored active content still has the digest that was approved and is a query the daemon accepts as it stands. A row changed behind the service (digest mismatch, text edited, a text outside the allow list, unreadable fields) is `withheld`: nothing is asked of the provider for it, **not even the default query**, and no credential is read for it.
- **Human proof.** Approval needs the single-use operator nonce that the desktop app mints for the action `integration.approve_view` on exactly this integration (scope kind `integration`, the integration id as scope id and as name). A nonce for another integration, another action (a secret write, the arming of a trigger) or one already spent is refused with `human_proof_required`, as is a request without one. A request for a revision other than the current one is refused `stale_revision` before the nonce is read.
- **The JQL.** Checked before it is stored and again before it is run (`integration_view_jql_refused`, with the rule that broke and never the text): at most 500 characters, counted on the text typed **and** on its canonical form (quotes and spaces are added by the rewrite, so a query of 443 typed characters that rewrites to 915 is refused at the proposal), which makes the check idempotent: what is stored passes the check again unchanged. At most 8 clauses joined by `AND`; the fields `project status priority issuetype resolution labels component fixVersion assignee reporter created updated`; `=`, `!=`, `IN`, `NOT IN` (at most 20 values), and `> >= < <=` on `created` and `updated` with a relative date (`-7d`) or a day (`2026-11-09`); the values `currentUser()` (on `assignee` and `reporter`) and `EMPTY`; one `ORDER BY updated|created|priority|status`. No `OR`, no other function, no text search, no comment. The query is rebuilt from its parts with every value quoted and escaped, so the text approved, stored and sent is not the text typed. The fields are chosen among `summary status priority issuetype assignee updated`, the summary included.
- **What the poller runs.** An integration with no active configuration runs the default query as before, whatever proposal waits, even one written to the database by hand. One with an active configuration runs that approved content (50 issues at most); if the row no longer matches its approval it runs nothing (fail closed, status `withheld`). The issues already kept stay until the approved query replaces them. Approving puts the profile due at once and drops the ETag of the previous query, so the new query is asked fresh.
- **Approval during a request.** The poller names the request it is about to send by the active configuration behind it (its revision, digest, text and fields, or the default query) and checks that name again after each wait: after the credential is resolved, and when the provider answers. A configuration approved, replaced or edited meanwhile cancels the request that has not left, and an answer to the old request is dropped whole: no issues, no ETag, no health, no deadline is written, so the ETag of the old query is never sent with the new one and the profile stays due at once.

## What the guarantee covers

- **Covered.** The credential stored in the secret store is never read back into a view, an answer, a table, a log line or an error. The daemon reads it in two places: `refresh`, to reach the provider, and the creation of an integration, to compare it in memory with the labels typed there. Neither writes it anywhere.
- **Operator text.** The names of a connection and of an integration, and the `resource`, are free text typed by the operator and shown to agents as typed. They are not secret storage. A label that has the shape of a token (the detector of the log masking, `maskedSecrets`) is refused `integration_label_is_secret`, and so is an integration label (name or resource) equal to the credential stored for its connection, blanks around it ignored. The refusal carries no value.
- **Not covered.** A credential of no known shape typed in the name of a connection, or in a label of an integration whose connection holds no value yet, or equal to the credential of another connection, is accepted: the daemon cannot tell it from a name. This is a typing slip of the operator, not an extraction by an agent; no tool lets an agent read the secret store.

## What this does not claim

- The status `stored` is the daemon's record of the last set or clear, as for every secret ([secrets.md](secrets.md), "What this does not claim").
- Creating a connection needs the admin token only. A process that reads `admin.token` can create a connection on an allowed host (for `jira_cloud`, any `*.atlassian.net` tenant); it still cannot set a value without the operator nonce of the desktop app, so no credential reaches a host the human did not type a value for.
- The activity log keeps the value of an identifier argument (`integration`) when it is a safe token of at most 64 characters, as it does for every identifier ([CHANGELOG.md](../CHANGELOG.md), ACTIVITY-LOG01). A credential pasted by someone into the `integration` argument would be kept as such. Any other argument, `token` and `authorization` included, is never kept.
- Health is not recomputed in the background: it is what the last refresh saw.
- The `down` of migration 070 drops the three integration tables in child-to-parent order and does not clean the polymorphic `secret_refs` rows of scope `connection`. After a rollback they stay as orphans (and the values stay in the secret store); a human clears them from the secrets route before the rollback, or leaves them: a later `up` creates new connection ids, so no orphan is ever read again.
