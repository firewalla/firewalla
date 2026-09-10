#!/bin/bash
#
# Sandbox test for scripts/fleet-engine.sh: renders the drop-ins for all four
# pcap_zeek_fleet / pcap_zeek_suricata combinations into a scratch directory
# (SYSTEMD_DIR), checks the binary-missing fallback, and checks that a failed
# install returns nonzero. Runs on a box (needs redis for the feature values)
# or anywhere with bash, jq and a FIREWALLA_HOME checkout; no service is
# touched: with SYSTEMD_DIR overridden the script neither reloads nor
# restarts anything.
#
#   sudo ./scripts/fleet-engine-test.sh          # on a box

: ${FIREWALLA_HOME:=/home/pi/firewalla}
set -u
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export SYSTEMD_DIR=$T/systemd
export FLEET_BIN=$T/fleet
printf '#!/bin/sh\necho fleet test\n' > "$FLEET_BIN"; chmod 755 "$FLEET_BIN"
ENGINE=$FIREWALLA_HOME/scripts/fleet-engine.sh
pass=0; failn=0
ok()   { echo "  ok   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# the features are read from redis; save and restore the box's values
saved_zf=$(redis-cli hget sys:features pcap_zeek_fleet 2>/dev/null)
saved_zs=$(redis-cli hget sys:features pcap_zeek_suricata 2>/dev/null)
restore() {
  for k in pcap_zeek_fleet:"$saved_zf" pcap_zeek_suricata:"$saved_zs"; do
    n=${k%%:*}; v=${k#*:}
    if [[ -n $v ]]; then redis-cli hset sys:features "$n" "$v" >/dev/null; else redis-cli hdel sys:features "$n" >/dev/null; fi
  done
}
trap 'restore; rm -rf "$T"' EXIT
setf() { redis-cli hset sys:features pcap_zeek_fleet "$1" pcap_zeek_suricata "$2" >/dev/null; }

B=$SYSTEMD_DIR/brofish.service.d/fleet.conf
S=$SYSTEMD_DIR/suricata.service.d/fleet.conf

echo "== fleet/fleet"
setf 1 1; sudo -E "$ENGINE" apply >/dev/null; check "apply returns 0" '[[ $? -eq 0 ]]'
# the templates name the asset path; FLEET_BIN here only stands in for its presence
ASSET=/home/pi/.firewalla/run/assets/fleet
check "brofish drop-in runs fleet without --no-suricata" 'grep -q "^ExecStart=$ASSET .* --http 127.0.0.1:8927  \$FLEET_OPTS" "$B"'
check "suricata drop-in holds the unit off" 'grep -q "^ConditionPathExists=" "$S"'
check "drop-ins are root-owned 0644" '[[ $(stat -c "%a %U" "$B") == "644 root" ]]'

echo "== fleet/suricata"
setf 1 0; sudo -E "$ENGINE" apply >/dev/null || bad "apply"
check "brofish drop-in carries --no-suricata" 'grep -q "^ExecStart=$ASSET .*--no-suricata" "$B"'
check "no suricata drop-in" '[[ ! -e $S ]]'

echo "== zeek/fleet"
setf 0 1; sudo -E "$ENGINE" apply >/dev/null || bad "apply"
check "no brofish drop-in" '[[ ! -e $B ]]'
check "suricata drop-in runs fleet --ids-only" 'grep -q "^ExecStart=$ASSET .*--ids-only" "$S"'

echo "== zeek/suricata"
setf 0 0; sudo -E "$ENGINE" apply >/dev/null || bad "apply"
check "no drop-ins at all" '[[ ! -e $B && ! -e $S ]]'

echo "== binary missing with both features on"
setf 1 1; rm -f "$FLEET_BIN"; out=$(sudo -E "$ENGINE" apply 2>&1); rc=$?
check "apply returns 0 (stock engines)" '[[ $rc -eq 0 ]]'
check "reports the missing binary" '[[ "$out" == *"not present"* ]]'
check "no drop-ins at all" '[[ ! -e $B && ! -e $S ]]'
check "shell roles resolve to zeek/suricata" '[[ $(bash -c "source $FIREWALLA_HOME/platform/platform.sh; echo \$(get_flow_engine_zeek)/\$(get_flow_engine_suricata)") == zeek/suricata ]]'
printf '#!/bin/sh\necho fleet test\n' > "$FLEET_BIN"; chmod 755 "$FLEET_BIN"

echo "== failed install returns nonzero and does not restart"
# SYSTEMD_DIR as a plain file: creating the drop-in directory fails even for root
setf 1 1; rm -rf "$SYSTEMD_DIR"; : > "$SYSTEMD_DIR"
out=$(sudo -E "$ENGINE" apply 2>&1); rc=$?
check "apply returns nonzero" '[[ $rc -ne 0 ]]'
check "reports the failure" '[[ "$out" == *FAILED* ]]'
check "switch does not restart after a failed apply" '! sudo -E "$ENGINE" switch >/dev/null 2>&1'
rm -f "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"

echo "== a failure after the first drop-in leaves the stock engines running"
# both features on, brofish drop-in installable, suricata one not: apply must
# fail before stopping anything
setf 1 1; rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"
: > "$SYSTEMD_DIR/suricata.service.d"          # a file where the directory must go
zeek_before=$(pgrep -c -x "${BRO_PROC_NAME:-zeek}" || true)
out=$(sudo -E "$ENGINE" apply 2>&1); rc=$?
check "apply returns nonzero" '[[ $rc -ne 0 ]]'
check "brofish drop-in was written before the failure" '[[ -f $B ]]'
check "zeek was not stopped" '[[ $(pgrep -c -x "${BRO_PROC_NAME:-zeek}" || true) == "$zeek_before" ]]'
check "no \"stopping zeek\" in the output" '[[ "$out" != *"stopping zeek"* ]]'
rm -f "$SYSTEMD_DIR/suricata.service.d"; rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"

echo "== pcap roles switched off"
# pcap_zeek off with both fleet features on: the suricata unit must run fleet
# ids-only, not be held off, or the box would have no IDS at all
setf 1 1; saved_pz=$(redis-cli hget sys:features pcap_zeek); redis-cli hset sys:features pcap_zeek 0 >/dev/null
sudo -E "$ENGINE" apply >/dev/null
check "suricata unit runs fleet --ids-only when pcap_zeek is off" 'grep -q "^ExecStart=$ASSET .*--ids-only" "$S"'
if [[ -n $saved_pz ]]; then redis-cli hset sys:features pcap_zeek "$saved_pz" >/dev/null; else redis-cli hdel sys:features pcap_zeek >/dev/null; fi
sudo -E "$ENGINE" apply >/dev/null
check "back to held-off once pcap_zeek is on again" 'grep -q "^ConditionPathExists=" "$S"'

echo "== restart starts a fleet-owned unit that is inactive"
# not run against the live units: check the code path instead
check "restart_fleet_services does not gate on is-active" '! grep -q "is-active -q brofish" "$ENGINE"'
check "restart_fleet_services resets a failed unit" 'grep -q "reset-failed brofish" "$ENGINE"'
check "restarts respect the pcap role features" 'grep -q "pcap_zeek_enabled" "$ENGINE" && grep -q "pcap_suricata_enabled" "$ENGINE"'

echo "== node reads the applied drop-ins, not the async feature table"
check "BroControl picks the cron template from the applied engine" 'grep -q "appliedZeekEngine" "$FIREWALLA_HOME/net2/BroControl.js"'
check "SuricataControl uses the applied engines" 'grep -q "appliedSuricataEngine" "$FIREWALLA_HOME/net2/SuricataControl.js"'
check "ZeekDPISensor uses the applied engine" 'grep -q "appliedZeekEngine" "$FIREWALLA_HOME/sensor/ZeekDPISensor.js"'

echo "== the failed-apply hold is honoured everywhere"
check "BroControl refuses to start brofish while held" 'grep -q "applyHeld" "$FIREWALLA_HOME/net2/BroControl.js"'
check "SuricataControl refuses to start suricata while held" 'grep -q "applyHeld" "$FIREWALLA_HOME/net2/SuricataControl.js"'
check "fleet-engine restart refuses while held" 'grep -q "not starting the pcap services" "$ENGINE"'
check "a successful apply lifts the hold" 'grep -q "rm -f \"\$FAILED_MARKER\"" "$ENGINE"'

echo "== zeek is stopped even without zeekctl, and restart failures propagate"
check "the pkill is not gated on zeekctl" '[[ $(grep -c "pkill -x" "$ENGINE") -ge 1 ]] && ! grep -q "pgrep -x .* && \[\[ -x \$ZEEKCTL \]\]" "$ENGINE"'
check "restart records a failure and returns it" 'grep -q "rc=1" "$ENGINE" && grep -q "return \$rc" "$ENGINE"'

echo "== scratch mode never touches live services"
setf 1 1
out=$(sudo -E "$ENGINE" apply 2>&1)
check "no service was stopped" '[[ "$out" != *stopping* ]]'
check "switch restarts nothing in scratch mode" '[[ -z "$(sudo -E "$ENGINE" switch 2>&1 | grep -i restart)" ]]'

echo "$pass passed, $failn failed"
[[ $failn -eq 0 ]]
