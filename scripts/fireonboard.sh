#!/bin/bash
# fireonboard.sh — unattended onboard dispatcher (replaces the interactive fw-firstboot path).
#
# Waits for what bootstrap.js needs (FireKick's sys:ept + internet), then runs it.
# Output goes to ~/.firewalla/fireonboard.log; /data/.fireonboard-done marks success.

set -u

ONBOARD_CONFIG="${FW_ONBOARD_CONFIG:-/home/pi/.firewalla/onboard-config.json}"
LOG="${FW_ONBOARD_LOG:-/home/pi/.firewalla/fireonboard.log}"
DONE=/data/.fireonboard-done
NODE=/home/pi/firewalla/bin/node
SCRIPTS_DIR=/home/pi/firewalla/scripts
PROVISION_HOST="${FW_PROVISION_HOST:-msp.dd.firewalla.net}"
WARN_AFTER="${FW_ONBOARD_WARN_AFTER:-80}"   # seconds offline before warning on the console

mkdir -p "$(dirname "$LOG")" 2>/dev/null
exec >>"$LOG" 2>&1
log(){ printf '[fireonboard %s] %s\n' "$(date -Is 2>/dev/null || date)" "$*"; }

# Echoes "<ip> [note]": the default-route address, else any global one — reachable from the LAN side
# only, so it gets labelled. Empty when the box has no address at all.
current_ip(){
  local dev="" ip=""
  dev=$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')
  [ -n "$dev" ] && ip=$(ip -4 -br addr show "$dev" 2>/dev/null | awk '{print $3}' | cut -d/ -f1)
  [ -n "$ip" ] && { echo "$ip"; return; }
  ip=$(ip -4 -br addr show scope global 2>/dev/null | awk 'NR==1{print $3}' | cut -d/ -f1)
  [ -n "$ip" ] && echo "$ip LAN port"
}

# banner <headline> [detail] — the console is the only channel when the box is unreachable.
banner(){
  local ip="" note=""
  read -r ip note <<< "$(current_ip)"
  {
    printf '\n'
    printf '  ============================================================\n'
    printf '    %s\n' "$1"
    [ -n "${2:-}" ] && printf '    %s\n' "$2"
    [ -n "$ip" ] && printf '    IP:  %s%s\n' "$ip" "${note:+   [$note]}"
    printf '  ============================================================\n\n'
  } > /etc/issue 2>/dev/null
  systemctl restart getty@tty1 2>/dev/null || true   # force getty to redraw /etc/issue now
  log "console banner: $1 (ip=${ip:-none}${note:+ $note})"
}

# FireKick's hmset: gid gates bootstrap's waitForGid(), token gates bone.cloudready(). Not FireMain.
ept_ready(){ [ -n "$(redis-cli hget sys:ept token 2>/dev/null)" ]; }

# Any one is enough: upstreams may drop ICMP or hijack DNS. No TLS — a stale clock breaks handshakes.
net_ready(){
  timeout 3 bash -c "exec 3<>/dev/tcp/$PROVISION_HOST/443" 2>/dev/null && { NET_VIA="tcp:$PROVISION_HOST"; return 0; }
  curl -sf -m 5 -o /dev/null http://connectivitycheck.gstatic.com/generate_204 && { NET_VIA="http:gstatic"; return 0; }
  ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && { NET_VIA="ping:1.1.1.1"; return 0; }
  ping -c1 -W2 8.8.8.8 >/dev/null 2>&1 && { NET_VIA="ping:8.8.8.8"; return 0; }
  return 1
}

# ── main ───────────────────────────────────────────────────────────────────────

log "=== fireonboard start ==="

if [ ! -f "$ONBOARD_CONFIG" ]; then
  log "no onboard-config at $ONBOARD_CONFIG — nothing to do"; exit 0
fi

# Wait indefinitely: without internet there is nothing to do but keep trying.
read t0 _ < /proc/uptime; t0=${t0%.*}; warned=0; NET_VIA=""
banner "Firewalla Crystal is starting - verifying network" "Activation starts automatically once the network is ready."
while :; do
  net=0; net_ready && net=1
  [ "$net" = 1 ] && ept_ready && break
  read now _ < /proc/uptime
  if [ "$warned" -eq 0 ] && [ "$net" = 0 ] && [ $(( ${now%.*} - t0 )) -gt "$WARN_AFTER" ]; then
    banner "Firewalla is starting - no internet yet" \
           "Check the cable and your WAN settings (DHCP / PPPoE / static IP)."
    warned=1
  fi
  sleep 2
done
log "ready: sys:ept published, internet confirmed via $NET_VIA"

banner "Firewalla is up and ready to activate" "Activate this box from the MSP web console."

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
