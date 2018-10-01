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
fi

sudo chmod 600 -R /etc/openvpn
sudo chmod 777 /etc/openvpn
sudo chmod 644 /etc/openvpn/crl.pem