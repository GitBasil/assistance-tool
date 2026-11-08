#!/usr/bin/env bash
# Build Footsteps and publish to https://ultrainnovate.com
# Requires: Docker Desktop, and ../server-access (basilt / mechanic-shop SSH kit).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/deploy"
ACCESS="$(cd "$ROOT/../server-access" && pwd)"
STAGE="${TMPDIR:-/tmp}/footsteps-stage-$$"
TGZ="${TMPDIR:-/tmp}/footsteps-deploy.tgz"

export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH:-}"

if [[ ! -x "$ACCESS/connect.sh" ]]; then
  echo "Missing server-access kit at $ACCESS" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH (is Docker Desktop installed/running?)" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable — open Docker Desktop and retry." >&2
  exit 1
fi

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "== building image =="
cd "$ROOT"
docker compose build

echo "== extracting production files =="
rm -rf "$STAGE"
mkdir -p "$STAGE"
cid="$(docker create footsteps:latest)"
docker cp "$cid:/app/package.json" "$STAGE/"
docker cp "$cid:/app/build" "$STAGE/build"
docker cp "$cid:/app/dist" "$STAGE/dist"
docker cp "$cid:/app/bridge" "$STAGE/bridge"
docker rm "$cid" >/dev/null
test -f "$STAGE/build/server.mjs"
test -f "$STAGE/dist/assist.js"

echo "== packing tarball =="
COPYFILE_DISABLE=1 tar czf "$TGZ" -C "$STAGE" package.json build dist bridge
ls -lh "$TGZ"

echo "== uploading =="
# ssh_config IdentityFile is relative — must run scp from the access kit folder.
(
  cd "$ACCESS"
  scp -F ssh_config "$TGZ" "$DEPLOY/install-footsteps.ps1" mechanic-shop:C:/apps/
)

echo "== installing on server =="
# IdentityFile in ssh_config is relative — must invoke connect from the kit folder.
(
  cd "$ACCESS"
  ./connect.sh mechanic-shop \
    'powershell -ExecutionPolicy Bypass -File C:\apps\install-footsteps.ps1'
)

echo "== public verify =="
ready="$(curl -fsS https://ultrainnovate.com/ready)"
echo "ready: $ready"
code="$(curl -fsS -o /dev/null -w '%{http_code}' https://ultrainnovate.com/assist.js)"
echo "assist.js: HTTP $code"
test "$code" = "200"

echo "PUBLISH_DONE https://ultrainnovate.com/dashboard"
