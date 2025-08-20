#!/bin/bash

# only patches ubuntu 22
if [[ $(lsb_release -rs| cut -d'.' -f1) != 22 ]]; then
  exit 0
fi

sudo timeout 60 apt update
pkgName="openssh-server"

if apt list $pkgName --upgradable 2>/dev/null | grep security; then
  logger "FIREWALLA:PATCH_OPENSSH:START"
  sudo dpkg --configure -a --force-confdef
  sudo timeout 60 apt install -o Dpkg::Options::="--force-confold" -y $pkgName
  logger "FIREWALLA:PATCH_OPENSSH:DONE"
fi
