import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { provideRouter } from '@angular/router';
import type { ManagerView } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { ManagerLinksComponent } from './manager-links.component';

function manager(patch: Partial<ManagerView> = {}): ManagerView {
  return {
    sessionId: 'm1', pulseSeconds: 1800, pulseEnabled: true, childrenCap: 2, missionText: 'x',
    nextPulseAt: '2026-01-01T00:30:00.000Z', childrenCount: 1,
    ...patch,
  };
}

const renderLinks = (managerView: ManagerView, { projectId }: { projectId: string | undefined } = { projectId: 'p1' }) =>
  render(ManagerLinksComponent, { providers: [provideRouter([])], bindings:[inputBinding('manager', () => managerView), inputBinding('projectId', () => projectId)] });

describe('ManagerLinksComponent', () => {
  it('links the log table to the tables screen, opened on that table of the manager project', async () => {
    await renderLinks(manager({ logStoreId: 'store-log' }));

    const link = screen.getByRole('link', { name: 'Log table' });

    expect(link).toHaveAttribute('href', '/tables?projectId=p1&storeId=store-log');
  });

  it('links the mission note to the notes screen, opened on that note of the manager project', async () => {
    await renderLinks(manager({ missionNoteId: 'note-mission' }));

    const link = screen.getByRole('link', { name: 'Mission note' });

    expect(link).toHaveAttribute('href', '/notes?projectId=p1&noteId=note-mission');
  });

  it('names the manager in the accessible name of both links while their visible text stays short', async () => {
    await render(ManagerLinksComponent, {
      providers: [provideRouter([])],
      bindings: [inputBinding('manager', () => manager({ missionNoteId: 'note-mission', logStoreId: 'store-log' })), inputBinding('managerName', () => 'Lead')],
    });

    expect(screen.getByRole('link', { name: 'Mission note of Lead' })).toHaveTextContent(/^Mission note$/);
    expect(screen.getByRole('link', { name: 'Log table of Lead' })).toHaveTextContent(/^Log table$/);
  });

  it('shows no link for a manager with neither a mission note nor a log table', async () => {
    await renderLinks(manager());

    expect(screen.queryByRole('link')).toBeNull();
  });

  it('tells that the mission note is pinned', async () => {
    await renderLinks(manager({ missionNoteId: 'note-mission', pinMissionNote: true }));

    expect(screen.getByTestId('manager-m1-mission-note-pinned')).toBeVisible();
  });

  it('does not tell a pin on a mission note that is not pinned', async () => {
    await renderLinks(manager({ missionNoteId: 'note-mission', pinMissionNote: false }));

    expect(screen.queryByTestId('manager-m1-mission-note-pinned')).toBeNull();
  });

  it('still links a manager that belongs to no project, without a project in the link', async () => {
    await renderLinks(manager({ logStoreId: 'store-log' }), { projectId: undefined });

    expect(screen.getByRole('link', { name: 'Log table' })).toHaveAttribute('href', '/tables?storeId=store-log');
  });
});
