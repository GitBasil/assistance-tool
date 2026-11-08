import type { Config } from './config';
import type { Ev, Session } from './types';
import { D, sget, sset } from './util';

const MAX_PER_PV = 2000;
const MAX_OFFLINE = 500;
const FLUSH_MS = 5000;
const LIVE_FLUSH_MS = 250;
const FLUSH_N = 50;

export interface Batcher {
  push(e: Ev): void;
  flush(final?: boolean): void;
  newPage(): void;
  stop(): void;
  stats(): { sent: number; bytes: number; dropped: number };
  worker?: Worker;
}

/**
 * Buffers events and uploads them in batches: every 5s or 50 events (every 250ms, and
 * page views at once, while a dashboard watches the session live), gzip via
 * CompressionStream (in a worker when available), final flush via sendBeacon
 * (the caller invokes flush(true) on pagehide/visibility-hidden). Failed
 * uploads back off and spill into a capped localStorage queue.
 */
export function createBatcher(
  cfg: Config,
  session: Session,
  header: () => Record<string, unknown>,
  gzip: (s: string) => Promise<Blob | null>,
): Batcher {
  let q: Ev[] = [];
  let count = 0;
  let dropped = 0;
  let sent = 0;
  let bytes = 0;
  let backoff = 0;
  let nextTry = 0;
  let inflight = false;
  const url = () =>
    `${cfg.endpoint}/collect?k=${encodeURIComponent(cfg.key)}&s=${encodeURIComponent(cfg.site)}`;

  const offline = (evs: Ev[]) => {
    if (!session.storage) return;
    const old = sget<Ev[]>('q', []);
    sset('q', old.concat(evs).slice(-MAX_OFFLINE));
  };

  const payload = (evs: Ev[]) => JSON.stringify({ v: 1, ...header(), ev: evs });

  async function send(evs: Ev[]) {
    const body = payload(evs);
    inflight = true;
    try {
      const gz = await gzip(body);
      const res = await fetch(url(), {
        method: 'POST',
        body: gz || body,
        keepalive: (gz?.size || body.length) < 60000,
        headers: { 'content-type': 'text/plain' },
        credentials: 'omit',
        mode: 'cors',
      });
      if (!res.ok && res.status !== 400 && res.status !== 413) throw new Error(String(res.status));
      session.watched = res.status === 202 ? Date.now() + 60000 : 0;
      // Remembered per tab so the next page starts in live mode instead of waiting 5 s.
      if (session.storage) sset('watched', session.watched || undefined, true);
      sent += evs.length;
      bytes += gz?.size || body.length;
      backoff = 0;
      const old = session.storage ? sget<Ev[]>('q', []) : [];
      if (old.length) {
        sset('q', undefined);
        q = old.concat(q);
      }
    } catch {
      backoff = Math.min((backoff || 2000) * 2, 120000);
      nextTry = Date.now() + backoff;
      offline(evs);
    } finally {
      inflight = false;
    }
  }

  function flush(final = false) {
    if (!q.length || !cfg.endpoint || !session.recording) return;
    if (!final && (inflight || Date.now() < nextTry || D.visibilityState === 'hidden')) return;
    const evs = q;
    q = [];
    if (final) {
      const body = payload(evs);
      const ok =
        body.length < 60000 &&
        navigator.sendBeacon?.(url(), new Blob([body], { type: 'text/plain' }));
      if (ok) {
        sent += evs.length;
        bytes += body.length;
      } else offline(evs);
      return;
    }
    send(evs);
  }

  let timer: any = 0;
  const live = () => (session.watched || 0) > Date.now();
  const schedule = () => {
    if (!timer)
      timer = setTimeout(
        () => {
          timer = 0;
          flush();
          if (q.length) schedule();
        },
        live() ? LIVE_FLUSH_MS : FLUSH_MS,
      );
  };
  return {
    push(e) {
      if (!session.recording) return;
      if (count >= MAX_PER_PV) {
        dropped++;
        return;
      }
      count++;
      q.push(e);
      // While a dashboard watches, a new page is announced the moment it opens: that page
      // view is what moves the live replay to the next screen.
      if (q.length >= FLUSH_N || (e.t === 'pv' && live())) flush();
      if (q.length) schedule();
    },
    flush,
    newPage() {
      flush();
      count = 0;
    },
    stop() {
      clearTimeout(timer);
      flush(true);
    },
    stats: () => ({ sent, bytes, dropped }),
  };
}
