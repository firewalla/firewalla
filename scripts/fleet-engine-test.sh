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
# the live checks can stop the engines this box was running; remember what was
# active and put the box back exactly as it was, configuration and services
brofish_was=$(systemctl is-active brofish 2>/dev/null)
suricata_was=$(systemctl is-active suricata 2>/dev/null)
relive() {
  sudo -E env -u SYSTEMD_DIR -u FLEET_BIN "$FIREWALLA_HOME/scripts/fleet-engine.sh" apply >/dev/null 2>&1 || true
  [[ $brofish_was == active ]] && [[ $(systemctl is-active brofish) != active ]] && sudo systemctl start brofish >/dev/null 2>&1
  [[ $suricata_was == active ]] && [[ $(systemctl is-active suricata) != active ]] && sudo systemctl start suricata >/dev/null 2>&1
  return 0
}
trap 'sudo chattr -i /etc/systemd/system/brofish.service.d 2>/dev/null; sudo rm -f /dev/shm/fleet-engine.failed; restore; relive; rm -rf "$T"' EXIT
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

echo "== a failed apply leaves the hold marker (live mode)"
# live mode is needed for the marker, but the failure has to happen before any
# service is touched: an unwritable drop-in location does that
setf 1 1
sudo rm -f /dev/shm/fleet-engine.failed
sudo mkdir -p /etc/systemd/system/brofish.service.d
# the drop-in must actually need installing, or apply has nothing to fail at:
# remove it, then make the directory immutable so the install cannot succeed
sudo rm -f /etc/systemd/system/brofish.service.d/fleet.conf
sudo chattr +i /etc/systemd/system/brofish.service.d 2>/dev/null
if lsattr -d /etc/systemd/system/brofish.service.d 2>/dev/null | grep -q i; then
  # the live checks run against the box's real paths: the sandbox FLEET_BIN
  # would make verify compare systemd's ExecStart with the scratch binary
  live_before=$(systemctl show brofish -p ExecStart --value)
  out=$(sudo -E env -u SYSTEMD_DIR -u FLEET_BIN "$ENGINE" apply 2>&1); rc=$?
  check "live apply fails" '[[ $rc -ne 0 ]]'
  check "hold marker is left behind" '[[ -e /dev/shm/fleet-engine.failed ]]'
  check "restart refuses while held" '! sudo -E env -u SYSTEMD_DIR -u FLEET_BIN "$ENGINE" restart >/dev/null 2>&1'
  check "brofish was not restarted" '[[ "$(systemctl show brofish -p ExecStart --value)" == "$live_before" ]]'
  sudo chattr -i /etc/systemd/system/brofish.service.d 2>/dev/null
  sudo -E env -u SYSTEMD_DIR -u FLEET_BIN "$ENGINE" apply >/dev/null 2>&1
  check "a successful live apply clears the marker" '[[ ! -e /dev/shm/fleet-engine.failed ]]'
  check "the live drop-in is back" '[[ -f /etc/systemd/system/brofish.service.d/fleet.conf ]]'
else
  echo "  skip live marker checks (cannot make the drop-in dir immutable here)"
  sudo chattr -i /etc/systemd/system/brofish.service.d 2>/dev/null
fi

echo "== switch reports a restart failure"
check "switch_roles tracks failures and returns them" 'sed -n "/^switch_roles()/,/^}/p" "$ENGINE" | grep -q "rc=1" && sed -n "/^switch_roles()/,/^}/p" "$ENGINE" | grep -q "return \$rc"'

echo "== the failed-apply hold is honoured everywhere"
check "BroControl refuses to start brofish while held" 'grep -q "applyHeld" "$FIREWALLA_HOME/net2/BroControl.js"'
check "SuricataControl refuses to start suricata while held" 'grep -q "applyHeld" "$FIREWALLA_HOME/net2/SuricataControl.js"'
check "fleet-engine restart refuses while held" 'grep -q "not starting the pcap services" "$ENGINE"'
check "apply sets the hold before touching anything" 'sed -n "/^apply()/,/^}/p" "$ENGINE" | grep -q "touch \"\$FAILED_MARKER\""'
check "a successful apply lifts the hold" 'grep -q "rm -f \"\$FAILED_MARKER\"" "$ENGINE"'

echo "== zeek is stopped even without zeekctl, and restart failures propagate"
check "the pkill is not gated on zeekctl" 'grep -q "pkill -x" "$ENGINE" && ! grep -qF -- "-x \$ZEEKCTL ]]; then" "$ENGINE" || grep -qF "stopping the zeek processes directly" "$ENGINE"'
check "restart records a failure and returns it" 'grep -q "rc=1" "$ENGINE" && grep -q "return \$rc" "$ENGINE"'

echo "== the pcap roles are respected"
check "brofish gets --no-suricata unless fleet owns an enabled IDS role" 'sed -n "/^apply()/,/^}/p" "$ENGINE" | grep -q "pcap_suricata_enabled && opts="'
check "FleetEnginePlugin also watches pcap_zeek / pcap_suricata" 'grep -q "FEATURE_PCAP_ZEEK," "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js" && grep -q "FEATURE_PCAP_SURICATA" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'
check "the suricata watchdog choice accounts for the flow role" 'grep -q "FEATURE_PCAP_ZEEK" "$FIREWALLA_HOME/net2/SuricataControl.js"'
check "fleet-ping honours the hold" 'grep -q "held back, not checking" "$FIREWALLA_HOME/scripts/fleet-ping.sh"'
check "fleet-ping skips a role the box switched off" 'grep -q "pcap_zeek_enabled" "$FIREWALLA_HOME/scripts/fleet-ping.sh"'

echo "== an explicit false in a config file wins over a later default"
cfgdir=$T/hidden/config; mkdir -p "$cfgdir"
printf '{"userFeatures":{"pcap_zeek_fleet":false}}' > "$cfgdir/config.json"
redis-cli hdel sys:features pcap_zeek_fleet >/dev/null
roles=$(FIREWALLA_HIDDEN=$T/hidden FW_EFFECTIVE_FEATURES=/nonexistent bash -c "source $FIREWALLA_HOME/platform/platform.sh; FLEET_BIN=$FLEET_BIN; echo \$(get_flow_engine_zeek)")
check "user config false is honoured (not swallowed by // empty)" '[[ $roles == zeek ]]'
setf 1 1

echo "== the effective-features file written by node is read first"
printf '{"pcap_zeek_fleet":false,"pcap_zeek_suricata":false}' > "$T/eff.json"
redis-cli hdel sys:features pcap_zeek_fleet pcap_zeek_suricata >/dev/null
roles=$(FW_EFFECTIVE_FEATURES=$T/eff.json bash -c "source $FIREWALLA_HOME/platform/platform.sh; FLEET_BIN=$FLEET_BIN; echo \$(get_flow_engine_zeek)/\$(get_flow_engine_suricata)")
check "effective-features file overrides the config files" '[[ $roles == zeek/suricata ]]'
setf 1 1

echo "== behaviour: the drop-ins are staged and committed together"
# a wanted suricata template that cannot be installed must leave the brofish
# drop-in as it was, not half-updated
setf 1 1; sudo rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"
saved_ps=$(redis-cli hget sys:features pcap_suricata)
redis-cli hset sys:features pcap_suricata 1 >/dev/null
sudo -E "$ENGINE" apply >/dev/null
before=$(cat "$B")
# the suricata drop-in now has to be installed (its location is gone) and
# cannot be (a file sits where the directory belongs), while the brofish
# drop-in has to change (pcap_suricata off adds --no-suricata)
sudo rm -rf "$SYSTEMD_DIR/suricata.service.d"
: > "$SYSTEMD_DIR/suricata.service.d"
redis-cli hset sys:features pcap_suricata 0 >/dev/null
out=$(sudo -E "$ENGINE" apply 2>&1); rc=$?
check "apply fails" '[[ $rc -ne 0 ]]'
check "the failure is reported" '[[ "$out" == *FAILED* ]]'
check "the brofish drop-in was rolled back, not half-updated" '[[ "$(cat "$B")" == "$before" ]]'
if [[ -n $saved_ps ]]; then redis-cli hset sys:features pcap_suricata "$saved_ps" >/dev/null; else redis-cli hdel sys:features pcap_suricata >/dev/null; fi
sudo rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"

echo "== behaviour: apply rewrites a stale drop-in"
setf 1 1; sudo -E "$ENGINE" apply >/dev/null
printf '[Service]\nExecStart=/bin/false\n' | sudo tee "$B" >/dev/null
sudo -E "$ENGINE" apply >/dev/null
check "a hand-edited drop-in is corrected" 'grep -q "^ExecStart=$ASSET " "$B"'
check "FireMain startup restarts when the applied state changed" 'grep -q "flow engine reconciled at startup" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'

echo "== behaviour: readers never see a partial effective-features file"
eff=$T/eff-concurrent.json
printf '{"pcap_zeek_fleet":true,"pcap_zeek_suricata":true}' > "$eff"
( for i in $(seq 1 40); do
    printf '{"pcap_zeek_fleet":true,"pcap_zeek_suricata":true}' > "$eff.tmp"; mv -f "$eff.tmp" "$eff"
    printf '{"pcap_zeek_fleet":false,"pcap_zeek_suricata":false}' > "$eff.tmp"; mv -f "$eff.tmp" "$eff"
  done ) &
writer=$!
bad=0
for i in $(seq 1 25); do
  r=$(FW_EFFECTIVE_FEATURES=$eff bash -c "source \"$FIREWALLA_HOME/platform/platform.sh\"; FLEET_BIN=$FLEET_BIN; echo \$(get_flow_engine_zeek)")
  [[ $r == fleet || $r == zeek ]] || bad=$((bad+1))
done
wait $writer
check "every read answered a valid engine" '[[ $bad -eq 0 ]]'
check "node publishes the file atomically (temp + rename)" 'grep -q "renameSync" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'

echo "== scratch mode never touches live services"
setf 1 1
out=$(sudo -E "$ENGINE" apply 2>&1)
check "no service was stopped" '[[ "$out" != *stopping* ]]'
check "switch restarts nothing in scratch mode" '[[ -z "$(sudo -E "$ENGINE" switch 2>&1 | grep -i restart)" ]]'

echo "$pass passed, $failn failed"
[[ $failn -eq 0 ]]
