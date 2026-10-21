import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  getStatus: vi.fn(), sendText: vi.fn(), scan: vi.fn(), connect: vi.fn(), getLog: vi.fn(),
}));
vi.mock('../native-plugin/rayneo', () => ({ RayNeo: native }));
let settings: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  settings = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => settings.get(key) ?? null });
  vi.stubGlobal('window', {});
  native.getStatus.mockResolvedValue({ connected: true });
  native.sendText.mockResolvedValue({ submitted: true, displayVerified: false });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function enable() {
  settings.set('subline.rayneo.enabled', 'true');
  settings.set('subline.rayneo.experimental', 'true');
  settings.set('subline.rayneo.businessId', '42');
}
test('default and missing business ID cannot write, including debug test', async () => {
  const { forwardRayNeoText, rayneoDebug } = await import('./rayneo-forwarder');
  await forwardRayNeoText('A', true);
  settings.set('subline.rayneo.enabled', 'true');
  settings.set('subline.rayneo.experimental', 'true');
  await forwardRayNeoText('A', true);
  await expect(rayneoDebug.sendTest('A')).rejects.toThrow();
  expect(native.sendText).not.toHaveBeenCalled();
});
test('connected final and partial use explicit route, partials throttle at 250ms', async () => {
  enable();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { forwardRayNeoText } = await import('./rayneo-forwarder');
  await forwardRayNeoText('one', false);
  now = 249; await forwardRayNeoText('two', false);
  now = 250; await forwardRayNeoText('three', false);
  await forwardRayNeoText('final', true);
  expect(native.sendText.mock.calls.map(([value]) => value)).toEqual([
    { text: 'one', final: false, experimental: true, businessId: 42 },
    { text: 'three', final: false, experimental: true, businessId: 42 },
    { text: 'final', final: true, experimental: true, businessId: 42 },
  ]);
});
test('disconnected or malformed route cannot write', async () => {
  enable(); native.getStatus.mockResolvedValue({ connected: false });
  const { forwardRayNeoText } = await import('./rayneo-forwarder');
  await forwardRayNeoText('A', true);
  for (const id of ['', ' ', '13.5', '256', '-1', 'NaN']) {
    settings.set('subline.rayneo.businessId', id);
    await forwardRayNeoText('A', true);
  }
  expect(native.sendText).not.toHaveBeenCalled();
});
test('disabling while status is pending prevents write', async () => {
  enable();
  native.getStatus.mockImplementationOnce(async () => {
    settings.set('subline.rayneo.experimental', 'false');
    return { connected: true };
  });
  const { forwardRayNeoText } = await import('./rayneo-forwarder');
  await forwardRayNeoText('A', true);
  expect(native.sendText).not.toHaveBeenCalled();
});
