// Footsteps dashboard. All collected data is hostile input: every string is rendered
// with textContent / attributes only, never as HTML. Snapshots render inside a
// script-less sandboxed iframe.

const $ = (s, r = document) => r.querySelector(s);
/** Resolved on each use — the login page has no `#main` until after sign-in. */
const mainEl = () => $('#main');
/** `site` is a site id; `sites` the registry with headline numbers; `range` the report window. */
const state = { site: '', sites: [], token: '', meta: null, user: null, range: localStorage.getItem('assist-range') || '7d' };

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

class AuthRequired extends Error {
  constructor() {
    super('Sign in required.');
  }
}

async function api(path, params = {}, method = 'GET', body) {
  const q = new URLSearchParams({ site: state.site, range: state.range === 'all' ? '' : state.range, ...params });
  const init = { method, credentials: 'same-origin' };
  if (body !== undefined) Object.assign(init, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  let r;
  try {
    r = await fetch(`/api/${path}?${q}`, init);
  } catch {
    throw new Error('Could not reach the server. Check that it is running.');
  }
  if (r.status === 401 && path !== 'auth/login') throw new AuthRequired();
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// ---------------- feedback: toasts, confirm, copy ----------------
function toast(text, kind = 'ok') {
  const box = $('#toasts');
  if (!box) return;
  for (const old of box.children) if (old.textContent === text) old.remove();
  const t = el('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, el('span', { text }));
  box.append(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 2600);
  setTimeout(() => t.remove(), kind === 'error' ? 6400 : 3000);
}

/** Modal confirmation. `typed`: the user must type this text first (for destructive actions). */
function confirmDialog({ title, body, action = 'Confirm', danger = false, typed = '' }) {
  return new Promise((resolve) => {
    const input = typed ? el('input', { 'aria-label': `Type ${typed} to confirm`, autocomplete: 'off', spellcheck: 'false' }) : null;
    const go = el('button', { type: 'submit', class: danger ? 'danger' : 'primary', text: action, disabled: !!typed });
    input?.addEventListener('input', () => (go.disabled = input.value.trim() !== typed));
    const d = el(
      'dialog',
      { class: 'modal' },
      el(
        'form',
        { method: 'dialog' },
        el('h2', { text: title }),
        el('p', { text: body }),
        typed ? el('label', { class: 'field' }, el('span', {}, 'Type ', el('strong', { text: typed }), ' to confirm'), input) : null,
        el('div', { class: 'modal-actions' }, el('button', { type: 'button', text: 'Cancel', onclick: () => d.close('') }), go),
      ),
    );
    d.addEventListener('close', () => {
      resolve(d.returnValue !== '' && d.returnValue !== 'cancel');
      d.remove();
    });
    go.value = 'ok';
    document.body.append(d);
    d.showModal();
    (input || go).focus();
  });
}

function copyBtn(getText, label = 'Copy') {
  const b = el('button', { type: 'button', class: 'copy', text: label });
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(typeof getText === 'function' ? getText() : getText);
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = label), 1500);
    } catch {
      toast('Copy failed: select the text and copy it by hand.', 'error');
    }
  });
  return b;
}

const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};
const STATUS = {
  active: ['good', 'Receiving data'],
  quiet: ['ended', 'No data in 24 h'],
  waiting: ['warn', 'Waiting for first event'],
  paused: ['ended', 'Paused'],
};
const statusBadge = (s) => el('span', { class: 'badge ' + STATUS[s.status][0], text: STATUS[s.status][1] });
const siteNow = () => state.sites.find((s) => s.id === state.site) || null;
/** A URL for one of the site's pages: the first concrete domain, https unless it's local. */
const siteOrigin = (s) => {
  const d = (s?.domains || []).find((x) => !x.includes('*')) || '';
  return d ? (/^(localhost|127\.|\[)/.test(d) ? 'http://' : 'https://') + d : '';
};
async function loadSites() {
  state.sites = await api('sites');
  renderSwitcher();
}

const fmt = (n) => (n == null ? '—' : typeof n === 'number' ? n.toLocaleString() : String(n));
const ms = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms');
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const fpName = (fp) => {
  const [sel, role, name] = String(fp || '').split('|');
  return name ? `${role || 'element'} “${name}”` : sel || '(page)';
};
/** Last path segment, as a short page name: `/console/dispatch` becomes "Dispatch". */
const pageLabel = (u) => {
  let seg = '';
  try {
    seg = decodeURIComponent(String(u || '').split(/[?#]/)[0]).split('/').filter(Boolean).pop() || '';
  } catch {
    seg = '';
  }
  if (!seg) return '';
  return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(And|Of|The|A|On|To)\b/g, (w) => w.toLowerCase());
};
/** What a manager should read first: who, where, and whether they got stuck. */
function reasonOf(s) {
  const who = s.name || s.email || 'This visitor';
  const events = s.timeline || [];
  const stuck = [...events].reverse().find((e) => e.t === 'f');
  const failed = [...events].reverse().find((e) => e.t === 'err');
  const where = pageLabel((stuck || failed || {}).u || s.pages?.[s.pages.length - 1]);
  const on = where ? ' on ' + where : '';
  const f = Math.round(s.frus || 0);
  const n = s.errors || 0;
  if (f) return `${who} got stuck${on}. Frustration ${f}${n ? `, ${n} ${n === 1 ? 'error' : 'errors'}` : ''}.`;
  if (n) return `${who} hit ${n} ${n === 1 ? 'error' : 'errors'}${on}.`;
  return `${who} browsed${on} with no scored struggle.`;
}
/** What a recording keeps. Masked sites keep no field values; passwords are never kept. */
const maskFacts = (masked) => (masked ? 'Text is masked and field values are not kept. ' : 'Typed values are visible. ') + 'Passwords are never captured.';
const recordingFacts = (masked) => 'Recorded on this Footsteps server. Pointer and clicks over a redacted page. ' + maskFacts(masked);
const fpCell = (fp) => el('td', {}, el('div', { text: fpName(fp) }), el('div', { class: 'fp muted', text: String(fp || '').split('|')[0] }));
const card = (k, v, d, onclick) => el('div', { class: 'card' + (onclick ? ' click' : ''), onclick, title: onclick ? 'Open' : '' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: fmt(v) }), d ? el('div', { class: 'd', text: d }) : null);
/** Open the session recording paused at this moment. */
const openAt = (at) => {
  if (!at?.sid) return false;
  go('sessions', { sid: at.sid, pid: at.pid, ts: at.ts });
  return true;
};
const bar = (pct, color) => el('div', { class: 'bar' }, el('i', { style: { width: Math.max(0, Math.min(100, pct || 0)) + '%', background: color || '' } }));
const empty = (t) => el('div', { class: 'empty', text: t });
function table(cols, rows, onRow) {
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.num ? 'num' : '', text: c.h })))),
    el(
      'tbody',
      {},
      rows.map((r) =>
        el(
          'tr',
          { class: onRow ? 'click' : '', onclick: onRow ? () => onRow(r) : null },
          cols.map((c) => {
            const v = c.v(r);
            return v instanceof Node && v.tagName === 'TD' ? v : el('td', { class: c.num ? 'num' : '' }, v instanceof Node ? v : fmt(v));
          }),
        ),
      ),
    ),
  );
}
/** A paged list with all its rows known up front. */
const pagedRows = (key, rows, build, opts) => {
  const p = paged(key, build, opts);
  p.setRows(rows);
  return p;
};
/** Page and rows-per-page of each paged list, kept across live refreshes and visits. */
const pagedState = new Map();
/**
 * A list that pages instead of scrolling: shows as many rows as fit on the screen under
 * whatever sits above it, with ‹ 1 2 3 › underneath. `build(slice)` draws one page.
 * Feed it with `.setRows(rows, resetPage)`; `.repaint()` redraws (for rows that change height).
 */
function paged(key, build, { max = 100, min = 3, rowH = 48, above = 420 } = {}) {
  let st = pagedState.get(key);
  if (!st) pagedState.set(key, (st = { page: 0, size: 0 }));
  if (!st.size) st.size = Math.max(min, Math.min(max, Math.floor((innerHeight - above) / rowH)));
  let rows = [];
  const body = el('div', { class: 'paged-body' });
  const bar = el('div', { class: 'pager' });
  const box = el('div', { class: 'paged' }, body, bar);
  const overflow = () => document.documentElement.scrollHeight - innerHeight;
  const paint = () => {
    const pages = Math.max(1, Math.ceil(rows.length / st.size));
    st.page = Math.min(st.page, pages - 1);
    const from = st.page * st.size;
    const slice = rows.slice(from, from + st.size);
    body.replaceChildren(build(slice));
    const to = (n) => ((st.page = n), paint(), fit());
    const nums = [...new Set([0, st.page - 1, st.page, st.page + 1, pages - 1])].filter((n) => n >= 0 && n < pages).sort((a, b) => a - b);
    const buttons = [];
    nums.forEach((n, i) => {
      if (i && n - nums[i - 1] > 1) buttons.push(el('span', { class: 'gap', text: '…' }));
      buttons.push(el('button', { type: 'button', class: 'pg', 'aria-current': n === st.page ? 'page' : null, 'aria-label': 'Page ' + (n + 1), text: String(n + 1), onclick: () => to(n) }));
    });
    bar.hidden = !rows.length;
    bar.replaceChildren(
      el('span', { class: 'muted small', text: rows.length ? (pages > 1 ? `Showing ${from + 1}–${from + slice.length} of ${fmt(rows.length)}` : `${fmt(rows.length)} in total`) : '' }),
      ...(pages > 1 ? [el('div', { class: 'pg-group' }, el('button', { type: 'button', class: 'pg', disabled: st.page === 0, text: '‹ Prev', onclick: () => to(st.page - 1) }), ...buttons, el('button', { type: 'button', class: 'pg', disabled: st.page >= pages - 1, text: 'Next ›', onclick: () => to(st.page + 1) }))] : []),
    );
  };
  // Shrink until the dashboard stops scrolling, then grow while another row still fits.
  const fit = () => {
    if (!box.isConnected) return;
    let guard = 40;
    while (overflow() > 0 && st.size > min && guard--) (st.size--, paint());
    while (guard-- > 0 && st.size < Math.min(max, rows.length)) {
      st.size++;
      paint();
      if (overflow() > 0) {
        st.size--;
        paint();
        break;
      }
    }
  };
  const onResize = () => (box.isConnected ? fit() : removeEventListener('resize', onResize));
  addEventListener('resize', onResize);
  box.setRows = (r, reset) => {
    rows = r;
    if (reset) st.page = 0;
    paint();
    fit();
  };
  box.repaint = () => (paint(), fit());
  // Redraw and land on the page holding row `i` (rows that grow or shrink change the page size).
  box.reveal = (i) => {
    for (let n = 0; n < 4; n++) {
      st.page = Math.max(0, Math.floor(i / st.size));
      paint();
      fit();
      if (Math.floor(i / st.size) === st.page) break;
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(fit));
  return box;
}
function spark(points, key, color) {
  if (points.length < 2) return el('div', { class: 'empty', text: points.length ? `${fmt(points[0][key])} today — the trend appears after a second day of data.` : 'No data yet.' });
  const s = svgEl('svg', { class: 'spark', viewBox: '0 0 300 80', preserveAspectRatio: 'none', role: 'img', 'aria-label': key + ' trend' });
  const max = Math.max(1, ...points.map((p) => p[key]));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(i / (points.length - 1)) * 300},${75 - (p[key] / max) * 68}`).join(' ');
  s.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
  return s;
}
const livePill = (text) => el('span', { class: 'live-pill' }, el('i'), el('span', { text }));
/**
 * Page header. Above the title: `crumbs` ([label, view, params] or plain text), else the site's name
 * on site pages. `status` sits beside the title; `actions` on the right, where render() also puts
 * the date range; `facts` ([label, value, title?]) is a strip of key numbers underneath.
 */
function header(title, sub, { crumbs, status, actions = [], facts } = {}) {
  const site = GLOBAL.has(currentView()) ? null : siteNow();
  const trail = crumbs || (site ? [site.name] : []);
  const nav = trail.length
    ? el(
        'nav',
        { class: 'ph-crumbs', 'aria-label': 'Breadcrumb' },
        trail.map((c, i) => [
          i ? el('span', { class: 'ph-sep', 'aria-hidden': 'true', text: '/' }) : null,
          Array.isArray(c) ? el('a', { href: '#' + c[1], onclick: (e) => (e.preventDefault(), go(c[1], c[2] || {})), text: c[0] }) : el('span', { text: c }),
        ]),
      )
    : null;
  return [
    el(
      'header',
      { class: 'ph' },
      el('div', { class: 'ph-row' }, el('div', { class: 'ph-main' }, nav, el('div', { class: 'ph-title' }, el('h1', { text: title }), status || null), sub ? el('p', { class: 'sub', text: sub }) : null), el('div', { class: 'ph-actions' }, actions)),
      facts ? factStrip(facts) : null,
    ),
  ];
}
const factStrip = (facts) =>
  el(
    'dl',
    { class: 'facts' },
    facts.filter(Boolean).map(([k, v, title]) => el('div', { class: 'fact', title: title || null }, el('dt', { text: k }), el('dd', {}, v instanceof Node ? v : fmt(v)))),
  );
/** 39s, 4m 05s, 1h 22m. */
const dur = (n) => {
  const s = Math.max(0, Math.round((n || 0) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm';
};
/** Today 12:47 PM, Yesterday 9:03 AM, Nov 3 4:10 PM (year only when it differs). */
const dayTime = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return 'Today ' + time;
  if (today - day === 86_400_000) return 'Yesterday ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }) + ' ' + time;
};
const DEVICE = { d: 'Desktop', t: 'Tablet', m: 'Mobile' };
const frusLevel = (n) => (Math.round(n) > 120 ? 'bad' : Math.round(n) > 50 ? 'warn' : 'good');
/** Per-element or per-page score (one signal is 10-25). */
const scoreLevel = (n) => (n >= 30 ? 'bad' : n >= 12 ? 'warn' : 'good');
const level = (kind, text) => el('span', { class: 'level ' + kind }, el('i'), el('span', { text }));
/** Sessions list filter; kept across the list's live re-renders. */
const sess = { status: 'all', dev: '', q: '', rec: false, sort: 'recent' };
/** People search, kept while the list refreshes. */
let peopleQ = '';
/** The name form on a person's page stays open across a live refresh. */
let editingWho = false;
const personName = (r) => r.name || r.email || 'Anonymous visitor';
/** One line describing something a person did. */
function actText(e) {
  const say = {
    pv: 'Opened ' + (e.u || 'a page'),
    c: 'Clicked ' + fpName(e.el),
    f: SIGNAL[e.k]?.[0] || e.k || 'Frustration',
    err: 'Error: ' + (e.m || 'unknown'),
    frm: 'Form ' + (e.a || ''),
    cu: 'Tracked “' + (e.n || '') + '”',
    bye: 'Left the site',
    coach: 'Coach ' + (e.a || ''),
    tour: 'Tour ' + (e.a || ''),
    ask: 'Asked for help',
    act: (e.ok ? 'Did ' : 'Blocked ') + (e.a || 'an action'),
  };
  return say[e.t] || e.t;
}
/** One person's visits and everything they did, plus a name and email you can set here. */
async function personPage(vid) {
  const d = await api('person/' + encodeURIComponent(vid));
  const named = d.name || d.email;
  const form = el('form', { class: 'id-form', hidden: !editingWho });
  const name = el('input', { value: d.name, placeholder: 'Name', maxlength: '80', 'aria-label': 'Name' });
  const email = el('input', { type: 'email', value: d.email, placeholder: 'Email', maxlength: '120', 'aria-label': 'Email' });
  const err = el('span', { class: 'form-error' });
  form.append(name, email, el('button', { type: 'submit', class: 'primary', text: 'Save' }), el('button', { type: 'button', text: 'Cancel', onclick: () => ((editingWho = false), render()) }), err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('people', {}, 'POST', { vid: d.vid, name: name.value.trim(), email: email.value.trim() });
      editingWho = false;
      toast(name.value.trim() || email.value.trim() ? 'Saved. Future visits from this browser keep the name.' : 'Name removed.');
      render();
    } catch (x) {
      err.textContent = x.message;
    }
  });
  const sessions = paged('person-sessions', (slice) => (slice.length ? sessTable(slice, new Map(), true) : empty('No visits stored.')), { max: 6, rowH: 53, above: 360 });
  sessions.setRows(d.sessions);
  const activity = pagedRows('person-activity', d.activity, (slice) =>
    slice.length
      ? table(
          [
            { h: 'When', v: (r) => el('td', { class: 'nowrap', text: dayTime(r.at) }) },
            { h: 'What they did', v: (r) => el('td', {}, el('div', { class: 'cell-main', text: actText(r) }), r.t !== 'pv' && r.u ? el('div', { class: 'cell-sub', text: r.u }) : null) },
          ],
          slice,
          (r) => openAt(r),
        )
      : empty('Nothing recorded for this person yet.'),
    { rowH: 48, above: 560 },
  );
  return [
    ...header(personName(d), named ? 'Every visit stored for this person. Click one to watch it, or a row below to jump to that moment.' : 'No name yet. Add one here, or set data-who on the script tag.', {
      crumbs: [siteNow()?.name, ['People', 'people'], personName(d)].filter(Boolean),
      status: d.sessions.some((r) => r.live) ? livePill('Active now') : null,
      actions: [el('button', { type: 'button', text: named ? 'Edit name' : 'Add name', onclick: () => ((editingWho = true), render()) })],
    }),
    form,
    factStrip([
      ['Sessions', d.sessions.length],
      ['First seen', d.sessions.length ? dayTime(Math.min(...d.sessions.map((r) => r.start))) : '—'],
      ['Last seen', d.sessions.length ? dayTime(Math.max(...d.sessions.map((r) => r.end))) : '—'],
      ['Frustration', d.sessions.reduce((n, r) => n + r.frus, 0)],
      ['Errors', d.sessions.reduce((n, r) => n + r.errors, 0)],
      ['Visitor id', el('span', { class: 'who' }, el('code', { text: d.vids.join(', ') }), copyBtn(d.vid, 'Copy'))],
    ]),
    el('div', { class: 'perf-head' }, el('h2', { text: 'Visits' })),
    sessions,
    el('div', { class: 'perf-head' }, el('h2', { text: 'What they did' }), el('span', { class: 'muted small', text: 'Newest first. Click a row to watch that moment.' })),
    activity,
  ];
}
/** One page of the sessions list. */
function sessTable(slice, visitCount, timeFirst = false) {
  if (!slice.length) return empty('No sessions match these filters.');
  return table(
    [
      { h: 'Started', v: (r) => el('td', {}, el('div', { class: 'cell-main', text: timeFirst ? dayTime(r.start) : r.name || r.email || dayTime(r.start) }), el('div', { class: 'muted cell-sub', text: (!timeFirst && (r.name || r.email) ? dayTime(r.start) + ' · ' : '') + (DEVICE[r.dev] || r.dev || 'Unknown device') + (r.email && r.name && !timeFirst ? ' · ' + r.email : '') + (!r.name && !r.email && r.vid ? ' · visitor ' + r.vid.slice(0, 8) : '') + (r.vid && visitCount.get(r.vid) > 1 ? ` · ${visitCount.get(r.vid)} visits` : '') })) },
      { h: 'Status', v: (r) => (r.live ? livePill('Active now') : el('span', { class: 'muted', text: 'Ended' })) },
      { h: 'Duration', v: (r) => dur(r.end - r.start), num: 1 },
      { h: 'Recording', v: (r) => (r.replayMs ? clock(r.replayMs) : '—'), num: 1 },
      { h: 'Pages', v: (r) => r.pages, num: 1 },
      { h: 'Clicks', v: (r) => r.clicks, num: 1 },
      { h: 'Frustration', num: 1, v: (r) => el('td', { class: 'num' }, r.frus ? el('span', { class: 'badge ' + (frusLevel(r.frus) === 'good' ? '' : frusLevel(r.frus)), text: r.frus }) : el('span', { class: 'muted', text: '0' })) },
      { h: 'Errors', num: 1, v: (r) => el('td', { class: 'num' }, r.errors ? el('span', { class: 'badge bad', text: r.errors }) : el('span', { class: 'muted', text: '0' })) },
    ],
    slice,
    (r) => go('sessions', { sid: r.sid }),
  );
}
/** People whose visits are shown open in the sessions list; kept across live refreshes. */
const sessOpen = new Set();
/** Visits listed under an open person before the rest are left to their own page. */
const SESS_SHOWN = 8;
/** The sessions list: one row per person, each opening to their visits. */
function sessGroupTable(groups, repaint) {
  if (!groups.length) return empty('No sessions match these filters.');
  const who = (g) => g.name || g.email || 'Anonymous visitor';
  const body = el('tbody');
  for (const g of groups) {
    const many = g.sessions.length > 1;
    const open = many && sessOpen.has(g.key);
    const last = g.sessions[0];
    const sub = [g.name && g.email ? g.email : !g.name && !g.email ? 'Visitor ' + String(g.vid || '').slice(0, 8) : '', [...g.devs].map((d) => DEVICE[d] || d).join(', ')].filter(Boolean).join(' · ');
    body.append(
      el(
        'tr',
        { class: 'click' + (open ? ' open' : ''), 'aria-expanded': many ? String(open) : null, title: many ? 'Show their visits' : 'Watch this visit', onclick: () => (many ? (open ? sessOpen.delete(g.key) : sessOpen.add(g.key), repaint(g.key)) : go('sessions', { sid: last.sid })) },
        el('td', {}, el('div', { class: 'route' }, many ? el('span', { class: 'chev', text: open ? '▾' : '▸' }) : el('span', { class: 'chev' }), el('div', { class: 'who-cell' }, el('div', { class: 'cell-main', text: who(g) }), el('div', { class: 'muted cell-sub', text: sub })), many ? el('span', { class: 'badge', text: `${g.sessions.length} visits` }) : null)),
        el('td', {}, el('div', { class: 'cell-main', text: dayTime(g.last) }), el('div', { class: 'cell-sub' }, g.live ? livePill('Active now') : el('span', { class: 'muted', text: 'Ended' }))),
        el('td', { class: 'num', text: dur(g.time) }),
        el('td', { class: 'num', text: g.recs ? `${g.recs} of ${g.sessions.length}` : '—' }),
        el('td', { class: 'num', text: g.pages }),
        el('td', { class: 'num', text: g.clicks }),
        el('td', { class: 'num' }, g.frus ? el('span', { class: 'badge ' + (frusLevel(g.frus) === 'good' ? '' : frusLevel(g.frus)), text: Math.round(g.frus) }) : el('span', { class: 'muted', text: '0' })),
        el('td', { class: 'num' }, g.errors ? el('span', { class: 'badge bad', text: g.errors }) : el('span', { class: 'muted', text: '0' })),
      ),
    );
    if (!open) continue;
    for (const r of g.sessions.slice(0, SESS_SHOWN))
      body.append(
        el(
          'tr',
          { class: 'variant click', title: 'Watch this visit', onclick: () => go('sessions', { sid: r.sid }) },
          el('td', {}, el('div', { class: 'cell-main', text: dayTime(r.start) }), el('div', { class: 'muted cell-sub', text: DEVICE[r.dev] || r.dev || 'Unknown device' })),
          el('td', {}, r.live ? livePill('Active now') : el('span', { class: 'muted', text: 'Ended' })),
          el('td', { class: 'num', text: dur(r.end - r.start) }),
          el('td', { class: 'num', text: r.replayMs ? clock(r.replayMs) : '—' }),
          el('td', { class: 'num', text: r.pages }),
          el('td', { class: 'num', text: r.clicks }),
          el('td', { class: 'num' }, r.frus ? el('span', { class: 'badge ' + (frusLevel(r.frus) === 'good' ? '' : frusLevel(r.frus)), text: r.frus }) : el('span', { class: 'muted', text: '0' })),
          el('td', { class: 'num' }, r.errors ? el('span', { class: 'badge bad', text: r.errors }) : el('span', { class: 'muted', text: '0' })),
        ),
      );
    const more = g.sessions.length - SESS_SHOWN;
    body.append(
      el(
        'tr',
        { class: 'variant click', onclick: () => go('people', { vid: g.vid }) },
        el('td', { colspan: '8' }, el('span', { class: 'link', text: more > 0 ? `${more} older ${more === 1 ? 'visit' : 'visits'} and everything they did →` : 'Everything this person did →' })),
      ),
    );
  }
  const head = ['Person', 'Last seen', 'Time on site', 'Recordings', 'Pages', 'Clicks', 'Frustration', 'Errors'];
  return el('table', { class: 'perf sess-grp' }, el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { class: i > 1 ? 'num' : '', text: h })))), body);
}
/** Closes the visitor-history popover when the click lands outside it. */
let visitCloser = null;
const clock = (n) => {
  const s = Math.max(0, Math.round((n || 0) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const snapCache = new Map();
/** Replay frames by content hash. They never change, so this cache is never invalidated. */
const frameCache = new Map();

/**
 * A replay frame is a document in an iframe, and browsers paint native form controls
 * there with the old beveled edge even when the page set a plain border. Lock the
 * border the page computed, for controls that aren't actually using that bevel.
 */
function flattenControls(doc) {
  if (!doc) return;
  for (const el of doc.querySelectorAll('input, textarea, select, button, fieldset')) {
    const cs = doc.defaultView.getComputedStyle(el);
    if (/inset|outset|groove|ridge/.test(cs.borderStyle) || el.style.appearance === 'none') continue;
    const border = cs.border;
    const radius = cs.borderRadius;
    const bg = cs.backgroundColor;
    const pad = cs.padding;
    el.style.setProperty('appearance', 'none');
    el.style.setProperty('-webkit-appearance', 'none');
    el.style.border = border;
    el.style.borderRadius = radius;
    el.style.backgroundColor = bg;
    el.style.padding = pad;
    if (el.tagName === 'SELECT' && (!cs.backgroundImage || cs.backgroundImage === 'none')) {
      el.style.backgroundImage = 'linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%)';
      el.style.backgroundPosition = 'right 10px center, right 6px center';
      el.style.backgroundSize = '4px 4px, 4px 4px';
      el.style.backgroundRepeat = 'no-repeat';
    }
  }
}

const nodeKey = (n) => n.getAttribute('id') || n.getAttribute('data-assist-fp') || '';
const sameNode = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.nodeName === b.nodeName && nodeKey(a) === nodeKey(b)));

/**
 * Turns the live replay document into the next frame in place, so a dialog opening or a
 * row changing doesn't reload the whole page (images, fonts, animations, scroll).
 */
function morph(from, to, doc) {
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
  for (const a of to.attributes) {
    if (from.getAttribute(a.name) === a.value) continue;
    try {
      from.setAttribute(a.name, a.value);
    } catch {}
  }
  let a = from.firstChild;
  for (let b = to.firstChild; b; b = b.nextSibling) {
    if (!a) {
      from.appendChild(doc.importNode(b, true));
      continue;
    }
    if (!sameNode(a, b)) {
      let m = a.nextSibling;
      for (let i = 0; m && i < 8 && !sameNode(m, b); i++) m = m.nextSibling;
      if (!m || !sameNode(m, b)) {
        from.insertBefore(doc.importNode(b, true), a);
        continue;
      }
      while (a !== m) {
        const n = a.nextSibling;
        a.remove();
        a = n;
      }
    }
    morph(a, b, doc);
    a = a.nextSibling;
  }
  while (a) {
    const n = a.nextSibling;
    a.remove();
    a = n;
  }
}

/**
 * Plays a session over its redacted snapshot: pointer path, scroll and clicks.
 * `ts` restarts on every page, so each page is its own segment of the tape.
 */
function recordingPlayer(rec, marks, alive, onTime, opts = {}) {
  if (!rec?.pages?.length) return el('div', { class: 'player' }, empty(opts.live ? 'Waiting for this visitor to move, scroll or click…' : 'No recording for this session.'));
  let g = 0;
  let playing = false;
  let speed = 1;
  let scrubbing = false;
  let last = 0;
  let raf = 0;
  let shown = '';
  let clickAt = -1;
  let liveOn = !!opts.live;
  let pages, total, moves, scrolls, clicks, inputs, boxScrolls, frames, baseOf, dots, idleSpans;
  const byPid = (list) => {
    const m = new Map();
    for (const pt of list || []) {
      if (!m.has(pt.pid)) m.set(pt.pid, []);
      m.get(pt.pid).push(pt);
    }
    return m;
  };
  const gOf = (pid, ts) => {
    if (!baseOf.has(pid)) return null;
    const seg = pages.find((p) => p.pid === pid);
    return baseOf.get(pid) + Math.max(0, Math.min(Number(ts) || 0, seg.dur));
  };
  // Everything derived from the recording. Re-run when a live session sends more.
  function ingest(r, mk) {
    pages = r.pages;
    total = pages.reduce((s, p) => s + p.dur, 0);
    moves = byPid(r.moves);
    scrolls = byPid(r.scrolls);
    clicks = byPid(r.clicks);
    inputs = byPid(r.inputs);
    boxScrolls = byPid(r.boxScrolls);
    frames = byPid(r.frames);
    for (const list of frames.values()) list.sort((a, b) => a.ts - b.ts);
    baseOf = new Map();
    let acc = 0;
    for (const seg of pages) {
      baseOf.set(seg.pid, acc);
      acc += seg.dur;
    }
    dots = [];
    for (const m of mk || []) {
      const atg = gOf(m.pid, m.ts);
      if (atg != null) dots.push({ ...m, g: atg });
    }
    if (!dots.some((d) => d.kind === 'click')) {
      for (const c of r.clicks || []) {
        const atg = gOf(c.pid, c.ts);
        if (atg != null) dots.push({ g: atg, kind: 'click', label: 'Click' });
      }
    }
    const activity = [0, total];
    const pushAct = (pid, ts) => {
      const atg = gOf(pid, ts);
      if (atg != null) activity.push(atg);
    };
    for (const pt of r.moves || []) pushAct(pt.pid, pt.ts);
    for (const pt of r.scrolls || []) pushAct(pt.pid, pt.ts);
    for (const pt of r.inputs || []) pushAct(pt.pid, pt.ts);
    for (const pt of r.frames || []) pushAct(pt.pid, pt.ts);
    for (const pt of r.boxScrolls || []) pushAct(pt.pid, pt.ts);
    for (const d of dots) activity.push(d.g);
    activity.sort((a, b) => a - b);
    idleSpans = [];
    for (let i = 1; i < activity.length; i++) {
      if (activity[i] - activity[i - 1] >= 3000) idleSpans.push({ from: activity[i - 1] + 1200, to: activity[i] });
    }
  }
  ingest(rec, marks);
  const at = (ms) => {
    let acc = 0;
    for (const seg of pages) {
      if (ms < acc + seg.dur) return { seg, ts: ms - acc };
      acc += seg.dur;
    }
    const seg = pages[pages.length - 1];
    return { seg, ts: seg.dur };
  };
  const before = (list, ts) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].ts <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const stage = el('div', { class: 'stage rec-stage' });
  const wrap = el('div', { class: 'rec-wrap' });
  const inner = el('div', { class: 'inner' });
  const mkFrame = () => el('iframe', { sandbox: 'allow-same-origin', title: 'Session recording', referrerpolicy: 'no-referrer' });
  let frame = mkFrame();
  let spare = mkFrame();
  spare.classList.add('spare');
  const cursor = svgEl('svg', { class: 'rec-cursor', viewBox: '0 0 20 22', 'aria-hidden': 'true' });
  cursor.append(svgEl('path', { d: 'M1 1 L1 17 L5.2 13.2 L8.4 20 L11.2 18.7 L8 12 L13.4 12 Z', fill: '#111827', stroke: '#fff', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
  cursor.style.display = 'none';
  const ripple = el('div', { class: 'rec-ripple' });
  const heatCanvas = el('canvas', { class: 'rec-heat', 'aria-hidden': 'true' });
  heatCanvas.style.display = 'none';
  inner.append(frame, spare, heatCanvas, cursor, ripple);
  wrap.append(inner);
  stage.append(wrap);
  const playBtn = el('button', { type: 'button', class: 'primary', text: 'Play' });
  const speeds = [1, 2, 4, 8].map((n) => el('button', { type: 'button', text: n + '×', 'aria-pressed': n === 1, 'aria-label': 'Play at ' + n + ' times speed' }));
  const heatBtn = el('button', { type: 'button', text: 'Heatmap', 'aria-pressed': 'false', title: 'Overlay clicks or pointer movement as heat.' });
  const heatSel = el('select', { 'aria-label': 'Heatmap layer' }, el('option', { value: 'clicks', text: 'Clicks' }), el('option', { value: 'moves', text: 'Moves' }));
  heatSel.hidden = true;
  const heatScopeSel = el(
    'select',
    { 'aria-label': 'Heatmap scope', title: 'Session: only this visitor. All sessions: every visitor on this page.' },
    el('option', { value: 'session', text: 'This session' }),
    el('option', { value: 'all', text: 'All sessions' }),
  );
  heatScopeSel.hidden = true;
  const skipBox = el('input', { type: 'checkbox' });
  skipBox.checked = sessionStorage.getItem('assist-skip-idle') === '1';
  const skipLabel = el('label', { class: 'skip-idle', title: 'While this is on, playback jumps every quiet stretch with no pointer, scroll, clicks, or actions.' }, skipBox, 'Skip idle');
  const range = el('input', { class: 'scrub', type: 'range', min: '0', max: String(total), value: '0', step: '50', 'aria-label': 'Recording position' });
  const marksLayer = el('div', { class: 'scrub-marks' });
  const time = el('span', { class: 'rec-time muted', text: clock(0) + ' / ' + clock(total) });
  const MARK_KIND = { click: ['click', 'clicks'], frus: ['frustration signal', 'frustration signals'], err: ['error', 'errors'], action: ['action', 'actions'] };
  const legend = el('span', { class: 'scrub-legend' });
  // Shown only when a page has no snapshot; otherwise the player says nothing extra.
  const cap = el('p', { class: 'muted rec-cap', hidden: true });
  const liveBtn = el('button', { type: 'button', class: 'live-pill', title: 'Jump to what the visitor is doing right now' }, el('i'), el('span', { text: 'LIVE' }));
  liveBtn.hidden = !liveOn;
  const heatInfo = el('p', { class: 'muted rec-cap' });
  heatInfo.hidden = true;
  const maxIcon = svgEl('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' });
  maxIcon.append(svgEl('path', { d: 'M1 5.5V1.5A.5.5 0 0 1 1.5 1h4M15 5.5v-4a.5.5 0 0 0-.5-.5h-4M1 10.5v4a.5.5 0 0 0 .5.5h4M15 10.5v4a.5.5 0 0 1-.5.5h-4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const maxLabel = el('span', { text: 'Full screen' });
  const maxBtn = el('button', { type: 'button', class: 'rec-max', title: 'Maximize the recording' }, maxIcon, maxLabel);
  const head = el('div', { class: 'rec-head' }, el('strong', { text: 'Recording' }), liveBtn, maxBtn, cap);
  const toolbar = el(
    'div',
    { class: 'rec-toolbar' },
    el('div', { class: 'ctrl-group' }, playBtn, ...speeds),
    el('div', { class: 'ctrl-group' }, heatBtn, heatSel, heatScopeSel),
    el('div', { class: 'ctrl-group' }, skipLabel),
  );
  legend.hidden = !dots.length;
  const scrubRow = el('div', { class: 'scrub-row' }, el('div', { class: 'scrub-wrap' }, range, marksLayer), time, legend);
  const box = el('div', { class: 'player' }, head, stage, toolbar, scrubRow, heatInfo);

  let isMax = false;
  const MAX_SCALE = 2.4;
  const fit = (seg) => {
    // The stage's size comes from the page layout, never from its content, so both
    // dimensions are safe to measure. Upscaling is capped so tiny captures stay legible.
    const availW = stage.clientWidth || seg.w;
    const availH = stage.clientHeight || seg.h;
    const k = Math.min(MAX_SCALE, availW / seg.w, availH / seg.h);
    inner.style.width = seg.w + 'px';
    inner.style.height = seg.h + 'px';
    inner.style.transform = `scale(${k})`;
    wrap.style.width = Math.round(seg.w * k) + 'px';
    wrap.style.height = Math.round(seg.h * k) + 'px';
    for (const f of [frame, spare]) {
      f.setAttribute('width', seg.w);
      f.setAttribute('height', seg.h);
    }
  };
  const scrollTo = (x, y) => {
    try {
      frame.contentWindow?.scrollTo(x, y);
    } catch {}
  };
  let heatOn = false;
  let heatMode = 'clicks';
  let heatScope = 'session';
  let heatFor = '';
  let heatPending = '';
  let heatPts = [];
  let heatKey = '';
  const heatCache = new Map();
  function renderMarks() {
  marksLayer.replaceChildren();
  const have = new Set(dots.map((d) => d.kind));
  legend.replaceChildren(
    ...[
      ['click', 'Clicks'],
      ['frus', 'Frustration'],
      ['err', 'Errors'],
      ['action', 'Actions'],
    ]
      .filter(([k]) => have.has(k))
      .flatMap(([k, t]) => [el('i', { class: k }), t]),
  );
  legend.hidden = !have.size;
  const clustered = [];
  // Group events of the same kind that would land on top of each other. The gap is at
  // least 2.8% of the recording, which is roughly one pill's width on the bar.
  const near = Math.max(600, total * 0.04);
  for (const d of [...dots].sort((a, b) => a.g - b.g)) {
    const prev = clustered[clustered.length - 1];
    if (prev && prev.kind === d.kind && d.g - prev.g <= near) {
      prev.n++;
      if (d.label && prev.extra.length < 3 && !prev.extra.includes(d.label)) prev.extra.push(d.label);
    } else clustered.push({ g: d.g, kind: d.kind, n: 1, extra: d.label ? [d.label] : [] });
  }
  for (const d of clustered) {
    const [one, many] = MARK_KIND[d.kind] || [d.kind, d.kind];
    const title = (d.n > 1 ? d.n + ' ' + many + ' — ' : '') + (d.extra.join(' · ') || one);
    const b = el(
      'button',
      {
        type: 'button',
        class: 'scrub-dot ' + d.kind + (d.n > 1 ? ' many' : ''),
        title,
        'data-g': String(d.g),
        style: { left: (total ? (d.g / total) * 100 : 0) + '%' },
      },
      d.n > 1 ? el('span', { class: 'scrub-count', text: d.n > 99 ? '99+' : String(d.n) }) : el('i', { class: 'mark' }),
      el('span', { class: 'scrub-tip', text: title }),
    );
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      g = d.g;
      last = 0;
      draw();
    });
    b.addEventListener('mouseenter', () => {
      const tip = b.querySelector('.scrub-tip');
      tip.style.transform = 'translateX(-50%)';
      const pad = 8;
      const r = tip.getBoundingClientRect();
      const host = scrubRow.getBoundingClientRect();
      const shift = r.left < host.left + pad ? host.left + pad - r.left : r.right > host.right - pad ? host.right - pad - r.right : 0;
      if (shift) tip.style.transform = `translateX(calc(-50% + ${shift}px))`;
    });
    marksLayer.append(b);
  }
  }
  renderMarks();
  const paintMarks = () => {
    for (const b of marksLayer.children) b.classList.toggle('past', Number(b.dataset.g) <= g);
  };
  function applySkip() {
    if (!skipBox.checked) return;
    let guard = 0;
    while (guard++ < idleSpans.length) {
      const span = idleSpans.find((s) => g >= s.from && g < s.to - 250);
      if (!span) return;
      g = span.to;
    }
  }
  async function ensureHeat(seg) {
    const key = heatScope + '|' + (heatScope === 'session' ? seg.pid : seg.u) + '|' + heatMode;
    if (heatFor === key || heatPending === key) return;
    if (heatScope === 'session') {
      const list = (heatMode === 'moves' ? moves.get(seg.pid) : clicks.get(seg.pid)) || [];
      heatPts = list.map((p) => [p.x, p.y, 1]);
      heatFor = key;
      heatPending = '';
      heatKey = '';
      heatInfo.textContent = heatPts.length ? `Showing ${heatMode} from this session only (${heatPts.length} point${heatPts.length === 1 ? '' : 's'}).` : `No ${heatMode} captured for this session on this page.`;
      if (alive()) draw();
      return;
    }
    heatPending = key;
    let data = heatCache.get(seg.u);
    if (data === undefined) {
      try {
        data = await api('heatmap', { u: seg.u });
      } catch {
        data = null;
      }
      heatCache.set(seg.u, data);
    }
    if (heatPending !== key || !alive()) return;
    const doc = frame.contentDocument;
    const byFp = new Map();
    const byName = new Map();
    if (doc) {
      for (const n of doc.querySelectorAll('[data-assist-fp]')) {
        const fp = n.getAttribute('data-assist-fp');
        byFp.set(fp, n);
        const parts = fp.split('|');
        if (parts[2]) byName.set(parts[1] + '|' + parts[2], n);
      }
    }
    const find = (fp) =>
      byFp.get(fp) ||
      (() => {
        const parts = String(fp).split('|');
        return parts[2] ? byName.get(parts[1] + '|' + parts[2]) : null;
      })();
    if (!data) heatPts = [];
    else if (heatMode === 'moves') heatPts = data.moves.map((m) => [m.x * (seg.w / (m.w || seg.w)), m.y * (seg.w / (m.w || seg.w)), m.n]);
    else
      heatPts = (data.clicks || []).map((c) => {
        const n = doc && find(c.el);
        if (n) {
          const r = n.getBoundingClientRect();
          const view = doc.defaultView;
          const left = r.left + view.scrollX;
          const top = r.top + view.scrollY;
          return [left + (c.rx / 1000) * r.width, top + (c.ry / 1000) * r.height, 1];
        }
        return [c.x, c.y, 1];
      });
    heatFor = key;
    heatPending = '';
    heatKey = '';
    heatInfo.textContent = heatPts.length ? `Showing ${heatMode} from all sessions on this page (${heatPts.length} point${heatPts.length === 1 ? '' : 's'}).` : `No ${heatMode} recorded for this page yet.`;
    if (alive()) draw();
  }
  function paintHeat(sx, sy, seg) {
    if (!heatOn) {
      heatCanvas.style.display = 'none';
      return;
    }
    heatCanvas.style.display = '';
    if (heatCanvas.width !== seg.w || heatCanvas.height !== seg.h) {
      heatCanvas.width = seg.w;
      heatCanvas.height = seg.h;
      heatKey = '';
    }
    const key = heatFor + '|' + sx + '|' + sy + '|' + seg.w;
    if (key === heatKey) return;
    heatKey = key;
    const ctx2 = heatCanvas.getContext('2d');
    ctx2.clearRect(0, 0, seg.w, seg.h);
    const pts = heatPts.map(([x, y, n]) => [x - sx, y - sy, n]).filter(([x, y]) => x > -40 && x < seg.w + 40 && y > -40 && y < seg.h + 40);
    if (pts.length) heat(ctx2, pts, seg.w, seg.h);
  }
  // Which page state the visitor was looking at, at `ts` on this page. Before the
  // first frame we show the first one; without frames, the page's latest snapshot.
  function pickFrame(seg, ts) {
    const list = frames.get(seg.pid);
    if (!list?.length) return null;
    return list[Math.max(0, before(list, ts) - 1)];
  }
  let loadingKey = '';
  const failedAt = new Map();
  async function show(seg, ts) {
    const f = pickFrame(seg, ts);
    const key = f ? 'h:' + f.h : 'u:' + seg.u;
    if (shown === key || loadingKey === key) return;
    // A live frame can be announced a moment before its upload lands; retry, but not every animation frame.
    if (Date.now() - (failedAt.get(key) || 0) < 1000) return;
    loadingKey = key;
    let html = f ? frameCache.get(f.h) : snapCache.get(seg.u);
    if (html == null) {
      try {
        html = (await api('snapshot', f ? { h: f.h } : { u: seg.u })).html || '';
      } catch {
        html = f ? null : '';
      }
      if (html != null) (f ? frameCache : snapCache).set(f ? f.h : seg.u, html);
    }
    if (loadingKey !== key || !alive()) return;
    loadingKey = '';
    if (html == null) return void failedAt.set(key, Date.now());
    shown = key;
    if (!html) {
      cap.textContent = 'No snapshot for this page yet. The pointer still plays on an empty screen.';
      cap.hidden = false;
      return;
    }
    cap.hidden = true;
    const doc = frame.contentDocument;
    if (doc?.body && frame.srcdoc) {
      morph(doc.documentElement, new DOMParser().parseFromString(html, 'text/html').documentElement, doc);
      flattenControls(doc);
      inputKey = '';
      boxKey = '';
      original = new Map();
      draw();
      return;
    }
    const next = spare;
    next.onload = () => {
      next.onload = null;
      if (!alive() || shown !== key) return;
      next.classList.remove('spare');
      frame.classList.add('spare');
      spare = frame;
      frame = next;
      flattenControls(next.contentDocument);
      inputKey = '';
      boxKey = '';
      original = new Map();
      heatFor = '';
      heatPending = '';
      heatKey = '';
      draw();
    };
    next.srcdoc = html;
  }

  // Panels and dialogs scrolled on their own: the latest position before `ts`, or the top.
  let boxKey = '';
  function paintBoxes(seg, ts) {
    const list = boxScrolls.get(seg.pid) || [];
    const doc = frame.contentDocument;
    const n = before(list, ts);
    const key = seg.pid + '|' + n + '|' + list.length;
    if (!doc || !list.length || key === boxKey) return;
    boxKey = key;
    const latest = new Map();
    for (const e of list) if (!latest.has(e.el)) latest.set(e.el, { x: 0, y: 0 });
    for (let i = 0; i < n; i++) latest.set(list[i].el, list[i]);
    for (const [fp, e] of latest) {
      const node = doc.querySelector(`[data-assist-fp="${CSS.escape(fp)}"]`);
      if (node) node.scrollTo(e.x, e.y);
    }
  }

  // Typed values are replayed onto the snapshot's own fields; seeking back restores what the snapshot had.
  let inputKey = '';
  let original = new Map();
  function paintInputs(seg, ts) {
    const list = inputs.get(seg.pid) || [];
    const doc = frame.contentDocument;
    const n = before(list, ts);
    const key = seg.pid + '|' + n + '|' + list.length;
    if (!doc || key === inputKey) return;
    inputKey = key;
    const latest = new Map();
    for (const e of list) if (!latest.has(e.el)) latest.set(e.el, null);
    for (let i = 0; i < n; i++) latest.set(list[i].el, list[i]);
    for (const [fp, e] of latest) {
      const node = doc.querySelector(`[data-assist-fp="${CSS.escape(fp)}"]`);
      if (!node) continue;
      if (!original.has(fp)) original.set(fp, { v: node.value, c: node.checked });
      const o = original.get(fp);
      if (e && typeof e.c === 'boolean') node.checked = e.c;
      else if (e) node.value = e.v;
      else {
        node.value = o.v;
        node.checked = o.c;
      }
    }
  }

  function draw() {
    applySkip();
    const { seg, ts } = at(Math.min(g, total));
    show(seg, ts);
    fit(seg);
    const sc = scrolls.get(seg.pid) || [];
    const si = before(sc, ts);
    const s = si ? sc[si - 1] : null;
    const sx = s ? s.x : 0;
    const sy = s ? s.y : 0;
    scrollTo(sx, sy);
    const mv = moves.get(seg.pid) || [];
    const mi = before(mv, ts);
    let pt = null;
    if (mv.length) {
      if (!mi) pt = mv[0];
      else if (mi >= mv.length) pt = mv[mv.length - 1];
      else {
        const a = mv[mi - 1];
        const b = mv[mi];
        const k = b.ts === a.ts ? 1 : (ts - a.ts) / (b.ts - a.ts);
        pt = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    if (!pt) {
      const ck = clicks.get(seg.pid) || [];
      const ci = before(ck, ts);
      if (ci) pt = ck[ci - 1];
    }
    if (pt && ts >= 0) {
      cursor.style.display = '';
      cursor.style.left = pt.x - sx + 'px';
      cursor.style.top = pt.y - sy + 'px';
    } else cursor.style.display = 'none';
    const ck = clicks.get(seg.pid) || [];
    const ci = before(ck, ts);
    const hit = ci ? ck[ci - 1] : null;
    if (hit && hit.ts !== clickAt && ts - hit.ts < 400) {
      clickAt = hit.ts;
      ripple.style.left = hit.x - sx + 'px';
      ripple.style.top = hit.y - sy + 'px';
      ripple.classList.remove('on');
      void ripple.offsetWidth;
      ripple.classList.add('on');
    }
    paintInputs(seg, ts);
    paintBoxes(seg, ts);
    range.max = String(total);
    range.value = String(Math.round(g));
    range.style.setProperty('--pct', (total ? (g / total) * 100 : 0) + '%');
    paintMarks();
    const atEdge = liveOn && g >= total - 1500;
    time.textContent = atEdge ? clock(g) + ' · live' : clock(g) + ' / ' + clock(total);
    liveBtn.hidden = !liveOn;
    liveBtn.classList.toggle('behind', liveOn && !atEdge);
    liveBtn.lastChild.textContent = atEdge ? 'LIVE' : 'Go live';
    if (heatOn) ensureHeat(seg);
    paintHeat(sx, sy, seg);
    onTime(seg.pid, ts, seg.u);
  }

  function loop(t) {
    if (!alive()) return;
    if (playing) {
      if (last) g += (t - last) * speed;
      if (g >= total) {
        g = total;
        // A live session keeps "playing" at the edge and moves on as new samples arrive.
        if (!liveOn) {
          playing = false;
          playBtn.textContent = 'Play';
        }
      }
      draw();
    }
    last = t;
    raf = requestAnimationFrame(loop);
  }
  // Following live sits this far behind the newest sample, so motion stays smooth between uploads.
  const LIVE_LAG = 500;
  function goLive() {
    g = Math.max(0, total - LIVE_LAG);
    speed = 1;
    speeds.forEach((x, n) => x.setAttribute('aria-pressed', n === 0 ? 'true' : 'false'));
    playing = true;
    playBtn.textContent = 'Pause';
    last = 0;
    draw();
  }
  liveBtn.addEventListener('click', goLive);
  playBtn.addEventListener('click', () => {
    if (g >= total && !liveOn) g = 0;
    playing = !playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    last = 0;
  });
  speeds.forEach((b, i) =>
    b.addEventListener('click', () => {
      speed = [1, 2, 4, 8][i];
      speeds.forEach((x, n) => x.setAttribute('aria-pressed', n === i ? 'true' : 'false'));
    }),
  );
  range.addEventListener('pointerdown', () => (scrubbing = true));
  range.addEventListener('pointerup', () => (scrubbing = false));
  range.addEventListener('change', () => (scrubbing = false));
  range.addEventListener('input', () => {
    g = +range.value;
    last = 0;
    draw();
  });
  skipBox.addEventListener('change', () => {
    sessionStorage.setItem('assist-skip-idle', skipBox.checked ? '1' : '0');
    last = 0;
    draw();
  });
  heatBtn.addEventListener('click', () => {
    heatOn = !heatOn;
    heatBtn.setAttribute('aria-pressed', heatOn ? 'true' : 'false');
    heatSel.hidden = !heatOn;
    heatScopeSel.hidden = !heatOn;
    heatInfo.hidden = !heatOn;
    heatKey = '';
    if (!heatOn) heatCanvas.style.display = 'none';
    draw();
  });
  heatSel.addEventListener('change', () => {
    heatMode = heatSel.value;
    heatFor = '';
    heatPending = '';
    heatKey = '';
    draw();
  });
  heatScopeSel.value = heatScope;
  heatScopeSel.addEventListener('change', () => {
    heatScope = heatScopeSel.value;
    heatFor = '';
    heatPending = '';
    heatKey = '';
    draw();
  });
  function setMax(on) {
    isMax = on;
    box.classList.toggle('is-max', on);
    maxLabel.textContent = on ? 'Exit full screen' : 'Full screen';
    maxBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    draw();
  }
  function onViewportChange() {
    if (!alive()) {
      document.removeEventListener('fullscreenchange', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      return;
    }
    if (document.fullscreenElement === box || document.fullscreenElement === null) setMax(document.fullscreenElement === box);
    else draw();
  }
  document.addEventListener('fullscreenchange', onViewportChange);
  window.addEventListener('resize', onViewportChange);
  maxBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    const req = box.requestFullscreen?.bind(box) || box.webkitRequestFullscreen?.bind(box);
    if (req) req().catch(() => setMax(!box.classList.contains('is-max')));
    else setMax(!box.classList.contains('is-max'));
  });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (!alive()) return ro.disconnect();
      fit(at(Math.min(g, total)).seg);
    });
    ro.observe(stage);
  }
  raf = requestAnimationFrame(loop);
  requestAnimationFrame(() => {
    if (!alive()) return;
    if (opts.at) {
      playing = false;
      playBtn.textContent = 'Play';
      box.seek(opts.at.pid, Number(opts.at.ts) || 0);
    } else if (liveOn) goLive();
    else draw();
  });
  return Object.assign(box, {
    isPlaying: () => playing,
    /** New samples for a live session: the tape grows in place; the page frame is kept. */
    update(r, mk, live) {
      if (!r?.pages?.length) return;
      const following = liveOn && playing && total - g < 2500;
      const head = pages?.[0]?.pid;
      ingest(r, mk);
      liveOn = !!live;
      // Dropping the oldest page shifts the whole tape, so a playhead that was following
      // the visitor would land on an earlier page. Put it back at the live edge.
      if (following && (pages[0]?.pid !== head || total - g > 1500)) g = Math.max(0, total - LIVE_LAG);
      inputKey = '';
      renderMarks();
      if (!playing) draw();
    },
    /** A fresher snapshot arrived for `u`. */
    refreshSnap(u) {
      snapCache.delete(u);
      if (shown === 'u:' + u) {
        shown = '';
        draw();
      }
    },
    seek(pid, ts) {
      let acc = 0;
      for (const seg of pages) {
        if (seg.pid === pid) {
          g = acc + Math.max(0, Math.min(ts, seg.dur));
          draw();
          return;
        }
        acc += seg.dur;
      }
    },
  });
}

// ---------------- heat rendering (shared by snapshot mode) ----------------
function colorize(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (!a) continue;
    const t = Math.min(1, a * 1.4);
    d[i] = t < 0.5 ? 0 : t < 0.75 ? (t - 0.5) * 4 * 255 : 255;
    d[i + 1] = t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255;
    d[i + 2] = t < 0.25 ? 255 : t < 0.5 ? (0.5 - t) * 4 * 255 : 0;
    d[i + 3] = Math.min(220, 60 + t * 200);
  }
  return img;
}
function heat(g, pts, W, H) {
  const max = Math.max(1, ...pts.map((p) => p[2]));
  for (const [x, y, n] of pts) {
    const grd = g.createRadialGradient(x, y, 0, x, y, 26);
    grd.addColorStop(0, `rgba(0,0,0,${Math.min(0.9, 0.15 + (n / max) * 0.5)})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - 26, y - 26, 52, 52);
  }
  if (W && H) g.putImageData(colorize(g.getImageData(0, 0, W, H)), 0, 0);
}

// ---------------- views ----------------
// ---------------- shared display helpers ----------------
/** The tail of a CSS path, without positional noise: "… › input.PrivateSwitchBase-input". */
const shortSel = (sel) => {
  const parts = String(sel || '').split('>');
  const last = parts[parts.length - 1].replace(/:nth-of-type\(\d+\)/g, '').replace(/^([\w-]*)((?:\.[\w-]+)?).*$/, '$1$2');
  return (parts.length > 1 ? '… › ' : '') + (last || parts[parts.length - 1]);
};
/** An element as people know it (role and label), with its selector underneath. */
function elCell(fp) {
  const [sel = '', role, name] = String(fp || '').split('|');
  if (!sel || sel === '(page)') return el('td', {}, el('div', { class: 'cell-main', text: 'The page itself' }), el('div', { class: 'cell-sub', text: 'Not tied to one element' }));
  return el('td', { class: 'el-cell' }, el('div', { class: 'cell-main' }, name ? [el('span', { class: 'role', text: role || 'element' }), ' ', el('span', { text: name })] : el('code', { text: shortSel(sel) })), name ? el('div', { class: 'cell-sub sel', title: sel, text: shortSel(sel) }) : null);
}
/** A page URL: the path, with any query muted beside it. */
function pageCell(u) {
  const [path, ...rest] = String(u || '').split(/(?=[?#])/);
  return el('td', {}, el('div', { class: 'page-cell', title: u }, el('code', { text: path || '/' }), rest.length ? el('span', { class: 'q', text: rest.join('') }) : null));
}
/** Distinct routes from a list of page URLs. */
const routesOf = (list) => [...new Set((list || []).map((u) => String(u).split(/[?#]/)[0] || '/'))];
const SIGNAL = {
  rage: ['Rage clicks', 'bad'],
  dead: ['Dead clicks', 'warn'],
  errclick: ['Click hit an error', 'bad'],
  disabled: ['Tried a disabled control', 'warn'],
  thrash: ['Field thrash', 'warn'],
  valloop: ['Validation loop', 'bad'],
  resubmit: ['Resubmitted', 'bad'],
  fake: ['Clicked non-button', 'warn'],
  uturn: ['U-turn', 'warn'],
  loop: ['Page loop', 'warn'],
  refresh: ['Reloaded', 'warn'],
  qback: ['Quick back', 'warn'],
  paste: ['Paste retry', 'warn'],
  cursor: ['Erratic pointer', 'warn'],
  wander: ['Wandering', 'warn'],
  hover: ['Long hover', 'warn'],
  idle: ['Stalled', 'warn'],
  leave: ['Left the window', 'warn'],
  zoom: ['Zoomed', 'warn'],
  tabcycle: ['Tab cycling', 'warn'],
};
const signalBadge = (k, n) => {
  const [t, c] = SIGNAL[k] || [k, 'warn'];
  return el('span', { class: 'badge ' + c, title: k, text: n > 1 ? `${t} ×${n}` : t });
};
const ERR_KIND = { net: ['Network', 'A request failed or returned an error status'], js: ['JavaScript', 'An uncaught script error'], rej: ['Promise', 'A promise rejected and nothing handled it'], con: ['Console', 'console.error was called'], ui: ['Shown to user', 'An error message appeared on screen'], csp: ['Blocked', 'Blocked by the content security policy'], res: ['Resource', 'An image, script or style failed to load'] };
const errKind = (k) => {
  const [t, title] = ERR_KIND[k] || [k, ''];
  return el('span', { class: 'badge kind k-' + k, title, text: t });
};
/** Score as a small bar plus number; `max` is the top score on screen. */
const scoreCell = (v, max) => el('td', { class: 'num score-cell' }, el('span', { class: 'score-bar' }, el('i', { class: scoreLevel(v), style: { width: Math.max(6, Math.round((v / Math.max(1, max)) * 100)) + '%' } })), el('strong', { text: fmt(v) }));

// ---------------- overview ----------------
/** Change against the previous period. `upGood` says which direction is good news. */
function delta(cur, prev, upGood, what = '') {
  if (prev == null) return null;
  if (!prev && !cur) return el('span', { class: 'delta flat', text: 'No change' });
  if (!prev) return el('span', { class: 'delta ' + (upGood ? 'up good' : 'up bad'), text: 'New this period' });
  const pc = Math.round(((cur - prev) / prev) * 100);
  if (!pc) return el('span', { class: 'delta flat', text: 'No change' });
  const good = pc > 0 === upGood;
  return el('span', { class: `delta ${pc > 0 ? 'up' : 'down'} ${good ? 'good' : 'bad'}`, title: `Previous period: ${fmt(prev)}${what ? ' ' + what : ''}` }, `${pc > 0 ? '▲' : '▼'} ${Math.abs(pc)}%`);
}
function kpi({ k, v, d, hint, tone, go: open }) {
  return el(
    'button',
    { type: 'button', class: 'kpi' + (tone ? ' t-' + tone : ''), onclick: open },
    el('span', { class: 'kpi-k', text: k }),
    el('span', { class: 'kpi-v' }, el('span', { text: v }), d),
    hint ? el('span', { class: 'kpi-hint', text: hint }) : null,
  );
}
let ovMetric = 'sessions';
const METRICS = [
  ['sessions', 'Sessions', 'sessions'],
  ['pv', 'Page views', 'page views'],
  ['errors', 'Errors', 'errors'],
  ['frus', 'Frustration', 'avg frustration per session'],
];
function activityChart(series) {
  const box = el('section', { class: 'ov-card chart-card' });
  const pts = series?.points || [];
  const hourly = series?.unit === 'hour';
  const label = (t, long) =>
    hourly
      ? new Date(t).toLocaleString([], long ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric' })
      : new Date(t).toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}) });
  const paint = () => {
    const [key, name, unit] = METRICS.find((m) => m[0] === ovMetric) || METRICS[0];
    const vals = pts.map((p) => p[key] || 0);
    const max = Math.max(...vals, 0);
    const total = key === 'frus' ? null : vals.reduce((a, b) => a + b, 0);
    const peak = vals.indexOf(max);
    const nice = max <= 4 ? Math.max(1, max) : Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) * Math.pow(10, Math.floor(Math.log10(max)));
    const every = Math.max(1, Math.ceil(pts.length / 8));
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Metric' }, METRICS.map(([k, t]) => el('button', { type: 'button', 'aria-pressed': k === key, text: t, onclick: () => ((ovMetric = k), paint()) })));
    box.replaceChildren(
      el(
        'div',
        { class: 'ov-head' },
        el('h2', { text: 'Activity' }),
        el('span', { class: 'muted small', text: max ? `${total != null && !(hourly && key === 'sessions') ? fmt(total) + ' ' + unit + ' · ' : ''}peak ${fmt(max)} ${hourly ? 'at' : 'on'} ${label(pts[peak].t, true)}` : `No ${unit} in this range` }),
        seg,
      ),
      el(
        'div',
        { class: 'chart', role: 'img', 'aria-label': `${name} per ${hourly ? 'hour' : 'day'}` },
        el('div', { class: 'chart-y' }, [nice, nice / 2, 0].map((v) => el('span', { text: fmt(Math.round(v * 10) / 10) }))),
        el(
          'div',
          { class: 'chart-plot' },
          el('div', { class: 'chart-grid' }, el('i'), el('i'), el('i')),
          el(
            'div',
            { class: 'chart-bars' + (key === 'errors' ? ' bad' : key === 'frus' ? ' warn' : '') },
            pts.map((p, i) => el('div', { class: 'cb' + (p[key] ? '' : ' zero') + (i > pts.length * 0.75 ? ' tip-left' : '') }, el('i', { 'data-tip': `${label(p.t, true)} · ${fmt(p[key] || 0)} ${unit}`, style: { height: (p[key] ? Math.max(2, (p[key] / nice) * 100) : 0) + '%' } }))),
          ),
          el('div', { class: 'chart-x' }, pts.map((p, i) => el('span', { text: i % every === 0 ? label(p.t) : '' }))),
        ),
      ),
    );
  };
  paint();
  return box;
}
function overviewPages(routes, rows = 8) {
  if (!routes?.length) return empty('No pages yet.');
  const shown = routes.slice(0, rows);
  const maxViews = Math.max(...shown.map((r) => r.views), 1);
  const t = table(
    [
      { h: 'Page', v: (r) => el('td', {}, el('div', { class: 'route' }, el('code', { text: r.route }), r.variants > 1 ? el('span', { class: 'badge', title: 'URLs that differ only in their query or hash', text: `${r.variants} variants` }) : null)) },
      { h: 'Views', v: (r) => el('td', { class: 'num views-cell' }, el('span', { class: 'mini-bar' }, el('i', { style: { width: Math.round((r.views / maxViews) * 100) + '%' } })), fmt(r.views)) },
      { h: 'Sessions', v: (r) => r.sessions, num: 1 },
      { h: 'Frustration', v: (r) => el('td', { class: 'num' }, r.frus ? level(scoreLevel(r.frus), String(r.frus)) : el('span', { class: 'muted', text: '0' })) },
      { h: 'Errors', v: (r) => el('td', { class: 'num' + (r.errors ? ' bad-text' : ' muted') }, fmt(r.errors)) },
    ],
    shown,
    (r) => go('heatmap', { u: r.top }),
  );
  t.classList.add('compact');
  return [t, routes.length > shown.length ? el('p', { class: 'muted small more', text: `+ ${routes.length - shown.length} more route${routes.length - shown.length === 1 ? '' : 's'} with fewer views` }) : null];
}
/** The overview's People card: who is on the site, each opening their own page. */
function overviewPeople(people, rows = 5) {
  if (!people?.length) return empty('No visitors yet.');
  const shown = people.slice(0, rows);
  const t = table(
    [
      {
        h: 'Person',
        v: (p) => el('td', {}, el('div', { class: 'route' }, el('span', { class: 'person-name' + (p.name || p.email ? '' : ' muted'), title: p.email || p.vid, text: p.name || p.email || 'Anonymous · ' + String(p.vid).slice(0, 6) }), p.live ? livePill('Now') : null)),
      },
      { h: 'Visits', v: (p) => p.sessions, num: 1 },
      { h: 'Last seen', v: (p) => el('td', { class: 'num muted', text: p.live ? 'now' : ago(p.last) }) },
      { h: 'Issues', v: (p) => el('td', { class: 'num' }, p.frus || p.errors ? el('span', { class: 'badge ' + (p.errors ? 'bad' : 'warn'), text: p.frus + p.errors }) : el('span', { class: 'muted', text: '0' })) },
    ],
    shown,
    (p) => go('people', { vid: p.vid }),
  );
  t.classList.add('compact');
  return [t, el('button', { type: 'button', class: 'ov-btn', onclick: () => go('people') }, el('span', { text: 'Open People' }), el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }))];
}
function attentionList(frus, errs, vit, limit = 5) {
  const items = [];
  const core = VITALS.filter((v) => v[5]).map(([n]) => [n, vit?.summary?.[n]]).filter(([, s]) => s);
  const worst = core.find(([, s]) => s.rating === 'poor') || core.find(([, s]) => s.rating === 'ni');
  if (worst) {
    const [n, s] = worst;
    const [cls, label] = RATING[s.rating];
    items.push({ tone: cls, kind: 'Speed', title: `${(VITALS.find((v) => v[0] === n) || [])[1] || n} is ${label.toLowerCase()}`, sub: `${vfmt(n, s.p75)} for 3 in 4 visits · ${s.poor}% of visits are poor`, value: vfmt(n, s.p75), open: () => go('performance') });
  }
  for (const e of [...errs].sort((a, b) => b.sessions - a.sessions || b.n - a.n).slice(0, 2))
    items.push({ tone: 'bad', kind: 'Error · ' + (ERR_KIND[e.k] || [e.k])[0], title: e.m, sub: `${fmt(e.sessions)} session${e.sessions === 1 ? '' : 's'} · ${routesOf(e.pages).slice(0, 2).join(', ')} · last ${ago(e.last)}`, value: `×${fmt(e.n)}`, open: () => openAt(e.at) || go('errors') });
  for (const f of frus.slice(0, Math.max(0, limit - items.length))) {
    const [, role, name] = String(f.el).split('|');
    const what = name ? `${role || 'element'} “${name}”` : f.el.split('|')[0] === '(page)' ? 'Whole page' : shortSel(f.el.split('|')[0]);
    items.push({ tone: scoreLevel(f.score) === 'bad' ? 'bad' : 'warn', kind: 'Frustration', title: what, sub: `${Object.entries(f.kinds).map(([k, n]) => (SIGNAL[k]?.[0] || k) + (n > 1 ? ' ×' + n : '')).join(', ')} · ${String(f.u).split(/[?#]/)[0]}`, value: String(f.score), open: () => openAt(f.at) || go('frustration') });
  }
  items.length = Math.min(items.length, limit);
  if (!items.length) return el('div', { class: 'all-good' }, el('strong', { text: 'Nothing stands out' }), el('span', { class: 'muted', text: 'No errors, frustration or slow pages in this range.' }));
  return el(
    'ul',
    { class: 'attn' },
    items.map((x) =>
      el(
        'li',
        {},
        el(
          'button',
          { type: 'button', onclick: x.open },
          el('i', { class: 'attn-dot ' + x.tone }),
          el('span', { class: 'attn-body' }, el('span', { class: 'attn-line' }, el('span', { class: 'attn-kind', text: x.kind }), el('span', { class: 'attn-title', title: x.title, text: x.title })), el('span', { class: 'attn-sub', title: x.sub, text: x.sub })),
          el('span', { class: 'attn-value', text: x.value }),
          el('span', { class: 'attn-go', 'aria-hidden': 'true', text: '›' }),
        ),
      ),
    ),
  );
}

const views = {
  async overview() {
    const s = siteNow();
    if (s && s.status === 'waiting') return [...header('Overview', 'Not receiving data yet. Install the script to start.'), installCard(s)];
    const [o, frus, errs, vit, people] = await Promise.all([api('overview'), api('frustration').catch(() => []), api('errors').catch(() => []), api('vitals').catch(() => null), api('people').catch(() => [])]);
    const range = RANGE_LABEL[state.range].toLowerCase();
    const p = o.prev && Object.values(o.prev).some(Boolean) ? o.prev : null;
    const sub = `How people used ${o.siteName} in ${range}${p ? ', compared with the period before' : o.prev ? ' (no data in the period before to compare with)' : ''}.`;
    if (!o.sessions) return [...header('Overview', sub), empty(`No visits in ${range}. Try a longer range.`)];
    const share = (n) => (o.sessions ? Math.round((n / o.sessions) * 100) : 0);
    // Rows that fit on one screen next to the chart's minimum height.
    const fit = Math.max(4, Math.min(8, Math.floor((innerHeight - 600) / 31)));
    return [
      ...header('Overview', sub),
      el(
        'div',
        { class: 'kpis' },
        kpi({ k: 'Sessions', v: fmt(o.sessions), d: delta(o.sessions, p?.sessions, true), hint: o.bots ? `${fmt(o.bots)} bot session${o.bots === 1 ? '' : 's'} left out` : 'Real visitors only', go: () => go('sessions') }),
        kpi({ k: 'Page views', v: fmt(o.pageviews), d: delta(o.pageviews, p?.pageviews, true), hint: `${o.pagesPerSession} pages per session`, go: () => go('heatmap') }),
        kpi({ k: 'Median visit', v: dur(o.medianDuration), hint: `${share(o.bounced)}% saw one page only`, go: () => go('sessions') }),
        kpi({ k: 'Frustrated sessions', v: fmt(o.frustrated), tone: o.frustrated ? (share(o.frustrated) >= 20 ? 'bad' : 'warn') : 'good', hint: `${share(o.frustrated)}% of sessions · avg score ${o.avgFrustration}`, d: delta(o.avgFrustration, p?.avgFrustration, false, 'avg score'), go: () => go('frustration') }),
        kpi({ k: 'Errors', v: fmt(o.errors), tone: o.errors ? 'bad' : 'good', d: delta(o.errors, p?.errors, false), hint: `in ${fmt(o.errorSessions)} session${o.errorSessions === 1 ? '' : 's'} (${share(o.errorSessions)}%)`, go: () => go('errors') }),
        kpi({ k: 'Rage · dead clicks', v: `${fmt(o.rage)} · ${fmt(o.dead)}`, tone: o.rage + o.dead ? 'warn' : 'good', d: delta(o.rage + o.dead, p ? p.rage + p.dead : null, false), hint: 'Repeated or ignored clicks', go: () => go('frustration') }),
      ),
      activityChart(o.series),
      el(
        'div',
        { class: 'ov-grid' },
        el('section', { class: 'ov-card' }, el('div', { class: 'ov-head' }, el('h2', { text: 'Pages' }), el('span', { class: 'muted small', text: 'Grouped by route, busiest first' })), overviewPages(o.routes, fit)),
        el('section', { class: 'ov-card' }, el('div', { class: 'ov-head' }, el('h2', { text: 'People' }), el('span', { class: 'muted small', text: people.length ? `${people.length >= 200 ? '200+' : people.length} in ${range} · ${people.filter((p) => p.name || p.email).length} named` : 'Who is on the site' })), overviewPeople(people, Math.max(2, Math.min(6, fit - 2)))),
        el('section', { class: 'ov-card' }, el('div', { class: 'ov-head' }, el('h2', { text: 'Needs attention' }), el('span', { class: 'muted small', text: 'The biggest problems right now' })), attentionList(frus, errs, vit, Math.min(5, fit - 1))),
      ),
    ];
  },

  async heatmap(p) {
    const pages = await api('pages');
    if (!pages.length) return [...header('Heatmaps'), empty('No pages recorded yet.')];
    const u = p.u || pages[0].u;
    let mode = p.mode || 'clicks';
    let dev = p.dev || '';
    const sel = el('select', { class: 'page-pick', 'aria-label': 'Page', onchange: (e) => go('heatmap', { u: e.target.value, mode, dev }) }, pages.map((x) => el('option', { value: x.u, text: `${x.u}  ·  ${fmt(x.views)} views${x.snapshot ? '' : ' · no snapshot'}`, selected: x.u === u })));
    const devSel = el('select', { 'aria-label': 'Device', onchange: (e) => go('heatmap', { u, mode, dev: e.target.value }) }, [['', 'All devices'], ['d', 'Desktop'], ['t', 'Tablet'], ['m', 'Mobile']].map(([v, t]) => el('option', { value: v, text: t, selected: v === dev })));
    const MODE_TIP = { clicks: 'Where people click', moves: 'Where the pointer travels', scroll: 'How far down people get', attention: 'What stays on screen longest', frustration: 'Elements with frustration signals' };
    const modes = el('div', { class: 'seg', role: 'group', 'aria-label': 'Heatmap type' }, Object.keys(MODE_TIP).map((m) => el('button', { type: 'button', 'aria-pressed': m === mode, title: MODE_TIP[m], text: m[0].toUpperCase() + m.slice(1), onclick: () => go('heatmap', { u, mode: m, dev }) })));
    const info = el('span', { class: 'muted small' });
    const origin = siteOrigin(siteNow());
    const openIcon = svgEl('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' });
    openIcon.append(svgEl('path', { d: 'M6 2.5H3.5A1 1 0 0 0 2.5 3.5v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10M9 2.5h4.5V7M7 9l6.2-6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    const onsite = origin ? el('a', { class: 'btn-open', href: `${origin}${u.split('?')[0]}?assist-heatmap=${encodeURIComponent(state.token)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open on the live site', openIcon) : null;
    const stage = el('div', { class: 'stage' });
    const out = [...header('Heatmaps', 'Where people click, move and scroll, drawn on a redacted copy of the page.', { actions: onsite ? [onsite] : [] }), el('div', { class: 'toolbar' }, sel, devSel, modes, el('span', { class: 'hm-info' }, info)), stage];

    const [data, snap] = await Promise.all([api('heatmap', { u }), api('snapshot', { u }).catch(() => null)]);
    if (!snap) {
      stage.append(empty('No snapshot captured for this page yet (snapshots are taken once per page version). Use "Open on the live site" for on-site mode.'));
      return out;
    }
    const W = snap.vw || 1280;
    const H = Math.min(snap.ht || 2000, 12000);
    const inner = el('div', { class: 'inner', style: { width: W + 'px', height: H + 'px' } });
    const frame = el('iframe', { sandbox: 'allow-same-origin', title: 'Page snapshot', width: W, height: H, referrerpolicy: 'no-referrer' });
    frame.srcdoc = snap.html;
    const canvas = el('canvas', { width: W, height: H });
    inner.append(frame, canvas);
    const box = el('div', { class: 'hm-box' }, inner);
    stage.append(box);
    // Fit the whole snapshot below the toolbar; a page too long to stay readable that way fits
    // the width instead and scrolls inside the stage, never the dashboard.
    const fit = () => {
      if (!stage.isConnected) return removeEventListener('resize', fit);
      const room = Math.max(320, innerHeight - (stage.getBoundingClientRect().top + scrollY) - 24);
      const kw = Math.min(1, stage.clientWidth / W);
      const kh = (room - 2) / H;
      const k = kh >= kw * 0.55 ? Math.min(kw, kh) : kw;
      inner.style.transform = `scale(${k})`;
      box.style.width = W * k + 'px';
      box.style.height = H * k + 'px';
      stage.style.height = Math.min(H * k + 2, room) + 'px';
      stage.style.overflowY = H * k + 2 > room ? 'auto' : 'hidden';
    };
    requestAnimationFrame(fit);
    addEventListener('resize', fit);

    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const byFp = new Map();
      const byName = new Map();
      for (const n of doc.querySelectorAll('[data-assist-fp]')) {
        const fp = n.getAttribute('data-assist-fp');
        byFp.set(fp, n);
        const [, role, name] = fp.split('|');
        if (name) byName.set(role + '|' + name, n);
      }
      const find = (fp) => byFp.get(fp) || (() => {
        const [, role, name] = String(fp).split('|');
        return name ? byName.get(role + '|' + name) : null;
      })();
      const rect = (n) => {
        const r = n.getBoundingClientRect();
        return { left: r.left + doc.defaultView.scrollX, top: r.top + doc.defaultView.scrollY, width: r.width, height: r.height };
      };
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, W, H);
      if (mode === 'clicks') {
        let matched = 0;
        const list = data.clicks.filter((c) => !dev || c.dev === dev);
        const pts = list.map((c) => {
          const n = find(c.el);
          if (n) {
            matched++;
            const r = rect(n);
            return [r.left + (c.rx / 1000) * r.width, r.top + (c.ry / 1000) * r.height, 1];
          }
          return [c.x, c.y, 1];
        });
        heat(g, pts, W, H);
        info.textContent = `${list.length} clicks · confidence ${list.length ? Math.round((matched / list.length) * 100) : 0}% matched to elements on this snapshot`;
      } else if (mode === 'moves') {
        const list = data.moves.filter((m) => !dev || m.dev === dev);
        heat(g, list.map((m) => [m.x * (W / (m.w || W)), m.y * (W / (m.w || W)), m.n]), W, H);
        info.textContent = `${list.reduce((n, m) => n + m.n, 0)} movement samples`;
      } else if (mode === 'scroll') {
        const reach = dev ? data.scroll.byDev[dev] : data.scroll.reach;
        for (let i = 0; i < 10; i++) {
          const pct = reach[i] || 0;
          g.fillStyle = `hsla(${pct * 1.2}, 85%, 50%, .3)`;
          g.fillRect(0, (i / 10) * H, W, H / 10);
          g.fillStyle = '#111';
          g.font = '600 14px system-ui';
          g.fillText(`${Math.round(pct)}% reached`, 12, (i / 10) * H + 20);
        }
        info.textContent = `${data.scroll.sessions} page views with scroll data`;
      } else {
        const list = mode === 'attention' ? data.attention : data.frustration.map((x) => [x.el, x.score, x.at]);
        const max = Math.max(1, ...list.map((x) => x[1]));
        let matched = 0;
        const hits = [];
        for (const [fp, v, at] of list) {
          const n = find(fp);
          if (!n) continue;
          matched++;
          const r = rect(n);
          const t = v / max;
          g.strokeStyle = mode === 'attention' ? `rgba(37,99,235,${0.3 + t * 0.7})` : `rgba(220,38,38,${0.3 + t * 0.7})`;
          g.lineWidth = 2 + t * 5;
          g.strokeRect(r.left - 3, r.top - 3, r.width + 6, r.height + 6);
          g.fillStyle = g.strokeStyle;
          g.font = '600 12px system-ui';
          g.fillText(mode === 'attention' ? `${(v / 1000).toFixed(1)}s` : `score ${v}`, r.left, Math.max(12, r.top - 6));
          if (at) hits.push({ left: r.left, top: r.top, width: r.width, height: r.height, at });
        }
        if (hits.length) {
          canvas.style.cursor = 'pointer';
          canvas.onclick = (ev) => {
            const b = canvas.getBoundingClientRect();
            const x = ((ev.clientX - b.left) / b.width) * canvas.width;
            const y = ((ev.clientY - b.top) / b.height) * canvas.height;
            const hit = hits.find((h) => x >= h.left - 3 && x <= h.left + h.width + 3 && y >= h.top - 3 && y <= h.top + h.height + 3);
            if (hit) openAt(hit.at);
          };
        }
        info.textContent = `${list.length} elements · ${matched} matched on this snapshot${hits.length ? ' · click one to open its recording' : ''}`;
      }
    });
    return out;
  },

  async frustration() {
    const rows = await api('frustration');
    const sum = (k) => rows.reduce((n, r) => n + (r.kinds[k] || 0), 0);
    const max = Math.max(1, ...rows.map((r) => r.score));
    const help = el(
      'details',
      { class: 'explain compact-help' },
      el('summary', {}, el('strong', { text: 'How scoring works' })),
      el(
        'div',
        { class: 'help-body' },
        el('p', { text: 'Each element gets points for evidence that someone was stuck on it: rage clicks (25), clicks that hit an error (20), validation loops (20), dead clicks (15), field thrash (15), retried disabled controls (14).' }),
        el('p', { class: 'muted', text: 'Everyday behaviour (hovering, going back and forth, reloading) only counts when it comes with that evidence, so normal browsing stays at zero.' }),
      ),
    );
    return [
      ...header('Frustration hotspots', 'Elements where visitors got stuck, ranked by evidence. Click a row to watch the latest time it happened.', {
        facts: rows.length ? [['Hotspots', rows.length], ['Rage clicks', sum('rage')], ['Dead clicks', sum('dead')], ['Clicks that hit an error', sum('errclick')], ['Validation loops', sum('valloop')]] : null,
      }),
      help,
      rows.length
        ? pagedRows('frustration', rows, (slice) =>
            table(
              [
                { h: 'Element', v: (r) => elCell(r.el) },
                { h: 'Page', v: (r) => pageCell(r.u) },
                { h: 'What happened', v: (r) => el('td', {}, el('div', { class: 'badges' }, Object.entries(r.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => signalBadge(k, n)))) },
                { h: 'Score', v: (r) => scoreCell(r.score, max), num: 1 },
              ],
              slice,
              (r) => openAt(r.at),
            ),
          )
        : empty('No frustration in this range. Visitors are getting through without signs of being stuck.'),
    ];
  },

  async errors() {
    const rows = (await api('errors')).sort((a, b) => b.sessions - a.sessions || b.n - a.n);
    const kinds = {};
    for (const r of rows) kinds[r.k] = (kinds[r.k] || 0) + r.n;
    const maxN = Math.max(1, ...rows.map((r) => r.n));
    const trail = (r) =>
      r.bc?.length
        ? el(
            'details',
            { class: 'crumbs', onclick: (e) => e.stopPropagation() },
            el('summary', { text: `What led up to it (${r.bc.length} step${r.bc.length === 1 ? '' : 's'})` }),
            el('ol', {}, r.bc.map((b) => el('li', {}, el('span', { class: 'badge', text: b.k.replace(/^f:/, '').replace(/^err:/, 'error ') }), b.el ? el('code', { text: shortSel(String(b.el).split('|')[0]) + (String(b.el).split('|')[2] ? ` “${String(b.el).split('|')[2]}”` : '') }) : null))),
          )
        : null;
    return [
      ...header('Errors', 'Grouped by fingerprint, most widespread first. Click a row to watch the latest time it happened.', {
        facts: rows.length ? [['Total', rows.reduce((n, r) => n + r.n, 0)], ['Distinct errors', rows.length], ...Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => [(ERR_KIND[k] || [k])[0], n])] : null,
      }),
      rows.length
        ? pagedRows('errors', rows, (slice) => table(
            [
              {
                h: 'Error',
                v: (r) =>
                  el(
                    'td',
                    { class: 'err-cell' },
                    el('div', { class: 'err-top' }, errKind(r.k), el('span', { class: 'cell-main err-msg', title: r.m, text: r.m })),
                    r.ru ? el('div', { class: 'cell-sub', title: r.ru }, el('code', { text: r.ru })) : null,
                    r.st ? el('div', { class: 'cell-sub', title: r.st }, el('code', { text: String(r.st).split('\n')[0] })) : null,
                    trail(r),
                  ),
              },
              {
                h: 'Pages',
                v: (r) => {
                  const list = routesOf(r.pages);
                  return el('td', { class: 'pages-cell', title: r.pages.join('\n') }, list.slice(0, 2).map((p) => el('div', {}, el('code', { text: p }))), list.length > 2 ? el('div', { class: 'muted small', text: `+ ${list.length - 2} more` }) : null);
                },
              },
              { h: 'Times', v: (r) => el('td', { class: 'num views-cell' }, el('span', { class: 'mini-bar bad' }, el('i', { style: { width: Math.round((r.n / maxN) * 100) + '%' } })), fmt(r.n)) },
              { h: 'Sessions', v: (r) => r.sessions, num: 1 },
              { h: 'Last seen', v: (r) => el('td', { class: 'nowrap', title: `First ${when(r.first)}\nLast ${when(r.last)}` }, el('div', { text: ago(r.last) }), el('div', { class: 'cell-sub', text: 'first ' + ago(r.first) })) },
            ],
            slice,
            (r) => openAt(r.at),
          ), { rowH: 62 })
        : empty('No errors in this range.'),
    ];
  },

  async forms() {
    const f = await api('forms');
    const warnPct = (v, bad, warn) => el('td', { class: 'num' }, v >= bad ? level('bad', v + '%') : v >= warn ? level('warn', v + '%') : el('span', { class: v ? '' : 'muted', text: v + '%' }));
    const started = f.forms.reduce((n, r) => n + r.start, 0);
    const ok = f.forms.reduce((n, r) => n + r.ok, 0);
    // The fields list is registered first so it fits the screen before the (capped) forms list does.
    const fields = pagedRows('form-fields', f.fields, (slice) =>
      table(
        [
          { h: 'Field', v: (r) => elCell(r.el) },
          { h: 'Page', v: (r) => pageCell(r.u) },
          { h: 'Uses', v: (r) => r.n, num: 1 },
          { h: 'Hesitation', v: (r) => el('td', { class: 'num' }, r.hesitation >= 3000 ? level('warn', ms(r.hesitation)) : ms(r.hesitation)) },
          { h: 'Time in field', v: (r) => ms(r.duration), num: 1 },
          { h: 'Corrections', v: (r) => r.corrections, num: 1 },
          { h: 'Errors', v: (r) => warnPct(r.errorRate, 25, 1) },
          { h: 'Left empty', v: (r) => (r.required ? warnPct(r.leftEmpty, 50, 25) : el('td', { class: 'num muted', title: 'Optional field', text: r.leftEmpty + '%' })) },
          { h: 'Abandoned here', v: (r) => el('td', { class: 'num' + (r.dropOff ? ' bad-text' : ' muted') }, fmt(r.dropOff)) },
        ],
        slice,
        (r) => openAt(r.at),
      ),
    { rowH: 50, above: 520 });
    const forms = pagedRows('forms', f.forms, (slice) =>
      table(
        [
          { h: 'Form', v: (r) => elCell(r.el) },
          { h: 'Started', v: (r) => r.start, num: 1 },
          { h: 'Submitted', v: (r) => r.submit, num: 1 },
          { h: 'Succeeded', v: (r) => r.ok, num: 1 },
          { h: 'Failed', v: (r) => r.fail, num: 1 },
          { h: 'Abandoned', v: (r) => r.abandon, num: 1 },
          { h: 'Completion', v: (r) => el('td', {}, r.completion == null ? '—' : `${r.completion}%`, bar(r.completion, r.completion < 50 ? '#dc2626' : '')) },
        ],
        slice,
        (r) => openAt(r.at),
      ),
    { max: 4, rowH: 50 });
    return [
      ...header('Forms', 'Where people hesitate, correct themselves, hit errors and give up. Click a row to watch the latest time it happened.', {
        facts: f.forms.length || f.fields.length ? [['Forms', f.forms.length], ['Started', started], ['Completed', started ? `${ok} (${Math.round((ok / started) * 100)}%)` : ok], ['Fields tracked', f.fields.length], ['Fields with errors', f.fields.filter((x) => x.errorRate > 0).length]] : null,
      }),
      el('div', { class: 'perf-head' }, el('h2', { text: 'Forms' }), el('span', { class: 'muted small', text: 'A form counts once someone types in it; it completes when the submit succeeds.' })),
      f.forms.length ? forms : el('p', { class: 'note', text: 'No form was submitted or abandoned in this range. Field activity is below.' }),
      el('div', { class: 'perf-head' }, el('h2', { text: 'Fields' }), el('span', { class: 'muted small', text: 'Hesitation is the pause before typing; corrections are edits per visit.' })),
      f.fields.length ? fields : empty('No field data yet.'),
    ];
  },
  async funnels() {
    const [data, site, pages] = await Promise.all([api('funnels'), api('sites/' + encodeURIComponent(state.site)), api('pages').catch(() => [])]);
    const defined = site.config?.funnels || [];
    const paths = pagePaths(pages);
    const create = () => editFunnel(null, defined, paths);

    // Funnels defined here, with their numbers; then any the site's own code defines.
    const cards = defined.map((f) => funnelCard(f, data.find((d) => d.name === f.name), { edit: () => editFunnel(f, defined, paths), remove: () => removeFunnel(f, defined) }));
    for (const d of data) if (!defined.some((f) => f.name === d.name)) cards.push(funnelCard({ name: d.name, steps: [] }, d, { code: true }));

    const intro = funnelIntro(!cards.length, create);
    return [
      ...header('Funnels', 'See where visitors drop off on the way to a goal, such as finishing a task.', {
        actions: [el('button', { type: 'button', class: 'primary', text: '+ New funnel', onclick: create })],
      }),
      intro,
      cards.length ? el('div', { class: 'funnel-grid' }, cards) : null,
    ];
  },

  async people(p) {
    if (p.vid) return personPage(p.vid);
    const rows = await api('people', { q: peopleQ });
    const search = el('input', { type: 'search', class: 'perf-search', placeholder: 'Name, email or visitor id…', 'aria-label': 'Find a person', value: peopleQ });
    const note = el('p', { class: 'muted small', text: '' });
    const list = paged('people', (slice) =>
      slice.length
        ? table(
            [
              { h: 'Person', v: (r) => el('td', {}, el('div', { class: 'cell-main', text: r.name || r.email || 'Anonymous' }), el('div', { class: 'cell-sub', text: r.name && r.email ? r.email : r.name || r.email ? '' : 'No name yet' })) },
              { h: 'Visitor id', v: (r) => el('code', { text: r.vid }) },
              { h: 'Sessions', v: (r) => r.sessions, num: 1 },
              { h: 'Last seen', v: (r) => el('td', { class: 'nowrap' }, el('div', { text: dayTime(r.last) }), r.live ? livePill('Active now') : null) },
              { h: 'Frustration', num: 1, v: (r) => el('td', { class: 'num' }, r.frus ? el('span', { class: 'badge ' + (frusLevel(r.frus) === 'good' ? '' : frusLevel(r.frus)), text: r.frus }) : el('span', { class: 'muted', text: '0' })) },
              { h: 'Errors', num: 1, v: (r) => el('td', { class: 'num' }, r.errors ? el('span', { class: 'badge bad', text: r.errors }) : el('span', { class: 'muted', text: '0' })) },
            ],
            slice,
            (r) => go('people', { vid: r.vid }),
          )
        : empty(peopleQ ? `No one matches “${peopleQ}”.` : 'No visitors stored yet.'),
    );
    let timer = 0;
    const load = async (reset) => {
      const found = await api('people', { q: peopleQ });
      note.textContent = peopleQ ? `${fmt(found.length)} match` : 'Named people first, then everyone else, across all stored data.';
      list.setRows(found, reset);
    };
    search.addEventListener('input', () => {
      peopleQ = search.value.trim();
      clearTimeout(timer);
      timer = setTimeout(() => load(true), 200);
    });
    note.textContent = peopleQ ? '' : 'Named people first, then everyone else, across all stored data.';
    list.setRows(rows);
    return [
      ...header('People', 'Find one person and see every visit they made. A name or email comes from data-who on the script tag, or from adding it on their page.'),
      el('div', { class: 'sess-tools' }, search, note),
      list,
    ];
  },

  async performance() {
    const v = await api('vitals', { dev: perf.dev });
    const devTotal = Object.values(v.devices).reduce((a, b) => a + b, 0);
    const devSeg = el(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Device' },
      [['', 'All devices'], ['d', 'Desktop'], ['m', 'Mobile'], ['t', 'Tablet']]
        .filter(([k]) => !k || v.devices[k] || perf.dev === k)
        .map(([k, t]) => el('button', { type: 'button', 'aria-pressed': perf.dev === k, title: `${fmt(k ? v.devices[k] || 0 : devTotal)} page loads measured`, text: t, onclick: () => ((perf.dev = k), render()) })),
    );
    const head = header('Performance', 'How fast pages load and respond for real visitors: the 75th percentile, so 3 in 4 visits were at least this fast.', { actions: [devSeg] });
    if (!v.pages.length)
      return [
        ...head,
        empty(perf.dev ? `No ${DEVICE[perf.dev].toLowerCase()} measurements in ${RANGE_LABEL[state.range].toLowerCase()}.` : `No measurements in ${RANGE_LABEL[state.range].toLowerCase()} yet. They arrive as visitors load pages with web vitals turned on in Setup & settings.`),
      ];

    const cards = el('div', { class: 'vcards' }, VITALS.map((m) => vitalCard(m, v.summary[m[0]])));
    const lt = v.longTasks;
    const ltNote = el(
      'p',
      { class: 'lt-note' },
      el('strong', { text: 'Long tasks: ' }),
      lt.n ? `${fmt(lt.n)} times the browser was busy for more than 50 ms in a row (${ms(lt.ms)} in total), which delays reactions to clicks and typing. All devices.` : 'none recorded. The page never froze for more than 50 ms in a row.',
    );

    // Toolbar and table re-paint locally, so typing in the search box keeps focus.
    const search = el('input', { type: 'search', placeholder: 'Find a page…', value: perf.q, 'aria-label': 'Find a page', class: 'perf-search' });
    const only = el('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [[false, 'All pages'], [true, 'Needs attention']].map(([k, t]) => el('button', { type: 'button', 'aria-pressed': perf.bad === k, text: t, onclick: () => ((perf.bad = k), paint()) })));
    const sort = select([['worst', 'Slowest first'], ['views', 'Most visited'], ['name', 'Name']], perf.sort);
    sort.setAttribute('aria-label', 'Sort pages');
    sort.addEventListener('change', () => ((perf.sort = sort.value), paint()));
    search.addEventListener('input', () => ((perf.q = search.value), paint()));
    const count = el('span', { class: 'muted small' });
    const list = paged('perf', (slice) => perfTable(slice, () => list.repaint()), { rowH: 40, above: 560 });
    const box = el('div');
    const paint = () => {
      only.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === 1 ? perf.bad : !perf.bad)));
      const q = perf.q.trim().toLowerCase();
      let rows = v.pages.filter((p) => (!q || p.route.toLowerCase().includes(q) || p.variants.some((x) => x.u.toLowerCase().includes(q))) && (!perf.bad || pageScore(p) > 0));
      rows = rows.sort(perf.sort === 'views' ? (a, b) => b.views - a.views : perf.sort === 'name' ? (a, b) => a.route.localeCompare(b.route) : (a, b) => pageScore(b) - pageScore(a) || b.views - a.views);
      count.textContent = `${rows.length} of ${v.pages.length} page${v.pages.length === 1 ? '' : 's'}`;
      list.setRows(rows, true);
      box.replaceChildren(rows.length ? list : empty(perf.bad ? 'Every page is fast here. Nothing needs attention.' : 'No page matches.'));
    };
    paint();
    return [
      ...head,
      assessment(v.summary),
      cards,
      ltNote,
      el('div', { class: 'perf-head' }, el('h2', { text: 'Pages' }), el('span', { class: 'muted small', text: 'Pages that differ only in their query (?id=…) are grouped. Click a row to see them, or a value to watch its slowest visit.' })),
      el('div', { class: 'perf-tools' }, search, only, sort, count),
      box,
    ];
  },

  async sessions(p) {
    if (p.sid) return views.session(p);
    const rows = await api('sessions');
    const live = rows.filter((r) => r.live).length;
    const durs = rows.map((r) => r.end - r.start).sort((a, b) => a - b);
    const median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
    const personOf = (r) => r.person || r.vid || r.sid;
    const people = new Set(rows.map(personOf)).size;
    const pct = (n) => (rows.length ? Math.round((n / rows.length) * 100) + '%' : '—');
    const frustrated = rows.filter((r) => r.frus > 0).length;
    const withErrors = rows.filter((r) => r.errors > 0).length;
    /** Distinct people with at least one session that passes `keep`. */
    const peopleWhere = (keep) => new Set(rows.filter(keep).map(personOf)).size;
    const status = [
      ['all', 'All', () => true],
      ['live', 'Active now', (r) => r.live],
      ['frus', 'Frustrated', (r) => r.frus > 0],
      ['err', 'With errors', (r) => r.errors > 0],
    ].map(([id, t, keep]) => [id, t, keep, peopleWhere(keep)]);
    if (!status.some((f) => f[0] === sess.status)) sess.status = 'all';
    const devices = [...new Set(rows.map((r) => r.dev).filter(Boolean))];
    if (sess.dev && !devices.includes(sess.dev)) sess.dev = '';
    const SORTS = {
      recent: ['Last seen', null],
      frus: ['Most frustrated', (a, b) => b.frus - a.frus || b.last - a.last],
      errors: ['Most errors', (a, b) => b.errors - a.errors || b.last - a.last],
      visits: ['Most visits', (a, b) => b.sessions.length - a.sessions.length || b.last - a.last],
      long: ['Longest time on site', (a, b) => b.time - a.time || b.last - a.last],
    };
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Show' });
    let shown = [];
    const body = paged('sessions', (slice) => sessGroupTable(slice, (key) => body.reveal(shown.findIndex((g) => g.key === key))), { rowH: 53, above: 440 });
    const search = el('input', { type: 'search', class: 'perf-search', placeholder: 'Name, email or visitor id…', 'aria-label': 'Find a visitor', value: sess.q });
    const devSel = el('select', { 'aria-label': 'Device', onchange: (e) => ((sess.dev = e.target.value), paint(true)) }, [['', 'All devices'], ...devices.map((d) => [d, DEVICE[d] || d])].map(([v, t]) => el('option', { value: v, text: t, selected: v === sess.dev })));
    const sortSel = el('select', { 'aria-label': 'Sort', onchange: (e) => ((sess.sort = e.target.value), paint(true)) }, Object.entries(SORTS).map(([k, [t]]) => el('option', { value: k, text: t, selected: k === sess.sort })));
    const recBox = el('label', { class: 'check-inline' }, el('input', { type: 'checkbox', checked: sess.rec, onchange: (e) => ((sess.rec = e.target.checked), paint(true)) }), 'Has recording');
    const count = el('span', { class: 'muted small' });
    search.addEventListener('input', () => ((sess.q = search.value.trim().toLowerCase()), paint(true)));
    const reset = el('button', { type: 'button', class: 'link', text: 'Clear filters', onclick: () => (Object.assign(sess, { status: 'all', dev: '', q: '', rec: false }), (pagedState.get('sessions').page = 0), render()) });

    /** Sessions that pass the filters, folded into one row per person. */
    const grouped = () => {
      const keep = status.find((f) => f[0] === sess.status)[2];
      const list = rows.filter((r) => keep(r) && (!sess.dev || r.dev === sess.dev) && (!sess.rec || r.replayMs) && (!sess.q || [r.name, r.email, r.vid, r.person, r.sid].join(' ').toLowerCase().includes(sess.q)));
      const by = new Map();
      for (const r of list) {
        const k = personOf(r);
        let g = by.get(k);
        if (!g) by.set(k, (g = { key: k, vid: r.vid, name: '', email: '', sessions: [], last: 0, first: Infinity, live: false, time: 0, pages: 0, clicks: 0, frus: 0, errors: 0, recs: 0, devs: new Set() }));
        g.sessions.push(r);
        g.name = g.name || r.name;
        g.email = g.email || r.email;
        if (r.end > g.last) ((g.last = r.end), (g.vid = r.vid));
        g.first = Math.min(g.first, r.start);
        g.live = g.live || r.live;
        g.time += r.end - r.start;
        g.pages += r.pages;
        g.clicks += r.clicks;
        g.frus += r.frus;
        g.errors += r.errors;
        if (r.replayMs) g.recs++;
        if (r.dev) g.devs.add(r.dev);
      }
      const out = [...by.values()];
      for (const g of out) g.sessions.sort((a, b) => b.start - a.start);
      const cmp = SORTS[sess.sort][1];
      return { list, groups: cmp ? out.sort(cmp) : out.sort((a, b) => Number(b.live) - Number(a.live) || b.last - a.last) };
    };
    const paint = (resetPage) => {
      const { list, groups } = grouped();
      const filtering = sess.status !== 'all' || sess.dev || sess.q || sess.rec;
      chips.replaceChildren(...status.map(([id, t, , n]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': id === sess.status, onclick: () => ((sess.status = id), paint(true)) }, t, el('span', { class: 'chip-n', text: fmt(n) }))));
      count.textContent = filtering ? `${fmt(groups.length)} ${groups.length === 1 ? 'person' : 'people'} · ${fmt(list.length)} of ${fmt(rows.length)} sessions match` : '';
      reset.hidden = !filtering;
      body.setRows((shown = groups), resetPage);
    };
    paint();
    return [
      ...header('Sessions', `Every visit in ${RANGE_LABEL[state.range].toLowerCase()}, one row per person. Open a row to see their visits. Updates by itself as people browse.`, {
        facts: [
          ['People', fmt(people)],
          ['Sessions', rows.length >= 1000 ? '1000+' : rows.length, rows.length >= 1000 ? 'The 1000 most recent are listed' : null],
          ['Active now', live],
          ['Median duration', rows.length ? dur(median) : '—'],
          ['Frustrated', pct(frustrated), 'Sessions with at least one scored frustration signal'],
          ['With errors', pct(withErrors)],
        ],
      }),
      el('div', { class: 'sess-tools' }, chips, el('div', { class: 'sess-filters' }, search, devSel, recBox, sortSel, count, reset)),
      body,
    ];
  },
  async session(p) {
    const gen = viewGen;
    const visitsOf = (vid) => (vid ? api('sessions', { vid, range: '' }).catch(() => []) : Promise.resolve([]));
    const [s, rec, list0] = await Promise.all([api('session/' + encodeURIComponent(p.sid)), api('replay/' + encodeURIComponent(p.sid)).catch(() => null), api('sessions').catch(() => [])]);
    let visits = await visitsOf(s.vid);
    if (gen !== viewGen) return [];
    const label = (e) => {
      switch (e.t) {
        case 'pv': return `Viewed ${e.u}`;
        case 'c': return `Clicked ${fpName(e.el)}`;
        case 'f': return `Frustration: ${e.k} on ${fpName(e.el)}`;
        case 'err': return `Error (${e.k}): ${e.m}`;
        case 'frm': return `Form ${e.a}: ${fpName(e.el)}`;
        case 'coach': return `Assistant ${e.a}: ${e.k}`;
        case 'tour': return `Tutorial ${e.a}: ${e.id}`;
        case 'ask': return 'Asked the assistant a question';
        case 'act': return `Action ${e.a}${e.ok ? '' : ' (blocked)'}`;
        case 'cu': return `Custom event: ${e.n}`;
        case 'bye': return 'Left the site';
        default: return e.t;
      }
    };
    const marksOf = (tl) =>
      (tl || []).flatMap((e) => {
        if (e.t === 'c') return [{ pid: e.pid, ts: e.ts || 0, kind: 'click', label: label(e) }];
        if (e.t === 'f') return [{ pid: e.pid, ts: e.ts || 0, kind: 'frus', label: label(e) }];
        if (e.t === 'err') return [{ pid: e.pid, ts: e.ts || 0, kind: 'err', label: label(e) }];
        if (['coach', 'tour', 'ask', 'frm', 'act', 'cu'].includes(e.t)) return [{ pid: e.pid, ts: e.ts || 0, kind: 'action', label: label(e) }];
        return [];
      });
    const alive = () => gen === viewGen;
    const items = [];
    let activeLi = null;
    const onTime = (pid, ts) => {
      let best = null;
      for (const li of items) if (li.dataset.pid === pid && +li.dataset.ts <= ts) best = li;
      for (const li of items) li.classList.toggle('on', li === best);
      if (best !== activeLi) {
        activeLi = best;
        if (best && player.isPlaying?.()) best.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
    const jump = p.pid ? { pid: p.pid, ts: Number(p.ts) || 0 } : null;
    let player = recordingPlayer(rec, marksOf(s.timeline), alive, onTime, { live: s.live, at: jump });
    const playerCol = el('div', { class: 'rec-player-col' }, player);
    const list = el('ul', { class: 'timeline' });
    let shownTl = 0;
    const addItems = (tl) => {
      const fresh = shownTl > 0;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      for (const e of tl.slice(shownTl)) {
        const li = el('li', { class: 'click t-' + e.t + (fresh ? ' fresh' : ''), 'data-pid': e.pid || '', 'data-ts': e.ts || 0, tabindex: '0' }, el('span', { class: 'muted', text: ms(e.at - s.start) }), el('span', { class: 'badge', text: e.t }), el('span', { text: label(e) }));
        const seek = () => player.seek?.(e.pid, e.ts || 0);
        li.addEventListener('click', seek);
        li.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') (ev.preventDefault(), seek());
        });
        items.push(li);
        list.append(li);
      }
      if (fresh && atBottom && tl.length > shownTl) list.scrollTop = list.scrollHeight;
      shownTl = tl.length;
    };
    addItems(s.timeline || []);
    const tlNote = el('span', { class: 'muted' });
    // Newer / older in the same order as the sessions list.
    const at = list0.findIndex((r) => r.sid === p.sid);
    const step = (d, text, hint) => {
      const r = at < 0 ? null : list0[at + d];
      return el('button', { type: 'button', class: 'nav-btn', disabled: !r, title: r ? `${hint}: ${dayTime(r.start)}` : `No ${hint.toLowerCase()} session`, onclick: () => r && go('sessions', { sid: r.sid }) }, text);
    };
    const statusBox = el('span', { class: 'ph-status' });
    const subLine = el('p', { class: 'sub' });
    const factsBox = el('div', { class: 'facts-box' });
    const [ph] = header(dayTime(s.start), null, {
      crumbs: [siteNow()?.name, ['Sessions', 'sessions'], 'Session ' + p.sid.slice(0, 8)].filter(Boolean),
      status: statusBox,
      actions: [el('div', { class: 'btn-group' }, step(-1, '‹ Newer', 'Newer'), step(1, 'Older ›', 'Older')), copyBtn(() => location.href, 'Copy link')],
    });
    ph.querySelector('.ph-main').append(subLine);
    ph.append(factsBox);
    // Same visitor's other visits. The buttons stay in the header; the cards open over the
    // page, so the recording keeps its height.
    const visitSlot = el('div', { class: 'visits-nav' });
    ph.querySelector('.ph-actions').prepend(visitSlot);
    const paintVisits = () => {
      const all = [...visits].sort((a, b) => a.start - b.start);
      const i = all.findIndex((r) => r.sid === p.sid);
      if (i < 0 || all.length < 2) return visitSlot.replaceChildren();
      const wasOpen = visitSlot.querySelector('.visits-pop') && !visitSlot.querySelector('.visits-pop').hidden;
      const kept = visitSlot.querySelector('.visit-row')?.scrollLeft;
      const hop = (d, text) => {
        const r = all[i + d];
        return el('button', { type: 'button', class: 'nav-btn', disabled: !r, title: r ? dayTime(r.start) : `No ${text.replace(/[‹›]/g, '').trim().toLowerCase()}`, onclick: () => r && go('sessions', { sid: r.sid }) }, text);
      };
      const cards = all.map((r, n) => {
        const cur = r.sid === p.sid;
        return el(
          'a',
          { href: '#sessions', class: 'visit' + (cur ? ' cur' : ''), 'aria-current': cur ? 'true' : null, title: `Visit ${n + 1}: ${dayTime(r.start)}`, onclick: (e) => (e.preventDefault(), !cur && go('sessions', { sid: r.sid })) },
          el('span', { class: 'visit-n', text: 'Visit ' + (n + 1) }),
          el('span', { class: 'visit-when', text: dayTime(r.start) }),
          el('span', { class: 'visit-meta' }, r.live ? level('good', 'Active now') : el('span', { text: dur(r.end - r.start) }), r.frus ? el('span', { class: 'level ' + (frusLevel(r.frus) === 'good' ? 'warn' : frusLevel(r.frus)) }, el('i'), el('span', { text: 'frustration ' + r.frus })) : null, r.errors ? el('span', { class: 'level bad' }, el('i'), el('span', { text: r.errors + (r.errors === 1 ? ' error' : ' errors') })) : null),
        );
      });
      const row = el('div', { class: 'visit-row' }, cards);
      const pop = el('div', { class: 'visits-pop', hidden: !wasOpen, role: 'dialog', 'aria-label': 'This visitor’s other sessions' }, el('div', { class: 'visits-pop-head' }, el('strong', { text: 'This visitor' }), el('span', { class: 'muted', text: `${all.length} sessions, oldest first` })), row);
      const toggle = el('button', { type: 'button', class: 'nav-btn visits-toggle', 'aria-expanded': wasOpen ? 'true' : 'false', 'aria-haspopup': 'dialog', title: 'This visitor’s other sessions', onclick: () => setOpen(pop.hidden) }, `Visit ${i + 1} of ${all.length}`);
      const setOpen = (open) => {
        pop.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        const c = row.querySelector('.cur');
        if (open && c) requestAnimationFrame(() => (row.scrollLeft = kept ?? c.offsetLeft - row.offsetLeft - row.clientWidth / 2 + c.offsetWidth / 2));
      };
      visitSlot.replaceChildren(el('div', { class: 'btn-group' }, hop(-1, '‹ Earlier'), toggle, hop(1, 'Later ›')), pop);
    };
    if (visitCloser) document.removeEventListener('mousedown', visitCloser);
    visitCloser = (e) => {
      if (visitSlot.contains(e.target)) return;
      const pop = visitSlot.querySelector('.visits-pop');
      if (pop && !pop.hidden) (pop.hidden = true), visitSlot.querySelector('.visits-toggle')?.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('mousedown', visitCloser);
    const paintMeta = (x) => {
      statusBox.replaceChildren(x.live ? livePill('Active now') : el('span', { class: 'badge ended', text: 'Ended ' + new Date(x.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }));
      const first = x.pages[0] || '';
      subLine.replaceChildren(reasonOf(x), el('span', { class: 'muted', text: ' · ' + (DEVICE[x.dev] || 'Unknown device') + (first ? ' · entered on ' + first : '') }));
      // Scores only count evidence of being stuck (a rage click is 25, a dead click 15), so these are low.
      const f = Math.round(x.frus);
      factsBox.replaceChildren(
        factStrip([
          ['Duration', dur(x.end - x.start)],
          ['Recording', x.replayMs ? clock(x.replayMs) : 'None'],
          ['Pages', x.pages.length],
          ['Clicks', x.clicks],
          ['Frustration', level(frusLevel(f), f ? String(f) : 'None'), 'Evidence that the visitor was stuck: rage, dead and error clicks, retried disabled controls, validation loops'],
          ['Errors', level(x.errors ? 'bad' : 'good', x.errors ? fmt(x.errors) : 'None')],
          x.vid ? ['Person', el('span', { class: 'who' }, el('a', { href: '#', onclick: (e) => (e.preventDefault(), go('people', { vid: x.vid })) }, x.name || x.email || 'Anonymous visitor'), x.email && x.name ? el('span', { class: 'muted', text: ' · ' + x.email }) : null, copyBtn(x.vid, 'Copy id')), 'Everything this person did. The copied id is what a data-deletion request uses.'] : null,
        ]),
      );
      tlNote.textContent = x.live ? 'New events appear as they happen' : 'Click a row to jump there';
    };
    paintMeta(s);
    paintVisits();
    let wasLive = s.live;
    // At most one refresh in flight; anything arriving meanwhile triggers exactly one more.
    let busy = false;
    let again = false;
    const pull = async () => {
      if (busy) return void (again = true);
      busy = true;
      try {
        await refresh();
      } catch {
      } finally {
        busy = false;
        if (again && alive()) {
          again = false;
          pull();
        }
      }
    };
    const refresh = async () => {
      const [s2, r2] = await Promise.all([api('session/' + encodeURIComponent(p.sid)), api('replay/' + encodeURIComponent(p.sid)).catch(() => null)]);
      if (!alive()) return;
      paintMeta(s2);
      // Only a live session can still change its place in the history (or the visitor return).
      if (s2.live || wasLive) {
        const v2 = await visitsOf(s2.vid);
        if (!alive()) return;
        visits = v2;
        paintVisits();
      }
      addItems(s2.timeline || []);
      if (player.update) player.update(r2, marksOf(s2.timeline), s2.live);
      else if (r2?.pages?.length) {
        player = recordingPlayer(r2, marksOf(s2.timeline), alive, onTime, { live: s2.live });
        playerCol.replaceChildren(player);
      }
      wasLive = s2.live;
    };
    live.onEvent = (d) => {
      if (!alive()) return;
      if (d.k === 'snap') return player.refreshSnap?.(d.u);
      if ((d.k === 'ev' && d.sid === p.sid) || (d.k === 'tick' && wasLive)) pull();
    };
    return [
      el(
        'div',
        { class: 'rec-page' },
        ph,
        el(
          'div',
          { class: 'rec-layout' },
          playerCol,
          el('div', { class: 'rec-timeline-col' }, el('div', { class: 'rec-tl-head' }, el('strong', { text: 'Timeline' }), tlNote), list),
        ),
      ),
    ];
  },

  async sites() {
    await loadSites();
    if (!state.sites.length)
      return [
        ...header('Welcome to Footsteps', 'Add the first website you want to understand. You get a script tag to paste into it; data shows up here within seconds.'),
        el('div', { class: 'onboard' }, el('ol', {}, el('li', { text: 'Name the site and list the domains it runs on.' }), el('li', { text: 'Paste the script tag into its pages.' }), el('li', { text: 'Browse the site: sessions, heatmaps and frustration appear here.' })), el('button', { type: 'button', class: 'primary', text: 'Add a site', onclick: () => go('site-new') })),
      ];
    const live = state.sites.reduce((n, s) => n + s.live, 0);
    return [
      ...header('All sites', `${state.sites.length} site${state.sites.length === 1 ? '' : 's'} · ${live} visitor${live === 1 ? '' : 's'} on them right now`, { actions: [el('button', { type: 'button', class: 'primary', text: '+ Add site', onclick: () => go('site-new') })] }),
      el(
        'div',
        { class: 'site-grid' },
        state.sites.map((s) =>
          el(
            'article',
            { class: 'site-card', tabindex: 0, role: 'link', 'aria-label': `Open ${s.name}`, onclick: () => openSite(s.id), onkeydown: (e) => e.key === 'Enter' && openSite(s.id) },
            el('div', { class: 'site-card-head' }, el('div', {}, el('h3', { text: s.name }), el('div', { class: 'muted fp', text: s.domains.join(', ') })), s.live ? livePill(`${s.live} live`) : statusBadge(s)),
            el(
              'div',
              { class: 'site-stats' },
              [
                ['Today', s.sessions24h, 'Sessions started in the last 24 hours'],
                ['Sessions', s.sessions, 'Sessions in stored data'],
                ['Views', s.pageviews, 'Page views in stored data'],
                ['Errors', s.errors, 'Errors in stored data'],
                ['Frustration', s.avgFrustration, 'Average frustration score per session'],
              ].map(([k, v, t]) => el('div', { title: t }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: fmt(v) }))),
            ),
            spark(s.trend, 'sessions', '#2563eb'),
            el(
              'div',
              { class: 'site-card-foot' },
              el('span', { class: 'muted', text: s.lastEvent ? 'Last event ' + ago(s.lastEvent) : 'No events yet' }),
              s.rejected.length ? el('span', { class: 'badge warn', text: `${s.rejected.length} domain${s.rejected.length === 1 ? '' : 's'} refused` }) : null,
              el('button', { type: 'button', class: 'link', text: 'Settings', onclick: (e) => (e.stopPropagation(), openSite(s.id, 'settings')) }),
            ),
          ),
        ),
      ),
    ];
  },

  async 'site-new'() {
    const name = el('input', { required: true, maxlength: 80, placeholder: 'Shop', autocomplete: 'off' });
    const domains = el('textarea', { rows: 3, required: true, placeholder: 'shop.example.com\n*.example.com\nlocalhost:3000', spellcheck: 'false' });
    const err = el('p', { class: 'form-error', role: 'alert' });
    const submit = el('button', { type: 'submit', class: 'primary', text: 'Create site' });
    const form = el(
      'form',
      { class: 'panel narrow', novalidate: true },
      field('Name', name, 'What your team calls it. Shown in the site switcher.'),
      field('Domains', domains, 'One per line. Only pages on these hosts can send data. Use *.example.com for subdomains and localhost:* for any local port.'),
      err,
      el('div', { class: 'form-actions' }, el('button', { type: 'button', text: 'Cancel', onclick: () => history.back() }), submit),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const s = await api('sites', {}, 'POST', { name: name.value, domains: lines(domains.value) });
        await loadSites();
        toast(`${s.name} created. Paste the script tag into its pages.`);
        openSite(s.id, 'settings');
      } catch (x) {
        err.textContent = x.message;
      } finally {
        submit.disabled = false;
      }
    });
    setTimeout(() => name.focus());
    return [...header('Add a site', null, { crumbs: [['All sites', 'sites'], 'New site'] }), form];
  },

  async users() {
    if (state.user?.role !== 'admin') {
      return [...header('Users', 'Only an admin can manage who signs in.'), el('div', { class: 'empty' }, el('p', { text: 'Ask an admin if you need access for a teammate.' }))];
    }
    const rows = await api('users', { site: '', range: '' });
    const username = el('input', { required: true, maxlength: 40, autocomplete: 'off', placeholder: 'jane' });
    const password = el('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password', placeholder: 'At least 8 characters' });
    const role = el('select', {}, el('option', { value: 'user', text: 'User' }), el('option', { value: 'admin', text: 'Admin' }));
    const err = el('p', { class: 'form-error', role: 'alert' });
    const submit = el('button', { type: 'submit', class: 'primary', text: 'Add user' });
    const form = el(
      'form',
      { class: 'panel', novalidate: true },
      el('h2', { text: 'Add a user' }),
      el('p', { class: 'muted', text: 'They can sign in to this dashboard. Admins can manage sites and other users.' }),
      el('div', { class: 'form-grid' }, field('Username', username), field('Password', password), field('Role', role)),
      err,
      el('div', { class: 'form-actions' }, submit),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        await api('users', { site: '', range: '' }, 'POST', { username: username.value, password: password.value, role: role.value });
        toast(`Added ${username.value.trim().toLowerCase()}.`);
        username.value = '';
        password.value = '';
        role.value = 'user';
        render();
      } catch (x) {
        err.textContent = x.message;
      } finally {
        submit.disabled = false;
      }
    });

    const table = el(
      'div',
      { class: 'panel' },
      el('h2', { text: 'People with access' }),
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Username' }), el('th', { text: 'Role' }), el('th', { text: 'Added' }), el('th', { text: '' }))),
        el(
          'tbody',
          {},
          ...rows.map((u) =>
            el(
              'tr',
              {},
              el('td', {}, el('strong', { text: u.username }), u.id === state.user.id ? el('span', { class: 'badge ended', text: 'you' }) : null),
              el('td', { text: u.role === 'admin' ? 'Admin' : 'User' }),
              el('td', { class: 'muted', text: dayTime(u.createdAt) }),
              el(
                'td',
                { class: 'row-actions' },
                el('button', {
                  type: 'button',
                  class: 'link',
                  text: 'Reset password',
                  onclick: async () => {
                    const next = window.prompt(`New password for ${u.username} (min 8 characters)`);
                    if (next == null) return;
                    try {
                      await api('users/' + encodeURIComponent(u.id), { site: '', range: '' }, 'PUT', { password: next, role: u.role });
                      toast(`Password updated for ${u.username}.`);
                    } catch (x) {
                      toast(x.message, 'error');
                    }
                  },
                }),
                u.role === 'user'
                  ? el('button', {
                      type: 'button',
                      class: 'link',
                      text: 'Make admin',
                      onclick: async () => {
                        try {
                          await api('users/' + encodeURIComponent(u.id), { site: '', range: '' }, 'PUT', { role: 'admin' });
                          toast(`${u.username} is now an admin.`);
                          render();
                        } catch (x) {
                          toast(x.message, 'error');
                        }
                      },
                    })
                  : u.id !== state.user.id
                    ? el('button', {
                        type: 'button',
                        class: 'link',
                        text: 'Make user',
                        onclick: async () => {
                          try {
                            await api('users/' + encodeURIComponent(u.id), { site: '', range: '' }, 'PUT', { role: 'user' });
                            toast(`${u.username} is now a user.`);
                            render();
                          } catch (x) {
                            toast(x.message, 'error');
                          }
                        },
                      })
                    : null,
                u.id !== state.user.id
                  ? el('button', {
                      type: 'button',
                      class: 'link danger-text',
                      text: 'Remove',
                      onclick: async () => {
                        if (!(await confirmDialog({ title: `Remove ${u.username}?`, body: 'They will be signed out and can no longer open this dashboard.', action: 'Remove', danger: true }))) return;
                        try {
                          await api('users/' + encodeURIComponent(u.id), { site: '', range: '' }, 'DELETE');
                          toast(`${u.username} removed.`);
                          render();
                        } catch (x) {
                          toast(x.message, 'error');
                        }
                      },
                    })
                  : null,
              ),
            ),
          ),
        ),
      ),
    );
    return [...header('Users', 'Who can sign in to Footsteps.'), form, table];
  },

  async settings() {
    const s = await api('sites/' + encodeURIComponent(state.site));
    const c = s.config || {};
    const f = c.features || {};

    const name = el('input', { value: s.name, maxlength: 80 });
    const domains = el('textarea', { rows: Math.max(2, s.domains.length + 1), spellcheck: 'false' });
    domains.value = s.domains.join('\n');
    const paused = el('input', { type: 'checkbox', checked: s.paused });
    const mask = el('input', { type: 'checkbox', checked: !!c.mask });
    const sample = el('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round((c.sampleRate ?? 1) * 100), class: 'short' });
    const consent = select([['auto', 'Automatic: respect Global Privacy Control / Do Not Track'], ['required', 'Required: record nothing until the site calls Assist.consent(true)'], ['none', 'Not needed']], c.consent || 'auto');
    const network = select([['observe', 'Observe (patches nothing)'], ['wrap', 'Wrap fetch / XHR (sees every failed request)'], ['off', 'Off']], c.network || 'observe');
    const consoleErr = el('input', { type: 'checkbox', checked: !!c.console });
    const FEAT = [['analytics', 'Analytics (forms, scroll depth, attention)'], ['heatmaps', 'Heatmaps'], ['errors', 'Error tracking'], ['forms', 'Form analytics'], ['vitals', 'Web vitals'], ['snapshots', 'Page snapshots'], ['replay', 'Session recordings']];
    const feats = Object.fromEntries(FEAT.map(([k]) => [k, el('input', { type: 'checkbox', checked: f[k] !== false })]));
    const ignore = el('textarea', { rows: 3, spellcheck: 'false', placeholder: '.chat-widget\n#payment-form' });
    ignore.value = (c.ignore || []).join('\n');
    const retention = el('input', { type: 'number', min: 1, max: 3650, value: s.retentionDays ?? '', placeholder: String(state.meta.retentionDays), class: 'short' });

    const err = el('p', { class: 'form-error', role: 'alert' });
    const saveBar = el('div', { class: 'save-bar', hidden: true }, el('span', { text: 'You have unsaved changes.' }), el('button', { type: 'button', text: 'Discard', onclick: () => render() }), el('button', { type: 'submit', class: 'primary', text: 'Save changes' }));
    const general = section('General', field('Name', name), field('Domains', domains, 'One per line. Batches from any other host are refused and listed under Install.'), toggle(paused, 'Pause collection', 'The script stays off on every page and anything sent anyway is dropped. Takes up to 5 minutes to reach open pages.'));
    const form = el(
      'form',
      { class: 'settings', novalidate: true },
      el('div', { class: 'set-col' }, general, section('Errors', field('Network failures', network), toggle(consoleErr, 'Also capture console.error')), section('Data', field('Keep data for', el('span', { class: 'with-unit' }, retention, el('span', { text: 'days' })), `Empty: the server default (${state.meta.retentionDays} days). Older events, snapshots and recordings are deleted.`))),
      el('div', { class: 'set-col' }, section(
        'Recording & privacy',
        toggle(mask, 'Mask page content', 'Off: recordings show the page as the visitor saw it, including typed values (never passwords). On: text is masked except labels, headings and buttons, and no field values are kept.'),
        field('Sessions recorded', el('span', { class: 'with-unit' }, sample, el('span', { text: '%' })), 'Share of visits that are recorded. Lower it on busy sites.'),
        field('Consent', consent),
        el('fieldset', { class: 'checks' }, el('legend', { text: 'Collect' }), FEAT.map(([k, t]) => el('label', {}, feats[k], el('span', { text: t })))),
        field('Never capture', ignore, 'CSS selectors, one per line. Matching elements are left out of everything.'),
      ),
      section(
        'Funnels',
        el('p', { class: 'muted', text: `${(c.funnels || []).length ? `${c.funnels.length} funnel${c.funnels.length === 1 ? '' : 's'} defined.` : 'No funnels yet.'} A funnel shows where visitors drop off on the way to a goal, such as finishing a task.` }),
        el('button', { type: 'button', text: (c.funnels || []).length ? 'Manage funnels' : 'Create a funnel', onclick: () => go('funnels') }),
      )),
      err,
      saveBar,
    );
    const dirty = () => (saveBar.hidden = false);
    form.addEventListener('input', dirty);
    form.addEventListener('change', dirty);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        const body = {
          name: name.value,
          domains: lines(domains.value),
          paused: paused.checked,
          retentionDays: retention.value === '' ? null : +retention.value,
          config: {
            mask: mask.checked,
            sampleRate: (+sample.value || 0) / 100,
            consent: consent.value,
            network: network.value,
            console: consoleErr.checked,
            features: Object.fromEntries(Object.entries(feats).map(([k, x]) => [k, x.checked])),
            ignore: lines(ignore.value),
            funnels: c.funnels || [],
          },
        };
        await api('sites/' + encodeURIComponent(s.id), {}, 'PUT', body);
        await loadSites();
        toast('Settings saved. Open pages pick them up within 5 minutes.');
        render();
      } catch (x) {
        err.textContent = x.message;
        toast(x.message, 'error');
      }
    });

    return [...header('Setup & settings', 'Install, settings and data for this site.'), el('div', { class: 'settings-grid' }, installCard(s, true), form, dataCard(s))];
  },
};

// ---------------- settings building blocks ----------------
const lines = (v) => v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

// ---------------- performance ----------------
/** Filters for the performance page; kept while moving around the dashboard. */
const perf = { dev: '', q: '', bad: false, sort: 'worst', open: new Set() };
/** [id, name, what it measures, explanation, [good, poor] thresholds, core web vital?] CLS is stored ×1000. */
const VITALS = [
  ['LCP', 'Largest Contentful Paint', 'Loading', 'Time until the main content, the biggest image or block of text, is on screen.', [2500, 4000], true],
  ['INP', 'Interaction to Next Paint', 'Responsiveness', 'Time from a click, tap or key press until the page visibly reacts. Only measured when visitors interact.', [200, 500], true],
  ['CLS', 'Cumulative Layout Shift', 'Visual stability', 'How much content jumps around while people look at it. 0 means nothing moved.', [100, 250], true],
  ['FCP', 'First Contentful Paint', 'Loading', 'Time until anything at all appears, such as a header or a spinner.', [1800, 3000], false],
  ['TTFB', 'Time to First Byte', 'Server', 'Time until the server starts sending the page. Slow servers delay everything else.', [800, 1800], false],
];
const RATING = { good: ['good', 'Good'], ni: ['warn', 'Needs improvement'], poor: ['bad', 'Poor'] };
const vfmt = (n, v) => {
  if (v == null) return '—';
  if (n === 'CLS') return (v / 1000).toFixed(2);
  return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' s' : Math.round(v) + ' ms';
};
/** Higher is worse: poor core vitals weigh most. 0 means nothing needs attention. */
const pageScore = (p) => VITALS.reduce((t, [n, , , , , core]) => t + ({ poor: 3, ni: 1 }[p.metrics[n]?.rating] || 0) * (core ? 2 : 1), 0);

/** Google's Core Web Vitals assessment: passed when LCP, INP and CLS are all good at p75. */
function assessment(sum) {
  const core = VITALS.filter((m) => m[5] && sum[m[0]]);
  if (!core.length) return null;
  const r = core.map((m) => sum[m[0]].rating);
  const [cls, title, text] = r.includes('poor')
    ? ['bad', 'Core Web Vitals: failed', 'At least one core metric is poor for a quarter of visits or more. Start with the red card below.']
    : r.every((x) => x === 'good')
      ? ['good', 'Core Web Vitals: passed', 'Loading, responsiveness and visual stability are all good for at least 3 in 4 visits.']
      : ['warn', 'Core Web Vitals: needs improvement', 'Nothing is poor, but at least one core metric is above the good threshold.'];
  const missing = VITALS.filter((m) => m[5] && !sum[m[0]]).map((m) => m[0]);
  return el(
    'div',
    { class: 'assess ' + cls },
    el('span', { class: 'assess-dot', 'aria-hidden': 'true' }),
    el('div', {}, el('strong', { text: title }), el('div', { class: 'small', text: text + (missing.length ? ` ${missing.join(' and ')} not measured yet.` : '') })),
    el('div', { class: 'assess-core' }, core.map((m) => el('span', { class: 'level ' + RATING[sum[m[0]].rating][0] }, el('i'), el('span', { text: `${m[0]} ${vfmt(m[0], sum[m[0]].p75)}` })))),
  );
}

function vitalCard([n, name, kind, what, [good, poor], core], s) {
  const limits = `Good ≤ ${vfmt(n, good)} · Poor > ${vfmt(n, poor)}`;
  if (!s)
    return el('div', { class: 'vcard none' }, el('div', { class: 'vc-top' }, el('span', { class: 'vc-id', text: n }), core ? el('span', { class: 'vc-core', text: 'Core' }) : null), el('div', { class: 'vc-name', text: `${name} · ${kind}` }), el('div', { class: 'vc-value muted', text: '—' }), el('p', { class: 'vc-what', title: what, text: what }), el('div', { class: 'vc-foot', text: n === 'INP' ? 'No interactions measured yet.' : 'Not measured yet.' }));
  const [cls, label] = RATING[s.rating] || ['', ''];
  const seg = (k, w, t) => (w ? el('i', { class: k, style: { width: w + '%' }, title: `${w}% ${t}` }) : null);
  return el(
    'div',
    { class: 'vcard r-' + cls },
    el('div', { class: 'vc-top' }, el('span', { class: 'vc-id', text: n }), core ? el('span', { class: 'vc-core', title: 'One of the three Core Web Vitals Google uses to rate a page', text: 'Core' }) : null, el('span', { class: 'badge ' + cls, text: label })),
    el('div', { class: 'vc-name', text: `${name} · ${kind}` }),
    el('div', { class: 'vc-value', text: vfmt(n, s.p75) }),
    el('div', { class: 'dist', role: 'img', 'aria-label': `${s.good}% good, ${s.ni}% needs improvement, ${s.poor}% poor` }, seg('good', s.good, 'good'), seg('ni', s.ni, 'need improvement'), seg('poor', s.poor, 'poor')),
    el('div', { class: 'dist-legend' }, el('span', { text: `${s.good}% good` }), el('span', { text: `${s.ni}% needs work` }), el('span', { text: `${s.poor}% poor` })),
    el('p', { class: 'vc-what', title: what, text: what }),
    el('div', { class: 'vc-foot' }, el('span', { title: `${limits} · ${fmt(s.n)} sample${s.n === 1 ? '' : 's'}`, text: `Good ≤ ${vfmt(n, good)}` }), s.slow ? el('button', { type: 'button', class: 'link', text: 'Watch slowest', onclick: () => openAt(s.slow) }) : null),
  );
}

function vitalPill(n, s) {
  if (!s) return el('td', { class: 'num muted', text: '—' });
  const [cls] = RATING[s.rating] || [''];
  const b = el('button', { type: 'button', class: 'vpill ' + cls, title: `75th percentile of ${fmt(s.n)} sample${s.n === 1 ? '' : 's'}, ${s.good}% good. Click to watch the slowest.`, text: vfmt(n, s.p75) });
  b.addEventListener('click', (e) => (e.stopPropagation(), s.slow && openAt(s.slow)));
  return el('td', { class: 'num' }, b);
}

function perfTable(rows, repaint) {
  const body = el('tbody');
  for (const p of rows) {
    const open = perf.open.has(p.route);
    const more = p.variants.length;
    const tr = el(
      'tr',
      { class: 'click' + (open ? ' open' : ''), 'aria-expanded': more ? String(open) : null, onclick: () => (more ? (open ? perf.open.delete(p.route) : perf.open.add(p.route), repaint()) : go('heatmap', { u: p.route })), title: more ? 'Show the addresses grouped here' : 'Open its heatmap' },
      el('td', {}, el('div', { class: 'route' }, more ? el('span', { class: 'chev', text: open ? '▾' : '▸' }) : el('span', { class: 'chev' }), el('code', { text: p.route }), more ? el('span', { class: 'badge', text: `${more} variants` }) : null)),
      el('td', { class: 'num', text: fmt(p.views) }),
      VITALS.map(([n]) => vitalPill(n, p.metrics[n])),
    );
    body.append(tr);
    if (open)
      for (const x of p.variants)
        body.append(el('tr', { class: 'variant click', onclick: () => go('heatmap', { u: x.u }), title: 'Open its heatmap' }, el('td', {}, el('code', { text: x.u })), el('td', { class: 'num', text: fmt(x.views) }), VITALS.map(([n]) => vitalPill(n, x.metrics[n]))));
  }
  return el('table', { class: 'perf' }, el('thead', {}, el('tr', {}, el('th', { text: 'Page' }), el('th', { class: 'num', text: 'Views' }), VITALS.map(([n, name]) => el('th', { class: 'num', title: name, text: n })))), body);
}

// ---------------- funnels ----------------
/** The site's recorded pages as paths a funnel step can use, busiest first. Ids become `*`. */
function pagePaths(pages) {
  const m = new Map();
  for (const x of pages) {
    const p = String(x.u).split(/[?#]/)[0].replace(/:id\b/g, '*') || '/';
    m.set(p, (m.get(p) || 0) + (x.views || 0));
  }
  return [...m].map(([p, views]) => ({ p, views })).sort((a, b) => b.views - a.views).slice(0, 30);
}

async function saveFunnels(list) {
  const s = await api('sites/' + encodeURIComponent(state.site));
  await api('sites/' + encodeURIComponent(state.site), {}, 'PUT', { config: { ...(s.config || {}), funnels: list } });
  await loadSites();
}

async function removeFunnel(f, all) {
  const yes = await confirmDialog({ title: `Delete “${f.name}”?`, body: 'It stops being measured and leaves this page. Visits already recorded are kept.', action: 'Delete funnel', danger: true });
  if (!yes) return;
  try {
    await saveFunnels(all.filter((x) => x !== f && x.name !== f.name));
    toast('Funnel deleted.');
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** The "what is this" panel. Open for a site with no funnels yet, otherwise a folded tip. */
function funnelIntro(first, create) {
  const bars = [
    ['Viewed', '/records', 100, null],
    ['Viewed', '/records/*', 62, '62% continue'],
    ['Clicked', '#save', 21, '34% continue'],
  ];
  const d = el(
    'details',
    { class: 'explain', open: first || localStorage.getItem('assist-funnel-help') !== 'closed' },
    el('summary', {}, el('strong', { text: 'What is a funnel?' }), el('span', { class: 'muted', text: first ? '' : ' A quick explanation' })),
    el(
      'div',
      { class: 'explain-body' },
      el(
        'div',
        { class: 'explain-text' },
        el('p', { class: 'lead', text: 'A funnel is the path you hope visitors follow to reach a goal, like Open a record → Review it → Save. Footsteps counts how many sessions get to each step, so you can see exactly where people give up.' }),
        el(
          'ol',
          { class: 'how' },
          el('li', {}, el('strong', { text: 'Pick a goal. ' }), 'Something you want people to finish: save a record, submit a form, complete a task.'),
          el('li', {}, el('strong', { text: 'List the steps in order. ' }), 'A step is either a page someone visits or a button they click.'),
          el('li', {}, el('strong', { text: 'Find the biggest drop. ' }), 'That is where to look first. Click any step to watch a recording of someone reaching it.'),
        ),
        el('p', { class: 'muted small', text: 'Each session counts once per step. Counting starts after you save, and pages pick up a new funnel within 5 minutes.' }),
        first ? el('button', { type: 'button', class: 'primary', text: 'Create your first funnel', onclick: create }) : null,
      ),
      el(
        'figure',
        { class: 'explain-ex', 'aria-label': 'Example funnel' },
        el('figcaption', {}, el('strong', { text: 'Example: Complete a task' }), el('span', { class: 'muted', text: ' sessions that reached each step' })),
        bars.map(([k, v, n, note]) =>
          el('div', { class: 'ex-row' }, el('div', { class: 'ex-top' }, el('span', {}, el('span', { class: 'fs-kind', text: k }), ' ', el('code', { text: v })), el('span', { class: 'ex-n', text: n })), el('div', { class: 'fbar' }, el('i', { style: { width: n + '%' } })), note ? el('div', { class: 'ex-note', text: note }) : null),
        ),
        el('p', { class: 'ex-tip', text: 'Most people leave between opening a record and saving it. That step is the one to investigate.' }),
      ),
    ),
  );
  if (!first) d.addEventListener('toggle', () => localStorage.setItem('assist-funnel-help', d.open ? 'open' : 'closed'));
  return d;
}

const stepLabel = (s, i) => (s ? [el('span', { class: 'fs-kind', text: s.startsWith('/') ? 'Viewed' : 'Clicked' }), ' ', el('code', { text: s })] : [el('span', { class: 'fs-kind', text: 'Step ' + (i + 1) })]);

/** One funnel: its steps with counts, what share continues, and where most people drop out. */
function funnelCard(f, d, { edit, remove, code } = {}) {
  const got = d?.steps || [];
  const n = f.steps.length || got.length;
  const steps = Array.from({ length: n }, (_, i) => ({ label: f.steps[i] || '', sessions: got[i]?.sessions || 0, at: got[i]?.at }));
  const start = steps[0]?.sessions || 0;
  let worst = -1;
  let worstLoss = 0;
  steps.forEach((s, i) => {
    const loss = i ? steps[i - 1].sessions - s.sessions : 0;
    if (loss > worstLoss) (worst = i), (worstLoss = loss);
  });
  const end = steps[n - 1]?.sessions || 0;
  const rows = steps.map((s, i) => {
    const prev = i ? steps[i - 1].sessions : 0;
    const loss = i ? Math.max(0, prev - s.sessions) : 0;
    const go = s.at ? () => openAt(s.at) : null;
    return el(
      'li',
      { class: 'fs' + (go ? ' click' : '') + (i === worst ? ' worst' : ''), onclick: go, title: go ? 'Watch the latest session that reached this step' : '' },
      el('span', { class: 'fs-i', text: i + 1 }),
      el(
        'div',
        { class: 'fs-main' },
        el('div', { class: 'fs-label' }, stepLabel(s.label, i), i === worst ? el('span', { class: 'badge bad', text: 'Biggest drop' }) : null),
        el('div', { class: 'fbar' }, el('i', { style: { width: (start ? (s.sessions / start) * 100 : 0) + '%' } })),
      ),
      el(
        'div',
        { class: 'fs-num' },
        el('div', { class: 'fs-count', text: fmt(s.sessions) }),
        i ? el('div', { class: 'fs-sub', text: prev ? `${Math.round((s.sessions / prev) * 100)}% of previous` : '—' }) : el('div', { class: 'fs-sub', text: 'started here' }),
        i && loss ? el('div', { class: 'fs-loss', text: `−${fmt(loss)} left` }) : null,
      ),
    );
  });
  return el(
    'section',
    { class: 'panel funnel' },
    el(
      'div',
      { class: 'funnel-head' },
      el('div', {}, el('h2', { text: f.name }), el('p', { class: 'muted small', text: start ? `${Math.round((end / start) * 100)}% of the ${fmt(start)} session${start === 1 ? '' : 's'} that started finished.` : 'No sessions yet: they appear after a visitor reaches the first step.' })),
      code ? el('span', { class: 'badge', title: 'Set in the page’s script tag or Assist.init, so it can’t be edited here', text: 'Defined in site code' }) : el('div', { class: 'funnel-actions' }, el('button', { type: 'button', text: 'Edit', onclick: edit }), el('button', { type: 'button', class: 'link danger', text: 'Delete', onclick: remove })),
    ),
    start
      ? factStrip([
          ['Started', fmt(start), 'Sessions that reached the first step'],
          ['Finished', fmt(end), 'Sessions that reached the last step'],
          ['Conversion', Math.round((end / Math.max(1, start)) * 100) + '%'],
          worst > 0 ? ['Biggest drop', el('span', { class: 'bad-text', text: `−${fmt(worstLoss)}` }), `${fmt(worstLoss)} left between step ${worst} and step ${worst + 1}`] : ['Biggest drop', 'None'],
        ])
      : null,
    el('ol', { class: 'fsteps' }, rows),
  );
}

/** Create or edit a funnel. Resolves after saving or cancelling. */
function editFunnel(existing, all, paths) {
  const rows = existing ? existing.steps.map((s) => ({ kind: s.startsWith('/') ? 'page' : 'click', value: s })) : [{ kind: 'page', value: '' }, { kind: 'page', value: '' }];
  const name = el('input', { value: existing?.name || '', maxlength: 60, placeholder: 'e.g. Complete a task', autocomplete: 'off', 'aria-label': 'Funnel name' });
  const list = el('ol', { class: 'steps' });
  const err = el('p', { class: 'form-error', role: 'alert' });
  const dl = el('datalist', { id: 'funnel-pages' }, paths.map((x) => el('option', { value: x.p })));
  const KINDS = [['page', 'Visits a page'], ['click', 'Clicks something']];

  const norm = (r) => {
    let v = r.value.trim();
    if (r.kind !== 'page') return v;
    if (/^https?:\/\//i.test(v)) {
      try {
        v = new URL(v).pathname;
      } catch {}
    }
    v = v.split(/[?#]/)[0];
    return v && !v.startsWith('/') ? '/' + v : v;
  };
  const hint = (r) => {
    const v = norm(r);
    if (r.kind === 'page') return !v ? 'A page path like /records. Use * for a changing part, e.g. /records/*.' : v.includes('*') ? `Counts a view of any page matching ${v}` : `Counts a view of ${v}`;
    return !v ? 'The selector of a button or link, like #save. Right-click it on your site, choose Inspect, and copy its id.' : `Counts a click on an element matching ${v}`;
  };

  const paint = (focus = -1) => {
    list.replaceChildren(
      ...rows.map((r, i) => {
        const input = el('input', { value: r.value, list: r.kind === 'page' ? 'funnel-pages' : null, placeholder: r.kind === 'page' ? '/records' : '#save', 'aria-label': `Step ${i + 1}: ${r.kind === 'page' ? 'page path' : 'element selector'}`, autocomplete: 'off', spellcheck: 'false' });
        const h = el('small', { class: 'muted', text: hint(r) });
        input.addEventListener('input', () => ((r.value = input.value), (h.textContent = hint(r)), (err.textContent = '')));
        const kind = el('select', { 'aria-label': `Step ${i + 1} type` }, KINDS.map(([v, t]) => el('option', { value: v, text: t, selected: v === r.kind })));
        kind.addEventListener('change', () => ((r.kind = kind.value), paint(i)));
        const mv = (d, text, label) => el('button', { type: 'button', class: 'icon', text, 'aria-label': label, disabled: i + d < 0 || i + d >= rows.length, onclick: () => (([rows[i], rows[i + d]] = [rows[i + d], rows[i]]), paint()) });
        return el(
          'li',
          { class: 'step-row' },
          el('span', { class: 'step-n', text: i + 1 }),
          el('div', { class: 'step-body' }, el('div', { class: 'step-inputs' }, kind, input), h),
          el('div', { class: 'step-ctl' }, mv(-1, '↑', `Move step ${i + 1} up`), mv(1, '↓', `Move step ${i + 1} down`), el('button', { type: 'button', class: 'icon', text: '×', 'aria-label': `Remove step ${i + 1}`, disabled: rows.length <= 2, onclick: () => (rows.splice(i, 1), paint()) })),
        );
      }),
    );
    if (focus >= 0) list.children[focus]?.querySelector('input')?.focus();
  };
  const addPage = (p) => {
    const blank = rows.find((r) => r.kind === 'page' && !r.value.trim());
    if (blank) blank.value = p;
    else rows.push({ kind: 'page', value: p });
    paint();
  };

  const TEMPLATES = [
    ['Complete a task', [['page', '/records'], ['page', '/records/*'], ['click', '#save']]],
    ['Submit a request', [['page', '/requests'], ['click', '#submit']]],
    ['Review a record', [['page', '/queue'], ['page', '/queue/*'], ['click', '#done']]],
  ];
  const tpl = !existing
    ? el(
        'div',
        { class: 'chips-row' },
        el('span', { class: 'muted small', text: 'Start from an example:' }),
        TEMPLATES.map(([t, steps]) =>
          el('button', { type: 'button', class: 'chip', text: t, onclick: () => ((name.value ||= t), rows.splice(0, rows.length, ...steps.map(([kind, value]) => ({ kind, value }))), paint(0)) }),
        ),
      )
    : null;
  const mine = paths.length
    ? el('div', { class: 'chips-row' }, el('span', { class: 'muted small', text: 'Your busiest pages, click to add:' }), paths.slice(0, 6).map((x) => el('button', { type: 'button', class: 'chip', title: `${fmt(x.views)} views`, text: x.p, onclick: () => addPage(x.p) })))
    : null;

  const d = el('dialog', { class: 'modal wide' });
  const save = el('button', { type: 'submit', class: 'primary', text: existing ? 'Save funnel' : 'Create funnel' });
  const form = el(
    'form',
    { method: 'dialog', novalidate: true },
    el('h2', { text: existing ? 'Edit funnel' : 'New funnel' }),
    el('p', { text: 'Name the goal, then list the steps visitors take to reach it, in order. Each step is a page they visit or something they click.' }),
    field('Name', name),
    tpl,
    el('div', { class: 'field-label', text: 'Steps' }),
    list,
    el('button', { type: 'button', class: 'add-step', text: '+ Add step', onclick: () => (rows.push({ kind: 'page', value: '' }), paint(rows.length - 1)) }),
    mine,
    existing ? el('p', { class: 'notice warn small', text: 'Counts are kept per step position. After reordering or replacing steps, earlier numbers may not line up with the new steps.' }) : null,
    err,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', text: 'Cancel', onclick: () => d.close() }), save),
    dl,
  );
  d.append(form);
  paint();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const nm = name.value.trim();
    const steps = rows.map(norm);
    const bad = rows.findIndex((r, i) => !steps[i]);
    const dup = all.some((f) => f !== existing && f.name.toLowerCase() === nm.toLowerCase());
    const sel = rows.findIndex((r, i) => {
      if (r.kind !== 'click' || !steps[i]) return false;
      if (steps[i].startsWith('/')) return true;
      try {
        document.querySelector(steps[i]);
        return false;
      } catch {
        return true;
      }
    });
    if (!nm) return void (err.textContent = 'Give the funnel a name.');
    if (dup) return void (err.textContent = `You already have a funnel called “${nm}”.`);
    if (bad >= 0) return void ((err.textContent = `Step ${bad + 1} is empty. Fill it in or remove it.`), list.children[bad]?.querySelector('input')?.focus());
    if (sel >= 0) return void ((err.textContent = `Step ${sel + 1} isn’t a valid selector. Use something like #save or .submit, or switch the step to “Visits a page”.`), list.children[sel]?.querySelector('input')?.focus());
    save.disabled = true;
    try {
      const next = { name: nm, steps };
      await saveFunnels(existing ? all.map((f) => (f === existing ? next : f)) : [...all, next]);
      d.close();
      toast('Funnel saved. Open pages pick it up within 5 minutes.');
      render();
    } catch (x) {
      err.textContent = x.message;
      save.disabled = false;
    }
  });
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  name.focus();
}
function field(label, control, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 8);
  const target = control.matches?.('input,select,textarea') ? control : control.querySelector('input,select,textarea');
  target?.setAttribute('id', id);
  if (hint) target?.setAttribute('aria-describedby', id + 'h');
  return el('div', { class: 'field' }, el('label', { for: id, text: label }), control, hint ? el('small', { id: id + 'h', text: hint }) : null);
}
const toggle = (input, label, hint) => el('label', { class: 'toggle' }, input, el('span', {}, el('strong', { text: label }), hint ? el('small', { text: hint }) : null));
const select = (opts, v) => el('select', {}, opts.map(([k, t]) => el('option', { value: k, text: t, selected: k === v })));
const section = (title, ...kids) => el('section', { class: 'panel', id: 'sec-' + title.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '') }, el('h2', { text: title }), ...kids);

/** Embed snippet, keys, connection status and refused domains. */
function installCard(s, compact = false) {
  const snippet = s.snippet;
  const refused = s.rejected.length
    ? el(
        'div',
        { class: 'notice warn' },
        el('strong', { text: 'Refused: pages on these hosts used this site’s key but aren’t in its domains.' }),
        el(
          'ul',
          {},
          s.rejected.map((r) =>
            el(
              'li',
              {},
              el('code', { text: r.host }),
              el('span', { class: 'muted', text: ` ${r.n} request${r.n === 1 ? '' : 's'}, last ${ago(r.last)} ` }),
              r.host !== '(no origin)'
                ? el('button', {
                    type: 'button',
                    text: 'Allow this domain',
                    onclick: async () => {
                      try {
                        await api(`sites/${encodeURIComponent(s.id)}/domains`, {}, 'POST', { domain: r.host });
                        await loadSites();
                        toast(`${r.host} added. Its pages start sending within 5 minutes.`);
                        render();
                      } catch (x) {
                        toast(x.message, 'error');
                      }
                    },
                  })
                : null,
            ),
          ),
        ),
      )
    : null;
  const status =
    s.status === 'waiting'
      ? el('div', { class: 'waiting' }, el('i'), el('span', { text: 'Waiting for the first event. Open a page with the script and this updates by itself.' }))
      : el('p', { class: 'muted' }, statusBadge(s), ` Last event ${ago(s.lastEvent)} · ${fmt(s.stored)} events stored`);
  const keys = el(
    'ul',
    { class: 'keys' },
    s.keys.map((k, i) =>
      el(
        'li',
        {},
        el('code', { text: k }),
        i === 0 ? el('span', { class: 'badge', text: 'in snippet' }) : el('span', { class: 'muted', text: 'still accepted' }),
        copyBtn(k),
        i > 0
          ? el('button', {
              type: 'button',
              class: 'link danger',
              text: 'Revoke',
              onclick: async () => {
                if (!(await confirmDialog({ title: 'Revoke this key?', body: 'Pages still using it stop sending data at once.', action: 'Revoke key', danger: true }))) return;
                try {
                  await api(`sites/${encodeURIComponent(s.id)}/keys/${encodeURIComponent(k)}`, {}, 'DELETE');
                  await loadSites();
                  toast('Key revoked.');
                  render();
                } catch (x) {
                  toast(x.message, 'error');
                }
              },
            })
          : null,
      ),
    ),
  );
  const rotate = el('button', {
    type: 'button',
    text: 'New key',
    onclick: async () => {
      if (!(await confirmDialog({ title: 'Create a new key?', body: 'The snippet switches to the new key. The old one keeps working until you revoke it, so update your pages first.', action: 'Create key' }))) return;
      await api(`sites/${encodeURIComponent(s.id)}/keys`, {}, 'POST');
      await loadSites();
      toast('New key created. Update the snippet on your pages, then revoke the old key.');
      render();
    },
  });
  return el(
    'section',
    { class: 'panel install' },
    el('h2', { text: 'Install' }),
    status,
    refused,
    el('p', { text: 'Paste this into every page, ideally just before </head>:' }),
    el('div', { class: 'snippet' }, el('pre', {}, el('code', { text: snippet })), copyBtn(snippet, 'Copy snippet')),
    el(
      'ul',
      { class: 'install-facts' },
      el('li', { text: 'The script is built to stay under 12 KB gzipped.' }),
      el('li', { text: 'Recordings stay on this server.' }),
      el('li', { text: maskFacts(!!s.config?.mask) }),
    ),
    compact ? el('details', {}, el('summary', { text: 'Keys' }), el('p', { class: 'muted', text: 'Keys are public (they appear in your pages). What protects the site is the domain list.' }), keys, rotate) : null,
    compact ? el('details', {}, el('summary', { text: 'On-site heatmap' }), el('p', {}, 'Open any page of this site with ', el('code', { text: `?assist-heatmap=${state.token}` }), ' to see the heat layer on the live page.')) : null,
  );
}

/** Erase a visitor and delete the site. */
function dataCard(s) {
  const vid = el('input', { placeholder: 'Visitor id', 'aria-label': 'Visitor id', class: 'wide', autocomplete: 'off', spellcheck: 'false' });
  return el(
    'section',
    { class: 'panel danger-zone' },
    el('h2', { text: 'Danger zone' }),
    el('div', { class: 'field' }, el('label', { text: 'Erase a visitor' }), el('div', { class: 'row' }, vid, el('button', {
      type: 'button',
      text: 'Erase',
      onclick: async () => {
        const v = vid.value.trim();
        if (!v) return vid.focus();
        if (!(await confirmDialog({ title: 'Erase this visitor?', body: `Every event recorded for ${v} on ${s.name} is deleted. This can't be undone.`, action: 'Erase', danger: true }))) return;
        try {
          const r = await api('visitor/' + encodeURIComponent(v), {}, 'DELETE');
          toast(`Erased ${r.erased} events.`);
          vid.value = '';
        } catch (x) {
          toast(x.message, 'error');
        }
      },
    })), el('small', { text: 'For data-deletion requests. The visitor id is on each session.' })),
    el('div', { class: 'field' }, el('label', { text: 'Delete this site' }), el('div', {}, el('button', {
      type: 'button',
      class: 'danger',
      text: 'Delete site and all its data',
      onclick: async () => {
        if (!(await confirmDialog({ title: `Delete ${s.name}?`, body: `All ${fmt(s.stored)} events, recordings and snapshots are deleted, and pages using its key stop sending. This can't be undone.`, action: 'Delete site', danger: true, typed: s.name }))) return;
        try {
          await api('sites/' + encodeURIComponent(s.id), {}, 'DELETE');
          toast(`${s.name} deleted.`);
          state.site = '';
          localStorage.removeItem('assist-site');
          await loadSites();
          go('sites');
        } catch (x) {
          toast(x.message, 'error');
        }
      },
    }))),
  );
}

const NAV = [
  ['Insights', [['overview', 'Overview'], ['people', 'People'], ['sessions', 'Sessions'], ['heatmap', 'Heatmaps'], ['frustration', 'Frustration'], ['errors', 'Errors'], ['forms', 'Forms'], ['funnels', 'Funnels'], ['performance', 'Performance']]],
  ['Site', [['settings', 'Setup & settings']]],
];
/** Views that aren't about one site. */
const GLOBAL = new Set(['sites', 'site-new', 'users']);
/** Views that honour the date range. */
const RANGED = new Set(['overview', 'heatmap', 'frustration', 'errors', 'forms', 'funnels', 'performance', 'sessions']);
const RANGES = [['24h', '24 h'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']];
const RANGE_LABEL = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All stored data' };

/** Navigate. Site views carry the site id (`s`) so links can be shared. */
function go(view, params = {}) {
  const all = GLOBAL.has(view) ? params : { s: state.site, ...params };
  const q = new URLSearchParams(Object.entries(all).filter(([, v]) => v != null && v !== ''));
  location.hash = view + (q.size ? '?' + q : '');
}

function setSite(id) {
  if (id === state.site) return;
  state.site = id;
  if (id) localStorage.setItem('assist-site', id);
  renderSwitcher();
}
function openSite(id, view = 'overview') {
  setSite(id);
  go(view);
}

// ---------------- site switcher ----------------
function renderSwitcher() {
  const box = $('#switcher');
  const global = GLOBAL.has(currentView());
  const cur = global ? null : siteNow();
  const dot = (s) => el('i', { class: 'dot s-' + (s.live ? 'live' : s.status), title: s.live ? 'Visitors on it now' : STATUS[s.status][1] });
  const pop = el('div', { class: 'switch-pop', hidden: true, role: 'menu' });
  const btn = el(
    'button',
    { type: 'button', class: 'switch-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    cur ? dot(cur) : null,
    el('span', { class: 'switch-name', text: cur ? cur.name : global ? 'All sites' : 'Choose a site' }),
    el('span', { class: 'chev', 'aria-hidden': 'true', text: '▾' }),
  );
  const close = () => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => !box.contains(e.target) && close();
  const item = (label, sub, onclick, lead, current) =>
    el('button', { type: 'button', role: 'menuitem', class: 'switch-item' + (current ? ' on' : ''), onclick: () => (close(), onclick()) }, lead || el('i', { class: 'dot none' }), el('span', {}, el('span', { text: label }), sub ? el('small', { text: sub }) : null));
  const search = el('input', { type: 'search', placeholder: 'Find a site', 'aria-label': 'Find a site' });
  const list = el('div', { class: 'switch-list' });
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren(
      ...state.sites
        .filter((s) => !q || s.name.toLowerCase().includes(q) || s.domains.some((d) => d.includes(q)))
        .map((s) => item(s.name, s.live ? `${s.live} live now` : s.domains[0], () => openSite(s.id, global || currentView() === 'session' ? 'overview' : currentView()), dot(s), !global && s.id === state.site)),
    );
  };
  search.addEventListener('input', fill);
  pop.append(
    ...[
      item('All sites', `${state.sites.length} site${state.sites.length === 1 ? '' : 's'}`, () => go('sites'), el('i', { class: 'dot grid' })),
      state.sites.length > 6 ? search : null,
      list,
      el('hr'),
      item('Add a site', '', () => go('site-new'), el('i', { class: 'dot plus', text: '+' })),
    ].filter(Boolean),
  );
  fill();
  btn.addEventListener('click', () => {
    if (!pop.hidden) return close();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    addEventListener('pointerdown', outside, true);
    (state.sites.length > 6 ? search : list.querySelector('.on') || list.firstChild)?.focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) (close(), btn.focus());
  });
  box.replaceChildren(btn, pop);
  // Site views make no sense without a site: hide them on the global pages.
  $('#nav').classList.toggle('no-site', global || !state.site);
}
const currentView = () => (location.hash.slice(1) || '').split('?')[0] || 'overview';

function rangeControl(view, params) {
  return el(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Date range' },
    RANGES.map(([v, t]) =>
      el('button', {
        type: 'button',
        'aria-pressed': v === state.range,
        text: t,
        onclick: () => {
          state.range = v;
          localStorage.setItem('assist-range', v);
          render();
        },
      }),
    ),
  );
}

// ---------------- live stream ----------------
// Views either handle events themselves (the session page sets `live.onEvent`)
// or, for the report views below, are quietly re-rendered a moment after new data.
const live = { es: null, onEvent: null };
// Performance is left out: it has a search box, and vitals change too slowly to need it.
const SOFT = new Set(['overview', 'people', 'frustration', 'errors', 'forms', 'funnels', 'sessions', 'sites']);

let liveFor = null;
function connectLive(site) {
  if (live.es && liveFor === site) return;
  liveFor = site;
  live.es?.close();
  const box = $('#live');
  const txt = box.querySelector('span');
  box.className = 'live-status';
  txt.textContent = 'Connecting…';
  const es = new EventSource('/api/stream?' + new URLSearchParams({ site }));
  live.es = es;
  es.onerror = () => {
    box.className = 'live-status off';
    txt.textContent = 'Reconnecting…';
  };
  es.onmessage = (m) => {
    let d;
    try {
      d = JSON.parse(m.data);
    } catch {
      return;
    }
    box.className = 'live-status on' + (d.k === 'ev' ? ' blip' : '');
    if (d.k === 'ev') setTimeout(() => box.classList.remove('blip'), 700);
    txt.textContent = d.live ? `Live · ${d.live} active session${d.live === 1 ? '' : 's'}` : site === '*' ? 'Live · no one on your sites' : 'Live · no one on the site';
    // A site getting its first event leaves the "waiting" state: refresh its card / install panel.
    if (d.k === 'ev') {
      const s = state.sites.find((x) => x.id === d.site);
      if (s && s.status === 'waiting') loadSites().then(() => ['overview', 'settings', 'sites'].includes(currentView()) && render());
    }
    if (d.k !== 'hello') live.onEvent?.(d);
  };
}

let viewGen = 0;
async function render() {
  const gen = ++viewGen;
  live.onEvent = null;
  let [view, qs] = (location.hash.slice(1) || '').split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  if (!views[view]) view = state.site ? 'overview' : 'sites';
  if (!GLOBAL.has(view)) {
    // A shared link names its site; otherwise stay on the current one.
    if (params.s && state.sites.some((s) => s.id === params.s)) setSite(params.s);
    if (!state.site) return go('sites');
    if (params.s !== state.site) return history.replaceState(null, '', '#' + view + '?' + new URLSearchParams({ ...params, s: state.site })), render();
  }
  connectLive(GLOBAL.has(view) ? '*' : state.site);
  renderSwitcher();
  const active = view === 'session' ? 'sessions' : view;
  for (const a of $('#nav').querySelectorAll('a')) a.dataset.v === active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  const fn = () => views[view](params);
  const withTools = (nodes) => {
    if (!RANGED.has(view) || params.sid) return nodes;
    const slot = nodes.find((n) => n.classList?.contains('ph'))?.querySelector('.ph-actions');
    if (slot) return slot.append(rangeControl()), nodes;
    return [el('div', { class: 'tools' }, rangeControl()), ...nodes];
  };
  const main = mainEl();
  if (!main) return showLogin();
  main.replaceChildren(el('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' }, el('i'), el('i'), el('i')));
  try {
    const nodes = withTools((await fn()).flat().filter(Boolean));
    if (gen !== viewGen) return;
    main.replaceChildren(...nodes);
    main.focus({ preventScroll: true });
    if (!live.onEvent && SOFT.has(view) && !params.sid) {
      let t = 0;
      let busy = false;
      live.onEvent = (d) => {
        // Ticks only matter to the sessions list (a session can go quiet without new events).
        if (d.k === 'snap' || (d.k === 'tick' && view !== 'sessions')) return;
        // Throttle, not debounce: a steady stream of events must still refresh the view.
        if (t) return;
        t = setTimeout(async () => {
          t = 0;
          if (busy || gen !== viewGen) return;
          // Don't rebuild the page under someone who is typing in a filter box.
          if (main.contains(document.activeElement) && document.activeElement.matches?.('input[type=search],input[type=text]')) return;
          busy = true;
          try {
            const y = scrollY;
            const next = withTools((await fn()).flat().filter(Boolean));
            if (gen !== viewGen) return;
            main.replaceChildren(...next);
            scrollTo(0, y);
          } catch {
          } finally {
            busy = false;
          }
        }, 800);
      };
    }
  } catch (e) {
    if (e instanceof AuthRequired) return showLogin();
    if (gen !== viewGen) return;
    main.replaceChildren(el('div', { class: 'empty error-state' }, el('strong', { text: 'This page could not load.' }), el('p', { text: e.message }), el('button', { type: 'button', text: 'Try again', onclick: () => render() })));
  }
}

function setShellVisible(on) {
  document.body.classList.toggle('authed', on);
  document.body.classList.toggle('login-screen', !on);
}

let hashBound = false;

function renderAccount() {
  const box = $('#account');
  if (!box || !state.user) return;
  box.hidden = false;
  box.replaceChildren(
    el('div', { class: 'account-who' }, el('strong', { text: state.user.username }), el('span', { text: state.user.role === 'admin' ? 'Admin' : 'User' })),
    state.user.role === 'admin' ? el('button', { type: 'button', class: 'link account-link', text: 'Manage users', onclick: () => go('users') }) : null,
    el('button', {
      type: 'button',
      class: 'link account-link',
      text: 'Sign out',
      onclick: async () => {
        try {
          await api('auth/logout', { site: '', range: '' }, 'POST', {});
        } catch {
        }
        live.es?.close();
        live.es = null;
        state.user = null;
        showLogin();
      },
    }),
  );
}

function bindLoginForm(form) {
  if (!form || form.dataset.bound === '1') return form;
  form.dataset.bound = '1';
  const user = form.querySelector('[name=username]');
  const pass = form.querySelector('[name=password]');
  const err = $('#login-error') || form.querySelector('.login-error');
  const goBtn = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (err) err.textContent = '';
    if (goBtn) {
      goBtn.disabled = true;
      goBtn.textContent = 'Signing in…';
    }
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user.value, password: pass.value }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'Sign in failed.');
      state.user = body.user;
      document.title = 'Footsteps';
      await enterApp();
    } catch (x) {
      if (err) err.textContent = x.message;
      if (goBtn) {
        goBtn.disabled = false;
        goBtn.textContent = 'Sign in';
      }
      pass?.focus();
      pass?.select();
    }
  });
  return form;
}

function showLogin(message = '') {
  setShellVisible(false);
  document.body.classList.remove('boot-pending');
  document.body.classList.add('login-screen');
  live.es?.close();
  live.es = null;
  document.title = 'Footsteps — Sign in';

  // Prefer the static login markup so the first paint is already the sign-in screen.
  let form = $('#login-form');
  if (!form || !$('#login-root')) {
    document.body.replaceChildren(
      el(
        'div',
        { class: 'login-page', id: 'login-root' },
        el('div', { class: 'login-glow', 'aria-hidden': 'true' }),
        el(
          'form',
          { class: 'login-card', id: 'login-form', novalidate: true },
          el('div', { class: 'login-brand' }, el('img', { src: '/dashboard/favicon.svg', alt: '', width: '36', height: '36' }), el('div', {}, el('strong', { text: 'Footsteps' }), el('span', { text: 'Sign in to continue' }))),
          el('label', { class: 'field' }, el('span', { text: 'Username' }), el('input', { name: 'username', autocomplete: 'username', required: true, maxlength: '40', placeholder: 'Username' })),
          el('label', { class: 'field' }, el('span', { text: 'Password' }), el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' })),
          el('p', { class: 'login-error', id: 'login-error', role: 'alert' }),
          el('button', { type: 'submit', class: 'primary login-submit', text: 'Sign in' }),
        ),
        el('p', { class: 'login-foot', text: 'Authorized users only' }),
      ),
    );
    form = $('#login-form');
  }
  bindLoginForm(form);
  const err = $('#login-error');
  if (err && message) err.textContent = message;
  setTimeout(() => form.querySelector('[name=username]')?.focus());
}

async function enterApp() {
  document.body.classList.remove('boot-pending', 'login-screen');
  document.body.replaceChildren(
    el('a', { class: 'skip', href: '#main', text: 'Skip to content' }),
    el(
      'aside',
      { class: 'side' },
      el('div', { class: 'brand' }, el('img', { src: '/dashboard/favicon.svg', alt: '', width: '22', height: '22' }), 'Footsteps ', el('span', { text: 'insights' })),
      el('div', { id: 'switcher', class: 'switcher' }),
      el('nav', { id: 'nav', 'aria-label': 'Views' }),
      el(
        'div',
        { class: 'side-foot' },
        el('div', { id: 'account', class: 'account' }),
        el('div', { id: 'live', class: 'live-status', role: 'status', 'aria-live': 'polite' }, el('i'), el('span', { text: 'Connecting…' })),
        el('div', { id: 'ver', class: 'ver' }),
      ),
    ),
    el('main', { id: 'main', tabindex: '-1' }, el('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' }, el('i'), el('i'), el('i'))),
    el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }),
  );
  setShellVisible(true);
  $('#nav').replaceChildren(
    ...NAV.map(([group, items]) =>
      el('div', { class: 'nav-group' }, el('div', { class: 'nav-label', text: group }), items.map(([v, t]) => el('a', { href: '#' + v, 'data-v': v, text: t, onclick: (e) => (e.preventDefault(), go(v)) }))),
    ),
  );
  renderAccount();
  try {
    state.meta = await api('meta');
    state.token = state.meta.token;
    if (state.meta.user) state.user = state.meta.user;
    $('#ver').textContent = 'v' + state.meta.version;
    await loadSites();
  } catch (e) {
    if (e instanceof AuthRequired) return showLogin();
    const mainEl = $('#main');
    mainEl.replaceChildren(el('div', { class: 'empty error-state' }, el('strong', { text: 'Cannot reach the Footsteps server.' }), el('p', { text: e.message }), el('button', { type: 'button', text: 'Try again', onclick: () => location.reload() })));
    return;
  }
  const remembered = localStorage.getItem('assist-site');
  const byActivity = [...state.sites].sort((a, b) => b.lastEvent - a.lastEvent);
  state.site = state.sites.some((s) => s.id === remembered) ? remembered : byActivity[0]?.id || '';
  if (!hashBound) {
    addEventListener('hashchange', render);
    hashBound = true;
  }
  render();
}

async function boot() {
  // HTML starts in boot-pending (spinner, form hidden) so a signed-in refresh
  // never flashes the login card, and a signed-out visit still lands on login.
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (me.status === 401) {
      showLogin();
      return;
    }
    if (!me.ok) {
      showLogin('Could not reach the Footsteps server.');
      return;
    }
    state.user = (await me.json()).user;
    await enterApp();
  } catch (e) {
    showLogin(e.message || 'Could not reach the Footsteps server.');
  }
}
boot();
