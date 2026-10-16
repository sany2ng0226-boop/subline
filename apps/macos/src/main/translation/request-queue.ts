/** Bound translation work before IPC; never wait for translation on the ASR path. */
export class TranslationRequestQueue<T, R> {
  private waiting: Array<{ input: T; resolve: (value: R) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private active = false;

  constructor(private readonly run: (input: T) => Promise<R>,
    private readonly maxWaiting = 3, private readonly maxWaitMs = 15_000) {}

  submit(input: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (this.active && this.waiting.length >= this.maxWaiting) {
        const oldest = this.waiting.shift()!;
        clearTimeout(oldest.timer);
        oldest.reject(new Error('翻译积压，已跳过此句翻译；原文保留'));
      }
      const entry = { input, resolve, reject, timer: setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        reject(new Error('翻译等待超过 15 秒，已跳过此句翻译；原文保留'));
      }, this.maxWaitMs) };
      this.waiting.push(entry);
      this.drain();
    });
  }

  cancelWaiting(): void {
    for (const entry of this.waiting.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(new Error('翻译配置已更新，取消旧队列；原文保留'));
    }
  }

  private drain(): void {
    if (this.active) return;
    const entry = this.waiting.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    this.active = true;
    // Catch synchronous transport errors as well as rejected inference requests.
    Promise.resolve().then(() => this.run(entry.input)).then(entry.resolve, entry.reject).finally(() => {
      this.active = false;
      this.drain();
    });
  }
}
