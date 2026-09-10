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

# which service runs fleet, and on which API port; a role the box has switched
# off is not ours to watch
if [[ $ZEEK_ENGINE == fleet ]] && pcap_zeek_enabled; then
  SERVICE=brofish; HTTP=127.0.0.1:8927
elif [[ $SURICATA_ENGINE == fleet ]] && pcap_suricata_enabled; then
  SERVICE=suricata; HTTP=127.0.0.1:8928
else
  exit 0   # nothing of ours is running
fi

# only fleet's own service is ours to restart: if the unit currently runs
# something else (drop-in missing after a switch), leave it to FireMain
exec_now=$(systemctl show $SERVICE -p ExecStart --value 2>/dev/null)
if [[ "$exec_now" != *"$FLEET"* ]]; then
  logger "fleet-ping: $SERVICE does not run fleet (${exec_now:0:100}); not checking"
  exit 0
fi

# zeek must not run beside fleet: `zeekctl cron` (fire-mem-check) restarts
# nodes zeekctl believes crashed, so stop it through zeekctl, which records
# them as stopped, and log who launched it so the trigger can be found
if [[ $SERVICE == brofish ]] && pgrep -x "${BRO_PROC_NAME:-zeek}" >/dev/null 2>&1; then
  zpid=$(pgrep -o -x "${BRO_PROC_NAME:-zeek}")
  log "fleet-ping: zeek running beside fleet, stopping it: $(ps -o ppid=,lstart=,cmd= -p "$zpid" | cut -c1-120) cgroup=$(cat /proc/$zpid/cgroup 2>/dev/null | tr '\n' ' ')"
  sudo timeout 60 /usr/local/${BRO_PROC_NAME:-zeek}/bin/${BRO_PROC_NAME:-zeek}ctl stop >/dev/null 2>&1 || true
  sudo pkill -x "${BRO_PROC_NAME:-zeek}" 2>/dev/null || true
fi

# logs are still being written (same check brofish-ping.sh makes); only
# meaningful for the brofish role, an ids-only fleet writes no zeek logs
check_heartbeat() {
  [[ $SERVICE == brofish ]] || return 0
  local result
  result=$(find "$HEARTBEAT_DIR" -follow -name 'heartbeat.*' -mmin -${MMIN} 2>/dev/null)
  [[ -n "$result" ]]
}

# the process is answering and every interface is still publishing
check_status() {
  sudo "$FLEET" --zeekctl-compat --http "$HTTP" --status >/dev/null 2>&1
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
  sudo systemctl restart $SERVICE
fi
