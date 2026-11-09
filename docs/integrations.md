# Integrations

**In brief.** A *connection* says which provider OpenFleet talks to, on which hosts, with which credential. An *integration* is a connection used by one project. A manager can list the integrations of its project, read the last health of one and ask for a fresh probe. It can never create a connection, name a host or a url, set a credential or read one. The credential lives in the secret store of the desktop app (see [secrets.md](secrets.md)) and in no table, answer, log line or error message of the daemon. This page describes foundations only (I1): there is no polling, no item sync and no Jira or GitHub read tool yet.

## What exists

| Piece | Where |
|---|---|
| Tables `integration_connections`, `integration_profiles`, `integration_health` (migration 070, down file alongside) | `packages/core/src/db/migrations/070_integrations.sql` |
| Provider registry: hosts a provider may reach, its probe path, how it presents a credential | `packages/core/src/integrations/integrationProviders.ts` |
| Probe port and its `fetch` adapter | `packages/core/src/integrations/integrationProbe.ts` |
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
- The probe asks `<scheme>://<first host><health path>` and nothing else. A redirect is never followed, so the credential reaches the host asked and no other.
- A creation body is strict: a field it does not know, a `token` included, is refused `invalid_body`. A known field that holds a credential is refused `integration_label_is_secret` (see "What the guarantee covers").

## Health

`ok`, `auth_failed` (401, 403), `rate_limited` (429), `unreachable` (any other status, a redirect, a network failure, a timeout of 10 s), or `unknown` before the first refresh. It is a type: no byte of the provider's answer, no error text, leaves the probe.

`refresh_integration` is bounded, and the bound follows the credential: it belongs to the **connection**, so every integration of a connection shares one cooldown and one place in flight. A second refresh of the same connection (through any of its integrations, in any project) within 60 seconds, or while one is running, is refused `integration_refresh_cooldown` (retry later) before the credential is read. At most 4 refreshes are in flight at once across all connections (`MAX_CONCURRENT_REFRESHES`); a fifth is refused with the same code. A loop, or many profiles of one connection, cannot hammer a provider or lock out an account. A connection with no value on this device answers `secret_not_connected_on_this_device` and calls nobody.

The cooldown is kept in memory and measured on the monotonic clock: a step of the wall clock neither ends it nor extends it, and a restart of the daemon clears it.

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
