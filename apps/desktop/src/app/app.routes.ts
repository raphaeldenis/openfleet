import type { Routes } from '@angular/router';
import { ComponentsSheetComponent } from './design/components-sheet.component';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./app').then((m) => m.App) },
  { path: 'components', component: ComponentsSheetComponent },
  { path: 'manager/:id', loadComponent: () => import('./managers/manager-dashboard.component').then((m) => m.ManagerDashboardComponent) },
];
