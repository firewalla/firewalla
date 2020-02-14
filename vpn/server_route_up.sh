#!/bin/bash

INSTANCE=$1

mkdir -p /home/pi/.firewalla/run/ovpn_server

GATEWAY_FILE="/home/pi/.firewalla/run/ovpn_server/$INSTANCE.gateway"
echo $route_vpn_gateway > $GATEWAY_FILE

MASK_LEN=`ipcalc -nb ${route_network_1}/${route_netmask_1} | grep Netmask | awk '{print $4}'`

SUBNET_FILE="/home/pi/.firewalla/run/ovpn_server/$INSTANCE.subnet"
CIDR="${route_network_1}/${MASK_LEN}"
echo $CIDR > $SUBNET_FILE

LOCAL_FILE="/home/pi/.firewalla/run/ovpn_server/$INSTANCE.local"
CIDR="${ifconfig_local}/${MASK_LEN}"
echo $CIDR > $LOCAL_FILE

# send to firerouter redis db
redis-cli -n 1 publish "ifup" "$dev" || true