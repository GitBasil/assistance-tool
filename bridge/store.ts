import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync, rmSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tx, type Db } from './db';

/** A stored event: the wire event plus its batch header (flattened). `site` is the site id. */
export interface StoredEvent {
  t: string;
  ts?: number;
  at: number;
  sid: string;
  vid: string;
  pid: string;
  site: string;
  u: string;
  dev: string;
  grp: 'h' | 'c';
  bot: number;
  [k: string]: unknown;
}

export interface Snapshot {
  site: string;
  u: string;
  h: string;
  /** Element count at capture time, used to keep the fuller of two snapshots. */
  n?: number;
  /** Content hash: the replay frame id (`kf` events point at it). */
  ch?: string;
  w: number;
  ht: number;
  vw: number;
  html: string;
  at: number;
}

export const safe = (s: string) => s.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
export const urlKey = (u: string) => createHash('sha1').update(u).digest('hex').slice(0, 16);
const DAY = 86_400_000;

/**
 * Events live in SQLite (one row per event, indexed by site and time). Page
 * snapshots and replay frames are files: large, write-once blobs that the
 * dashboard fetches one at a time.
 */
export class Store {
  private snapDir: string;
  private frameDir: string;
  private ins;

  constructor(
    private db: Db,
    private dir: string,
  ) {
    this.snapDir = join(dir, 'snaps');
    this.frameDir = join(dir, 'frames');
    mkdirSync(this.snapDir, { recursive: true });
    mkdirSync(this.frameDir, { recursive: true });
    this.ins = db.prepare('INSERT INTO events (site, at, vid, body) VALUES (?, ?, ?, ?)');
  }

  append(events: StoredEvent[]) {
    if (!events.length) return;
    tx(this.db, () => {
      for (const e of events) this.ins.run(e.site, e.at, e.vid || '', JSON.stringify(e));
    });
  }

  /** Feeds stored events to `fn` in arrival order, optionally for one site and a time window (`until` exclusive). */
  replay(fn: (e: StoredEvent) => void, o: { site?: string; since?: number; until?: number } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.site) where.push('site = ?'), args.push(o.site);
    if (o.since) where.push('at >= ?'), args.push(o.since);
    if (o.until) where.push('at < ?'), args.push(o.until);
    const q = this.db.prepare(`SELECT body FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`);
    let n = 0;
    for (const r of q.iterate(...args) as Iterable<{ body: string }>) {
      try {
        fn(JSON.parse(r.body));
        n++;
      } catch {}
    }
    return n;
  }

  /** Events stored per site, and the newest arrival time. */
  counts(): Map<string, { events: number; last: number }> {
    const m = new Map<string, { events: number; last: number }>();
    for (const r of this.db.prepare('SELECT site, COUNT(*) n, MAX(at) last FROM events GROUP BY site').all() as { site: string; n: number; last: number }[])
      m.set(r.site, { events: Number(r.n), last: Number(r.last) });
    return m;
  }

  saveSnapshot(s: Snapshot) {
    if (s.ch) {
      // Every distinct page state, by content. Gzipped: the same stylesheet repeats in each one.
      const fd = join(this.frameDir, safe(s.site));
      mkdirSync(fd, { recursive: true });
      const fp = join(fd, `${safe(s.ch)}.json.gz`);
      if (!existsSync(fp)) writeFileSync(fp, gzipSync(JSON.stringify(s)));
    }
    const d = join(this.snapDir, safe(s.site));
    mkdirSync(d, { recursive: true });
    // A loading splash or empty shell must not replace a real capture of the same URL.
    const prev = this.snapshot(s.site, s.u);
    if (prev?.n && s.n && s.n < prev.n * 0.4 && s.at - prev.at < 6 * 3600_000) return;
    writeFileSync(join(d, `${urlKey(s.u)}.json`), JSON.stringify(s));
  }

  snapshot(site: string, u: string): Snapshot | null {
    const p = join(this.snapDir, safe(site), `${urlKey(u)}.json`);
    try {
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  /** One replay frame by content hash. */
  frame(site: string, ch: string): Snapshot | null {
    const p = join(this.frameDir, safe(site), `${safe(ch)}.json.gz`);
    try {
      return existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) : null;
    } catch {
      return null;
    }
  }

  hasSnapshot(site: string, u: string) {
    return existsSync(join(this.snapDir, safe(site), `${urlKey(u)}.json`));
  }

  /** Deletes events, snapshots and frames older than each site's retention. Returns rows + files removed. */
  purge(retention: (site: string) => number) {
    const now = Date.now();
    let removed = 0;
    const sites = (this.db.prepare('SELECT DISTINCT site FROM events').all() as { site: string }[]).map((r) => r.site);
    const del = this.db.prepare('DELETE FROM events WHERE site = ? AND at < ?');
    for (const s of sites) removed += Number(del.run(s, now - retention(s) * DAY).changes);
    for (const root of [this.snapDir, this.frameDir])
      for (const name of readdirSync(root)) {
        const d = join(root, name);
        if (!statSync(d).isDirectory()) continue;
        const cutoff = now - retention(name) * DAY;
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isFile() && statSync(p).mtimeMs < cutoff) (unlinkSync(p), removed++);
        }
      }
    return removed;
  }

  /** Right to erasure: every event of one visitor, on one site or everywhere. */
  eraseVisitor(vid: string, site?: string) {
    const r = site ? this.db.prepare('DELETE FROM events WHERE vid = ? AND site = ?').run(vid, site) : this.db.prepare('DELETE FROM events WHERE vid = ?').run(vid);
    return Number(r.changes);
  }

  /** Removes everything recorded for a site. */
  deleteSite(site: string) {
    const n = Number(this.db.prepare('DELETE FROM events WHERE site = ?').run(site).changes);
    for (const root of [this.snapDir, this.frameDir]) rmSync(join(root, safe(site)), { recursive: true, force: true });
    return n;
  }

  /** Moves a site's snapshot and frame folders (used when legacy host-named data becomes a site). */
  renameFiles(from: string, to: string) {
    for (const root of [this.snapDir, this.frameDir]) {
      const a = join(root, safe(from));
      const b = join(root, safe(to));
      if (existsSync(a) && !existsSync(b)) renameSync(a, b);
    }
  }

  /** Day-partitioned NDJSON logs written by earlier versions. */
  legacyFiles() {
    return readdirSync(this.dir)
      .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))
      .sort();
  }

  /**
   * Imports the NDJSON logs into the database, renaming each event's site with
   * `siteFor` (legacy logs keyed sites by host name), then moves the files into
   * `legacy/` so nothing is ever deleted and the import never runs twice.
   */
  async importLegacy(siteFor: (host: string) => string) {
    const files = this.legacyFiles();
    if (!files.length) return 0;
    const done = join(this.dir, 'legacy');
    mkdirSync(done, { recursive: true });
    let n = 0;
    for (const f of files) {
      const batch: StoredEvent[] = [];
      const rl = createInterface({ input: createReadStream(join(this.dir, f)), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as StoredEvent;
          if (typeof e.t !== 'string' || typeof e.sid !== 'string') continue;
          e.site = siteFor(String(e.site || 'unknown'));
          batch.push(e);
          if (batch.length >= 2000) (this.append(batch), (n += batch.length), (batch.length = 0));
        } catch {}
      }
      this.append(batch);
      n += batch.length;
      renameSync(join(this.dir, f), join(done, f));
    }
    return n;
  }
}
