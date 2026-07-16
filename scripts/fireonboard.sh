#!/bin/bash
# fireonboard.sh — unattended onboard dispatcher (replaces the interactive fw-firstboot path).
#
# Launched in the background by fireonboard.service on first boot, fully silent: nothing is shown
# on the console; all output goes to /home/pi/.firewalla/fireonboard.log (for dev troubleshooting).
#
# Does two things:
#   1) Wait for the app stack (FireMain + sys:ept.gid)
#   2) Run bootstrap.js (onboard mode): write license unconditionally; if msp/app was selected,
#      register(bid) -> wait for the user to click activate -> join MSP / join App
#
# Network is applied by FireRouter itself on first boot (it reads onboard-config.network as its
# initial config), so this script no longer touches the network.
#
# /data/.fireonboard-done is written only after bootstrap.js succeeds (exit 0); otherwise retry next boot.

set -u

ONBOARD_CONFIG="${FW_ONBOARD_CONFIG:-/home/pi/.firewalla/onboard-config.json}"
LOG="${FW_ONBOARD_LOG:-/home/pi/.firewalla/fireonboard.log}"
DONE=/data/.fireonboard-done
NODE=/home/pi/firewalla/bin/node
SCRIPTS_DIR=/home/pi/firewalla/scripts

mkdir -p "$(dirname "$LOG")" 2>/dev/null
# Send all stdout/stderr to the log — keep the console silent for the user.
exec >>"$LOG" 2>&1
log(){ printf '[fireonboard %s] %s\n' "$(date -Is 2>/dev/null || date)" "$*"; }

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

# 2) Show the "SSH here" banner on tty1 (this one line only; silent otherwise).
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
