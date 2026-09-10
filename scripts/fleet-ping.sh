#!/bin/bash
#
# Watchdog for fleet, the brofish-ping.sh counterpart used when the
# pcap_zeek_fleet and/or pcap_zeek_suricata feature is on.
#
# brofish-ping.sh decides whether workers are alive by running `zeekctl top`,
# which cannot see fleet. This asks fleet itself: `fleet --status` checks the
# process answers over its local API AND that every capture thread published
# a snapshot in the last few seconds, so a dead capture thread is caught rather
# than silently losing one link. It also makes sure zeek is not running beside
# fleet (both would write the same spool).

: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${FIREWALLA_HIDDEN:=/home/pi/.firewalla}
source "${FIREWALLA_HOME}/platform/platform.sh"

FLEET=${FLEET:-$FIREWALLA_HIDDEN/run/assets/fleet}
HEARTBEAT_DIR=${HEARTBEAT_DIR:-$(get_zeek_log_dir)}
MMIN=${MMIN:-15}
TOTAL_RETRIES=${TOTAL_RETRIES:-5}
SLEEP_TIMEOUT=${SLEEP_TIMEOUT:-3}
ZEEK_ENGINE=$(get_flow_engine_zeek)
SURICATA_ENGINE=$(get_flow_engine_suricata)

log() { "$FIREWALLA_HOME/scripts/firelog" -t cloud -m "$1"; }

# a failed or interrupted apply holds the pcap services stopped on purpose
# (net2/FlowEngine.js and both control classes honour the same marker): do not
# restart anything on a configuration nobody verified
if [[ -e /dev/shm/fleet-engine.failed ]]; then
  logger "fleet-ping: flow engine configuration is held back, not checking"
  exit 0
fi

# fleet can own both roles at once, in two processes: brofish for the flows and
# suricata for the IDS. Check each one it owns; a role the box has switched off
# is not ours to watch.
# One role per invocation, so the two cron entries (crontab.fleet for the flow
# role, suricata/crontab.fleet-ids for the IDS) do not both check everything:
#   fleet-ping.sh [brofish|suricata]    default: every role fleet owns
WANT=${1:-all}
ROLES=()
if [[ $ZEEK_ENGINE == fleet ]] && pcap_zeek_enabled && [[ $WANT == all || $WANT == brofish ]]; then
  ROLES+=("brofish:127.0.0.1:8927")
fi
if [[ $SURICATA_ENGINE == fleet ]] && pcap_suricata_enabled && [[ $WANT == all || $WANT == suricata ]]; then
  ROLES+=("suricata:127.0.0.1:8928")
fi
[[ ${#ROLES[@]} -gt 0 ]] || exit 0   # nothing of ours to check

# the IDS process is launched with suricata's interface list (node.cfg is only
# refreshed while the zeek role runs, so it can be stale or absent); --status
# has to ask about the same interfaces or it would judge the wrong ones
ids_status_args=()
if [[ -r $FIREWALLA_HIDDEN/run/suricata/listen_interfaces.rc ]]; then
  source "$FIREWALLA_HIDDEN/run/suricata/listen_interfaces.rc"
  for intf in $LISTEN_INTERFACES; do
    ids_status_args+=(-i "$intf")
  done
fi

# only fleet's own service is ours to restart: if the unit currently runs
# something else (drop-in missing after a switch), leave it to FireMain
# one pass per role fleet owns
overall=0
for role in "${ROLES[@]}"; do
  SERVICE=${role%%:*}
  HTTP=${role#*:}

  # brofish runs fleet through scripts/fleet-run, the IDS unit through
  # scripts/fleet-ids-run
  exec_now=$(systemctl show "$SERVICE" -p ExecStart --value 2>/dev/null)
  if [[ "$exec_now" != *"$FLEET"* && "$exec_now" != *fleet-run* && "$exec_now" != *fleet-ids-run* ]]; then
    logger "fleet-ping: $SERVICE does not run fleet (${exec_now:0:100}); not checking"
    continue
  fi

  # zeek must not run beside the brofish fleet: `zeekctl cron` restarts nodes
  # zeekctl believes crashed, so stop it through zeekctl, which records them as
  # stopped, and log who launched it so the trigger can be found
  if [[ $SERVICE == brofish ]] && pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1; then
    zpid=$(pgrep -o -x "${BRO_PROC_NAME:-zeek}")
    log "fleet-ping: zeek running beside fleet, stopping it: $(ps -o ppid=,lstart=,cmd= -p "$zpid" | cut -c1-120) cgroup=$(cat /proc/$zpid/cgroup 2>/dev/null | tr '\n' ' ')"
    sudo timeout 60 /usr/local/${BRO_PROC_NAME:-zeek}/bin/${BRO_PROC_NAME:-zeek}ctl stop >/dev/null 2>&1 || true
    sudo pkill -x "${BRO_PROC_NAME:-zeek}" 2>/dev/null || true
  fi

  # logs are still being written (the same check brofish-ping.sh makes); only
  # meaningful for the brofish role, an ids-only fleet writes no zeek logs
  check_heartbeat() {
    [[ $SERVICE == brofish ]] || return 0
    local result
    result=$(find "$HEARTBEAT_DIR" -follow -name 'heartbeat.*' -mmin -${MMIN} 2>/dev/null)
    [[ -n "$result" ]]
  }

  # the process is answering and every interface it captures is publishing
  check_status() {
    local args=(--zeekctl-compat)
    if [[ $SERVICE == suricata && ${#ids_status_args[@]} -gt 0 ]]; then
      args+=("${ids_status_args[@]}")
    fi
    sudo "$FLEET" "${args[@]}" --http "$HTTP" --status >/dev/null 2>&1
  }

  result_hb="OK"
  result_status="OK"
  ok=false
  for ((retry = 0; retry < TOTAL_RETRIES; retry++)); do
    ok=true
    check_heartbeat && result_hb="OK" || { ok=false; result_hb="fail"; }
    check_status && result_status="OK" || { ok=false; result_status="fail"; }
    $ok && break
    sleep $SLEEP_TIMEOUT
  done

  if ! $ok; then
    detail=$(sudo "$FLEET" --zeekctl-compat --http "$HTTP" --status 2>&1 | tr '\n' ' ')
    log "fleet ping failed(HB:$result_hb, Status:$result_status), restarting $SERVICE: $detail"
    sudo systemctl restart "$SERVICE" || overall=1
  fi
done
exit $overall
