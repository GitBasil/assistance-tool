# Deploy Footsteps to production

Agent-facing runbook for publishing this repo to the Windows Server behind **https://ultrainnovate.com**.

> Live public URL: `https://ultrainnovate.com`  
> Dashboard: `https://ultrainnovate.com/dashboard`  
> Embed script: `https://ultrainnovate.com/assist.js`  
> Initial admin (seeded on first boot only): `basil` / `Pass@123` — change after first login; admins manage people under **Manage users**

---

## 0. What this server is

| Item | Value |
|------|-------|
| Host | `3.135.202.156` (Windows Server 2022 EC2) |
| Admin SSH (IIS / NSSM / `C:\apps`) | user `basilt`, kit at `../server-access` (alias `mechanic-shop`) |
| Restricted SSH (Troodak only) | user `troodak-deploy`, kit at `../troodak-deploy-handoff` — **do not use for Footsteps** |
| App root on server | `C:\apps\assistance-tool\` |
| Node runtime | portable **Node 22** at `C:\apps\assistance-tool\runtime\node` (`node:sqlite` needs 22+) |
| Windows service | `Footsteps` (NSSM → `start-footsteps.cmd`) |
| Local listen | `127.0.0.1:7821` |
| IIS site | `ultrainnovate.com` (HTTPS bindings for apex + `www`) reverse-proxies to `:7821` |
| Data (SQLite, snaps, recordings) | `C:\apps\assistance-tool\data` — **never delete** |
| Logs | `C:\logs\assistance-tool\stdout.log`, `stderr.log` |
| Cloudflare | Zone already proxies `ultrainnovate.com` to this origin. SSL mode must be **Full** (origin uses the server’s default cert). |

Connect helpers (run from those folders so relative key paths work):

```bash
../server-access/connect.sh mechanic-shop
../server-access/connect.sh mechanic-shop 'powershell -Command "sc.exe query Footsteps"'
```

---

## 1. Hard rules (read before deploying)

1. **Upload a `.ps1` and run it with `-File`.** Never pass multi-line PowerShell through `ssh … powershell -Command "…"`. It often exits 0 and does nothing.
2. **No `rsync`.** Windows OpenSSH here does not have it. Use `tar` + `scp`.
3. **Do not overwrite `C:\apps\assistance-tool\data`.** That is production analytics.
4. **Do not copy Mac `.env` / secrets into production.** Server env lives in `C:\apps\assistance-tool\footsteps.env.cmd`.
5. **Build with Node 22 semantics.** Prefer `docker build` (image already pins Node 22) or a local Node 22 toolchain.
6. **Private keys stay in `server-access` / `troodak-deploy-handoff`.** Do not commit them into this repo.

---

## 2. Routine publish (code changes)

From this repo on the Mac:

```bash
./deploy/publish.sh
```

What it does:

1. Builds a production image (`docker compose build`) and extracts `build/`, `dist/`, `bridge/dashboard/`, `package.json`
2. Packs `deploy/footsteps-deploy.tgz`
3. `scp`s the tarball + `deploy/install-footsteps.ps1` to `C:\apps\` via `mechanic-shop`
4. Runs `install-footsteps.ps1` on the server (sync app files, restart `Footsteps`, probe `/ready`)
5. Curls `https://ultrainnovate.com/ready` and `/assist.js`

Expected success markers:

- remote: `LOCAL_READY: 200` and `INSTALL_FOOTSTEPS_DONE`
- public: HTTP 200 from `/ready` and `/assist.js`

### Manual equivalent

```bash
# 1) Build artifacts (Docker avoids the corporate .npmrc / Node 20 issues)
docker compose build
cid=$(docker create footsteps:latest)
rm -rf /tmp/footsteps-stage && mkdir -p /tmp/footsteps-stage
docker cp "$cid:/app/package.json" /tmp/footsteps-stage/
docker cp "$cid:/app/build" /tmp/footsteps-stage/build
docker cp "$cid:/app/dist" /tmp/footsteps-stage/dist
docker cp "$cid:/app/bridge" /tmp/footsteps-stage/bridge
docker rm "$cid" >/dev/null

# 2) Pack + upload
COPYFILE_DISABLE=1 tar czf /tmp/footsteps-deploy.tgz -C /tmp/footsteps-stage package.json build dist bridge
scp -F ../server-access/ssh_config /tmp/footsteps-deploy.tgz deploy/install-footsteps.ps1 \
  mechanic-shop:C:/apps/

# 3) Install / restart on server
../server-access/connect.sh mechanic-shop \
  'powershell -ExecutionPolicy Bypass -File C:\apps\install-footsteps.ps1'

# 4) Verify
curl -sS https://ultrainnovate.com/ready
curl -sS -o /dev/null -w '%{http_code}\n' https://ultrainnovate.com/assist.js
```

---

## 3. First-time / repair install

`install-footsteps.ps1` is idempotent. It will:

- install portable Node 22 under `C:\apps\assistance-tool\runtime` if missing
- create/update NSSM service `Footsteps`
- create/update IIS site + app pool + reverse-proxy `web.config`
- set production env (`ASSIST_PUBLIC_URL=https://ultrainnovate.com`, `ASSIST_TRUST_PROXY=true`, data dir, etc.)

Only re-run the full script after a server wipe or when changing domain/port/env. Routine code deploys use the same script; it preserves `data\`.

---

## 4. Verify after publish

```bash
curl -sS https://ultrainnovate.com/ready          # {"ok":true,...}
curl -sS https://ultrainnovate.com/health
curl -sS -o /dev/null -w '%{http_code}\n' https://ultrainnovate.com/dashboard   # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://ultrainnovate.com/assist.js   # 200

# Service / local probe on the box
../server-access/connect.sh mechanic-shop \
  'powershell -Command "sc.exe query Footsteps | Select-String STATE"'
../server-access/connect.sh mechanic-shop \
  'powershell -Command "Invoke-WebRequest http://127.0.0.1:7821/ready -UseBasicParsing | Select StatusCode,Content"'
```

If the service is RUNNING but public returns 502, Node likely crashed — read:

```bash
../server-access/connect.sh mechanic-shop \
  'powershell -Command "Get-Content C:\logs\assistance-tool\stderr.log -Tail 80"'
```

---

## 5. Live dashboard stuck on “Connecting…”

The status pill uses **Server-Sent Events** at `/api/stream`. Collect can be fine while live stays broken.

**Cause we already hit:** IIS Application Request Routing buffers proxied responses by default (`responseBufferLimit` ≈ 4 MB). An SSE stream never “finishes”, so the browser gets nothing and the UI stays on Connecting… / Reconnecting….

**Fix (already applied on this server; `install-footsteps.ps1` re-applies it):**

```bat
%windir%\System32\inetsrv\appcmd.exe set config -section:system.webServer/proxy /responseBufferLimit:0 /minResponseBuffer:0 /commit:apphost
```

Quick probe (must print a `hello` event within ~1s):

```bash
curl -sS -N --max-time 3 https://ultrainnovate.com/api/stream?site=*
```

---

## 6. Domain / Cloudflare notes

- Apex `ultrainnovate.com` is already on Cloudflare and reaches this origin.
- IIS bindings exist for both `ultrainnovate.com` and `www.ultrainnovate.com`.
- **`www` needs a Cloudflare DNS record** (CNAME → apex, or A → `3.135.202.156`, Proxied) before `https://www.ultrainnovate.com` resolves. Do that in the Cloudflare dashboard for the zone; no CF token is stored in this repo.
- Prefer SSL/TLS mode **Full**. **Full (strict)** needs a Cloudflare Origin Certificate that includes `ultrainnovate.com` installed in IIS (admin task).

Embed snippet for production sites:

```html
<script defer src="https://ultrainnovate.com/assist.js" data-key="pk_…"></script>
```

Create the site + key in the dashboard (`/dashboard` → Add a site). Allow the real page hostname(s) under that site’s domains.

---

## 7. Server layout (do not break)

```
C:\apps\assistance-tool\
  app\                 # build/, dist/, bridge/dashboard/, package.json
  data\                # assist.db, snaps, frames, .dashboard-token  ← persistent
  runtime\node\        # portable Node 22
  iis\web.config       # ARR reverse proxy to 127.0.0.1:7821
  start-footsteps.cmd
  footsteps.env.cmd    # production env (edit on server only)
C:\logs\assistance-tool\
  stdout.log
  stderr.log
```

NSSM binary reused from the mechanic-shop install:

`C:\apps\mechanic-shop\installers\nssm-2.24\win64\nssm.exe`

---

## 8. Restart without redeploying

```bash
../server-access/connect.sh mechanic-shop \
  'powershell -Command "sc.exe stop Footsteps; Start-Sleep 3; sc.exe start Footsteps"'
```

---

## Folder contents

| File | Purpose |
|------|---------|
| `README.md` | This runbook |
| `publish.sh` | Mac-side one-command publish |
| `install-footsteps.ps1` | Server-side install/update (run with `-File`) |
| `AGENTS.md` | Short pointer so coding agents find this kit |
