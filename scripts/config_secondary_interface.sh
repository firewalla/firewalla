#!/bin/bash 

: ${FIREWALLA_HOME:=/home/pi/firewalla}

# <ip>

IP_ADDRESS=$1
IP_ADDRESS=$(sed 's;/;\\/;g' <<< $IP_ADDRESS)

sed 's/IP_ADDRESS/'$IP_ADDRESS'/' <$FIREWALLA_HOME/etc/subintf.template >/etc/network/if-pre-up.d/subintf
chmod 755 /etc/network/if-pre-up.d/subintf
