#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

source ${FIREWALLA_HOME}/platform/platform.sh

if [[ $(lsb_release -cs) == "jammy" && $(uname -m) == "x86_64" ]]; then
  test -s /home/pi/openvpn/easy-rsa/keys/dh1024.pem && ! test -s /home/pi/openvpn/easy-rsa/keys/dh2048.pem && sudo rm -fr /home/pi/openvpn
fi

sudo chmod 777 -R /etc/openvpn
if [[ -e /etc/openvpn/easy-rsa/keys ]] && [[ $(uname -m) == "aarch64" ]] && ! [[ -e /etc/openvpn/multi_profile_support ]]; then
  bash $FIREWALLA_HOME/scripts/reset-vpn-keys.sh
fi 

OPENSSL_CNF=$(get_openssl_cnf_file)
# Ensure nextUpdate in openssl crl to 3600 days
if [ -f $OPENSSL_CNF ]; then
  sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' $OPENSSL_CNF
fi

sudo cp /home/pi/firewalla/extension/vpnclient/openvpn_client@.service.template /etc/systemd/system/openvpn_client@.service
sudo cp /home/pi/firewalla/extension/vpnclient/openconnect_client@.service.template /etc/systemd/system/openconnect_client@.service
sudo systemctl daemon-reload
sync
