#!/bin/bash

sudo chmod 777 -R /etc/openvpn
cd /etc/openvpn/easy-rsa
if [[ -e keys ]] && [[ -e keys2 ]]; then
  VPN_ON="false"
  if redis-cli hget policy:system "vpn" | json_pp | grep '"state" : true' &>/dev/null; then
    VPN_ON="true"
  fi

  if [[ $VPN_ON == "true" ]]; then
    curl -s -o /dev/null -w "%{http_code}" -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' -d '{ "vpn": {"state": false }}' 'http://localhost:8834/v1/encipher/simple?command=set&item=policy&target=0.0.0.0'
  fi
  rm -fr keys
  mv keys2 keys
  sleep 15
  if [[ $VPN_ON == "true" ]]; then
    curl -s -o /dev/null -w "%{http_code}" -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' -d '{ "vpn": {"state": true }}' 'http://localhost:8834/v1/encipher/simple?command=set&item=policy&target=0.0.0.0'
  fi
fi