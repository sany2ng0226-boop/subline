import { describe, expect, it, vi } from 'vitest';
import { makeDefaults } from '@rt/core';
import { createAlwaysOnTopController } from './always-on-top';

describe('main window pinning', () => {
  it('applies persisted state, saves toggles without losing other settings, and notifies', () => {
    let settings = { ...makeDefaults(['ja']), alwaysOnTop: true };
    const setAlwaysOnTop = vi.fn();
    const notify = vi.fn();
    const save = vi.fn((next) => (settings = next));
    const controller = createAlwaysOnTopController({
      load: () => settings, save, window: () => ({ setAlwaysOnTop }), notify,
    });
    controller.apply(settings.alwaysOnTop);
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
    expect(save).not.toHaveBeenCalled();
    controller.set(false);
    expect(settings.alwaysOnTop).toBe(false);
    expect(settings.nativeLang).toBe('ja');
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'floating');
    expect(notify).toHaveBeenLastCalledWith(false);
    controller.set(true);
    expect(settings.alwaysOnTop).toBe(true);
    expect(notify).toHaveBeenLastCalledWith(true);
  });

  it('can persist while the window is absent', () => {
    const settings = makeDefaults([]);
    const save = vi.fn((next) => next);
    const notify = vi.fn();
    createAlwaysOnTopController({ load: () => settings, save, window: () => null, notify }).set(true);
    expect(save).toHaveBeenCalledWith({ ...settings, alwaysOnTop: true });
    expect(notify).toHaveBeenCalledWith(true);
  });
});
