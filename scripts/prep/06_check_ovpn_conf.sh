#!/bin/bash

sudo chmod 777 -R /etc/openvpn
if [ ! -s /etc/openvpn/crl.pem ]; then
  # create crl file with dummy revocation list
  cd /etc/openvpn/easy-rsa
  source ./vars
  ./pkitool dummy
  ./revoke-full dummy
  cp keys/crl.pem ../crl.pem
  cd -  
fi

if [ -f /etc/openvpn/server.conf ]; then
  grep -q -w "crl-verify" /etc/openvpn/server.conf
  crl_enabled=$?
  if [[ $crl_enabled -ne 0 ]]; then
    # ensure crl-verify is enabled in server config
    echo -e "\ncrl-verify /etc/openvpn/crl.pem" >> /etc/openvpn/server.conf
  fi
  grep -q -w "client-config-dir" /etc/openvpn/server.conf
  ccd_enabled=$?
  if [[ $ccd_enabled -ne 0 ]]; then
    # ensure client-config-dir is enabled in server config
    echo -e "\nclient-config-dir /etc/openvpn/client_conf" >> /etc/openvpn/server.conf
  fi
fi

if [ ! -d /etc/openvpn/client_conf ]; then
  # create client config dir
  mkdir -p /etc/openvpn/client_conf
fi

if [ ! -f /etc/openvpn/client_conf/DEFAULT ]; then
  sed 's/COMP_LZO_OPT/comp-lzo no/' < /home/pi/firewalla/vpn/client_conf.txt > /etc/openvpn/client_conf/DEFAULT
  sed -i 's/COMPRESS_OPT/compress/' /etc/openvpn/client_conf/DEFAULT
fi

sudo chmod 600 -R /etc/openvpn
sudo chmod 777 /etc/openvpn
sudo chmod 644 /etc/openvpn/crl.pem
sudo chmod 777 /etc/openvpn/client_conf
sudo chmod 644 /etc/openvpn/client_conf/*

sudo cp /home/pi/firewalla/extension/vpnclient/openvpn_client@.service.template /etc/systemd/system/openvpn_client@.service