import type { Routes } from '@angular/router';
import { ComponentsSheetComponent } from './design/components-sheet.component';

export const routes: Routes = [
  // Tried before the shell's own wildcard — stays outside the shell chrome, a dev-only
  // style/component sheet rather than a product screen.
  { path: 'components', component: ComponentsSheetComponent },
  { path: 'onboarding', loadComponent: () => import('./onboarding/onboarding.component').then((m) => m.OnboardingComponent) },
  {
    path: '',
    loadComponent: () => import('./shell/app-shell.component').then((m) => m.AppShellComponent),
    children: [
      { path: '', pathMatch: 'full', loadComponent: () => import('./shell/empty-state.component').then((m) => m.EmptyStateComponent) },
      { path: 'inbox', loadComponent: () => import('./inbox/inbox.component').then((m) => m.InboxComponent) },
      { path: 'settings', loadComponent: () => import('./settings/settings.component').then((m) => m.SettingsComponent) },
      { path: 'new', loadComponent: () => import('./sessions/new-session-form.component').then((m) => m.NewSessionFormComponent) },
      // --- Tables (P3-T18) ---
      { path: 'tables', loadComponent: () => import('./tables/tables-view.component').then((m) => m.TablesViewComponent) },
      // --- end Tables ---
      { path: 'manager/:id', loadComponent: () => import('./managers/manager-dashboard.component').then((m) => m.ManagerDashboardComponent) },
      { path: 'session/:sessionId', loadComponent: () => import('./sessions/session-view.component').then((m) => m.SessionViewComponent) },
      { path: '**', loadComponent: () => import('./shell/not-found.component').then((m) => m.NotFoundComponent) },
    ],
  },
];
