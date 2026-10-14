import { TestBed } from '@angular/core/testing';
import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { CommandPolicyEvaluateResult, CommandPolicyRuleView, CommandPolicyView, DaemonIssue, DeniedCommand } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';
import { SettingsComponent } from './settings.component';

// Black-box specs of the Command policy section: the daemon is a stubbed fetch, the section is exercised through the REST calls it sends.

const RM_RULE: CommandPolicyRuleView = { id: 'no-forced-recursive-rm', origin: 'delivered', decision: 'deny', enabled: true, profiles: ['default', 'dev'], presence: 'unattended', reason: 'rm -rf asks for a confirmation nobody sees.', alternative: 'Use `rm -r <path>` inside your worktree.' };
const CLEAN_RULE: CommandPolicyRuleView = { id: 'no-forced-git-clean', origin: 'delivered', decision: 'deny', enabled: true, profiles: ['default'], presence: 'unattended', reason: 'git clean -f deletes files.', alternative: 'Remove files with rm.' };

const policyView = (changes: Partial<CommandPolicyView> = {}): CommandPolicyView => ({
  mode: 'observe', unattended: { askBecomesDeny: true }, rules: [RM_RULE, CLEAN_RULE], override: null, issues: [], ...changes,
});

const denial = (changes: Partial<DeniedCommand> = {}): DeniedCommand => ({
  id: 'd1', sessionId: 'abcdef1234567890', managerId: 'm1', profile: 'dev', harness: 'claude-cli', ruleId: 'no-forced-recursive-rm', decisionSource: 'policy',
  outcome: 'denied', toolName: 'Bash', commandExcerpt: 'rm -rf build', alternative: 'Use rm -r.', actor: 'session', createdAt: '2026-10-14T10:00:00.000Z', ...changes,
});

class DaemonRefusal {
  constructor(readonly status: number, readonly error: string) {}
}

interface FakeDaemon {
  view?: CommandPolicyView;
  denials?: DeniedCommand[];
  nextCursor?: string;
  moreDenials?: DeniedCommand[];
  save?: (override: unknown) => Promise<CommandPolicyView>;
  evaluate?: (request: unknown) => Promise<CommandPolicyEvaluateResult>;
  failsToLoadPolicy?: boolean;
}

async function renderCommandPolicy(daemon: FakeDaemon = {}) {
  let current = daemon.view ?? policyView();
  const saves: unknown[] = [];
  const evaluations: unknown[] = [];
  const applyOverride = (override: NonNullable<CommandPolicyView['override']>): CommandPolicyView => ({
    ...current,
    ...(override.mode === undefined ? {} : { mode: override.mode }),
    unattended: { askBecomesDeny: override.unattended?.askBecomesDeny ?? current.unattended.askBecomesDeny },
    rules: current.rules.map((rule) => ({ ...rule, enabled: !(override.disabledRules ?? []).includes(rule.id) })),
    override,
  });
  const save = daemon.save ?? ((override: unknown) => Promise.resolve(applyOverride(override as NonNullable<CommandPolicyView['override']>)));
  const fetchStub = vi.fn((url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const respond = async (): Promise<unknown> => {
      if (pathname === '/api/command-policy' && init?.method === 'PUT') { const body: unknown = JSON.parse(String(init.body)); saves.push(body); current = await save(body); return current; }
      if (pathname === '/api/command-policy/evaluate') { const body: unknown = JSON.parse(String(init?.body)); evaluations.push(body); return (daemon.evaluate ?? (() => Promise.resolve({ verdict: { decision: 'allow' }, mode: 'observe', profile: 'default' })))(body); }
      if (pathname === '/api/command-policy/denials') return searchParams.has('cursor') ? { items: daemon.moreDenials ?? [] } : { items: daemon.denials ?? [], ...(daemon.nextCursor === undefined ? {} : { nextCursor: daemon.nextCursor }) };
      if (pathname === '/api/command-policy') { if (daemon.failsToLoadPolicy) throw new DaemonRefusal(500, 'internal_error'); return current; }
      return {};
    };
    return respond().then(
      (body) => new Response(JSON.stringify(body)),
      (failure: unknown) => (failure instanceof DaemonRefusal ? new Response(JSON.stringify({ error: failure.error }), { status: failure.status }) : Promise.reject(failure)),
    );
  });
  vi.stubGlobal('fetch', fetchStub);
  const view = await render(SettingsComponent);
  await userEvent.click(screen.getByRole('tab', { name: 'Command policy' }));
  return { ...view, saves, evaluations };
}

const modeRadio = (name: 'Enforce' | 'Observe' | 'Off') => screen.findByRole('radio', { name });
const askSwitch = () => screen.findByRole('switch', { name: 'Refuse permission dialogs nobody can answer' });

afterEach(() => vi.unstubAllGlobals());

describe('Settings → Command policy', () => {
  it('is a section of the settings tabs, with its heading', async () => {
    await renderCommandPolicy();

    expect(await screen.findByRole('heading', { level: 1, name: 'Command policy' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual(['General', 'Models', 'Command policy', 'Daemon', 'Diagnostics', 'About']);
  });

  it('shows the mode the daemon enforces, in a radio group a screen reader can name', async () => {
    await renderCommandPolicy({ view: policyView({ mode: 'enforce' }) });

    expect(await modeRadio('Enforce')).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Observe' })).not.toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'Command policy mode' })).toBeInTheDocument();
    expect(screen.getByTestId('policy-mode-consequence')).toHaveTextContent('Refuses what the rules of a role profile forbid');
  });

  it('saves the whole override with the chosen mode at once, keeping what the file already says', async () => {
    const { saves } = await renderCommandPolicy({ view: policyView({ override: { version: 1, disabledRules: ['no-forced-git-clean'] } }) });

    await userEvent.click(await modeRadio('Enforce'));

    expect(await screen.findByTestId('policy-save-status')).toHaveTextContent('Saved: mode enforce');
    expect(saves).toEqual([{ version: 1, disabledRules: ['no-forced-git-clean'], mode: 'enforce' }]);
    expect(screen.getByRole('radio', { name: 'Enforce' })).toBeChecked();
  });

  it('says that mode Off still leaves permission dialogs of unattended sessions refused', async () => {
    await renderCommandPolicy({ view: policyView({ mode: 'off' }) });

    expect(await screen.findByTestId('policy-mode-consequence')).toHaveTextContent('Permission dialogs of unattended sessions are still refused');
    expect(await askSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('turns the ask switch off with the consequences spelled out, and saves unattended.askBecomesDeny false', async () => {
    const { saves } = await renderCommandPolicy();
    expect(await screen.findByTestId('policy-ask-consequence')).toHaveTextContent('immediate refusal');

    await userEvent.click(await askSwitch());

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Refuse permission dialogs nobody can answer' })).toHaveAttribute('aria-checked', 'false'));
    expect(saves).toEqual([{ version: 1, unattended: { askBecomesDeny: false } }]);
    expect(screen.getByTestId('policy-ask-consequence')).toHaveTextContent('back to the approval flow');
    expect(screen.getByTestId('policy-ask-consequence')).toHaveTextContent('30 seconds');
  });

  it('keeps the switch on the keyboard: Space toggles it', async () => {
    const { saves } = await renderCommandPolicy();
    const toggle = await askSwitch();

    toggle.focus();
    await userEvent.keyboard(' ');

    await waitFor(() => expect(saves).toHaveLength(1));
  });

  it('lists every rule with its id, profiles, decision, alternative and state', async () => {
    await renderCommandPolicy({ view: policyView({ rules: [RM_RULE, { ...CLEAN_RULE, enabled: false }] }) });

    const rmRow = await screen.findByTestId('policy-rule-no-forced-recursive-rm');
    expect(within(rmRow).getByText('default, dev')).toBeInTheDocument();
    expect(within(rmRow).getByText('deny')).toBeInTheDocument();
    expect(within(rmRow).getByText('Use `rm -r <path>` inside your worktree.')).toBeInTheDocument();
    expect(within(rmRow).getByText('Enabled')).toBeInTheDocument();
    expect(within(screen.getByTestId('policy-rule-no-forced-git-clean')).getByText('Disabled')).toBeInTheDocument();
  });

  it('disables a rule by its id and keeps the other fields of the override', async () => {
    const { saves } = await renderCommandPolicy({ view: policyView({ override: { version: 1, mode: 'enforce' } }) });

    await userEvent.click(await screen.findByRole('button', { name: 'Disable rule no-forced-recursive-rm' }));

    expect(await screen.findByRole('button', { name: 'Enable rule no-forced-recursive-rm' })).toBeInTheDocument();
    expect(saves).toEqual([{ version: 1, mode: 'enforce', disabledRules: ['no-forced-recursive-rm'] }]);
  });

  it('enables a disabled rule by removing it from the disabled list', async () => {
    const { saves } = await renderCommandPolicy({ view: policyView({ override: { version: 1, disabledRules: ['no-forced-git-clean', 'no-forced-recursive-rm'] }, rules: [RM_RULE, { ...CLEAN_RULE, enabled: false }] }) });

    await userEvent.click(await screen.findByRole('button', { name: 'Enable rule no-forced-git-clean' }));

    await waitFor(() => expect(saves).toEqual([{ version: 1, disabledRules: ['no-forced-recursive-rm'] }]));
  });

  it('offers no switch for a custom rule: it lives in the file', async () => {
    await renderCommandPolicy({ view: policyView({ rules: [{ ...RM_RULE, id: 'my-rule', origin: 'custom' }] }) });

    const row = await screen.findByTestId('policy-rule-my-rule');

    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).getByText('Custom · edit command-policy.json, then restart the daemon to apply')).toBeInTheDocument();
  });

  it('keeps the name cell of a rule a plain table cell, not a flex box', async () => {
    await renderCommandPolicy();

    const nameCell = within(await screen.findByTestId('policy-rule-no-forced-recursive-rm')).getByRole('rowheader');

    expect(getComputedStyle(nameCell).display).not.toBe('flex');
    expect(nameCell).toHaveTextContent('rm -rf asks for a confirmation nobody sees.');
  });

  it('says where the previous hand-edited file went after a save that dropped parts of it', async () => {
    await renderCommandPolicy({ save: (override) => Promise.resolve({ ...policyView({ override: override as CommandPolicyView['override'] }), previousFileKeptAs: 'command-policy.json.bak-2026-10-14T10-00-00-000Z' }) });

    await userEvent.click(await modeRadio('Enforce'));

    expect(await screen.findByTestId('policy-save-status')).toHaveTextContent('The previous file is kept as command-policy.json.bak-2026-10-14T10-00-00-000Z.');
  });

  it('tells that saving rewrites the file without the ignored parts and keeps a copy', async () => {
    await renderCommandPolicy({ view: policyView({ issues: ['rule no-yarn: too long'] }) });

    expect(await screen.findByTestId('policy-file-issues')).toHaveTextContent('Saving here rewrites the file without them and keeps a copy.');
  });

  it('keeps the previous mode on screen and says nothing changed when the file is read-only', async () => {
    await renderCommandPolicy({ save: () => Promise.reject(new DaemonRefusal(409, 'config_read_only')) });

    await userEvent.click(await modeRadio('Enforce'));

    expect(await screen.findByTestId('policy-save-error')).toHaveTextContent('command-policy.json is read-only. Nothing was changed.');
    expect(screen.getByRole('radio', { name: 'Observe' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Enforce' })).not.toBeChecked();
  });

  it('says the file cannot be read when the daemon answers config_unreadable', async () => {
    await renderCommandPolicy({ save: () => Promise.reject(new DaemonRefusal(409, 'config_unreadable')) });

    await userEvent.click(await askSwitch());

    expect(await screen.findByTestId('policy-save-error')).toHaveTextContent('can’t be read: fix it by hand');
  });

  it('says the load failed when the daemon does not give the policy', async () => {
    await renderCommandPolicy({ failsToLoadPolicy: true });

    expect(await screen.findByTestId('policy-error')).toHaveTextContent('Couldn’t load the command policy from the daemon.');
  });

  it('names the parts of the file the daemon ignores', async () => {
    await renderCommandPolicy({ view: policyView({ issues: ['rule no-pnpm: a deny rule requires an alternative'] }) });

    expect(await screen.findByTestId('policy-file-issues')).toHaveTextContent('Parts of command-policy.json are ignored: rule no-pnpm: a deny rule requires an alternative');
  });

  it('draws rule text from the daemon as inert text', async () => {
    const hostile = '<img src=x onerror="document.title=\'pwned\'">';
    await renderCommandPolicy({ view: policyView({ rules: [{ ...RM_RULE, reason: hostile, alternative: hostile }] }), denials: [denial({ commandExcerpt: hostile })] });

    const row = await screen.findByTestId('policy-rule-no-forced-recursive-rm');

    expect(row.querySelector('img')).toBeNull();
    expect(row).toHaveTextContent(hostile);
    expect(screen.getByTestId('policy-denials').querySelector('img')).toBeNull();
    expect(document.title).not.toBe('pwned');
  });
});

describe('Settings → Command policy → quick keyboard changes of the mode', () => {
  const viewSavedAs = (override: unknown): CommandPolicyView => policyView({ mode: (override as { mode: CommandPolicyView['mode'] }).mode, override: override as CommandPolicyView['override'] });

  it('sends only the last of several quick arrow presses once the save in flight is done, and ends on the focused mode', async () => {
    let finishFirstSave!: () => void;
    const firstSaveIsFinishable = new Promise<void>((resolve) => { finishFirstSave = resolve; });
    const { saves } = await renderCommandPolicy({ view: policyView({ mode: 'observe' }), save: async (override) => { await firstSaveIsFinishable; return viewSavedAs(override); } });
    (await modeRadio('Observe')).focus();

    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    finishFirstSave();

    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves.map((saved) => (saved as { mode: string }).mode)).toEqual(['off', 'observe']);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Observe' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'Observe' })).toHaveFocus();
  });

  it('puts the focus back on the checked radio when the save of the focused one is refused', async () => {
    await renderCommandPolicy({ save: () => Promise.reject(new DaemonRefusal(409, 'config_read_only')) });
    (await modeRadio('Observe')).focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(await screen.findByTestId('policy-save-error')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Observe' })).toHaveFocus());
    expect(screen.getByRole('radio', { name: 'Observe' })).toBeChecked();
  });
});

describe('Settings → Command policy → the ask switch turned off', () => {
  it('marks the switch and its consequence as a warning only while the dialogs go to the approval flow', async () => {
    await renderCommandPolicy();
    const toggle = await askSwitch();
    expect(toggle).not.toHaveAttribute('data-warning');
    expect(screen.getByTestId('policy-ask-consequence')).not.toHaveAttribute('data-warning');

    await userEvent.click(toggle);

    await waitFor(() => expect(screen.getByTestId('policy-ask-consequence')).toHaveAttribute('data-warning', '1'));
    expect(screen.getByRole('switch', { name: 'Refuse permission dialogs nobody can answer' })).toHaveAttribute('data-warning', '1');
  });

  it('stops saying the dialogs are still refused under mode Off once the switch is off', async () => {
    await renderCommandPolicy({ view: policyView({ mode: 'off', unattended: { askBecomesDeny: false } }) });

    const consequence = await screen.findByTestId('policy-mode-consequence');

    expect(consequence).not.toHaveTextContent('still refused');
    expect(consequence).toHaveTextContent('go to the approval flow');
  });
});

describe('Settings → Command policy → degradation', () => {
  const failOpenIssue = (count: number): DaemonIssue => ({ code: 'hook_fail_open', since: '2026-10-14T10:00:00.000Z', message: 'x', id: 'abcd1234', count });

  it('says the engine is healthy when nothing failed open', async () => {
    await renderCommandPolicy();

    expect(await screen.findByTestId('policy-degraded')).toHaveTextContent('Policy engine healthy');
  });

  it('shows the count of failures that went through unchecked', async () => {
    await renderCommandPolicy();
    await screen.findByTestId('policy-degraded');

    TestBed.inject(FleetEventsService).daemonIssues.set([failOpenIssue(4)]);

    await waitFor(() => expect(screen.getByTestId('policy-degraded')).toHaveTextContent('Degraded: the policy engine failed open 4 times'));
  });
});

describe('Settings → Command policy → try a command', () => {
  it('keeps Try it off until a command is typed', async () => {
    await renderCommandPolicy();

    expect(await screen.findByRole('button', { name: 'Try it' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Command to try'), 'ls');
    expect(screen.getByRole('button', { name: 'Try it' })).toBeEnabled();
  });

  it('sends the command, the role and the presence to the daemon and shows the refusal with its alternative', async () => {
    const refusal: CommandPolicyEvaluateResult = { verdict: { decision: 'deny', ruleId: 'no-forced-recursive-rm', reason: 'rm -rf asks.', alternative: 'Use rm -r.' }, mode: 'enforce', profile: 'dev' };
    const { evaluations } = await renderCommandPolicy({ evaluate: () => Promise.resolve(refusal) });

    await userEvent.type(await screen.findByLabelText('Command to try'), 'rm -rf build');
    await userEvent.type(screen.getByLabelText('Role (optional)'), 'DEV');
    await userEvent.selectOptions(screen.getByLabelText('Session'), 'attended');
    await userEvent.click(screen.getByRole('button', { name: 'Try it' }));

    const result = await screen.findByTestId('policy-try-result');
    await waitFor(() => expect(result).toHaveTextContent('Refused by no-forced-recursive-rm'));
    expect(result).toHaveTextContent('Alternative: Use rm -r.');
    expect(result).toHaveTextContent('Judged by the dev profile, policy mode enforce.');
    expect(evaluations).toEqual([{ command: 'rm -rf build', role: 'DEV', presence: 'attended' }]);
  });

  it('submits on Enter and omits an empty role', async () => {
    const { evaluations } = await renderCommandPolicy();

    await userEvent.type(await screen.findByLabelText('Command to try'), 'git status{Enter}');

    await waitFor(() => expect(evaluations).toEqual([{ command: 'git status', presence: 'unattended' }]));
    expect(await screen.findByTestId('policy-try-result')).toHaveTextContent('Allowed: no rule refuses it');
  });

  it('says a command is only observed, not refused, while the policy observes', async () => {
    const observed: CommandPolicyEvaluateResult = { verdict: { decision: 'allow', observed: { ruleId: 'no-forced-recursive-rm', reason: 'rm -rf asks.', alternative: 'Use rm -r.' } }, mode: 'observe', profile: 'default' };
    await renderCommandPolicy({ evaluate: () => Promise.resolve(observed) });

    await userEvent.type(await screen.findByLabelText('Command to try'), 'rm -rf x{Enter}');

    expect(await screen.findByText('Allowed: no-forced-recursive-rm would refuse it, but the policy only observes')).toBeInTheDocument();
  });

  it('clears the verdict as soon as the command is edited, so it never sits under another command', async () => {
    const refusal: CommandPolicyEvaluateResult = { verdict: { decision: 'deny', ruleId: 'no-forced-recursive-rm', reason: 'rm -rf asks.', alternative: 'Use rm -r.' }, mode: 'enforce', profile: 'dev' };
    await renderCommandPolicy({ evaluate: () => Promise.resolve(refusal) });
    await userEvent.type(await screen.findByLabelText('Command to try'), 'rm -rf build{Enter}');
    expect(await screen.findByText('Refused by no-forced-recursive-rm')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Command to try'), 'x');

    await waitFor(() => expect(screen.queryByText('Refused by no-forced-recursive-rm')).toBeNull());
  });

  it('keeps the focus on the Try button while the daemon judges, and sends one request only', async () => {
    let judge!: () => void;
    const judgement = new Promise<void>((resolve) => { judge = resolve; });
    const { evaluations } = await renderCommandPolicy({ evaluate: async () => { await judgement; return { verdict: { decision: 'allow' }, mode: 'observe', profile: 'default' }; } });
    await userEvent.type(await screen.findByLabelText('Command to try'), 'ls');
    const tryButton = screen.getByRole('button', { name: 'Try it' });

    await userEvent.click(tryButton);
    await userEvent.click(tryButton);

    expect(tryButton).toHaveFocus();
    expect(tryButton).toHaveAttribute('aria-disabled', 'true');
    expect(tryButton).not.toBeDisabled();
    judge();
    await waitFor(() => expect(evaluations).toHaveLength(1));
    await waitFor(() => expect(tryButton).toHaveAttribute('aria-disabled', 'false'));
  });

  it('says the daemon could not judge when the call fails', async () => {
    await renderCommandPolicy({ evaluate: () => Promise.reject(new DaemonRefusal(500, 'internal_error')) });

    await userEvent.type(await screen.findByLabelText('Command to try'), 'ls{Enter}');

    expect(await screen.findByText('The daemon could not judge this command. Try again.')).toBeInTheDocument();
  });
});

describe('Settings → Command policy → recent refusals', () => {
  it('says so when nothing was refused', async () => {
    await renderCommandPolicy();

    expect(await screen.findByTestId('policy-denials-empty')).toHaveTextContent('No refusal recorded yet.');
  });

  it('lists a refusal with its outcome, rule, excerpt, alternative and short session id', async () => {
    await renderCommandPolicy({ denials: [denial(), denial({ id: 'd2', outcome: 'observed', commandExcerpt: 'git clean -fd', ruleId: 'no-forced-git-clean' })] });

    const rows = await screen.findAllByTestId('policy-denial');

    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Refused')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('rm -rf build')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Alternative: Use rm -r.');
    expect(rows[0]).toHaveTextContent('session abcdef12');
    expect(within(rows[1]!).getByText('Observed')).toBeInTheDocument();
  });

  it('loads the next page behind the button until the daemon has no cursor left', async () => {
    await renderCommandPolicy({ denials: [denial()], nextCursor: 'next', moreDenials: [denial({ id: 'd9', commandExcerpt: 'older command' })] });

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('older command')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('moves the focus to the title of the list when the last Load more disappears', async () => {
    await renderCommandPolicy({ denials: [denial()], nextCursor: 'next', moreDenials: [denial({ id: 'd9', commandExcerpt: 'older command' })] });

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Recent refusals' })).toHaveFocus());
  });
});
