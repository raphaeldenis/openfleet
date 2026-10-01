import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

const CONFIRMATION_MS = 2000;
const IDLE_LABEL = 'Copy details';

/** Puts `text` on the clipboard and says so on the button and in a polite status region; the button keeps the focus so a keyboard user stays where they are. */
@Component({
  selector: 'of-copy-details-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="of-btn of-btn--secondary copy-details" [attr.data-testid]="testId()" (click)="copy()">{{ label() }}</button>
    <span class="visually-hidden" role="status">{{ announcement() }}</span>
  `,
  styles: `
    .copy-details { flex: none; height: 1.5rem; padding: 0 .625rem; font-size: .6875rem; white-space: nowrap; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
  `,
})
export class CopyDetailsButtonComponent {
  readonly text = input.required<string>();
  readonly testId = input.required<string>();
  protected readonly label = signal(IDLE_LABEL);
  protected readonly announcement = signal('');
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  protected async copy(): Promise<void> {
    const isCopied = await this.writeToClipboard();
    const outcome = isCopied ? 'Copied' : 'Copy failed';
    this.label.set(outcome);
    this.announcement.set(outcome);
    clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.showIdle(), CONFIRMATION_MS);
  }

  private async writeToClipboard(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.text());
      return true;
    } catch {
      return false;
    }
  }

  private showIdle(): void {
    this.label.set(IDLE_LABEL);
    this.announcement.set('');
  }
}
