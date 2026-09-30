import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({ selector: 'of-right-panel-toggle', changeDetection: ChangeDetectionStrategy.OnPush, template: `` })
export class RightPanelToggleComponent {}

@Component({ selector: 'of-right-panel', changeDetection: ChangeDetectionStrategy.OnPush, template: `` })
export class RightPanelComponent {}

export function watchedSessionIdOf(url: string): string | undefined {
  return url ? undefined : undefined;
}
