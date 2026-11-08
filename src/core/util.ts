export const W = window;
export const D = document;
export const now = () => performance.now();

/** Small, fast non-crypto string hash (FNV-1a, base36). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Uniform [0,1) bucket from a string, used for sampling. */
export const bucket = (s: string) => parseInt(hash(s), 36) / 4294967296;

export const rid = () =>
  (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 16);

export const idle = (fn: () => void, timeout = 2000) =>
  (W as any).requestIdleCallback
    ? (W as any).requestIdleCallback(fn, { timeout })
    : setTimeout(fn, 1);

type Guard = <F extends (...a: any[]) => any>(f: F) => F;
let G: Guard = (f) => f;
/** Installed by core: every listener registered via on() runs inside guard(). */
export const setGuard = (g: Guard) => (G = g);

export function on(
  t: EventTarget,
  type: string,
  fn: (e: any) => void,
  opts: AddEventListenerOptions = { capture: true, passive: true },
): () => void {
  const g = G(fn);
  t.addEventListener(type, g, opts);
  return () => t.removeEventListener(type, g, opts);
}

/** Run after the next paint, so layout reads never land inside an interaction (INP). */
export function afterPaint(fn: () => void) {
  const f = G(fn);
  let done = false;
  const run = () => !done && ((done = true), f());
  requestAnimationFrame(() => setTimeout(run));
  setTimeout(run, 150); // hidden tabs get no rAF
}

function storageOf(session?: boolean): Storage | null {
  try {
    return session ? sessionStorage : localStorage;
  } catch {
    return null;
  }
}

export const PREFIX = '__assist_';

export function sget<T>(k: string, d: T, session?: boolean): T {
  try {
    const v = storageOf(session)?.getItem(PREFIX + k);
    return v == null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
}

export function sset(k: string, v: unknown, session?: boolean) {
  try {
    const s = storageOf(session);
    if (!s) return;
    if (v === undefined) s.removeItem(PREFIX + k);
    else s.setItem(PREFIX + k, JSON.stringify(v));
  } catch {
    /* quota or disabled storage */
  }
}

export const elOf = (e: Event): Element | null => {
  const p = (e.composedPath && e.composedPath()[0]) || e.target;
  return p instanceof Element ? p : (p as Node)?.parentElement || null;
};

export const isEditable = (el: Element | null): el is HTMLInputElement =>
  !!el &&
  (el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable);

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
