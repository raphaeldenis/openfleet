import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppRoot } from './app/app-root';
import { ensureAdminTokenInStorage } from './app/core/tauri-admin-token';

ensureAdminTokenInStorage()
  .then(() => bootstrapApplication(AppRoot, appConfig))
  .catch((err) => console.error(err));
