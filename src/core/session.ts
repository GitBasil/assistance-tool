import type { Config } from './config';
import type { Session } from './types';
import { bucket, rid, sget, sset, W } from './util';

const IDLE = 30 * 60 * 1000;

export function privacySignal(): boolean {
  const n = navigator as any;
  return n.doNotTrack === '1' || (W as any).doNotTrack === '1' || n.globalPrivacyControl === true;
}

export function isBot(): boolean {
  const n = navigator as any;
  return !!n.webdriver || /headless|bot|crawl|spider|lighthouse|pingdom/i.test(n.userAgent || '');
}

/**
 * consent:
 *  - auto: record unless DNT/GPC; persistent storage allowed.
 *  - required: memory-only, nothing sent until Assist.consent(true).
 *  - none: no consent needed (integrator handles it elsewhere).
 */
export function createSession(cfg: Config, granted: boolean | null): Session {
  const blocked = cfg.consent === 'auto' && privacySignal();
  const allowed = cfg.consent === 'required' ? granted === true : !blocked && granted !== false;
  const storage = allowed;
  let vid = storage ? sget<string>('vid', '') : '';
  if (!vid) {
    vid = rid();
    if (storage) sset('vid', vid);
  }
  let s = storage ? sget<{ id: string; at: number } | null>('sid', null, true) : null;
  const t = Date.now();
  if (!s || t - s.at > IDLE) s = { id: rid(), at: t };
  s.at = t;
  if (storage) sset('sid', s, true);
  return {
    vid,
    sid: s.id,
    pid: rid(),
    recording: allowed && bucket(vid + ':s') < cfg.sampleRate,
    storage,
    bot: isBot(),
    start: Date.now(),
  };
}

export function touch(session: Session) {
  if (session.storage) sset('sid', { id: session.sid, at: Date.now() }, true);
}
