export interface Funnel {
  name: string;
  steps: string[];
}

export interface Config {
  endpoint: string;
  key: string;
  site: string;
  base: string;
  consent: 'auto' | 'required' | 'none';
  sampleRate: number;
  network: 'observe' | 'wrap' | 'off';
  console: boolean;
  frames: 'top' | 'same-origin';
  /** Mask page text, attributes and field values in snapshots/replay. Off: everything is recorded as-is. */
  mask: boolean;
  features: {
    analytics: boolean;
    heatmaps: boolean;
    errors: boolean;
    forms: boolean;
    vitals: boolean;
    snapshots: boolean;
    /** Pointer, scroll and click replay over the redacted snapshot. Never keystrokes. */
    replay: boolean;
  };
  funnels: Funnel[];
  ignore: string[];
  preload: string[];
  nonce: string;
  remoteConfig: boolean;
  debug: boolean;
  disabled: boolean;
}

export function defaults(): Config {
  return {
    endpoint: '',
    key: '',
    site: location.host,
    base: '',
    consent: 'auto',
    sampleRate: 1,
    network: 'observe',
    console: false,
    frames: 'top',
    mask: false,
    features: {
      analytics: true,
      heatmaps: true,
      errors: true,
      forms: true,
      vitals: true,
      snapshots: true,
      replay: true,
    },
    funnels: [],
    ignore: [],
    preload: [],
    nonce: '',
    remoteConfig: true,
    debug: false,
    disabled: false,
  };
}

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge; arrays and scalars replace. Unknown keys are kept (forward compat). */
export function merge<T>(base: T, ...over: any[]): T {
  const out: any = isObj(base) ? { ...base } : base;
  for (const o of over) {
    if (!isObj(o)) continue;
    for (const k of Object.keys(o)) {
      if (o[k] === undefined || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = isObj(out[k]) && isObj(o[k]) ? merge(out[k], o[k]) : o[k];
    }
  }
  return out;
}

const ALL = ['analytics', 'heatmaps', 'errors', 'forms', 'vitals', 'snapshots', 'replay'] as const;

/** Read `data-*` attributes from the script tag. */
export function fromScript(s: HTMLScriptElement | null): Partial<Config> {
  if (!s) return {};
  const d = s.dataset;
  const c: any = {};
  if (d.endpoint) c.endpoint = d.endpoint;
  if (d.key) c.key = d.key;
  if (d.site) c.site = d.site;
  if (d.consent) c.consent = d.consent;
  if (d.sampleRate) c.sampleRate = +d.sampleRate;
  if (d.network) c.network = d.network;
  if (d.nonce || s.nonce) c.nonce = d.nonce || s.nonce;
  if (d.preload) c.preload = d.preload.split(',').map((x) => x.trim());
  if (d.debug != null) c.debug = d.debug !== 'false';
  if (d.mask != null) c.mask = d.mask !== 'false';
  if (d.features) {
    const on = d.features.split(',').map((x) => x.trim());
    c.features = {};
    for (const f of ALL) c.features[f] = on.includes(f);
  }
  return c;
}

/** Validate & coerce; returns a list of warnings (shown in debug mode). */
export function validate(c: Config): string[] {
  const w: string[] = [];
  if (!(c.sampleRate >= 0 && c.sampleRate <= 1)) {
    w.push('sampleRate must be 0..1');
    c.sampleRate = 1;
  }
  if (!['auto', 'required', 'none'].includes(c.consent)) {
    w.push('consent must be auto|required|none');
    c.consent = 'auto';
  }
  for (const k of ['funnels', 'ignore', 'preload'] as const)
    if (!Array.isArray(c[k])) {
      w.push(k + ' must be an array');
      (c as any)[k] = [];
    }
  c.endpoint = c.endpoint.replace(/\/+$/, '');
  return w;
}
