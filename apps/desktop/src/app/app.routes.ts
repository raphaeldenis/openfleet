import type { Routes } from '@angular/router';
import { ComponentsSheetComponent } from './design/components-sheet.component';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./shell/app-shell.component').then((m) => m.AppShellComponent),
    children: [
      { path: '', pathMatch: 'full', loadComponent: () => import('./shell/empty-state.component').then((m) => m.EmptyStateComponent) },
      { path: 'inbox', loadComponent: () => import('./inbox/inbox.component').then((m) => m.InboxComponent) },
      { path: 'manager/:id', loadComponent: () => import('./managers/manager-dashboard.component').then((m) => m.ManagerDashboardComponent) },
      { path: 'session/:sessionId', loadComponent: () => import('./sessions/session-view.component').then((m) => m.SessionViewComponent) },
    ],
  },
  // Stays outside the shell chrome — a dev-only style/component sheet, not a product screen.
  { path: 'components', component: ComponentsSheetComponent },
];
