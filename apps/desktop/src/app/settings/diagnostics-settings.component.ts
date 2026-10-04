import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FleetApiService } from '../core/fleet-api.service';
import { DiagnosticsExport } from '../core/diagnostics-export';
import { buildBundle, sizeLabelOf } from './diagnostics-bundle';
import { copiedReferencesLabel, referenceListText, referencesOf } from './diagnostics-references';

type ExportState =
  | { kind: 'idle' }
  | { kind: 'exporting' }
  | { kind: 'saved'; fileName: string; sizeLabel: string }
  | { kind: 'failed'; cause: BundleFailure };

type BundleFailure = 'daemon_silent' | 'not_written';

type CopyOutcome = { kind: 'none' } | { kind: 'copied'; count: number } | { kind: 'no_references' } | { kind: 'failed'; cause: 'daemon_silent' | 'clipboard' };

const UNAVAILABLE_TOOLTIP = 'Available in the OpenFleet desktop app';

const BUNDLE_FAILURE_TEXT: Record<BundleFailure, string> = {
  daemon_silent: 'The bundle was not written — the daemon did not answer – start it and try again.',
  not_written: 'The bundle was not written — the file could not be saved – pick another folder and try again.',
};

const COPY_FAILURE_TEXT = {
  daemon_silent: 'The references were not copied — the daemon did not answer – try again.',
  clipboard: 'The references were not copied — the clipboard refused them – try again.',
};

@Component({
  selector: 'of-diagnostics-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" data-testid="settings-diagnostics">
      <h1>Diagnostics</h1>
      <div class="rows">
        <div class="row">
          <div class="label">
            <span class="name">Export diagnostics bundle…</span>
            <span class="detail">Logs, daemon version, recent errors (secrets masked) · {{ exporter.isAvailable ? 'opens the macOS save dialog' : unavailableTooltip }}</span>
          </div>
          <button
            type="button"
            class="of-btn of-btn--secondary"
            data-testid="diagnostics-export"
            [disabled]="isExportDisabled()"
            [attr.aria-busy]="exportState().kind === 'exporting' ? 'true' : null"
            [attr.title]="exporter.isAvailable ? null : unavailableTooltip"
            (click)="onExportButton()"
          >{{ exportButtonLabel() }}</button>
        </div>
        <div class="row">
          <div class="label">
            <span class="name">Copy reference list</span>
            <span class="detail">The references of the last 50 errors, one per line</span>
          </div>
          <button type="button" class="of-btn of-btn--secondary" data-testid="diagnostics-copy-references" [disabled]="isCopying()" (click)="copyReferences()">Copy</button>
        </div>
      </div>
      @if (savedState(); as saved) {
        <p class="line" role="status" data-testid="diagnostics-saved"><span class="ok">✓</span> Saved {{ saved.fileName }} · {{ saved.sizeLabel }}</p>
      }
      @if (failedText(); as failure) {
        <p class="line" role="alert" data-testid="diagnostics-failed"><span class="bad">✕</span> {{ failure }}</p>
      }
      @if (revealError()) {
        <p class="line" role="alert" data-testid="diagnostics-reveal-error"><span class="bad">✕</span> Couldn’t show the bundle in Finder.</p>
      }
      <p class="hint" role="status" aria-live="polite" data-testid="diagnostics-copy-status">{{ copyStatus() }}</p>
      @if (copyFailure(); as failure) {
        <p class="line" role="alert" data-testid="diagnostics-copy-failed"><span class="bad">✕</span> {{ failure }}</p>
      }
    </section>
  `,
  styles: `
    .panel { max-width: 40rem; display: flex; flex-direction: column; gap: 1rem; }
    h1 { margin: 0; font-size: 1.125rem; font-weight: 600; }
    .rows { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .row { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
    .row:last-child { border-bottom: 0; }
    .label { flex: 1; display: flex; flex-direction: column; }
    .name { font-weight: 500; }
    .detail { font-size: .75rem; color: var(--mut); }
    .hint { margin: 0; font-size: .75rem; color: var(--mut); }
    .hint:empty { position: absolute; }
    .line { margin: 0; display: flex; gap: .5rem; font-size: .75rem; color: var(--fg); }
    .ok { color: var(--s-idle); }
    .bad { color: var(--state-error); }
  `,
})
export class DiagnosticsSettingsComponent {
  private readonly api = inject(FleetApiService);
  protected readonly exporter = inject(DiagnosticsExport);
  protected readonly unavailableTooltip = UNAVAILABLE_TOOLTIP;

  protected readonly exportState = signal<ExportState>({ kind: 'idle' });
  protected readonly copyOutcome = signal<CopyOutcome>({ kind: 'none' });
  protected readonly isCopying = signal(false);
  protected readonly revealError = signal(false);

  protected readonly isExportDisabled = computed(() => !this.exporter.isAvailable || this.exportState().kind === 'exporting');
  protected readonly exportButtonLabel = computed(() => {
    const state = this.exportState();
    if (state.kind === 'exporting') return 'Exporting…';
    if (state.kind === 'saved') return 'Reveal';
    if (state.kind === 'failed') return 'Try again';
    return 'Export…';
  });
  protected readonly savedState = computed(() => {
    const state = this.exportState();
    return state.kind === 'saved' ? state : null;
  });
  protected readonly failedText = computed(() => {
    const state = this.exportState();
    return state.kind === 'failed' ? BUNDLE_FAILURE_TEXT[state.cause] : null;
  });
  protected readonly copyStatus = computed(() => {
    const outcome = this.copyOutcome();
    if (outcome.kind === 'copied') return copiedReferencesLabel(outcome.count);
    if (outcome.kind === 'no_references') return 'No references yet · nothing was copied';
    return '';
  });
  protected readonly copyFailure = computed(() => {
    const outcome = this.copyOutcome();
    return outcome.kind === 'failed' ? COPY_FAILURE_TEXT[outcome.cause] : null;
  });

  protected onExportButton(): void {
    if (this.exportState().kind === 'saved') void this.revealSavedBundle();
    else void this.exportBundle();
  }

  private async exportBundle(): Promise<void> {
    this.revealError.set(false);
    this.exportState.set({ kind: 'exporting' });
    const daemonDocument = await this.api.diagnostics().catch(() => undefined);
    if (daemonDocument === undefined) return this.exportState.set({ kind: 'failed', cause: 'daemon_silent' });
    try {
      const desktopLog = await this.exporter.readDesktopLog();
      const bundle = buildBundle({ daemonDocument, desktopLog, at: new Date() });
      const outcome = await this.exporter.saveBundle(bundle);
      const wasDismissed = outcome.status === 'cancelled';
      this.exportState.set(wasDismissed ? { kind: 'idle' } : { kind: 'saved', fileName: bundle.fileName, sizeLabel: sizeLabelOf(bundle.bytes.length) });
    } catch {
      this.exportState.set({ kind: 'failed', cause: 'not_written' });
    }
  }

  private async revealSavedBundle(): Promise<void> {
    this.revealError.set(false);
    try {
      await this.exporter.revealSavedBundle();
    } catch {
      this.revealError.set(true);
    }
  }

  protected async copyReferences(): Promise<void> {
    this.isCopying.set(true);
    this.copyOutcome.set({ kind: 'none' });
    try {
      this.copyOutcome.set(await this.copiedOutcome());
    } finally {
      this.isCopying.set(false);
    }
  }

  private async copiedOutcome(): Promise<CopyOutcome> {
    const daemonDocument = await this.api.diagnostics().catch(() => undefined);
    if (daemonDocument === undefined) return { kind: 'failed', cause: 'daemon_silent' };
    const references = referencesOf(daemonDocument);
    if (references.length === 0) return { kind: 'no_references' };
    try {
      await navigator.clipboard.writeText(referenceListText(references));
      return { kind: 'copied', count: references.length };
    } catch {
      return { kind: 'failed', cause: 'clipboard' };
    }
  }
}
