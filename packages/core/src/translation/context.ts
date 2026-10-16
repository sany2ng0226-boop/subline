/** Source-only context: never recycle generated translations as evidence. */
export class TranslationContext {
  private pair = '';
  private previous: string[] = [];

  take(source: string, target: string, text: string): string[] {
    const pair = `${source}:${target}`;
    if (pair !== this.pair) this.reset();
    this.pair = pair;
    const context = [...this.previous];
    this.previous = [...this.previous, text.slice(-400)].slice(-2);
    return context;
  }

  reset(): void {
    this.pair = '';
    this.previous = [];
  }
}
