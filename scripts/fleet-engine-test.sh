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
check "brofish drop-in runs fleet without --no-suricata" 'grep -q "^ExecStart=$FLEET_BIN .* --http 127.0.0.1:8927  \$FLEET_OPTS" "$B"'
check "suricata drop-in holds the unit off" 'grep -q "^ConditionPathExists=" "$S"'
check "drop-ins are root-owned 0644" '[[ $(stat -c "%a %U" "$B") == "644 root" ]]'

echo "== fleet/suricata"
setf 1 0; sudo -E "$ENGINE" apply >/dev/null || bad "apply"
check "brofish drop-in carries --no-suricata" 'grep -q "^ExecStart=$FLEET_BIN .*--no-suricata" "$B"'
check "no suricata drop-in" '[[ ! -e $S ]]'

echo "== zeek/fleet"
setf 0 1; sudo -E "$ENGINE" apply >/dev/null || bad "apply"
check "no brofish drop-in" '[[ ! -e $B ]]'
check "suricata drop-in runs fleet --ids-only" 'grep -q "^ExecStart=$FLEET_BIN .*--ids-only" "$S"'

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

echo "$pass passed, $failn failed"
[[ $failn -eq 0 ]]
