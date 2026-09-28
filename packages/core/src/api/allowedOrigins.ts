// The desktop shell's own origins: the Angular dev server (also the e2e baseURL), and the Tauri webview in
// both its dev and packaged forms. Shared between CORS (server.ts) and the /ws upgrade check (wsHandler.ts)
// so the two never drift apart.
export const ALLOWED_ORIGINS = new Set(['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost']);
