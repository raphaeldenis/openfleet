import { Injectable, computed, inject } from '@angular/core';
import { FleetEventsService } from '../core/fleet-events.service';
import { AnsweredRepliesStore } from '../working-state/answered-replies.store';
import { attentionItemsOf, inboxCountLabelOf, itemsNeedingYouOf, statesWithoutOpenEscalationLines } from '../working-state/attention-items';
import { contextNoticesOf } from '../working-state/context-notices';

/** What the Inbox title and the sidebar Inbox badge both count: gates, governance proposals, escalations, questions and context notices. */
@Injectable({ providedIn: 'root' })
export class InboxNeedingYou {
  private readonly events = inject(FleetEventsService);
  private readonly answeredReplies = inject(AnsweredRepliesStore);

  readonly count = computed(() => {
    const openEscalations = this.events.escalations();
    const statesToAsk = statesWithoutOpenEscalationLines(this.events.workingStates(), new Set(openEscalations.map(({ id }) => id)));
    const attentionItems = attentionItemsOf(this.events.sessions(), statesToAsk, this.answeredReplies.answeredReplyBySessionId());
    const attentionCount = itemsNeedingYouOf(attentionItems).length;
    const contextNoticeCount = contextNoticesOf(this.events.sessions()).length;
    return this.events.approvals().length + this.events.proposals().length + openEscalations.length + attentionCount + contextNoticeCount;
  });

  /** The count as the badge shows it, or undefined when nothing needs the human. */
  readonly label = computed(() => (this.count() > 0 ? inboxCountLabelOf(this.count()) : undefined));
}
