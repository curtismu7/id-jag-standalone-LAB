#!/usr/bin/env bash
# Start the ID-JAG kit against the live PingFederate (mode=live, npm run): the playground server,
# the resource-as and the mcp-sample, with one shared RESOURCE_AS_CLIENT_SECRET and the local
# PingFederate's CA file on every process that talks to it. Kills stale port holders first.
#
# Usage: scripts/dev-live.sh [--pf-url=...] [--pf-client-id=...] [--pf-ca-file=...] [--ports]
#   --ports=<server>,<resource-as>,<mcp>   default 4720,9080,9090 (the pf-pf SP connection values)
#
# Reads the repo .env for PF_URL, PF_EXCHANGE_CLIENT_ID, PF_EXCHANGE_CLIENT_SECRET, PF_CA_FILE and
# RESOURCE_AS_CLIENT_SECRET; missing values are prompted for (secret hidden) and written back into .env.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env"

set_env() { # set_env KEY VALUE  -- replace or append in .env
  local key="$1" val="$2"
  if grep -q "^${key}=" "$env_file" 2>/dev/null; then
    sed -i '' "s|^${key}=.*|${key}=${val}|" "$env_file"
  else
    printf '\n%s=%s\n' "$key" "$val" >>"$env_file"
  fi
}
get_env() { grep "^$1=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-; }

pf_url="" pf_client="" pf_ca=""
ports="4720,9080,9090"
for a in "$@"; do
  case "$a" in
    --pf-url=*) pf_url="${a#*=}" ;;
    --pf-client-id=*) pf_client="${a#*=}" ;;
    --pf-ca-file=*) pf_ca="${a#*=}" ;;
    --ports=*) ports="${a#*=}" ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
IFS=, read -r port_server port_ras port_mcp <<<"$ports"

[ -f "$env_file" ] || { echo ".env missing — run: npm run setup -- --mode=pf-as first" >&2; exit 1; }
chmod 600 "$env_file" 2>/dev/null || true

[ -n "$pf_url" ] && set_env PF_URL "$pf_url"
[ -n "$pf_client" ] && set_env PF_EXCHANGE_CLIENT_ID "$pf_client"
[ -n "$pf_ca" ] && set_env PF_CA_FILE "$pf_ca"

for key in PF_URL PF_EXCHANGE_CLIENT_ID; do
  [ -n "$(get_env "$key")" ] || { echo "$key is not set in .env — rerun with --$([ "$key" = PF_URL ] && echo pf-url || echo pf-client-id)" >&2; exit 1; }
done

if [ -z "$(get_env PF_EXCHANGE_CLIENT_SECRET)" ]; then
  printf 'PF_EXCHANGE_CLIENT_SECRET (hidden): '
  read -rs v; echo
  [ -n "$v" ] && set_env PF_EXCHANGE_CLIENT_SECRET "$v"
fi

# One shared secret for both directions of the leg 2 client auth; generated once, reused after.
if [ -z "$(get_env RESOURCE_AS_CLIENT_SECRET)" ]; then
  set_env RESOURCE_AS_CLIENT_SECRET "$(openssl rand -hex 24)"
  echo "generated RESOURCE_AS_CLIENT_SECRET into .env"
fi

# PF_CA_FILE: trust the local PingFederate's own certificate (server and resource-as both use it).
if [ -z "$(get_env PF_CA_FILE)" ]; then
  for cand in /app/deploy/pf-rootCA.pem "$root/deploy/pf-rootCA.pem" "$HOME/Development/AI-DEMO-Standalone/standalone/id-jag-standalone-LAB/deploy/pf-rootCA.pem"; do
    if [ -r "$cand" ]; then set_env PF_CA_FILE "$cand"; break; fi
  done
fi

pf_ca_file="$(get_env PF_CA_FILE)"
[ -z "$pf_ca_file" ] || [ -r "$pf_ca_file" ] || { echo "PF_CA_FILE=$pf_ca_file is not readable" >&2; exit 1; }

kill_port() { # free a port from any stale listener of a previous dev-live run
  local pids
  pids="$(lsof -t -nP -i ":$1" 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null && sleep 1
  lsof -t -nP -i ":$1" >/dev/null 2>&1 && { echo "port $1 still held; refusing to kill it again" >&2; exit 1; } || true
}
kill_port "$port_server"; kill_port "$port_ras"; kill_port "$port_mcp"

# shellcheck disable=SC1091
set -a; source "$env_file"; set +a

# Which resource-as redeems the ID-JAGs: the SE-hosted one (SE_RESOURCE_AS_ISSUER in .env) or a
# local one. The server's settings win from the environment either way.
ras_issuer="${SE_RESOURCE_AS_ISSUER:-http://localhost:$port_ras}"
idjag_resource="${SE_ID_JAG_RESOURCE:-http://localhost:$port_mcp/mcp}"

export MODE=live PORT="$port_ras" ISSUER="${SE_RESOURCE_AS_ISSUER:+http://localhost:$port_ras}" DATA_DIR="$root/.data-resource-as"
export RESOURCE_AS_CLIENT_ID="${RESOURCE_AS_CLIENT_ID:-id-jag-playground}"
nohup node "$root/resource-as/src/index.js" >"/tmp/idjag-dev-ras.log" 2>&1 &
echo $! >"/tmp/idjag-dev-ras.pid"

export PORT="$port_mcp" AS_ISSUER="http://localhost:$port_ras" AS_JWKS_URL="http://localhost:$port_ras/jwks" MCP_RESOURCE="http://localhost:$port_mcp/mcp"
nohup node "$root/mcp-sample/src/index.js" >"/tmp/idjag-dev-mcp.log" 2>&1 &
echo $! >"/tmp/idjag-dev-mcp.pid"

export PORT="$port_server" APP_ORIGIN="http://localhost:$port_server" \
  RESOURCE_AS_ISSUER="$ras_issuer" \
  RESOURCE_AS_TOKEN_ENDPOINT="$ras_issuer/token" \
  ID_JAG_RESOURCE="$idjag_resource" MCP_URL="http://localhost:$port_mcp/mcp"
npm --prefix "$root" start >"/tmp/idjag-dev-server.log" 2>&1 &
echo $! >"/tmp/idjag-dev-server.pid"

sleep 4
ok=0
curl -sf "http://localhost:$port_server/api/health" >/dev/null && ok=$((ok+1)) || echo "server not up: /tmp/idjag-dev-server.log" >&2
curl -sf "http://localhost:$port_ras/jwks" >/dev/null && ok=$((ok+1)) || echo "resource-as not up: /tmp/idjag-dev-ras.log" >&2
curl -sf "http://localhost:$port_mcp/.well-known/oauth-protected-resource" >/dev/null && ok=$((ok+1)) || echo "mcp-sample not up: /tmp/idjag-dev-mcp.log" >&2

echo ""
echo "3 services started, $ok answering:"
echo "  playground   http://localhost:$port_server  (log /tmp/idjag-dev-server.log)"
echo "  resource-as  http://localhost:$port_ras      (log /tmp/idjag-dev-ras.log)"
echo "  mcp-sample   http://localhost:$port_mcp      (log /tmp/idjag-dev-mcp.log)"
[ "$ok" = 3 ] || exit 1
