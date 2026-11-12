import type { TriggerCondition, TriggerFireReason, TriggerLedgerState, TriggerRun, TriggerWhen } from '@openfleet/shared';

const SESSION_STATE_LABELS = { waiting_permission: 'attend une permission', idle: 'est inactive', closed_with_error: 'se ferme en erreur' } as const;
const STORE_EVENT_LABELS = { new_matching_rows: 'une ligne est créée', row_updated: 'une ligne est modifiée', row_count: 'le nombre de lignes' } as const;
const CATCH_UP_LABELS = { skip: 'les créneaux manqués sont ignorés', run_once: 'le dernier créneau manqué est rattrapé', run_all: 'les cinq derniers créneaux manqués sont rattrapés' } as const;
const OPERATOR_LABELS: Record<TriggerCondition['op'], string> = {
  contains: 'contient', ends_with: 'finit par', eq: '=', exists: 'existe', gt: '>', gte: '≥', lt: '<', lte: '≤', neq: '≠', not_contains: 'ne contient pas', not_exists: "n'existe pas", starts_with: 'commence par',
};

export const LEDGER_STATE_LABELS: Record<TriggerLedgerState, string> = {
  accepted: 'Accepté', attempted: 'Tenté', completed: 'Terminé', cancelled: 'Annulé', needs_review: 'À examiner',
};

export const FIRE_REASON_LABELS: Record<TriggerFireReason, string> = {
  interrupted: 'le démon s’est arrêté pendant l’effet', stale: 'trop ancien', superseded: 'remplacé par un tir plus récent', batched: 'regroupé dans un lot', disarmed: 'le trigger n’était plus armé',
  target_unavailable: 'cible indisponible', target_not_eligible: 'cible non éligible', cooldown: 'délai de repos', daily_cap: 'plafond du jour atteint', breaker_open: 'disjoncteur ouvert',
  chain_depth: 'chaîne trop profonde', action_failed: 'l’action a échoué',
  playbook_unapproved: 'playbook non approuvé tel qu’il est', playbook_unavailable: 'playbook introuvable ou hors du projet', playbook_inputs_invalid: 'entrées du playbook refusées',
  playbook_busy: 'playbook déjà en cours ou plafond de runs atteint',
};

/** The WHEN of a trigger as one French sentence. */
export function whenText(when: TriggerWhen): string {
  switch (when.source) {
    case 'session_state': {
      const waited = when.minutes === undefined ? '' : ` depuis ${when.minutes} min`;
      return `Une session enfant ${SESSION_STATE_LABELS[when.state]}${waited}`;
    }
    case 'silent_run': return `Une session enfant génère sans signe de vie depuis ${when.minutes} min`;
    case 'data_store_query': {
      const isRowCount = when.event === 'row_count';
      const threshold = isRowCount ? ` ${OPERATOR_LABELS[when.op ?? 'eq']} ${String(when.value)}` : '';
      return `Dans la table ${when.storeId} : ${STORE_EVENT_LABELS[when.event]}${threshold}`;
    }
    case 'cron': return `Cron « ${when.expression} » (${when.timezone}) ; ${CATCH_UP_LABELS[when.catchUp]}`;
    case 'integration_records': {
      const keyFilter = when.keyPrefix === undefined ? '' : ` ; clés ${when.keyPrefix}-*`;
      const statusFilter = when.statuses === undefined ? '' : ` ; statuts ${when.statuses.join(', ')}`;
      return `Intégration ${when.integrationId} : ${when.event}${keyFilter}${statusFilter}`;
    }
  }
}

/** The RUN of a trigger as one French sentence. */
export function runText(run: TriggerRun): string {
  switch (run.kind) {
    case 'prompt_manager': return `Envoie un prompt au manager${run.managerId === undefined ? ' propriétaire' : ` ${run.managerId}`}`;
    case 'notify': return `Notifie : « ${run.title} »`;
    case 'prompt_session': return `Envoie un prompt à la session ${run.sessionId}`;
    case 'close_session': return `Ferme la session ${run.sessionId}`;
    case 'run_playbook': return `Lance le playbook ${run.playbookId} (l’exécution n’est pas encore disponible)`;
  }
}

/** One condition as `field op value`, with its join word when it is not the first. */
export function conditionText(condition: TriggerCondition, { isFirst }: { isFirst: boolean }): string {
  const join = isFirst ? '' : `${condition.join === 'or' ? 'ou' : 'et'} `;
  const value = condition.rhs === undefined ? '' : ` ${JSON.stringify(condition.rhs)}`;
  return `${join}${condition.lhs} ${OPERATOR_LABELS[condition.op]}${value}`;
}
