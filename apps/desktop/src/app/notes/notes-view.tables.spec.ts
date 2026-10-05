import { render, screen } from '@testing-library/angular/zoneless';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, vi } from 'vitest';
import { itRendersImportedMarkdownTables } from '../../testing/markdown-tables.testing';
import { FleetApiService } from '../core/fleet-api.service';
import { DirectoryOpener } from './directory-opener';
import { NotesViewComponent } from './notes-view.component';
import { aNoteSummary, aNoteView } from './notes.fixtures';

const page = <T>(items: T[]) => ({ items, total: items.length, limit: 100, offset: 0 });

async function renderNotesViewShowing(bodyMd: string): Promise<void> {
  const api = {
    listProjects: vi.fn().mockResolvedValue(page([{ id: 'p1', name: 'OpenFleet', docsFolderPath: null }])),
    listNotes: vi.fn().mockResolvedValue(page([aNoteSummary({ id: 'n1', title: 'imported' })])),
    getNote: vi.fn().mockResolvedValue(aNoteView({ id: 'n1', title: 'imported', bodyMd })),
  };
  await render(NotesViewComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: DirectoryOpener, useValue: { isAvailable: false, open: vi.fn() } },
      { provide: ActivatedRoute, useValue: { queryParamMap: new BehaviorSubject(convertToParamMap({})) } },
    ],
  });
  await screen.findByTestId('note-editor-title');
}

describe('the notes view', () => {
  itRendersImportedMarkdownTables(renderNotesViewShowing);
});
