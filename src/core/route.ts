import { on, W } from './util';

/**
 * SPA route changes: Navigation API first; otherwise chain-safe
 * pushState/replaceState wrapping plus popstate/hashchange.
 */
export function watchRoutes(cb: (url: string) => void): () => void {
  let last = location.href;
  const check = () => {
    if (location.href !== last) {
      last = location.href;
      cb(last);
    }
  };
  const nav = (W as any).navigation;
  if (nav?.addEventListener) {
    const f = () => setTimeout(check, 0);
    nav.addEventListener('navigatesuccess', f);
    return () => nav.removeEventListener('navigatesuccess', f);
  }
  const h = history as any;
  const restore: (() => void)[] = [];
  for (const m of ['pushState', 'replaceState']) {
    const orig = h[m];
    if (orig.__assist) continue;
    const w = function (this: any) {
      const r = orig.apply(this, arguments as any);
      setTimeout(check, 0);
      return r;
    };
    w.__assist = 1;
    h[m] = w;
    restore.push(() => h[m] === w && (h[m] = orig));
  }
  restore.push(on(W, 'popstate', check), on(W, 'hashchange', check));
  return () => restore.forEach((f) => f());
}
