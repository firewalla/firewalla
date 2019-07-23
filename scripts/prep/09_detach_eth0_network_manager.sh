#!/bin/bash

if [[ -e /etc/NetworkManager/NetworkManager.conf ]]; then
  # do not use native dnsmasq
  sudo sed -i "s/^dns=dnsmasq/#dns=dnsmasq/" /etc/NetworkManager/NetworkManager.conf
  # do not manage interfaces in /etc/network/interfaces
  sudo sed -i "s/^managed=true/managed=false/" /etc/NetworkManager/NetworkManager.conf
  sudo systemctl restart NetworkManager
fi