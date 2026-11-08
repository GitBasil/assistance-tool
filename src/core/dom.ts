import type { Config } from './config';

export const UI_ATTR = 'data-assist-ui';
export const INTERACTIVE =
  'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[onclick],input,select,textarea,label,summary,[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
export const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea';

export const device = () => (innerWidth < 640 ? 'm' : innerWidth < 1024 ? 't' : 'd');
export const isOurs = (n: Node | null): boolean => {
  const el = n as Element;
  if (!el?.closest) return false;
  if (el.closest(`[${UI_ATTR}]`)) return true;
  const host = (el.getRootNode?.() as ShadowRoot)?.host;
  return !!host && isOurs(host);
};

export function ignored(cfg: Config, el: Element | null): boolean {
  if (!el || isOurs(el) || el.closest('[data-assist-ignore]')) return true;
  for (const s of cfg.ignore)
    try {
      if (el.closest(s)) return true;
    } catch {}
  return false;
}

export const formOf = (el: Element): Element | null =>
  (el as HTMLInputElement).form || el.closest('form,[role=form]');
