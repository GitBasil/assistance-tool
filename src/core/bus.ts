type Fn = (data: any) => void;

/** Tiny synchronous pub/sub shared by core and chunks. */
export class Bus {
  private m = new Map<string, Set<Fn>>();

  on(type: string, fn: Fn): () => void {
    let s = this.m.get(type);
    if (!s) this.m.set(type, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(type: string, data?: unknown) {
    const s = this.m.get(type);
    if (s) for (const fn of s) {
      try {
        fn(data);
      } catch (e) {
        this.err?.(e);
      }
    }
    if (type !== '*') this.m.get('*')?.forEach((fn) => fn({ type, data }));
  }

  err?: (e: unknown) => void;

  clear() {
    this.m.clear();
  }
}
