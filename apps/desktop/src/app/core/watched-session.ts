import { Injectable, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

const WATCHED_SESSION_URL = /^\/(?:session|manager)\/([^/?#]+)/;

/** Returns the id of the session or manager the route shows, if any. */
export function watchedSessionIdOf(url: string): string | undefined {
  return WATCHED_SESSION_URL.exec(url)?.[1];
}

/** The id of the session or manager the current route shows; the sidebar marks that row as selected. */
@Injectable({ providedIn: 'root' })
export class WatchedSession {
  private readonly router = inject(Router);

  readonly id = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => watchedSessionIdOf(this.router.url)),
    ),
    { initialValue: watchedSessionIdOf(this.router.url) },
  );
}
