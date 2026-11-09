import { OpenFleetError, type PlaybookCell } from '@openfleet/shared';
import { canonicalDigestOf } from './kernel/canonicalDigest.js';
import type { PlaybookRecord, PlaybookRepository } from './playbookRepository.js';
import type { LocatedScript, ScriptLocator } from './scriptLocator.js';

/** What a human reviews before approving: the digest of the playbook together with the sha256 of each script file it runs. */
export interface ApprovalPreview {
  digest: string;
  scripts: Record<string, string>;
}

export interface PlaybookApprovalsDeps {
  repository: PlaybookRepository;
  locator: ScriptLocator;
  clock: () => string;
}

const scriptProgramsOf = (playbook: PlaybookRecord): string[] => {
  const programs = playbook.flow.cells.flatMap((cell: PlaybookCell) => (cell.kind === 'script' ? [cell.program] : []));
  return [...new Set(programs)].sort();
};

const digestOf = (playbook: PlaybookRecord, scripts: Record<string, string>): string =>
  canonicalDigestOf({ name: playbook.name, inputs: playbook.inputs, flow: playbook.flow, policy: playbook.policy, scripts });

const unapproved = () => new OpenFleetError('playbook_unapproved', 'no human approved this playbook as it stands.', { hint: 'Review it in the desktop app, then approve its digest.' });
const scriptChanged = (program: string) => new OpenFleetError('script_changed', `the script "${program}" is not the file that was approved.`, { hint: 'Review the script, then approve the playbook again.' });

/**
 * The approval of the code a playbook runs. The digest covers the content of the playbook and the sha256 of every script file it names, so a changed cell or a changed file is a different digest.
 * It is written through the admin REST only: no MCP tool approves, so an agent with its MCP token alone never approves what it wrote.
 * By design the admin token is not a proof of a human gesture (any process of the user can read it): whoever holds it can read the digest, approve and run a playbook it wrote itself,
 * the same as for `agent_locked`. The approval separates the admin from the MCP token and nothing more; the desktop app is where a human is expected to read the digest before confirming it.
 * An edit of the playbook clears the approval (the repository does it in the same statement).
 */
export class PlaybookApprovals {
  constructor(private readonly deps: PlaybookApprovalsDeps) {}

  /** The digest the playbook would be approved under now. Throws script_not_allowed for a program no script root holds or that cannot be started safely. */
  preview(playbook: PlaybookRecord): ApprovalPreview {
    const scripts = Object.fromEntries(scriptProgramsOf(playbook).map((program) => [program, this.deps.locator.locate(program).sha256]));
    return { digest: digestOf(playbook, scripts), scripts };
  }

  /** Approves the playbook when `digest` is the digest it has now. Throws approval_digest_mismatch otherwise, so a human approves what they read. */
  approve(playbook: PlaybookRecord, { digest, by }: { digest: string; by: string }): void {
    const current = this.preview(playbook);
    const isWhatWasReviewed = digest === current.digest;
    if (!isWhatWasReviewed) throw new OpenFleetError('approval_digest_mismatch', 'the digest is not the one of the playbook as it stands.', { hint: 'Read the approval again, then confirm its digest.' });
    const wasApproved = this.deps.repository.approve({ id: playbook.id, expectedRev: playbook.contentRev, digest, scripts: current.scripts, by, at: this.deps.clock() });
    if (!wasApproved) throw new OpenFleetError('playbook_conflict', 'the playbook moved while it was approved.', { hint: 'Reload the playbook, then approve again.' });
  }

  /**
   * Returns the sha256 of each pinned script when the approval still holds.
   * Throws playbook_unapproved when nothing is approved or the content no longer matches the approved digest,
   * and script_changed when a pinned file is missing, unsafe to start or no longer the file that was approved.
   */
  assertStillApproved(playbook: PlaybookRecord): Record<string, string> {
    const { approvedDigest, approvedScripts } = playbook;
    if (approvedDigest === null || approvedScripts === null) throw unapproved();
    for (const program of Object.keys(approvedScripts)) this.locatePinned(program, approvedScripts);
    const contentMatchesTheApproval = digestOf(playbook, approvedScripts) === approvedDigest;
    if (!contentMatchesTheApproval) throw unapproved();
    return approvedScripts;
  }

  /** The file of a program, once it is the pinned one. Throws script_changed for a program that was not pinned, a file that is gone or unsafe, or a file whose sha256 differs. */
  locatePinned(program: string, pinned: Record<string, string>): LocatedScript {
    const located = this.deps.locator.tryLocate(program);
    const isThePinnedFile = located !== undefined && located.sha256 === pinned[program];
    if (!isThePinnedFile) throw scriptChanged(program);
    return located;
  }
}
