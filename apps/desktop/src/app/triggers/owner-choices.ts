import { MANAGER_ROLE, escapedControlsOf, type Session } from '@openfleet/shared';

/** A manager the human can choose as the owner of a trigger: its id for the daemon, its name written as plain text for the screen. */
export interface OwnerChoice {
  id: string;
  label: string;
}

/** The managers of one project, in the order the daemon lists them; a session of another project or a worker is never offered. */
export function ownerChoicesOf({ sessions, projectId }: { sessions: Session[]; projectId: string }): OwnerChoice[] {
  const isManagerOfProject = (session: Session) => session.role === MANAGER_ROLE && session.projectId === projectId;
  return sessions.filter(isManagerOfProject).map((manager) => ({ id: manager.id, label: escapedControlsOf(manager.name) }));
}

/**
 * The owner a choice in the list stands for: `null` for no manager, an id the list offers, or the owner the form was opened with.
 * Anything else is no choice at all, so an id that is not in the list never reaches the draft.
 */
export function acceptedOwnerOf({ chosenValue, choices, openedWith }: { chosenValue: string; choices: OwnerChoice[]; openedWith: string | null }): { owner: string | null } | undefined {
  if (chosenValue === '') return { owner: null };
  const isOffered = choices.some((choice) => choice.id === chosenValue) || chosenValue === openedWith;
  return isOffered ? { owner: chosenValue } : undefined;
}
