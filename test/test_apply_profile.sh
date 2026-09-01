#!/bin/bash

#
#    Copyright 2026 Firewalla Inc.
#
#    This program is free software: you can redistribute it and/or  modify
#    it under the terms of the GNU Affero General Public License, version 3,
#    as published by the Free Software Foundation.
#
#    This program is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU Affero General Public License for more details.
#
#    You should have received a copy of the GNU Affero General Public License
#    along with this program.  If not, see <http://www.gnu.org/licenses/>.
#

# Tests the input handling of scripts/apply_profile.sh. The script's main body needs root and
# reconfigures the running box, so it is never executed here. Instead each function under test is
# extracted from the real file with sed and evaluated, so the test tracks the shipped source rather
# than a copy. Self-contained, no network, no root, no redis.
# Run directly: test/test_apply_profile.sh
# Exit code = number of failed checks.

FW_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET=$FW_HOME/scripts/apply_profile.sh

T=$(mktemp -d /tmp/ap-test-XXXXXX)
trap 'rm -rf $T' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2' got '$3')"; fi
}
absent() { # absent <desc> <path>
  if [[ -e "$2" ]]; then bad "$1 (created $2)"; else ok "$1"; fi
}

# pull one function definition out of the real script
extract() { sed -n "/^$1() {/,/^}/p" "$TARGET"; }

for fn in get_active_profile set_smp_affinity set_cpufreqs; do
  [[ -n "$(extract $fn)" ]] || { echo "FATAL: cannot extract $fn() from $TARGET"; exit 1; }
done

# ----------------------------------------------------------------------------
# get_active_profile: the name comes from redis, where any local process can put it,
# and becomes a path. only a plain file name may be used.
# ----------------------------------------------------------------------------

mkdir -p $T/user $T/default
: > $T/default/profile_default
: > $T/user/profile_temp

# stub redis-cli so the test needs no redis
mkdir -p $T/bin
cat > $T/bin/redis-cli <<'EOF'
#!/bin/bash
[[ "$1" == "get" ]] && printf '%s' "$FAKE_ACTIVE_PROFILE"
EOF
chmod +x $T/bin/redis-cli

gap() { # gap <redis value> -> the path the script would read
  PATH=$T/bin:$PATH \
  FAKE_ACTIVE_PROFILE="$1" \
  PROFILE_USER_DIR=$T/user PROFILE_DEFAULT_DIR=$T/default PROFILE_DEFAULT_NAME=profile_default \
  bash -c "logerror() { echo \"ERROR:\$@\" >&2; }; $(extract get_active_profile); get_active_profile" 2>/dev/null
}

check "empty redis value falls back to the default profile" "$T/default/profile_default" "$(gap '')"
check "a user profile that exists resolves under the user dir" "$T/user/profile_temp" "$(gap 'profile_temp')"
check "a name only in the default dir resolves there" "$T/default/profile_default" "$(gap 'profile_default')"

# traversal, separators and shell metacharacters must all fall back to the default
for n in '../../../../etc/passwd' '/etc/passwd' 'sub/dir' '..' '.' '.hidden' '-rf' 'x;id' 'a b' '$(id)' '`id`' '*'; do
  check "rejects $(printf '%q' "$n")" "$T/default/profile_default" "$(gap "$n")"
done

# ----------------------------------------------------------------------------
# set_smp_affinity: the interface name comes from the profile and used to be spliced into
# awk program text. awk has system(), so that was command execution.
#
# The payload has to satisfy two constraints, and both were found the hard way:
#   - no spaces. rows arrive through `read intf smp_affinity`, so a space ends the first field
#     and truncates anything after it before awk ever sees it.
#   - the injected code must be a top-level awk rule separated by ';'. Splicing a BEGIN block
#     into the middle of an expression is a syntax error, so awk exits and nothing runs.
# BEGIN then fires with no input at all, so the test does not depend on /proc/interrupts.
# Verified to execute against the pre-fix form.
# ----------------------------------------------------------------------------

MARK=$T/awk_injected
PAYLOAD='x";BEGIN{system("id>'"$MARK"'")};$1=="y'
printf '%s\t20\n' "$PAYLOAD" | PROFILE_CHECK=true bash -c "
  logerror() { :; }; loginfo() { :; }
  $(extract set_smp_affinity)
  set_smp_affinity" >/dev/null 2>&1
absent "awk program text is not built from the interface name" "$MARK"

# a benign row must still be accepted, i.e. the fix did not just break the function
printf 'eth0\t20\n' | PROFILE_CHECK=true bash -c "
  logerror() { echo \"ERROR:\$@\" >&2; }; loginfo() { :; }
  $(extract set_smp_affinity)
  set_smp_affinity" >/dev/null 2>&1
check "a benign interface row is processed without error" "0" "$?"

# ----------------------------------------------------------------------------
# set_cpufreqs: cpuid is a path component of /sys/.../policy<cpuid>/, so it has to be numeric
# ----------------------------------------------------------------------------

# rows reach this function through `read cpuid min max governor`, so only values that survive a
# default-IFS field split are worth testing: an empty or space-containing first field is collapsed
# by read itself and never reaches the guard.
scf() { # scf <cpuid> -> stderr of the run
  printf '%s\t1000000\t2000000\tperformance\n' "$1" | PROFILE_CHECK=true bash -c "
    logerror() { echo \"ERROR:\$@\" >&2; }; loginfo() { :; }
    $(extract set_cpufreqs)
    set_cpufreqs" 2>&1 >/dev/null
}

for c in '0/../../../../tmp/x' '../../../../tmp/x' '.' '..' '-1' '1;id' '$(id)' 'a' '0x0' '1.0'; do
  out=$(scf "$c")
  if [[ "$out" == *"invalid cpuid"* ]]; then
    ok "rejects cpuid $(printf '%q' "$c")"
  else
    bad "rejects cpuid $(printf '%q' "$c") (no invalid-cpuid error, got: $out)"
  fi
done

out=$(scf '0')
if [[ "$out" == *"invalid cpuid"* ]]; then
  bad "accepts a numeric cpuid"
else
  ok "accepts a numeric cpuid"
fi

echo "RESULT: $PASS passed, $FAIL failed"
exit $FAIL
