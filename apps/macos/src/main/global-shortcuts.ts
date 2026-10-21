import type { AppSettings, ShortcutAction } from '@rt/core';

const actions: ShortcutAction[] = ['toggleOverlay', 'toggleRecording', 'toggleClickThrough'];
type Status = Record<ShortcutAction, 'ok' | 'conflict' | 'unbound'>;
type Map = Record<ShortcutAction, string | null>;
interface Dependencies {
  globalShortcut: { register(key: string, cb: () => void): boolean; unregister(key: string): void; unregisterAll(): void };
  platform: string;
  readSettings(): AppSettings;
  writeSettings(settings: AppSettings): unknown;
  dispatch(action: ShortcutAction): void | Promise<void>;
  onUnlockUnavailable(): void;
  log(error: unknown): void;
}

// Normalize Electron modifier aliases and ordering so equivalent bindings conflict.
export function acceleratorKey(value: string, platform: string): string | null {
  const parts = value.split('+');
  const key = parts.pop()?.toLowerCase();
  if (!key || !(/^[a-z0-9]$/.test(key) || /^f([1-9]|1\d|2[0-4])$/.test(key)
    || /^(plus|space|tab|capslock|numlock|scrolllock|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|volumeup|volumedown|volumemute|medianexttrack|mediaprevioustrack|mediastop|mediaplaypause|printscreen|num[0-9]|numdec|numadd|numsub|nummult|numdiv)$/.test(key)
    || /^[)!@#$%^&*(:;<,>.?/:\-_=~`\[\]\\'"{}|]$/.test(key))) return null;
  const aliases: Record<string, string> = {
    command: 'cmd', cmd: 'cmd', control: 'ctrl', ctrl: 'ctrl', alt: 'alt', option: 'alt',
    shift: 'shift', super: platform === 'darwin' ? 'cmd' : 'super', meta: platform === 'darwin' ? 'cmd' : 'super', altgr: 'altgr',
    commandorcontrol: platform === 'darwin' ? 'cmd' : 'ctrl',
    cmdorctrl: platform === 'darwin' ? 'cmd' : 'ctrl',
  };
  const modifiers = parts.map(p => aliases[p.toLowerCase()]);
  if (modifiers.some(p => !p) || new Set(modifiers).size !== modifiers.length) return null;
  return [...modifiers.sort(), key === 'esc' ? 'escape' : key === 'enter' ? 'return' : key].join('+');
}

export function createGlobalShortcuts(deps: Dependencies) {
  const modifier = deps.platform === 'darwin' ? 'Command' : 'Control';
  const config: Map = { toggleOverlay: `Alt+${modifier}+F`, toggleRecording: `Alt+${modifier}+R`, toggleClickThrough: null };
  const status: Status = { toggleOverlay: 'unbound', toggleRecording: 'unbound', toggleClickThrough: 'unbound' };
  const safe = (fn: () => void) => { try { fn(); } catch (error) { deps.log(error); } };
  const getOverlayUnlockShortcut = (): string | null => status.toggleClickThrough === 'ok' ? config.toggleClickThrough
    : status.toggleOverlay === 'ok' ? config.toggleOverlay : null;
  const enforce = () => { if (getOverlayUnlockShortcut() === null) safe(deps.onUnlockUnavailable); };
  function bind(action: ShortcutAction, key: string): boolean {
    try {
      return deps.globalShortcut.register(key, () => {
        try { void Promise.resolve(deps.dispatch(action)).catch(deps.log); } catch (error) { deps.log(error); }
      });
    } catch (error) { deps.log(error); return false; }
  }
  return {
    getOverlayUnlockShortcut,
    getShortcuts: (): Map => ({ ...config }),
    getShortcutStatus: (): Status => ({ ...status }),
    start() {
      Object.assign(config, deps.readSettings().shortcuts);
      const registered = new Set<string>();
      for (const action of actions) {
        const key = config[action];
        const normalized = key === null ? null : acceleratorKey(key, deps.platform);
        status[action] = key === null ? 'unbound'
          : normalized && !registered.has(normalized) && bind(action, key) ? 'ok' : 'conflict';
        if (status[action] === 'ok') registered.add(normalized!);
        if (status[action] === 'conflict') deps.log(`Shortcut registration failed: ${action}`);
      }
      enforce();
    },
    registerShortcut(action: ShortcutAction, key: string | null): { ok: boolean; error?: 'invalid' | 'conflict' } {
      if (!actions.includes(action) || (key !== null && (typeof key !== 'string' || !acceleratorKey(key, deps.platform)))) return { ok: false, error: 'invalid' };
      if (key !== null && actions.some(other => other !== action && config[other] !== null
        && acceleratorKey(config[other]!, deps.platform) === acceleratorKey(key, deps.platform))) return { ok: false, error: 'conflict' };
      const old = config[action];
      const wasBound = status[action] === 'ok';
      try { if (old && wasBound) deps.globalShortcut.unregister(old); }
      catch (error) { deps.log(error); return { ok: false, error: 'conflict' }; }
      if (key !== null && !bind(action, key)) {
        status[action] = old === null ? 'unbound' : wasBound && bind(action, old) ? 'ok' : 'conflict';
        enforce();
        return { ok: false, error: 'conflict' };
      }
      config[action] = key;
      status[action] = key === null ? 'unbound' : 'ok';
      safe(() => deps.writeSettings({ ...deps.readSettings(), shortcuts: { ...config } }));
      enforce();
      return { ok: true };
    },
    stop() {
      safe(() => deps.globalShortcut.unregisterAll());
      for (const action of actions) status[action] = 'unbound';
      enforce();
    },
  };
}

/** A locked visible overlay must unlock before a subsequent press can close it. */
export async function dispatchOverlayShortcut(action: ShortcutAction, overlay: {
  state(): { visible: boolean; clickThrough: boolean };
  setClickThrough(on: boolean): unknown;
  open(): Promise<void>;
  close(): void;
}, toggleRecording: () => void): Promise<void> {
  const state = overlay.state();
  if (action === 'toggleRecording') toggleRecording();
  else if (action === 'toggleClickThrough') overlay.setClickThrough(!state.clickThrough);
  else if (state.visible && state.clickThrough) overlay.setClickThrough(false);
  else if (state.visible) overlay.close();
  else await overlay.open();
}
