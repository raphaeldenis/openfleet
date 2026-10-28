# Project profile skeleton over MCP: `bootstrap_project_profile`

One call gives a manager its project skeleton: two tables, a mission note, the journal binding and the access requests for the tables. Calling it again changes nothing.

## Input

| Field | Type | Rule |
|---|---|---|
| `manager_id` | string | optional; the manager to equip. Absent, the caller is the target |

The target must be a manager, and either the caller itself or a manager the caller spawned. The project is the project of the target session. A target that is not a manager gets `not_a_manager`; a manager outside the caller's lineage gets `outside_lineage`; a session with no project gets `project_not_found`.

## What it does

Everything runs in one transaction. A refusal or a failure at any step leaves the project as it was.

| Step | Item | Natural key | When it exists already |
|---|---|---|---|
| 1 | Table `Manager journal` (columns `Time`, created by the daemon, and `Entry`) | name in the project, any case | reused as it is, rows and columns untouched |
| 2 | Table `Manager backlog` (columns `Ticket`, the natural key, `Title`, `Status`) | name in the project, any case | reused as it is |
| 3 | Mission note `Mission - <manager name>`, linked as the mission note of the manager | the link of the manager | the linked note is kept, nothing is written to it |
| 4 | Journal table bound as the log table of the manager | the binding of the manager | a bound table is kept |
| 5 | One `request_resource_access` per table (`readWrite`) in the governance queue | the request itself | a pending or queued identical request is returned, not filed again; a table already granted is skipped |

## What it never does

- It grants nothing. Step 5 only files requests; a human approves or denies them in the governance queue.
- It changes no pulse. It does not resume a paused manager, does not change the cadence and does not send a message. A paused manager stays paused.
- It spawns no session. A manager is a live session, which cannot be created inside a database transaction: the target manager exists before the call.
- It creates no playbook, no trigger and no integration. OpenFleet has no native playbook, trigger or integration registry yet (see [playbook shims](playbook-shims.md)); their Scape counterparts stay archived in the playbooks note of the import.
- It fills no field of the manager card (expertise, mission, pulse actions). A later increment fills them from a template.
- It writes into no existing note and no existing table.

## Answer

```
{
  managerId, projectId,
  tables: [{ name, id, created }],
  missionNote: { id, created },
  logStoreId,
  grantRequests: [{ resourceId, requestId?, status: 'pending' | 'queued' | 'granted', filed }]
}
```

`created` and `filed` are `true` only for what this call wrote. A second identical call returns the same identifiers with every `created` and `filed` at `false`.

## Errors

No new code: `not_a_manager`, `outside_lineage`, `project_not_found`, `governance_queue_full` (the queue has no place left for the requests; nothing is written) and the usual note and table refusals.

## Contract

This is an added tool: no existing tool, route or schema changes. The repository has no contract version convention, so this tool carries none (backlog line CONTRACT-VERSION01).
