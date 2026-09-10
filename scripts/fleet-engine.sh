#!/bin/bash
#
# Apply the flow-engine knobs: make brofish.service and suricata.service run
# fleet, zeek/suricata, or a mix, according to FW_FLOW_ENGINE_ZEEK and
# FW_FLOW_ENGINE_SURICATA (platform.sh, overridable per box by
# ~/.firewalla/config/flow_engine_zeek / flow_engine_suricata).
#
#   fleet-engine.sh apply     install / remove the systemd drop-ins (main-start)
#   fleet-engine.sh restart   apply, then restart whichever services run fleet
#   fleet-engine.sh status    print the knobs and what the units resolve to
#
# The unit files themselves are never touched: main-start copies the
# platform's brofish.service and suricata.service on every start, so fleet
# lives in drop-ins beside them. With both knobs at their stock values the
# drop-ins are removed and the box behaves as before.

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

: ${SYSTEMD_DIR:=/etc/systemd/system}
FLEET_BIN=${FLEET_BIN:-$FIREWALLA_HIDDEN/run/assets/fleet}
BROFISH_DROPIN=$SYSTEMD_DIR/brofish.service.d/fleet.conf
SURICATA_DROPIN=$SYSTEMD_DIR/suricata.service.d/fleet.conf
ZEEKCTL=/usr/local/${BRO_PROC_NAME:-zeek}/bin/${BRO_PROC_NAME:-zeek}ctl

log() { logger "FIREWALLA:FLEET-ENGINE $1"; echo "$1"; }

# the knobs, downgraded to the stock engine when the fleet binary is missing
# (the asset has not been downloaded yet): a drop-in pointing at a missing
# binary would leave the box without any flow logging
resolve() {
  ZEEK_ENGINE=$(get_flow_engine_zeek)
  SURICATA_ENGINE=$(get_flow_engine_suricata)
  if [[ $ZEEK_ENGINE == fleet || $SURICATA_ENGINE == fleet ]] && [[ ! -x $FLEET_BIN ]]; then
    log "fleet binary $FLEET_BIN not present, keeping zeek/suricata for now"
    ZEEK_ENGINE=zeek
    SURICATA_ENGINE=suricata
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
  elif [[ -e $SURICATA_DROPIN ]]; then
    sudo rm -f "$SURICATA_DROPIN"
    changed=true
    log "suricata.service -> suricata (drop-in removed)"
  fi

  $changed && sudo systemctl daemon-reload
  return 0
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
  echo "FW_FLOW_ENGINE_ZEEK=$(get_flow_engine_zeek) FW_FLOW_ENGINE_SURICATA=$(get_flow_engine_suricata) (effective: $ZEEK_ENGINE / $SURICATA_ENGINE)"
  echo "fleet binary: $([[ -x $FLEET_BIN ]] && "$FLEET_BIN" --help 2>&1 | head -1 || echo "missing at $FLEET_BIN")"
  for u in brofish suricata; do
    printf '%-9s %-8s %s\n' "$u" "$(systemctl is-active $u 2>/dev/null)" \
      "$(systemctl show $u -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -1 | cut -c1-90)"
  done
}

case "${1:-apply}" in
  apply)   apply ;;
  restart) apply; restart_fleet_services ;;
  status)  status ;;
  *) echo "usage: $0 apply|restart|status" >&2; exit 2 ;;
esac
