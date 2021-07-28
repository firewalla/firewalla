#!/bin/bash

# Copyright 2020 Firewalla Inc.

# This program is free software: you can redistribute it and/or  modify
# it under the terms of the GNU Affero General Public License, version 3,
# as published by the Free Software Foundation.

# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.

# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

usage() {
    echo "Usage: apt-get.sh [options] <apt-get-arguments>"
    echo ""
    echo "Options:"
    echo "    -nu,  --no-update           skip apt-get update"
    echo "    -nr,  --no-reboot           no auto reboot after script execution"
    echo "    -fr,  --force-reboot        force reboot after script execution"
    echo "    -pre, --exec-pre-upgrade    command* to run before upgrade"
    echo "    -pst, --exec-post-upgrade   command* to run after upgrade"
    echo ""
    echo "  *: note that command should be correctly quoted to be respected as a single argument"
    echo ""
    return
}


date
echo "apt-get.sh $(printf -- '"%s" ' "$@")"
logger "FIREWALLA: apt-get.sh $(printf -- '"%s" ' "$@")"

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


$PRE_EXEC

if [ "$NOUPDATE" != 1 ]; then
  sudo /usr/bin/apt-get update
fi
# Dpkg::Options
# confold: If a conffile has been modified and the version in the package
# did change, always keep the old version without prompting, unless the
# --force-confdef is also specified, in which case the default action is preferred.
sudo /usr/bin/apt-get -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" -y $PARAMS

$POST_EXEC


# Install on both overlay and underlay fs to avoid reboot
if [[ "$RAMFS_ROOT_PARTITION" == 'yes' ]]; then

  # Some directories do not exist in lower fs, e.g.
  # /var/log -> /log/system
  # /var/lib/apt -> /log/apt/lib
  sudo mount -o bind /log /media/root-ro/log

# don't indent here-document with space
cat << EOF | sudo overlayroot-chroot
$PRE_EXEC

if [ "$NOUPDATE" != 1 ]; then
    /usr/bin/apt-get update
fi
/usr/bin/apt-get -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" -y $PARAMS

$POST_EXEC
EOF

  sudo umount -l /media/root-ro/log
fi


# /etc/profile.d/armbian-check-first-login-reboot.sh
# Gold -> /usr/lib/update-notifier/update-motd-reboot-require
if [ "$NOREBOOT" != 1 ] && ([ -f "/var/run/.reboot_required" ] || [ -f "/var/run/reboot-required" ]); then
    echo "Reboot required for newly added/upgraded packages, reboot in 30 seconds"
    sudo shutdown -r -t 30
fi

if [ "$FORCE_REBOOT" == 1 ]; then
    echo "Forced reboot, start in 30 seconds"
    sudo shutdown -r -t 30
fi

