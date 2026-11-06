#!/bin/bash
# Sets up PingFederate for the standalone apps.
#   - If PingFederate already answers on the admin port, ask for its admin login, check it, and save it.
#   - Otherwise install the official image in Docker, bound to 127.0.0.1 only, with the default
#     administrator login, and save the login.
# Admin credentials are written only to ~/.config/demo-kit/provisioning.json (mode 600), never to the shared .env.
# Environment overrides: PF_ADMIN_PORT (4731), PF_ENGINE_PORT (4732), PF_CONTAINER (id-jag-kit-pf for a new install; an
#   existing container named pingfederate-lab, from an earlier version of this kit, is found and reused, never recreated),
#   PF_IMAGE (pingidentity/pingfederate:13.1.3-latest, the version the shared Acme PingFederate runs), PF_LICENSE_FILE (~/.config/demo-kit/pingfederate.lic),
#   PF_SERVER_PROFILE_URL and PF_SERVER_PROFILE_PATH (Ping getting-started profile), PF_ACCEPT_EULA=YES to skip the prompt.
set -u

ADMIN_PORT="${PF_ADMIN_PORT:-4731}"
ENGINE_PORT="${PF_ENGINE_PORT:-4732}"
IMAGE="${PF_IMAGE:-pingidentity/pingfederate:13.1.3-latest}"
LICENSE="${PF_LICENSE_FILE:-$HOME/.config/demo-kit/pingfederate.lic}"
# Ping's public "getting-started" server profile creates the first administrator from PING_IDENTITY_PASSWORD.
# Without a profile a fresh PingFederate shows a setup wizard and has no admin account yet.
PROFILE_URL="${PF_SERVER_PROFILE_URL:-https://github.com/pingidentity/pingidentity-server-profiles.git}"
PROFILE_PATH="${PF_SERVER_PROFILE_PATH:-getting-started/pingfederate}"
DEFAULT_USER="administrator"
DEFAULT_PASSWORD="2FederateM0re"   # the official image's documented default; change it for anything beyond local use
PROVISIONING="$HOME/.config/demo-kit/provisioning.json"
BASE="https://127.0.0.1:$ADMIN_PORT/pf-admin-api/v1"

fail() { echo "ERROR: $*" >&2; exit 1; }

# New installs are named id-jag-kit-pf ("pingfederate-lab" is also the name of another app). An earlier version of this kit
# named its container pingfederate-lab: when that one exists, keep using it instead of creating a second PingFederate.
if [ -n "${PF_CONTAINER:-}" ]; then NAME="$PF_CONTAINER"
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx pingfederate-lab; then NAME="pingfederate-lab"
else NAME="id-jag-kit-pf"; fi

# HTTP status of the version endpoint with no login ("000" means nothing is listening).
probe() { curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/version" 2>/dev/null || true; }

# Login check without putting the password on the command line.
login_status() {
  printf 'user = "%s:%s"\n' "$1" "$2" | curl -sk -K - -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/version" 2>/dev/null || true
}

# Prints "<http status> <resultId or ->" for a login attempt. The body is parsed, never printed in full.
login_result() {
  local out
  out="$(printf 'user = "%s:%s"\n' "$1" "$2" | curl -sk -K - -H 'X-XSRF-Header: PingFederate' -w '\n%{http_code}' --max-time 10 "$BASE/version" 2>/dev/null)" || true
  local status="${out##*$'\n'}" body="${out%$'\n'*}" id="-"
  case "$body" in *license_agreement_not_accepted*) id="license_agreement_not_accepted";; esac
  echo "$status $id"
}

# Accepts PingFederate's in-product license agreement through its admin API. Only called after the user has said YES
# (the prompt or PF_ACCEPT_EULA=YES), which covers both the image terms and this agreement.
accept_agreement() {
  local url
  url="$(printf 'user = "%s:%s"\n' "$DEFAULT_USER" "$DEFAULT_PASSWORD" | curl -sk -K - -H 'X-XSRF-Header: PingFederate' --max-time 10 "$BASE/license/agreement" 2>/dev/null | sed -n 's/.*"licenseAgreementUrl":"\([^"]*\)".*/\1/p')"
  [ -n "$url" ] || return 1
  printf 'user = "%s:%s"\n' "$DEFAULT_USER" "$DEFAULT_PASSWORD" | curl -sk -K - -X PUT -H 'X-XSRF-Header: PingFederate' -H 'Content-Type: application/json' \
    -d "{\"licenseAgreementUrl\":\"$url\",\"accepted\":true}" --max-time 10 "$BASE/license/agreement" 2>/dev/null | grep -q '"accepted":true'
}

agreement_help() {
  cat >&2 <<EOF

PingFederate needs its own license agreement accepted once, in the admin console. This is a legal step,
so this script does not do it for you:
  1. Open https://127.0.0.1:$ADMIN_PORT in a browser (accept the local certificate warning).
  2. Sign in as $DEFAULT_USER (the image's documented default password; see the PingFederate image documentation).
  3. Read and accept the PingFederate license agreement.
  4. Run this script again. It will verify the login and save it.
EOF
}

save_creds() {
  mkdir -p "$(dirname "$PROVISIONING")"
  PF_URL="https://127.0.0.1:$ADMIN_PORT" PF_USER="$1" PF_PASS="$2" PROV="$PROVISIONING" node -e '
    const fs = require("fs");
    const file = process.env.PROV;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    data.pingfederate = { adminUrl: process.env.PF_URL, username: process.env.PF_USER, password: process.env.PF_PASS, note: "Local PingFederate admin login. Read only by the provisioning scripts." };
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  ' || fail "could not write $PROVISIONING"
  echo "Saved the admin login to $PROVISIONING (mode 600)."
}

code="$(probe)"
if [ -n "$code" ] && [ "$code" != "000" ]; then
  echo "PingFederate answers on https://127.0.0.1:$ADMIN_PORT (HTTP $code). Using the existing install."
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$NAME"; then
    read -r status rid <<<"$(login_result "$DEFAULT_USER" "$DEFAULT_PASSWORD")"
    if [ "$status" = "200" ]; then save_creds "$DEFAULT_USER" "$DEFAULT_PASSWORD"; echo "Existing PingFederate verified (default login)."; exit 0; fi
    if [ "$rid" = "license_agreement_not_accepted" ]; then
      if [ "${PF_ACCEPT_EULA:-}" = "YES" ] && accept_agreement; then
        echo "PingFederate's in-product license agreement accepted."
        read -r status rid <<<"$(login_result "$DEFAULT_USER" "$DEFAULT_PASSWORD")"
        if [ "$status" = "200" ]; then save_creds "$DEFAULT_USER" "$DEFAULT_PASSWORD"; echo "Existing PingFederate verified (default login)."; exit 0; fi
        fail "the default login was refused (HTTP $status). Do not retry in a loop: repeated failures lock the account."
      fi
      agreement_help; exit 2
    fi
  fi
  read -r -p "Admin username: " user
  read -r -s -p "Admin password: " pass; echo
  status="$(login_status "$user" "$pass")"
  [ "$status" = "200" ] || fail "login refused (HTTP $status). Nothing was saved."
  save_creds "$user" "$pass"
  echo "Existing PingFederate verified."
  exit 0
fi

echo "No PingFederate on port $ADMIN_PORT. Installing the official image."
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install OrbStack or Docker Desktop, then run this again."
docker info >/dev/null 2>&1 || fail "Docker is not running. Open OrbStack and run this again."
[ -f "$LICENSE" ] || fail "No license at $LICENSE. Put pingfederate.lic there, or set PF_LICENSE_FILE."
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  fail "a container named $NAME already exists. Remove it, or set PF_CONTAINER to another name."
fi
for p in "$ADMIN_PORT" "$ENGINE_PORT"; do
  if lsof -iTCP:"$p" -sTCP:LISTEN -n -P >/dev/null 2>&1; then fail "port $p is taken. Pick another with PF_ADMIN_PORT or PF_ENGINE_PORT."; fi
done

if [ "${PF_ACCEPT_EULA:-}" != "YES" ]; then
  echo "PingFederate is licensed by Ping. Read the terms: https://www.pingidentity.com/en/legal.html"
  echo "Typing YES accepts the terms for the PingFederate image and PingFederate's in-product license agreement."
  read -r -p "Accept and install? Type YES to continue: " answer
  [ "$answer" = "YES" ] || fail "not accepted. Nothing was installed."
fi

docker pull "$IMAGE" >/dev/null || fail "could not pull $IMAGE"
docker run -d --name "$NAME" --restart unless-stopped \
  -p "127.0.0.1:$ADMIN_PORT:9999" -p "127.0.0.1:$ENGINE_PORT:9031" \
  -e PING_IDENTITY_ACCEPT_EULA=YES \
  -e ROOT_USER="$DEFAULT_USER" \
  -e PING_IDENTITY_PASSWORD="$DEFAULT_PASSWORD" \
  -e SERVER_PROFILE_URL="$PROFILE_URL" \
  -e SERVER_PROFILE_PATH="$PROFILE_PATH" \
  -v "$LICENSE:/opt/out/instance/server/default/conf/pingfederate.lic:ro" \
  "$IMAGE" >/dev/null || fail "docker could not start $NAME"
echo "Started $NAME. Waiting for the admin API (this can take a few minutes)..."

for _ in $(seq 1 90); do
  code="$(probe)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then break; fi
  sleep 2
done
# The server profile is imported shortly after start, and the import can reset the agreement. Accept it, then retry
# ONLY while PingFederate answers "agreement not accepted" (that does not count as a failed password). Any other
# refusal stops at once: repeated failed logins lock the administrator account.
status=""; rid=""
for _ in $(seq 1 30); do
  read -r status rid <<<"$(login_result "$DEFAULT_USER" "$DEFAULT_PASSWORD")"
  if [ "$status" = "200" ]; then break; fi
  if [ "$rid" = "license_agreement_not_accepted" ]; then
    accept_agreement && echo "PingFederate's in-product license agreement accepted."
    sleep 6
    continue
  fi
  break
done
[ "$status" = "200" ] || fail "the default login was refused (HTTP $status, $rid). Do not retry in a loop: repeated failures lock the account. Check: docker logs $NAME"
save_creds "$DEFAULT_USER" "$DEFAULT_PASSWORD"
echo "PingFederate is up."
echo "  Admin console and API: https://127.0.0.1:$ADMIN_PORT"
echo "  Runtime (engine):      https://127.0.0.1:$ENGINE_PORT"
echo "  The administrator login is saved in $PROVISIONING (mode 600); it is not shown here."
