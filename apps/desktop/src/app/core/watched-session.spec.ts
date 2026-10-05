import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import { WatchedSession, watchedSessionIdOf } from './watched-session';

@Component({ selector: 'test-page', template: '' })
class PageComponent {}

const routes: Routes = [
  { path: '', pathMatch: 'full', component: PageComponent },
  { path: 'inbox', component: PageComponent },
  { path: 'session/:id', component: PageComponent },
  { path: 'manager/:id', component: PageComponent },
];

describe('watchedSessionIdOf', () => {
  it.each([
    ['/session/abc', 'abc'],
    ['/manager/m1', 'm1'],
    ['/session/abc?x=1#frag', 'abc'],
    ['/', undefined],
    ['/inbox', undefined],
    ['/session', undefined],
  ])('reads %s as %s', (url, expected) => {
    expect(watchedSessionIdOf(url)).toBe(expected);
  });
});

describe('WatchedSession', () => {
  async function openAt(url: string) {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    const harness = await RouterTestingHarness.create(url);
    return { harness, watched: TestBed.inject(WatchedSession) };
  }

  it('names the session of the route it starts on', async () => {
    const { watched } = await openAt('/session/s1');

    expect(watched.id()).toBe('s1');
  });

  it('follows the route from a session to a manager and then to a page without one', async () => {
    const { harness, watched } = await openAt('/session/s1');

    await harness.navigateByUrl('/manager/m1');
    expect(watched.id()).toBe('m1');

    await harness.navigateByUrl('/inbox');
    expect(watched.id()).toBeUndefined();
  });
});
