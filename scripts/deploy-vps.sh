#!/usr/bin/env bash
set -euo pipefail
release="${1:?usage: deploy-vps.sh release-directory}"
app=/var/www/whatsapp-cledson
grep -q codex-maintenance /usr/local/bin/healthcheck-buscador.sh
cd "$release"
npm test
node --check server.mjs
# Never restart this service while a campaign is active or pending.
curl -fsS --max-time 5 http://127.0.0.1:3010/status | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s).campaign;if(c.isRunning||c.hasPending)process.exit(1)})'
backup="/opt/backups/whatsapp-cledson-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$backup"
touch "$app/.git/codex-maintenance"
trap 'rm -f "$app/.git/codex-maintenance"' EXIT
pm2 stop whatsapp-cledson >/dev/null
rollback() {
  pm2 stop whatsapp-cledson >/dev/null || true
  if test -d "$backup/node_modules"; then
    mv "$app/node_modules" "$release/failed-node_modules" || true
    mv "$backup/node_modules" "$app/node_modules"
  fi
  # Never restore stale auth keys over a session that has since connected.
  tar -xzf "$backup/application.tar.gz" -C "$app" ./server.mjs ./package.json
  if test -f "$backup/had-lockfile"; then tar -xzf "$backup/application.tar.gz" -C "$app" ./package-lock.json; fi
  pm2 start whatsapp-cledson >/dev/null
  echo "ROLLED_BACK backup=$backup" >&2
}
trap rollback ERR
# Complete snapshot while the sole owner of this session is stopped.
tar --exclude=node_modules --exclude=.git -I 'gzip -1' -cf "$backup/application.tar.gz" -C "$app" .
chmod 600 "$backup/application.tar.gz"
if test -f "$app/package-lock.json"; then touch "$backup/had-lockfile"; fi
mv "$app/node_modules" "$backup/node_modules"
mv "$release/node_modules" "$app/node_modules"
for file in server.mjs delivery-store.mjs reliable-send.mjs signal-session-guard.mjs package.json package-lock.json README.md; do cp "$release/$file" "$app/$file"; done
mkdir -p "$app/tests" "$app/scripts"
cp "$release/tests/"*.mjs "$app/tests/"
cp "$release/deploy-vps.sh" "$app/scripts/deploy-vps.sh"
pm2 start whatsapp-cledson >/dev/null
ready=0
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 3 http://127.0.0.1:3010/status | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);process.exit(x.status==="CONNECTED"&&x.delivery?0:1)})'; then ready=1; break; fi
  sleep 2
done
test "$ready" = 1
trap - ERR
printf 'DEPLOY_OK backup=%s\n' "$backup"
