import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { NewSessionFormComponent } from './new-session-form.component';

const PROJECT = { id: 'p1', name: 'Fleet', docsFolderPath: '/docs' };
const SECOND_PROJECT = { id: 'p2', name: 'Other', docsFolderPath: '/other-docs' };
const WITHOUT_DOCS = { id: 'p3', name: 'Bare', docsFolderPath: null };
const HANDOFF = { noteId: 'n1', file: 'gimli.md', title: 'Gimli', updatedAt: '2026-10-03T10:00:00Z' };
const page = (items = [HANDOFF]) => ({ items, total: items.length, limit: 200, offset: 0 });

async function renderForm(overrides: Record<string, unknown> = {}) {
  const api = {
    listProjects: vi.fn().mockResolvedValue({ items: [PROJECT, SECOND_PROJECT, WITHOUT_DOCS], total: 3 }),
    listHandoffs: vi.fn().mockResolvedValue(page()),
    createSession: vi.fn().mockResolvedValue({ id: 's1' }),
    createManagerSession: vi.fn().mockResolvedValue({ id: 'm1' }),
    ...overrides,
  };
  const { fixture } = await render(NewSessionFormComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: ActivatedRoute, useValue: { queryParamMap: new BehaviorSubject(convertToParamMap({})) } }] });
  vi.spyOn(fixture.debugElement.injector.get(Router), 'navigate').mockResolvedValue(true);
  await screen.findByTestId('new-session-project');
  return api;
}

const chooseProject = (id = PROJECT.id) => userEvent.selectOptions(screen.getByTestId('new-session-project'), id);
const openPicker = () => userEvent.click(screen.getByRole('combobox', { name: 'Start from a handoff' }));
const handoffList = () => within(screen.getByRole('listbox', { name: 'Handoffs' }));
const pickHandoff = async () => {
  await openPicker();
  await userEvent.click(await screen.findByRole('option', { name: /gimli.md/ }));
};
const fillFields = async () => {
  await userEvent.type(screen.getByTestId('new-session-directory'), '/workspace');
  await userEvent.type(screen.getByTestId('new-session-name'), 'New');
};

describe('New session handoff picker', () => {
  it('explains why it is disabled without a project or docs folder', async () => {
    await renderForm();
    expect(screen.getByText('Choose a project with a docs folder to start from a handoff.')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Start from a handoff' })).toBeDisabled();
    await chooseProject(WITHOUT_DOCS.id);
    expect(screen.getByRole('combobox', { name: 'Start from a handoff' })).toBeDisabled();
  });

  it('sends only the selected basename with its project and supports Remove', async () => {
    const api = await renderForm();
    await chooseProject();
    await pickHandoff();
    expect(screen.getByText('@file handoffs/gimli.md')).toHaveAttribute('title', 'Added to the first prompt as read-only context');
    await fillFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));
    expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT.id, handoffFile: 'gimli.md' }));
  });

  it('clears the selection and reloads the list when the project switches', async () => {
    const api = await renderForm({ listHandoffs: vi.fn().mockResolvedValueOnce(page()).mockResolvedValue(page([])) });
    await chooseProject();
    await pickHandoff();
    await chooseProject(SECOND_PROJECT.id);
    await waitFor(() => expect(screen.queryByText('@file handoffs/gimli.md')).toBeNull());
    await openPicker();
    expect(await screen.findByText('No handoffs yet — they appear here once a session writes one.')).toBeVisible();
    await fillFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));
    const submitted = api.createSession.mock.calls[0]![0];
    expect(submitted.projectId).toBe(SECOND_PROJECT.id);
    expect(submitted).not.toHaveProperty('handoffFile');
  });

  it('ignores the old project response arriving after the new project', async () => {
    let resolveOld!: (value: ReturnType<typeof page>) => void;
    await renderForm({ listHandoffs: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue(page([])) });
    await chooseProject();
    await openPicker();
    expect(screen.getByText('Loading handoffs…')).toBeVisible();
    await chooseProject(SECOND_PROJECT.id);
    await openPicker();
    expect(await screen.findByText('No handoffs yet — they appear here once a session writes one.')).toBeVisible();
    resolveOld(page());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(handoffList().queryByRole('option')).toBeNull());
    expect(screen.getByText('No handoffs yet — they appear here once a session writes one.')).toBeVisible();
    expect(screen.queryByText('Loading handoffs…')).toBeNull();
  });

  it('shows the error atom and retries a failed load', async () => {
    await renderForm({ listHandoffs: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page()) });
    await chooseProject();
    await openPicker();
    expect(await screen.findByRole('alert')).toHaveTextContent('Handoffs could not be loaded');
    expect(screen.getByRole('alert').querySelector('of-error-line')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await handoffList().findByRole('option')).toHaveTextContent('gimli.md');
  });

  it('moves focus with arrows, selects with Enter, closes with Escape and removes the chip', async () => {
    await renderForm({ listHandoffs: vi.fn().mockResolvedValue(page([HANDOFF, { ...HANDOFF, noteId: 'n2', file: 'nori.md', title: 'Nori' }])) });
    await chooseProject();
    await openPicker();
    const options = await handoffList().findAllByRole('option');
    await waitFor(() => expect(options[0]).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(options[1]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('@file handoffs/nori.md')).toBeVisible();
    await openPicker();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Start from a handoff' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Remove handoff nori.md' }));
    expect(screen.queryByText('@file handoffs/nori.md')).toBeNull();
  });

  it('filters a long list without showing a search field for short lists', async () => {
    const handoffs = Array.from({ length: 24 }, (_, index) => ({ ...HANDOFF, noteId: String(index), file: `handoff-${index}.md` }));
    await renderForm({ listHandoffs: vi.fn().mockResolvedValue(page(handoffs)) });
    await chooseProject();
    await openPicker();
    const search = await screen.findByRole('searchbox', { name: 'Search handoffs' });
    await userEvent.type(search, 'handoff-23');
    expect(handoffList().getAllByRole('option')).toHaveLength(1);
  });

  it('keeps the form filled when the selected file disappears at create time', async () => {
    await renderForm({ createSession: vi.fn().mockRejectedValue(new ApiError(404, 'missing', 'handoff_not_found')) });
    await chooseProject();
    await pickHandoff();
    await fillFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('handoffs/gimli.md is no longer in the docs folder – pick another handoff or remove it.');
    expect(screen.getByTestId('new-session-name')).toHaveValue('New');
    expect(screen.getByTestId('new-session-directory')).toHaveValue('/workspace');
    await userEvent.click(screen.getByRole('button', { name: 'Remove handoff gimli.md' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides and clears the picker in manager mode', async () => {
    const api = await renderForm();
    await chooseProject();
    await pickHandoff();
    await userEvent.click(screen.getByTestId('new-session-mode-manager'));
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Start from a handoff' })).toBeNull());
    await userEvent.click(screen.getByTestId('new-session-mode-session'));
    expect(screen.queryByText('@file handoffs/gimli.md')).toBeNull();
    expect(api.createManagerSession).not.toHaveBeenCalled();
  });
});
