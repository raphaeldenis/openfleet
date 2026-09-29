// Holds the admin token in memory only, never in localStorage: a script that reads storage (an
// extension, a forensic disk read) never finds it there. Reset on every reload — ensureAdminTokenInStorage
// (tauri-admin-token.ts) always repopulates it at startup, from Tauri or from a bootstrap localStorage value.
let adminToken = '';

export function getAdminToken(): string {
  return adminToken;
}

export function setAdminToken(token: string): void {
  adminToken = token.trim();
}
