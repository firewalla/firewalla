#!/bin/bash

# Tests for scripts/scheduled_reboot.sh: the production marker written by
# main-start is /tmp/FWPRODUCTION, so a box with that file must schedule a
# reboot and a box without it must not.
#
# The script's hardcoded paths are rewritten into a temp dir and its external
# commands are replaced by recording stubs.
#
# usage: test/test_scheduled_reboot.sh

PASS=0; FAIL=0
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d) || exit 1
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/bin" "$T/hidden" "$T/scripts"
for c in sync logger; do printf '#!/bin/bash\nexit 0\n' > "$T/bin/$c"; done
printf '#!/bin/bash\necho dhcp_not >/dev/null; echo ""\n' > "$T/bin/redis-cli"
printf '#!/bin/bash\necho "$@" >> %s/shutdown.log\n' "$T" > "$T/bin/sudo"
printf '#!/bin/bash\necho "$@" >> %s/firelog.log\n' "$T" > "$T/scripts/firelog"
chmod +x "$T"/bin/* "$T/scripts/firelog"

sed -e "s#/home/pi/firewalla/scripts#$T/scripts#g" \
    -e "s#/home/pi/.firewalla#$T/hidden#g" \
    -e "s#/tmp/FWPRODUCTION#$T/FWPRODUCTION#g" \
    -e "s#/tmp/PRODUCTION#$T/PRODUCTION#g" \
    "$SRC_DIR/scripts/scheduled_reboot.sh" > "$T/run.sh"

run() {
  rm -f "$T/shutdown.log" "$T/firelog.log"
  (cd "$SRC_DIR" && PATH="$T/bin:$PATH" bash "$T/run.sh") >/dev/null 2>&1
}
check() {
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1 (expected '$2', got '$3')"; fi
}

rm -f "$T/FWPRODUCTION" "$T/PRODUCTION"
run
check "non-production: no shutdown" no "$([[ -e $T/shutdown.log ]] && echo yes || echo no)"

echo release_6_0 > "$T/FWPRODUCTION"
run
check "production (FWPRODUCTION): shutdown scheduled" yes "$([[ -e $T/shutdown.log ]] && echo yes || echo no)"

echo "pass=$PASS fail=$FAIL"
[[ $FAIL -eq 0 ]]
