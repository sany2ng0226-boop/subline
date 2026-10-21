/** Share the quit confirmation flow before invoking Electron's immediate exit. */
export function createGuardedRelaunch(deps: {
  confirm: () => Promise<boolean>;
  flush: () => Promise<void>;
  proceed: () => void;
}): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= (async () => {
      if (!await deps.confirm()) return;
      await deps.flush();
      deps.proceed();
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
