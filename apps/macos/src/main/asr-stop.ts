import type { AsrToMain, MainToAsr } from '../shared/types';

interface AsrChild {
  postMessage(message: MainToAsr): void;
  on(event: 'message', listener: (message: AsrToMain) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  removeListener(event: 'message', listener: (message: AsrToMain) => void): unknown;
  removeListener(event: 'exit', listener: (code: number) => void): unknown;
}

/** The worker posts its acknowledgement after all final segments on the same IPC channel. */
export function createAsrStopController(timeoutMs = 15_000) {
  let nextRequestId = 0;
  let pending: { child: AsrChild; result: Promise<void> } | undefined;

  return {
    stop(child: AsrChild): Promise<void> {
      if (pending?.child === child) return pending.result;
      const requestId = ++nextRequestId;
      const result = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          child.removeListener('message', onMessage);
          child.removeListener('exit', onExit);
          if (error) reject(error);
          else resolve();
        };
        const onMessage = (message: AsrToMain): void => {
          if (message.type === 'flushed' && message.requestId === requestId) finish();
          else if (message.type === 'error') finish(new Error(message.message));
        };
        const onExit = (code: number): void => finish(new Error(`ASR exited before finishing the recording (${code})`));
        const timer = setTimeout(() => finish(new Error('ASR did not finish the recording within 15 seconds')), timeoutMs);
        child.on('message', onMessage);
        child.on('exit', onExit);
        try { child.postMessage({ type: 'flush', requestId }); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      const tracked = result.finally(() => {
        if (pending?.result === tracked) pending = undefined;
      });
      pending = { child, result: tracked };
      return tracked;
    },
  };
}
