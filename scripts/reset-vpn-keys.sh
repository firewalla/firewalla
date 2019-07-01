#!/bin/bash

sudo chmod 777 -R /etc/openvpn
cd /etc/openvpn/easy-rsa

VPN_ON="false"
if redis-cli hget policy:system "vpn" | json_pp | grep '"state" : true' &>/dev/null; then
  VPN_ON="true"
fi

if [[ $VPN_ON == "false" ]]; then
  source ./vars 
  ./clean-all
  rm /home/pi/ovpns/*
  exit 0
fi

cd $FIREWALLA_HOME/vpn
nohup bash -c "KEYS_FOLDER=keys2 sudo -E ./install2.sh server" &> /tmp/install2.output &
