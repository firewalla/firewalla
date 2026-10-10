#!/bin/bash

: "${FIREWALLA_HOME:=/home/pi/firewalla}"
TAG="FIREWALLA:PATCH_OPENSSH"

# only patches ubuntu 22
if [[ $(lsb_release -rs| cut -d'.' -f1) != 22 ]]; then
  exit 0
fi

source $FIREWALLA_HOME/scripts/apt_utils.sh

apt_due openssh 82800 || { logger "$TAG:SKIP:WITHIN_1_DAY"; exit 0; }
# written before apt runs, so a failed, killed or no-upgrade run also waits;
# 23h so the nightly run's jitter doesn't skip every other night
apt_defer openssh 82800
trap 'exit 143' TERM INT
trap apt_cleanup EXIT

sudo timeout 90 apt update \
  || { logger "$TAG:ERROR:APT_UPDATE_FAILED code $?"; exit 1; }
pkgName="openssh-server"

if apt list $pkgName --upgradable 2>/dev/null | grep -q security; then
  logger "$TAG:START"
  $FIREWALLA_HOME/scripts/apt-get.sh --no-update --no-reboot install $pkgName \
    || { logger "$TAG:ERROR:APT_GET_FAILED code $?"; exit 1; }
  sudo systemctl daemon-reload
  sudo systemctl restart sshd

  logger "$TAG:DONE"
else
  logger "$TAG:SKIP:NO_SECURITY_UPGRADE_AVAILABLE"
fi
