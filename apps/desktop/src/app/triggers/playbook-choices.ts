import { escapedControlsOf } from '@openfleet/shared';
import type { PlaybookView } from '../core/playbook-trigger-views';

/** A playbook the human can choose to run: its id for the daemon, its name written as plain text for the screen. */
export interface PlaybookChoice {
  id: string;
  label: string;
}

/** The playbooks of one project, in the order the daemon lists them; a playbook of another project is never offered. */
export function playbookChoicesOf({ playbooks, projectId }: { playbooks: PlaybookView[]; projectId: string }): PlaybookChoice[] {
  return playbooks.filter((playbook) => playbook.projectId === projectId).map((playbook) => ({ id: playbook.id, label: escapedControlsOf(playbook.name) }));
}
