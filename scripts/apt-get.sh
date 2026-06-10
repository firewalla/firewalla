#!/bin/bash

# Copyright 2020-2026 Firewalla Inc.

# This program is free software: you can redistribute it and/or  modify
# it under the terms of the GNU Affero General Public License, version 3,
# as published by the Free Software Foundation.

# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.

# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

# Redirect all output to log (add early, before other output)
exec > >(sudo tee -a /home/pi/logs/apt-get.log) 2>&1

source ${FIREWALLA_HOME}/platform/platform.sh

usage() {
    echo "Usage: apt-get.sh [options] <apt-get-arguments>"
    echo ""
    echo "Options:"
    echo "    -nu,  --no-update           skip apt-get update"
#   echo "    -nr,  --no-reboot           no auto reboot after script execution"
    echo "    -fr,  --force-reboot        force reboot after script execution"
    echo "    -pre, --exec-pre-upgrade    command* to run before upgrade"
    echo "    -pst, --exec-post-upgrade   command* to run after upgrade"
    echo ""
    echo "  *: note that command should be correctly quoted to be respected as a single argument"
    echo ""
    return
}


TAG="FIREWALLA:APT-GET"
echo "========================================"
date
echo "apt-get.sh $(printf -- '"%s" ' "$@")"
logger "$TAG:START $(printf -- '"%s" ' "$@")"

PARAMS=""

while [[ "$1" != "" ]]; do
    case $1 in
    -nu | --no-update)
        shift
        NOUPDATE=1
        ;;
    -nr | --no-reboot)
        shift
        NOREBOOT=1
        ;;
    -fr | --force-reboot)
        shift
        FORCE_REBOOT=1
        ;;
    -pre | --exec-pre-upgrade)
        shift
        PRE_EXEC=$1
        shift
        ;;
    -pst | --exec-post-upgrade)
        shift
        POST_EXEC=$1
        shift
        ;;
    -h | --help)
        usage
        exit
        ;;
    *)
        PARAMS="$PARAMS $1"
        shift
        ;;
    esac
done

if [ -z "$PARAMS" ]; then
    usage
    exit 0
fi

if [ -n "$PRE_EXEC" ]; then
  logger "$TAG:PRE_EXEC:START"
  $PRE_EXEC || { logger "$TAG:ERROR:PRE_EXEC_FAILED code $?"; exit 1; }
fi

if [ "$NOUPDATE" != 1 ]; then
  logger "$TAG:APT_UPDATE:START"
  sudo timeout 60 /usr/bin/apt-get update \
    || { logger "$TAG:ERROR:APT_UPDATE_FAILED code $?"; exit 1; }
fi

sudo timeout 10 dpkg --configure -a --force-confold

# Dpkg::Options
# confold: If a conffile has been modified and the version in the package
# did change, always keep the old version without prompting, unless the
# --force-confdef is also specified, in which case the default action is preferred.
logger "$TAG:APT_INSTALL:START"
sudo timeout 60 /usr/bin/apt-get -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" -y $PARAMS \
  || { logger "$TAG:ERROR:APT_INSTALL_FAILED code $?"; exit 1; }

if [ -n "$POST_EXEC" ]; then
  logger "$TAG:POST_EXEC:START"
  $POST_EXEC || { logger "$TAG:ERROR:POST_EXEC_FAILED code $?"; exit 1; }
fi


# Install on both overlay and underlay fs to avoid reboot
if [[ "$RAMFS_ROOT_PARTITION" == 'yes' ]]; then
  logger "$TAG:OVERLAYROOT_CHROOT:START"

  # Copy overlay's resolv.conf, it might be missing
  resolv_overlay=/log/resolv.conf.apt-get
  sudo cp -L /etc/resolv.conf "$resolv_overlay"

  # Some directories do not exist in lower fs, e.g.
  # /var/log -> /log/system
  # /var/lib/apt -> /log/apt/lib
  # this gives lower partition updated apt cache, no apt update is necessary
  sudo mount -o rw,bind /log /media/root-ro/log

# ===== don't indent here-document with space =====
cat << EOF | sudo overlayroot-chroot
set -e
if [ -s $resolv_overlay ]; then cp $resolv_overlay /etc/resolv.conf; fi

${PRE_EXEC:-:} || exit \$?

/usr/bin/apt-get -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" -y $PARAMS || exit \$?

${POST_EXEC:-:} || exit \$?
EOF
# =================================================

  overlay_rc=${PIPESTATUS[1]}
  sudo umount -l /media/root-ro/log

  [ "$overlay_rc" -ne 0 ] && { logger "$TAG:ERROR:OVERLAYROOT_CHROOT_FAILED"; exit "$overlay_rc"; }

  logger "$TAG:OVERLAYROOT_CHROOT:DONE"
fi


# # /etc/profile.d/armbian-check-first-login-reboot.sh
# # Gold -> /usr/lib/update-notifier/update-motd-reboot-require
# if [ "$NOREBOOT" != 1 ] && ([ -f "/var/run/.reboot_required" ] || [ -f "/var/run/reboot-required" ]); then
#     logger "$TAG:REBOOT_REQUIRED:shutdown in 30 seconds"
#     echo "Reboot required for newly added/upgraded packages, reboot in 30 seconds"
#     sudo shutdown -r -t 30
# fi

if [ "$FORCE_REBOOT" == 1 ]; then
    logger "$TAG:FORCE_REBOOT:shutdown in 30 seconds"
    echo "Forced reboot, start in 30 seconds"
    sudo shutdown -r -t 30
fi

logger "$TAG:DONE"

