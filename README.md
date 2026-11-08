# Footsteps — embeddable behavior analytics

One `<script>` tag. Footsteps watches how people use a page (clicks, scrolling, forms, errors, performance) and notices struggle (rage clicks, dead clicks, validation loops, error clicks, wandering). It records that behavior and shows it in a local dashboard. It does not change the page and it does not call a model.

- `dist/assist.js` is the core: **≤ 12 KB gzipped**, no dependencies, patches nothing by default. Everything else is a content-hashed chunk loaded on demand.
- AI runs through a local **bridge** (Node) that drives the Cursor CLI on this machine. Without the bridge, everything except AI answers still works (rules, tips, tours, analytics).
- The bridge stores events and serves a **dashboard** (heatmaps, frustration, errors, forms, funnels, vitals, session recordings).

## Quick start

```bash
npm install
npm run build        # dist/assist.js + chunks, then check sizes with npm run check:size
npm run bridge       # http://localhost:7821  (collector, AI, dashboard, serves dist/)
npm run demo         # http://localhost:5173  (demo site with planted UX problems)
```

Open the demo, struggle a little (wrong date format on *Apply*, the dead *Filters* button on *Products*, *Save* on *Settings*), then open the dashboard at `http://localhost:7821/dashboard`. A fresh install starts with a *Local development* site that accepts `localhost` on any port with the key `local-dev-site-key`.

## Sites

One server collects for any number of websites. Each site has a name, one or more **site keys**, the **domains** allowed to send data with them, its own settings and its own retention.

In the dashboard: the switcher at the top left moves between sites; *All sites* shows every site's traffic, errors and frustration side by side; *Add a site* creates one and shows its embed snippet; *Setup & settings* covers install, recording and privacy, funnels, errors, data retention, pausing, key rotation and deletion. Every view has a date range (24 h, 7 days, 30 days, all).

A batch is accepted only when its key belongs to a site **and** the page's host (from `Origin`, else `Referer`) is one of that site's domains. Domains are hosts with an optional port: `shop.example.com`, `*.example.com` (any subdomain), `localhost:3000`, `localhost:*` (any port). Pages turned away are listed on the site's settings with a one-click *Allow*, so a missing domain is easy to spot. A paused site keeps its data but drops new events, and its pages switch the script off.

Settings changes reach open pages within 5 minutes (the script caches `/config`). Rotating a key keeps the old one working until you remove it, so you can update embeds first.

## Embed

Copy the snippet from the site's *Setup & settings* page. That one tag is the whole install:

```html
<script defer src="https://insights.example.com/assist.js" data-key="pk_…"></script>
```

`defer` runs it before the page's own modules. Funnels, masking, and sampling are set on the site in the dashboard and arrive through `/config`. Nobody is named until that same tag says where the signed-in person is:

```html
<script defer src="https://insights.example.com/assist.js" data-key="pk_…" data-who="/passport|currentIdentity.userIdentifier|currentIdentity.displayName|currentIdentity.email"></script>
```

`data-who` is the request to read, then the id path, the name path, and the email path. Those three fields are taken from that response and nowhere else.

Chunks load from the same folder as `assist.js`; events go to the script's origin unless `endpoint` says otherwise.

## Configuration

Sources, later wins: defaults → cached remote config (the site's settings in the dashboard) → `data-*` attributes → `window.AssistConfig` → `Assist.init({...})`.

`data-*` attributes: `data-key`, `data-endpoint`, `data-site`, `data-consent`, `data-sample-rate`, `data-network`, `data-nonce`, `data-preload="analytics,replay"`, `data-features="analytics,replay"`, `data-debug`, `data-who`.

| Option | Default | Meaning |
| --- | --- | --- |
| `consent` | `'auto'` | `auto` (no storage until a consent signal like GPC/DNT says no), `required` (nothing stored or sent until `Assist.consent(true)`), `none`. |
| `sampleRate` | `1` | Share of sessions that record analytics. |
| `network` | `'observe'` | `observe` (resource timing, patches nothing), `wrap` (chain-safe fetch/XHR wrapper), `off`. See [Errors](#errors). |
| `console` | `false` | Also capture `console.error`. |
| `features.*` | all `true` | `analytics, heatmaps, errors, forms, vitals, snapshots, replay`. |
| `funnels` | `[]` | `{ name, steps: ['/path', '#selector', ...] }`. |
| `ignore` | `[]` | Selectors never captured (same as `data-assist-ignore`). |
| `remoteConfig` | `true` | Fetch `/config` from the bridge (cached 5 min; `disabled: true` there is a kill switch). |

Markup hooks: `data-assist-ignore` (never captured), `data-assist-sensitive` (treated like a password field), `data-assist-unmask` (text may appear in snapshots), `data-assist-id` (stable fingerprint).

## API

```js
Assist.init(opts)                     // merge config (before or after load)
Assist.track('plan_selected', { plan: 'pro' })
Assist.identify('user-42', { name: 'Ada', email: 'ada@example.com' })
// Optional. Prefer data-who on the script tag; that is how a visitor gets a name.
// The id stays an id: a bare email is stored as their email, never as the id.
// Find them under People. Earlier anonymous visits from the same browser are included.
Assist.consent(true | false)
Assist.on('struggle', ({ level, score, signal }) => {})   // also: frustration, error, route, deadClick
Assist.getSessionInsights()           // { score, level, hotspots, signals, errors, session, stats }
Assist.destroy()
```

Integrator mode: `?assist-heatmap=<dashboard token>` overlays heatmaps on the live page.

## Privacy

- **Masking is off by default** (`mask: false`, or `data-mask="false"` on the script tag). DOM snapshots copy the page as the visitor saw it, with real text, images and current field values. Recordings replay typed field values as they change. Password, hidden and file inputs are never recorded. Set `data-mask="true"` to go back to the masked mode below.
- With `mask: true`, snapshots mask all text except labels, headings, buttons and links and drop input values and images, and recordings carry no field values.
- Either way, snapshots drop scripts and inline handlers and neutralize links, and anything marked `data-assist-ignore` is left out.
- Form analytics describe fields by length and character class only (for example "5 digits").
- Telemetry text (labels, error messages, titles, stack frames) passes the redactor: emails, card numbers, SSNs, phone numbers, IBANs, long numbers and tokens are masked. Resource URLs drop query values and turn ids into `:id`. The page URL kept for replay and snapshots keeps its query string, so two dialogs on the same screen stay separate.
- Element fingerprints (`selector|role|name`) only carry a name for controls, headings and labels, never for arbitrary text.
- The server keeps raw events for each site's retention (default `ASSIST_RETENTION_DAYS`, 30), purged at startup and every 6 hours, and the dashboard can erase a visitor.

## Frustration scoring

Direct signals (rage, dead, error and disabled clicks, validation loops, input thrash, resubmits) always count. Context signals are ambiguous on their own and score nothing unless corroborated within 20 seconds, either by a direct signal or by context from two other groups:

- navigation: U-turns, back-and-forth loops, repeated reloads, quick back
- motion: erratic cursor, long hover, wandering, fake-link clicks
- focus: idle, leaving the tab, zooming, pasting, tab cycling

Once corroborated, the earlier pending signals are credited too. Uncredited ones still appear in the session timeline, marked as hints. Detectors are tuned against normal browsing: a U-turn needs a different page, a stay under 5 s and no interaction there; a refresh signal needs 3 reloads in a minute; disabled-click needs two clicks in 8 s; thrash counts separate deletion bursts and ignores clearing a search box.

## Errors

JavaScript errors, unhandled rejections, failed resources, validation messages and visible error text are captured with breadcrumbs and grouped by fingerprint. The assistant's own errors are never reported as the site's.

Network failures: by default (`network: 'observe'`) they come from resource timing, which patches nothing. Chromium only creates that entry once the response body has been read, so a failed `fetch` whose body the site never reads is not seen. Set `network: 'wrap'` (or `data-network="wrap"`) to install a chain-safe `fetch`/XHR wrapper that sees every failure; it stacks with Sentry, Datadog and zone.js, keeps `fetch.name`, and is covered by the compat tests.

## CSP and Trusted Types

Footsteps builds its UI without `innerHTML`, uses constructable stylesheets inside Shadow DOM, and creates one Trusted Types policy named `assist` that only vouches for its own worker URL. A strict policy needs:

```
script-src  <assist origin>
connect-src <bridge/endpoint origin>
worker-src  <assist origin> blob:
trusted-types assist          (if you use require-trusted-types-for 'script')
```

No `unsafe-inline` or `unsafe-eval` is required. If constructable stylesheets are unavailable, set `data-nonce` so the fallback `<style>` carries your nonce. If workers are blocked, compression and aggregation fall back to idle time on the main thread.

## Events (wire format)

Batches are gzip-compressed JSON `{ v: 1, sid, vid, pid, site, u, dev, grp, bot, ver, ev: [...] }`. Each event has `t` (type) and `ts` (ms since page view):

| `t` | Event |
| --- | --- |
| `pv` | Page view: normalized URL, title, referrer, viewport, connection, language. |
| `c` | Click: element fingerprint, relative and page position, device. |
| `mv`, `sd`, `vis`, `hv` | Move grid, scroll depth, element visibility and hover dwell. |
| `f` | Frustration signal: `k` = `rage, dead, fake, errclick, valloop, thrash, paste, resubmit, cursor, wander, tabcycle, disabled, idle, hover, ...`, element, score. |
| `err`, `errn` | First occurrence of an error (kind, message, fingerprint, top frame, breadcrumbs) and repeat counts. |
| `fld`, `frm`, `fn` | Field metrics (hesitation, corrections, errors), form outcome, funnel step. |
| `vit`, `lt` | Web vitals (LCP, CLS, INP, FCP, TTFB) and long tasks. |
| `cu`, `diag` | Custom `track()` events; self-diagnostics. |
| `rp` | Recording sample: pointer path (`k: m`), scroll position (`k: s`) or viewport (`k: z`). No typed text. |

## Server

The server (`bridge/`) is one Node 22 process: collector, dashboard, API and the script files. Storage is SQLite (`node:sqlite`, WAL) at `<data dir>/assist.db` for sites and events; page snapshots and recordings are files under `<data dir>/snaps` and `<data dir>/frames`. Back up the whole data directory.

### Configuration

Environment variables win over `bridge.config.json`, which is overridden by `bridge.config.local.json` (not committed). Invalid values stop startup with every problem listed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ASSIST_HOST` | `127.0.0.1` | Interface to listen on. `0.0.0.0` to serve the network (the Docker image does). |
| `ASSIST_PORT` (or `PORT`) | `7821` | Port. |
| `ASSIST_PUBLIC_URL` | `http://localhost:<port>` | Address browsers use to reach the server. Embed snippets are built from it; `https` turns on HSTS. |
| `ASSIST_ALLOWED_HOSTS` | public URL host + localhost | Extra `Host` header values to accept (comma-separated), against DNS rebinding. |
| `ASSIST_ALLOWED_ORIGINS` | — | Extra origins allowed to call `/api/*` (comma-separated, wildcards allowed). |
| `ASSIST_RETENTION_DAYS` | `30` | Default retention; each site can override it. |
| `ASSIST_DATA_DIR` | `./data` | Database, snapshots, recordings, dashboard token. |
| `ASSIST_TRUST_PROXY` | `false` | Use `X-Forwarded-For`/`-Proto` from a reverse proxy for client IPs and rate limits. |
| `ASSIST_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `ASSIST_LOG_FORMAT` | `text` on a terminal, else `json` | One JSON object per line for log collectors. |
| `ASSIST_DASHBOARD_TOKEN` | generated, kept in `<data dir>/.dashboard-token` | Token for the on-site heatmap overlay and cross-origin API calls. |

### Deploy

```bash
docker compose up -d --build          # http://localhost:7821/dashboard, data in ./data
```

Set `ASSIST_PUBLIC_URL` to the address your sites will load the script from (for example `https://insights.example.com`) and, behind a TLS proxy, `ASSIST_TRUST_PROXY=true`. The image runs as a non-root user, health-checks `/ready`, and shuts down cleanly on `SIGTERM`.

Without Docker: `npm ci && npm run build && npm run build:server`, then `ASSIST_HOST=0.0.0.0 npm run start:prod`.

**The dashboard requires a signed-in user.** The first boot creates admin `basil` / `Pass@123` (change this). Admins can add more users from **Manage users**. Public collect stays open: `/assist.js`, hashed chunks, `/collect` and `/config` need no login.

### Upgrading from the file store

On first start, older `data/events-*.ndjson` files are imported into SQLite, one site per page hostname found in them, and moved to `data/legacy/`. Old site keys keep working on those sites.

### Security

Checks the `Host` header, rate-limits per client and route, caps bodies (256 KB, 4 MB unzipped), validates every event field, and only lets the dashboard itself (same origin) or a token holder read `/api/*`. `/collect` and `/config` answer any origin, since acceptance is decided by site key plus domain and nothing is read back.

### HTTP API

| Route | Purpose |
| --- | --- |
| `POST /collect?k=<key>` | Event and snapshot batches from the script. |
| `GET /config?k=<key>` | The site's settings for the script (`{ disabled: true }` when unknown or paused). |
| `GET /health`, `GET /ready` | Liveness; readiness (the database answers). |
| `GET /api/meta` | Version, public URL, script URL, ingest counters. |
| `GET, POST /api/sites` | List sites with today's numbers; create a site (`{ name, domains }`). |
| `GET, PUT, DELETE /api/sites/:id` | Read, update (`name, domains, config, retentionDays, paused`), delete a site and its data. |
| `POST /api/sites/:id/keys`, `DELETE /api/sites/:id/keys/:key` | Add a new key; remove an old one. |
| `POST /api/sites/:id/domains` | Allow a refused domain. |
| `GET /api/overview`, `/api/pages`, `/api/heatmap`, `/api/frustration`, `/api/errors`, `/api/forms`, `/api/funnels`, `/api/vitals`, `/api/sessions`, `/api/session/:sid`, `/api/replay/:sid` | Reports; take `site=<id>` and `range=24h\|7d\|30d`. |
| `DELETE /api/visitor/:vid?site=<id>` | Erase one visitor's events. |
| `GET /api/stream?site=<id\|*>` | Server-sent live events. |

## Performance

Hard budgets, checked by `npm run check:size` and `npm run check:perf` (Playwright, Edge, 4x CPU throttling, the same scripted session with and without Footsteps on a ~2,500-element page):

| Budget | Limit |
| --- | --- |
| Core size | ≤ 12 KB gzipped (each chunk has its own limit) |
| Core startup on the main thread | ≤ 3 ms at 4x CPU |
| Longest task caused by Footsteps | ≤ 16 ms |
| One event handler, p95 | ≤ 0.2 ms |
| Added interaction latency (INP, p98) | ≤ 10 ms |
| Retained JS heap vs. baseline | ≤ 2 MB |
| Upload, active session | ≤ 50 KB/min |

How: the script's own evaluation only installs a queueing stub; boot, capture and route watching run as separate short tasks afterwards. The core carries Chromium's `//# allFunctionsCalledOnLoad` compile hint so it compiles on the background streaming thread. Listeners are passive and delegated; layout reads happen after paint, never inside an interaction. Chunks load one per idle callback; snapshots serialize in 5 ms idle slices; compression runs in a worker.

## Tests

```bash
npm test             # unit tests (vitest + happy-dom): frustration detectors, redactor, fingerprints,
                     # snapshot serializer, config, aggregation, sites, SQLite store,
                     # server config and request guards
npm run test:e2e     # Playwright compat matrix (installed Edge): plain HTML, React 18, Vue 3,
                     # zone.js, web components, strict CSP + Trusted Types, Sentry
npm run check:perf   # build + size budgets + performance benchmark
npm run smoke        # end-to-end against the demo (needs `npm run bridge` and `npm run demo`)
```

Set `PW_CHANNEL=chrome` to use Chrome instead of Edge.

## Layout

```
src/core/        core: config, session, bus, capture, frustration, errors, batcher, loader
src/page/        page model and element fingerprints
src/privacy/     redactor
src/chunks/      lazy chunks: analytics, vitals, snapshot, replay, netwrap, heatmap
src/worker/      compression worker
bridge/          server: config, db (SQLite), store, sites, aggregation, security, log, dashboard/
Dockerfile, docker-compose.yml   production image
demo/            demo site;  scripts/  build, size check, bench, smoke, demo server
tests/unit/      vitest;  tests/e2e/  Playwright fixtures + compat spec
```
