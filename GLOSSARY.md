# OpenFleet

OpenFleet is a desktop workspace where manager agents drive fleets of coding agents through a delivery pipeline. It replaces Scape, so a term OpenFleet has not yet coined keeps its Scape name.

## Language

### Fleet

**Manager** (Scape: Argus):
A session that creates and supervises children and receives a pulse.
_Avoid_: orchestrator, supervisor

**Lead**:
A role of a manager that runs the pipeline for a project's backlog rows.
_Avoid_: Capitaine (a persona name, not a term)

**Forge**:
A role of a manager that supervises a Lead.

**Child**:
A session created by a manager and bound to it by lineage and the manager's children cap; a child can itself be a manager.
_Avoid_: subagent (an in-session helper with no session and no worktree)

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

**Role**:
The function a session performs in the pipeline, such as DEV or QE.

**Profile**:
The team pack entry that fixes, for one role, its rung, permission profile, caps and role brief.

**Role brief**:
The mission text a session reads for its role.

**Rung**:
A model alias (haiku, sonnet, opus or fable) resolved to a model at launch; opus and fable are reached only by a logged escalation.
_Avoid_: exact model id

### Project data (Scape terms)

**Note** (Scape):
A versioned markdown document of the project.

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

**Finding**:
A numbered observation from a reviewer, carrying a severity, a file and line, and a triggering scenario, logged by the Lead.
_Avoid_: issue, comment

**Severity**:
The weight of a finding: blocker, major or minor, used by QE, QA, ponytail and retro.

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

**Permission profile**:
The set of allow, ask and deny decisions the harness applies to one session.

**Team pack**:
The briefs, profiles, laws and hooks shipped by default with OpenFleet.

### Rhythm and state

**Pulse**:
The scheduled wake-up of a watching manager.

**Argus mode** (Scape):
The mode of a manager: watching receives pulses, sleeping runs only when woken, disabled does neither.

**Wake**:
Any message that wakes a sleeping manager.

**Working state**:
The state file a session rereads at start and at every stop.

### Migration

**Cutover**:
The switch from Scape to OpenFleet; its backlog rows are tagged [CUTOVER].
