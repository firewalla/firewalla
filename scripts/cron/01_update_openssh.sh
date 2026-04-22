#!/bin/bash

: "${FIREWALLA_HOME:=/home/pi/firewalla}"
TAG="FIREWALLA:PATCH_OPENSSH"

# only patches ubuntu 22
if [[ $(lsb_release -rs| cut -d'.' -f1) != 22 ]]; then
  logger "$TAG:SKIP:NOT_UBUNTU_22"
  exit 0
fi

openssh_ts_file=/dev/shm/openssh_apt_update_ts
if [[ -e $openssh_ts_file ]] && (( $(cat $openssh_ts_file) > $(date +%s) - 86400 * 7 )); then
  logger "$TAG:SKIP:WITHIN_7_DAYS"
  exit 0
fi

sudo timeout 90 apt update \
  || { logger "$TAG:ERROR:APT_UPDATE_FAILED code $?"; exit 1; }
pkgName="openssh-server"

if apt list $pkgName --upgradable 2>/dev/null | grep -q security; then
  logger "$TAG:START"
  $FIREWALLA_HOME/scripts/apt-get.sh --no-update --no-reboot install $pkgName \
    || { logger "$TAG:ERROR:APT_GET_FAILED code $?"; exit 1; }
  sudo systemctl daemon-reload
  sudo systemctl restart sshd
  date +%s > $openssh_ts_file

  logger "$TAG:DONE"
else
  logger "$TAG:SKIP:NO_SECURITY_UPGRADE_AVAILABLE"
fi

sudo apt clean
sudo rm -rf /log/apt/lib/lists/*
