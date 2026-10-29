# OpenFleet

OpenFleet is a desktop workspace where manager agents drive fleets of coding agents through a delivery pipeline. It replaces Scape, so a term OpenFleet has not yet coined keeps its Scape name.

## Language

### Fleet

**Manager** (Scape: Argus):
A session that creates and supervises children and receives a pulse.
_Avoid_: orchestrator, supervisor

**Manager kind**:
The part a manager plays in the fleet: a Lead runs a project's pipeline, a Forge supervises a Lead.

**Lead**:
A kind of manager that runs the pipeline for a project's backlog rows.
_Avoid_: Capitaine (a persona name, not a term)

**Forge**:
A kind of manager that supervises a Lead.

**Child**:
A session created by a manager and bound to it by lineage and the manager's children cap; a child can itself be a manager.
_Avoid_: subagent (an in-session helper with no session and no worktree)

**Lineage**:
The chain of parent managers above a session, recorded when the session is created.

**Children cap**:
The maximum number of live children a manager may hold at once.

**Session**:
One running agent identified by a unique live name, a model and a permission profile.
_Avoid_: agent, run

**Worktree**:
A git working directory isolated per backlog row, in which a session works and which outlives that session.

**Backlog row**:
One unit of work in the project's backlog table, identified by a natural id such as FIX168.
_Avoid_: task, ticket

**Harness**:
The adapter that launches and drives an agent CLI for a session.

**Profile**:
The team pack entry that fixes, for one role, its rung, permission profile, caps and role brief.

**Role brief**:
The mission text a session reads for its role.

**Mission note**:
The note in which the human states a manager's mission and approves its laws.

**Rung**:
A model alias (haiku, sonnet, opus or fable) resolved to a model at launch; opus and fable are reached only by a logged escalation.
_Avoid_: exact model id

### Roles

**Role**:
The function a session performs in the pipeline: PM, ARCHITECT, DEV, QE, QA, Design QA, ponytail, adversarial reviewer or RETRO.

**PM**:
Writes the acceptance criteria from the ticket.

**ARCHITECT**:
Writes the plan note and the tests list, and sizes the row S, M or L.

**DEV**:
Implements the plan test-first in its worktree.

**QE**:
Writes black-box tests and runs mutation testing.

**QA**:
Checks the acceptance criteria in a browser on the real app.

**Design QA**:
Compares the screens against the mockup.

**ponytail**:
Reviews the diff for over-engineering; its findings are informative.

**Adversarial reviewer**:
Gives the delivery verdict, go or no-go.

**RETRO**:
Proposes environment improvements after a merge.

### Project data (Scape terms)

**Note** (Scape):
A versioned markdown document of the project.

**Overlay note** (Scape):
A note holding the content tied to one project, kept out of the default team pack (notes #104, #105, #108, #109, #111).

**Data store** (Scape):
A structured project table, such as the backlog, the Lead log or the findings; also called a table.

**Playbook** (Scape):
A replayable automation routine.

**Trigger** (Scape):
A condition that starts a playbook or wakes a manager.

**Scheduled event** (Scape):
A wake-up or action planned for a given time.

**Session card** (Scape):
The summary sheet of one session.

### Pipeline and review

**Pipeline**:
The ordered roles a backlog row crosses: PM, ARCHITECT, DEV, UI smoke (UI rows), QE, QA, Design QA (UI rows), ponytail, adversarial go/no-go, draft PR.

**UI smoke**:
A quick check that the screens of a UI row render before the deeper QE and QA steps.

**QA browser**:
The browser-driven QA step, run by an agent against the real app with several permission profiles.

**Integration MR**:
The merge request that carries one backlog row to the main branch as one squash commit per ticket.

**Finding**:
A numbered observation from a reviewer, carrying a severity, a file and line, and a triggering scenario, logged by the Lead.
_Avoid_: issue, comment

**Findings gate**:
The gate that holds a PR until its head commit has one findings line for each of qe, qa, ponytail and adversarial.

**Severity**:
The weight of a finding: blocker, major or minor, the scale of the findings lines from QE, QA, ponytail and retro. A PR review labels its points blocking, fix-before-merge or nit, which map to blocker, major and minor.

**Verdict**:
The delivery decision of the adversarial review: go or no-go.

### Rules and enforcement

**Rule**:
Any normative statement, whether in a standing document, a brief or a hook.

**Law**:
A rule approved by the human in the mission note, with a scope, a condition and exclusions.
_Avoid_: policy

**Gate**:
A check that must pass and fails closed: a missing command or an empty output counts as a failure.

**Hook**:
A script the harness runs at a fixed moment of a session, such as before a tool call, to enforce a rule.

**Permission profile**:
The set of allow, ask and deny decisions the harness applies to one session.

**Team pack**:
The briefs, profiles, laws and hooks shipped by default with OpenFleet.

**Contract version**:
The integer that identifies the revision of the MCP tool contract; it changes whenever a tool schema changes.

**Migration**:
A numbered SQL file that moves the database schema forward, with a matching down file.

### Rhythm and state

**Pulse**:
The scheduled wake-up of a watching manager.

**Manager mode**:
The mode of a manager: watching receives pulses, sleeping runs only when woken, disabled receives nothing automated and holds its messages. Added in OpenFleet by PARITY-ARGUS-07b (contract version 11); described in `docs/manager-mode.md` and implemented in `packages/core/src/managers/managerRepository.ts` at commit 63fd05fd.

**Wake**:
Any message that wakes a sleeping manager.

**Working state**:
The state file a session rereads at start and at every stop.

**Headroom**:
The share of the context window a session still has free before it must compact or hand off.

### Migration

**Cutover**:
The switch from Scape to OpenFleet; its backlog rows are tagged [CUTOVER].
