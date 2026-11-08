import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// Loaded at runtime: bundlers and Vite don't all know the prefix-only `node:sqlite` builtin yet.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncT;

/**
 * Schema versions, applied in order and recorded in `PRAGMA user_version`.
 * Never edit a shipped step: append a new one.
 */
const MIGRATIONS = [
  `CREATE TABLE sites (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     domains TEXT NOT NULL DEFAULT '[]',
     keys TEXT NOT NULL DEFAULT '[]',
     config TEXT NOT NULL DEFAULT '{}',
     retention_days INTEGER,
     paused INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     site TEXT NOT NULL,
     at INTEGER NOT NULL,
     vid TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL
   );
   CREATE INDEX events_site_at ON events (site, at);
   CREATE INDEX events_vid ON events (vid);
   CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL COLLATE NOCASE UNIQUE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     ip TEXT NOT NULL DEFAULT '',
     ua TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX sessions_user ON sessions (user_id);
   CREATE INDEX sessions_expires ON sessions (expires_at);`,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const v = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let i = v; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function meta(db: Db, k: string): string | undefined;
export function meta(db: Db, k: string, v: string): void;
export function meta(db: Db, k: string, v?: string) {
  if (v === undefined) return (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
}
