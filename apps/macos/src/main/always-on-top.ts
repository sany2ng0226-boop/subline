import type { AppSettings } from '@rt/core';

interface Dependencies {
  load(): AppSettings;
  save(settings: AppSettings): AppSettings;
  window(): { setAlwaysOnTop(on: boolean, level: 'floating'): void } | null;
  notify(on: boolean): void;
}

export function createAlwaysOnTopController(deps: Dependencies) {
  function apply(on: boolean): void {
    deps.window()?.setAlwaysOnTop(on, 'floating');
    deps.notify(on);
  }
  return {
    apply,
    set(on: boolean): void {
      const saved = deps.save({ ...deps.load(), alwaysOnTop: on });
      apply(saved.alwaysOnTop);
    },
  };
}
