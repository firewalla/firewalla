#!/bin/bash

# only patches ubuntu 22
if [[ $(lsb_release -rs| cut -d'.' -f1) != 22 ]]; then
  exit 0
fi

pkgName="openssh-server"
patchVer="1:8.9p1-3ubuntu0.10"

installedVer=$(apt-cache policy $pkgName | grep Installed: | cut -d':' -f2-)
if (dpkg --compare-versions "$installedVer" lt "$patchVer"); then
  logger "FIREWALLA:PATCH_OPENSSH:START"
  sudo dpkg --configure -a --force-confdef
  sudo timeout 60 apt update
  sudo timeout 60 apt install -o Dpkg::Options::="--force-confold" -y $pkgName=$patchVer
  logger "FIREWALLA:PATCH_OPENSSH:DONE"
fi
