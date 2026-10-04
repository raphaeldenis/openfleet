import type { HandoffContent, HandoffPreview } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { HandoffPreviewApiError, type HandoffPreviewApi } from './handoff-preview.api';
import { HandoffPreviewStore } from './handoff-preview.store';

const SESSION_ID = 's1';

const DRAFT_SECTIONS: HandoffContent = {
  goal: 'Ship the handoff panel',
  state: 'generating',
  decisions: '',
  filesTouched: ' M panel.ts',
  nextSteps: '- wire the host',
  openQuestions: '',
};

function previewWith(overrides: Partial<HandoffPreview> = {}): HandoffPreview {
  return {
    sessionId: SESSION_ID,
    kind: 'session',
    sections: DRAFT_SECTIONS,
    sources: { goal: 'none', state: 'session', decisions: 'none', filesTouched: 'git', nextSteps: 'working_state', openQuestions: 'none' },
    truncated: [],
    target: { available: true, relativePath: 'handoffs/2026-10-04-gimli.md', writeOnCloseDefault: true },
    generatedAt: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function apiWith(overrides: Partial<HandoffPreviewApi> = {}): HandoffPreviewApi {
  return {
    getPreview: vi.fn().mockResolvedValue(previewWith()),
    save: vi.fn().mockResolvedValue({ relativePath: 'handoffs/2026-10-04-gimli.md' }),
    ...overrides,
  };
}

describe('HandoffPreviewStore', () => {
  it('starts idle with empty sections', () => {
    const store = new HandoffPreviewStore(apiWith());

    expect(store.state()).toBe('idle');
    expect(store.sections().goal).toBe('');
  });

  it('is loading while the preview is being collected', async () => {
    const pending = deferred<HandoffPreview>();
    const store = new HandoffPreviewStore(apiWith({ getPreview: () => pending.promise }));

    const opening = store.open(SESSION_ID);

    expect(store.state()).toBe('loading');
    pending.resolve(previewWith());
    await opening;
  });

  it('is ready with the collected sections, sources and target path once the preview arrives', async () => {
    const store = new HandoffPreviewStore(apiWith());

    await store.open(SESSION_ID);

    expect(store.state()).toBe('ready');
    expect(store.sections()).toEqual(DRAFT_SECTIONS);
    expect(store.sources().filesTouched).toBe('git');
    expect(store.relativePath()).toBe('handoffs/2026-10-04-gimli.md');
    expect(store.saveDisabledReason()).toBeUndefined();
  });

  it('knows the target is usable once the preview arrives, and not before nor after a reset', async () => {
    const store = new HandoffPreviewStore(apiWith());
    expect(store.isTargetAvailable()).toBe(false);

    await store.open(SESSION_ID);
    expect(store.isTargetAvailable()).toBe(true);

    store.reset();
    expect(store.isTargetAvailable()).toBe(false);
  });

  it('knows the target is unusable when the preview says so', async () => {
    const target = { available: false, reason: 'no_project' as const, writeOnCloseDefault: false };
    const store = new HandoffPreviewStore(apiWith({ getPreview: vi.fn().mockResolvedValue(previewWith({ target })) }));

    await store.open(SESSION_ID);

    expect(store.isTargetAvailable()).toBe(false);
  });

  it('is loadFailed with a message when the preview cannot be collected', async () => {
    const store = new HandoffPreviewStore(apiWith({ getPreview: vi.fn().mockRejectedValue(new Error('boom')) }));

    await store.open(SESSION_ID);

    expect(store.state()).toBe('loadFailed');
    expect(store.error()).toBeTruthy();
  });

  it('shows the copy the adapter supplies when the preview cannot be collected', async () => {
    const getPreview = vi.fn().mockRejectedValue(new HandoffPreviewApiError('That session no longer exists.'));
    const store = new HandoffPreviewStore(apiWith({ getPreview }));

    await store.open(SESSION_ID);

    expect(store.state()).toBe('loadFailed');
    expect(store.error()).toBe('That session no longer exists.');
  });

  it('shows the copy the adapter supplies when the save fails', async () => {
    const save = vi.fn().mockRejectedValue(new HandoffPreviewApiError('Saving handoffs is not available yet.'));
    const store = new HandoffPreviewStore(apiWith({ save }));
    await store.open(SESSION_ID);

    await store.save();

    expect(store.state()).toBe('error');
    expect(store.error()).toBe('Saving handoffs is not available yet.');
  });

  it('collects the preview again when retrying after a load failure', async () => {
    const getPreview = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(previewWith());
    const store = new HandoffPreviewStore(apiWith({ getPreview }));
    await store.open(SESSION_ID);

    await store.retry();

    expect(getPreview).toHaveBeenCalledTimes(2);
    expect(store.state()).toBe('ready');
    expect(store.error()).toBeUndefined();
  });

  it.each([
    ['no_project', 'Save is off: this project has no docs folder yet.'],
    ['no_docs_folder', 'Save is off: this project has no docs folder yet.'],
    ['docs_folder_unusable', 'Save is off: the docs folder is not writable.'],
  ] as const)('explains why saving is off when the target is unavailable (%s)', async (reason, expectedText) => {
    const target = { available: false, reason, writeOnCloseDefault: false };
    const store = new HandoffPreviewStore(apiWith({ getPreview: vi.fn().mockResolvedValue(previewWith({ target })) }));

    await store.open(SESSION_ID);

    expect(store.state()).toBe('ready');
    expect(store.saveDisabledReason()).toBe(expectedText);
  });

  it('does not save when the target is unavailable', async () => {
    const target = { available: false, reason: 'no_project' as const, writeOnCloseDefault: false };
    const api = apiWith({ getPreview: vi.fn().mockResolvedValue(previewWith({ target })) });
    const store = new HandoffPreviewStore(api);
    await store.open(SESSION_ID);

    await store.save();

    expect(api.save).not.toHaveBeenCalled();
    expect(store.state()).toBe('ready');
  });

  it('saves the edited sections and ends saved with the authoritative path', async () => {
    const api = apiWith({ save: vi.fn().mockResolvedValue({ relativePath: 'handoffs/2026-10-04-gimli-2.md' }) });
    const store = new HandoffPreviewStore(api);
    await store.open(SESSION_ID);
    store.edit({ ...store.sections(), decisions: 'Keep the store a plain class' });

    await store.save();

    expect(api.save).toHaveBeenCalledWith(SESSION_ID, { ...DRAFT_SECTIONS, decisions: 'Keep the store a plain class' });
    expect(store.state()).toBe('saved');
    expect(store.relativePath()).toBe('handoffs/2026-10-04-gimli-2.md');
  });

  it('is saving while the save is in flight', async () => {
    const pending = deferred<{ relativePath: string }>();
    const store = new HandoffPreviewStore(apiWith({ save: () => pending.promise }));
    await store.open(SESSION_ID);

    const saving = store.save();

    expect(store.state()).toBe('saving');
    pending.resolve({ relativePath: 'handoffs/x.md' });
    await saving;
  });

  it('sends only one save when Save is triggered twice in a row', async () => {
    const pending = deferred<{ relativePath: string }>();
    const api = apiWith({ save: vi.fn().mockReturnValue(pending.promise) });
    const store = new HandoffPreviewStore(api);
    await store.open(SESSION_ID);

    const firstSave = store.save();
    const secondSave = store.save();
    pending.resolve({ relativePath: 'handoffs/x.md' });
    await Promise.all([firstSave, secondSave]);

    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('ends in error and keeps the edits when the save fails', async () => {
    const api = apiWith({ save: vi.fn().mockRejectedValue(new Error('read-only')) });
    const store = new HandoffPreviewStore(api);
    await store.open(SESSION_ID);
    store.edit({ ...store.sections(), goal: 'My edited goal' });

    await store.save();

    expect(store.state()).toBe('error');
    expect(store.error()).toBeTruthy();
    expect(store.sections().goal).toBe('My edited goal');
  });

  it('saves the kept edits again when retrying after a save failure', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('read-only')).mockResolvedValueOnce({ relativePath: 'handoffs/x.md' });
    const store = new HandoffPreviewStore(apiWith({ save }));
    await store.open(SESSION_ID);
    store.edit({ ...store.sections(), goal: 'My edited goal' });
    await store.save();

    await store.retry();

    expect(save).toHaveBeenLastCalledWith(SESSION_ID, expect.objectContaining({ goal: 'My edited goal' }));
    expect(store.state()).toBe('saved');
    expect(store.error()).toBeUndefined();
  });

  it('does not collect the preview again when retrying after a save failure', async () => {
    const getPreview = vi.fn().mockResolvedValue(previewWith());
    const store = new HandoffPreviewStore(apiWith({ getPreview, save: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({ relativePath: 'p' }) }));
    await store.open(SESSION_ID);
    await store.save();

    await store.retry();

    expect(getPreview).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale preview answer when another session is opened meanwhile', async () => {
    const slow = deferred<HandoffPreview>();
    const getPreview = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce(previewWith({ sessionId: 's2', sections: { ...DRAFT_SECTIONS, goal: 'second' } }));
    const store = new HandoffPreviewStore(apiWith({ getPreview }));

    const firstOpen = store.open('s1');
    await store.open('s2');
    slow.resolve(previewWith({ sections: { ...DRAFT_SECTIONS, goal: 'first' } }));
    await firstOpen;

    expect(store.sections().goal).toBe('second');
  });

  it('goes back to idle with empty sections on reset', async () => {
    const store = new HandoffPreviewStore(apiWith());
    await store.open(SESSION_ID);

    store.reset();

    expect(store.state()).toBe('idle');
    expect(store.sections().goal).toBe('');
  });
});
