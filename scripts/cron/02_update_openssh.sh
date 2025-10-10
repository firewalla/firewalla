#!/bin/bash

# only patches ubuntu 22
if [[ $(lsb_release -rs| cut -d'.' -f1) != 22 ]]; then
  exit 0
fi

openssh_ts_file=/dev/shm/openssh_apt_update_ts
if [[ -e $openssh_ts_file ]] && (( $(cat $openssh_ts_file) > $(date +%s) - 86400 * 7 )); then
  exit 0
fi

echo $(date +%s) > $openssh_ts_file

sudo timeout 60 apt update
pkgName="openssh-server"

if apt list $pkgName --upgradable 2>/dev/null | grep security; then
  logger "FIREWALLA:PATCH_OPENSSH:START"
  sudo dpkg --configure -a --force-confdef
  sudo timeout 60 apt install -o Dpkg::Options::="--force-confold" -y $pkgName
  logger "FIREWALLA:PATCH_OPENSSH:DONE"
fi

sudo apt clean
sudo rm -rf /log/apt/lib/lists/*
