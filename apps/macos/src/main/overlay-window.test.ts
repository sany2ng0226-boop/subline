import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { makeDefaults, type AppSettings } from '@rt/core';
import { createOverlayController, OVERLAY_BROADCAST_CHANNELS } from './overlay-window';

function setup(platform = 'darwin', saved?: { x: number; y: number; width: number; height: number }) {
  let settings: AppSettings = { ...makeDefaults([]), overlay: { fontDelta: 2, clickThrough: true, bounds: saved } };
  const webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
  const target = Object.assign(new EventEmitter(), {
    webContents, focus: vi.fn(), isDestroyed: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(), setIgnoreMouseEvents: vi.fn(),
    getBounds: vi.fn(() => ({ x: 12, y: 20, width: 700, height: 150 })),
    loadURL: vi.fn(async () => {}), loadFile: vi.fn(async () => {}),
    close: vi.fn(() => { target.emit('closed'); }),
    destroy: vi.fn(() => { target.emit('closed'); }),
  });
  const deps = {
    createWindow: vi.fn(() => target as unknown as BrowserWindow),
    screen: {
      getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } })),
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } })),
    },
    preload: '/preload.js', rendererFile: '/index.html', rendererUrl: undefined as string | undefined,
    platform, readSettings: () => settings,
    writeSettings: vi.fn((next: AppSettings) => { settings = next; }),
    publish: vi.fn(),
  };
  return { target, deps, controller: createOverlayController(deps), settings: () => settings };
}

afterEach(() => vi.useRealTimers());

describe('overlay window', () => {
  it('starts closed, opens a single shared renderer and focuses on repeated opens', async () => {
    const { controller, deps, target } = setup();
    expect(controller.state().visible).toBe(false);
    expect(deps.createWindow).not.toHaveBeenCalled();
    await controller.open();
    await controller.open();
    expect(deps.createWindow).toHaveBeenCalledTimes(1);
    expect(target.focus).toHaveBeenCalledOnce();
    expect(deps.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      x: 180, y: 680, width: 640, height: 120,
      frame: false, transparent: true, alwaysOnTop: true, hasShadow: false,
      resizable: false, skipTaskbar: true, focusable: true,
      webPreferences: { preload: '/preload.js', contextIsolation: true },
    }));
    expect(target.loadFile).toHaveBeenCalledWith('/index.html', { hash: 'overlay' });
    expect(target.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(target.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    expect(target.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    target.webContents.emit('did-finish-load');
    expect(deps.publish).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, clickThrough: true }));
  });

  it('uses dev hash and Windows fullscreen level', async () => {
    const { controller, deps, target } = setup('win32');
    deps.rendererUrl = 'http://localhost:5173/#old';
    await controller.open();
    expect(target.loadURL).toHaveBeenCalledWith('http://localhost:5173/#overlay');
    expect(target.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  });

  it('clamps partially visible bounds and falls back for disconnected displays', async () => {
    const partial = setup('darwin', { x: 900, y: 750, width: 900, height: 400 });
    await partial.controller.open();
    expect(partial.deps.createWindow).toHaveBeenCalledWith(expect.objectContaining({ x: 360, y: 680, width: 640, height: 120 }));
    const disconnected = setup('darwin', { x: -3000, y: 0, width: 640, height: 120 });
    await disconnected.controller.open();
    expect(disconnected.deps.createWindow).toHaveBeenCalledWith(expect.objectContaining({ x: 180, y: 680 }));
  });

  it('debounces bounds writes, preserves settings, persists click-through and flushes on close', async () => {
    vi.useFakeTimers();
    const { controller, target, deps, settings } = setup();
    await controller.open();
    target.emit('move');
    target.emit('resize');
    expect(deps.writeSettings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(deps.writeSettings).toHaveBeenCalledTimes(1);
    expect(settings().overlay!.fontDelta).toBe(2);
    expect(settings().overlay!.bounds).toEqual({ x: 12, y: 20, width: 640, height: 120 });
    controller.setClickThrough(false);
    expect(target.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    expect(settings().overlay!.clickThrough).toBe(false);
    target.emit('move');
    controller.close();
    expect(controller.state().visible).toBe(false);
    expect(deps.publish).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    const writes = deps.writeSettings.mock.calls.length;
    vi.runAllTimers();
    expect(deps.writeSettings).toHaveBeenCalledTimes(writes);
    await controller.open();
    expect(deps.createWindow).toHaveBeenCalledTimes(2);
  });

  it('identifies overlay senders and only sends to live windows', async () => {
    const { controller, target } = setup();
    await controller.open();
    expect(controller.isOverlaySender(target.webContents as never)).toBe(true);
    expect(controller.isOverlaySender({} as never)).toBe(false);
    controller.send('pipeline:segment', { text: 'hello' });
    expect(target.webContents.send).toHaveBeenCalledOnce();
    target.isDestroyed.mockReturnValue(true);
    controller.send('pipeline:segment', {});
    expect(target.webContents.send).toHaveBeenCalledOnce();
    expect(OVERLAY_BROADCAST_CHANNELS.has('pipeline:status')).toBe(true);
    expect(OVERLAY_BROADCAST_CHANNELS.has('translation:status')).toBe(true);
    expect(OVERLAY_BROADCAST_CHANNELS.has('window:archive-before-close')).toBe(false);
    expect(OVERLAY_BROADCAST_CHANNELS.has('window:close-guard')).toBe(false);
  });

  it('destroys failed loads and reports the closed state', async () => {
    const { controller, target } = setup();
    target.loadFile.mockRejectedValueOnce(new Error('load failed'));
    await expect(controller.open()).rejects.toThrow('load failed');
    expect(target.destroy).toHaveBeenCalledOnce();
    expect(controller.state().visible).toBe(false);
  });
});

 it('refuses restored and requested click-through when unlock is unavailable', async () => {
   const { controller, deps, target } = setup();
   Object.assign(deps, { canClickThrough: () => false });
   await controller.open();
   expect(controller.state().clickThrough).toBe(false);
   expect(controller.setClickThrough(true)).toEqual({ ok: false, error: 'no-unlock-shortcut' });
   expect(controller.setClickThrough(false)).toEqual({ ok: true });
   expect(controller.state().clickThrough).toBe(false);
   expect(target.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
 });
