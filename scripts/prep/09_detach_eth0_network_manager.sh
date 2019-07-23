#!/bin/bash

if [[ -e /etc/NetworkManager/NetworkManager.conf ]]; then
  sudo sed -i "s/^dns=dnsmasq/#dns=dnsmasq/" /etc/NetworkManager/NetworkManager.conf
  sudo sed -i "s/^managed=true/managed=false/" /etc/NetworkManager/NetworkManager.conf
  sudo systemctl restart NetworkManager
fi