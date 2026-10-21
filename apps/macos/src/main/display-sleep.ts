interface DisplaySleepBlocker {
  start(type: 'prevent-display-sleep'): number;
  stop(id: number): void;
}

export function createDisplaySleepBlocker(blocker: DisplaySleepBlocker) {
  let id: number | undefined;
  return {
    start(): void {
      if (id === undefined) id = blocker.start('prevent-display-sleep');
    },
    stop(): void {
      if (id === undefined) return;
      blocker.stop(id);
      id = undefined;
    },
  };
}
