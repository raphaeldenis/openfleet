import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { ensureAdminTokenInStorage } from './app/core/tauri-admin-token';

ensureAdminTokenInStorage()
  .then(() => bootstrapApplication(App, appConfig))
  .catch((err) => console.error(err));
