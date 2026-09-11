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

# Failure-path tests for scripts/switch_branch.sh.
#
# Runs the real script against a scratch repo with a local bare "origin", so
# no box and no network are needed. What is under test is the script's own
# control flow: which failures abort the switch, and whether a rejected switch
# leaves the post-switch tail alone (.no_auto_upgrade, the redis flag,
# /tmp/FWPRODUCTION, the switch log).
#
# The gate's signature and minimal-version logic is NOT retested here -
# test_upgrade_verify.sh covers that. Verification is steered only by whether
# a test keyring file exists: absent means "skip verification" (gate passes),
# present with no signed tag on the tip means the gate rejects. That needs no
# gpg key and no gpgv.
#
# Isolation: HOME, FIREWALLA_HOME and FIREWALLA_HIDDEN are redirected into a
# temp dir, and redis-cli/logger/sync/sudo are replaced by recording stubs on
# PATH. /tmp/FWPRODUCTION is hardcoded in the script, so it is saved and
# restored around the run instead.
#
# usage: test/test_switch_branch.sh        (add -v to dump each case's output)

VERBOSE=${1:-}
PASS=0; FAIL=0
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

T=$(mktemp -d) || exit 1
# /tmp/FWPRODUCTION is written by the script under test and its path cannot be
# overridden; keep the caller's copy and put it back at exit
FWPROD_SAVED=
[[ -e /tmp/FWPRODUCTION ]] && FWPROD_SAVED=$(cat /tmp/FWPRODUCTION)
cleanup() {
  rm -rf "$T"
  if [[ -n "$FWPROD_SAVED" ]]; then echo "$FWPROD_SAVED" > /tmp/FWPRODUCTION
  else rm -f /tmp/FWPRODUCTION; fi
}
trap cleanup EXIT

check() {
  local name=$1 expect=$2 got=$3
  if [[ "$expect" == "$got" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $name"
    echo "      expected: '$expect'"
    echo "      got:      '$got'"
  fi
}

# ---------------------------------------------------------------- fixture ----

ORIGIN=$T/origin.git
FW=$T/fw
HIDDEN=$T/hidden
BIN=$T/bin
CALLS=$T/calls
export HOME=$T/home

mkdir -p "$BIN" "$CALLS" "$HOME" "$HIDDEN/config"

git init -q --bare "$ORIGIN"
git clone -q "$ORIGIN" "$T/seed" 2>/dev/null
(
  cd "$T/seed"
  git config user.email t@t; git config user.name t; git config commit.gpgsign false
  git commit -q --allow-empty -m "master rev"
  git branch -M master && git push -q origin master
  git commit -q --allow-empty -m "beta_22_0 OLD"
  git branch -q beta_22_0 && git push -q origin beta_22_0
  git commit -q --allow-empty -m "release_14_0 rev"
  git branch -q release_14_0 && git push -q origin release_14_0
)

# recording stubs; the script must not reach real redis, syslog or sudo
for tool in redis-cli logger sync sudo; do
  cat > "$BIN/$tool" <<EOS
#!/bin/bash
echo "\$@" >> "$CALLS/$tool"
exit 0
EOS
  chmod +x "$BIN/$tool"
done
# UV_LOGGER is an absolute path by default, so PATH cannot intercept it
cat > "$BIN/uvlog" <<EOS
#!/bin/bash
echo "\$@" >> "$CALLS/uvlog"
EOS
chmod +x "$BIN/uvlog"
export PATH=$BIN:$PATH

# platform.sh stub. The branch mapping is deliberately NOT the identity, so a
# regression that used the local branch name as the remote one would be caught.
mk_fw() {
  rm -rf "$FW"
  git clone -q "$ORIGIN" "$FW" 2>/dev/null
  mkdir -p "$FW/scripts" "$FW/platform"
  cp "$SRC_DIR/scripts/switch_branch.sh" "$FW/scripts/"
  cp "$SRC_DIR/scripts/upgrade_verify.sh" "$FW/scripts/"
  cat > "$FW/platform/platform.sh" <<'EOS'
map_target_branch() {
  case $1 in
    beta_6_0)    echo beta_22_0 ;;
    release_6_0) echo release_14_0 ;;
    *)           echo "$1" ;;
  esac
}
get_node_modules_url() { echo "$T/no_such_node_modules.git"; }
EOS
  (
    cd "$FW"
    git config user.email t@t; git config user.name t; git config commit.gpgsign false
    git config remote.origin.fetch "+refs/heads/master:refs/remotes/origin/master"
    git checkout -q -B master origin/master
  )
  # a pin file whose revision is unreachable, so the node-modules step fails;
  # that failure must not abort the switch
  echo "0000000000000000000000000000000000000000" > "$FW/scripts/NODE_MODULES_REVISION.testplat"
  rm -f "$CALLS"/* 2>/dev/null
  : > "$HIDDEN/config/.no_auto_upgrade"
  rm -f /tmp/FWPRODUCTION
}

echo '{"verify_release_tag":true}' > "$T/enforce_on.json"
echo '{}'                          > "$T/enforce_off.json"

# run the real script; $1 = target branch, rest = extra env assignments
run_switch() {
  local target=$1; shift
  ( cd "$FW"
    env FIREWALLA_HOME="$FW" FIREWALLA_HIDDEN="$HIDDEN" \
        FIREWALLA_PLATFORM=testplat \
        UV_LOGGER="$BIN/uvlog" \
        UV_FLOOR_FILE="$T/floor" UV_FLOOR_ASSET="$T/floor_asset" \
        UV_RELEASE_KEYRING="$T/release.gpg" \
        UV_RELEASE_KEYRING_ASSET="$T/no_asset.gpg" \
        UV_RELEASE_PUBKEY="$T/no_pubkey.gpg" \
        "$@" \
        bash "$FW/scripts/switch_branch.sh" "$target"
  ) > "$T/out" 2>&1
  echo $?
}

branch_now()  { git -C "$FW" rev-parse --abbrev-ref HEAD; }
refspec_now() { git -C "$FW" config --get remote.origin.fetch; }
head_msg()    { git -C "$FW" log -1 --format=%s; }
called()      { [[ -s "$CALLS/$1" ]] && echo yes || echo no; }
dump()        { [[ -n "$VERBOSE" ]] && { echo "--- output:"; sed 's/^/    /' "$T/out"; }; }

# ------------------------------------------------------------------ cases ----

# 1. target == current branch: exits 0 early, tail must not run
mk_fw
RC=$(run_switch master UV_TEST_KEYRING="$T/none")
check "same branch: exit 0"                    0    "$RC"
check "same branch: no redis write"            no   "$(called redis-cli)"
check "same branch: no switch log"             no   "$(called logger)"
dump

# 2. gate rejects a release_* target with enforcement on
mk_fw
: > "$T/testkeyring.gpg"; echo dummy > "$T/testkeyring.gpg"
RC=$(run_switch release_6_0 UV_TEST_KEYRING="$T/testkeyring.gpg" \
                UV_OTA_CONFIG_URL="file://$T/enforce_on.json")
check "reject: exit 1"                         1    "$RC"
check "reject: branch unchanged"               master "$(branch_now)"
check "reject: refspec unchanged"              "+refs/heads/master:refs/remotes/origin/master" "$(refspec_now)"
check "reject: no redis write"                 no   "$(called redis-cli)"
check "reject: no switch log"                  no   "$(called logger)"
check "reject: FWPRODUCTION not written"       absent "$([[ -e /tmp/FWPRODUCTION ]] && cat /tmp/FWPRODUCTION || echo absent)"
check "reject: .no_auto_upgrade kept"          yes  "$([[ -e $HIDDEN/config/.no_auto_upgrade ]] && echo yes || echo no)"
grep -q "failed release verification" "$T/out"
check "reject: logs the reason"                0    "$?"
dump

# 3. same rejection with enforcement off: dry-run must let it through
mk_fw
RC=$(run_switch beta_6_0 UV_TEST_KEYRING="$T/testkeyring.gpg" \
                UV_OTA_CONFIG_URL="file://$T/enforce_off.json")
check "dry-run: exit 0"                        0    "$RC"
check "dry-run: branch switched"               beta_6_0 "$(branch_now)"
grep -q "DRY-RUN would reject" "$T/out"
check "dry-run: logged as dry-run"             0    "$?"
dump

# 4. fetch fails while a stale origin ref from an earlier switch is present
mk_fw
git -C "$FW" fetch -q origin "+refs/heads/beta_22_0:refs/remotes/origin/beta_22_0"
STALE=$(git -C "$FW" rev-parse --short origin/beta_22_0)
git -C "$FW" remote set-url origin "$T/gone.git"
RC=$(run_switch beta_6_0 UV_TEST_KEYRING="$T/none")
check "fetch fail: exit 1"                     1    "$RC"
check "fetch fail: branch unchanged"           master "$(branch_now)"
check "fetch fail: not on the stale revision"  "master rev" "$(head_msg)"
check "fetch fail: refspec unchanged"          "+refs/heads/master:refs/remotes/origin/master" "$(refspec_now)"
check "fetch fail: no redis write"             no   "$(called redis-cli)"
check "fetch fail: no switch log"              no   "$(called logger)"
check "fetch fail: stale ref still exists"     "$STALE" "$(git -C "$FW" rev-parse --short origin/beta_22_0)"
dump

# 5. checkout fails after the gate passed (a ref D/F conflict blocks -B)
mk_fw
git -C "$FW" branch beta_6_0/sub master
RC=$(run_switch beta_6_0 UV_TEST_KEYRING="$T/none")
check "checkout fail: exit 1"                  1    "$RC"
check "checkout fail: branch unchanged"        master "$(branch_now)"
check "checkout fail: refspec unchanged"       "+refs/heads/master:refs/remotes/origin/master" "$(refspec_now)"
check "checkout fail: no redis write"          no   "$(called redis-cli)"
check "checkout fail: no switch log"           no   "$(called logger)"
dump

# 6. successful switch: tail runs, refspec follows the mapped remote branch
mk_fw
RC=$(run_switch beta_6_0 UV_TEST_KEYRING="$T/none")
check "success: exit 0"                        0    "$RC"
check "success: branch switched"               beta_6_0 "$(branch_now)"
check "success: on the fetched revision"       "beta_22_0 OLD" "$(head_msg)"
check "success: refspec is the mapped branch"  "+refs/heads/beta_22_0:refs/remotes/origin/beta_22_0" "$(refspec_now)"
check "success: redis flag set"                yes  "$(called redis-cli)"
check "success: switch logged"                 yes  "$(called logger)"
grep -q "Firewalla:switch_branch: from master to beta_6_0" "$CALLS/logger"
check "success: switch log text"               0    "$?"
check "success: .no_auto_upgrade removed"      no   "$([[ -e $HIDDEN/config/.no_auto_upgrade ]] && echo yes || echo no)"
grep -q "branch.changed 2" "$CALLS/redis-cli"
check "success: beta_6_0 maps to flag 2"       0    "$?"
dump

# 7. a node-modules failure on the success path must not abort the switch
grep -q "node modules pin sync failed" "$T/out"
check "success: node modules failed"           0    "$?"
check "success: switch still completed"        beta_6_0 "$(branch_now)"

# 8. successful switch to a release_* branch writes /tmp/FWPRODUCTION
mk_fw
RC=$(run_switch release_6_0 UV_TEST_KEYRING="$T/none")
check "release: exit 0"                        0    "$RC"
check "release: branch switched"               release_6_0 "$(branch_now)"
check "release: FWPRODUCTION written"          release_6_0 "$(cat /tmp/FWPRODUCTION 2>/dev/null)"
grep -q "branch.changed 1" "$CALLS/redis-cli"
check "release: maps to flag 1"                0    "$?"
dump

echo
echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
