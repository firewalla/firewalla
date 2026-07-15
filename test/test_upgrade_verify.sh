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

# Functional tests for scripts/upgrade_verify.sh. Self-contained: builds
# throwaway git repos and gpg keyrings under /tmp, needs no network and no
# existing keys. Run directly: test/test_upgrade_verify.sh
# Exit code = number of failed checks.

FW_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

T=$(mktemp -d /tmp/uv-test-XXXXXX)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { # check <desc> <expected-rc> <actual-rc>
  if [[ $2 -eq $3 ]]; then ok "$1"; else bad "$1 (expected rc=$2 got rc=$3)"; fi
}

source $FW_HOME/scripts/upgrade_verify.sh

# --- unit: version compare ---
uv_version_ge 1.983.001 1.983;     check "1.983.001 >= 1.983" 0 $?
uv_version_ge 1.983 1.983.001;     check "1.983 < 1.983.001" 1 $?
uv_version_ge 1.983 1.983;         check "1.983 >= 1.983" 0 $?
uv_version_ge 1.984 1.983.999;     check "1.984 >= 1.983.999" 0 $?
uv_version_ge 1.983.010 1.983.009; check "leading zeros 010 >= 009" 0 $?
uv_version_ge 2.0 1.999.999;       check "2.0 >= 1.999.999" 0 $?

# --- unit: official remote match ---
uv_is_official_remote "https://github.com/firewalla/firewalla.git"; check "official https .git" 0 $?
uv_is_official_remote "https://github.com/firewalla/firewalla";     check "official https no .git" 0 $?
uv_is_official_remote "git@github.com:firewalla/firewalla.git";     check "official ssh" 0 $?
uv_is_official_remote "https://github.com/attacker/firewalla.git";  check "other owner rejected" 1 $?
uv_is_official_remote "https://github.com.evil.com/firewalla/firewalla.git"; check "domain suffix trick rejected" 1 $?
uv_is_official_remote "https://github.com/firewalla/firewalla-test.git"; check "repo suffix rejected" 1 $?

# --- unit: UV_OFFICIAL_REPO override (firerouter) ---
UV_OFFICIAL_REPO=firerouter
uv_is_official_remote "https://github.com/firewalla/firerouter.git"; check "firerouter remote accepted with override" 0 $?
uv_is_official_remote "git@github.com:firewalla/firerouter.git";     check "firerouter ssh remote accepted with override" 0 $?
uv_is_official_remote "https://github.com/firewalla/firewalla.git";  check "firewalla remote rejected with override" 1 $?
UV_OFFICIAL_REPO=firewalla

# --- e2e setup: origin repo, clone, test key ---
export GNUPGHOME_SIGN=$T/sign-gnupg
mkdir -p -m700 $GNUPGHOME_SIGN
GNUPGHOME=$GNUPGHOME_SIGN gpg --batch --passphrase '' --quick-generate-key "Test Release <test@fw.test>" ed25519 sign never 2>/dev/null
FPR=$(GNUPGHOME=$GNUPGHOME_SIGN gpg --list-keys --with-colons 2>/dev/null | awk -F: '/^fpr:/{print $10; exit}')
[[ -n "$FPR" ]] && ok "test key generated ($FPR)" || bad "keygen"

git init -q -b rel $T/origin
GITC="git -C $T/origin -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false"
echo one > $T/origin/f; $GITC add f; $GITC commit -qm c1
GNUPGHOME=$GNUPGHOME_SIGN $GITC -c user.signingkey=$FPR tag -s goldse-alph-v1.983.001 -m rel1
echo two > $T/origin/f; $GITC commit -qam c2-unsigned-tip

git clone -q $T/origin $T/box 2>/dev/null
cd $T/box
git config user.email t@t; git config user.name t; git config commit.gpgsign false

# box-side keyring: import public key only (test keyring, remote is non-official file://)
UV_TEST_GNUPGHOME=$T/box-test-gnupg
mkdir -p -m700 $UV_TEST_GNUPGHOME
GNUPGHOME=$GNUPGHOME_SIGN gpg --armor --export $FPR 2>/dev/null | GNUPGHOME=$UV_TEST_GNUPGHOME gpg --batch --quiet --import 2>/dev/null
UV_FLOOR_FILE=$T/floor
UV_LOGGER=true

# --- e2e: signed commit accepted (fetch tip = unsigned c2 first: rejected) ---
git fetch -q origin rel
uv_verify_release_commit FETCH_HEAD >/dev/null; check "unsigned branch tip rejected" 1 $?

# point branch at the signed commit
git -C $T/origin reset -q --hard 'goldse-alph-v1.983.001^{commit}'
git fetch -q origin rel
uv_verify_release_commit FETCH_HEAD >/dev/null; check "signed commit accepted (tag fetched by name from remote)" 0 $?

# --- e2e: minimal version logic ---
echo 1.983.001 > $UV_FLOOR_FILE
uv_verify_release_commit FETCH_HEAD >/dev/null; check "at minimal version accepted" 0 $?
echo 1.983.002 > $UV_FLOOR_FILE
uv_verify_release_commit FETCH_HEAD >/dev/null; check "below minimal version rejected" 1 $?
rm -f $UV_FLOOR_FILE

# --- e2e: tamper: tag signed by another key ---
GNUPGHOME_EVIL=$T/evil-gnupg; mkdir -p -m700 $GNUPGHOME_EVIL
GNUPGHOME=$GNUPGHOME_EVIL gpg --batch --passphrase '' --quick-generate-key "Evil <evil@x.test>" ed25519 sign never 2>/dev/null
EFPR=$(GNUPGHOME=$GNUPGHOME_EVIL gpg --list-keys --with-colons 2>/dev/null | awk -F: '/^fpr:/{print $10; exit}')
echo three > $T/origin/f; $GITC commit -qam c3
GNUPGHOME=$GNUPGHOME_EVIL $GITC -c user.signingkey=$EFPR tag -s goldse-alph-v1.983.003 -m fake
git fetch -q origin rel
uv_verify_release_commit FETCH_HEAD >/dev/null; check "commit with wrong-key signature rejected" 1 $?

# --- e2e: no test key on non-official remote -> skip (accept) ---
UV_TEST_GNUPGHOME=$T/nonexistent
uv_verify_release_commit FETCH_HEAD >/dev/null; check "non-official remote without test key skips" 0 $?
UV_TEST_GNUPGHOME=$T/box-test-gnupg

# --- e2e: gate rejects unverified ---
uv_verify_release_commit FETCH_HEAD >/dev/null; check "gate rejects unverified commit" 1 $?

# --- e2e: monotonic minimal version update from the assets file ---
UV_FLOOR_FILE=$T/floor2
UV_FLOOR_ASSET=$T/floor-asset
uv_update_version_floor >/dev/null
[[ ! -e $UV_FLOOR_FILE ]]; check "missing asset ignored, no minimal version cached" 0 $?
echo "1.983.001" > $UV_FLOOR_ASSET
uv_update_version_floor >/dev/null
[[ $(cat $UV_FLOOR_FILE 2>/dev/null) == 1.983.001 ]]; check "minimal version read from asset and cached" 0 $?
echo "1.982.000" > $UV_FLOOR_ASSET
uv_update_version_floor >/dev/null
[[ $(cat $UV_FLOOR_FILE 2>/dev/null) == 1.983.001 ]]; check "lower asset value ignored (monotonic)" 0 $?
echo "1.984.000" > $UV_FLOOR_ASSET
uv_update_version_floor >/dev/null
[[ $(cat $UV_FLOOR_FILE 2>/dev/null) == 1.984.000 ]]; check "higher asset value adopted" 0 $?
echo "garbage!!" > $UV_FLOOR_ASSET
uv_update_version_floor >/dev/null
[[ $(cat $UV_FLOOR_FILE 2>/dev/null) == 1.984.000 ]]; check "malformed asset ignored" 0 $?

# --- e2e: release key import gated on official remote ---
UV_RELEASE_GNUPGHOME=$T/release-gnupg
UV_RELEASE_PUBKEY=$T/release_pub.key
GNUPGHOME=$GNUPGHOME_SIGN gpg --armor --export $FPR 2>/dev/null > $UV_RELEASE_PUBKEY
uv_ensure_release_key >/dev/null 2>&1
[[ ! -d $UV_RELEASE_GNUPGHOME ]]; check "non-official remote: release keyring not created" 0 $?
SAVED_URL=$(git remote get-url origin)
git remote set-url origin https://github.com/firewalla/firewalla.git
uv_ensure_release_key >/dev/null 2>&1
[[ -s $UV_RELEASE_GNUPGHOME/pubring.kbx || -s $UV_RELEASE_GNUPGHOME/pubring.gpg ]]; check "official remote: release key imported" 0 $?
git remote set-url origin "$SAVED_URL"

# --- e2e: strict node modules pin sync ---
git init -q -b rel $T/nm-origin
NMGIT="git -C $T/nm-origin -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false"
echo m1 > $T/nm-origin/m; $NMGIT add m; $NMGIT commit -qm nm1
PIN=$($NMGIT rev-parse HEAD)
echo m2 > $T/nm-origin/m; $NMGIT commit -qam nm2-tip
NM=$T/nm-box
PINF=$T/nm-pin
echo $PIN > $PINF

uv_sync_node_modules $NM $T/nm-origin rel $PINF >/dev/null
[[ $(git -C $NM rev-parse HEAD 2>/dev/null) == $PIN ]]; check "fresh clone lands on pin, not tip" 0 $?

echo m3 > $T/nm-origin/m; $NMGIT commit -qam nm3-hostile-tip
OUT=$(uv_sync_node_modules $NM $T/nm-origin rel $PINF); RC=$?
[[ $(git -C $NM rev-parse HEAD) == $PIN ]]; check "moved origin tip ignored, stays on pin" 0 $?
[[ $RC -eq 0 && -z "$OUT" ]]; check "no-op sync is quiet and returns 0" 0 $?

echo m-dirty >> $NM/m
uv_sync_node_modules $NM $T/nm-origin rel $PINF >/dev/null
[[ -z $(git -C $NM status -uno --porcelain) ]]; check "dirty tree restored to pin" 0 $?

NEWPIN=$($NMGIT rev-parse HEAD)
echo $NEWPIN > $PINF
uv_sync_node_modules $NM $T/nm-origin rel $PINF >/dev/null
[[ $(git -C $NM rev-parse HEAD) == $NEWPIN ]]; check "raised pin adopted via fetch" 0 $?

echo "ffffffffffffffffffffffffffffffffffffffff" > $PINF
uv_sync_node_modules $NM $T/nm-origin rel $PINF >/dev/null
check "unreachable pin rejected" 1 $?
[[ $(git -C $NM rev-parse HEAD) == $NEWPIN ]]; check "repo unchanged after unreachable pin" 0 $?

echo "not-a-hash" > $PINF
uv_sync_node_modules $NM $T/nm-origin rel $PINF >/dev/null
check "malformed pin rejected" 1 $?

uv_sync_node_modules $NM $T/nm-origin rel $T/nonexistent-pin >/dev/null
check "missing pin file rejected" 1 $?

echo "ffffffffffffffffffffffffffffffffffffffff" > $PINF
rm -rf $NM
uv_sync_node_modules $NM $T/nm-origin rel $PINF >/dev/null
check "fresh clone with unreachable pin rejected" 1 $?
[[ ! -d $NM ]]; check "unpinned fresh clone removed" 0 $?

echo
echo "RESULT: $PASS passed, $FAIL failed"
cd /
rm -rf $T
exit $FAIL
