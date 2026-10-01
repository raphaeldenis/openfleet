import { Component, inputBinding } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { InMemorySessionTodosSource, SESSION_TODOS_SOURCE, type ChildProgress } from './session-todos-source';
import { TodosTabComponent } from './todos-tab.component';

@Component({ selector: 'test-stub', template: '' })
class StubPage {}

const MANAGER_ID = 'manager-1';

function child(id: string, completed: number | null, total = 0, extra: Partial<ChildProgress> = {}): ChildProgress {
  const counts = completed === null ? null : { total, completed, inProgress: 0, pending: total - completed };
  return { id, name: id.toUpperCase(), emoji: '⛏️', state: 'idle', isManager: false, counts, ...extra };
}

async function renderManagerTab(children: ChildProgress[] | 'unsupported', options: { sessionId?: string | undefined } = {}) {
  const source = new InMemorySessionTodosSource();
  source.publishChildren(MANAGER_ID, children === 'unsupported' ? { kind: 'unsupported' } : { kind: 'ready', children });
  const sessionId = 'sessionId' in options ? options.sessionId : MANAGER_ID;
  const view = await render(TodosTabComponent, {
    bindings: [inputBinding('sessionId', () => sessionId)],
    providers: [
      { provide: SESSION_TODOS_SOURCE, useValue: source },
      provideRouter([{ path: 'session/:id', component: StubPage }, { path: 'manager/:id', component: StubPage }]),
    ],
  });
  return { source, view };
}

const rows = () => screen.queryAllByTestId('manager-child');
const rowOf = (name: string) => rows().find((row) => within(row).queryByTestId('manager-child-link')?.textContent?.trim() === name) as HTMLElement;
const summary = () => screen.getByTestId('manager-children-summary').textContent?.trim();

describe('manager children progress', () => {
  it('shows the sum of the children that have a list, and says how many children it spans', async () => {
    await renderManagerTab([child('gimli', 2, 5), child('balin', null), child('ori', 3, 4)]);

    expect(summary()).toBe('Children · 5 of 9 done across 2 children');
  });

  it('says "1 child" in the singular', async () => {
    await renderManagerTab([child('gimli', 2, 5), child('balin', null)]);

    expect(summary()).toBe('Children · 2 of 5 done across 1 child');
  });

  it('says no child has todos when none has a list, instead of a sum of zeros', async () => {
    await renderManagerTab([child('gimli', null), child('balin', null)]);

    expect(summary()).toBe('Children · no todos yet');
  });

  it('reads each child as its name, its state chip and "done/total done"', async () => {
    await renderManagerTab([child('gimli', 2, 5, { state: 'generating' })]);

    const row = rowOf('GIMLI');
    expect(within(row).getByTestId('state-chip-label').textContent).toBe('generating');
    expect(within(row).getByTestId('manager-child-progress-text').textContent).toBe('2/5 done');
  });

  it('says "no todos" for a child without a list and draws no bar for it', async () => {
    await renderManagerTab([child('balin', null), child('gimli', 1, 2)]);

    const balin = rowOf('BALIN');
    expect(within(balin).getByTestId('manager-child-progress-text').textContent).toBe('no todos');
    expect(balin.querySelector('of-todo-progress')).toBeNull();
    expect(rowOf('GIMLI').querySelector('of-todo-progress')).not.toBeNull();
  });

  it('adds nothing to the sum for a child without a list', async () => {
    await renderManagerTab([child('balin', null), child('gimli', 1, 2)]);

    expect(summary()).toBe('Children · 1 of 2 done across 1 child');
  });

  it('keeps the rows in the order the source gives, open children before closed ones', async () => {
    await renderManagerTab([child('a', 1, 2), child('b', 1, 2), child('c', 1, 2, { state: 'closed' })]);

    expect(rows().map((row) => within(row).getByTestId('manager-child-link').textContent?.trim())).toEqual(['A', 'B', 'C']);
  });

  it('shows a closed child with its counts and flags unfinished work in words', async () => {
    await renderManagerTab([child('ori', 3, 4, { state: 'closed' })]);

    const row = rowOf('ORI');
    expect(within(row).getByTestId('state-chip-label').textContent).toBe('closed');
    expect(within(row).getByTestId('manager-child-progress-text').textContent).toBe('3/4 done');
    expect(within(row).getByTestId('manager-child-unfinished').textContent).toBe('unfinished');
  });

  it('does not flag a closed child whose work is all done', async () => {
    await renderManagerTab([child('ori', 4, 4, { state: 'closed' })]);

    expect(screen.queryByTestId('manager-child-unfinished')).toBeNull();
  });

  it('fills the child bar to its share of completed todos', async () => {
    await renderManagerTab([child('gimli', 2, 5)]);

    const fill = rowOf('GIMLI').querySelector('.fill') as HTMLElement;
    expect(fill.style.width).toBe('40%');
  });

  it('keeps the bar out of the accessibility tree, since the text already says the numbers', async () => {
    await renderManagerTab([child('gimli', 2, 5)]);

    expect(within(rowOf('GIMLI')).queryByRole('progressbar')).toBeNull();
    expect(rowOf('GIMLI').querySelector('of-todo-progress [aria-hidden="true"]')).not.toBeNull();
  });

  it('updates a row in place when its child reports progress, keeping the same DOM node', async () => {
    const { source, view } = await renderManagerTab([child('gimli', 2, 5), child('balin', 1, 2)]);
    const gimliRowBefore = rowOf('GIMLI');

    source.publishChildren(MANAGER_ID, { kind: 'ready', children: [child('ori', null), child('gimli', 4, 5), child('balin', 1, 2)] });
    await view.fixture.whenStable();

    expect(rowOf('GIMLI')).toBe(gimliRowBefore);
    expect(within(gimliRowBefore).getByTestId('manager-child-progress-text').textContent).toBe('4/5 done');
  });

  describe('navigation', () => {
    it('opens the session of the child when its name is activated', async () => {
      await renderManagerTab([child('gimli', 2, 5)]);

      await userEvent.click(within(rowOf('GIMLI')).getByRole('link', { name: 'GIMLI' }));

      expect(TestBed.inject(Router).url).toBe('/session/gimli');
    });

    it('opens the dashboard of a child that is itself a manager', async () => {
      await renderManagerTab([child('sub', 1, 3, { isManager: true })]);

      await userEvent.click(within(rowOf('SUB')).getByRole('link'));

      expect(TestBed.inject(Router).url).toBe('/manager/sub');
    });

    it('is reachable and activatable from the keyboard', async () => {
      await renderManagerTab([child('gimli', 2, 5), child('balin', 1, 2)]);

      await userEvent.tab();
      await userEvent.tab();
      await userEvent.keyboard('{Enter}');

      expect(TestBed.inject(Router).url).toBe('/session/balin');
    });

    it('moves the focus to the todos panel when a worker child is opened, so it is not lost with the link', async () => {
      await renderManagerTab([child('gimli', 2, 5)]);

      await userEvent.tab();
      await userEvent.keyboard('{Enter}');

      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Todos' }));
    });

    it('moves the focus to the todos panel when a child manager is opened', async () => {
      await renderManagerTab([child('sub', 1, 3, { isManager: true })]);

      await userEvent.tab();
      await userEvent.keyboard('{Enter}');

      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Todos' }));
    });
  });

  describe('names', () => {
    it('keeps the full name in a tooltip for a name the row clips', async () => {
      const longName = 'Gimli the builder of long names';
      await renderManagerTab([child('gimli', 2, 5, { name: longName })]);

      expect(screen.getByTestId('manager-child-link').getAttribute('title')).toBe(longName);
    });

    it('shows invisible bidi controls in a child name as escapes', async () => {
      await renderManagerTab([child('gimli', 2, 5, { name: 'pay‮gnp' })]);

      expect(screen.getByTestId('manager-child-link').textContent).toContain('<U+202E>');
    });

    it('escapes invisible bidi controls in the tooltip too', async () => {
      await renderManagerTab([child('gimli', 2, 5, { name: 'pay‮gnp' })]);

      expect(screen.getByTestId('manager-child-link').getAttribute('title')).toContain('<U+202E>');
    });

    it('shows a name made only of an invisible letter as an escape, in the text and the tooltip', async () => {
      await renderManagerTab([child('gimli', 2, 5, { name: 'ㅤ' })]);

      const link = screen.getByTestId('manager-child-link');
      expect(link.textContent?.trim()).toContain('<U+3164>');
      expect(link.getAttribute('title')).toContain('<U+3164>');
    });

    it('renders a name as plain text, never as markup', async () => {
      await renderManagerTab([child('gimli', 2, 5, { name: '<b>bold</b>' })]);

      expect(screen.getByTestId('manager-child-link').textContent).toBe('<b>bold</b>');
      expect(screen.getByTestId('manager-child-link').querySelector('b')).toBeNull();
    });
  });

  describe('volume', () => {
    const manyChildren = (count: number) => Array.from({ length: count }, (_, index) => child(`c${index}`, 1, 2));

    it('shows 20 rows and says how many children are not shown', async () => {
      await renderManagerTab(manyChildren(25));

      expect(rows()).toHaveLength(20);
      expect(screen.getByTestId('manager-children-more').textContent).toBe('5 more children not shown');
    });

    it('still sums the children that are not shown', async () => {
      await renderManagerTab(manyChildren(25));

      expect(summary()).toBe('Children · 25 of 50 done across 25 children');
    });

    it('says "1 more child not shown" in the singular', async () => {
      await renderManagerTab(manyChildren(21));

      expect(screen.getByTestId('manager-children-more').textContent).toBe('1 more child not shown');
    });

    const linkTexts = () => rows().map((row) => within(row).getByTestId('manager-child-link').textContent?.trim());
    const closedUnfinished = (id: string) => child(id, 1, 4, { state: 'closed' });
    const closedDone = (id: string) => child(id, 4, 4, { state: 'closed' });

    it('keeps closed children with unfinished work among the 20 rows, shown after the open ones', async () => {
      const open = Array.from({ length: 22 }, (_, index) => child(`open${index}`, 1, 2));
      await renderManagerTab([...open, closedUnfinished('late1'), closedUnfinished('late2'), closedUnfinished('late3')]);

      expect(rows()).toHaveLength(20);
      expect(linkTexts().slice(-3)).toEqual(['LATE1', 'LATE2', 'LATE3']);
      expect(linkTexts().slice(0, 17)).toEqual(open.slice(0, 17).map((c) => c.name));
      expect(screen.getByTestId('manager-children-more').textContent).toBe('5 more children not shown');
    });

    it('fills the rows with open children before closed children whose work is done', async () => {
      const open = Array.from({ length: 18 }, (_, index) => child(`open${index}`, 1, 2));
      await renderManagerTab([...open, closedDone('done1'), closedDone('done2'), closedDone('done3'), closedUnfinished('late1'), closedUnfinished('late2')]);

      expect(linkTexts()).toEqual([...open.map((c) => c.name), 'LATE1', 'LATE2']);
      expect(screen.getByTestId('manager-children-more').textContent).toBe('3 more children not shown');
    });

    it('says how many of the hidden children are unfinished', async () => {
      await renderManagerTab(Array.from({ length: 25 }, (_, index) => closedUnfinished(`late${index}`)));

      expect(screen.getByTestId('manager-children-more').textContent).toBe('5 more children not shown, 5 unfinished');
    });

    it('says "1 more child not shown, 1 unfinished" in the singular', async () => {
      await renderManagerTab(Array.from({ length: 21 }, (_, index) => closedUnfinished(`late${index}`)));

      expect(screen.getByTestId('manager-children-more').textContent).toBe('1 more child not shown, 1 unfinished');
    });

    it('shows no "more" line at exactly 20 children', async () => {
      await renderManagerTab(manyChildren(20));

      expect(screen.queryByTestId('manager-children-more')).toBeNull();
    });
  });

  describe('absent and unsupported', () => {
    it('shows no children block for a session without children', async () => {
      await renderManagerTab([]);

      expect(screen.queryByTestId('manager-children')).toBeNull();
      expect(screen.queryByTestId('manager-children-unsupported')).toBeNull();
    });

    it('shows no children block without a session', async () => {
      await renderManagerTab([child('gimli', 2, 5)], { sessionId: undefined });

      expect(screen.queryByTestId('manager-children')).toBeNull();
    });

    it('says calmly that an old daemon does not report children progress', async () => {
      await renderManagerTab('unsupported');

      expect(screen.getByTestId('manager-children-unsupported').textContent).toBe("Children's progress isn't available — this daemon doesn't report todos.");
      expect(screen.queryByTestId('manager-children')).toBeNull();
    });

    it('shows the children even though the manager has no list of its own', async () => {
      await renderManagerTab([child('gimli', 2, 5)]);

      expect(screen.getByTestId('todos-empty')).not.toBeNull();
      expect(rows()).toHaveLength(1);
    });
  });

  describe('list semantics', () => {
    it('is a labelled region holding a list with one item per child', async () => {
      await renderManagerTab([child('gimli', 2, 5), child('balin', 1, 2)]);

      const region = screen.getByRole('region', { name: /Children/ });
      expect(within(region).getAllByRole('listitem')).toHaveLength(2);
    });
  });
});
