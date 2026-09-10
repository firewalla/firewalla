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
# a reload owed to systemd from an earlier apply whose daemon-reload failed
RELOAD_PENDING=/dev/shm/fleet-engine.reload-pending
# tests point SYSTEMD_DIR at a scratch directory: render and check files, never
# reload systemd or touch a running service
LIVE=false
[[ $SYSTEMD_DIR == /etc/systemd/system ]] && LIVE=true

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

fail() { log "FAILED: $1"; return 1; }

# Install or remove the drop-ins per the effective roles. Every state-changing
# step is checked and a failure returns nonzero without touching the rest, and
# the result is verified against what systemd will actually run, so a caller
# (FleetEnginePlugin, main-start) never restarts services on stale drop-ins.
apply() {
  resolve
  local changed=false

  if [[ $ZEEK_ENGINE == fleet ]]; then
    local opts=""
    [[ $SURICATA_ENGINE == fleet ]] || opts="--no-suricata"
    local tmp
    tmp=$(mktemp) || fail "mktemp" || return 1
    if ! sed "s#@FLEET_OPTS@#$opts#" "$FIREWALLA_HOME/etc/brofish-fleet.conf" > "$tmp"; then
      rm -f "$tmp"; fail "rendering brofish drop-in from $FIREWALLA_HOME/etc/brofish-fleet.conf"; return 1
    fi
    if ! sudo cmp -s "$tmp" "$BROFISH_DROPIN" 2>/dev/null; then
      if ! install_dropin "$tmp" "$BROFISH_DROPIN"; then
        rm -f "$tmp"; fail "installing $BROFISH_DROPIN"; return 1
      fi
      changed=true
      log "brofish.service -> fleet${opts:+ ($opts)}"
    fi
    rm -f "$tmp"
  elif [[ -e $BROFISH_DROPIN ]]; then
    sudo rm -f "$BROFISH_DROPIN" || fail "removing $BROFISH_DROPIN" || return 1
    changed=true
    log "brofish.service -> zeek (drop-in removed)"
  fi

  if [[ $SURICATA_ENGINE == fleet ]]; then
    local src
    # the brofish fleet can only do IDS while it is actually running, i.e. the
    # pcap_zeek feature is on as well; otherwise this unit runs fleet ids-only
    if [[ $ZEEK_ENGINE == fleet ]] && pcap_zeek_enabled; then
      src="$FIREWALLA_HOME/etc/suricata-fleet-off.conf"   # the brofish fleet does IDS
    else
      src="$FIREWALLA_HOME/etc/suricata-fleet-ids.conf"   # fleet in ids-only mode
    fi
    [[ -f $src ]] || fail "missing $src" || return 1
    if ! sudo cmp -s "$src" "$SURICATA_DROPIN" 2>/dev/null; then
      install_dropin "$src" "$SURICATA_DROPIN" || fail "installing $SURICATA_DROPIN" || return 1
      changed=true
      log "suricata.service -> $(basename "$src" .conf | sed 's/suricata-//')"
    fi
  elif [[ -e $SURICATA_DROPIN ]]; then
    sudo rm -f "$SURICATA_DROPIN" || fail "removing $SURICATA_DROPIN" || return 1
    changed=true
    log "suricata.service -> suricata (drop-in removed)"
  fi

  if $LIVE && { $changed || [[ -e $RELOAD_PENDING ]]; }; then
    # an owed reload from an earlier failure is retried here: without this a
    # second apply would find matching files, skip the reload and fail verify
    sudo touch "$RELOAD_PENDING" 2>/dev/null || true
    sudo systemctl daemon-reload || fail "systemctl daemon-reload" || return 1
    sudo rm -f "$RELOAD_PENDING" 2>/dev/null || true
  fi

  # Only once every file change is in place and verified: stop the stock
  # engines fleet has taken over from. A failure above returns before this, so
  # an unsuccessful apply leaves the running services alone.
  verify || return 1
  $LIVE && stop_replaced_engines
  return 0
}

# zeek must not run beside fleet (both would write the same spool), and zeekctl
# must record its nodes as stopped or `zeekctl cron` restarts them; the suricata
# processes must not run while fleet evaluates the rules
stop_replaced_engines() {
  if [[ $ZEEK_ENGINE == fleet ]] && pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1 && [[ -x $ZEEKCTL ]]; then
    log "stopping zeek through zeekctl"
    sudo timeout 60 "$ZEEKCTL" stop >/dev/null 2>&1 || true
    sudo pkill -x "${BRO_PROC_NAME:-zeek}" 2>/dev/null || true
  fi
  if [[ $SURICATA_ENGINE == fleet && $ZEEK_ENGINE == fleet ]] && pcap_zeek_enabled \
     && systemctl is-active -q suricata 2>/dev/null \
     && [[ "$(systemctl show suricata -p ExecStart --value 2>/dev/null)" != *"$FLEET_BIN"* ]]; then
    log "stopping suricata (fleet evaluates its rules)"
    sudo systemctl stop suricata 2>/dev/null || true
  fi
  return 0
}

# What is on disk and what systemd resolved must match the roles just applied.
# With SYSTEMD_DIR pointed elsewhere (tests) only the files can be checked.
verify() {
  local real=$LIVE
  if [[ $ZEEK_ENGINE == fleet ]]; then
    [[ -f $BROFISH_DROPIN ]] || fail "verify: $BROFISH_DROPIN missing" || return 1
    ! $real || [[ "$(systemctl show brofish -p ExecStart --value 2>/dev/null)" == *"$FLEET_BIN"* ]] \
      || fail "verify: brofish.service does not resolve to $FLEET_BIN" || return 1
  else
    [[ ! -e $BROFISH_DROPIN ]] || fail "verify: $BROFISH_DROPIN still present" || return 1
    ! $real || [[ "$(systemctl show brofish -p ExecStart --value 2>/dev/null)" != *"$FLEET_BIN"* ]] \
      || fail "verify: brofish.service still resolves to fleet" || return 1
  fi
  if [[ $SURICATA_ENGINE == fleet ]]; then
    [[ -f $SURICATA_DROPIN ]] || fail "verify: $SURICATA_DROPIN missing" || return 1
    if [[ $ZEEK_ENGINE != fleet ]]; then
      ! $real || [[ "$(systemctl show suricata -p ExecStart --value 2>/dev/null)" == *"$FLEET_BIN"* ]] \
        || fail "verify: suricata.service does not resolve to $FLEET_BIN" || return 1
    fi
  else
    [[ ! -e $SURICATA_DROPIN ]] || fail "verify: $SURICATA_DROPIN still present" || return 1
  fi
  return 0
}

# after a feature flip: both units restart so whatever the drop-ins now say
# takes effect (fleet in, zeek/suricata out, or the reverse)
switch_roles() {
  $LIVE || return 0
  pcap_zeek_enabled && { sudo systemctl restart brofish 2>/dev/null || true; }
  pcap_suricata_enabled && { sudo systemctl restart suricata 2>/dev/null || true; }
  return 0
}

# restart whichever services now run fleet (after the asset was updated, or
# after a knob changed); the stock services are left to FireMain
restart_fleet_services() {
  resolve
  $LIVE || return 0
  # `restart` starts an inactive or failed unit too, so fleet ends up running
  # the role it owns (the asset can arrive while a unit is down) -- but only
  # while the box wants that role at all: pcap_zeek / pcap_suricata off means
  # the pcap plugin has stopped the service on purpose
  if [[ $ZEEK_ENGINE == fleet ]] && pcap_zeek_enabled; then
    sudo systemctl reset-failed brofish 2>/dev/null || true
    sudo systemctl restart brofish || log "FAILED: restarting brofish"
  fi
  if [[ $SURICATA_ENGINE == fleet ]] && pcap_suricata_enabled \
     && { [[ $ZEEK_ENGINE != fleet ]] || ! pcap_zeek_enabled; }; then
    sudo systemctl reset-failed suricata 2>/dev/null || true
    sudo systemctl restart suricata || log "FAILED: restarting suricata"
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
  restart) apply && restart_fleet_services ;;
  switch)  apply && switch_roles ;;
  status)  status ;;
  *) echo "usage: $0 apply|restart|switch|status" >&2; exit 2 ;;
esac
