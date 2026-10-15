import { MANAGER_BASE_PATH, type ManagerBaseView } from '@openfleet/shared';
import { json, type Router } from './router.js';

export function registerManagerBaseRoutes(router: Router, managerBase: ManagerBaseView): void {
  router.add('GET', MANAGER_BASE_PATH, ({ res }) => json(res, 200, managerBase));
}
