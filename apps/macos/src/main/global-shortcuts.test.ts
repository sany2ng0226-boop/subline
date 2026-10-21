import { describe, it, expect, vi } from 'vitest';
import { makeDefaults, type AppSettings } from '@rt/core';
import { acceleratorKey, createGlobalShortcuts, dispatchOverlayShortcut } from './global-shortcuts';

function setup(platform = 'darwin', overrides: AppSettings['shortcuts'] = {}) {
  let settings: AppSettings = { ...makeDefaults([]), shortcuts: overrides };
  const callbacks = new Map<string, () => void>();
  const globalShortcut = {
    register: vi.fn((key: string, cb: () => void) => { callbacks.set(key, cb); return true; }),
    unregister: vi.fn((key: string) => { callbacks.delete(key); }), unregisterAll: vi.fn(),
  };
  const deps = { globalShortcut, platform, readSettings: () => settings,
    writeSettings: vi.fn((next: AppSettings) => { settings = next; }),
    dispatch: vi.fn(), onUnlockUnavailable: vi.fn(), log: vi.fn() };
  return { controller: createGlobalShortcuts(deps), deps, callbacks };
}

describe('global shortcuts', () => {
  it('registers defaults on startup, dispatches, and cleans up', () => {
    const { controller, deps, callbacks } = setup();
    controller.start();
    expect(controller.getShortcuts()).toEqual({ toggleOverlay: 'Alt+Command+F', toggleRecording: 'Alt+Command+R', toggleClickThrough: null });
    expect(controller.getShortcutStatus()).toEqual({ toggleOverlay: 'ok', toggleRecording: 'ok', toggleClickThrough: 'unbound' });
    callbacks.get('Alt+Command+R')!();
    expect(deps.dispatch).toHaveBeenCalledWith('toggleRecording');
    controller.stop(); expect(deps.globalShortcut.unregisterAll).toHaveBeenCalledOnce();
  });
  it('overlays saved settings and uses Control on Windows', () => {
    const { controller } = setup('win32', { toggleRecording: null });
    controller.start();
    expect(controller.getShortcuts().toggleOverlay).toBe('Alt+Control+F');
    expect(controller.getShortcutStatus().toggleRecording).toBe('unbound');
  });
  it('rejects invalid inputs without unregistering and catches duplicate aliases', () => {
    const { controller, deps } = setup(); controller.start();
    for (const key of ['', 'Alt+', 'Potato+F', 'Ctrl+Ctrl+F', 'Ctrl+banana']) {
      expect(controller.registerShortcut('toggleOverlay', key)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(controller.registerShortcut('toggleRecording', 'CommandOrControl+Option+f')).toEqual({ ok: false, error: 'conflict' });
    expect(deps.globalShortcut.unregister).not.toHaveBeenCalled();
  });
  it.each(['false', 'throw'])('restores previous binding after register %s', mode => {
    const { controller, deps } = setup(); controller.start();
    if (mode === 'throw') deps.globalShortcut.register.mockImplementationOnce(() => { throw new Error('OS'); });
    else deps.globalShortcut.register.mockReturnValueOnce(false);
    expect(controller.registerShortcut('toggleOverlay', 'Ctrl+X')).toEqual({ ok: false, error: 'conflict' });
    expect(deps.globalShortcut.register).toHaveBeenLastCalledWith('Alt+Command+F', expect.any(Function));
    expect(controller.getShortcutStatus().toggleOverlay).toBe('ok');
    expect(controller.getShortcuts().toggleOverlay).toBe('Alt+Command+F');
    expect(deps.writeSettings).not.toHaveBeenCalled();
  });
  it('detects equivalent saved startup bindings without relying on the OS', () => {
    const { controller, deps } = setup('darwin', { toggleRecording: 'CommandOrControl+Option+F' });
    controller.start();
    expect(controller.getShortcutStatus().toggleRecording).toBe('conflict');
    expect(deps.globalShortcut.register).toHaveBeenCalledTimes(1);
  });
  it('reports startup failures without losing config and forces unlock', () => {
    const { controller, deps } = setup(); deps.globalShortcut.register.mockReturnValue(false);
    controller.start();
    expect(controller.getShortcutStatus().toggleOverlay).toBe('conflict');
    expect(controller.getShortcuts().toggleOverlay).toBe('Alt+Command+F');
    expect(deps.log).toHaveBeenCalled(); expect(deps.onUnlockUnavailable).toHaveBeenCalled();
  });
  it('forces unlock when rollback fails, persists successful rebind and unbind', () => {
    const { controller, deps } = setup(); controller.start();
    deps.globalShortcut.register.mockReturnValueOnce(false).mockReturnValueOnce(false);
    controller.registerShortcut('toggleOverlay', 'Ctrl+X');
    expect(controller.getShortcutStatus().toggleOverlay).toBe('conflict');
    expect(deps.onUnlockUnavailable).toHaveBeenCalled();
    expect(controller.registerShortcut('toggleOverlay', 'Ctrl+X')).toEqual({ ok: true });
    expect(deps.readSettings().shortcuts?.toggleOverlay).toBe('Ctrl+X');
    expect(controller.registerShortcut('toggleOverlay', null)).toEqual({ ok: true });
    expect(controller.getShortcutStatus().toggleOverlay).toBe('unbound');
    expect(deps.readSettings().shortcuts?.toggleOverlay).toBeNull();
  });
  it('normalizes modifier ordering, aliases and key names', () => {
    expect(acceleratorKey('Shift+CommandOrControl+Escape', 'win32')).toBe(acceleratorKey('Control+Shift+Esc', 'win32'));
    expect(acceleratorKey('Alt+Plus', 'darwin')).not.toBeNull();
  });
  it('unlocks first, then closes; opens hidden overlays and routes recording', async () => {
    let state = { visible: true, clickThrough: true };
    const overlay = { state: () => state, setClickThrough: vi.fn((on: boolean) => { state.clickThrough = on; }), close: vi.fn(), open: vi.fn(async () => {}) };
    const record = vi.fn();
    await dispatchOverlayShortcut('toggleOverlay', overlay, record);
    expect(overlay.setClickThrough).toHaveBeenCalledWith(false); expect(overlay.close).not.toHaveBeenCalled();
    await dispatchOverlayShortcut('toggleOverlay', overlay, record); expect(overlay.close).toHaveBeenCalledOnce();
    state = { visible: false, clickThrough: false };
    await dispatchOverlayShortcut('toggleOverlay', overlay, record); expect(overlay.open).toHaveBeenCalledOnce();
    await dispatchOverlayShortcut('toggleClickThrough', overlay, record); expect(state.clickThrough).toBe(true);
    await dispatchOverlayShortcut('toggleRecording', overlay, record); expect(record).toHaveBeenCalledOnce();
  });
});
