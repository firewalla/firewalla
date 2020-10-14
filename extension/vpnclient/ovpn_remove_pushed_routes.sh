#!/bin/bash

# remove routes pushed from OpenVPN server due to redirect-gateway options
sudo ip route del 0.0.0.0/1 || true
sudo ip route del 128.0.0.0/1 || true

# flush IPv6 address
sudo ip -6 a flush dev $dev || true

# create file with vpn gateway IP and subnet
PROFILE_ID=$1

GATEWAY_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.gateway"
echo $route_vpn_gateway > $GATEWAY_FILE
chown pi $GATEWAY_FILE

SUBNET_FILE="/home/pi/.firewalla/run/ovpn_profile/$PROFILE_ID.subnet"
echo "$route_network_1/$route_netmask_1" > $SUBNET_FILE
chown pi $SUBNET_FILE

redis-cli publish "ovpn_client.route_up" "$PROFILE_ID"