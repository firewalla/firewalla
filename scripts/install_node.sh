#!/bin/bash

# Installs only bin/node of the upgraded Node from an assets tarball as $NODE_UPGRADE_BIN, shared with
# firerouter; /home is the tight overlay upper layer, so the versions dir moves to /data when it has room.
# usage: install_node.sh [--skip-check] <tarball>   exec_post, or exec_skip: exit 0 = no download needed

check_only=
[[ $1 == --skip-check ]] && { check_only=1; shift; }
tarball=$1
[[ $(basename "$tarball") =~ ^node-(v[0-9.]+)-linux- ]]
ver=${BASH_REMATCH[1]}
: ${FIREWALLA_HOME:=/home/pi/firewalla}
source $FIREWALLA_HOME/platform/platform.sh
: ${NODE_DATA_MNT:=/data}
NODE_DATA_DIR=$NODE_DATA_MNT/node_versions
: ${NODE_MIN_FREE_MB:=350}        # leaves >= 200MB on /home after install
: ${NODE_DATA_MIN_FREE_MB:=450}   # leaves >= 300MB on /data after install, for redis dumps and support files
# update: binary 150MB + tarball 40MB + margin, no more than a first install keeps, so any box can update
: ${NODE_UPDATE_MIN_FREE_MB:=200}
: ${NODE_DATA_UPDATE_MIN_FREE_MB:=250}
tmp=

fail() {
  logger "FIREWALLA:NODE_UPGRADE:INSTALL_FAILED $ver $1"
  exit 1
}

free_mb() { df -Pm "$1" | awk 'NR==2{print $4}'; }

place_dir() {
  if [[ ! -e $NODE_VERSIONS_DIR && ! -L $NODE_VERSIONS_DIR ]] && mountpoint -q "$NODE_DATA_MNT" &&
     (( $(free_mb "$NODE_DATA_MNT") >= NODE_DATA_MIN_FREE_MB )); then
    { sudo mkdir -p "$NODE_DATA_DIR" && sudo chown pi:pi "$NODE_DATA_DIR" && ln -s "$NODE_DATA_DIR" "$NODE_VERSIONS_DIR"; } || fail data-dir
  fi
  mkdir -p "$NODE_VERSIONS_DIR" || fail mkdir
}

# a Node on disk, the upgraded one or a version directory of the earlier layout
node_on_disk() { [[ -x $NODE_UPGRADE_BIN ]] || compgen -G "$NODE_VERSIONS_DIR/v[0-9]*/bin/node" >/dev/null; }

# sets $free, succeeds when the versions dir has room for the install
gate() {
  local min=$NODE_MIN_FREE_MB update_min=$NODE_UPDATE_MIN_FREE_MB
  if [[ -L $NODE_VERSIONS_DIR ]]; then
    min=$NODE_DATA_MIN_FREE_MB
    update_min=$NODE_DATA_UPDATE_MIN_FREE_MB
  fi
  node_on_disk && min=$update_min
  free=$(free_mb "$NODE_VERSIONS_DIR/")
  (( free >= min ))
}

installed() { [[ $("$NODE_UPGRADE_BIN" -v 2>/dev/null) == "$ver" ]]; }

# 0: nothing to download this round, 1: go on with the hash check and the download
skip_check() {
  # a killed round's leftovers (update_assets.sh is killed after 1200s) would count as up to date and never be
  # installed; wget stamps a finished download with the server's time, so the age spares only one in progress
  [[ -d $NODE_VERSIONS_DIR ]] && find "$NODE_VERSIONS_DIR/" -maxdepth 3 -type f \( -name 'node-v*.tar.xz*' -o -name '.node.*' \) -mmin +20 -delete
  installed && exit 0
  place_dir
  gate && exit 1
  logger "FIREWALLA:NODE_UPGRADE:INSTALL_SKIPPED nospace ${free}MB"
  exit 0
}

extract() {
  local bindir=$(dirname "$NODE_UPGRADE_BIN")
  mkdir -p "$bindir" || fail mkdir
  tmp=$(mktemp "$bindir/.node.XXXXXX") || fail mktemp
  tar -xJf "$tarball" -O "$(basename "$tarball" .tar.xz)/bin/node" > "$tmp" || fail extract
  rm -f "$tarball"
  chmod 755 "$tmp"
  # e.g. an official build on a glibc < 2.28 box
  [[ $("$tmp" -v 2>/dev/null) == "$ver" ]] && "$tmp" --expose-gc -max-old-space-size=256 -e 1 &>/dev/null || fail run-check
  # a rename, never a write into the running binary, and a failed install leaves the old one intact
  mv -f "$tmp" "$NODE_UPGRADE_BIN" || fail mv
}

[[ -n $check_only ]] && skip_check

trap 'rm -f "$tmp" "$tarball"' EXIT
# tarball re-downloaded while this version is already in place
installed && exit 0
extract
logger "FIREWALLA:NODE_UPGRADE:INSTALLED $ver"
exit 0
