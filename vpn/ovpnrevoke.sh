#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}
source ${FIREWALLA_HOME}/platform/platform.sh

# ovpnrevoke.sh <common name>

CN=$1
INSTANCE=$2
if [[ -z $INSTANCE ]]; then
  INSTANCE="server"
fi
PTP_ADDR=`cat /etc/openvpn/ovpn_server/$INSTANCE.gateway`

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

CLIENT_RC="/home/pi/ovpns/$CN/$CN.rc"
if [[ -f $CLIENT_RC ]]; then
  source "$CLIENT_RC"
fi
if [[ -n $CLIENT_SUBNETS ]]; then # CLIENT_SUBNETS are cidr subnets separated with comma
  CLIENT_SUBNETS=${CLIENT_SUBNETS//,/ } # replace comma with space
  for CLIENT_SUBNET in $CLIENT_SUBNETS;
  do
    sudo ip r del $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn metric 1024 || true
    sudo ip r del $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table lan_routable metric 1024 || true
    sudo ip r del $CLIENT_SUBNET via $PTP_ADDR dev tun_fwvpn table wan_routable metric 1024 || true
  done
fi

# remove client conf file, profile, password and settings
sudo rm "/etc/openvpn/client_conf/$CN"
sudo rm "/home/pi/ovpns/$CN$FILEEXT"
sudo rm "/home/pi/ovpns/$CN$FILEEXT$PASSEXT"
sudo rm -rf "/home/pi/ovpns/$CN"
