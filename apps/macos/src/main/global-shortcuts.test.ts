import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@rt/core';
import { createGlobalShortcuts, dispatchShortcut } from './global-shortcuts';

function setup(platform = 'darwin') {
  let settings = {} as AppSettings;
  const deps = {
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    platform, readSettings: () => settings, dispatch: vi.fn(), log: vi.fn(),
  };
  return { deps, controller: createGlobalShortcuts(deps),
    save: (shortcuts: AppSettings['shortcuts']) => { settings = { ...settings, shortcuts }; } };
}

describe('recording global shortcut', () => {
  it('sends the plain action string on shortcut to live windows', () => {
    const send = vi.fn();
    const destroyedSend = vi.fn();
    const { deps, controller } = setup();
    deps.dispatch.mockImplementation((action) => dispatchShortcut([
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
    ], action));
    controller.start();
    const [, callback] = deps.globalShortcut.register.mock.calls[0] as unknown as [string, () => void];
    callback();
    expect(send).toHaveBeenCalledExactlyOnceWith('shortcut', 'toggleRecording');
    expect(destroyedSend).not.toHaveBeenCalled();
  });
  it.each([['darwin', 'Alt+Command+R'], ['win32', 'Alt+Control+R']])('registers the %s default and dispatches recording', (platform, key) => {
    const { deps, controller } = setup(platform);
    controller.start();
    expect(deps.globalShortcut.register).toHaveBeenCalledExactlyOnceWith(key, expect.any(Function));
    const callback = deps.globalShortcut.register.mock.calls[0] as unknown as [string, () => void];
    callback[1]();
    expect(deps.dispatch).toHaveBeenCalledExactlyOnceWith('toggleRecording');
  });
  it('replaces the binding from saved settings and supports unbinding and restoring defaults', () => {
    const { deps, controller, save } = setup();
    controller.start();
    save({ toggleRecording: 'Control+Shift+R', toggleOverlay: 'Alt+Command+F' });
    controller.start();
    expect(deps.globalShortcut.unregister).toHaveBeenCalledWith('Alt+Command+R');
    expect(deps.globalShortcut.register).toHaveBeenLastCalledWith('Control+Shift+R', expect.any(Function));
    save({ toggleRecording: null });
    controller.start();
    expect(deps.globalShortcut.unregister).toHaveBeenLastCalledWith('Control+Shift+R');
    expect(deps.globalShortcut.register).toHaveBeenCalledTimes(2);
    save(undefined);
    controller.start();
    expect(deps.globalShortcut.register).toHaveBeenLastCalledWith('Alt+Command+R', expect.any(Function));
  });
  it.each(['conflict', 'invalid'])('logs %s registration failures and retries on the next save', (mode) => {
    const { deps, controller } = setup();
    if (mode === 'conflict') deps.globalShortcut.register.mockReturnValueOnce(false);
    else deps.globalShortcut.register.mockImplementationOnce(() => { throw new Error('Invalid accelerator'); });
    expect(() => controller.start()).not.toThrow();
    expect(deps.log).toHaveBeenCalledOnce();
    controller.start();
    expect(deps.globalShortcut.unregister).not.toHaveBeenCalled();
    expect(deps.globalShortcut.register).toHaveBeenCalledTimes(2);
  });
});
