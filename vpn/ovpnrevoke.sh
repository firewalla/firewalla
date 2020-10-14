#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# ovpnrevoke.sh <common name>

CN=$1

FILEEXT=".ovpn" 
PASSEXT=".password"

cd /etc/openvpn/easy-rsa
OPENSSL_CNF=$(get_openssl_cnf_file)
# Ensure nextUpdate in openssl crl to 3600 days
if [ -f $OPENSSL_CNF ]; then
  sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' $OPENSSL_CNF
fi

source ./vars
echo "revoke previous CN: $CN"
./revoke-full $CN
sudo cp keys/crl.pem /etc/openvpn/crl.pem
sudo chmod 644 /etc/openvpn/crl.pem

# remove client conf file, profile, password and settings
sudo rm "/etc/openvpn/client_conf/$CN"
sudo rm "/home/pi/ovpns/$CN$FILEEXT"
sudo rm "/home/pi/ovpns/$CN$FILEEXT$PASSEXT"
sudo rm -rf "/home/pi/ovpns/$CN"
