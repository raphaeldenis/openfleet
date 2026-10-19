import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

async function injectFresh() {
  vi.resetModules();
  const { TestBed } = await import('@angular/core/testing');
  const { NativeNotifications } = await import('./native-notifications.service');
  return TestBed.inject(NativeNotifications);
}

const unsetTauriMarker = () => delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
const banner = { title: 'Gimli finished', body: 'Bash', route: '/session/abc' };

describe('NativeNotifications under Tauri', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });
  afterEach(unsetTauriMarker);

  it('raises a banner and answers delivered', async () => {
    invokeMock.mockResolvedValue({ status: 'delivered' });
    const notifications = await injectFresh();

    const outcome = await notifications.show(banner);

    expect(outcome).toBe('delivered');
    expect(invokeMock).toHaveBeenCalledWith('show_native_notification', { request: banner });
  });

  it('answers permissionDenied without throwing when the human refused the permission', async () => {
    invokeMock.mockResolvedValue({ status: 'permissionDenied' });
    const notifications = await injectFresh();

    await expect(notifications.show(banner)).resolves.toBe('permissionDenied');
  });

  it('lets a refused request reach the caller', async () => {
    invokeMock.mockRejectedValue('the route must be a path inside the app');
    const notifications = await injectFresh();

    await expect(notifications.show({ ...banner, route: 'https://evil.example' })).rejects.toBe('the route must be a path inside the app');
  });

  it('sets the Dock badge to the count and clears it with zero', async () => {
    invokeMock.mockResolvedValue(undefined);
    const notifications = await injectFresh();

    await notifications.setDockBadge(3);
    await notifications.setDockBadge(0);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'set_dock_badge', { count: 3 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'set_dock_badge', { count: 0 });
  });

  it('sends only whole non-negative counts to the Dock', async () => {
    invokeMock.mockResolvedValue(undefined);
    const notifications = await injectFresh();

    await notifications.setDockBadge(-4);
    await notifications.setDockBadge(2.9);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'set_dock_badge', { count: 0 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'set_dock_badge', { count: 2 });
  });

  it('hands the route of a clicked banner to the handler until it stops listening', async () => {
    const unlisten = vi.fn();
    let deliverClick: (event: { payload: { route: string } }) => void = () => undefined;
    listenMock.mockImplementation(async (_name: string, callback: typeof deliverClick) => {
      deliverClick = callback;
      return unlisten;
    });
    const notifications = await injectFresh();
    const openedRoutes: string[] = [];

    const stopListening = await notifications.onBannerClick((route) => openedRoutes.push(route));
    deliverClick({ payload: { route: '/session/abc' } });
    stopListening();

    expect(listenMock).toHaveBeenCalledWith('native-notification-clicked', expect.any(Function));
    expect(openedRoutes).toEqual(['/session/abc']);
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe('NativeNotifications in a plain browser', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    unsetTauriMarker();
  });

  it('is unavailable and every call does nothing', async () => {
    const notifications = await injectFresh();
    const openedRoutes: string[] = [];

    const outcome = await notifications.show(banner);
    await notifications.setDockBadge(5);
    const stopListening = await notifications.onBannerClick((route) => openedRoutes.push(route));
    stopListening();

    expect(notifications.isAvailable).toBe(false);
    expect(outcome).toBe('unsupported');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(openedRoutes).toEqual([]);
  });
});
