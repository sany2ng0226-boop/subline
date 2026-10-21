import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle, WebContents } from 'electron';
import type { AppSettings, OverlayState, OverlayClickThroughResult } from '@rt/core';

export interface OverlayDependencies {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  screen: {
    getDisplayMatching(bounds: Rectangle): { workArea: Rectangle };
    getPrimaryDisplay(): { workArea: Rectangle };
  };
  preload: string;
  rendererFile: string;
  rendererUrl?: string;
  platform: string;
  readSettings(): AppSettings;
  writeSettings(settings: AppSettings): unknown;
  canClickThrough?(): boolean;
  publish(state: OverlayState): void;
}

export const OVERLAY_BROADCAST_CHANNELS = new Set([
  'pipeline:segment', 'pipeline:partial', 'pipeline:translation',
  'pipeline:status', 'translation:status',
]);

export function createOverlayController(deps: OverlayDependencies) {
  let window: BrowserWindow | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clickThrough = false;
  let bounds: Rectangle | undefined;
  const state = (): OverlayState => ({
    visible: !!window && !window.isDestroyed(), clickThrough,
    ...(bounds ? { bounds: { ...bounds } } : {}),
  });
  const publish = () => deps.publish(state());
  function persist() {
    clearTimeout(timer);
    timer = undefined;
    const settings = deps.readSettings();
    deps.writeSettings({
      ...settings,
      overlay: { fontDelta: 0, ...settings.overlay, clickThrough, ...(bounds ? { bounds } : {}) },
    });
  }
  function restoredBounds(): Rectangle {
    const position = deps.readSettings().overlay?.bounds;
    const saved = position ? { x: position.x, y: position.y, width: 640, height: 120 } : undefined;
    const area = saved ? deps.screen.getDisplayMatching(saved).workArea : deps.screen.getPrimaryDisplay().workArea;
    const intersects = saved && saved.x < area.x + area.width && saved.x + saved.width > area.x
      && saved.y < area.y + area.height && saved.y + saved.height > area.y;
    const width = 640;
    const height = 120;
    return {
      width, height,
      x: intersects ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : Math.round(area.x + (area.width - width) / 2),
      y: intersects ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : area.y + area.height - height,
    };
  }
  return {
    state,
    isOverlaySender: (sender: WebContents) => !!window && sender === window.webContents,
    send(channel: string, payload: unknown) {
      if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
    },
    async open() {
      if (window && !window.isDestroyed()) { window.focus(); return; }
      clickThrough = (deps.readSettings().overlay?.clickThrough ?? false) && (deps.canClickThrough?.() ?? true);
      bounds = restoredBounds();
      const target = deps.createWindow({
        ...bounds,
        frame: false, transparent: true, alwaysOnTop: true, hasShadow: false,
        resizable: false, skipTaskbar: true, focusable: true,
        webPreferences: { preload: deps.preload, contextIsolation: true },
      });
      window = target;
      target.setAlwaysOnTop(true, deps.platform === 'win32' ? 'screen-saver' : 'floating');
      target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      target.setIgnoreMouseEvents(clickThrough, { forward: true });
      const changed = () => {
        const { x, y } = target.getBounds();
        bounds = { x, y, width: 640, height: 120 };
        clearTimeout(timer);
        timer = setTimeout(persist, 250);
        publish();
      };
      target.on('move', changed);
      target.on('resize', changed);
      target.on('closed', () => {
        persist();
        window = null;
        publish();
      });
      target.webContents.on('did-finish-load', publish);
      publish();
      try {
        if (deps.rendererUrl) await target.loadURL(deps.rendererUrl.split('#')[0] + '#overlay');
        else await target.loadFile(deps.rendererFile, { hash: 'overlay' });
      } catch (error) {
        if (!target.isDestroyed()) target.destroy();
        throw error;
      }
    },
    close() {
      if (window && !window.isDestroyed()) window.close();
    },
    setClickThrough(on: boolean): OverlayClickThroughResult {
      // Never lock the window unless the global unlock binding is working.
      if (on && !(deps.canClickThrough?.() ?? true)) return { ok: false, error: 'no-unlock-shortcut' };
      clickThrough = on;
      window?.setIgnoreMouseEvents(on, { forward: true });
      persist();
      publish();
      return { ok: true };
    },
  };
}
