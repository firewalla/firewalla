#!/bin/bash
# fireonboard.sh — unattended onboard dispatcher (replaces the interactive fw-firstboot path).
#
# Launched in the background by fireonboard.service on first boot, fully silent: nothing is shown
# on the console; all output goes to /home/pi/.firewalla/fireonboard.log (for dev troubleshooting).
#
# Does three things:
#   1) Wait for the app stack (FireMain + sys:ept.gid)
#   2) Unconditionally translate onboard-config.network into FireRouter config and apply it
#   3) Run bootstrap.js (onboard mode): write license unconditionally; if msp/app was selected,
#      register(bid) -> wait for the user to click activate -> join MSP / join App
#
# /data/.fireonboard-done is written only after bootstrap.js succeeds (exit 0); otherwise retry next boot.

set -u

ONBOARD_CONFIG="${FW_ONBOARD_CONFIG:-/home/pi/.firewalla/onboard-config.json}"
LOG="${FW_ONBOARD_LOG:-/home/pi/.firewalla/fireonboard.log}"
DONE=/data/.fireonboard-done
FRR_BASE=http://localhost:8837
FRR_SET="$FRR_BASE/v1/config/set"
FRR_GET="$FRR_BASE/v1/config/active"   # read endpoint, used only as a readiness probe
NODE=/home/pi/firewalla/bin/node
SCRIPTS_DIR=/home/pi/firewalla/scripts

mkdir -p "$(dirname "$LOG")" 2>/dev/null
# Send all stdout/stderr to the log — keep the console silent for the user.
exec >>"$LOG" 2>&1
log(){ printf '[fireonboard %s] %s\n' "$(date -Is 2>/dev/null || date)" "$*"; }

# ── network ───────────────────────────────────────────────────────────────────
# FireRouter owns :8837 and can come up a bit AFTER FireMain (the stack wait below only checks
# FireMain). apply_network POSTs to it, so block until it actually answers — otherwise the POST hits
# connection-refused and the network config is silently dropped while we'd still log "applied".
wait_firerouter(){
  local i=0
  while [ $i -lt 90 ]; do   # up to ~3 min
    curl -s -o /dev/null --max-time 2 "$FRR_GET" && return 0
    sleep 2; i=$((i+1))
  done
  return 1
}

# onboard-config.network is already a ready-made FireRouter network_config (translated by the
# cloud). POST the whole block to /v1/config/set as-is; the box does no translation.
apply_network(){
  if [ "$(jq -r 'has("network")' "$ONBOARD_CONFIG" 2>/dev/null)" != "true" ]; then
    log "network: no .network in onboard-config — skip"; return 0
  fi
  if [ "$(jq -r '.network | has("interface")' "$ONBOARD_CONFIG" 2>/dev/null)" != "true" ]; then
    log "ERROR: .network is not a FireRouter config (missing 'interface') — skip network"; return 1
  fi
  if ! wait_firerouter; then
    log "ERROR: FireRouter (:8837) not ready after ~3min — skip network apply (retry next boot)"; return 1
  fi
  log "network: FireRouter ready; posting ready-made FireRouter config as-is (.network)"
  local payload rc; payload=$(jq -c '.network' "$ONBOARD_CONFIG")
  curl -sS -X POST "$FRR_SET" -H 'Content-Type: application/json' -d "$payload" | head -c 800
  rc=${PIPESTATUS[0]}
  echo
  [ "$rc" -eq 0 ] && log "network: applied" || log "ERROR: network POST failed (curl rc=$rc)"
  return "$rc"
}

# Show a single "SSH here" banner on tty1 (visible on bare-metal VGA / noVNC console); silent otherwise.
# Don't hardcode eth0: take the IP of the default-route interface (WAN may not be eth0); fall back to
# the first global IPv4. Write the banner to /etc/issue (getty renders it on every login screen) and
# restart getty@tty1 to force a redraw, so it shows immediately on first boot instead of next refresh.
show_ssh_banner(){
  local ip="" dev="" i=0   # set -u: must init, else $ip is undefined when no default route is found
  while [ $i -lt 15 ]; do      # DHCP may take a few seconds; wait up to ~30s
    dev=$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')
    [ -n "$dev" ] && ip=$(ip -4 -br addr show "$dev" 2>/dev/null | awk '{print $3}' | cut -d/ -f1)
    [ -z "$ip" ] && ip=$(ip -4 -br addr show scope global 2>/dev/null | awk 'NR==1{print $3}' | cut -d/ -f1)
    [ -n "$ip" ] && break
    sleep 2; i=$((i+1))
  done
  ip=${ip:-<no-ip-yet>}
  # /etc/issue: rendered by getty at the login screen (visible on both bare metal and VM consoles).
  {
    printf '\n'
    printf '  ============================================================\n'
    printf '    Firewalla is ready\n'
    printf '    SSH:  ssh pi@%s    (password: firewalla)\n' "$ip"
    printf '  ============================================================\n\n'
  } > /etc/issue 2>/dev/null
  # Force getty to redraw so the first-boot console shows /etc/issue with the IP immediately.
  systemctl restart getty@tty1 2>/dev/null || true
  log "console banner shown (dev=${dev:-?} ip=$ip)"
}

# ── main ───────────────────────────────────────────────────────────────────────

log "=== fireonboard start ==="

if [ ! -f "$ONBOARD_CONFIG" ]; then
  log "no onboard-config at $ONBOARD_CONFIG — nothing to do"; exit 0
fi
command -v jq >/dev/null 2>&1 || { log "ERROR: jq not installed"; exit 1; }

# 1) Wait for the stack (monotonic clock, safe on no-RTC boxes), up to 7 minutes.
read t0 _ < /proc/uptime; t0=${t0%.*}; up=0
while :; do
  if pgrep -f FireMain >/dev/null 2>&1 && [ -n "$(redis-cli hget sys:ept gid 2>/dev/null)" ]; then
    up=1; break
  fi
  read now _ < /proc/uptime
  [ $(( ${now%.*} - t0 )) -gt 420 ] && break
  sleep 2
done
if [ $up -ne 1 ]; then
  log "stack NOT ready after 420s - exit (will retry next boot)"; exit 1
fi
log "stack ready"

# 2) Apply network unconditionally (failure does not block license/activation).
apply_network || log "WARN: network apply failed, continuing"

# 2.5) Show the "SSH here" banner on tty1 (this one line only; silent otherwise).
show_ssh_banner

# 3) license + activation (node, onboard mode; bootstrap.js reads onboard-config itself).
log "launching bootstrap.js (onboard) ..."
HOME=/home/pi FW_ONBOARD_CONFIG="$ONBOARD_CONFIG" runuser -u pi -- bash -c "
  cd '$SCRIPTS_DIR' && '$NODE' bootstrap.js
"
rc=$?
log "bootstrap.js exit=$rc"
if [ $rc -eq 0 ]; then
  touch "$DONE" 2>/dev/null
  log "marked $DONE"
else
  log "NOT marking done - will retry next boot (or: sudo rm $DONE && sudo systemctl start fireonboard)"
fi
log "=== fireonboard end (rc=$rc) ==="
exit $rc
