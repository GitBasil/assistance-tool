import { UI_ATTR } from '../core/dom';

/** querySelectorAll that also descends into open shadow roots. */
export function deepAll(sel: string, root: ParentNode = document, out: Element[] = [], limit = 600): Element[] {
  for (const el of root.querySelectorAll(sel)) {
    if (out.length >= limit) break;
    out.push(el);
  }
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
  let n: Node | null = walker.currentNode;
  let scanned = 0;
  while ((n = walker.nextNode()) && scanned++ < 5000) {
    const sr = (n as Element).shadowRoot;
    if (sr && !(n as Element).hasAttribute(UI_ATTR)) deepAll(sel, sr, out, limit);
  }
  return out;
}
