#!/bin/bash

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# repo rule, then the name it is installed under in /etc/logrotate.d
while read src dst; do
  sudo install -m 644 $FIREWALLA_HOME/etc/logrotate.d/$src.logrotate /etc/logrotate.d/$dst
done <<EOF
apt-get apt-get
docker_vpn docker_vpn
openconnect openconnect
openvpn openvpn
redis redis
wgvpn wireguard
EOF
