import type { Config } from './config';
import type { Bus } from './bus';
import type { Frustration } from './frustration';

/** Wire event. Keys are deliberately short; see docs/schema in README. */
export interface Ev {
  t: string;
  ts?: number;
  [k: string]: unknown;
}

export interface Session {
  vid: string;
  sid: string;
  pid: string;
  /** analytics recorded for this session (consent + sampling) */
  recording: boolean;
  /** persistent storage allowed (consent) */
  storage: boolean;
  bot: boolean;
  start: number;
  /** Until this time a dashboard is watching live (the bridge answers 202): upload near-instantly. */
  watched?: number;
}

export interface Breadcrumb {
  k: string;
  el?: string;
  ts: number;
}

/** Context handed to every lazily loaded chunk. */
export interface Ctx {
  version: string;
  cfg: Config;
  bus: Bus;
  session: Session;
  frus: Frustration;
  base: string;
  /** True for our own script/chunk URLs, stacks, and bridge requests (never the host site's). */
  own(s?: string): boolean;
  send(ev: Ev): void;
  report(k: string, m: string, x?: Record<string, unknown>): void;
  load<T = any>(name: string): Promise<T>;
  fp(el: Element): string;
  redact(s: string): string;
  guard<F extends (...a: any[]) => any>(fn: F): F;
  crumbs(): Breadcrumb[];
  store: {
    get<T>(k: string, d: T, session?: boolean): T;
    set(k: string, v: unknown, session?: boolean): void;
  };
  /** last time the user typed (ms, performance.now) */
  lastInput(): number;
  keyboardMode(): boolean;
  now(): number;
}

export type Chunk = (ctx: Ctx) => any;
