import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

const CONFIRMATION_MS = 2000;

/** Puts `text` on the clipboard and says so on the button itself; the button keeps the focus so a keyboard user stays where they are. */
@Component({
  selector: 'of-copy-details-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="of-btn of-btn--secondary copy-details" [attr.data-testid]="testId()" (click)="copy()">{{ label() }}</button>
  `,
  styles: `
    .copy-details { flex: none; height: 1.5rem; padding: 0 .625rem; font-size: .6875rem; white-space: nowrap; }
  `,
})
export class CopyDetailsButtonComponent {
  readonly text = input.required<string>();
  readonly testId = input.required<string>();
  protected readonly label = signal('Copy details');

  protected async copy(): Promise<void> {
    const isCopied = await navigator.clipboard.writeText(this.text()).then(() => true, () => false);
    this.label.set(isCopied ? 'Copied' : 'Copy failed');
    setTimeout(() => this.label.set('Copy details'), CONFIRMATION_MS);
  }
}
