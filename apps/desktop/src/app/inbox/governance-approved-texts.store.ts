import { Injectable, signal } from '@angular/core';

export interface ApprovedText {
  readonly proposalId: string;
  readonly managerName: string;
  readonly typeLabel: string;
  readonly excerpt: string;
  readonly text: string;
  readonly noteQuery: { projectId: string | undefined; noteId: string } | undefined;
}

/** The approved texts the human still has to copy into the mission note: they outlive the Inbox filter and the Inbox itself until dismissed. */
@Injectable({ providedIn: 'root' })
export class GovernanceApprovedTexts {
  private readonly remembered = signal<readonly ApprovedText[]>([]);
  readonly texts = this.remembered.asReadonly();

  remember(approved: ApprovedText): void {
    this.remembered.update((all) => [...all.filter((candidate) => candidate.proposalId !== approved.proposalId), approved]);
  }

  dismiss(proposalId: string): void {
    this.remembered.update((all) => all.filter((approved) => approved.proposalId !== proposalId));
  }
}
