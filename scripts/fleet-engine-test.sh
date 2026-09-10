#!/bin/bash
#
# Tests for scripts/fleet-engine.sh.
#
#   ./scripts/fleet-engine-test.sh          sandbox only: renders the drop-ins
#                                           for every feature combination into a
#                                           scratch directory and unit-tests the
#                                           failure paths with stubs. Touches no
#                                           service, no /etc/systemd/system and
#                                           not the box's redis features.
#   ./scripts/fleet-engine-test.sh --live   additionally exercises the live
#                                           paths (hold marker, rollback under
#                                           /etc/systemd/system, recovery). This
#                                           changes real state; it restores the
#                                           feature values and restarts whatever
#                                           was running when it finishes.
#
# Needs bash, jq and a FIREWALLA_HOME checkout.

: ${FIREWALLA_HOME:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
export FIREWALLA_HOME
set -u
LIVE_CHECKS=false
[[ ${1:-} == --live ]] && LIVE_CHECKS=true

T=$(mktemp -d)
export SYSTEMD_DIR=$T/systemd
export FLEET_BIN=$T/fleet
export FW_EFFECTIVE_FEATURES=$T/features.json
printf '#!/bin/sh\necho fleet test\n' > "$FLEET_BIN"; chmod 755 "$FLEET_BIN"
mkdir -p "$SYSTEMD_DIR" "$T/bin"
# the sandbox decides the features through FW_EFFECTIVE_FEATURES, so redis must
# not answer: a stub on PATH keeps the box's own values out of the way
printf '#!/bin/sh\nexit 0\n' > "$T/bin/redis-cli"; chmod 755 "$T/bin/redis-cli"
printf '#!/bin/sh\nexec "$@"\n' > "$T/bin/sudo"; chmod 755 "$T/bin/sudo"
ENGINE=$FIREWALLA_HOME/scripts/fleet-engine.sh
SANDBOX=(sudo -E env "PATH=$T/bin:$PATH")
pass=0; failn=0
ok()   { echo "  ok   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# feature values for the sandbox: pcap_zeek_fleet, pcap_zeek_suricata, and the
# roles themselves (default on, as the checked-in config has them)
setf() {
  cat > "$FW_EFFECTIVE_FEATURES" <<JSON
{"pcap_zeek_fleet": $([[ $1 == 1 ]] && echo true || echo false),
 "pcap_zeek_suricata": $([[ $2 == 1 ]] && echo true || echo false),
 "pcap_zeek": $([[ ${3:-1} == 1 ]] && echo true || echo false),
 "pcap_suricata": $([[ ${4:-1} == 1 ]] && echo true || echo false)}
JSON
}

# --live only: the box's own feature values and service state, restored on exit
saved_zf=""; saved_zs=""; brofish_was=""; suricata_was=""
restore() { :; }
relive() { :; }
if $LIVE_CHECKS; then
  saved_zf=$(redis-cli hget sys:features pcap_zeek_fleet 2>/dev/null)
  saved_zs=$(redis-cli hget sys:features pcap_zeek_suricata 2>/dev/null)
  brofish_was=$(systemctl is-active brofish 2>/dev/null)
  suricata_was=$(systemctl is-active suricata 2>/dev/null)
  restore() {
    for k in pcap_zeek_fleet:"$saved_zf" pcap_zeek_suricata:"$saved_zs"; do
      n=${k%%:*}; v=${k#*:}
      if [[ -n $v ]]; then redis-cli hset sys:features "$n" "$v" >/dev/null; else redis-cli hdel sys:features "$n" >/dev/null; fi
    done
  }
  relive() {
    sudo -E env -u SYSTEMD_DIR -u FLEET_BIN -u FW_EFFECTIVE_FEATURES "$ENGINE" apply >/dev/null 2>&1 || true
    [[ $brofish_was == active ]] && [[ $(systemctl is-active brofish) != active ]] && sudo systemctl start brofish >/dev/null 2>&1
    [[ $suricata_was == active ]] && [[ $(systemctl is-active suricata) != active ]] && sudo systemctl start suricata >/dev/null 2>&1
    return 0
  }
fi
cleanup() {
  if $LIVE_CHECKS; then
    sudo chattr -i /etc/systemd/system/brofish.service.d 2>/dev/null
    sudo rm -f /dev/shm/fleet-engine.failed
    restore
    relive
  fi
  if $LIVE_CHECKS; then sudo rm -rf "$T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

B=$SYSTEMD_DIR/brofish.service.d/fleet.conf
S=$SYSTEMD_DIR/suricata.service.d/fleet.conf

echo "== fleet/fleet"
setf 1 1; "${SANDBOX[@]}" "$ENGINE" apply >/dev/null; check "apply returns 0" '[[ $? -eq 0 ]]'
# the templates name the asset path; FLEET_BIN here only stands in for its presence
ASSET=/home/pi/.firewalla/run/assets/fleet
# the brofish drop-in launches through the wrapper, the ids-only unit runs the
# binary directly
RUNNER=/home/pi/firewalla/scripts/fleet-run
check "brofish drop-in always carries --no-suricata (the IDS has its own process)" 'grep -q "^ExecStart=$RUNNER .*--no-suricata" "$B"'
check "suricata drop-in runs the ids-only fleet" 'grep -q "^ExecStart=/home/pi/firewalla/scripts/fleet-ids-run " "$S"'
check "drop-ins are mode 0644" 'find "$B" -prune -perm 0644 | grep -q .'

echo "== fleet/suricata"
setf 1 0; "${SANDBOX[@]}" "$ENGINE" apply >/dev/null || bad "apply"
check "brofish drop-in carries --no-suricata" 'grep -q "^ExecStart=$RUNNER .*--no-suricata" "$B"'
check "no suricata drop-in" '[[ ! -e $S ]]'

echo "== zeek/fleet"
setf 0 1; "${SANDBOX[@]}" "$ENGINE" apply >/dev/null || bad "apply"
check "no brofish drop-in" '[[ ! -e $B ]]'
check "suricata drop-in runs the ids launcher" 'grep -q "^ExecStart=/home/pi/firewalla/scripts/fleet-ids-run " "$S"'

echo "== zeek/suricata"
setf 0 0; "${SANDBOX[@]}" "$ENGINE" apply >/dev/null || bad "apply"
check "no drop-ins at all" '[[ ! -e $B && ! -e $S ]]'

echo "== binary missing with both features on"
setf 1 1; rm -f "$FLEET_BIN"; out=$("${SANDBOX[@]}" "$ENGINE" apply 2>&1); rc=$?
check "apply returns 0 (stock engines)" '[[ $rc -eq 0 ]]'
check "reports the missing binary" '[[ "$out" == *"not present"* ]]'
check "no drop-ins at all" '[[ ! -e $B && ! -e $S ]]'
check "shell roles resolve to zeek/suricata" '[[ $(bash -c "source $FIREWALLA_HOME/platform/platform.sh; echo \$(get_flow_engine_zeek)/\$(get_flow_engine_suricata)") == zeek/suricata ]]'
printf '#!/bin/sh\necho fleet test\n' > "$FLEET_BIN"; chmod 755 "$FLEET_BIN"

echo "== failed install returns nonzero and does not restart"
# SYSTEMD_DIR as a plain file: creating the drop-in directory fails even for root
setf 1 1; rm -rf "$SYSTEMD_DIR"; : > "$SYSTEMD_DIR"
out=$("${SANDBOX[@]}" "$ENGINE" apply 2>&1); rc=$?
check "apply returns nonzero" '[[ $rc -ne 0 ]]'
check "reports the failure" '[[ "$out" == *FAILED* ]]'
check "switch does not restart after a failed apply" '! "${SANDBOX[@]}" "$ENGINE" switch >/dev/null 2>&1'
rm -f "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"

if $LIVE_CHECKS; then
echo "== [live] a failed apply rolls back and leaves the stock engines running"
# both features on, brofish drop-in installable, suricata one not: apply must
# fail before stopping anything
setf 1 1; sudo rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"
: > "$SYSTEMD_DIR/suricata.service.d"          # a file where the directory must go
zeek_before=$(pgrep -c -x "${BRO_PROC_NAME:-zeek}" || true)
out=$("${SANDBOX[@]}" "$ENGINE" apply 2>&1); rc=$?
check "apply returns nonzero" '[[ $rc -ne 0 ]]'
check "nothing was left half-written (the commit rolled back)" '[[ ! -e $B ]]'
check "zeek was not stopped" '[[ $(pgrep -c -x "${BRO_PROC_NAME:-zeek}" || true) == "$zeek_before" ]]'
check "no \"stopping zeek\" in the output" '[[ "$out" != *"stopping zeek"* ]]'
sudo rm -rf "$SYSTEMD_DIR/suricata.service.d"; sudo rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"

echo "== pcap roles switched off"
# pcap_zeek off with both fleet features on: the suricata unit must run fleet
# ids-only, not be held off, or the box would have no IDS at all
setf 1 1; setf 1 1 0 1
"${SANDBOX[@]}" "$ENGINE" apply >/dev/null
check "suricata unit runs the ids launcher when pcap_zeek is off" 'grep -q "^ExecStart=/home/pi/firewalla/scripts/fleet-ids-run " "$S"'
setf 1 1 1 1
"${SANDBOX[@]}" "$ENGINE" apply >/dev/null
check "the ids unit is used whatever the flow role" 'grep -q "^ExecStart=/home/pi/firewalla/scripts/fleet-ids-run " "$S"'

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
  out=$(sudo -E env -u SYSTEMD_DIR -u FLEET_BIN -u FW_EFFECTIVE_FEATURES "$ENGINE" apply 2>&1); rc=$?
  check "live apply fails" '[[ $rc -ne 0 ]]'
  check "hold marker is left behind" '[[ -e /dev/shm/fleet-engine.failed ]]'
  check "restart refuses while held" '! sudo -E env -u SYSTEMD_DIR -u FLEET_BIN -u FW_EFFECTIVE_FEATURES "$ENGINE" restart >/dev/null 2>&1'
  check "brofish was not restarted" '[[ "$(systemctl show brofish -p ExecStart --value)" == "$live_before" ]]'
  sudo chattr -i /etc/systemd/system/brofish.service.d 2>/dev/null
  sudo -E env -u SYSTEMD_DIR -u FLEET_BIN -u FW_EFFECTIVE_FEATURES "$ENGINE" apply >/dev/null 2>&1
  check "a successful live apply clears the marker" '[[ ! -e /dev/shm/fleet-engine.failed ]]'
  check "the live drop-in is back" '[[ -f /etc/systemd/system/brofish.service.d/fleet.conf ]]'
else
  echo "  skip live marker checks (cannot make the drop-in dir immutable here)"
  sudo chattr -i /etc/systemd/system/brofish.service.d 2>/dev/null
fi

fi   # LIVE_CHECKS

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
check "the IDS never rides on the brofish fleet" '! grep -q "suricata-fleet-off" "$ENGINE" && [[ ! -e $FIREWALLA_HOME/etc/suricata-fleet-off.conf ]]'
check "the ids launcher takes suricata's interface list" 'grep -q "listen_interfaces.rc" "$FIREWALLA_HOME/scripts/fleet-ids-run"'
check "main-start guards the later zeekctl cron" 'grep -q "fleet-engine.failed" "$FIREWALLA_HOME/scripts/main-start"'
check "the apply lock needs no shared permissions (mkdir based)" 'grep -q "until mkdir \"\$LOCK\"" "$ENGINE"'
check "a stale lock is removed" 'grep -q "stale apply lock" "$ENGINE"'
check "the watchdog checks both roles" 'grep -q "ROLES+=" "$FIREWALLA_HOME/scripts/fleet-ping.sh"'
check "any apply failure is retried" 'grep -q "this.applyFailed" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'
check "FleetEnginePlugin also watches pcap_zeek / pcap_suricata" 'grep -q "FEATURE_PCAP_ZEEK," "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js" && grep -q "FEATURE_PCAP_SURICATA" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'
check "the suricata watchdog is used whenever fleet owns the IDS" 'grep -q "appliedSuricataEngine() === .fleet." "$FIREWALLA_HOME/net2/SuricataControl.js"'
check "fleet-ping honours the hold" 'grep -q "held back, not checking" "$FIREWALLA_HOME/scripts/fleet-ping.sh"'
check "fleet-ping skips a role the box switched off" 'grep -q "pcap_zeek_enabled" "$FIREWALLA_HOME/scripts/fleet-ping.sh"'

echo "== an explicit false in a config file wins over a later default"
cfgdir=$T/hidden/config; mkdir -p "$cfgdir"
printf '{"userFeatures":{"pcap_zeek_fleet":false}}' > "$cfgdir/config.json"
roles=$(PATH=$T/bin:$PATH FIREWALLA_HIDDEN=$T/hidden FW_EFFECTIVE_FEATURES=/nonexistent bash -c "source \"$FIREWALLA_HOME/platform/platform.sh\"; FLEET_BIN=$FLEET_BIN; echo \$(get_flow_engine_zeek)")
check "user config false is honoured (not swallowed by // empty)" '[[ $roles == zeek ]]'
setf 1 1

echo "== the effective-features file written by node is read first"
printf '{"pcap_zeek_fleet":false,"pcap_zeek_suricata":false}' > "$T/eff.json"
roles=$(PATH=$T/bin:$PATH FW_EFFECTIVE_FEATURES=$T/eff.json bash -c "source \"$FIREWALLA_HOME/platform/platform.sh\"; FLEET_BIN=$FLEET_BIN; echo \$(get_flow_engine_zeek)/\$(get_flow_engine_suricata)")
check "effective-features file overrides the config files" '[[ $roles == zeek/suricata ]]'
setf 1 1

echo "== behaviour: the drop-ins are staged and committed together"
# a wanted suricata template that cannot be installed must leave the brofish
# drop-in as it was, not half-updated
# both drop-ins have to be installed and the suricata one cannot be (a file
# sits where its directory belongs), so the brofish one must be rolled back
setf 1 1 1 1
sudo rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"
sudo touch "$SYSTEMD_DIR/suricata.service.d"
out=$("${SANDBOX[@]}" "$ENGINE" apply 2>&1); rc=$?
check "apply fails" '[[ $rc -ne 0 ]]'
check "the failure is reported" '[[ "$out" == *FAILED* ]]'
check "the brofish drop-in was rolled back, not left half-installed" '[[ ! -e $B ]]'
sudo rm -rf "$SYSTEMD_DIR"; mkdir -p "$SYSTEMD_DIR"
"${SANDBOX[@]}" "$ENGINE" apply >/dev/null
check "the next apply installs both cleanly" '[[ -f $B && -f $S ]]'

echo "== behaviour: apply rewrites a stale drop-in"
setf 1 1; "${SANDBOX[@]}" "$ENGINE" apply >/dev/null
printf '[Service]\nExecStart=/bin/false\n' > "$B"
"${SANDBOX[@]}" "$ENGINE" apply >/dev/null
check "a hand-edited drop-in is corrected" 'grep -q "^ExecStart=$RUNNER " "$B"'
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
  r=$(PATH=$T/bin:$PATH FW_EFFECTIVE_FEATURES=$eff bash -c "source \"$FIREWALLA_HOME/platform/platform.sh\"; FLEET_BIN=$FLEET_BIN; echo \$(get_flow_engine_zeek)")
  [[ $r == fleet || $r == zeek ]] || bad=$((bad+1))
done
wait $writer
check "every read answered a valid engine" '[[ $bad -eq 0 ]]'
check "node publishes the file atomically (temp + rename)" 'grep -q "renameSync" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'

echo "== scratch mode never touches live services"
setf 1 1
out=$("${SANDBOX[@]}" "$ENGINE" apply 2>&1)
check "no service was stopped" '[[ "$out" != *stopping* ]]'
check "switch restarts nothing in scratch mode" '[[ -z "$("${SANDBOX[@]}" "$ENGINE" switch 2>&1 | grep -i restart)" ]]'

echo "== unit: shutdown failures are failures"
# source the functions and stub the world: a zeek that never dies, and a
# suricata whose stop fails, must both make stop_replaced_engines return 1
unit() { # stub-body expected-rc name
  local body=$1 want=$2 name=$3 rc
  rc=$(FLEET_ENGINE_SOURCE_ONLY=1 bash -c "
    FIREWALLA_HOME=$FIREWALLA_HOME
    source \"$ENGINE\" >/dev/null 2>&1
    $body
    ZEEK_ENGINE=fleet; SURICATA_ENGINE=fleet; BRO_PROC_NAME=zeek; FLEET_BIN=$FLEET_BIN
    stop_replaced_engines >/dev/null 2>&1; echo \$?")
  [[ $rc == "$want" ]] && ok "$name" || bad "$name (rc=$rc want=$want)"
}
unit 'pgrep() { return 0; }; sudo() { return 0; }; systemctl() { return 1; }; sleep() { :; }; pcap_zeek_enabled() { return 0; }' 1 "an unkillable zeek fails the shutdown"
unit 'pgrep() { case "$*" in *suricata*) return 0;; esac; return 1; }; sudo() { return 0; }; sleep() { :; }; systemctl() { case "$*" in *ExecStart*) echo "path=$FLEET_BIN";; esac; return 0; }; pcap_zeek_enabled() { return 0; }' 1 "a suricata that survives the kill fails the shutdown"
unit 'pgrep() { return 1; }; sudo() { return 0; }; systemctl() { return 1; }; pcap_zeek_enabled() { return 0; }' 0 "nothing to stop succeeds"

echo "== unit: the hold survives a failed shutdown"
stop_line=$(grep -n "if \$LIVE && ! stop_replaced_engines" "$ENGINE" | head -1 | cut -d: -f1)
lift_line=$(grep -n 'rm -f "\$FAILED_MARKER"' "$ENGINE" | tail -1 | cut -d: -f1)
check "apply lifts the hold only after stop_replaced_engines succeeds" '[[ -n $stop_line && -n $lift_line && $stop_line -lt $lift_line ]]'

echo "== unit: the live hold is mandatory"
check "apply aborts when the failed marker cannot be created" 'grep -q "if \$LIVE && ! sudo touch \"\$FAILED_MARKER\"" "$ENGINE"'
check "apply aborts when the reload marker cannot be created" 'grep -q "if \$LIVE && ! sudo touch \"\$RELOAD_PENDING\"" "$ENGINE"'
check "apply verifies that the failed marker was removed" 'grep -q "\[\[ -e \$FAILED_MARKER \]\]" "$ENGINE"'

echo "== unit: a failed feature publication aborts the apply"
check "publishFeatures throws instead of logging" 'grep -q "throw new Error(\`publishing the effective flow engine features failed" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'

echo "== unit: verify accepts the wrapper for brofish"
check "verify checks for fleet-run under brofish" 'sed -n "/^verify()/,/^}/p" "$ENGINE" | grep -q "FLEET_RUN"'

echo "== unit: zeek preparation and legacy cron"
check "the brofish drop-in launches through fleet-run" 'grep -q "^ExecStart=/home/pi/firewalla/scripts/fleet-run " "$FIREWALLA_HOME/etc/brofish-fleet.conf"'
check "fleet-run runs before_bro and after_bro" 'grep -q "^before_bro" "$FIREWALLA_HOME/scripts/fleet-run" && grep -q "after_bro" "$FIREWALLA_HOME/scripts/fleet-run"'
check "both drop-ins clear RemainAfterExit" 'grep -q "RemainAfterExit=false" "$FIREWALLA_HOME/etc/brofish-fleet.conf" && grep -q "RemainAfterExit=false" "$FIREWALLA_HOME/etc/suricata-fleet-ids.conf"'
check "the hourly zeekctl cron is removed while fleet owns the role" 'grep -q "cron.hourly/bro-cron" "$ENGINE"'
check "flow-check is skipped while the apply is held" 'grep -q "fleet-engine.failed || /home/pi/firewalla/scripts/flow-check.sh" "$FIREWALLA_HOME/etc/crontab.fleet"'
check "a backup that fails aborts before the destination is touched" 'sed -n "/commit_one()/,/^  }/p" "$ENGINE" | grep -q "cp -f \"\$dst\" \"\$backup/\$name\" 2>/dev/null; then"'
check "the feature listeners are registered before the initial apply" 'awk "/onFeature/{o=NR} /await this.apply\\(false\\)/{a=NR} END{exit !(o && a && o<a)}" "$FIREWALLA_HOME/sensor/FleetEnginePlugin.js"'

echo "== behaviour: two applies do not interleave"
setf 1 1
( "${SANDBOX[@]}" "$ENGINE" apply >/dev/null 2>&1 ) &
p1=$!
( "${SANDBOX[@]}" "$ENGINE" apply >/dev/null 2>&1 ) &
p2=$!
wait $p1; r1=$?; wait $p2; r2=$?
check "both concurrent applies ended cleanly" '[[ $r1 -eq 0 && $r2 -eq 0 ]]'
check "the drop-ins are consistent afterwards" 'grep -q "^ExecStart=$RUNNER " "$B" && [[ -f $S ]]'

echo "$pass passed, $failn failed"
[[ $failn -eq 0 ]]
