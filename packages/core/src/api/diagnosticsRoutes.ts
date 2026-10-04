import { DIAGNOSTICS_PATH, type DiagnosticsDocument } from '@openfleet/shared';
import { json, type Router } from './router.js';

export function registerDiagnosticsRoutes(router: Router, readDiagnostics: () => DiagnosticsDocument): void {
  router.add('GET', DIAGNOSTICS_PATH, ({ res }) => json(res, 200, readDiagnostics()));
}
