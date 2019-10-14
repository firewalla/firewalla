#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# ovpnrevoke.sh <common name>

CN=$1

FILEEXT=".ovpn" 
PASSEXT=".password"

cd /etc/openvpn/easy-rsa
# Ensure nextUpdate in openssl crl to 3600 days
if [ -f /etc/openvpn/easy-rsa/openssl-1.0.0.cnf ]; then
  sudo sed -i 's/default_crl_days= [0-9]*/default_crl_days= 3600/' /etc/openvpn/easy-rsa/openssl-1.0.0.cnf
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
