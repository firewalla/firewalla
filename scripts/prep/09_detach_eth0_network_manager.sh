#!/bin/bash

if [[ $MANAGED_BY_FIREROUTER == "yes" ]]; then
  exit
fi

if [[ -e /etc/NetworkManager/NetworkManager.conf ]]; then
  # do not use native dnsmasq
  changed=0
  if grep -q -e "^dns=dnsmasq" /etc/NetworkManager/NetworkManager.conf ; then
    sudo sed -i "s/^dns=dnsmasq/#dns=dnsmasq/" /etc/NetworkManager/NetworkManager.conf
    changed=1
  fi
  # do not manage interfaces in /etc/network/interfaces
  if grep -q -e "^managed=true" /etc/NetworkManager/NetworkManager.conf ; then
    sudo sed -i "s/^managed=true/managed=false/" /etc/NetworkManager/NetworkManager.conf
    changed=1
  fi
  if [[ changed -eq 1 ]]; then
    sudo systemctl restart NetworkManager
  fi
fi