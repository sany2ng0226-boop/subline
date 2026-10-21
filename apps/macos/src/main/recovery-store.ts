import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_RECOVERY_BYTES = 20 * 1024 * 1024;

type Waiter = { resolve: () => void; reject: (error: unknown) => void };
type Operation = { json?: string; read?: () => Promise<void>; waiters: Waiter[] };

/** One writer per profile. Clears are barriers: later saves cannot resurrect older snapshots. */
export function createRecoveryStore(userData: () => string) {
  const queue: Operation[] = [];
  let running: Promise<void> | undefined;
  const file = () => path.join(userData(), 'recovery.json');

  async function persist(json: string): Promise<void> {
    const target = file();
    const tmp = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      const handle = await fs.open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(json, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async function drain(): Promise<void> {
    while (queue.length) {
      const op = queue.shift()!;
      try {
        if (op.read) await op.read();
        else if (op.json === undefined) await fs.rm(file(), { force: true });
        else await persist(op.json);
        op.waiters.forEach((w) => w.resolve());
      } catch (error) {
        op.waiters.forEach((w) => w.reject(error));
      }
    }
  }

  function start(): void {
    if (running) return;
    running = drain().finally(() => {
      running = undefined;
      // A caller may enqueue after its operation resolves but before this finalizer runs.
      if (queue.length) start();
    });
  }

  function enqueue(json?: string, read?: () => Promise<void>): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      const last = queue.at(-1);
      if (json !== undefined && last?.json !== undefined) {
        last.json = json;
        last.waiters.push({ resolve, reject });
      } else queue.push({ json, read, waiters: [{ resolve, reject }] });
    });
    start();
    return result;
  }

  async function flush(): Promise<void> {
    while (running) await running;
  }

  return {
    async saveRecovery(json: string): Promise<void> {
      if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_RECOVERY_BYTES) {
        throw new Error('Recovery must be a JSON string of at most 20 MiB');
      }
      JSON.parse(json);
      await enqueue(json);
    },
    async loadRecovery(): Promise<string | null> {
      let result: string | null = null;
      await enqueue(undefined, async () => {
        let raw: string;
        try {
          if ((await fs.stat(file())).size > MAX_RECOVERY_BYTES) return;
          raw = await fs.readFile(file(), 'utf8');
        } catch { return; }
        try {
          JSON.parse(raw);
          result = raw;
        } catch {
          try {
            await fs.rename(file(), path.join(userData(), `recovery.corrupt-${Date.now()}.json`));
          } catch { /* Unreadable profiles must not block startup. */ }
        }
      });
      return result;
    },
    clearRecovery: () => enqueue(),
    flush,
  };
}
