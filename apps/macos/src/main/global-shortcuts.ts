import type { AppSettings } from '@rt/core';

export function dispatchShortcut(
  windows: ReadonlyArray<{ isDestroyed(): boolean; webContents: { send(channel: string, action: string): void } }>,
  action: 'toggleRecording',
): void {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send('shortcut', action);
  }
}

interface Dependencies {
  globalShortcut: {
    register(key: string, callback: () => void): boolean;
    unregister(key: string): void;
  };
  platform: string;
  readSettings(): AppSettings;
  dispatch(action: 'toggleRecording'): void;
  log(error: unknown): void;
}

export function createGlobalShortcuts(deps: Dependencies) {
  let registered: string | null = null;
  return {
    start() {
      if (registered !== null) {
        deps.globalShortcut.unregister(registered);
        registered = null;
      }
      const key = deps.readSettings().shortcuts?.toggleRecording;
      if (key === null) return;
      const accelerator = key ?? `Alt+${deps.platform === 'darwin' ? 'Command' : 'Control'}+R`;
      try {
        if (deps.globalShortcut.register(accelerator, () => deps.dispatch('toggleRecording'))) {
          registered = accelerator;
        } else {
          deps.log(`Shortcut registration failed: toggleRecording (${accelerator})`);
        }
      } catch (error) {
        deps.log(error);
      }
    },
  };
}
