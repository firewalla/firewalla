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
# key, and its version must be at or above the minimal version
#
# All UV_ variables can be preset before sourcing; the defaults below apply
# to the firewalla repo. firerouter presets UV_OFFICIAL_REPO and
# UV_RELEASE_PUBKEY; the release key, keyring, minimal version and its
# fw_min_version asset are shared by both repos.

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# verification uses gpgv, not gpg: gpgv is verify-only and is guaranteed
# present (apt depends on it), while the gnupg package is absent from newer
# platform images. gpgv takes a plain binary keyring file and trusts every
# key in it, so there is no keyring import, no GNUPGHOME and no trustdb.
#
# keyrings live outside the git tree so fetch/reset cannot modify them
: ${UV_RELEASE_KEYRING:=/home/pi/.upgrade-keys/release.gpg}
: ${UV_TEST_KEYRING:=/home/pi/.upgrade-keys/test.gpg}
: ${UV_OFFICIAL_REPO:=firewalla}
# binary (dearmored) public key shipped in the repo; gpgv cannot read the
# ASCII-armored form and there is no gpg on the box to convert it. This is
# the bootstrap copy, used only until the assets pipeline delivers one.
: ${UV_RELEASE_PUBKEY:=$FIREWALLA_HOME/etc/keys/release_pub.gpg}
# authoritative keyring from the assets pipeline, signature-verified by
# update_assets.sh against etc/keys/assets.key. It arrives independently of
# git, so a box that has been offline for a long time still picks up a
# rotated key and can upgrade; it also allows revoking a key without a
# release. Takes precedence over the in-repo bootstrap copy.
: ${UV_RELEASE_KEYRING_ASSET:=/home/pi/.firewalla/run/assets/release_pub.gpg}
: ${UV_FLOOR_FILE:=/home/pi/.firewalla/config/upgrade_min_version}
: ${UV_FLOOR_ASSET:=/home/pi/.firewalla/run/assets/fw_min_version}
: ${UV_OTA_CONFIG_URL:=https://ota.firewalla.com/fapp/fbox.json}
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

# copy the release keyring from the currently installed (trusted) tree to a
# location outside the repo, so a later reset/checkout cannot remove it.
# Re-copied when the file changes, so a signed release can rotate the key.
uv_ensure_release_key() {
  # only maintain the release keyring when the box tracks the official repo;
  # a test box (non-official remote) uses the test keyring only, keeping the
  # two environments separate
  uv_is_official_remote "$(git remote get-url origin 2>/dev/null)" || return 0
  local src
  # pull just the keyring before verifying, so a factory-fresh or long-offline
  # box gets the current key on its FIRST upgrade instead of failing once and
  # waiting for the daily asset sync, and so a revoked key stops being trusted
  # immediately. Single-asset mode needs no assets.d, so this also works before
  # prepare_assets_list.sh has ever run. Best effort: bounded by timeout, output
  # discarded, failure ignored - verification then proceeds with whatever
  # keyring is already on the box.
  if [[ -x $FIREWALLA_HOME/scripts/update_assets.sh ]]; then
    timeout 60 $FIREWALLA_HOME/scripts/update_assets.sh \
      "$UV_RELEASE_KEYRING_ASSET" /all/release_pub.gpg 644 &>/dev/null || true
  fi
  # precedence: assets-delivered keyring (authoritative, carries rotations and
  # revocations) > keyring already installed > in-repo key. The middle rule
  # matters: without it, a temporarily missing asset would let the in-repo key -
  # only ever a bootstrap copy, and possibly predating a rotation - overwrite an
  # already-rotated keyring and start rejecting valid releases.
  if [[ -s $UV_RELEASE_KEYRING_ASSET ]]; then
    src=$UV_RELEASE_KEYRING_ASSET
  elif [[ -s $UV_RELEASE_KEYRING ]]; then
    return 0
  elif [[ -s $UV_RELEASE_PUBKEY ]]; then
    src=$UV_RELEASE_PUBKEY
  else
    return 0
  fi
  # already current
  cmp -s $src $UV_RELEASE_KEYRING 2>/dev/null && return 0
  mkdir -p "$(dirname $UV_RELEASE_KEYRING)" 2>/dev/null
  # write to a temp file in the same directory, then rename: an interrupted
  # copy must never leave a truncated keyring behind, which would fail every
  # verification until the next successful run
  local tmp=$UV_RELEASE_KEYRING.new
  if cp -f $src $tmp 2>/dev/null && [[ -s $tmp ]] && mv -f $tmp $UV_RELEASE_KEYRING 2>/dev/null; then
    uv_log "installed release keyring from $src"
  else
    rm -f $tmp 2>/dev/null
    uv_log "failed to install release keyring to $UV_RELEASE_KEYRING"
    return 1
  fi
}

# verify a git tag's signature with gpgv against <keyring>. git's verify-tag
# shells out to gpg, which does not exist on newer images, so the tag object
# is split by hand: everything before the PGP block is the signed payload,
# the block itself is the detached signature. Return 0 only on a good
# signature from a key in the keyring (gpgv trusts exactly those).
uv_gpgv_verify_tag() {
  local tag=$1 keyring=$2 tmp raw rc=1
  tmp=$(mktemp -d) || return 1
  raw=$tmp/tag
  if git cat-file tag "$tag" > $raw 2>/dev/null; then
    sed '/-----BEGIN PGP SIGNATURE-----/,$d' $raw > $tmp/payload
    sed -n '/-----BEGIN PGP SIGNATURE-----/,$p' $raw > $tmp/sig
    # a tag with no signature block yields an empty sig file
    if [[ -s $tmp/sig ]]; then
      gpgv --keyring "$keyring" --status-fd 1 $tmp/sig $tmp/payload 2>/dev/null |
        grep -q '^\[GNUPG:\] VALIDSIG ' && rc=0
    fi
  fi
  rm -rf $tmp
  return $rc
}

uv_get_version_floor() {
  [[ -s $UV_FLOOR_FILE ]] && cat $UV_FLOOR_FILE
}

# refresh the minimal version from the assets pipeline (update_assets.sh
# downloads and signature-verifies /all/fw_min_version); monotonic - only
# ever raised, a lower or missing asset value never lowers the cached one
uv_update_version_floor() {
  [[ -s $UV_FLOOR_ASSET ]] || return 0
  local asset cached
  asset=$(tr -d '[:space:]' < $UV_FLOOR_ASSET)
  [[ "$asset" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 0
  cached=$(uv_get_version_floor)
  if [[ -z "$cached" ]] || ! uv_version_ge "$cached" "$asset"; then
    # dir may not exist on a new/recovery box; write failure must not abort
    # callers running under set -e
    mkdir -p "$(dirname $UV_FLOOR_FILE)" 2>/dev/null || true
    if echo "$asset" > $UV_FLOOR_FILE 2>/dev/null; then
      uv_log "minimal version raised to $asset"
    else
      uv_log "cannot write minimal version cache to $UV_FLOOR_FILE"
    fi
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
    # already exactly on the pin with a clean tree, nothing to do (exit 2 so
    # the caller stays quiet)
    if [[ $(git rev-parse HEAD 2>/dev/null) == "$pin" && -z $(git status -uno --porcelain 2>/dev/null) ]]; then
      exit 2
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
  # already on the pin, no change, no log
  [[ $rc -eq 2 ]] && return 0
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
# version >= the minimal version. Return 0 = verified (or exempt), 1 = failed.
uv_verify_release_commit() {
  local commit keyring floor tag tags t ver
  # ^{commit} peels any ref (branch, annotated tag) to its commit hash
  commit=$(git rev-parse "${1:-FETCH_HEAD}^{commit}" 2>/dev/null) || {
    uv_log "cannot resolve commit $1"
      return 1
  }

  local url=$(git remote get-url origin 2>/dev/null)
  if uv_is_official_remote "$url"; then
    # official remote with no keyring fails closed (reject, never skip)
    if [[ ! -s $UV_RELEASE_KEYRING ]]; then
      uv_log "official remote but release keyring missing at $UV_RELEASE_KEYRING"
      return 1
    fi
    keyring=$UV_RELEASE_KEYRING
  else
    if [[ -s $UV_TEST_KEYRING ]]; then
      keyring=$UV_TEST_KEYRING
    else
      uv_log "non-official remote ($url) and no test key, skip verification"
      return 0
    fi
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
      uv_as_pi git fetch --no-tags origin "refs/tags/$t:refs/tags/$t" &>/dev/null || continue
    tags="$tags"$'\n'"$t"
  done

  floor=$(uv_get_version_floor)
  for tag in $tags; do
    # a pre-existing local tag with this name may point elsewhere
    [[ $(git rev-parse -q --verify "$tag^{commit}" 2>/dev/null) == "$commit" ]] || continue
    # gpgv trusts exactly the keys in the keyring, so a good signature there
    # already means "signed by us" - no separate fingerprint match needed
    if ! uv_gpgv_verify_tag "$tag" "$keyring"; then
      uv_log "tag $tag signature not from a trusted key"
      continue
    fi
    if [[ -n "$floor" ]]; then
      # version comes from the tag name, which the signature covers
      ver=$(echo "$tag" | sed -n 's/.*v\([0-9][0-9.]*\)$/\1/p')
      if [[ -z "$ver" ]] || ! uv_version_ge "$ver" "$floor"; then
        uv_log "tag $tag verified but version '$ver' below minimal version $floor"
        continue
      fi
    fi
    uv_log "commit $commit verified by tag $tag"
    return 0
  done

  uv_log "no trusted signed tag found for commit $commit"
  return 1
}

# enforcement is opt-in via cloud config: real only when fbox.json has
# "verify_release_tag" set to true or 1. Any other value, a missing key, or
# an unreachable/invalid config -> not enforced (dry-run), so verification
# never blocks upgrades until it is explicitly turned on.
uv_is_enforced() {
  local val
  val=$(curl -m10 -s "$UV_OTA_CONFIG_URL" 2>/dev/null | jq -r '.verify_release_tag // empty' 2>/dev/null)
  [[ "$val" == "true" || "$val" == "1" ]]
}

# gate for the update paths: verify the commit, then honor enforcement.
# Return 0 = proceed with the update, 1 = block. When not enforced, a failed
# verification is logged as dry-run and the update proceeds.
# usage: uv_gate <commit-ish> <branch>
uv_gate() {
  local commit=${1:-FETCH_HEAD} branch=$2
  uv_verify_release_commit "$commit" && return 0
  if uv_is_enforced; then
    return 1
  fi
  uv_log "DRY-RUN would reject $commit on branch '$branch'; upgrade allowed (verify_release_tag not enabled)"
  return 0
}
