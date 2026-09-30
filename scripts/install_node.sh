#!/bin/bash

# Installs the upgraded Node from an assets tarball (post command in platform assets.lst): only
# bin/node, into $NODE_VERSIONS_DIR/<version>, shared with firerouter. Services pick it up when they
# start (node_bin_or_default in platform/platform.sh, firerouter bin/node), so a new install schedules
# restarts: the first main-run after a code update usually restarts the services before this
# download is done, and nothing else restarts them on a schedule.
# On first install $NODE_VERSIONS_DIR becomes a symlink to /data/node_versions when /data has room:
# /home is the tight overlay upper layer.
# usage: install_node.sh <tarball> <version>
#        install_node.sh --restart-firerouter <version>   (run by the timer set up below)

tarball=$1
ver=$2
: ${NODE_VERSIONS_DIR:=/home/pi/.node_versions}
: ${NODE_DATA_MNT:=/data}
NODE_DATA_DIR=$NODE_DATA_MNT/node_versions
: ${NODE_MIN_FREE_MB:=350}        # leaves >= 200MB on /home after install
: ${NODE_DATA_MIN_FREE_MB:=450}   # leaves >= 300MB on /data after install, for redis dumps and support files
dest=$NODE_VERSIONS_DIR/$ver
tmp=$NODE_VERSIONS_DIR/.$ver.tmp

# restart + init_network_config like sr6 (a few seconds of LAN outage). Skipped when firerouter's code
# does not pick this version yet (its own upgrade restart switches it later), when FireRouter already
# runs this binary, or when it is latched
if [[ $1 == --restart-firerouter ]]; then
  fr_home=${FIREROUTER_HOME:-/home/pi/firerouter}
  [[ $(sed -n 's/^NODE_UPGRADE_VERSION=\([^ ]*\).*/\1/p' $fr_home/bin/node) == "$ver" ]] || exit 0
  pid=$(pgrep -f '^FireRouter' | head -n1)
  [[ -n $pid && $(sudo readlink /proc/$pid/exe) == $(readlink -f "$NODE_VERSIONS_DIR/$ver/bin/node") ]] && exit 0
  [[ -e ${FIREROUTER_HIDDEN:-/home/pi/.router}/config/.node_legacy ]] && exit 0
  logger "FIREWALLA:NODE_UPGRADE:RESTART firerouter onto $ver"
  sudo systemctl restart firerouter
  source $fr_home/bin/common
  init_network_config
  exit 0
fi

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

# firewalla's services 5 minutes later, clear of main-start; FireRouter 5 minutes after them. FireKick is
# left alone like fireupgrade_soft.sh does (NO_FIREKICK_RESTART), try-restart skips inactive units.
# Transient services that sleep: FireMain runs daemon-reload at start, which re-arms --on-active timers
# (FireRouter's got pushed 5 minutes on Gold Plus). A reboot kills them, and switches both anyway.
sudo systemd-run --collect --unit=node-upgrade-restart-fw /bin/bash -c 'sleep 300; exec /bin/systemctl try-restart firemain firemon fireapi firehb fireui' &>/dev/null
sudo systemd-run --collect --unit=node-upgrade-restart-fr --uid=pi /bin/bash -c "sleep 600; exec '$(readlink -f "$0")' --restart-firerouter '$ver'" &>/dev/null
exit 0
