#!/bin/bash

INSTANCE=$1

mkdir -p /etc/openvpn/ovpn_server

GATEWAY_FILE="/etc/openvpn/ovpn_server/$INSTANCE.gateway"
rm -f $GATEWAY_FILE

SUBNET_FILE="/etc/openvpn/ovpn_server/$INSTANCE.subnet"
rm -f $SUBNET_FILE

LOCAL_FILE="/etc/openvpn/ovpn_server/$INSTANCE.local"
rm -f $LOCAL_FILE

# send to firerouter redis db
redis-cli -n 1 publish "ifdown" "$dev" || true