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

# Release verification for upgrade/switch paths. Sourced by fireupgrade.sh
# and switch_branch.sh, and by the firerouter counterparts. Before a fetched
# commit is applied (reset/checkout), it must carry a tag signed by a trusted
# key, and its version must be at or above the floor. See git-protection.md
# at repo root for the design.
#
# All UV_ variables can be preset before sourcing; the defaults below apply
# to the firewalla repo. firerouter presets UV_OFFICIAL_REPO and
# UV_RELEASE_PUBKEY; the release key, keyring, version floor and its
# fw_min_version asset are shared by both repos.

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# dedicated gpg keyrings (not ~/.gnupg), holding only the trusted key(s),
# stored outside the git tree so fetch/reset cannot modify them
: ${UV_RELEASE_GNUPGHOME:=/home/pi/.upgrade-gnupg}
: ${UV_TEST_GNUPGHOME:=/home/pi/.upgrade-gnupg-test}
: ${UV_OFFICIAL_REPO:=firewalla}
: ${UV_RELEASE_PUBKEY:=$FIREWALLA_HOME/etc/keys/release_pub.key}
: ${UV_FLOOR_FILE:=/home/pi/.firewalla/config/upgrade_version_floor}
: ${UV_FLOOR_ASSET:=/home/pi/.firewalla/run/assets/fw_min_version}
: ${UV_LOGGER:="/usr/bin/logger -t FWUPGRADE.VERIFY"}

uv_log() {
  echo "upgrade_verify: $@"
  $UV_LOGGER "$@"
}

# git/gpg operate on pi-owned files; drop to pi when running as root.
# env passes VAR=value prefixes through sudo (sudo alone drops them).
uv_as_pi() {
  if [[ $(id -u) -eq 0 ]]; then
    sudo -u pi env "$@"
  else
    env "$@"
  fi
}

uv_is_official_remote() {
  local url=$1
  local re="^(https://|git@|ssh://git@)github\.com[:/]firewalla/${UV_OFFICIAL_REPO}(\.git)?/?$"
  [[ "$url" =~ $re ]]
}

# a >= b, versions as dot-separated numbers, e.g. 1.983.001
uv_version_ge() {
  local IFS=.
  local -a a=($1) b=($2)
  local i x y
  for i in 0 1 2 3; do
    x=${a[i]:-0}; y=${b[i]:-0}
    # 10#: force base-10, "010" would otherwise be octal
    (( 10#$x > 10#$y )) && return 0
    (( 10#$x < 10#$y )) && return 1
  done
  return 0
}

# import the release public key from the currently installed (trusted) tree
# into the keyring outside the repo; re-import when the file changes so a
# signed release can rotate the key
uv_ensure_release_key() {
  [[ -s $UV_RELEASE_PUBKEY ]] || return 0
  local sum marker
  sum=$(sha256sum $UV_RELEASE_PUBKEY | cut -d' ' -f1)
  marker=$UV_RELEASE_GNUPGHOME/.imported_sha256
  [[ -e $marker ]] && [[ $(cat $marker) == "$sum" ]] && return 0
  # gpg requires mode 700 on its home dir
  uv_as_pi mkdir -p -m 700 $UV_RELEASE_GNUPGHOME
  if uv_as_pi GNUPGHOME=$UV_RELEASE_GNUPGHOME gpg --batch --quiet --import $UV_RELEASE_PUBKEY 2>/dev/null; then
    echo "$sum" | uv_as_pi tee $marker >/dev/null
    uv_log "imported release key from $UV_RELEASE_PUBKEY"
  else
    uv_log "failed to import release key from $UV_RELEASE_PUBKEY"
    return 1
  fi
}

uv_get_version_floor() {
  [[ -s $UV_FLOOR_FILE ]] && cat $UV_FLOOR_FILE
}

# refresh the floor from the assets pipeline (update_assets.sh downloads and
# signature-verifies /all/fw_min_version); monotonic - only ever raised, a
# lower or missing asset value never lowers the cached one
uv_update_version_floor() {
  [[ -s $UV_FLOOR_ASSET ]] || return 0
  local asset cached
  asset=$(tr -d '[:space:]' < $UV_FLOOR_ASSET)
  [[ "$asset" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 0
  cached=$(uv_get_version_floor)
  if [[ -z "$cached" ]] || ! uv_version_ge "$cached" "$asset"; then
    echo "$asset" > $UV_FLOOR_FILE
    uv_log "version floor raised to $asset"
  fi
}

# pin file for the node modules repo of this platform (node4 variant on
# legacy node v4 devices); the file lives in the firewalla tree, so its
# content is covered by the release signature
uv_node_modules_pin_file() {
  [[ -n "$FIREWALLA_PLATFORM" ]] || return 1
  local f=$FIREWALLA_HOME/scripts/NODE_MODULES_REVISION.$FIREWALLA_PLATFORM
  [[ "$($FIREWALLA_HOME/bin/node -v 2>/dev/null)" =~ ^v4\. ]] && f=$f.node4
  echo $f
}

# strict pinned sync of the node modules repo: the work tree only ever lands
# on the revision from the pin file, never on a branch tip. On any failure
# the repo is left unchanged (a fresh unpinned clone is removed) and 1 is
# returned. UV_GIT can point to mgit for crash-safe fetch/reset.
# usage: uv_sync_node_modules <dir> <url> <branch> <pin_file>
uv_sync_node_modules() {
  local dir=$1 url=$2 branch=$3 pin_file=$4
  local git_cmd=${UV_GIT:-git}
  local pin fresh=0 rc
  if [[ ! -s $pin_file ]]; then
    uv_log "node modules pin file missing: $pin_file"
    return 1
  fi
  pin=$(tr -d '[:space:]' < $pin_file)
  if [[ ! "$pin" =~ ^[0-9a-f]{40}$ ]]; then
    uv_log "invalid node modules pin in $pin_file"
    return 1
  fi
  if [[ ! -d $dir/.git ]]; then
    rm -rf $dir
    git clone --recursive -b $branch --single-branch $url $dir ||
      git clone --recursive -b $branch --single-branch $url $dir || return 1
    fresh=1
  fi
  (
    cd $dir || exit 1
    rm -f .git/*.lock
    # already exactly on the pin with a clean tree
    if [[ $(git rev-parse HEAD 2>/dev/null) == "$pin" && -z $(git status -uno --porcelain 2>/dev/null) ]]; then
      exit 0
    fi
    if ! git cat-file -e "$pin^{commit}" 2>/dev/null; then
      $git_cmd fetch origin $branch || $git_cmd fetch origin $branch
    fi
    if ! git cat-file -e "$pin^{commit}" 2>/dev/null; then
      uv_log "pinned node modules revision $pin not reachable from $url"
      exit 1
    fi
    # move the local branch exactly onto the pin, discarding local changes
    git checkout -q -f -B $branch "$pin" || exit 1
    if [[ -n "$FWPRODUCTION" ]]; then
      git clean -xdf
    fi
    exit 0
  )
  rc=$?
  if [[ $rc -ne 0 && $fresh -eq 1 ]]; then
    # never leave an unpinned fresh clone behind
    rm -rf $dir
  fi
  if [[ $rc -eq 0 ]]; then
    uv_log "node modules pinned at $pin"
  else
    uv_log "node modules pin sync failed, repo unchanged"
  fi
  return $rc
}

# core check: does <commit-ish> carry a tag signed by a trusted key, with
# version >= floor. Return 0 = verified (or exempt), 1 = failed.
uv_verify_release_commit() {
  local commit keyring floor tag tags t ver sigout fprs
  # ^{commit} peels any ref (branch, annotated tag) to its commit hash
  commit=$(git rev-parse "${1:-FETCH_HEAD}^{commit}" 2>/dev/null) || {
    uv_log "cannot resolve commit $1"
      return 1
  }

  local url=$(git remote get-url origin 2>/dev/null)
  if uv_is_official_remote "$url"; then
    keyring=$UV_RELEASE_GNUPGHOME
    # pubring.kbx: gpg >= 2.1 keyring format, pubring.gpg: legacy format.
    # Official remote with no keyring fails closed (reject, never skip).
    if [[ ! -s $keyring/pubring.kbx && ! -s $keyring/pubring.gpg ]]; then
      uv_log "official remote but release keyring missing at $keyring"
      return 1
    fi
  else
    if [[ -s $UV_TEST_GNUPGHOME/pubring.kbx || -s $UV_TEST_GNUPGHOME/pubring.gpg ]]; then
      keyring=$UV_TEST_GNUPGHOME
    else
      uv_log "non-official remote ($url) and no test key, skip verification"
      return 0
    fi
  fi

  # trusted fingerprints from the keyring; --with-colons is gpg's
  # machine-readable output, "fpr" records carry the fingerprint in field 10
  fprs=$(uv_as_pi GNUPGHOME=$keyring gpg --batch --quiet --list-keys --with-colons 2>/dev/null |
    awk -F: '/^fpr:/ {print $10}')
  if [[ -z "$fprs" ]]; then
    uv_log "no trusted key in $keyring"
    return 1
  fi

  # local tags on this exact commit
  tags=$(git tag --points-at "$commit" 2>/dev/null)
  # plus remote tags on it: ls-remote lists annotated tags twice, the
  # "<name>^{}" (peeled) line carries the tagged COMMIT hash - matching it
  # finds the right tags and skips lightweight (unsignable) ones. Fetch each
  # by exact refspec, not the whole (attacker-controlled) tag namespace;
  # no "+" prefix, so an existing local tag is never overwritten.
  for t in $(git ls-remote --tags origin 2>/dev/null |
    awk -v c="$commit" '$1==c {print $2}' | sed -n 's#^refs/tags/\(.*\)\^{}$#\1#p');
  do
    echo "$tags" | grep -qx "$t" && continue
    git rev-parse -q --verify "refs/tags/$t" >/dev/null ||
      git fetch --no-tags origin "refs/tags/$t:refs/tags/$t" &>/dev/null || continue
    tags="$tags"$'\n'"$t"
  done

  floor=$(uv_get_version_floor)
  for tag in $tags; do
    # a pre-existing local tag with this name may point elsewhere
    [[ $(git rev-parse -q --verify "$tag^{commit}" 2>/dev/null) == "$commit" ]] || continue
    # --raw prints gpg status lines; a valid signature yields
    # "[GNUPG:] VALIDSIG <40-hex-fpr> ...". Matching the fingerprint pins
    # the signer (exit status alone = "some key in the keyring"); the
    # trailing space stops prefix matches.
    sigout=$(uv_as_pi GNUPGHOME=$keyring git verify-tag --raw "$tag" 2>&1) || continue
    for f in $fprs; do
      if echo "$sigout" | grep -q "VALIDSIG $f "; then
        if [[ -n "$floor" ]]; then
          # version comes from the tag name, which the signature covers
          ver=$(echo "$tag" | sed -n 's/.*v\([0-9][0-9.]*\)$/\1/p')
          if [[ -z "$ver" ]] || ! uv_version_ge "$ver" "$floor"; then
            uv_log "tag $tag verified but version '$ver' below floor $floor"
            continue 2
          fi
        fi
        uv_log "commit $commit verified by tag $tag"
        return 0
      fi
    done
    uv_log "tag $tag signature not from a trusted key"
  done

  uv_log "no trusted signed tag found for commit $commit"
  return 1
}
