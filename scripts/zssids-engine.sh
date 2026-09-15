#!/bin/bash
#
# Apply the pcap_zeek_fleet / pcap_suricata_fleet features: make
# brofish.service and suricata.service run zssids, zeek/suricata, or a mix
# (platform.sh get_flow_engine_zeek / get_flow_engine_suricata, which read the
# features the way net2/config.js does: sys:features, then the platform's
# files/config.json userFeatures, then net2/config.json).
#
#   zssids-engine.sh apply     install / remove the systemd drop-ins (main-start,
#                             ZssidsEnginePlugin); stops zeek/suricata beside zssids
#   zssids-engine.sh restart   apply, then restart whichever services run zssids
#   zssids-engine.sh switch    apply, then restart both brofish and suricata so the
#                             current features take effect whichever way they moved
#   zssids-engine.sh status    print the features and what the units resolve to
#
# The unit files themselves are never touched: main-start copies the
# platform's brofish.service and suricata.service on every start, so zssids
# lives in drop-ins beside them. With both knobs at their stock values the
# drop-ins are removed and the box behaves as before.

TEST_MODE=${ZSSIDS_ENGINE_TEST_MODE:-false}
if [[ $TEST_MODE != true ]]; then
  [[ -z ${FIREWALLA_HOME+x} || $FIREWALLA_HOME == /home/pi/firewalla ]] \
    && [[ -z ${FIREWALLA_HIDDEN+x} || $FIREWALLA_HIDDEN == /home/pi/.firewalla ]] \
    && [[ -z ${SYSTEMD_DIR+x} || $SYSTEMD_DIR == /etc/systemd/system ]] \
    && [[ -z ${ZSSIDS_RUN_DIR+x} || $ZSSIDS_RUN_DIR == /home/pi/.firewalla/run/assets ]] \
    && [[ -z ${ZSSIDS_ENGINE_LOCK+x} || $ZSSIDS_ENGINE_LOCK == /dev/shm/zssids-engine.lock.d ]] \
    || { echo "FIREWALLA:ZSSIDS-ENGINE refusing noncanonical production paths" >&2; exit 1; }
fi
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
source "${FIREWALLA_HOME}/platform/platform.sh"

# Test mode deliberately drops privilege: even if a caller supplies arbitrary
# scratch paths, commands written as sudo below execute with the caller's own
# permissions.
if [[ $TEST_MODE == true ]]; then
  sudo() { command "$@"; }
fi

: ${SYSTEMD_DIR:=/etc/systemd/system}
# ZSSIDS_BIN comes from platform.sh (overridable in the environment for tests)
BROFISH_DROPIN=$SYSTEMD_DIR/brofish.service.d/zssids.conf
SURICATA_DROPIN=$SYSTEMD_DIR/suricata.service.d/zssids.conf
ZEEKCTL=/usr/local/${BRO_PROC_NAME:-zeek}/bin/${BRO_PROC_NAME:-zeek}ctl
# a reload owed to systemd from an earlier apply whose daemon-reload failed
RELOAD_PENDING=/dev/shm/zssids-engine.reload-pending
# main-start writes this when its apply failed; net2/FlowEngine.js reads the
# same path, and BroControl / SuricataControl refuse to start a service while
# it exists
FAILED_MARKER=/dev/shm/zssids-engine.failed
# the brofish drop-in launches zssids through this wrapper (preparation hooks)
# The drop-ins point at these, and they live beside the asset rather than in
# the git checkout: a soft-downgrade to a revision without this patch leaves
# the drop-ins in place (its main-start only rewrites the base units), and
# launchers that had vanished with the checkout would leave brofish and
# suricata pointing at missing executables, i.e. no capture at all. apply()
# refreshes these copies from the checkout while it is there.
ZSSIDS_RUN_DIR=${ZSSIDS_RUN_DIR:-$FIREWALLA_HIDDEN/run/assets}
ZSSIDS_RUN=$ZSSIDS_RUN_DIR/zssids-run
ZSSIDS_IDS_RUN=$ZSSIDS_RUN_DIR/zssids-ids-run
# tests point SYSTEMD_DIR at a scratch directory: render and check files, never
# reload systemd or touch a running service
LIVE=false
[[ $SYSTEMD_DIR == /etc/systemd/system ]] && LIVE=true

log() { logger "FIREWALLA:ZSSIDS-ENGINE $1"; echo "$1"; }

# the effective roles: platform.sh already folds the binary's availability in
# (a missing asset means the stock engines), so bro-run, fire-mem-check,
# zssids-ping.sh and the node side all agree with what is applied here
resolve() {
  ZEEK_ENGINE=$(get_flow_engine_zeek)
  SURICATA_ENGINE=$(get_flow_engine_suricata)
  if ! zssids_available && { _fw_feature_on pcap_zeek_fleet || _fw_feature_on pcap_suricata_fleet; }; then
    log "zssids binary $ZSSIDS_BIN not present, keeping zeek/suricata until the asset arrives"
  fi
}

fail() { log "FAILED: $1"; return 1; }

# Does the installed zssids know how to serve both roles from one process? An
# older asset predates the arrangement, so the two services stay separate until
# it catches up.
zssids_supports_shared_roles() {
  [[ -x $ZSSIDS_BIN ]] || return 1
  timeout 10 "$ZSSIDS_BIN" --capabilities 2>/dev/null | grep -qx "shared-roles"
}

# One zssids process under brofish.service serves both roles: it captures once
# per interface with zeek's own filters and evaluates the suricata rules on
# those packets, so the IDS sees what zeek sees and nothing else.
shared_roles() {
  [[ $ZEEK_ENGINE == zssids && $SURICATA_ENGINE == zssids ]] \
    && pcap_zeek_enabled && pcap_suricata_enabled && zssids_supports_shared_roles
}

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

  # keep the launchers the drop-ins name up to date, outside the checkout
  if [[ $ZEEK_ENGINE == zssids || $SURICATA_ENGINE == zssids ]]; then
    sudo install -d "$ZSSIDS_RUN_DIR" 2>/dev/null || true
    for l in zssids-run zssids-ids-run; do
      if [[ -f $FIREWALLA_HOME/scripts/$l ]] && ! sudo cmp -s "$FIREWALLA_HOME/scripts/$l" "$ZSSIDS_RUN_DIR/$l"; then
        sudo install -m 0755 "$FIREWALLA_HOME/scripts/$l" "$ZSSIDS_RUN_DIR/$l" || { fail "installing $ZSSIDS_RUN_DIR/$l"; return 1; }
      fi
    done
    [[ -x $ZSSIDS_RUN && -x $ZSSIDS_IDS_RUN ]] || { fail "launchers missing under $ZSSIDS_RUN_DIR"; return 1; }
  fi

  local stage
  stage=$(mktemp -d) || fail "mktemp -d" || return 1
  local want_brofish="" want_suricata=""

  # ---- render and validate every wanted file before touching anything ----
  if [[ $ZEEK_ENGINE == zssids ]]; then
    # One process for both roles when zssids owns both and the box wants both:
    # the box then runs one capture path instead of two, and the rules are
    # evaluated on the packets zeek captures.
    local opts="--no-suricata"
    if shared_roles; then
      opts=""
    fi
    [[ -f $FIREWALLA_HOME/etc/brofish-zssids.conf ]] \
      || { rm -rf "$stage"; fail "missing $FIREWALLA_HOME/etc/brofish-zssids.conf"; return 1; }
    want_brofish=$stage/brofish.conf
    if ! sed "s#@ZSSIDS_OPTS@#$opts#" "$FIREWALLA_HOME/etc/brofish-zssids.conf" > "$want_brofish"; then
      rm -rf "$stage"; fail "rendering the brofish drop-in"; return 1
    fi
    grep -q '^ExecStart=' "$want_brofish" \
      || { rm -rf "$stage"; fail "rendered brofish drop-in has no ExecStart"; return 1; }
  fi
  if [[ $SURICATA_ENGINE == zssids ]]; then
    # One unit or two: when the brofish zssids owns the flow role as well, it
    # serves the IDS too and this unit is held off. Otherwise the IDS gets a
    # zssids of its own here, with suricata's interfaces and suricata's own
    # filter.
    local src="$FIREWALLA_HOME/etc/suricata-zssids-ids.conf"
    if shared_roles; then
      src="$FIREWALLA_HOME/etc/suricata-zssids-off.conf"
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
  # the engines zssids has taken over from must be gone before anything may
  # start zssids, or both would write the same spool: the hold stays until they
  # are verified stopped
  if $LIVE && ! stop_replaced_engines; then
    fail "stopping the engines zssids replaces"
    return 1
  fi
  # /etc/cron.hourly/bro-cron runs `zeekctl cron`, which restarts nodes zeekctl
  # believes crashed: with zssids as brofish that would put zeek back beside it
  # on the same spool. bro-run reinstalls it when zeek owns the role again.
  if $LIVE; then
    if [[ $ZEEK_ENGINE == zssids ]]; then
      if [[ -e /etc/cron.hourly/bro-cron ]]; then
        if ! sudo rm -f /etc/cron.hourly/bro-cron || [[ -e /etc/cron.hourly/bro-cron ]]; then
          fail "removing /etc/cron.hourly/bro-cron"
          return 1
        fi
        log "removed /etc/cron.hourly/bro-cron"
      fi
    elif [[ ! -e /etc/cron.hourly/bro-cron && -f $FIREWALLA_HOME/etc/bro-cron ]] && ${FW_SCHEDULE_BRO:-true}; then
      sudo install -m 0755 "$FIREWALLA_HOME/etc/bro-cron" /etc/cron.hourly/bro-cron 2>/dev/null \
        || { fail "restoring /etc/cron.hourly/bro-cron"; return 1; }
    fi
  fi
  # verified, and nothing else is running: lift the hold (this also clears one
  # left by an earlier failed apply or by main-start)
  if $LIVE && { ! sudo rm -f "$FAILED_MARKER" 2>/dev/null || [[ -e $FAILED_MARKER ]]; }; then
    fail "clearing $FAILED_MARKER"
    return 1
  fi
  return 0
}

# zeek must not run beside zssids (both would write the same spool), and zeekctl
# must record its nodes as stopped or `zeekctl cron` restarts them; the suricata
# processes must not run while zssids evaluates the rules
# the stock daemon runs as "Suricata-Main", the binary is "suricata"
suricata_running() {
  pgrep -x Suricata-Main >/dev/null 2>&1 || pgrep -x suricata >/dev/null 2>&1
}

# Returns nonzero unless every engine zssids replaces is verified gone.
stop_replaced_engines() {
  local rc=0
  if [[ $ZEEK_ENGINE == zssids ]] && pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1; then
    # zeekctl first when it is there, so its state says "stopped" and
    # `zeekctl cron` does not restart the nodes; the processes have to go
    # either way, or zeek and zssids would write the same spool
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
  # folding two services into one: the IDS-only zssids under the suricata unit
  # has to stop, or two processes would evaluate the rules and write the same
  # eve.json while the watchdog watches only one of them
  if shared_roles && systemctl is-active -q suricata 2>/dev/null; then
    log "stopping the separate IDS service (one process serves both roles now)"
    if ! sudo systemctl stop suricata; then
      log "FAILED: stopping suricata"
      rc=1
    elif systemctl is-active -q suricata 2>/dev/null; then
      log "FAILED: suricata is still active"
      rc=1
    fi
  fi
  # the suricata unit runs zssids itself now (ids-only), so any real suricata
  # process left over from before the switch has to go: it would keep writing
  # the same eve.json. suricata-run daemonizes it as "Suricata-Main" (see
  # scripts/suricata-reload), which `pgrep -x suricata` never matches.
  if [[ $SURICATA_ENGINE == zssids ]] && suricata_running; then
    log "stopping leftover suricata processes"
    sudo pkill -x Suricata-Main 2>/dev/null || true
    sudo pkill -x suricata 2>/dev/null || true
    local i
    for i in 1 2 3 4 5; do
      suricata_running || break
      sleep 1
      sudo pkill -9 -x Suricata-Main 2>/dev/null || true
      sudo pkill -9 -x suricata 2>/dev/null || true
    done
    if suricata_running; then
      log "FAILED: suricata is still running"
      rc=1
    fi
  fi
  return $rc
}

# What is on disk and what systemd resolved must match the roles just applied.
# With SYSTEMD_DIR pointed elsewhere (tests) only the files can be checked.
verify() {
  local real=$LIVE
  if [[ $ZEEK_ENGINE == zssids ]]; then
    [[ -f $BROFISH_DROPIN ]] || fail "verify: $BROFISH_DROPIN missing" || return 1
    ! $real || [[ "$(systemctl show brofish -p ExecStart --value 2>/dev/null)" == *"$ZSSIDS_RUN"* ]] \
      || fail "verify: brofish.service does not resolve to $ZSSIDS_RUN" || return 1
  else
    [[ ! -e $BROFISH_DROPIN ]] || fail "verify: $BROFISH_DROPIN still present" || return 1
    ! $real || [[ "$(systemctl show brofish -p ExecStart --value 2>/dev/null)" != *"$ZSSIDS_RUN"* ]] \
      || fail "verify: brofish.service still resolves to zssids" || return 1
  fi
  if [[ $SURICATA_ENGINE == zssids ]]; then
    [[ -f $SURICATA_DROPIN ]] || fail "verify: $SURICATA_DROPIN missing" || return 1
    if ! shared_roles; then
      ! $real || [[ "$(systemctl show suricata -p ExecStart --value 2>/dev/null)" == *"$ZSSIDS_IDS_RUN"* ]] \
        || fail "verify: suricata.service does not resolve to $ZSSIDS_IDS_RUN" || return 1
    fi
  else
    [[ ! -e $SURICATA_DROPIN ]] || fail "verify: $SURICATA_DROPIN still present" || return 1
  fi
  return 0
}

# after a feature flip: both units restart so whatever the drop-ins now say
# takes effect (zssids in, zeek/suricata out, or the reverse)
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

# restart whichever services now run zssids (after the asset was updated, or
# after a knob changed); the stock services are left to FireMain
restart_zssids_services() {
  resolve
  $LIVE || return 0
  # a failed apply holds the services stopped on purpose (main-start's marker,
  # honoured by BroControl / SuricataControl too): do not start them here
  if [[ -e $FAILED_MARKER ]]; then
    log "FAILED: apply has not succeeded yet, not starting the pcap services"
    return 1
  fi
  local rc=0
  # `restart` starts an inactive or failed unit too, so zssids ends up running
  # the role it owns (the asset can arrive while a unit is down) -- but only
  # while the box wants that role at all: pcap_zeek / pcap_suricata off means
  # the pcap plugin has stopped the service on purpose
  if [[ $ZEEK_ENGINE == zssids ]] && pcap_zeek_enabled; then
    sudo systemctl reset-failed brofish 2>/dev/null || true
    sudo systemctl restart brofish || { log "FAILED: restarting brofish"; rc=1; }
  fi
  # the suricata unit runs zssids only when the roles are split; with one
  # process the brofish restart above covers the IDS as well
  if [[ $SURICATA_ENGINE == zssids ]] && pcap_suricata_enabled && ! shared_roles; then
    sudo systemctl reset-failed suricata 2>/dev/null || true
    sudo systemctl restart suricata || { log "FAILED: restarting suricata"; rc=1; }
  fi
  return $rc
}

status() {
  resolve
  echo "pcap_zeek_fleet -> zeek role: $(get_flow_engine_zeek); pcap_suricata_fleet -> suricata role: $(get_flow_engine_suricata) (effective: $ZEEK_ENGINE / $SURICATA_ENGINE)"
  echo "zssids binary: $([[ -x $ZSSIDS_BIN ]] && "$ZSSIDS_BIN" --help 2>&1 | head -1 || echo "missing at $ZSSIDS_BIN")"
  for u in brofish suricata; do
    printf '%-9s %-8s %s\n' "$u" "$(systemctl is-active $u 2>/dev/null)" \
      "$(systemctl show $u -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -1 | cut -c1-90)"
  done
}

# tests source this file to exercise single functions with stubs
[[ -n ${ZSSIDS_ENGINE_SOURCE_ONLY:-} ]] && return 0

apply_and_restart() { apply && restart_zssids_services; }
apply_and_switch()  { apply && switch_roles; }

# main-start, ZssidsEnginePlugin and the asset hook (which main-run launches in
# the background) can all land here at once: without a lock two applies could
# resolve different engines and interleave their commits, rollbacks and the
# shared hold marker. status needs no lock.
# A directory is the lock: mkdir is atomic and, unlike a lock file, needs no
# shared permissions (main-start runs as pi, the asset hook as root, and
# /dev/shm is world-writable). An apply that cannot take the lock fails rather
# than proceeding unlocked.
LOCK=${ZSSIDS_ENGINE_LOCK:-/dev/shm/zssids-engine.lock.d}
run_locked() {
  local waited=0

  pid_alive() {
    local pid=$1
    [[ $pid =~ ^[0-9]+$ ]] || return 1
    # An apply can run as root (asset hook) or pi (main-start). kill -0
    # returns EPERM across those users even while the process is alive; procfs
    # remains readable and prevents the lower-privileged caller stealing it.
    kill -0 "$pid" 2>/dev/null || [[ -d /proc/$pid ]]
  }

  until mkdir "$LOCK" 2>/dev/null; do
    # Only a lock whose owner is gone is stale. Age alone is not enough: a
    # switch back to zeek waits on `systemctl restart brofish`, and the stock
    # unit allows 250 s to start, so a live holder can hold the lock longer
    # than any timeout worth waiting.
    local owner
    owner=$(cat "$LOCK/pid" 2>/dev/null)
    if [[ -z $owner ]]; then
      # mkdir publishes the lock before its owner can publish the pid. Do not
      # steal a freshly acquired lock in that small initialization window. An
      # empty lock left by a crash is safe to reclaim only with rmdir, which
      # fails if the owner has created its pid file in the meantime.
      waited=$((waited + 1))
      if [[ $waited -ge 10 ]]; then
        # rmdir is atomic and refuses a directory whose owner published pid
        # meanwhile; sudo is needed when a root asset hook died after mkdir.
        if rmdir "$LOCK" 2>/dev/null || sudo rmdir "$LOCK" 2>/dev/null; then
          log "removed an abandoned uninitialized apply lock $LOCK"
          continue
        fi
      fi
      if [[ $waited -gt 600 ]]; then
        fail "an uninitialized apply still holds $LOCK"
        return 1
      fi
      sleep 1
      continue
    fi
    if ! pid_alive "$owner"; then
      log "removing the apply lock $LOCK left by process $owner"
      if [[ $(cat "$LOCK/pid" 2>/dev/null) == "$owner" ]]; then
        if sudo rm -rf "$LOCK" 2>/dev/null || rm -rf "$LOCK" 2>/dev/null; then
          continue
        fi
      fi
      waited=$((waited + 1))
      sleep 1
      continue
    fi
    waited=$((waited + 2))
    if [[ $waited -gt 600 ]]; then
      fail "another flow engine apply (pid $owner) still holds $LOCK"
      return 1
    fi
    sleep 2
  done
  if ! printf '%s\n' "$$" > "$LOCK/pid" 2>/dev/null; then
    rmdir "$LOCK" 2>/dev/null
    fail "recording ownership of $LOCK"
    return 1
  fi
  "$@"
  local rc=$?
  if [[ $(cat "$LOCK/pid" 2>/dev/null) == "$$" ]]; then
    if ! sudo rm -rf "$LOCK" 2>/dev/null && ! rm -rf "$LOCK" 2>/dev/null; then
      fail "releasing $LOCK"
      return 1
    fi
  else
    fail "lost ownership of $LOCK"
    return 1
  fi
  return $rc
}

case "${1:-apply}" in
  apply)   run_locked apply ;;
  restart) run_locked apply_and_restart ;;
  switch)  run_locked apply_and_switch ;;
  status)  status ;;
  *) echo "usage: $0 apply|restart|switch|status" >&2; exit 2 ;;
esac
