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
source "${FIREWALLA_HOME}/platform/platform.sh"

: ${SYSTEMD_DIR:=/etc/systemd/system}
# FLEET_BIN comes from platform.sh (overridable in the environment for tests)
BROFISH_DROPIN=$SYSTEMD_DIR/brofish.service.d/fleet.conf
SURICATA_DROPIN=$SYSTEMD_DIR/suricata.service.d/fleet.conf
ZEEKCTL=/usr/local/${BRO_PROC_NAME:-zeek}/bin/${BRO_PROC_NAME:-zeek}ctl
# a reload owed to systemd from an earlier apply whose daemon-reload failed
RELOAD_PENDING=/dev/shm/fleet-engine.reload-pending
# main-start writes this when its apply failed; net2/FlowEngine.js reads the
# same path, and BroControl / SuricataControl refuse to start a service while
# it exists
FAILED_MARKER=/dev/shm/fleet-engine.failed
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

fail() { log "FAILED: $1"; return 1; }

install_dropin() { # src dst
  sudo install -d "$(dirname "$2")" || return 1
  if $LIVE; then
    sudo install -m 0644 -o root -g root "$1" "$2" || return 1
  else
    sudo install -m 0644 "$1" "$2" || return 1
  fi
}

# Install or remove the drop-ins per the effective roles.
#
# Both desired files are rendered and validated first, then committed
# together; if the second commit fails the first is put back, so no caller
# ever sees one role updated and the other stale. Every state-changing step
# is checked, the hold marker covers the window regardless, and the result is
# verified against what systemd will actually run.
apply() {
  resolve
  # Transactional hold: from here until verification succeeds the drop-ins may
  # be partial, so nothing may start brofish or suricata. Every caller gets
  # this, and a crash mid-apply leaves the hold in place rather than a box
  # running the wrong engine. net2/FlowEngine.js reads the same marker, and
  # BroControl.restart / SuricataControl.restart honour it.
  if $LIVE && ! sudo touch "$FAILED_MARKER" 2>/dev/null; then
    fail "creating $FAILED_MARKER"
    return 1
  fi
  # and the reload obligation, before any file changes: an apply interrupted
  # after writing a drop-in would otherwise leave a retry with matching files,
  # no reload and a stale systemd view it could never recover from
  if $LIVE && ! sudo touch "$RELOAD_PENDING" 2>/dev/null; then
    fail "creating $RELOAD_PENDING"
    return 1
  fi

  local stage
  stage=$(mktemp -d) || fail "mktemp -d" || return 1
  local want_brofish="" want_suricata=""

  # ---- render and validate every wanted file before touching anything ----
  if [[ $ZEEK_ENGINE == fleet ]]; then
    local opts="--no-suricata"
    # the brofish fleet evaluates the rules only when it owns the IDS role and
    # the box wants an IDS at all; otherwise it must not write alerts
    [[ $SURICATA_ENGINE == fleet ]] && pcap_suricata_enabled && opts=""
    [[ -f $FIREWALLA_HOME/etc/brofish-fleet.conf ]] \
      || { rm -rf "$stage"; fail "missing $FIREWALLA_HOME/etc/brofish-fleet.conf"; return 1; }
    want_brofish=$stage/brofish.conf
    if ! sed "s#@FLEET_OPTS@#$opts#" "$FIREWALLA_HOME/etc/brofish-fleet.conf" > "$want_brofish"; then
      rm -rf "$stage"; fail "rendering the brofish drop-in"; return 1
    fi
    grep -q '^ExecStart=' "$want_brofish" \
      || { rm -rf "$stage"; fail "rendered brofish drop-in has no ExecStart"; return 1; }
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
    [[ -f $src ]] || { rm -rf "$stage"; fail "missing $src"; return 1; }
    want_suricata=$stage/suricata.conf
    cp -f "$src" "$want_suricata" || { rm -rf "$stage"; fail "staging $src"; return 1; }
  fi

  # ---- commit: install or remove, keeping copies to roll back with ----
  local changed=false rolled=""
  local backup=$stage/backup; mkdir -p "$backup"
  commit_one() { # want dst name
    local want=$1 dst=$2 name=$3
    if [[ -n $want ]]; then
      sudo cmp -s "$want" "$dst" 2>/dev/null && return 0
      if [[ -e $dst ]] && ! sudo cp -f "$dst" "$backup/$name" 2>/dev/null; then
        return 1
      fi
      rolled="$rolled $name:$dst"
      install_dropin "$want" "$dst" || return 1
      changed=true
      return 0
    fi
    [[ -e $dst ]] || return 0
    sudo cp -f "$dst" "$backup/$name" 2>/dev/null || return 1
    rolled="$rolled $name:$dst"
    sudo rm -f "$dst" || return 1
    changed=true
    return 0
  }
  rollback() {
    local entry name dst
    for entry in $rolled; do
      name=${entry%%:*}; dst=${entry#*:}
      if [[ -f $backup/$name ]]; then
        install_dropin "$backup/$name" "$dst" 2>/dev/null || true
      else
        sudo rm -f "$dst" 2>/dev/null || true
      fi
    done
  }

  if ! commit_one "$want_brofish" "$BROFISH_DROPIN" brofish; then
    rollback; rm -rf "$stage"; fail "installing $BROFISH_DROPIN"; return 1
  fi
  if ! commit_one "$want_suricata" "$SURICATA_DROPIN" suricata; then
    rollback; rm -rf "$stage"; fail "installing $SURICATA_DROPIN"; return 1
  fi
  $changed && log "brofish.service -> $ZEEK_ENGINE, suricata.service -> $SURICATA_ENGINE"

  if $LIVE; then
    if ! sudo systemctl daemon-reload; then
      rollback; rm -rf "$stage"; fail "systemctl daemon-reload"; return 1
    fi
    sudo rm -f "$RELOAD_PENDING" 2>/dev/null || true
  fi

  if ! verify; then
    rollback
    $LIVE && sudo systemctl daemon-reload 2>/dev/null
    rm -rf "$stage"
    return 1
  fi
  rm -rf "$stage"
  # the engines fleet has taken over from must be gone before anything may
  # start fleet, or both would write the same spool: the hold stays until they
  # are verified stopped
  if $LIVE && ! stop_replaced_engines; then
    fail "stopping the engines fleet replaces"
    return 1
  fi
  # verified, and nothing else is running: lift the hold (this also clears one
  # left by an earlier failed apply or by main-start)
  if $LIVE && { ! sudo rm -f "$FAILED_MARKER" 2>/dev/null || [[ -e $FAILED_MARKER ]]; }; then
    fail "clearing $FAILED_MARKER"
    return 1
  fi
  return 0
}

# zeek must not run beside fleet (both would write the same spool), and zeekctl
# must record its nodes as stopped or `zeekctl cron` restarts them; the suricata
# processes must not run while fleet evaluates the rules
# Returns nonzero unless every engine fleet replaces is verified gone.
stop_replaced_engines() {
  local rc=0
  if [[ $ZEEK_ENGINE == fleet ]] && pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1; then
    # zeekctl first when it is there, so its state says "stopped" and
    # `zeekctl cron` does not restart the nodes; the processes have to go
    # either way, or zeek and fleet would write the same spool
    if [[ -x $ZEEKCTL ]]; then
      log "stopping zeek through zeekctl"
      sudo timeout 60 "$ZEEKCTL" stop >/dev/null 2>&1 || true
    else
      log "zeekctl not at $ZEEKCTL, stopping the zeek processes directly"
    fi
    sudo pkill -x "${BRO_PROC_NAME:-zeek}" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5; do
      pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1 || break
      sleep 1
      sudo pkill -9 -x "${BRO_PROC_NAME:-zeek}" 2>/dev/null || true
    done
    if pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1; then
      log "FAILED: ${BRO_PROC_NAME:-zeek} is still running"
      rc=1
    fi
  fi
  if [[ $SURICATA_ENGINE == fleet && $ZEEK_ENGINE == fleet ]] && pcap_zeek_enabled \
     && systemctl is-active -q suricata 2>/dev/null \
     && [[ "$(systemctl show suricata -p ExecStart --value 2>/dev/null)" != *"$FLEET_BIN"* ]]; then
    log "stopping suricata (fleet evaluates its rules)"
    if ! sudo systemctl stop suricata; then
      log "FAILED: stopping suricata"
      rc=1
    elif systemctl is-active -q suricata 2>/dev/null; then
      log "FAILED: suricata is still active"
      rc=1
    fi
  fi
  return $rc
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
  local rc=0
  if pcap_zeek_enabled; then
    sudo systemctl restart brofish || { log "FAILED: restarting brofish"; rc=1; }
  fi
  if pcap_suricata_enabled; then
    sudo systemctl restart suricata || { log "FAILED: restarting suricata"; rc=1; }
  fi
  return $rc
}

# restart whichever services now run fleet (after the asset was updated, or
# after a knob changed); the stock services are left to FireMain
restart_fleet_services() {
  resolve
  $LIVE || return 0
  # a failed apply holds the services stopped on purpose (main-start's marker,
  # honoured by BroControl / SuricataControl too): do not start them here
  if [[ -e $FAILED_MARKER ]]; then
    log "FAILED: apply has not succeeded yet, not starting the pcap services"
    return 1
  fi
  local rc=0
  # `restart` starts an inactive or failed unit too, so fleet ends up running
  # the role it owns (the asset can arrive while a unit is down) -- but only
  # while the box wants that role at all: pcap_zeek / pcap_suricata off means
  # the pcap plugin has stopped the service on purpose
  if [[ $ZEEK_ENGINE == fleet ]] && pcap_zeek_enabled; then
    sudo systemctl reset-failed brofish 2>/dev/null || true
    sudo systemctl restart brofish || { log "FAILED: restarting brofish"; rc=1; }
  fi
  if [[ $SURICATA_ENGINE == fleet ]] && pcap_suricata_enabled \
     && { [[ $ZEEK_ENGINE != fleet ]] || ! pcap_zeek_enabled; }; then
    sudo systemctl reset-failed suricata 2>/dev/null || true
    sudo systemctl restart suricata || { log "FAILED: restarting suricata"; rc=1; }
  fi
  return $rc
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

# tests source this file to exercise single functions with stubs
[[ -n ${FLEET_ENGINE_SOURCE_ONLY:-} ]] && return 0

case "${1:-apply}" in
  apply)   apply ;;
  restart) apply && restart_fleet_services ;;
  switch)  apply && switch_roles ;;
  status)  status ;;
  *) echo "usage: $0 apply|restart|switch|status" >&2; exit 2 ;;
esac
