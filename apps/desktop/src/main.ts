import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppRoot } from './app/app-root';
import { ensureAdminTokenLoaded } from './app/core/tauri-admin-token';
import { adoptDaemonUrlFromQuery } from './environments/environment';

adoptDaemonUrlFromQuery(globalThis.location?.search ?? '');

ensureAdminTokenLoaded()
  .then(() => bootstrapApplication(AppRoot, appConfig))
  .catch((err) => console.error(err));
