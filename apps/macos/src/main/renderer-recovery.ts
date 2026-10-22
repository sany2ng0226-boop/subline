export function createRendererRecovery(options: {
  isQuitting(): boolean;
  isDestroyed(): boolean;
  stopSession(): void;
  flushRecovery(): Promise<void>;
  reload(): void;
  reportFailure(): void;
  log(error: unknown): void;
  now?: () => number;
}) {
  let recovering: Promise<void> | undefined;
  const crashes: number[] = [];

  return {
    handle(): Promise<void> {
      if (options.isQuitting() || options.isDestroyed()) return Promise.resolve();
      if (recovering) return recovering;
      const now = options.now?.() ?? Date.now();
      while (crashes.length && now - crashes[0]! >= 60_000) crashes.shift();
      crashes.push(now);
      options.stopSession();
      recovering = options.flushRecovery().catch(options.log).then(() => {
        if (options.isQuitting() || options.isDestroyed()) return;
        // A broken renderer must not spin in an automatic restart loop.
        if (crashes.length > 2) options.reportFailure();
        else options.reload();
      }).finally(() => { recovering = undefined; });
      return recovering;
    },
  };
}
