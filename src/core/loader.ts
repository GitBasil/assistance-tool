import type { Ctx } from './types';
import { W } from './util';

/** Lazily import a content-hashed chunk from the same place assist.js came from. */
export function createLoader(ctx: () => Ctx, base: string) {
  const cache = new Map<string, Promise<any>>();
  const imp = (u: string) => import(/* webpackIgnore: true */ u);
  return function load<T = any>(name: string): Promise<T> {
    let p = cache.get(name);
    if (!p) {
      const file = __CHUNKS__[name];
      if (!file) return Promise.reject(new Error('unknown chunk ' + name));
      const url = base + file;
      p = imp(url)
        .catch(() => new Promise((r) => setTimeout(r, 1500)).then(() => imp(url)))
        .then((m) => m.default(ctx()))
        .catch((e) => {
          if (ctx().cfg.debug) console.warn('[assist] chunk failed', name, e);
          throw e;
        });
      cache.set(name, p);
    }
    return p as Promise<T>;
  };
}

/** gzip helper: inline worker when possible, otherwise main-thread CompressionStream. */
export function createGzip(base: string, file: string | undefined) {
  if (!('CompressionStream' in W)) return { start() {}, gzip: async (_s: string): Promise<Blob | null> => null };
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, (b: Blob | null) => void>();
  const attach = (w: Worker) => {
    worker = w;
    w.onmessage = (e) => {
      const f = pending.get(e.data.id);
      pending.delete(e.data.id);
      f?.(e.data.b ? new Blob([e.data.b]) : null);
    };
    w.onerror = () => {
      worker = null;
      pending.forEach((f) => f(null));
      pending.clear();
    };
  };
  let begun = false;
  const start = () => {
    if (begun || !file || !('Worker' in W)) return;
    begun = true;
    const url = base + file;
    let tt: any = null;
    try {
      // Trusted Types: a narrow policy that only vouches for our own worker URL.
      tt = (W as any).trustedTypes?.createPolicy('assist', { createScriptURL: (u: string) => (u === url || u.startsWith('blob:') ? u : '') });
    } catch {}
    const mk = (u: string) => new Worker(tt ? tt.createScriptURL(u) : u);
    try {
      if (new URL(url, location.href).origin === location.origin) return attach(mk(url));
      fetch(url, { credentials: 'omit' })
        .then((r) => r.text())
        .then((t) => attach(mk(URL.createObjectURL(new Blob([t], { type: 'text/javascript' })))))
        .catch(() => {});
    } catch {
      /* CSP worker-src blocks: stay on main thread */
    }
  };
  const main = (s: string) =>
    new Response(new Blob([s]).stream().pipeThrough(new (W as any).CompressionStream('gzip'))).blob();
  return {
    start,
    gzip(s: string): Promise<Blob | null> {
      if (s.length < 1024) return Promise.resolve(null);
      start();
      if (!worker) return main(s).catch(() => null);
      const id = ++seq;
      return new Promise((res) => {
        pending.set(id, res);
        worker!.postMessage({ id, s });
        setTimeout(() => pending.has(id) && (pending.delete(id), res(null)), 3000);
      });
    },
  };
}
