#!/bin/bash

sudo chmod 777 -R /etc/openvpn
if [[ -e /etc/openvpn/easy-rsa/keys ]] && [[ $(uname -m) == "aarch64" ]] && ! [[ -e /etc/openvpn/multi_profile_support ]]; then
  bash $FIREWALLA_HOME/scripts/reset-vpn-keys.sh
fi 

# Ensure nextUpdate in openssl crl to 3600 days
if [ -f /etc/openvpn/easy-rsa/openssl-1.0.0.cnf ]; then
  sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' /etc/openvpn/easy-rsa/openssl-1.0.0.cnf
fi

sudo cp /home/pi/firewalla/extension/vpnclient/openvpn_client@.service.template /etc/systemd/system/openvpn_client@.service
sudo systemctl daemon-reload
sync
