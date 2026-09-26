import type { Routes } from '@angular/router';
import { App } from './app';
import { ComponentsSheetComponent } from './design/components-sheet.component';

export const routes: Routes = [
  { path: '', component: App },
  { path: 'components', component: ComponentsSheetComponent },
];
