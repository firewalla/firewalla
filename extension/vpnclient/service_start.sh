#!/bin/bash

if [ $# -eq 0 ]; then
  logger "OpenVPNClient: No profile ID provided, exit"
  echo "OpenVPNClient: No profile ID provided, exit"
  exit 1
fi

sudo /usr/sbin/openvpn --config "/home/pi/.firewalla/run/ovpn_profile/$1.conf" --script-security 2 --route-up "/home/pi/firewalla/extension/vpnclient/ovpn_remove_pushed_routes.sh $1" --up "/home/pi/firewalla/extension/vpnclient/ovpn_up.sh $1" --status "/var/log/openvpn_client-status-$1.log" 2>&1 | sudo tee -a "/var/log/openvpn_client-$1.log"
