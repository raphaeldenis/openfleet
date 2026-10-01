import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { LiveSessionTodosSource } from './shell/todos/live-session-todos-source';
import { SESSION_TODOS_SOURCE } from './shell/todos/session-todos-source';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: SESSION_TODOS_SOURCE, useExisting: LiveSessionTodosSource },
  ]
};
