#!/bin/bash

# Installs the upgraded Node from an assets tarball (post command in platform assets.lst): only
# bin/node, into $NODE_VERSIONS_DIR/<version>, shared with firerouter. Services are not restarted: they
# pick it up the next time they start (node_bin_or_default in platform/platform.sh, firerouter bin/node).
# On first install $NODE_VERSIONS_DIR becomes a symlink to /data/node_versions when /data has room:
# /home is the tight overlay upper layer.
# usage: install_node.sh <tarball> <version>

tarball=$1
ver=$2
: ${NODE_VERSIONS_DIR:=/home/pi/.node_versions}
: ${NODE_DATA_MNT:=/data}
NODE_DATA_DIR=$NODE_DATA_MNT/node_versions
: ${NODE_MIN_FREE_MB:=350}        # leaves >= 200MB on /home after install
: ${NODE_DATA_MIN_FREE_MB:=450}   # leaves >= 300MB on /data after install, for redis dumps and support files
dest=$NODE_VERSIONS_DIR/$ver
tmp=$NODE_VERSIONS_DIR/.$ver.tmp

# tarball re-downloaded while this version is already in place
[[ $("$dest/bin/node" -v 2>/dev/null) == "$ver" ]] && exit 0

# drops the tarball, so the next assets round downloads it again and re-runs this script
fail() {
  rm -rf "$tmp" "$tarball"
  logger "FIREWALLA:NODE_UPGRADE:INSTALL_FAILED $ver $1"
  exit 1
}

free_mb() { df -Pm "$1" | awk 'NR==2{print $4}'; }

if [[ ! -e $NODE_VERSIONS_DIR && ! -L $NODE_VERSIONS_DIR ]] && mountpoint -q "$NODE_DATA_MNT" &&
   (( $(free_mb "$NODE_DATA_MNT") >= NODE_DATA_MIN_FREE_MB )); then
  { sudo mkdir -p "$NODE_DATA_DIR" && sudo chown pi:pi "$NODE_DATA_DIR" && ln -s "$NODE_DATA_DIR" "$NODE_VERSIONS_DIR"; } || fail data-dir
fi
mkdir -p "$NODE_VERSIONS_DIR" || fail mkdir
min=$NODE_MIN_FREE_MB
[[ -L $NODE_VERSIONS_DIR ]] && min=$NODE_DATA_MIN_FREE_MB
free=$(free_mb "$NODE_VERSIONS_DIR/")
if (( free < min )); then
  # tarball kept: low space rarely fixes itself, dropping it would re-download 30MB every round
  logger "FIREWALLA:NODE_UPGRADE:INSTALL_SKIPPED nospace ${free}MB"
  exit 0
fi

rm -rf "$tmp"
mkdir -p "$tmp/bin" || fail mkdir
tar -xJf "$tarball" -C "$tmp" --strip-components=1 "$(basename "$tarball" .tar.xz)/bin/node" || fail extract
# e.g. an official build on a glibc < 2.28 box
[[ $("$tmp/bin/node" -v 2>/dev/null) == "$ver" ]] && "$tmp/bin/node" --expose-gc -max-old-space-size=256 -e 1 &>/dev/null || fail run-check
# one mv, so the selectors only ever see no directory or a complete one
rm -rf "$dest"   # broken leftover, the -v check above failed
mv "$tmp" "$dest" || fail mv
logger "FIREWALLA:NODE_UPGRADE:INSTALLED $ver"
exit 0
