interface QuitEvent { preventDefault(): void }

export function createQuitFlow(options: {
  hasUnsavedContent(): boolean;
  confirmLeave(): Promise<boolean>;
  cleanup(): void;
  quit(): void;
  exit(code: number): void;
}) {
  let leaveConfirmed = false;
  let pending: Promise<void> | undefined;
  function commit(): void {
    if (leaveConfirmed) return;
    leaveConfirmed = true;
    // Arm before cleanup: a failed cleanup must not leave an invisible app alive.
    setTimeout(() => options.exit(0), 3_000).unref?.();
    try { options.cleanup(); } finally {
      // Leave Electron's cancelled quit/close stack before starting a fresh quit.
      setImmediate(options.quit);
    }
  }
  return {
    isQuitting: () => leaveConfirmed,
    windowsClosed: commit,
    handle(event: QuitEvent): void {
      if (leaveConfirmed) return;
      event.preventDefault();
      if (pending) return;
      if (!options.hasUnsavedContent()) {
        commit();
        return;
      }
      pending = Promise.resolve().then(options.confirmLeave).then((ok) => {
        if (ok) commit();
      }).catch((error) => console.error('Quit confirmation failed', error)).finally(() => {
        pending = undefined;
      });
    },
  };
}

interface MainWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export function setupSingleInstance(options: {
  skip: boolean;
  requestLock(): boolean;
  quit(): void;
  onSecondInstance(callback: () => void): void;
  whenReady(): Promise<unknown>;
  window(): MainWindow | null;
  createWindow(): void;
}): boolean {
  if (options.skip) return true;
  if (!options.requestLock()) {
    options.quit();
    return false;
  }
  options.onSecondInstance(() => {
    void options.whenReady().then(() => {
      let window = options.window();
      if (!window || window.isDestroyed()) {
        options.createWindow();
        window = options.window();
      }
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
  });
  return true;
}
