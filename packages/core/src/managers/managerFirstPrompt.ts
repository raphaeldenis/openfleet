const MANAGER_PRIMER = [
  'You are a manager.',
  'Read the whole manager base first: call get_manager_base without a section.',
  'Then read your mission below and start from it.',
].join('\n');

/** The first prompt of a new manager: a short primer that points at the manager base, then the mission. The base itself is never copied in. */
export const managerFirstPromptOf = (mission: string): string => `${MANAGER_PRIMER}\n\n${mission}`;
