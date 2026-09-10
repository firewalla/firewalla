#!/bin/bash
#
# Apply the pcap_zeek_fleet / pcap_zeek_suricata features: make
# brofish.service and suricata.service run fleet, zeek/suricata, or a mix
# (platform.sh get_flow_engine_zeek / get_flow_engine_suricata, which read the
# features the way net2/config.js does: sys:features, then the platform's
# files/config.json userFeatures, then net2/config.json).
#
#   fleet-engine.sh apply     install / remove the systemd drop-ins (main-start,
#                             FleetEnginePlugin); stops zeek/suricata beside fleet
#   fleet-engine.sh restart   apply, then restart whichever services run fleet
#   fleet-engine.sh switch    apply, then restart both brofish and suricata so the
#                             current features take effect whichever way they moved
#   fleet-engine.sh status    print the features and what the units resolve to
#
# The unit files themselves are never touched: main-start copies the
# platform's brofish.service and suricata.service on every start, so fleet
# lives in drop-ins beside them. With both knobs at their stock values the
# drop-ins are removed and the box behaves as before.

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

: ${SYSTEMD_DIR:=/etc/systemd/system}
# FLEET_BIN comes from platform.sh (overridable in the environment for tests)
BROFISH_DROPIN=$SYSTEMD_DIR/brofish.service.d/fleet.conf
SURICATA_DROPIN=$SYSTEMD_DIR/suricata.service.d/fleet.conf
ZEEKCTL=/usr/local/${BRO_PROC_NAME:-zeek}/bin/${BRO_PROC_NAME:-zeek}ctl

log() { logger "FIREWALLA:FLEET-ENGINE $1"; echo "$1"; }

# the effective roles: platform.sh already folds the binary's availability in
# (a missing asset means the stock engines), so bro-run, fire-mem-check,
# fleet-ping.sh and the node side all agree with what is applied here
resolve() {
  ZEEK_ENGINE=$(get_flow_engine_zeek)
  SURICATA_ENGINE=$(get_flow_engine_suricata)
  if ! fleet_available && { _fw_feature_on pcap_zeek_fleet || _fw_feature_on pcap_zeek_suricata; }; then
    log "fleet binary $FLEET_BIN not present, keeping zeek/suricata until the asset arrives"
  fi
}

install_dropin() { # src dst
  sudo install -d "$(dirname "$2")"
  sudo install -m 0644 -o root -g root "$1" "$2"
}

apply() {
  resolve
  local changed=false

  if [[ $ZEEK_ENGINE == fleet ]]; then
    local opts=""
    [[ $SURICATA_ENGINE == fleet ]] || opts="--no-suricata"
    local tmp; tmp=$(mktemp)
    sed "s#@FLEET_OPTS@#$opts#" "$FIREWALLA_HOME/etc/brofish-fleet.conf" > "$tmp"
    if ! sudo cmp -s "$tmp" "$BROFISH_DROPIN" 2>/dev/null; then
      install_dropin "$tmp" "$BROFISH_DROPIN"
      changed=true
      log "brofish.service -> fleet${opts:+ ($opts)}"
    fi
    rm -f "$tmp"
    # zeek must not run beside fleet (both would write the same spool), and
    # zeekctl must record its nodes as stopped or `zeekctl cron` restarts them
    if pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1 && [[ -x $ZEEKCTL ]]; then
      log "stopping zeek through zeekctl"
      sudo timeout 60 "$ZEEKCTL" stop >/dev/null 2>&1 || true
      sudo pkill -x "${BRO_PROC_NAME:-zeek}" 2>/dev/null || true
    fi
  elif [[ -e $BROFISH_DROPIN ]]; then
    sudo rm -f "$BROFISH_DROPIN"
    changed=true
    log "brofish.service -> zeek (drop-in removed)"
  fi

  if [[ $SURICATA_ENGINE == fleet ]]; then
    local src
    if [[ $ZEEK_ENGINE == fleet ]]; then
      src="$FIREWALLA_HOME/etc/suricata-fleet-off.conf"   # the brofish fleet does IDS
    else
      src="$FIREWALLA_HOME/etc/suricata-fleet-ids.conf"   # fleet in ids-only mode beside zeek
    fi
    if ! sudo cmp -s "$src" "$SURICATA_DROPIN" 2>/dev/null; then
      install_dropin "$src" "$SURICATA_DROPIN"
      changed=true
      log "suricata.service -> $(basename "$src" .conf | sed 's/suricata-//')"
    fi
    # the suricata processes must not run while fleet evaluates the rules
    if [[ $ZEEK_ENGINE == fleet ]] && systemctl is-active -q suricata 2>/dev/null \
       && [[ "$(systemctl show suricata -p ExecStart --value 2>/dev/null)" != *"$FLEET_BIN"* ]]; then
      log "stopping suricata (fleet evaluates its rules)"
      sudo systemctl daemon-reload
      sudo systemctl stop suricata 2>/dev/null || true
      changed=false
    fi
  elif [[ -e $SURICATA_DROPIN ]]; then
    sudo rm -f "$SURICATA_DROPIN"
    changed=true
    log "suricata.service -> suricata (drop-in removed)"
  fi

  $changed && sudo systemctl daemon-reload
  return 0
}

# after a feature flip: both units restart so whatever the drop-ins now say
# takes effect (fleet in, zeek/suricata out, or the reverse)
switch_roles() {
  sudo systemctl restart brofish 2>/dev/null || true
  sudo systemctl restart suricata 2>/dev/null || true
}

# restart whichever services now run fleet (after the asset was updated, or
# after a knob changed); the stock services are left to FireMain
restart_fleet_services() {
  resolve
  if [[ $ZEEK_ENGINE == fleet ]] && systemctl is-active -q brofish; then
    sudo systemctl restart brofish
  fi
  if [[ $SURICATA_ENGINE == fleet && $ZEEK_ENGINE != fleet ]] && systemctl is-active -q suricata; then
    sudo systemctl restart suricata
  fi
}

status() {
  resolve
  echo "pcap_zeek_fleet -> zeek role: $(get_flow_engine_zeek); pcap_zeek_suricata -> suricata role: $(get_flow_engine_suricata) (effective: $ZEEK_ENGINE / $SURICATA_ENGINE)"
  echo "fleet binary: $([[ -x $FLEET_BIN ]] && "$FLEET_BIN" --help 2>&1 | head -1 || echo "missing at $FLEET_BIN")"
  for u in brofish suricata; do
    printf '%-9s %-8s %s\n' "$u" "$(systemctl is-active $u 2>/dev/null)" \
      "$(systemctl show $u -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -1 | cut -c1-90)"
  done
}

case "${1:-apply}" in
  apply)   apply ;;
  restart) apply; restart_fleet_services ;;
  switch)  apply; switch_roles ;;
  status)  status ;;
  *) echo "usage: $0 apply|restart|switch|status" >&2; exit 2 ;;
esac
