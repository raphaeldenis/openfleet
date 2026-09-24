import type { ServerEvent } from '@openfleet/shared';
export class EventBus {
  private listeners = new Set<(e: ServerEvent) => void>();
  emit(event: ServerEvent): void { for (const l of this.listeners) l(event); }
  subscribe(listener: (e: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
